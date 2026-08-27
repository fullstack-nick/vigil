package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	recordingv1 "github.com/fullstack-nick/vigil/go/gen/vigil/recording/v1"
	"github.com/fullstack-nick/vigil/go/internal/events"
	"github.com/fullstack-nick/vigil/go/internal/platform"
	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
	"google.golang.org/protobuf/proto"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const commandTopic = "vigil.recording.commands.v1"

type config struct {
	mode            string
	namespace       string
	recorderImage   string
	recorderBinary  string
	leaseEndpoint   string
	leaseAudience   string
	leaseInsecure   string
	storageBucket   string
	allowedHLSHosts string
	kafka           platform.KafkaConfig
	consumerGroup   string
	metricsPort     string
}

type scheduler struct {
	config      config
	client      kubernetes.Interface
	eventWriter *kafka.Writer
	jobsStarted atomic.Uint64
	jobsFailed  atomic.Uint64
	healthy     atomic.Bool
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	configuration, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}

	dialer, err := platform.NewKafkaDialer(ctx, configuration.kafka)
	if err != nil {
		log.Fatal(err)
	}
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        configuration.kafka.Brokers,
		Topic:          commandTopic,
		GroupID:        configuration.consumerGroup,
		Dialer:         dialer,
		CommitInterval: 0,
		MinBytes:       1,
		MaxBytes:       2 << 20,
		MaxWait:        time.Second,
	})
	defer reader.Close()
	eventWriter, err := platform.NewKafkaWriter(ctx, configuration.kafka)
	if err != nil {
		log.Fatal(err)
	}
	defer eventWriter.Close()

	var client kubernetes.Interface
	if configuration.mode == "kubernetes" {
		clusterConfig, configErr := rest.InClusterConfig()
		if configErr != nil {
			log.Fatalf("load in-cluster config: %v", configErr)
		}
		client, err = kubernetes.NewForConfig(clusterConfig)
		if err != nil {
			log.Fatalf("create kubernetes client: %v", err)
		}
	}

	s := &scheduler{config: configuration, client: client, eventWriter: eventWriter}
	s.healthy.Store(true)
	go s.serveMetrics(ctx)
	if client != nil {
		go s.reconcileFailedJobs(ctx)
	}
	logJSON("info", "scheduler started", map[string]any{"mode": configuration.mode})
	if err := s.consume(ctx, reader); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func (s *scheduler) consume(ctx context.Context, reader *kafka.Reader) error {
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var command recordingv1.StartRecordingCommand
		if err := proto.Unmarshal(message.Value, &command); err != nil {
			return fmt.Errorf("decode start command at offset %d: %w", message.Offset, err)
		}
		if err := validateCommand(&command); err != nil {
			return fmt.Errorf("invalid command %s: %w", command.GetCommandId(), err)
		}
		retryDelay := 2 * time.Second
		for {
			if err := s.ensureRecorder(ctx, &command); err != nil {
				s.healthy.Store(false)
				logJSON("error", "recorder scheduling failed; command retained for retry", map[string]any{
					"recording_id": command.GetRecordingId(), "retry_after": retryDelay.String(), "error": err.Error(),
				})
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(retryDelay):
				}
				if retryDelay < 30*time.Second {
					retryDelay *= 2
					if retryDelay > 30*time.Second {
						retryDelay = 30 * time.Second
					}
				}
				continue
			}
			break
		}
		if err := reader.CommitMessages(ctx, message); err != nil {
			return fmt.Errorf("commit start command: %w", err)
		}
		s.healthy.Store(true)
	}
}

func (s *scheduler) ensureRecorder(ctx context.Context, command *recordingv1.StartRecordingCommand) error {
	if s.config.mode == "local" {
		return s.startLocalRecorder(command)
	}
	job := s.recorderJob(command)
	_, err := s.client.BatchV1().Jobs(s.config.namespace).Create(ctx, job, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		logJSON("info", "duplicate command matched existing job", map[string]any{
			"recording_id": command.GetRecordingId(), "job_name": job.Name,
		})
		return nil
	}
	if err != nil {
		return fmt.Errorf("create job %s: %w", job.Name, err)
	}
	s.jobsStarted.Add(1)
	logJSON("info", "recorder job created", map[string]any{
		"recording_id": command.GetRecordingId(), "job_name": job.Name,
	})
	return nil
}

func (s *scheduler) startLocalRecorder(command *recordingv1.StartRecordingCommand) error {
	process := exec.Command(s.config.recorderBinary)
	process.Stdout = os.Stdout
	process.Stderr = os.Stderr
	process.Env = append(os.Environ(), s.recorderEnvironment(command)...)
	if err := process.Start(); err != nil {
		return fmt.Errorf("start local recorder: %w", err)
	}
	s.jobsStarted.Add(1)
	go func() {
		if err := process.Wait(); err != nil {
			s.jobsFailed.Add(1)
			logJSON("error", "local recorder exited", map[string]any{
				"recording_id": command.GetRecordingId(), "error": err.Error(),
			})
		}
	}()
	return nil
}

func (s *scheduler) recorderJob(command *recordingv1.StartRecordingCommand) *batchv1.Job {
	backoffLimit := int32(0)
	deadline := int64(command.GetMaxDurationSeconds()) + 150
	ttl := int32(60)
	nonRoot := true
	user := int64(65532)
	readOnly := true
	noPrivilege := false
	jobName := jobName(command.GetRecordingId())
	labels := map[string]string{
		"app": "vigil", "component": "recorder", "managed-by": "vigil-scheduler",
	}
	annotations := map[string]string{
		"vigil.dev/recording-id": command.GetRecordingId(),
		"vigil.dev/attempt-id":   command.GetAttemptId(),
		"vigil.dev/command-id":   command.GetCommandId(),
	}
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: jobName, Namespace: s.config.namespace, Labels: labels, Annotations: annotations},
		Spec: batchv1.JobSpec{
			BackoffLimit:            &backoffLimit,
			ActiveDeadlineSeconds:   &deadline,
			TTLSecondsAfterFinished: &ttl,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels, Annotations: annotations},
				Spec: corev1.PodSpec{
					ServiceAccountName:           "vigil-recorder",
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: boolPointer(true),
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot:   &nonRoot,
						RunAsUser:      &user,
						SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					Containers: []corev1.Container{{
						Name: "recorder", Image: s.config.recorderImage, ImagePullPolicy: corev1.PullIfNotPresent,
						Command: []string{"/app/recorder"},
						Env:     envVars(s.recorderEnvironment(command)),
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:              resource.MustParse("500m"),
								corev1.ResourceMemory:           resource.MustParse("512Mi"),
								corev1.ResourceEphemeralStorage: resource.MustParse("1Gi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:              resource.MustParse("1"),
								corev1.ResourceMemory:           resource.MustParse("1Gi"),
								corev1.ResourceEphemeralStorage: resource.MustParse("2Gi"),
							},
						},
						SecurityContext: &corev1.SecurityContext{
							AllowPrivilegeEscalation: &noPrivilege,
							ReadOnlyRootFilesystem:   &readOnly,
							Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
						},
						VolumeMounts: []corev1.VolumeMount{{Name: "spool", MountPath: "/spool"}},
					}},
					Volumes: []corev1.Volume{{
						Name: "spool",
						VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{
							SizeLimit: quantityPointer(resource.MustParse("2Gi")),
						}},
					}},
				},
			},
		},
	}
}

func (s *scheduler) recorderEnvironment(command *recordingv1.StartRecordingCommand) []string {
	spoolDirectory := "/spool"
	if s.config.mode == "local" {
		spoolDirectory = "/spool/" + command.GetRecordingId()
	}
	values := []string{
		"RECORDING_ID=" + command.GetRecordingId(),
		"ATTEMPT_ID=" + command.GetAttemptId(),
		"JOB_NAME=" + jobName(command.GetRecordingId()),
		"MAX_DURATION_SECONDS=" + strconv.Itoa(int(command.GetMaxDurationSeconds())),
		"LEASE_ENDPOINT=" + s.config.leaseEndpoint,
		"LEASE_AUDIENCE=" + s.config.leaseAudience,
		"LEASE_INSECURE=" + s.config.leaseInsecure,
		"STORAGE_BUCKET=" + s.config.storageBucket,
		"KAFKA_BROKERS=" + strings.Join(s.config.kafka.Brokers, ","),
		"KAFKA_AUTH_MODE=" + s.config.kafka.AuthMode,
		"ALLOWED_HLS_HOSTS=" + s.config.allowedHLSHosts,
		"SPOOL_DIR=" + spoolDirectory,
	}
	return values
}

func (s *scheduler) reconcileFailedJobs(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			jobs, err := s.client.BatchV1().Jobs(s.config.namespace).List(ctx, metav1.ListOptions{LabelSelector: "app=vigil,component=recorder"})
			if err != nil {
				logJSON("error", "failed job reconciliation list failed", map[string]any{"error": err.Error()})
				continue
			}
			for index := range jobs.Items {
				job := &jobs.Items[index]
				if job.Status.Failed == 0 || job.Annotations["vigil.dev/failure-event-published"] == "true" {
					continue
				}
				recordingID := job.Annotations["vigil.dev/recording-id"]
				attemptID := job.Annotations["vigil.dev/attempt-id"]
				event := events.Envelope(recordingID, attemptID, "RECORDING_FAILED", 9_000_000)
				event.Payload = &recordingv1.RecordingEvent_Failed{Failed: &recordingv1.RecordingFailed{
					Code: "JOB_FAILED", Message: "Kubernetes recorder Job reached a failed terminal condition",
				}}
				if err := events.Publish(ctx, s.eventWriter, event); err != nil {
					logJSON("error", "publish job failure event failed", map[string]any{"job_name": job.Name, "error": err.Error()})
					continue
				}
				copy := job.DeepCopy()
				if copy.Annotations == nil {
					copy.Annotations = map[string]string{}
				}
				copy.Annotations["vigil.dev/failure-event-published"] = "true"
				if _, err := s.client.BatchV1().Jobs(s.config.namespace).Update(ctx, copy, metav1.UpdateOptions{}); err != nil {
					logJSON("error", "mark job failure event failed", map[string]any{"job_name": job.Name, "error": err.Error()})
				}
				s.jobsFailed.Add(1)
			}
		}
	}
}

func (s *scheduler) serveMetrics(ctx context.Context) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(response http.ResponseWriter, _ *http.Request) {
		if s.healthy.Load() {
			response.WriteHeader(http.StatusOK)
		} else {
			response.WriteHeader(http.StatusServiceUnavailable)
		}
		_, _ = response.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/metrics", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = fmt.Fprintf(response, "vigil_scheduler_jobs_started_total %d\nvigil_scheduler_jobs_failed_total %d\nvigil_scheduler_healthy %d\n", s.jobsStarted.Load(), s.jobsFailed.Load(), boolInt(s.healthy.Load()))
	})
	server := &http.Server{Addr: ":" + s.config.metricsPort, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logJSON("error", "metrics server failed", map[string]any{"error": err.Error()})
	}
}

func loadConfig() (config, error) {
	brokers := platform.ParseBrokers(environment("KAFKA_BROKERS", "kafka:9092"))
	if len(brokers) == 0 {
		return config{}, errors.New("KAFKA_BROKERS is empty")
	}
	mode := environment("SCHEDULER_MODE", "kubernetes")
	if mode != "kubernetes" && mode != "local" {
		return config{}, fmt.Errorf("invalid SCHEDULER_MODE %q", mode)
	}
	configuration := config{
		mode:            mode,
		namespace:       environment("NAMESPACE", "vigil"),
		recorderImage:   os.Getenv("RECORDER_IMAGE"),
		recorderBinary:  environment("RECORDER_BINARY", "/app/recorder"),
		leaseEndpoint:   environment("LEASE_ENDPOINT", "vigil-lease:8080"),
		leaseAudience:   os.Getenv("LEASE_AUDIENCE"),
		leaseInsecure:   environment("LEASE_INSECURE", "false"),
		storageBucket:   os.Getenv("STORAGE_BUCKET"),
		allowedHLSHosts: environment("ALLOWED_HLS_HOSTS", "synthetic-hls,synthetic-hls.vigil.svc.cluster.local"),
		kafka:           platform.KafkaConfig{Brokers: brokers, AuthMode: environment("KAFKA_AUTH_MODE", "local")},
		consumerGroup:   environment("KAFKA_SCHEDULER_GROUP", "vigil-scheduler-v1"),
		metricsPort:     environment("METRICS_PORT", "9090"),
	}
	if mode == "kubernetes" && configuration.recorderImage == "" {
		return config{}, errors.New("RECORDER_IMAGE is required in kubernetes mode")
	}
	if configuration.storageBucket == "" {
		return config{}, errors.New("STORAGE_BUCKET is required")
	}
	return configuration, nil
}

func validateCommand(command *recordingv1.StartRecordingCommand) error {
	for name, value := range map[string]string{"command_id": command.GetCommandId(), "recording_id": command.GetRecordingId(), "attempt_id": command.GetAttemptId(), "creator_id": command.GetCreatorId()} {
		if _, err := uuid.Parse(value); err != nil {
			return fmt.Errorf("%s is not a UUID", name)
		}
	}
	if command.GetSourceId() != "synthetic-hls" {
		return errors.New("source_id is not allowed")
	}
	if command.GetMaxDurationSeconds() < 5 || command.GetMaxDurationSeconds() > 600 {
		return errors.New("duration is outside 5..600 seconds")
	}
	return nil
}

func jobName(recordingID string) string {
	return "vigil-rec-" + strings.ReplaceAll(recordingID, "-", "")[:24]
}
func envVars(values []string) []corev1.EnvVar {
	result := make([]corev1.EnvVar, 0, len(values))
	for _, value := range values {
		parts := strings.SplitN(value, "=", 2)
		result = append(result, corev1.EnvVar{Name: parts[0], Value: parts[1]})
	}
	return result
}
func environment(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func boolPointer(value bool) *bool                               { return &value }
func quantityPointer(value resource.Quantity) *resource.Quantity { return &value }
func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
func logJSON(level, message string, fields map[string]any) {
	fields["severity"] = strings.ToUpper(level)
	fields["message"] = message
	fields["timestamp"] = time.Now().UTC().Format(time.RFC3339Nano)
	data, _ := json.Marshal(fields)
	fmt.Println(string(data))
}

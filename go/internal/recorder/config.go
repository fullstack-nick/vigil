package recorder

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/fullstack-nick/vigil/go/internal/platform"
	"github.com/google/uuid"
)

type Config struct {
	RecordingID       string
	AttemptID         string
	JobName           string
	WorkerID          string
	MaxDuration       time.Duration
	LeaseEndpoint     string
	LeaseAudience     string
	LeaseInsecure     bool
	StorageBucket     string
	SpoolDirectory    string
	MaximumSpoolBytes int64
	AllowedHLSHosts   map[string]struct{}
	FFmpegPath        string
	FFprobePath       string
	Kafka             platform.KafkaConfig
}

func LoadConfig() (Config, error) {
	durationSeconds, err := strconv.Atoi(environment("MAX_DURATION_SECONDS", "30"))
	if err != nil || durationSeconds < 5 || durationSeconds > 600 {
		return Config{}, errors.New("MAX_DURATION_SECONDS must be between 5 and 600")
	}
	maximumSpoolBytes, err := strconv.ParseInt(environment("MAX_SPOOL_BYTES", "536870912"), 10, 64)
	if err != nil || maximumSpoolBytes < 10<<20 || maximumSpoolBytes > 1<<30 {
		return Config{}, errors.New("MAX_SPOOL_BYTES must be between 10 MiB and 1 GiB")
	}
	recordingID := os.Getenv("RECORDING_ID")
	attemptID := os.Getenv("ATTEMPT_ID")
	if _, err := uuid.Parse(recordingID); err != nil {
		return Config{}, fmt.Errorf("RECORDING_ID is invalid: %w", err)
	}
	if _, err := uuid.Parse(attemptID); err != nil {
		return Config{}, fmt.Errorf("ATTEMPT_ID is invalid: %w", err)
	}
	jobName := os.Getenv("JOB_NAME")
	if jobName == "" {
		return Config{}, errors.New("JOB_NAME is required")
	}
	storageBucket := os.Getenv("STORAGE_BUCKET")
	if storageBucket == "" {
		return Config{}, errors.New("STORAGE_BUCKET is required")
	}
	brokers := platform.ParseBrokers(environment("KAFKA_BROKERS", "kafka:9092"))
	if len(brokers) == 0 {
		return Config{}, errors.New("KAFKA_BROKERS is empty")
	}
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "recorder"
	}
	allowedHosts := make(map[string]struct{})
	for _, host := range strings.Split(environment("ALLOWED_HLS_HOSTS", "synthetic-hls,synthetic-hls.vigil.svc.cluster.local"), ",") {
		if trimmed := strings.ToLower(strings.TrimSpace(host)); trimmed != "" {
			allowedHosts[trimmed] = struct{}{}
		}
	}
	leaseInsecure, _ := strconv.ParseBool(environment("LEASE_INSECURE", "false"))
	configuration := Config{
		RecordingID:       recordingID,
		AttemptID:         attemptID,
		JobName:           jobName,
		WorkerID:          hostname + "-" + uuid.NewString()[:8],
		MaxDuration:       time.Duration(durationSeconds) * time.Second,
		LeaseEndpoint:     environment("LEASE_ENDPOINT", "vigil-lease:8080"),
		LeaseAudience:     os.Getenv("LEASE_AUDIENCE"),
		LeaseInsecure:     leaseInsecure,
		StorageBucket:     storageBucket,
		SpoolDirectory:    environment("SPOOL_DIR", "/spool"),
		MaximumSpoolBytes: maximumSpoolBytes,
		AllowedHLSHosts:   allowedHosts,
		FFmpegPath:        environment("FFMPEG_PATH", "ffmpeg"),
		FFprobePath:       environment("FFPROBE_PATH", "ffprobe"),
		Kafka:             platform.KafkaConfig{Brokers: brokers, AuthMode: environment("KAFKA_AUTH_MODE", "local")},
	}
	cleanSpool := filepath.Clean(configuration.SpoolDirectory)
	if cleanSpool == "." || cleanSpool == string(filepath.Separator) || len(cleanSpool) < 4 {
		return Config{}, errors.New("SPOOL_DIR must identify a dedicated non-root directory")
	}
	configuration.SpoolDirectory = cleanSpool
	if !configuration.LeaseInsecure && configuration.LeaseAudience == "" {
		return Config{}, errors.New("LEASE_AUDIENCE is required for authenticated gRPC")
	}
	return configuration, nil
}

func environment(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

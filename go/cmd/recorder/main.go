package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	recordingv1 "github.com/fullstack-nick/vigil/go/gen/vigil/recording/v1"
	"github.com/fullstack-nick/vigil/go/internal/events"
	"github.com/fullstack-nick/vigil/go/internal/platform"
	"github.com/fullstack-nick/vigil/go/internal/recorder"
	"github.com/segmentio/kafka-go"
)

func main() {
	baseContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(baseContext); err != nil {
		logJSON("error", "recorder failed", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
}

func run(baseContext context.Context) error {
	configuration, err := recorder.LoadConfig()
	if err != nil {
		return err
	}
	configuration.SpoolDirectory = filepath.Join(configuration.SpoolDirectory, configuration.AttemptID)
	if err := os.MkdirAll(configuration.SpoolDirectory, 0o750); err != nil {
		return err
	}
	defer func() {
		if err := os.RemoveAll(configuration.SpoolDirectory); err != nil {
			logJSON("warn", "spool cleanup failed", map[string]any{"error": err.Error()})
		}
	}()

	eventWriter, err := platform.NewKafkaWriter(baseContext, configuration.Kafka)
	if err != nil {
		return err
	}
	defer eventWriter.Close()
	store, err := recorder.NewObjectStore(baseContext, configuration.StorageBucket)
	if err != nil {
		return err
	}
	defer store.Close()
	leaseClient, err := recorder.NewLeaseClient(baseContext, configuration)
	if err != nil {
		return err
	}
	defer leaseClient.Close()

	lease, denialReason, err := leaseClient.Acquire(baseContext)
	if err != nil {
		return fail(baseContext, eventWriter, configuration, "LEASE_ACQUIRE_FAILED", err)
	}
	if denialReason != "" {
		return stopWithoutRecording(baseContext, eventWriter, configuration, denialReason)
	}
	terminalReason := "FAILED"
	defer func() {
		releaseContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := leaseClient.Release(releaseContext, terminalReason); err != nil {
			logJSON("warn", "lease release failed", map[string]any{"error": err.Error()})
		}
	}()

	if err := recorder.ValidateSource(baseContext, lease.SourceURL, configuration.AllowedHLSHosts); err != nil {
		return fail(baseContext, eventWriter, configuration, "SOURCE_REJECTED", err)
	}
	recordingContext, cancelRecording := context.WithCancelCause(baseContext)
	defer cancelRecording(errors.New("recorder finished"))
	go leaseClient.Watch(recordingContext, lease.ExpiresAt, cancelRecording)

	started := events.Envelope(configuration.RecordingID, configuration.AttemptID, "RECORDING_STARTED", 1)
	started.Payload = &recordingv1.RecordingEvent_Started{Started: &recordingv1.RecordingStarted{
		WorkerId: configuration.WorkerID, JobName: configuration.JobName,
	}}
	if err := events.Publish(recordingContext, eventWriter, started); err != nil {
		cancelRecording(err)
		return fmt.Errorf("publish started event: %w", err)
	}
	logJSON("info", "capture started", map[string]any{
		"recording_id": configuration.RecordingID, "attempt_id": configuration.AttemptID,
	})

	publishSegment := func(ctx context.Context, segment recorder.StoredSegment) error {
		event := events.Envelope(configuration.RecordingID, configuration.AttemptID, "SEGMENT_UPLOADED", uint64(segment.Index)+1)
		event.Payload = &recordingv1.RecordingEvent_SegmentUploaded{SegmentUploaded: &recordingv1.SegmentUploaded{
			SegmentIndex:   segment.Index,
			ObjectName:     segment.ObjectName,
			ByteCount:      uint64(segment.Size),
			Crc32C:         recorder.CRC32CBase64(segment.CRC32C),
			DurationMillis: 5_000,
		}}
		return events.Publish(ctx, eventWriter, event)
	}
	segments, captureErr := recorder.Capture(recordingContext, configuration, lease.SourceURL, lease.StoragePrefix, store, publishSegment)
	if captureErr != nil {
		cause := context.Cause(recordingContext)
		if denial := recorder.DenialReason(cause); denial != "" {
			terminalReason = "CANCELLED:" + denial
			cleanupContext, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := store.DeleteRecording(cleanupContext, configuration.RecordingID); err != nil {
				logJSON("error", "cancelled recording cleanup failed", map[string]any{"error": err.Error()})
			}
			return publishStopped(cleanupContext, eventWriter, configuration, denial)
		}
		terminalReason = "FAILED"
		return fail(context.Background(), eventWriter, configuration, errorCode(captureErr), captureErr)
	}

	finalizingSequence := uint64(len(segments)) + 2
	finalizing := events.Envelope(configuration.RecordingID, configuration.AttemptID, "RECORDING_FINALIZING", finalizingSequence)
	finalizing.Payload = &recordingv1.RecordingEvent_Finalizing{Finalizing: &recordingv1.RecordingFinalizing{SegmentCount: uint32(len(segments))}}
	if err := events.Publish(recordingContext, eventWriter, finalizing); err != nil {
		return fail(context.Background(), eventWriter, configuration, "EVENT_PUBLISH_FAILED", err)
	}
	finalMedia, err := recorder.Finalize(recordingContext, configuration, store, segments)
	if err != nil {
		if denial := recorder.DenialReason(context.Cause(recordingContext)); denial != "" {
			terminalReason = "CANCELLED:" + denial
			cleanupContext, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_ = store.DeleteRecording(cleanupContext, configuration.RecordingID)
			return publishStopped(cleanupContext, eventWriter, configuration, denial)
		}
		return fail(context.Background(), eventWriter, configuration, "FINALIZATION_FAILED", err)
	}
	if denial := recorder.DenialReason(context.Cause(recordingContext)); denial != "" {
		terminalReason = "CANCELLED:" + denial
		cleanupContext, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = store.DeleteRecording(cleanupContext, configuration.RecordingID)
		return publishStopped(cleanupContext, eventWriter, configuration, denial)
	}
	completed := events.Envelope(configuration.RecordingID, configuration.AttemptID, "RECORDING_COMPLETED", finalizingSequence+1)
	completed.Payload = &recordingv1.RecordingEvent_Completed{Completed: &recordingv1.RecordingCompleted{
		ObjectName:     finalMedia.ObjectName,
		ByteCount:      uint64(finalMedia.Size),
		DurationMillis: finalMedia.DurationMillis,
		SegmentCount:   finalMedia.SegmentCount,
	}}
	if err := events.Publish(recordingContext, eventWriter, completed); err != nil {
		return fail(context.Background(), eventWriter, configuration, "EVENT_PUBLISH_FAILED", err)
	}
	terminalReason = "READY"
	logJSON("info", "recording completed", map[string]any{
		"recording_id":  configuration.RecordingID,
		"segment_count": finalMedia.SegmentCount,
		"byte_count":    finalMedia.Size,
	})
	return nil
}

func stopWithoutRecording(ctx context.Context, writer *kafka.Writer, config recorder.Config, denial string) error {
	if err := publishStopped(ctx, writer, config, denial); err != nil {
		return err
	}
	logJSON("info", "recording lease denied", map[string]any{"recording_id": config.RecordingID, "reason": denial})
	return nil
}

func publishStopped(ctx context.Context, writer *kafka.Writer, config recorder.Config, reason string) error {
	event := events.Envelope(config.RecordingID, config.AttemptID, "RECORDING_STOPPED", 8_000_000)
	event.Payload = &recordingv1.RecordingEvent_Stopped{Stopped: &recordingv1.RecordingStopped{
		Reason: stopReason(reason), Detail: "authorization lease ended capture",
	}}
	return events.Publish(ctx, writer, event)
}

func fail(ctx context.Context, writer *kafka.Writer, config recorder.Config, code string, cause error) error {
	publishContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	event := events.Envelope(config.RecordingID, config.AttemptID, "RECORDING_FAILED", 8_500_000)
	event.Payload = &recordingv1.RecordingEvent_Failed{Failed: &recordingv1.RecordingFailed{
		Code: code, Message: safeMessage(cause),
	}}
	if eventErr := events.Publish(publishContext, writer, event); eventErr != nil {
		return fmt.Errorf("%w; additionally failed to publish terminal event: %v", cause, eventErr)
	}
	return cause
}

func stopReason(reason string) recordingv1.StopReason {
	if strings.Contains(reason, "CONSENT") {
		return recordingv1.StopReason_STOP_REASON_CONSENT_REVOKED
	}
	if strings.Contains(reason, "LEASE") {
		return recordingv1.StopReason_STOP_REASON_LEASE_EXPIRED
	}
	return recordingv1.StopReason_STOP_REASON_OPERATOR_REQUESTED
}

func errorCode(err error) string {
	message := err.Error()
	if index := strings.IndexByte(message, ':'); index > 0 {
		candidate := strings.ReplaceAll(strings.ToUpper(message[:index]), " ", "_")
		if len(candidate) <= 64 {
			return candidate
		}
	}
	return "CAPTURE_FAILED"
}

func safeMessage(err error) string {
	message := err.Error()
	if len(message) > 500 {
		message = message[:500]
	}
	if strings.Contains(message, "://") {
		return "media operation failed; source details were redacted"
	}
	return message
}

func logJSON(level, message string, fields map[string]any) {
	fields["severity"] = strings.ToUpper(level)
	fields["message"] = message
	fields["timestamp"] = time.Now().UTC().Format(time.RFC3339Nano)
	data, _ := json.Marshal(fields)
	fmt.Println(string(data))
}

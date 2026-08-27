package events

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	recordingv1 "github.com/fullstack-nick/vigil/go/gen/vigil/recording/v1"
	"github.com/segmentio/kafka-go"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const EventTopic = "vigil.recording.events.v1"

func DeterministicID(recordingID, attemptID, kind string, sequence uint64) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%s:%d", recordingID, attemptID, kind, sequence)))
	return "evt_" + hex.EncodeToString(digest[:16])
}

func Envelope(recordingID, attemptID, kind string, sequence uint64) *recordingv1.RecordingEvent {
	return &recordingv1.RecordingEvent{
		EventId:     DeterministicID(recordingID, attemptID, kind, sequence),
		RecordingId: recordingID,
		AttemptId:   attemptID,
		Sequence:    sequence,
		OccurredAt:  timestamppb.Now(),
	}
}

func Publish(ctx context.Context, writer *kafka.Writer, event *recordingv1.RecordingEvent) error {
	data, err := proto.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal recording event: %w", err)
	}
	if err := writer.WriteMessages(ctx, kafka.Message{
		Topic: EventTopic,
		Key:   []byte(event.GetRecordingId()),
		Value: data,
		Headers: []kafka.Header{
			{Key: "vigil-event-id", Value: []byte(event.GetEventId())},
		},
	}); err != nil {
		return fmt.Errorf("publish recording event: %w", err)
	}
	return nil
}

package main

import (
	"fmt"
	"os"
	"time"

	recordingv1 "github.com/fullstack-nick/vigil/go/gen/vigil/recording/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	eventID     = "evt_fixture_000000000000000000000001"
	recordingID = "10000000-0000-4000-8000-000000000001"
	attemptID   = "20000000-0000-4000-8000-000000000001"
)

func main() {
	if len(os.Args) != 3 {
		fail("usage: fixture <write|verify> <path>")
	}
	switch os.Args[1] {
	case "write":
		data, err := proto.Marshal(expected())
		if err != nil {
			fail(err.Error())
		}
		if err := os.WriteFile(os.Args[2], data, 0o600); err != nil {
			fail(err.Error())
		}
	case "verify":
		data, err := os.ReadFile(os.Args[2])
		if err != nil {
			fail(err.Error())
		}
		var actual recordingv1.RecordingEvent
		if err := proto.Unmarshal(data, &actual); err != nil {
			fail(err.Error())
		}
		if !proto.Equal(&actual, expected()) {
			fail(fmt.Sprintf("fixture mismatch: %s", actual.String()))
		}
	default:
		fail("unknown fixture operation")
	}
}

func expected() *recordingv1.RecordingEvent {
	return &recordingv1.RecordingEvent{
		EventId:     eventID,
		RecordingId: recordingID,
		AttemptId:   attemptID,
		Sequence:    7,
		OccurredAt:  timestamppb.New(time.Date(2026, 8, 27, 12, 34, 56, 123_000_000, time.UTC)),
		Payload: &recordingv1.RecordingEvent_SegmentUploaded{SegmentUploaded: &recordingv1.SegmentUploaded{
			SegmentIndex:   6,
			ObjectName:     "raw/10000000/20000000/segment-000006.ts",
			ByteCount:      123456,
			Crc32C:         "6I6MWA==",
			DurationMillis: 5000,
		}},
	}
}

func fail(message string) { _, _ = fmt.Fprintln(os.Stderr, message); os.Exit(1) }

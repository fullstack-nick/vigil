import { describe, expect, it } from "vitest";

import { reduceRecording, type RecordingEvent } from "./projection.js";

const base = {
  recordingId: "recording-a",
  attemptId: "attempt-a",
  occurredAt: new Date("2026-08-27T12:00:00.000Z"),
};

function started(sequence = 1): RecordingEvent {
  return {
    ...base,
    eventId: `started-${sequence}`,
    sequence,
    kind: "RECORDING_STARTED",
    payload: { workerId: "worker-a", jobName: "vigil-rec-a" },
  };
}

function segment(sequence: number, bytes = 100): RecordingEvent {
  return {
    ...base,
    eventId: `segment-${sequence}`,
    sequence,
    kind: "SEGMENT_UPLOADED",
    payload: {
      segmentIndex: sequence - 1,
      objectName: `raw/a/a/segment-${String(sequence - 1).padStart(6, "0")}.ts`,
      byteCount: bytes,
      crc32c: "AAAAAA==",
      durationMillis: 5_000,
    },
  };
}

function completed(sequence = 4): RecordingEvent {
  return {
    ...base,
    eventId: `completed-${sequence}`,
    sequence,
    kind: "RECORDING_COMPLETED",
    payload: {
      objectName: "vod/a/recording.mp4",
      byteCount: 200,
      durationMillis: 10_000,
      segmentCount: 2,
    },
  };
}

function stopped(sequence = 5): RecordingEvent {
  return {
    ...base,
    eventId: `stopped-${sequence}`,
    sequence,
    kind: "RECORDING_STOPPED",
    payload: { reason: "CONSENT_REVOKED", detail: "lease denied" },
  };
}

describe("reduceRecording", () => {
  it.each([
    {
      name: "projects an ordinary successful history",
      events: [started(), segment(2), segment(3), completed()],
      status: "READY",
      segments: 2,
    },
    {
      name: "rebuilds correctly after out-of-order delivery",
      events: [segment(2), completed(), started(), segment(3)],
      status: "READY",
      segments: 2,
    },
    {
      name: "does not regress a terminal completion",
      events: [started(), completed(2), started(9)],
      status: "READY",
      segments: 2,
    },
    {
      name: "gives a consent stop precedence over completion",
      events: [stopped(2), started(), completed(9)],
      status: "CANCELLED",
      segments: 0,
    },
  ])("$name", ({ events, status, segments }) => {
    const result = reduceRecording(events);
    expect(result.status).toBe(status);
    expect(result.segmentCount).toBe(segments);
    if (status === "CANCELLED") {
      expect(result.finalObjectName).toBeUndefined();
    }
  });
});

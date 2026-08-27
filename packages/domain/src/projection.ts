export const RECORDING_STATUSES = [
  "REQUESTED",
  "STARTING",
  "RECORDING",
  "FINALIZING",
  "READY",
  "CANCELLED",
  "FAILED",
  "REJECTED_NO_CONSENT",
] as const;

export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export type RecordingEvent =
  | BaseEvent<"RECORDING_STARTED", { workerId: string; jobName: string }>
  | BaseEvent<
      "SEGMENT_UPLOADED",
      {
        segmentIndex: number;
        objectName: string;
        byteCount: number;
        crc32c: string;
        durationMillis: number;
      }
    >
  | BaseEvent<"RECORDING_FINALIZING", { segmentCount: number }>
  | BaseEvent<
      "RECORDING_COMPLETED",
      {
        objectName: string;
        byteCount: number;
        durationMillis: number;
        segmentCount: number;
      }
    >
  | BaseEvent<"RECORDING_FAILED", { code: string; message: string }>
  | BaseEvent<"RECORDING_STOPPED", { reason: string; detail: string }>;

export interface BaseEvent<TKind extends string, TPayload> {
  eventId: string;
  recordingId: string;
  attemptId: string;
  sequence: number;
  occurredAt: Date;
  kind: TKind;
  payload: TPayload;
}

export interface RecordingProjection {
  status: RecordingStatus;
  projectionVersion: number;
  startedAt?: Date;
  completedAt?: Date;
  segmentCount: number;
  byteCount: number;
  durationMillis: number;
  finalObjectName?: string;
  failureCode?: string;
  failureMessage?: string;
  stopReason?: string;
}

const terminalStatuses = new Set<RecordingStatus>([
  "READY",
  "CANCELLED",
  "FAILED",
  "REJECTED_NO_CONSENT",
]);

export function isTerminal(status: RecordingStatus): boolean {
  return terminalStatuses.has(status);
}

export function reduceRecording(
  events: readonly RecordingEvent[],
  initialStatus: RecordingStatus = "REQUESTED",
): RecordingProjection {
  const projection: RecordingProjection = {
    status: initialStatus,
    projectionVersion: 0,
    segmentCount: 0,
    byteCount: 0,
    durationMillis: 0,
  };

  const sorted = [...events].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      left.occurredAt.getTime() - right.occurredAt.getTime() ||
      left.eventId.localeCompare(right.eventId),
  );

  const stop = sorted.find((event) => event.kind === "RECORDING_STOPPED");

  for (const event of sorted) {
    projection.projectionVersion = Math.max(projection.projectionVersion, event.sequence);

    switch (event.kind) {
      case "RECORDING_STARTED":
        projection.startedAt ??= event.occurredAt;
        if (!isTerminal(projection.status)) {
          projection.status = "RECORDING";
        }
        break;
      case "SEGMENT_UPLOADED":
        projection.segmentCount += 1;
        projection.byteCount += event.payload.byteCount;
        projection.durationMillis += event.payload.durationMillis;
        break;
      case "RECORDING_FINALIZING":
        if (!isTerminal(projection.status)) {
          projection.status = "FINALIZING";
        }
        break;
      case "RECORDING_COMPLETED":
        if (!isTerminal(projection.status)) {
          projection.status = "READY";
          projection.completedAt = event.occurredAt;
          projection.finalObjectName = event.payload.objectName;
          projection.byteCount = event.payload.byteCount;
          projection.durationMillis = event.payload.durationMillis;
          projection.segmentCount = event.payload.segmentCount;
        }
        break;
      case "RECORDING_FAILED":
        if (!isTerminal(projection.status)) {
          projection.status = "FAILED";
          projection.completedAt = event.occurredAt;
          projection.failureCode = event.payload.code;
          projection.failureMessage = event.payload.message;
        }
        break;
      case "RECORDING_STOPPED":
        projection.status = "CANCELLED";
        projection.completedAt = event.occurredAt;
        projection.stopReason = event.payload.reason;
        delete projection.finalObjectName;
        break;
    }
  }

  // A consent or operator stop is privacy-authoritative even if a completion
  // event has a larger sequence or arrived first.
  if (stop?.kind === "RECORDING_STOPPED") {
    projection.status = "CANCELLED";
    projection.completedAt = stop.occurredAt;
    projection.stopReason = stop.payload.reason;
    delete projection.finalObjectName;
  }

  return projection;
}

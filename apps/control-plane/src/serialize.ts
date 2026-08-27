import type { RecordingDetail } from "@vigil/database";

export function serializeRecording(recording: RecordingDetail) {
  return {
    id: recording.id,
    creatorId: recording.creator_id,
    creatorDisplayName: recording.creator_display_name,
    sourceId: recording.source_id,
    status: recording.status,
    requestedAt: recording.requested_at,
    stopRequestedAt: recording.stop_requested_at,
    completedAt: recording.completed_at,
    segmentCount: recording.segment_count,
    byteCount: Number(recording.final_byte_count),
    durationMillis: Number(recording.duration_millis),
    retentionExpiresAt: recording.retention_expires_at,
    purgedAt: recording.purged_at,
    projectionVersion: Number(recording.projection_version),
    publicDemo: recording.public_demo,
    failure:
      recording.failure_code || recording.failure_message
        ? { code: recording.failure_code, message: recording.failure_message }
        : null,
    cancellationReason: recording.cancellation_reason,
    playbackAvailable:
      recording.status === "READY" &&
      Boolean(recording.final_object_name) &&
      !recording.purged_at,
  };
}


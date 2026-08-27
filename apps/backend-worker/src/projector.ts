import { createHash } from "node:crypto";

import { Storage } from "@google-cloud/storage";
import { RecordingEvent as RecordingEventMessage, StopReason } from "@vigil/contracts";
import type { Database } from "@vigil/database";
import {
  reduceRecording,
  type RecordingEvent,
  type RecordingStatus,
} from "@vigil/domain";
import { log, projectedEvents } from "@vigil/observability";
import type { Consumer, EachMessagePayload } from "kafkajs";

import type { WorkerConfig } from "./config.js";

const storage = new Storage();

interface StoredEventRow {
  event_id: string;
  payload_hash: string;
  payload_json: RecordingEvent;
}

export async function runProjector(
  database: Database,
  consumer: Consumer,
  config: WorkerConfig,
  signal: AbortSignal,
  health: { projector: boolean },
): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({ topic: config.eventTopic, fromBeginning: true });
  try {
    await consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: 1,
      eachMessage: async (payload) => {
        await projectMessage(database, payload, config);
        await consumer.commitOffsets([
          {
            topic: payload.topic,
            partition: payload.partition,
            offset: (BigInt(payload.message.offset) + 1n).toString(),
          },
        ]);
        health.projector = true;
      },
    });
    health.projector = true;
    await waitForAbort(signal);
  } catch (error) {
    health.projector = false;
    if (!signal.aborted) throw error;
  } finally {
    health.projector = false;
    await consumer.stop().catch(() => undefined);
    await consumer.disconnect().catch(() => undefined);
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function projectMessage(
  database: Database,
  delivery: EachMessagePayload,
  config: WorkerConfig,
): Promise<void> {
  const bytes = delivery.message.value;
  if (!bytes) {
    throw new Error("Kafka recording event had no payload");
  }
  const decoded = RecordingEventMessage.decode(bytes);
  const event = toDomainEvent(decoded);
  await verifyCompletedObject(event, config);
  const payloadHash = createHash("sha256").update(bytes).digest("hex");
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const conflicts = await client.query<StoredEventRow>(
      `SELECT event_id, payload_hash, payload_json
         FROM recording_events
        WHERE event_id = $1 OR (attempt_id = $2 AND sequence = $3)
        FOR UPDATE`,
      [event.eventId, event.attemptId, event.sequence],
    );
    const existing = conflicts.rows[0];
    if (existing) {
      if (existing.event_id === event.eventId && existing.payload_hash === payloadHash) {
        await client.query("COMMIT");
        projectedEvents.inc({ result: "duplicate", type: event.kind });
        return;
      }
      await client.query(
        `UPDATE recording_events
            SET conflict_payload_json = $2::jsonb,
                conflict_payload_hash = $3,
                conflict_detected_at = now()
          WHERE event_id = $1`,
        [existing.event_id, JSON.stringify(event), payloadHash],
      );
      await client.query("COMMIT");
      projectedEvents.inc({ result: "conflict", type: event.kind });
      log("error", "event identity conflict quarantined", {
        event_id: event.eventId,
        stored_event_id: existing.event_id,
        attempt_id: event.attemptId,
        sequence: event.sequence,
      });
      return;
    }

    await client.query(
      `INSERT INTO recording_events
        (event_id, recording_id, attempt_id, sequence, event_type, occurred_at,
         payload, payload_json, payload_hash, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())`,
      [
        event.eventId,
        event.recordingId,
        event.attemptId,
        event.sequence,
        event.kind,
        event.occurredAt,
        bytes,
        JSON.stringify(event),
        payloadHash,
      ],
    );
    const history = await client.query<{ payload_json: RecordingEvent }>(
      `SELECT payload_json
         FROM recording_events
        WHERE recording_id = $1 AND attempt_id = $2
        ORDER BY sequence, occurred_at, event_id`,
      [event.recordingId, event.attemptId],
    );
    const status = await client.query<{ status: RecordingStatus; stop_requested_at: Date | null }>(
      "SELECT status, stop_requested_at FROM recordings WHERE id = $1 FOR UPDATE",
      [event.recordingId],
    );
    const current = status.rows[0];
    if (!current) {
      throw new Error(`Recording ${event.recordingId} does not exist`);
    }
    const parsedHistory = history.rows.map((row) => ({
      ...row.payload_json,
      occurredAt: new Date(row.payload_json.occurredAt),
    })) as RecordingEvent[];
    const initialStatus: RecordingStatus = current.stop_requested_at ? "CANCELLED" : "REQUESTED";
    const projection = reduceRecording(parsedHistory, initialStatus);
    const retentionExpiresAt =
      projection.status === "READY" && projection.completedAt
        ? new Date(projection.completedAt.getTime() + retentionHours() * 60 * 60 * 1_000)
        : null;
    await client.query(
      `UPDATE recordings
          SET status = $2,
              projection_version = $3,
              completed_at = $4,
              final_object_name = $5,
              final_byte_count = $6,
              duration_millis = $7,
              segment_count = $8,
              retention_expires_at = COALESCE($9, retention_expires_at),
              failure_code = $10,
              failure_message = $11,
              cancellation_reason = COALESCE($12, cancellation_reason),
              updated_at = now()
        WHERE id = $1`,
      [
        event.recordingId,
        projection.status,
        projection.projectionVersion,
        projection.completedAt ?? null,
        projection.finalObjectName ?? null,
        projection.byteCount,
        projection.durationMillis,
        projection.segmentCount,
        retentionExpiresAt,
        projection.failureCode ?? null,
        projection.failureMessage ?? null,
        projection.stopReason ?? null,
      ],
    );
    if (["READY", "FAILED", "CANCELLED"].includes(projection.status)) {
      await client.query(
        `UPDATE recording_attempts
            SET ended_at = COALESCE(ended_at, $2), terminal_reason = COALESCE(terminal_reason, $3),
                lease_worker_id = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1`,
        [event.attemptId, projection.completedAt ?? new Date(), projection.status],
      );
    }
    await client.query("COMMIT");
    projectedEvents.inc({ result: "projected", type: event.kind });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function verifyCompletedObject(
  event: RecordingEvent,
  config: WorkerConfig,
): Promise<void> {
  if (event.kind !== "RECORDING_COMPLETED") return;
  if (!config.storageBucket) {
    throw new Error("STORAGE_BUCKET is required to project a completed recording");
  }
  const expectedObject = `vod/${event.recordingId}/recording.mp4`;
  if (event.payload.objectName !== expectedObject) {
    throw new Error(`Completed recording object name is not deterministic: ${event.payload.objectName}`);
  }
  const emulatorHost = process.env.STORAGE_EMULATOR_HOST;
  let objectSize: number;
  if (emulatorHost) {
    const metadataUrl = `${emulatorHost.replace(/\/$/, "")}/storage/v1/b/${encodeURIComponent(config.storageBucket)}/o/${encodeURIComponent(event.payload.objectName)}`;
    const response = await fetch(metadataUrl);
    if (!response.ok) {
      throw new Error(`Completed recording object metadata returned ${response.status}`);
    }
    const metadata = (await response.json()) as { size?: string };
    objectSize = Number(metadata.size);
  } else {
    const [metadata] = await storage
      .bucket(config.storageBucket)
      .file(event.payload.objectName)
      .getMetadata();
    objectSize = Number(metadata.size);
  }
  if (objectSize !== event.payload.byteCount) {
    throw new Error(
      `Completed recording object size mismatch for ${event.recordingId}: event=${event.payload.byteCount}, object=${objectSize}`,
    );
  }
}

function toDomainEvent(event: RecordingEventMessage): RecordingEvent {
  const shared = {
    eventId: required(event.eventId, "event_id"),
    recordingId: required(event.recordingId, "recording_id"),
    attemptId: required(event.attemptId, "attempt_id"),
    sequence: positive(event.sequence, "sequence"),
    occurredAt: event.occurredAt ?? new Date(),
  };
  if (event.started) {
    return { ...shared, kind: "RECORDING_STARTED", payload: event.started };
  }
  if (event.segmentUploaded) {
    return { ...shared, kind: "SEGMENT_UPLOADED", payload: event.segmentUploaded };
  }
  if (event.finalizing) {
    return { ...shared, kind: "RECORDING_FINALIZING", payload: event.finalizing };
  }
  if (event.completed) {
    return { ...shared, kind: "RECORDING_COMPLETED", payload: event.completed };
  }
  if (event.failed) {
    return { ...shared, kind: "RECORDING_FAILED", payload: event.failed };
  }
  if (event.stopped) {
    return {
      ...shared,
      kind: "RECORDING_STOPPED",
      payload: { reason: stopReasonName(event.stopped.reason), detail: event.stopped.detail },
    };
  }
  throw new Error("RecordingEvent must contain one lifecycle payload");
}

function stopReasonName(reason: StopReason): string {
  switch (reason) {
    case StopReason.STOP_REASON_OPERATOR_REQUESTED:
      return "OPERATOR_REQUESTED";
    case StopReason.STOP_REASON_CONSENT_REVOKED:
      return "CONSENT_REVOKED";
    case StopReason.STOP_REASON_LEASE_EXPIRED:
      return "LEASE_EXPIRED";
    default:
      return "UNSPECIFIED";
  }
}

function required(value: string, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return value;
}
function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be positive`);
  return value;
}
function retentionHours(): number {
  return Number(process.env.RETENTION_HOURS ?? "24");
}

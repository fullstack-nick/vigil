import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { Database } from "./client.js";
import { withTransaction } from "./client.js";

export const DEMO_CREATOR_ID = "00000000-0000-4000-8000-000000000001";
export const COMMAND_TOPIC = "vigil.recording.commands.v1";
export const EVENT_TOPIC = "vigil.recording.events.v1";

export type ConsentAction = "GRANTED" | "REVOKED";

export interface RecordingRow {
  id: string;
  creator_id: string;
  source_id: string;
  status: string;
  idempotency_key: string;
  requested_at: Date;
  stop_requested_at: Date | null;
  completed_at: Date | null;
  final_object_name: string | null;
  final_byte_count: string;
  duration_millis: string;
  segment_count: number;
  retention_expires_at: Date | null;
  purged_at: Date | null;
  projection_version: string;
  public_demo: boolean;
  failure_code: string | null;
  failure_message: string | null;
  cancellation_reason: string | null;
}

export interface RecordingDetail extends RecordingRow {
  creator_display_name: string;
  attempt_id: string;
  job_name: string;
  lease_expires_at: Date | null;
  consent_granted: boolean;
}

export interface NewRecordingInput {
  creatorId: string;
  sourceId: string;
  idempotencyKey: string;
  requestHash: string;
  maxDurationSeconds: number;
  recordingId: string;
  attemptId: string;
  commandId: string;
  jobName: string;
  commandPayload: Buffer;
  publicDemo: boolean;
}

export class DomainConflictError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

export async function setConsent(
  database: Database,
  input: {
    creatorId: string;
    action: ConsentAction;
    actor: string;
    policyVersion: string;
    evidence?: string;
  },
): Promise<{ action: ConsentAction; occurredAt: Date; affectedRecordings: string[] }> {
  return withTransaction(database, async (client) => {
    const creator = await client.query<{ id: string }>(
      "SELECT id FROM creators WHERE id = $1 FOR UPDATE",
      [input.creatorId],
    );
    if (creator.rowCount !== 1) {
      throw new DomainConflictError("Creator was not found", "CREATOR_NOT_FOUND", 404);
    }

    const occurredAt = new Date();
    const evidenceDigest = input.evidence
      ? createHash("sha256").update(input.evidence).digest("hex")
      : null;
    await client.query(
      `INSERT INTO consent_grants
        (id, creator_id, action, actor, policy_version, evidence_digest, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        input.creatorId,
        input.action,
        input.actor,
        input.policyVersion,
        evidenceDigest,
        occurredAt,
      ],
    );

    const affectedRecordings: string[] = [];
    if (input.action === "REVOKED") {
      const result = await client.query<{ id: string }>(
        `UPDATE recordings
            SET stop_requested_at = COALESCE(stop_requested_at, now()),
                cancellation_reason = 'CONSENT_REVOKED',
                status = CASE
                  WHEN status IN ('REQUESTED', 'STARTING', 'RECORDING', 'FINALIZING')
                    THEN 'CANCELLED'
                  ELSE status
                END,
                final_object_name = CASE
                  WHEN status IN ('REQUESTED', 'STARTING', 'RECORDING', 'FINALIZING')
                    THEN NULL
                  ELSE final_object_name
                END,
                updated_at = now()
          WHERE creator_id = $1
            AND status IN ('REQUESTED', 'STARTING', 'RECORDING', 'FINALIZING')
          RETURNING id`,
        [input.creatorId],
      );
      affectedRecordings.push(...result.rows.map((row) => row.id));
    }

    return { action: input.action, occurredAt, affectedRecordings };
  });
}

export async function requestRecording(
  database: Database,
  input: NewRecordingInput,
): Promise<{ recording: RecordingDetail; replayed: boolean }> {
  return withTransaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('vigil:recording-capacity'))");

    const existing = await client.query<RecordingRow & { request_hash: string }>(
      "SELECT * FROM recordings WHERE idempotency_key = $1",
      [input.idempotencyKey],
    );
    if (existing.rowCount === 1) {
      const row = existing.rows[0];
      if (!row || row.request_hash !== input.requestHash) {
        throw new DomainConflictError(
          "Idempotency key was already used for a different request",
          "IDEMPOTENCY_CONFLICT",
        );
      }
      return { recording: await getRecordingForUpdate(client, row.id), replayed: true };
    }

    const consent = await currentConsent(client, input.creatorId);
    if (consent !== "GRANTED") {
      throw new DomainConflictError(
        "Current creator consent is required",
        "CONSENT_REQUIRED",
        422,
      );
    }

    const capacity = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM recordings
        WHERE status IN ('REQUESTED', 'STARTING', 'RECORDING', 'FINALIZING')`,
    );
    if (Number(capacity.rows[0]?.count ?? "0") >= 3) {
      throw new DomainConflictError("Recorder capacity is full", "CAPACITY_EXHAUSTED", 429);
    }

    await client.query(
      `INSERT INTO recordings
        (id, creator_id, source_id, status, idempotency_key, request_hash,
         max_duration_seconds, public_demo, requested_at, updated_at)
       VALUES ($1, $2, $3, 'REQUESTED', $4, $5, $6, $7, now(), now())`,
      [
        input.recordingId,
        input.creatorId,
        input.sourceId,
        input.idempotencyKey,
        input.requestHash,
        input.maxDurationSeconds,
        input.publicDemo,
      ],
    );
    await client.query(
      `INSERT INTO recording_attempts
        (id, recording_id, ordinal, job_name, created_at)
       VALUES ($1, $2, 1, $3, now())`,
      [input.attemptId, input.recordingId, input.jobName],
    );
    await client.query(
      `INSERT INTO outbox_messages
        (command_id, aggregate_id, topic, message_key, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [input.commandId, input.recordingId, COMMAND_TOPIC, input.recordingId, input.commandPayload],
    );

    return {
      recording: await getRecordingForUpdate(client, input.recordingId),
      replayed: false,
    };
  });
}

export async function stopRecording(
  database: Database,
  recordingId: string,
  reason = "OPERATOR_REQUESTED",
): Promise<RecordingDetail> {
  return withTransaction(database, async (client) => {
    const updated = await client.query<{ id: string }>(
      `UPDATE recordings
          SET stop_requested_at = COALESCE(stop_requested_at, now()),
              cancellation_reason = $2,
              status = CASE
                WHEN status IN ('REQUESTED', 'STARTING', 'RECORDING', 'FINALIZING')
                  THEN 'CANCELLED'
                ELSE status
              END,
              final_object_name = CASE
                WHEN status IN ('REQUESTED', 'STARTING', 'RECORDING', 'FINALIZING')
                  THEN NULL
                ELSE final_object_name
              END,
              updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [recordingId, reason],
    );
    if (updated.rowCount !== 1) {
      throw new DomainConflictError("Recording was not found", "RECORDING_NOT_FOUND", 404);
    }
    return getRecordingForUpdate(client, recordingId);
  });
}

export async function getRecording(
  database: Database,
  recordingId: string,
  publicOnly = false,
): Promise<RecordingDetail | null> {
  const result = await database.pool.query<RecordingDetail>(
    recordingDetailSql(publicOnly ? "AND r.public_demo = true" : "") + " AND r.id = $1",
    [recordingId],
  );
  return result.rows[0] ?? null;
}

export async function listPublicRecordings(
  database: Database,
  limit = 20,
): Promise<RecordingDetail[]> {
  const result = await database.pool.query<RecordingDetail>(
    recordingDetailSql("AND r.public_demo = true") +
      " ORDER BY r.requested_at DESC LIMIT $1",
    [Math.min(Math.max(limit, 1), 50)],
  );
  return result.rows;
}

export async function publicSummary(database: Database): Promise<{
  creator: { id: string; displayName: string; consentGranted: boolean };
  counts: Record<string, number>;
}> {
  const [creator, counts] = await Promise.all([
    database.pool.query<{ id: string; display_name: string; consent_granted: boolean }>(
      `SELECT c.id, c.display_name,
              COALESCE((SELECT action = 'GRANTED'
                FROM consent_grants cg
               WHERE cg.creator_id = c.id
               ORDER BY occurred_at DESC, id DESC LIMIT 1), false) AS consent_granted
         FROM creators c WHERE c.id = $1`,
      [DEMO_CREATOR_ID],
    ),
    database.pool.query<{ status: string; count: string }>(
      "SELECT status, count(*)::text AS count FROM recordings WHERE public_demo = true GROUP BY status",
    ),
  ]);
  const creatorRow = creator.rows[0];
  if (!creatorRow) {
    throw new Error("Demo creator seed is missing; run database migrations");
  }
  return {
    creator: {
      id: creatorRow.id,
      displayName: creatorRow.display_name,
      consentGranted: creatorRow.consent_granted,
    },
    counts: Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)])),
  };
}

export async function acquireLease(
  database: Database,
  input: { recordingId: string; attemptId: string; workerId: string; jobName: string },
  sourceUrl: string,
  leaseSeconds = 45,
): Promise<{
  authorized: boolean;
  denialReason: string;
  expiresAt?: Date;
  storagePrefix?: string;
  sourceUrl?: string;
}> {
  return withTransaction(database, async (client) => {
    const detail = await getRecordingForUpdate(client, input.recordingId);
    if (detail.attempt_id !== input.attemptId || detail.job_name !== input.jobName) {
      return { authorized: false, denialReason: "JOB_IDENTITY_MISMATCH" };
    }
    if (!detail.consent_granted) {
      await markLeaseDenied(client, input.recordingId, input.attemptId, "CONSENT_REVOKED");
      return { authorized: false, denialReason: "CONSENT_REVOKED" };
    }
    if (detail.stop_requested_at || detail.status === "CANCELLED") {
      await markLeaseDenied(client, input.recordingId, input.attemptId, "STOP_REQUESTED");
      return { authorized: false, denialReason: detail.cancellation_reason ?? "STOP_REQUESTED" };
    }
    if (["READY", "FAILED", "REJECTED_NO_CONSENT"].includes(detail.status)) {
      return { authorized: false, denialReason: `TERMINAL_${detail.status}` };
    }

    const attempt = await client.query<{ lease_worker_id: string | null; lease_expires_at: Date | null }>(
      "SELECT lease_worker_id, lease_expires_at FROM recording_attempts WHERE id = $1 FOR UPDATE",
      [input.attemptId],
    );
    const lease = attempt.rows[0];
    if (
      lease?.lease_worker_id &&
      lease.lease_worker_id !== input.workerId &&
      lease.lease_expires_at &&
      lease.lease_expires_at > new Date()
    ) {
      return { authorized: false, denialReason: "LEASE_HELD" };
    }

    const expiresAt = new Date(Date.now() + leaseSeconds * 1_000);
    await client.query(
      `UPDATE recording_attempts
          SET lease_worker_id = $2,
              lease_expires_at = $3,
              started_at = COALESCE(started_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [input.attemptId, input.workerId, expiresAt],
    );
    await client.query(
      `UPDATE recordings
          SET status = CASE WHEN status = 'REQUESTED' THEN 'STARTING' ELSE status END,
              updated_at = now()
        WHERE id = $1`,
      [input.recordingId],
    );
    return {
      authorized: true,
      denialReason: "",
      expiresAt,
      storagePrefix: `raw/${input.recordingId}/${input.attemptId}`,
      sourceUrl,
    };
  });
}

export async function renewLease(
  database: Database,
  input: { recordingId: string; attemptId: string; workerId: string },
  leaseSeconds = 45,
): Promise<{ authorized: boolean; denialReason: string; expiresAt?: Date }> {
  return withTransaction(database, async (client) => {
    const detail = await getRecordingForUpdate(client, input.recordingId);
    if (detail.attempt_id !== input.attemptId) {
      return { authorized: false, denialReason: "ATTEMPT_MISMATCH" };
    }
    if (!detail.consent_granted || detail.stop_requested_at || detail.status === "CANCELLED") {
      const reason = !detail.consent_granted
        ? "CONSENT_REVOKED"
        : detail.cancellation_reason ?? "STOP_REQUESTED";
      await markLeaseDenied(client, input.recordingId, input.attemptId, reason);
      return { authorized: false, denialReason: reason };
    }
    if (["READY", "FAILED", "REJECTED_NO_CONSENT"].includes(detail.status)) {
      return { authorized: false, denialReason: `TERMINAL_${detail.status}` };
    }

    const expiresAt = new Date(Date.now() + leaseSeconds * 1_000);
    const result = await client.query(
      `UPDATE recording_attempts
          SET lease_expires_at = $4, updated_at = now()
        WHERE id = $1 AND recording_id = $2 AND lease_worker_id = $3`,
      [input.attemptId, input.recordingId, input.workerId, expiresAt],
    );
    if (result.rowCount !== 1) {
      return { authorized: false, denialReason: "LEASE_NOT_OWNED" };
    }
    return { authorized: true, denialReason: "", expiresAt };
  });
}

export async function releaseLease(
  database: Database,
  input: {
    recordingId: string;
    attemptId: string;
    workerId: string;
    terminalReason: string;
  },
): Promise<boolean> {
  const result = await database.pool.query(
    `UPDATE recording_attempts
        SET lease_expires_at = NULL,
            lease_worker_id = NULL,
            ended_at = COALESCE(ended_at, now()),
            terminal_reason = COALESCE(NULLIF($4, ''), terminal_reason),
            updated_at = now()
      WHERE id = $1 AND recording_id = $2
        AND (lease_worker_id = $3 OR lease_worker_id IS NULL)`,
    [input.attemptId, input.recordingId, input.workerId, input.terminalReason],
  );
  return result.rowCount === 1;
}

async function markLeaseDenied(
  client: PoolClient,
  recordingId: string,
  attemptId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE recording_attempts
        SET lease_expires_at = NULL, terminal_reason = $2,
            ended_at = COALESCE(ended_at, now()), updated_at = now()
      WHERE id = $1`,
    [attemptId, reason],
  );
  await client.query(
    `UPDATE recordings
        SET status = 'CANCELLED', cancellation_reason = $2,
            stop_requested_at = COALESCE(stop_requested_at, now()),
            final_object_name = NULL, updated_at = now()
      WHERE id = $1 AND status NOT IN ('READY', 'FAILED', 'REJECTED_NO_CONSENT')`,
    [recordingId, reason],
  );
}

async function currentConsent(client: PoolClient, creatorId: string): Promise<ConsentAction | null> {
  const result = await client.query<{ action: ConsentAction }>(
    `SELECT action FROM consent_grants
      WHERE creator_id = $1
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [creatorId],
  );
  return result.rows[0]?.action ?? null;
}

async function getRecordingForUpdate(
  client: PoolClient,
  recordingId: string,
): Promise<RecordingDetail> {
  const result = await client.query<RecordingDetail>(
    recordingDetailSql("") + " AND r.id = $1 FOR UPDATE OF r, a",
    [recordingId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DomainConflictError("Recording was not found", "RECORDING_NOT_FOUND", 404);
  }
  return row;
}

function recordingDetailSql(extraPredicate: string): string {
  return `SELECT r.*, c.display_name AS creator_display_name,
                 a.id AS attempt_id, a.job_name, a.lease_expires_at,
                 COALESCE((SELECT action = 'GRANTED'
                   FROM consent_grants cg
                  WHERE cg.creator_id = c.id
                  ORDER BY occurred_at DESC, id DESC LIMIT 1), false) AS consent_granted
            FROM recordings r
            JOIN creators c ON c.id = r.creator_id
            JOIN recording_attempts a ON a.recording_id = r.id AND a.ordinal = 1
           WHERE 1 = 1 ${extraPredicate}`;
}

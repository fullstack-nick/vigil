import { Storage } from "@google-cloud/storage";
import type { Database } from "@vigil/database";
import { log } from "@vigil/observability";

import type { WorkerConfig } from "./config.js";

export async function runMaintenance(
  database: Database,
  config: WorkerConfig,
  signal: AbortSignal,
  health: { maintenance: boolean },
): Promise<void> {
  const storage = new Storage();
  while (!signal.aborted) {
    try {
      await reconcileExpiredLeases(database);
      if (config.storageBucket) {
        await purgeExpiredRecordings(database, storage, config.storageBucket);
      }
      health.maintenance = true;
    } catch (error) {
      health.maintenance = false;
      log("error", "maintenance iteration failed", { error });
    }
    await wait(30_000, signal);
  }
}

async function reconcileExpiredLeases(database: Database): Promise<void> {
  const result = await database.pool.query<{ id: string }>(
    `UPDATE recordings r
        SET status = 'FAILED', failure_code = 'LEASE_EXPIRED',
            failure_message = 'Recorder lease expired without a terminal event',
            completed_at = COALESCE(completed_at, now()), updated_at = now()
       FROM recording_attempts a
      WHERE a.recording_id = r.id
        AND r.status IN ('STARTING', 'RECORDING', 'FINALIZING')
        AND a.lease_expires_at < now() - interval '20 seconds'
      RETURNING r.id`,
  );
  for (const row of result.rows) {
    log("warn", "expired lease reconciled", { recording_id: row.id });
  }
}

async function purgeExpiredRecordings(
  database: Database,
  storage: Storage,
  bucketName: string,
): Promise<void> {
  const candidates = await database.pool.query<{ id: string }>(
    `SELECT id FROM recordings
      WHERE purged_at IS NULL
        AND (
          (retention_expires_at IS NOT NULL AND retention_expires_at <= now())
          OR status = 'CANCELLED'
        )
      ORDER BY COALESCE(retention_expires_at, updated_at)
      LIMIT 20`,
  );
  const bucket = storage.bucket(bucketName);
  for (const row of candidates.rows) {
    await Promise.all([
      bucket.deleteFiles({ prefix: `raw/${row.id}/`, force: true }),
      bucket.deleteFiles({ prefix: `vod/${row.id}/`, force: true }),
    ]);
    await database.pool.query(
      `UPDATE recordings
          SET purged_at = now(), final_object_name = NULL, updated_at = now()
        WHERE id = $1 AND purged_at IS NULL`,
      [row.id],
    );
    log("info", "recording objects purged", { recording_id: row.id });
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

import type { Database } from "@vigil/database";
import { log, outboxMessages } from "@vigil/observability";
import type { Producer } from "kafkajs";

import type { WorkerConfig } from "./config.js";

interface OutboxRow {
  command_id: string;
  topic: string;
  message_key: string;
  payload: Buffer;
}

export async function runOutboxPublisher(
  database: Database,
  producer: Producer,
  config: WorkerConfig,
  signal: AbortSignal,
  health: { outbox: boolean },
): Promise<void> {
  await producer.connect();
  health.outbox = true;
  try {
    while (!signal.aborted) {
      const published = await publishBatch(database, producer);
      health.outbox = true;
      if (!published) {
        await wait(config.outboxPollMillis, signal);
      }
    }
  } catch (error) {
    health.outbox = false;
    if (!signal.aborted) throw error;
  } finally {
    await producer.disconnect();
  }
}

async function publishBatch(database: Database, producer: Producer): Promise<number> {
  const client = await database.pool.connect();
  let published = 0;
  try {
    await client.query("BEGIN");
    const result = await client.query<OutboxRow>(
      `SELECT command_id, topic, message_key, payload
         FROM outbox_messages
        WHERE published_at IS NULL
          AND (locked_at IS NULL OR locked_at < now() - interval '2 minutes')
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 20`,
    );
    for (const message of result.rows) {
      await client.query(
        `UPDATE outbox_messages
            SET locked_at = now(), locked_by = $2, attempts = attempts + 1
          WHERE command_id = $1`,
        [message.command_id, process.env.HOSTNAME ?? "local-worker"],
      );
      try {
        await producer.send({
          topic: message.topic,
          acks: -1,
          messages: [
            {
              key: message.message_key,
              value: message.payload,
              headers: { "vigil-command-id": message.command_id },
            },
          ],
        });
        await client.query(
          `UPDATE outbox_messages
              SET published_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL
            WHERE command_id = $1`,
          [message.command_id],
        );
        published += 1;
        outboxMessages.inc({ result: "published" });
      } catch (error) {
        const messageText = error instanceof Error ? error.message.slice(0, 1_000) : String(error);
        await client.query(
          `UPDATE outbox_messages
              SET last_error = $2, locked_at = NULL, locked_by = NULL
            WHERE command_id = $1`,
          [message.command_id, messageText],
        );
        outboxMessages.inc({ result: "failed" });
        log("warn", "outbox publish failed", {
          command_id: message.command_id,
          error: messageText,
        });
      }
    }
    await client.query("COMMIT");
    return published;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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

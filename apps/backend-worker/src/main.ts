import { createDatabase } from "@vigil/database";
import { log } from "@vigil/observability";

import { loadWorkerConfig } from "./config.js";
import { startHealthServer, type WorkerHealth } from "./health.js";
import { createKafka } from "./kafka.js";
import { runMaintenance } from "./maintenance.js";
import { runOutboxPublisher } from "./outbox.js";
import { runProjector } from "./projector.js";

const config = loadWorkerConfig();
const abort = new AbortController();
const health: WorkerHealth = { outbox: false, projector: false, maintenance: false };

async function main(): Promise<void> {
  const database = await createDatabase();
  const kafka = createKafka(config);
  const producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true });
  const consumer = kafka.consumer({
    groupId: config.projectorGroup,
    allowAutoTopicCreation: false,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });
  const healthServer = startHealthServer(config.port, health);
  log("info", "backend worker starting", {
    auth_mode: config.kafkaAuthMode,
    broker_count: config.brokers.length,
  });

  const shutdown = () => abort.abort();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await Promise.all([
      runOutboxPublisher(database, producer, config, abort.signal, health),
      runProjector(database, consumer, config, abort.signal, health),
      runMaintenance(database, config, abort.signal, health),
    ]);
  } finally {
    healthServer.close();
    await database.close();
  }
}

main().catch((error: unknown) => {
  log("error", "backend worker stopped unexpectedly", { error });
  abort.abort();
  process.exitCode = 1;
});


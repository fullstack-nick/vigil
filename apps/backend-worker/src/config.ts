import { EVENT_TOPIC } from "@vigil/database";

export interface WorkerConfig {
  brokers: string[];
  clientId: string;
  eventTopic: string;
  projectorGroup: string;
  kafkaAuthMode: "local" | "gcp-oauth";
  kafkaPrincipal?: string;
  storageBucket?: string;
  port: number;
  retentionHours: number;
  outboxPollMillis: number;
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const brokers = (environment.KAFKA_BROKERS ?? "kafka:9092")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!brokers.length) {
    throw new Error("KAFKA_BROKERS must contain at least one broker");
  }
  const kafkaPrincipal =
    environment.KAFKA_PRINCIPAL ?? environment.GOOGLE_MANAGED_KAFKA_AUTH_PRINCIPAL;
  return {
    brokers,
    clientId: environment.KAFKA_CLIENT_ID ?? "vigil-backend-worker",
    eventTopic: environment.KAFKA_EVENT_TOPIC ?? EVENT_TOPIC,
    projectorGroup: environment.KAFKA_PROJECTOR_GROUP ?? "vigil-projector-v1",
    kafkaAuthMode: environment.KAFKA_AUTH_MODE === "gcp-oauth" ? "gcp-oauth" : "local",
    ...(kafkaPrincipal ? { kafkaPrincipal } : {}),
    ...(environment.STORAGE_BUCKET ? { storageBucket: environment.STORAGE_BUCKET } : {}),
    port: Number(environment.PORT ?? "9090"),
    retentionHours: Number(environment.RETENTION_HOURS ?? "24"),
    outboxPollMillis: Number(environment.OUTBOX_POLL_MILLIS ?? "500"),
  };
}


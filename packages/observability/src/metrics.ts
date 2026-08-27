import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "vigil_" });

export const httpDuration = new Histogram({
  name: "vigil_http_request_duration_seconds",
  help: "Control API request latency.",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const projectedEvents = new Counter({
  name: "vigil_projected_events_total",
  help: "Recording events committed to the projection store.",
  labelNames: ["result", "type"] as const,
  registers: [registry],
});

export const outboxMessages = new Counter({
  name: "vigil_outbox_messages_total",
  help: "Outbox publication results.",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const consumerHealthy = new Gauge({
  name: "vigil_consumer_healthy",
  help: "Whether a continuously running worker loop is healthy.",
  labelNames: ["loop"] as const,
  registers: [registry],
});

export async function metricsText(): Promise<string> {
  return registry.metrics();
}


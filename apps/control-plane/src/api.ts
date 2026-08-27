import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import { Storage } from "@google-cloud/storage";
import { StartRecordingCommand } from "@vigil/contracts";
import {
  DEMO_CREATOR_ID,
  DomainConflictError,
  createDatabase,
  getRecording,
  listPublicRecordings,
  publicSummary,
  requestRecording,
  setConsent,
  stopRecording,
} from "@vigil/database";
import { httpDuration, log, metricsText, registry } from "@vigil/observability";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { GoogleAuth, Impersonated } from "google-auth-library";

import {
  clearSession,
  createSession,
  credentialMatches,
  mutationGuard,
  operatorGuard,
  readSession,
} from "./auth.js";
import type { ControlPlaneConfig } from "./config.js";
import { serializeRecording } from "./serialize.js";

const requestStartedAt = new WeakMap<FastifyRequest, bigint>();

export async function startApi(config: ControlPlaneConfig): Promise<void> {
  const database = await createDatabase();
  const storage = new Storage();
  const signingStorage = await createSigningStorage(storage);
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 32 * 1024,
    requestIdHeader: "x-request-id",
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        mediaSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Vigil Control API",
        description: "Consent-gated recording orchestration and public demo state.",
        version: "0.1.0",
      },
      tags: [
        { name: "public", description: "Read-only portfolio endpoints" },
        { name: "operator", description: "Credential-protected recording controls" },
      ],
    },
  });

  const builtPublic = fileURLToPath(new URL("./public", import.meta.url));
  const sourcePublic = fileURLToPath(new URL("../public", import.meta.url));
  await app.register(fastifyStatic, {
    root: existsSync(builtPublic) ? builtPublic : sourcePublic,
    prefix: "/",
    wildcard: false,
    cacheControl: config.environment === "production",
    maxAge: config.environment === "production" ? "1h" : 0,
  });

  app.addHook("onRequest", async (request, reply) => {
    requestStartedAt.set(request, process.hrtime.bigint());
    if (
      request.url.startsWith("/api/") ||
      request.url === "/healthz" ||
      request.url === "/readyz"
    ) {
      reply.header("cache-control", "no-store");
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    if (startedAt) {
      const duration = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      httpDuration.observe(
        {
          method: request.method,
          route: request.routeOptions.url ?? "unmatched",
          status: String(reply.statusCode),
        },
        duration,
      );
    }
    log("info", "http request", {
      request_id: request.id,
      method: request.method,
      route: request.routeOptions.url,
      status: reply.statusCode,
    });
  });

  const readiness = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await database.pool.query("SELECT 1");
      return { status: "ok", service: "vigil-api" };
    } catch {
      return reply.code(503).send({ status: "unavailable", service: "vigil-api" });
    }
  };
  app.get("/healthz", { schema: { hide: true } }, readiness);
  app.get("/readyz", { schema: { hide: true } }, readiness);
  app.get("/metrics", { schema: { hide: true } }, async (_request, reply) => {
    reply.type(registry.contentType);
    return metricsText();
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  app.get(
    "/api/public/summary",
    { schema: { tags: ["public"], summary: "Read the public demo summary" } },
    async () => ({
      ...(await publicSummary(database)),
      limits: { maxConcurrent: 3, maxDurationSeconds: 600, retentionHours: config.retentionHours },
      region: "europe-west3",
    }),
  );
  app.get(
    "/api/public/recordings",
    { schema: { tags: ["public"], summary: "List public demo recordings" } },
    async (request) => {
      const query = request.query as { limit?: string };
      const recordings = await listPublicRecordings(database, Number(query.limit ?? "20"));
      return { recordings: recordings.map(serializeRecording) };
    },
  );
  app.get(
    "/api/public/recordings/:recordingId",
    { schema: { tags: ["public"], summary: "Read one public demo recording" } },
    async (request, reply) => {
      const { recordingId } = request.params as { recordingId: string };
      const recording = await getRecording(database, recordingId, true);
      if (!recording) {
        return reply.code(404).send({ error: "RECORDING_NOT_FOUND" });
      }
      const timeline = await loadTimeline(database.pool, recordingId);
      return { recording: serializeRecording(recording), timeline };
    },
  );
  app.get(
    "/api/public/recordings/:recordingId/media",
    { schema: { tags: ["public"], summary: "Stream an explicitly public demo recording" } },
    async (request, reply) => {
      if (!config.storageBucket) {
        return reply.code(503).send({ error: "STORAGE_NOT_CONFIGURED" });
      }
      const { recordingId } = request.params as { recordingId: string };
      const recording = await getRecording(database, recordingId, true);
      if (
        !recording ||
        recording.status !== "READY" ||
        !recording.final_object_name ||
        recording.purged_at
      ) {
        return reply.code(404).send({ error: "PLAYBACK_NOT_AVAILABLE" });
      }
      const emulatorHost = process.env.STORAGE_EMULATOR_HOST;
      if (emulatorHost) {
        const objectUrl = `${emulatorHost.replace(/\/$/, "")}/${encodeURIComponent(config.storageBucket)}/${encodeURIComponent(recording.final_object_name)}`;
        const response = await fetch(objectUrl);
        if (!response.ok || !response.body) {
          return reply.code(502).send({ error: "EMULATED_STORAGE_READ_FAILED" });
        }
        reply.header("content-type", response.headers.get("content-type") ?? "video/mp4");
        const contentLength = response.headers.get("content-length");
        if (contentLength) reply.header("content-length", contentLength);
        reply.header("cache-control", "private, max-age=300");
        return reply.send(Readable.from(iterateResponseBody(response.body)));
      }
      const file = storage.bucket(config.storageBucket).file(recording.final_object_name);
      const [metadata] = await file.getMetadata();
      reply.header("content-type", metadata.contentType ?? "video/mp4");
      reply.header("content-length", metadata.size ?? recording.final_byte_count);
      reply.header("cache-control", "private, max-age=300");
      return reply.send(file.createReadStream());
    },
  );

  app.post(
    "/api/operator/session",
    {
      config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
      schema: {
        tags: ["operator"],
        summary: "Exchange the owner credential for a short-lived session",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["credential"],
          properties: { credential: { type: "string", minLength: 1, maxLength: 512 } },
        },
      },
    },
    async (request, reply) => {
      const { credential } = request.body as { credential: string };
      if (!credentialMatches(config.operatorCredential, credential)) {
        log("warn", "operator login rejected", { request_id: request.id });
        return reply.code(401).send({ error: "INVALID_CREDENTIAL" });
      }
      const session = createSession(reply, config);
      log("info", "operator login accepted", { request_id: request.id });
      return { authenticated: true, ...session };
    },
  );
  app.get(
    "/api/operator/session",
    { schema: { tags: ["operator"] } },
    async (request) => {
      const session = readSession(request, config);
      if (!session) return { authenticated: false };
      return { authenticated: true, ...session };
    },
  );
  app.delete(
    "/api/operator/session",
    { preHandler: mutationGuard(config), schema: { tags: ["operator"] } },
    async (_request, reply) => {
      clearSession(reply, config);
      return { authenticated: false };
    },
  );

  app.put(
    "/api/creators/:creatorId/consent",
    {
      preHandler: mutationGuard(config),
      schema: {
        tags: ["operator"],
        summary: "Append a consent grant or revocation",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["granted"],
          properties: {
            granted: { type: "boolean" },
            evidence: { type: "string", maxLength: 2_000 },
          },
        },
      },
    },
    async (request) => {
      const { creatorId } = request.params as { creatorId: string };
      const body = request.body as { granted: boolean; evidence?: string };
      const result = await setConsent(database, {
        creatorId,
        action: body.granted ? "GRANTED" : "REVOKED",
        actor: "portfolio-owner",
        policyVersion: "v1",
        ...(body.evidence ? { evidence: body.evidence } : {}),
      });
      log("info", "consent changed", {
        creator_id: creatorId,
        action: result.action,
        affected_recording_count: result.affectedRecordings.length,
      });
      return result;
    },
  );

  app.post(
    "/api/recordings",
    {
      preHandler: mutationGuard(config),
      schema: {
        tags: ["operator"],
        summary: "Request a consent-gated demo recording",
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            creatorId: { type: "string", format: "uuid" },
            sourceId: { type: "string", minLength: 1, maxLength: 80 },
            maxDurationSeconds: { type: "integer", minimum: 5, maximum: 600 },
            publicDemo: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 200
      ) {
        return reply.code(400).send({ error: "VALID_IDEMPOTENCY_KEY_REQUIRED" });
      }
      const body = (request.body ?? {}) as {
        creatorId?: string;
        sourceId?: string;
        maxDurationSeconds?: number;
        publicDemo?: boolean;
      };
      const creatorId = body.creatorId ?? DEMO_CREATOR_ID;
      const sourceId = body.sourceId ?? config.demoSourceId;
      const maxDurationSeconds = body.maxDurationSeconds ?? 30;
      if (creatorId !== DEMO_CREATOR_ID || sourceId !== config.demoSourceId) {
        return reply.code(422).send({ error: "SOURCE_NOT_ALLOWED" });
      }
      const canonicalRequest = JSON.stringify({
        creatorId,
        sourceId,
        maxDurationSeconds,
        publicDemo: body.publicDemo ?? true,
      });
      const requestHash = createHash("sha256").update(canonicalRequest).digest("hex");
      const recordingId = randomUUID();
      const attemptId = randomUUID();
      const commandId = randomUUID();
      const jobName = `vigil-rec-${recordingId.replaceAll("-", "").slice(0, 24)}`;
      const commandPayload = Buffer.from(
        StartRecordingCommand.encode({
          commandId,
          recordingId,
          attemptId,
          creatorId,
          sourceId,
          maxDurationSeconds,
          requestedAt: new Date(),
        }).finish(),
      );
      const result = await requestRecording(database, {
        creatorId,
        sourceId,
        idempotencyKey,
        requestHash,
        maxDurationSeconds,
        recordingId,
        attemptId,
        commandId,
        jobName,
        commandPayload,
        publicDemo: body.publicDemo ?? true,
      });
      return reply.code(result.replayed ? 200 : 202).send({
        recording: serializeRecording(result.recording),
        replayed: result.replayed,
      });
    },
  );

  app.get(
    "/api/recordings/:recordingId",
    { preHandler: operatorGuard(config), schema: { tags: ["operator"] } },
    async (request, reply) => {
      const { recordingId } = request.params as { recordingId: string };
      const recording = await getRecording(database, recordingId);
      if (!recording) {
        return reply.code(404).send({ error: "RECORDING_NOT_FOUND" });
      }
      return { recording: serializeRecording(recording), timeline: await loadTimeline(database.pool, recordingId) };
    },
  );
  app.post(
    "/api/recordings/:recordingId/stop",
    { preHandler: mutationGuard(config), schema: { tags: ["operator"] } },
    async (request) => {
      const { recordingId } = request.params as { recordingId: string };
      return { recording: serializeRecording(await stopRecording(database, recordingId)) };
    },
  );
  app.post(
    "/api/recordings/:recordingId/playback-url",
    { preHandler: mutationGuard(config), schema: { tags: ["operator"] } },
    async (request, reply) => {
      if (!config.storageBucket) {
        return reply.code(503).send({ error: "STORAGE_NOT_CONFIGURED" });
      }
      const { recordingId } = request.params as { recordingId: string };
      const recording = await getRecording(database, recordingId);
      if (
        !recording ||
        recording.status !== "READY" ||
        !recording.final_object_name ||
        recording.purged_at
      ) {
        return reply.code(404).send({ error: "PLAYBACK_NOT_AVAILABLE" });
      }
      if (process.env.STORAGE_EMULATOR_HOST) {
        return {
          url: `${config.publicOrigin ?? "http://localhost:3000"}/api/public/recordings/${recordingId}/media`,
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
        };
      }
      const expiresAt = Date.now() + 15 * 60 * 1_000;
      const [url] = await signingStorage
        .bucket(config.storageBucket)
        .file(recording.final_object_name)
        .getSignedUrl({ version: "v4", action: "read", expires: expiresAt });
      return { url, expiresAt: new Date(expiresAt) };
    },
  );

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof DomainConflictError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof Error && "validation" in error) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: error.message });
    }
    log("error", "unhandled API error", { request_id: request.id, error });
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url === "/metrics") {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
    return reply.type("text/html").sendFile("index.html");
  });

  await app.listen({ host: config.host, port: config.port });
  log("info", "public API listening", { port: config.port });

  const shutdown = async () => {
    await app.close();
    await database.close();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

async function createSigningStorage(defaultStorage: Storage): Promise<Storage> {
  const targetPrincipal = process.env.URL_SIGNER_SERVICE_ACCOUNT;
  if (!targetPrincipal) return defaultStorage;
  const sourceClient = await new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  }).getClient();
  const impersonated = new Impersonated({
    sourceClient,
    targetPrincipal,
    targetScopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
    lifetime: 900,
  });
  return new Storage({ authClient: new GoogleAuth({ authClient: impersonated }) });
}

async function loadTimeline(pool: { query: Function }, recordingId: string) {
  const result = (await pool.query(
    `SELECT event_id, sequence::text, event_type, occurred_at, payload_json,
            conflict_detected_at IS NOT NULL AS conflicted
       FROM recording_events
      WHERE recording_id = $1
      ORDER BY sequence, occurred_at, event_id`,
    [recordingId],
  )) as {
    rows: Array<{
      event_id: string;
      sequence: string;
      event_type: string;
      occurred_at: Date;
      payload_json: unknown;
      conflicted: boolean;
    }>;
  };
  return result.rows.map((row) => ({
    eventId: row.event_id,
    sequence: Number(row.sequence),
    type: row.event_type,
    occurredAt: row.occurred_at,
    payload: row.payload_json,
    conflicted: row.conflicted,
  }));
}

async function* iterateResponseBody(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

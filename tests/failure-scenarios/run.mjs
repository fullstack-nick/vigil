import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import kafkaJs from "../../apps/backend-worker/node_modules/kafkajs/index.js";
import {
  RecordingEvent,
  StopReason,
} from "../../packages/contracts/dist/index.js";

const { Kafka, logLevel } = kafkaJs;
const origin = process.env.VIGIL_TEST_ORIGIN ?? "http://localhost:3000";
const ownerCredential = process.env.VIGIL_TEST_CREDENTIAL ?? "vigil-local-owner";
const creatorId = "00000000-0000-4000-8000-000000000001";
const keepStack = process.env.VIGIL_KEEP_STACK === "1";

let cookie = "";
let csrf = "";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
    input: options.input,
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

async function request(path, options = {}, expected = [200]) {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  if (csrf && options.method && options.method !== "GET") {
    headers.set("x-csrf-token", csrf);
    headers.set("origin", origin);
  }
  const response = await fetch(`${origin}${path}`, { ...options, headers });
  const payload = (response.headers.get("content-type") ?? "").includes("application/json")
    ? await response.json()
    : await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return { response, payload };
}

async function waitFor(description, inspect, accept, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    try {
      current = await inspect();
      if (accept(current)) return current;
    } catch {
      // Startup and container restarts are expected inside these scenarios.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`${description} timed out; last observation: ${JSON.stringify(current)}`);
}

async function recording(recordingId) {
  return (await request(`/api/public/recordings/${recordingId}`)).payload;
}

async function waitForStatus(recordingId, expected, timeoutMs) {
  return waitFor(
    `recording ${recordingId} to reach ${expected.join("/")}`,
    () => recording(recordingId),
    (value) => expected.includes(value.recording.status),
    timeoutMs,
  );
}

async function loginAndGrantConsent() {
  const login = await fetch(`${origin}/api/operator/session`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ credential: ownerCredential }),
  });
  assert.equal(login.status, 200, "operator login should succeed");
  const body = await login.json();
  const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie");
  assert.ok(setCookie && body.csrf, "operator session must return cookie and CSRF token");
  cookie = setCookie.split(";", 1)[0];
  csrf = body.csrf;
  await setConsent(true);
}

async function setConsent(granted) {
  await request(`/api/creators/${creatorId}/consent`, {
    method: "PUT",
    body: JSON.stringify({ granted, evidence: "Vigil focused failure scenario" }),
  });
}

async function createRecording(durationSeconds) {
  const result = await request(
    "/api/recordings",
    {
      method: "POST",
      headers: { "idempotency-key": `failure-${randomUUID()}` },
      body: JSON.stringify({ maxDurationSeconds: durationSeconds, publicDemo: true }),
    },
    [202],
  );
  return result.payload.recording.id;
}

function sql(statement) {
  return run(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "vigil", "-d", "vigil", "-At", "-c", statement],
    { capture: true },
  );
}

function event(recordingId, attemptId, sequence, payload) {
  return {
    eventId: `failure-${recordingId.slice(0, 8)}-${String(sequence).padStart(2, "0")}`,
    recordingId,
    attemptId,
    sequence,
    occurredAt: new Date(Date.now() + sequence * 10),
    ...payload,
  };
}

async function duplicateAndOutOfOrder(producer) {
  run("docker", ["compose", "stop", "scheduler"]);
  const recordingId = await createRecording(30);
  const attemptId = sql(`SELECT id FROM recording_attempts WHERE recording_id = '${recordingId}'`);
  assert.match(attemptId, /^[0-9a-f-]{36}$/);

  const history = [
    event(recordingId, attemptId, 1, { started: { workerId: "failure-worker", jobName: "failure-job" } }),
    event(recordingId, attemptId, 2, {
      segmentUploaded: {
        segmentIndex: 0,
        objectName: `raw/${recordingId}/${attemptId}/segment-000000.ts`,
        byteCount: 1_024,
        crc32c: "AAAAAA==",
        durationMillis: 5_000,
      },
    }),
    event(recordingId, attemptId, 3, { finalizing: { segmentCount: 1 } }),
    event(recordingId, attemptId, 4, {
      stopped: { reason: StopReason.STOP_REASON_CONSENT_REVOKED, detail: "synthetic revocation" },
    }),
  ];

  for (const item of [history[3], history[1], history[0], history[2]]) {
    await producer.send({
      topic: "vigil.recording.events.v1",
      acks: -1,
      messages: [{ key: recordingId, value: Buffer.from(RecordingEvent.encode(item).finish()) }],
    });
  }
  const projected = await waitFor(
    "out-of-order history to be fully projected",
    () => recording(recordingId),
    (value) => value.recording.status === "CANCELLED" && value.timeline.length === 4,
    45_000,
  );
  assert.deepEqual(
    projected.timeline.map((item) => item.sequence),
    [1, 2, 3, 4],
    "timeline should be rebuilt in logical order",
  );

  await producer.send({
    topic: "vigil.recording.events.v1",
    acks: -1,
    messages: [{ key: recordingId, value: Buffer.from(RecordingEvent.encode(history[1]).finish()) }],
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(sql(`SELECT count(*) FROM recording_events WHERE recording_id = '${recordingId}'`), "4");

  const conflict = structuredClone(history[1]);
  conflict.segmentUploaded.byteCount = 2_048;
  await producer.send({
    topic: "vigil.recording.events.v1",
    acks: -1,
    messages: [{ key: recordingId, value: Buffer.from(RecordingEvent.encode(conflict).finish()) }],
  });
  await waitFor(
    "conflicting duplicate to be quarantined",
    async () => sql(`SELECT count(*) FROM recording_events WHERE recording_id = '${recordingId}' AND conflict_detected_at IS NOT NULL`),
    (value) => value === "1",
    30_000,
  );
  process.stdout.write("PASS duplicate delivery, out-of-order rebuild, and conflict quarantine\n");
}

async function projectorRestart() {
  run("docker", ["compose", "start", "scheduler"]);
  const recordingId = await createRecording(20);
  await waitForStatus(recordingId, ["RECORDING", "FINALIZING"], 60_000);
  run("docker", ["compose", "stop", "worker"]);
  await new Promise((resolve) => setTimeout(resolve, 28_000));
  run("docker", ["compose", "start", "worker"]);
  const result = await waitForStatus(recordingId, ["READY", "FAILED", "CANCELLED"], 90_000);
  assert.equal(result.recording.status, "READY", "projector must catch up from Kafka after restart");
  process.stdout.write("PASS projector outage and offset-safe restart\n");
}

async function consentRevocation() {
  await setConsent(true);
  const recordingId = await createRecording(45);
  await waitForStatus(recordingId, ["RECORDING", "FINALIZING"], 60_000);
  await setConsent(false);
  const result = await waitFor(
    "recorder to publish consent stop",
    () => recording(recordingId),
    (value) => value.timeline.some((item) => item.type === "RECORDING_STOPPED"),
    60_000,
  );
  assert.equal(result.recording.status, "CANCELLED");
  assert.equal(result.recording.playbackAvailable, false);
  const media = await request(`/api/public/recordings/${recordingId}/media`, {}, [404]);
  assert.equal(media.payload.error, "PLAYBACK_NOT_AVAILABLE");
  await setConsent(true);
  process.stdout.write("PASS consent revocation closes the lease and exposes no playback\n");
}

async function recorderDeath() {
  const recordingId = await createRecording(60);
  await waitForStatus(recordingId, ["RECORDING"], 60_000);
  run("docker", [
    "compose",
    "exec",
    "-T",
    "scheduler",
    "sh",
    "-ec",
    "for f in /proc/[0-9]*/comm; do if [ \"$(cat \"$f\")\" = recorder ]; then p=${f#/proc/}; p=${p%/comm}; kill -KILL \"$p\"; exit 0; fi; done; exit 1",
  ]);
  const result = await waitForStatus(recordingId, ["FAILED"], 140_000);
  assert.equal(result.recording.failure?.code, "LEASE_EXPIRED");
  assert.equal(result.recording.playbackAvailable, false);
  process.stdout.write("PASS killed local recorder reaches FAILED through expired-lease reconciliation\n");
}

async function main() {
  let producer;
  try {
    run("docker", ["compose", "up", "-d", "--build"]);
    await waitFor(
      "Vigil API health",
      async () => (await request("/healthz")).payload,
      (value) => value.status === "ok",
      120_000,
    );
    await loginAndGrantConsent();
    producer = new Kafka({
      clientId: `vigil-failure-${randomUUID()}`,
      brokers: ["localhost:19092"],
      logLevel: logLevel.NOTHING,
    }).producer({ allowAutoTopicCreation: false, idempotent: true });
    await producer.connect();

    await duplicateAndOutOfOrder(producer);
    await projectorRestart();
    await consentRevocation();
    await recorderDeath();
    process.stdout.write("Vigil focused failure suite passed (5 scenarios).\n");
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    try {
      process.stderr.write(`${run("docker", ["compose", "logs", "--no-color", "--tail", "300"], { capture: true })}\n`);
    } catch {
      // Preserve the original failure when diagnostics cannot be collected.
    }
    process.exitCode = 1;
  } finally {
    await producer?.disconnect().catch(() => undefined);
    if (!keepStack) {
      try {
        run("docker", ["compose", "down", "--volumes", "--remove-orphans"]);
      } catch (error) {
        process.stderr.write(`Compose cleanup failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    }
  }
}

await main();

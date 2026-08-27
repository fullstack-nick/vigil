import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.VIGIL_TEST_ORIGIN ?? "http://localhost:3000";
const ownerCredential = process.env.VIGIL_TEST_CREDENTIAL ?? "vigil-local-owner";
const keepStack = process.env.VIGIL_KEEP_STACK === "1";
const recordingTimeoutMs = Number(process.env.VIGIL_RECORDING_TIMEOUT_MS ?? 240_000);
const demoCreatorId = "00000000-0000-4000-8000-000000000001";
const artifactsDirectory = join(tmpdir(), `vigil-integration-${randomUUID()}`);

let cookie = "";
let csrf = "";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.${detail}`);
  }
  return result.stdout ?? "";
}

async function request(path, options = {}, expectedStatuses = [200]) {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (cookie) {
    headers.set("cookie", cookie);
  }
  if (csrf && options.method && options.method !== "GET") {
    headers.set("x-csrf-token", csrf);
    headers.set("origin", origin);
  }
  const response = await fetch(`${origin}${path}`, { ...options, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return { response, payload };
}

async function waitForHealth() {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const { payload } = await request("/healthz");
      if (payload.status === "ok") return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`Vigil did not become healthy: ${lastError?.message ?? "timeout"}`);
}

async function waitForRecording(recordingId) {
  const deadline = Date.now() + recordingTimeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const { payload } = await request(`/api/public/recordings/${recordingId}`);
    lastStatus = payload.recording.status;
    process.stdout.write(`\rRecording ${recordingId.slice(0, 8)}: ${lastStatus.padEnd(12)}`);
    if (["READY", "FAILED", "CANCELLED", "REVOKED"].includes(lastStatus)) {
      process.stdout.write("\n");
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  process.stdout.write("\n");
  throw new Error(`Recording stayed ${lastStatus} past ${recordingTimeoutMs}ms`);
}

async function verifyMedia(recordingId) {
  const response = await fetch(`${origin}/api/public/recordings/${recordingId}/media`);
  if (!response.ok) {
    throw new Error(`Media download returned ${response.status}`);
  }
  const mediaPath = join(artifactsDirectory, `${recordingId}.mp4`);
  await writeFile(mediaPath, Buffer.from(await response.arrayBuffer()));
  const output = run(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_name,codec_type", "-show_entries", "format=duration", "-of", "json", mediaPath],
    { capture: true },
  );
  const probe = JSON.parse(output);
  const codecs = new Map(probe.streams.map((stream) => [stream.codec_type, stream.codec_name]));
  const duration = Number(probe.format.duration);
  if (codecs.get("video") !== "h264" || codecs.get("audio") !== "aac") {
    throw new Error(`Unexpected codecs: ${JSON.stringify(Object.fromEntries(codecs))}`);
  }
  if (!Number.isFinite(duration) || duration < 5) {
    throw new Error(`Unexpected media duration: ${probe.format.duration}`);
  }
  return { duration, size: Number(response.headers.get("content-length") ?? 0) };
}

async function main() {
  await mkdir(artifactsDirectory, { recursive: true });
  try {
    run("docker", ["compose", "up", "-d", "--build"]);
    await waitForHealth();

    const anonymous = await request(
      "/api/recordings",
      {
        method: "POST",
        headers: { "idempotency-key": `anonymous-${randomUUID()}` },
        body: JSON.stringify({ maxDurationSeconds: 10 }),
      },
      [401],
    );
    if (anonymous.payload.error !== "OPERATOR_AUTH_REQUIRED") {
      throw new Error("Anonymous recording controls were not denied as designed");
    }

    const loginResponse = await fetch(`${origin}/api/operator/session`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ credential: ownerCredential }),
    });
    if (!loginResponse.ok) {
      throw new Error(`Operator login returned ${loginResponse.status}`);
    }
    const login = await loginResponse.json();
    const setCookie = loginResponse.headers.getSetCookie?.()[0] ?? loginResponse.headers.get("set-cookie");
    if (!setCookie || !login.csrf) {
      throw new Error("Operator session did not include a cookie and CSRF token");
    }
    cookie = setCookie.split(";", 1)[0];
    csrf = login.csrf;

    const noConsentKey = `no-consent-${randomUUID()}`;
    const withoutConsent = await request(
      "/api/recordings",
      {
        method: "POST",
        headers: { "idempotency-key": noConsentKey },
        body: JSON.stringify({ maxDurationSeconds: 10 }),
      },
      [422],
    );
    if (withoutConsent.payload.error !== "CONSENT_REQUIRED") {
      throw new Error("A recording was not blocked before consent was granted");
    }

    await request(`/api/creators/${demoCreatorId}/consent`, {
      method: "PUT",
      body: JSON.stringify({ granted: true, evidence: "Local integration test consent" }),
    });

    const idempotencyKey = `integration-${randomUUID()}`;
    const body = JSON.stringify({ maxDurationSeconds: 12, publicDemo: true });
    const created = await request(
      "/api/recordings",
      { method: "POST", headers: { "idempotency-key": idempotencyKey }, body },
      [202],
    );
    const recordingId = created.payload.recording.id;
    const replay = await request(
      "/api/recordings",
      { method: "POST", headers: { "idempotency-key": idempotencyKey }, body },
      [200],
    );
    if (!replay.payload.replayed || replay.payload.recording.id !== recordingId) {
      throw new Error("Idempotent request replay did not return the original recording");
    }

    const result = await waitForRecording(recordingId);
    if (result.recording.status !== "READY") {
      throw new Error(`Recording terminated as ${result.recording.status}: ${JSON.stringify(result.recording.failure)}`);
    }
    if (!result.timeline.some((event) => event.type === "RECORDING_COMPLETED")) {
      throw new Error("Public timeline did not contain the terminal completion event");
    }
    const media = await verifyMedia(recordingId);
    const summary = await request("/api/public/summary");
    if (summary.payload.readyRecordings < 1) {
      throw new Error("Public summary did not expose the ready demo recording");
    }
    process.stdout.write(
      `Vigil integration passed: consent gate, idempotency, Kafka workflow, ${result.recording.segmentCount} segments, ${media.duration.toFixed(1)}s H.264/AAC playback.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    try {
      const logs = run("docker", ["compose", "logs", "--no-color", "--tail", "250"], { capture: true });
      process.stderr.write(`${logs}\n`);
    } catch (logError) {
      process.stderr.write(`Could not collect compose logs: ${logError.message}\n`);
    }
    process.exitCode = 1;
  } finally {
    if (!keepStack) {
      try {
        run("docker", ["compose", "down", "--volumes", "--remove-orphans"]);
      } catch (error) {
        process.stderr.write(`Compose cleanup failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    }
    await rm(artifactsDirectory, { recursive: true, force: true });
  }
}

await main();

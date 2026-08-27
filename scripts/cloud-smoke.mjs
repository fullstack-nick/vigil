import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = process.env.VIGIL_PROJECT_ID ?? "boltstream-r7m5o9ld";
const region = process.env.VIGIL_REGION ?? "europe-west3";
const scenario = process.env.VIGIL_SMOKE_SCENARIO ?? "all";
const creatorId = "00000000-0000-4000-8000-000000000001";
const origin = (
  process.env.VIGIL_API_URL ??
  run("gcloud", [
    "run", "services", "describe", "vigil-api",
    "--project", project,
    "--region", region,
    "--format=value(status.url)",
  ], { capture: true })
).replace(/\/$/, "");
const ownerCredential = process.env.VIGIL_OWNER_CREDENTIAL ?? run(
  "gcloud",
  ["secrets", "versions", "access", "latest", "--secret", "vigil-operator-credential", "--project", project],
  { capture: true },
);
const artifacts = await mkdtemp(join(tmpdir(), "vigil-cloud-smoke-"));

let cookie = "";
let csrf = "";

function run(command, args, options = {}) {
  let executable = command;
  let executableArgs = args;
  if (process.platform === "win32" && command === "gcloud") {
    const lookup = spawnSync("where.exe", ["gcloud.ps1"], { encoding: "utf8" });
    const script = lookup.stdout?.split(/\r?\n/u).find(Boolean);
    if (!script) throw new Error("gcloud.ps1 was not found on PATH");
    executable = "powershell.exe";
    executableArgs = [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, ...args,
    ];
  }
  const result = spawnSync(executable, executableArgs, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.error) {
    throw new Error(`${executable} could not start: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
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

async function waitFor(description, inspect, accept, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    try {
      current = await inspect();
      if (accept(current)) return current;
    } catch {
      // Cloud Run cold starts and Kubernetes scheduling are expected here.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${description} timed out; last observation: ${JSON.stringify(current)}`);
}

async function login() {
  const response = await fetch(`${origin}/api/operator/session`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ credential: ownerCredential }),
  });
  assert.equal(response.status, 200, "owner login must succeed");
  const body = await response.json();
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
  assert.ok(setCookie && body.csrf, "owner session must return a cookie and CSRF token");
  cookie = setCookie.split(";", 1)[0];
  csrf = body.csrf;
}

async function setConsent(granted) {
  await request(`/api/creators/${creatorId}/consent`, {
    method: "PUT",
    body: JSON.stringify({ granted, evidence: "Owner-approved deployed smoke scenario" }),
  });
}

async function createRecording(durationSeconds) {
  const response = await request(
    "/api/recordings",
    {
      method: "POST",
      headers: { "idempotency-key": `cloud-smoke-${randomUUID()}` },
      body: JSON.stringify({ maxDurationSeconds: durationSeconds, publicDemo: true }),
    },
    [202],
  );
  return response.payload.recording.id;
}

async function detail(recordingId) {
  return (await request(`/api/public/recordings/${recordingId}`)).payload;
}

async function waitForStatus(recordingId, statuses, timeoutMs = 180_000) {
  return waitFor(
    `recording ${recordingId} to reach ${statuses.join("/")}`,
    () => detail(recordingId),
    (value) => statuses.includes(value.recording.status),
    timeoutMs,
  );
}

async function validatePlayback(recordingId) {
  const response = await fetch(`${origin}/api/public/recordings/${recordingId}/media`);
  assert.equal(response.status, 200, "ready recording should stream publicly");
  const path = join(artifacts, `${recordingId}.mp4`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  const probe = JSON.parse(run(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_name,codec_type", "-show_entries", "format=duration", "-of", "json", path],
    { capture: true },
  ));
  const codecs = Object.fromEntries(probe.streams.map((stream) => [stream.codec_type, stream.codec_name]));
  assert.equal(codecs.video, "h264");
  assert.equal(codecs.audio, "aac");
  assert.ok(Number(probe.format.duration) >= 5);
}

async function successfulRecording() {
  const recordingId = await createRecording(15);
  const result = await waitForStatus(recordingId, ["READY", "FAILED", "CANCELLED"], 240_000);
  assert.equal(result.recording.status, "READY", `happy-path recording failed: ${JSON.stringify(result.recording.failure)}`);
  assert.ok(result.timeline.some((item) => item.type === "RECORDING_COMPLETED"));
  await validatePlayback(recordingId);
  process.stdout.write(`PASS cloud recording ${recordingId} reached READY with H.264/AAC playback\n`);
  return recordingId;
}

async function revokedRecording() {
  const recordingId = await createRecording(45);
  await waitForStatus(recordingId, ["RECORDING", "FINALIZING"], 120_000);
  await setConsent(false);
  const result = await waitFor(
    "revoked recorder to publish its terminal stop",
    () => detail(recordingId),
    (value) => value.timeline.some((item) => item.type === "RECORDING_STOPPED"),
    90_000,
  );
  assert.equal(result.recording.status, "CANCELLED");
  assert.equal(result.recording.playbackAvailable, false);
  await request(`/api/public/recordings/${recordingId}/media`, {}, [404]);
  await setConsent(true);
  process.stdout.write(`PASS cloud revocation ${recordingId} failed closed\n`);
  return recordingId;
}

async function killedJob() {
  const recordingId = await createRecording(60);
  await waitForStatus(recordingId, ["RECORDING"], 120_000);
  const jobName = `vigil-rec-${recordingId.replaceAll("-", "").slice(0, 24)}`;
  const podName = await waitFor(
    `Pod for ${jobName}`,
    async () => run(
      "kubectl",
      ["get", "pods", "-n", "vigil", "-l", `job-name=${jobName}`, "-o", "jsonpath={.items[0].metadata.name}"],
      { capture: true, allowFailure: true },
    ),
    (value) => Boolean(value),
    60_000,
  );
  run(
    "kubectl",
    ["delete", "pod", podName, "-n", "vigil", "--grace-period=0", "--force", "--wait=true"],
    { capture: true },
  );
  await waitFor(
    `recorder Job ${jobName} to fail after forced Pod termination`,
    async () => run(
      "kubectl",
      ["get", "job", jobName, "-n", "vigil", "-o", "jsonpath={.status.conditions[?(@.type=='Failed')].status}"],
      { capture: true, allowFailure: true },
    ),
    (value) => value === "True",
    30_000,
  );
  const result = await waitForStatus(recordingId, ["FAILED"], 120_000);
  assert.ok(
    ["CAPTURE_FAILED", "JOB_FAILED"].includes(result.recording.failure?.code),
    `forced Pod loss must produce a recorder or Job terminal failure: ${JSON.stringify(result.recording.failure)}`,
  );
  assert.ok(
    result.timeline.some(
      (item) => item.type === "RECORDING_FAILED" && item.payload?.payload?.code === "JOB_FAILED",
    ),
    "scheduler must publish JOB_FAILED after the Kubernetes Job reaches its failed condition",
  );
  assert.equal(result.recording.playbackAvailable, false);
  process.stdout.write(
    `PASS killed Kubernetes Job ${jobName} reached FAILED (${result.recording.failure.code})\n`,
  );
  return recordingId;
}

try {
  assert.ok(origin.startsWith("https://"), "cloud smoke requires the HTTPS Cloud Run URL");
  await waitFor(
    "public Cloud Run health",
    async () => (await request("/readyz")).payload,
    (value) => value.status === "ok",
    120_000,
  );
  const anonymous = await request(
    "/api/recordings",
    {
      method: "POST",
      headers: { "idempotency-key": `anonymous-${randomUUID()}` },
      body: JSON.stringify({ maxDurationSeconds: 15 }),
    },
    [401],
  );
  assert.equal(anonymous.payload.error, "OPERATOR_AUTH_REQUIRED");
  await login();
  await setConsent(true);
  const results = {};
  if (scenario === "all" || scenario === "ready") results.ready = await successfulRecording();
  if (scenario === "all" || scenario === "revoked") results.revoked = await revokedRecording();
  if (scenario === "all" || scenario === "killed") results.killed = await killedJob();
  assert.ok(["all", "ready", "revoked", "killed"].includes(scenario), `unknown smoke scenario: ${scenario}`);
  process.stdout.write(`Vigil cloud smoke passed: ${JSON.stringify(results)}\n`);
} finally {
  await rm(artifacts, { recursive: true, force: true });
}

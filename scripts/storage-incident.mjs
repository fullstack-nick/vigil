import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const project = process.env.VIGIL_PROJECT_ID ?? "boltstream-r7m5o9ld";
const region = process.env.VIGIL_REGION ?? "europe-west3";
const projectNumber = run("gcloud", ["projects", "describe", project, "--format=value(projectNumber)"], { capture: true });
const bucket = process.env.VIGIL_STORAGE_BUCKET ?? `vigil-${projectNumber}-recordings`;
const recorderAccount = `vigil-recorder@${project}.iam.gserviceaccount.com`;
const member = `serviceAccount:${recorderAccount}`;
const role = "roles/storage.objectAdmin";
const origin = (
  process.env.VIGIL_API_URL ?? run("gcloud", [
    "run", "services", "describe", "vigil-api", "--project", project, "--region", region, "--format=value(status.url)",
  ], { capture: true })
).replace(/\/$/, "");
const ownerCredential = process.env.VIGIL_OWNER_CREDENTIAL ?? run(
  "gcloud",
  ["secrets", "versions", "access", "latest", "--secret", "vigil-operator-credential", "--project", project],
  { capture: true },
);

let cookie = "";
let csrf = "";
let bindingRemoved = false;

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
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

async function request(path, options = {}, expected = [200]) {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  if (options.body) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  if (csrf && options.method && options.method !== "GET") {
    headers.set("x-csrf-token", csrf);
    headers.set("origin", origin);
  }
  const response = await fetch(`${origin}${path}`, { ...options, headers });
  const payload = (response.headers.get("content-type") ?? "").includes("application/json") ? await response.json() : await response.text();
  if (!expected.includes(response.status)) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitFor(description, inspect, accept, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await inspect();
    if (accept(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${description} timed out; last observation: ${JSON.stringify(current)}`);
}

async function loginAndGrant() {
  const response = await fetch(`${origin}/api/operator/session`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ credential: ownerCredential }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
  cookie = setCookie.split(";", 1)[0];
  csrf = body.csrf;
  await request("/api/creators/00000000-0000-4000-8000-000000000001/consent", {
    method: "PUT",
    body: JSON.stringify({ granted: true, evidence: "Storage incident exercise" }),
  });
}

async function create(durationSeconds = 15) {
  const result = await request("/api/recordings", {
    method: "POST",
    headers: { "idempotency-key": `storage-incident-${randomUUID()}` },
    body: JSON.stringify({ maxDurationSeconds: durationSeconds, publicDemo: true }),
  }, [202]);
  return result.recording.id;
}

async function terminal(recordingId) {
  return waitFor(
    `recording ${recordingId} terminal state`,
    () => request(`/api/public/recordings/${recordingId}`),
    (value) => ["READY", "FAILED", "CANCELLED"].includes(value.recording.status),
  );
}

function removeBinding() {
  run("gcloud", [
    "storage", "buckets", "remove-iam-policy-binding", `gs://${bucket}`,
    "--member", member, "--role", role, "--project", project, "--quiet",
  ]);
  bindingRemoved = true;
}

function restoreBinding() {
  run("gcloud", [
    "storage", "buckets", "add-iam-policy-binding", `gs://${bucket}`,
    "--member", member, "--role", role, "--project", project, "--quiet",
  ]);
  bindingRemoved = false;
}

let failedRecording;
let recoveryRecording;
const startedAt = new Date().toISOString();
try {
  const policy = JSON.parse(run("gcloud", ["storage", "buckets", "get-iam-policy", `gs://${bucket}`, "--project", project, "--format=json"], { capture: true }));
  assert.ok(policy.bindings?.some((binding) => binding.role === role && binding.members?.includes(member)), "recorder binding must exist before the exercise");
  await loginAndGrant();
  removeBinding();
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  failedRecording = await create();
  const failed = await terminal(failedRecording);
  assert.equal(failed.recording.status, "FAILED", "permission incident must not produce playable media");
  assert.equal(failed.recording.playbackAvailable, false);
  process.stdout.write(`Observed storage denial on ${failedRecording}: ${failed.recording.failure?.code}\n`);
} finally {
  if (bindingRemoved) restoreBinding();
}

await new Promise((resolve) => setTimeout(resolve, 20_000));
recoveryRecording = await create();
const recovered = await terminal(recoveryRecording);
assert.equal(recovered.recording.status, "READY", `post-restore recording failed: ${JSON.stringify(recovered.recording.failure)}`);
const media = await fetch(`${origin}/api/public/recordings/${recoveryRecording}/media`);
assert.equal(media.status, 200);
process.stdout.write(`Vigil storage incident exercise recovered: ${JSON.stringify({ startedAt, endedAt: new Date().toISOString(), failedRecording, recoveryRecording })}\n`);

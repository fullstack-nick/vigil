import { spawnSync } from "node:child_process";

const renderOnly = process.argv.includes("--render-only");
const required = [
  "VIGIL_NODE_IMAGE",
  "VIGIL_GO_IMAGE",
  "VIGIL_SYNTHETIC_IMAGE",
  "VIGIL_KAFKA_BROKERS",
  "VIGIL_LEASE_ENDPOINT",
  "VIGIL_LEASE_AUDIENCE",
  "VIGIL_STORAGE_BUCKET",
  "VIGIL_SQL_CONNECTION_NAME",
  "VIGIL_PROJECT_NUMBER",
  "VIGIL_WORKER_SERVICE_ACCOUNT",
  "VIGIL_SCHEDULER_SERVICE_ACCOUNT",
  "VIGIL_RECORDER_SERVICE_ACCOUNT",
];

const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing Kubernetes deployment environment: ${missing.join(", ")}`);
}
for (const name of ["VIGIL_NODE_IMAGE", "VIGIL_GO_IMAGE", "VIGIL_SYNTHETIC_IMAGE"]) {
  if (!process.env[name].includes("@sha256:")) {
    throw new Error(`${name} must use an immutable sha256 digest`);
  }
}

const root = new URL("..", import.meta.url);
const render = spawnSync("kubectl", ["kustomize", "deploy/kubernetes/overlays/demo"], {
  cwd: root,
  encoding: "utf8",
  shell: false,
});
if (render.status !== 0) throw new Error(render.stderr || "kubectl kustomize failed");

const replacements = new Map([
  ["vigil/node:deploy", process.env.VIGIL_NODE_IMAGE],
  ["vigil/go:deploy", process.env.VIGIL_GO_IMAGE],
  ["vigil/synthetic-hls:deploy", process.env.VIGIL_SYNTHETIC_IMAGE],
  ["__KAFKA_BROKERS__", process.env.VIGIL_KAFKA_BROKERS],
  ["__LEASE_ENDPOINT__", process.env.VIGIL_LEASE_ENDPOINT],
  ["__LEASE_AUDIENCE__", process.env.VIGIL_LEASE_AUDIENCE],
  ["__STORAGE_BUCKET__", process.env.VIGIL_STORAGE_BUCKET],
  ["__SQL_CONNECTION_NAME__", process.env.VIGIL_SQL_CONNECTION_NAME],
  ["__PROJECT_NUMBER__", process.env.VIGIL_PROJECT_NUMBER],
  ["__WORKER_SERVICE_ACCOUNT__", process.env.VIGIL_WORKER_SERVICE_ACCOUNT],
  ["__SCHEDULER_SERVICE_ACCOUNT__", process.env.VIGIL_SCHEDULER_SERVICE_ACCOUNT],
  ["__RECORDER_SERVICE_ACCOUNT__", process.env.VIGIL_RECORDER_SERVICE_ACCOUNT],
]);

let manifest = render.stdout;
for (const [from, to] of replacements) manifest = manifest.replaceAll(from, to);
if (/__[A-Z0-9_]+__/.test(manifest) || /image: vigil\//.test(manifest)) {
  throw new Error("Rendered Kubernetes manifest still contains deployment placeholders");
}

if (renderOnly) {
  process.stdout.write(manifest);
} else {
  const apply = spawnSync("kubectl", ["apply", "-f", "-"], {
    cwd: root,
    input: manifest,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
  });
  if (apply.status !== 0) throw new Error(`kubectl apply failed with exit code ${apply.status}`);
}


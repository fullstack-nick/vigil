import { spawnSync } from "node:child_process";

const result = spawnSync("kubectl", ["kustomize", "deploy/kubernetes/overlays/demo"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  shell: false,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || "Kustomize render failed.\n");
  process.exitCode = result.status ?? 1;
} else if (!result.stdout.includes("kind: Deployment") || !result.stdout.includes("namespace: vigil")) {
  process.stderr.write("Kustomize output omitted expected Vigil resources.\n");
  process.exitCode = 1;
} else {
  process.stdout.write("Kustomize render passed.\n");
}


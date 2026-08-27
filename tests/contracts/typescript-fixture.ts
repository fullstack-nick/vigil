import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

import { RecordingEvent } from "../../packages/contracts/src/index.js";

const expected = {
  eventId: "evt_fixture_000000000000000000000001",
  recordingId: "10000000-0000-4000-8000-000000000001",
  attemptId: "20000000-0000-4000-8000-000000000001",
  sequence: 7,
  occurredAt: new Date("2026-08-27T12:34:56.123Z"),
  started: undefined,
  segmentUploaded: {
    segmentIndex: 6,
    objectName: "raw/10000000/20000000/segment-000006.ts",
    byteCount: 123_456,
    crc32c: "6I6MWA==",
    durationMillis: 5_000,
  },
  finalizing: undefined,
  completed: undefined,
  failed: undefined,
  stopped: undefined,
};

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const goDirectory = join(root, "go");
const temporary = await mkdtemp(join(tmpdir(), "vigil-contract-"));
const goFixture = join(temporary, "from-go.bin");
const typeScriptFixture = join(temporary, "from-typescript.bin");

try {
  runGo("write", goFixture);
  const goBytes = await readFile(goFixture);
  const decoded = RecordingEvent.decode(goBytes);
  assert.deepEqual(decoded, expected, "TypeScript must decode the Go fixture canonically");

  const typeScriptBytes = Buffer.from(RecordingEvent.encode(expected).finish());
  await writeFile(typeScriptFixture, typeScriptBytes);
  runGo("verify", typeScriptFixture);
  assert.deepEqual(typeScriptBytes, goBytes, "Go and TypeScript must emit identical fixture bytes");
  process.stdout.write("cross-language protobuf fixture passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function runGo(operation: "write" | "verify", path: string): void {
  const result = spawnSync("go", ["run", "./cmd/fixture", operation, path], {
    cwd: goDirectory,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Go fixture ${operation} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

import { log } from "@vigil/observability";

import { startApi } from "./api.js";
import { loadConfig } from "./config.js";
import { startLeaseServer } from "./lease.js";

const config = loadConfig();

const start = config.mode === "lease" ? startLeaseServer(config) : startApi(config);
start.catch((error: unknown) => {
  log("error", "control plane failed to start", { error });
  process.exitCode = 1;
});


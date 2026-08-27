import { createServer, type Server } from "node:http";

import { consumerHealthy, metricsText, registry } from "@vigil/observability";

export interface WorkerHealth {
  outbox: boolean;
  projector: boolean;
  maintenance: boolean;
}

export function startHealthServer(port: number, health: WorkerHealth): Server {
  return createServer(async (request, response) => {
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": registry.contentType });
      response.end(await metricsText());
      return;
    }
    if (request.url === "/healthz") {
      consumerHealthy.set({ loop: "outbox" }, health.outbox ? 1 : 0);
      consumerHealthy.set({ loop: "projector" }, health.projector ? 1 : 0);
      consumerHealthy.set({ loop: "maintenance" }, health.maintenance ? 1 : 0);
      const healthy = health.outbox && health.projector && health.maintenance;
      response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: healthy ? "ok" : "degraded", loops: health }));
      return;
    }
    response.writeHead(404).end();
  }).listen(port);
}


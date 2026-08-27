import {
  Server,
  ServerCredentials,
  status,
  type handleUnaryCall,
  type sendUnaryData,
  type ServerUnaryCall,
} from "@grpc/grpc-js";
import {
  RecordingLeaseServiceService,
  type AcquireRecordingLeaseRequest,
  type AcquireRecordingLeaseResponse,
  type RecordingLeaseServiceServer,
  type ReleaseRecordingLeaseRequest,
  type ReleaseRecordingLeaseResponse,
  type RenewRecordingLeaseRequest,
  type RenewRecordingLeaseResponse,
} from "@vigil/contracts";
import {
  acquireLease,
  createDatabase,
  releaseLease,
  renewLease,
} from "@vigil/database";
import { log } from "@vigil/observability";

import type { ControlPlaneConfig } from "./config.js";

export async function startLeaseServer(config: ControlPlaneConfig): Promise<void> {
  const database = await createDatabase();
  const server = new Server({
    "grpc.max_receive_message_length": 64 * 1024,
    "grpc.max_send_message_length": 64 * 1024,
  });

  const implementation: RecordingLeaseServiceServer = {
    acquireRecordingLease: unary(async (request) => {
      validateIdentity(request.recordingId, request.attemptId, request.workerId);
      const result = await acquireLease(database, request, config.demoSourceUrl);
      log("info", "lease acquisition evaluated", {
        recording_id: request.recordingId,
        attempt_id: request.attemptId,
        authorized: result.authorized,
        denial_reason: result.denialReason,
      });
      return {
        authorized: result.authorized,
        denialReason: result.denialReason,
        sourceUrl: result.sourceUrl ?? "",
        storagePrefix: result.storagePrefix ?? "",
        ...(result.expiresAt ? { leaseExpiresAt: result.expiresAt } : {}),
      };
    }),
    renewRecordingLease: unary(async (request) => {
      validateIdentity(request.recordingId, request.attemptId, request.workerId);
      const result = await renewLease(database, request);
      return {
        authorized: result.authorized,
        denialReason: result.denialReason,
        ...(result.expiresAt ? { leaseExpiresAt: result.expiresAt } : {}),
      };
    }),
    releaseRecordingLease: unary(async (request) => ({
      released: await releaseLease(database, request),
    })),
  };

  server.addService(RecordingLeaseServiceService, implementation);
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(
      `${config.host}:${config.port}`,
      ServerCredentials.createInsecure(),
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
  log("info", "lease gRPC server listening", { port: config.port });

  const shutdown = async () => {
    await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    await database.close();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

function unary<TRequest, TResponse>(
  operation: (request: TRequest) => Promise<TResponse>,
): handleUnaryCall<TRequest, TResponse> {
  return (call: ServerUnaryCall<TRequest, TResponse>, callback: sendUnaryData<TResponse>) => {
    operation(call.request)
      .then((response) => callback(null, response))
      .catch((error: unknown) => {
        log("error", "lease RPC failed", { error });
        callback({
          name: "LeaseError",
          message: error instanceof Error ? error.message : "lease operation failed",
          code: status.INTERNAL,
        });
      });
  };
}

function validateIdentity(recordingId: string, attemptId: string, workerId: string): void {
  if (!recordingId || !attemptId || !workerId) {
    throw new Error("recording_id, attempt_id, and worker_id are required");
  }
}

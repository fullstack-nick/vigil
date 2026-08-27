# ADR-0002: split request and continuous runtimes

- Status: accepted
- Date: 2026-08-27

## Context

The public API, native gRPC lease endpoint, Kafka projector, scheduler, and recorder have different protocols and execution lifetimes.

## Decision

Use one Node control-plane codebase in two Cloud Run services: a public HTTP/1 API that may scale to zero and an IAM-protected h2c lease service with one minimum instance. Run the continuous TypeScript worker, Go scheduler, synthetic HLS source, and ephemeral recorder Jobs in GKE Autopilot.

## Consequences

Public IAM cannot accidentally expose the lease RPCs, renewals avoid scale-to-zero latency, and long-lived consumers receive ordinary process supervision. This costs more than forcing everything into one request runtime, but it makes lifecycle ownership explicit.

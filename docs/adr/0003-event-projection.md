# ADR-0003: replayable idempotent projection

- Status: accepted
- Date: 2026-08-27

## Context

Kafka delivery is at least once. A publisher can crash after broker acknowledgement, events can be delayed, and a repeated identity might contain either identical or conflicting bytes.

## Decision

Commands and lifecycle events use one protobuf contract in Go and TypeScript. IDs, attempt sequences, Kubernetes Job names, and storage paths are deterministic. The projector stores each raw event, treats identical bytes as a duplicate, quarantines conflicting identity reuse, reloads the bounded attempt history, sorts it logically, and runs one pure reducer. It commits the Kafka offset only after the database transaction commits.

A completion is accepted only when the deterministic final object exists and its byte count matches the event.

## Consequences

Projection state is reproducible and ordinary re-delivery is harmless. Full-history reduction is more database work than an incremental state machine, but histories are intentionally small and the correctness is easier to audit.

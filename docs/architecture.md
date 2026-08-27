# Architecture and failure flows

## Control and data planes

Vigil separates cheap public reads from spend-causing mutations and separates request handling from continuous event processing.

```mermaid
flowchart TB
  subgraph Public[Public edge]
    Viewer[Anonymous viewer]
    Owner[Owner browser]
    API[REST, OpenAPI, static UI]
  end

  subgraph Run[Cloud Run]
    APIService[vigil-api · HTTP/1 · min 0]
    LeaseService[vigil-lease · h2c gRPC · min 1]
    Migration[vigil-migration Job]
  end

  subgraph Data[Private data services]
    SQL[(Cloud SQL PostgreSQL 16)]
    Kafka[(Managed Kafka)]
    Bucket[(Private recording bucket)]
  end

  subgraph GKE[GKE Autopilot · vigil namespace]
    Worker[Outbox + projector + retention]
    Scheduler[Scheduler + failed Job reconciler]
    Recorder[Ephemeral recorder Job]
    HLS[Synthetic HLS source]
  end

  Viewer -->|read only| API
  Owner -->|session + CSRF| API
  API --> APIService
  APIService --> SQL
  APIService --> Bucket
  Migration --> SQL
  Worker <--> SQL
  Worker -->|start commands| Kafka
  Kafka --> Scheduler
  Scheduler --> Recorder
  HLS --> Recorder
  Recorder -->|OIDC-authenticated lease| LeaseService
  LeaseService --> SQL
  Recorder --> Bucket
  Recorder -->|lifecycle events| Kafka
  Kafka --> Worker
```

Cloud Run reaches Cloud SQL through Direct VPC egress and the Cloud SQL connector. GKE reaches it through a Cloud SQL Auth Proxy sidecar. Managed Kafka and the synthetic source are reachable only through the dedicated VPC. Workloads use distinct Kubernetes and Google service accounts joined by Workload Identity Federation.

## Successful recording sequence

```mermaid
sequenceDiagram
  actor O as Owner
  participant A as REST API
  participant D as PostgreSQL
  participant W as Outbox worker
  participant K as Kafka
  participant S as Scheduler
  participant R as Recorder Job
  participant L as Lease service
  participant G as Cloud Storage

  O->>A: Grant consent
  A->>D: Append consent action
  O->>A: POST recording + Idempotency-Key
  A->>D: BEGIN
  A->>D: Insert recording, attempt, command
  A->>D: COMMIT
  W->>D: Lock unpublished outbox row
  W->>K: Publish typed start command
  W->>D: Mark published after ack
  K->>S: At-least-once command
  S->>R: Ensure deterministic Job exists
  R->>L: Acquire lease
  L->>D: Check consent, stop, identity, capacity
  loop every 15 seconds
    R->>L: Renew lease
  end
  R->>G: Upload deterministic segments
  R->>K: Publish lifecycle events
  R->>G: Upload validated MP4
  R->>K: Publish completion
  K->>W: At-least-once events
  W->>G: Verify final object and size
  W->>D: Store event + rebuild projection
  O->>A: Read timeline / play media
```

## Revocation flow

```mermaid
flowchart LR
  Revoke[Owner revokes consent] --> Append[Append consent record]
  Append --> Cancel[Mark active recordings cancelled]
  Cancel --> NoPlayback[Clear playback exposure]
  Cancel --> Renew[Next lease renewal denied]
  Renew --> Stop[Recorder stops FFmpeg and uploads]
  Stop --> Delete[Delete raw and final prefixes]
  Delete --> Event[Publish deterministic stop event]
  Event --> Projection[Projection remains CANCELLED]
```

If the lease endpoint is unavailable, the recorder keeps the last expiry as a hard deadline and stops before authorization becomes uncertain. A killed Kubernetes recorder reaches a failed Job; the scheduler publishes a deterministic `JOB_FAILED` event. Locally, the maintenance loop turns an abandoned expired lease into `FAILED`.

## Event projection

```mermaid
flowchart TD
  Delivery[Kafka delivery] --> Decode[Decode protobuf]
  Decode --> Lookup{Known ID or attempt/sequence?}
  Lookup -->|same ID + same bytes| Duplicate[Acknowledge duplicate]
  Lookup -->|different bytes| Quarantine[Record conflict; do not mutate state]
  Lookup -->|new| Store[Insert immutable event]
  Store --> Load[Load full attempt history]
  Load --> Sort[Sort sequence, time, ID]
  Sort --> Reduce[Pure reducer]
  Reduce --> Persist[Persist projection in same transaction]
  Persist --> Commit[Commit DB, then Kafka offset]
```

The approach is intentionally simple for the bounded history. It gives delayed events a place in history without letting arrival order regress state.

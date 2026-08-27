# Vigil — research-refined implementation plan

Planning snapshot: 2026-08-27

Implementation began after the owner resolved the project name and public-access model on 2026-08-27. The plan remains the controlling implementation specification and acceptance checklist.

The research-refined plan below is additive. Appendix A contains the complete user-supplied baseline plan verbatim and unchanged. If a refinement below differs from an option in the baseline, the refinement records the current implementation decision; the baseline remains preserved as requested.

## Project independence and provenance rule

Vigil is an independently designed portfolio project. Public-facing code, UI, documentation, resource names, screenshots, metadata, and marketing copy must not refer to, imitate, or imply affiliation with any company or product cited in the historical source material. Do not reuse their names, titles, assets, product language, source code, or licensing materials.

The only exception is Appendix A, which preserves the user-provided research source exactly as requested. Its citations are historical planning context, not attribution or affiliation.

Use independently written code and documentation, generic domain terminology, and an independently chosen standard open-source license. Apache-2.0 is the recommended repository license unless the owner chooses another license before publication.

## Executive recommendation

- Build the project under the name **Vigil**.
- Use the existing GCP project `boltstream-r7m5o9ld`. It is the least cluttered eligible billed project found during the read-only inventory.
- Deploy all regional resources in Frankfurt, `europe-west3`.
- Isolate every resource with a `vigil-` prefix, common labels, a dedicated VPC/subnet/IP ranges, dedicated service accounts, a dedicated Terraform state bucket and prefixes, and a dedicated `vigil` Kubernetes namespace.
- Use Google Cloud Managed Service for Apache Kafka first. If actual creation is rejected by an account-level trial restriction or a project-specific zero quota, fall back to a single-node Apache Kafka KRaft StatefulSet in the dedicated GKE namespace. Do not silently substitute another event product.
- Use GKE Autopilot for the scheduler, TypeScript backend worker, synthetic HLS source, and recorder Jobs.
- Split the TypeScript control plane into two Cloud Run services built from the same application source:
  - a public HTTP/1 REST API and small portfolio UI;
  - an authenticated HTTP/2 gRPC lease service invokable only by the recorder identity.
- Keep the outbox publisher and event projector together in one continuously running TypeScript GKE Deployment. Cloud Run request handlers must not run background polling loops.
- Protect every mutating public endpoint with an operator credential. Public visitors can view the product explanation and a deliberately public demo result, but cannot create recordings or spend cloud resources.
- Keep conventional tests local. CI performs only fast contract/build/configuration gates; it does not run the local integration or failure suites.

## What the research verified

### Workspace and accounts

- Workspace `C:\D_DRIVE\Nikita\JS\anchorcast` was empty and was not a Git repository at inspection time.
- Google Cloud CLI is authenticated as `nickaccturk@gmail.com`.
- The active gcloud project was `tracegate-r7m5o9ld`, but the plan deliberately selects a different project.
- GitHub CLI is authenticated as `fullstack-nick`.
- `fullstack-nick/vigil` did not exist when checked, so that repository path was available.
- Publishing an npm package is not required.
- The billing account is open, uses TRY, and is attached to five eligible projects. GCP does not expose the remaining promotional-credit balance through the normal gcloud billing-account description, so the exact remaining credit must be checked in the Billing console before deployment if the owner wants an exact runway estimate.
- The existing billing budget applies only to the TraceGate project; Vigil will need its own alerting budget. A Cloud Billing budget sends alerts and does not cap spend.

### Existing GCP project inventory

This was a read-only inventory. Existing resources remain outside Vigil Terraform state.

| Project | Relevant observed footprint | Suitability |
| --- | --- | --- |
| `boltstream-r7m5o9ld` | One running `e2-micro` VM, two disks, one state bucket, one custom VPC, two custom service accounts, two secrets | **Recommended; least occupied eligible project** |
| `minicontainer-r7m5o9ld` | Two running VMs, two disks, two in-use static IPs, two custom VPCs plus default, one state bucket | More network and compute overlap |
| `tracegate-r7m5o9ld` | VM, Cloud SQL, three Cloud Run services, Artifact Registry, multiple service accounts/buckets/secrets | Too crowded |
| `pulsequeue-r7m5o9ld` | Two running VMs, three disks, static IP, multiple VPCs, backup bucket, six unrelated secrets | Too crowded |
| `devcontrol-r7m5o9ld` | VM/database disks, three Cloud Run services, Artifact Registry, scheduler, internal address, many secrets | Too crowded |
| `project-3088a1b0-e0b5-4c95-9e6` | Billing disabled and Compute API disabled; organization-owned | Not eligible |

The recommended project currently uses 2 of its 5 VPC-network quota and 1 of its 32 global CPU quota. In `europe-west3` it showed 200 regional CPUs, 24 E2 CPUs, 8 static addresses, and 200 internal addresses available with zero regional use. Those observed quotas are ample for this design. Managed Kafka, Cloud SQL, and GKE service-specific creation is still an implementation-time preflight because their APIs are not enabled in this project yet.

The recommended project also contains an unrelated default Compute Engine service account with the broad Editor role and permissive firewall rules on the default VPC. Vigil must use neither. Its workloads use only the dedicated Vigil VPC and least-privilege identities.

### Local development toolchain

| Tool | Observed state | Plan |
| --- | --- | --- |
| Git 2.53 and GitHub CLI 2.88 | Ready and authenticated | Use |
| Node.js 24.19, npm 11.2, Corepack, pnpm 11.19 | Ready | Pin Node and pnpm in repository metadata |
| Go 1.26.7 | Ready | Pin the module/toolchain version |
| Python 3.11 | Ready | Auxiliary tooling only |
| FFmpeg 8.1 | Ready | Use locally; recorder image pins its own Linux FFmpeg |
| Docker Desktop / Compose | Installed, daemon stopped | Start Docker Desktop before local integration work |
| kubectl 1.36 | Ready, no current cluster context | GKE credentials will create the context |
| Terraform 1.15.8 | Ready; 1.16 was reported available | Existing version is adequate; upgrade is optional |
| gcloud 574 | Ready; Managed Kafka, GKE, SQL, and Run command groups present | Use |
| Buf | Missing | **Required installation before implementation** |
| protoc | Missing | Not required when Buf owns generation |
| grpcurl | Missing | Optional but recommended for manual gRPC smoke checks |
| Helm | Missing | Not required; use Kustomize through kubectl |
| psql | Missing | Not required; use the PostgreSQL container or an ephemeral client |
| kind/minikube/k3d | Missing | Not required; scheduler gets a focused fake-client test plus a real GKE smoke test |

The machine has Windows 11 Pro, 14 physical/20 logical CPU cores, 31.6 GiB RAM, and about 38 GiB free disk at inspection time. That is sufficient, although local images and integration volumes should be pruned deliberately rather than accumulating indefinitely.

## Current platform constraints

- Managed Service for Apache Kafka is available in `europe-west3`. Its minimum cluster is 3 vCPUs and 3 GiB RAM across at least three brokers/zones.
- The minimum cluster also bills 100 GiB local storage per vCPU. Using the current public default rates as rough arithmetic, the Kafka floor is about USD 189/month before regional variation, inter-zone traffic, and PSC processing. Kafka will dominate the demo’s baseline spend.
- A single Autopilot cluster’s USD 0.10/hour management fee is covered by the monthly GKE free-tier credit, but Pod CPU, memory, and ephemeral-storage requests are still billed.
- The free-trial program can restrict quota increases. Default observed quotas appear sufficient; creation itself is the definitive test.
- Autopilot accepts the recorder’s proposed 2 GiB ephemeral-storage limit; normal Autopilot Pods support 10 MiB through 10 GiB.
- Cloud Run native gRPC requires end-to-end HTTP/2 and an h2c server in the container. Separating REST and gRPC services avoids mixed-protocol routing and lets Cloud Run IAM protect the entire lease service.
- Managed Kafka requires TLS and authentication. In-cloud clients should use short-lived ADC credentials and `roles/managedkafka.client`, with explicit Kafka ACLs. No service-account JSON keys will be created.
- GKE Autopilot has managed Prometheus collection enabled by default, but application scraping still requires `PodMonitoring` resources.
- Cloud Storage lifecycle rules are a safety-net TTL, not the precise product deletion clock. The application retention worker performs timely deletion; bucket lifecycle cleans up anything it misses.

Primary references for these conclusions:

- [Managed Kafka locations](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/locations)
- [Managed Kafka sizing](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/plan-cluster-size)
- [Managed Kafka pricing](https://cloud.google.com/managed-service-for-apache-kafka/pricing)
- [Managed Kafka authentication](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/authentication-kafka)
- [Managed Kafka ACLs](https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/access-control-kafka-acls)
- [GKE Autopilot resource requests](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests)
- [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)
- [Cloud Run HTTP/2](https://docs.cloud.google.com/run/docs/configuring/http2)
- [Cloud Run service-to-service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
- [Cloud SQL from GKE](https://docs.cloud.google.com/sql/docs/postgres/connect-kubernetes-engine)
- [Managed Prometheus collection](https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/setup-managed)
- [Cloud Storage lifecycle](https://docs.cloud.google.com/storage/docs/lifecycle)
- [Cloud Storage signed URLs](https://docs.cloud.google.com/storage/docs/access-control/signed-urls)
- [GitHub Actions Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
- [Terraform Managed Kafka resource](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/managed_kafka_cluster)
- [Google Cloud Free Program restrictions](https://docs.cloud.google.com/free/docs/free-cloud-features)

## Refined system architecture

~~~mermaid
flowchart LR
    Viewer[Portfolio viewer / operator] -->|HTTPS| API[Public REST API + small UI<br/>Cloud Run]
    API -->|transactions| DB[(Cloud SQL PostgreSQL)]

    Lease[Authenticated lease gRPC<br/>Cloud Run] --> DB

    Worker[TypeScript backend worker<br/>GKE Autopilot] -->|poll outbox / project events| DB
    Worker -->|commands| Kafka[(Managed Kafka)]
    Kafka -->|commands| Scheduler[Go scheduler<br/>GKE Autopilot]
    Scheduler -->|create/watch| Job[Go recorder Job]

    Source[Synthetic HLS source<br/>GKE Autopilot] --> Job
    Job -->|Acquire / Renew / Release| Lease
    Job -->|segments + final MP4| GCS[(Cloud Storage)]
    Job -->|lifecycle events| Kafka
    Kafka -->|events| Worker

    API -->|short V4 signed URL| GCS
    Metrics[Managed Prometheus + Monitoring] -.scrapes/observes.-> Worker
    Metrics -.scrapes/observes.-> Scheduler
    Metrics -.scrapes/observes.-> Job
~~~

### Why the Cloud Run service is split

The baseline’s single Cloud Run box is conceptually sound, but one public service would make every path share the same Cloud Run IAM ingress decision and would require one Node server to multiplex REST and native gRPC. Two scale-to-zero services built from the same control-plane source are clearer:

- `vigil-api` serves REST, OpenAPI, and static UI over HTTP/1. Public reads are deliberate; all mutations require an operator session/token.
- `vigil-lease` serves only native gRPC over h2c. It requires Cloud Run IAM authentication and grants `roles/run.invoker` only to the recorder service account.

The lease service keeps one minimum instance to avoid cold-start risk during renewals. The public API may scale to zero.

### Why the backend worker stays in GKE

The outbox publisher and event projector are continuous poll/consume processes. A single TypeScript GKE Deployment is a natural home and avoids relying on background execution inside request-driven Cloud Run instances. One process can supervise two independent loops with separate health signals and graceful shutdown.

## Runtime and repository choices

Use a small pnpm workspace and ordinary Go modules—no monorepo framework.

~~~text
vigil/
├── apps/
│   ├── control-plane/        # TypeScript; REST/UI and gRPC entry points
│   └── backend-worker/       # TypeScript; outbox publisher + event projector
├── packages/
│   ├── domain/               # Pure state reducer and shared domain types
│   ├── database/             # pg access, migrations, repositories
│   └── observability/        # logs, metrics, tracing helpers
├── go/
│   ├── cmd/
│   │   ├── scheduler/
│   │   └── recorder/
│   └── internal/
├── proto/
│   └── vigil/recording/v1/
├── database/
│   └── migrations/
├── deploy/
│   └── kubernetes/
│       ├── base/
│       └── overlays/demo/
├── infra/
│   ├── bootstrap/            # state bucket + GitHub WIF foundation
│   ├── foundation/           # APIs, network, data services, IAM, GKE
│   └── platform/             # Cloud Run, monitoring, image-digest inputs
├── tests/
│   ├── contracts/
│   ├── integration/
│   └── failure-scenarios/
├── docs/
│   ├── architecture.md
│   ├── adr/
│   ├── runbook.md
│   └── postmortem.md
└── PLAN.md
~~~

Recommended implementation stack:

- TypeScript on Node 24, Fastify for REST/OpenAPI, native Node gRPC via `@grpc/grpc-js`, `pg` for explicit transactions, and a small SQL migration runner.
- Go for scheduler and recorder, standard gRPC, `segmentio/kafka-go`, and official Google Cloud clients.
- Buf as the single protobuf tool. Generate Go and TypeScript from one schema and pin all plugins.
- KafkaJS locally. For Managed Kafka, implement a small, focused SASL/PLAIN authentication provider that fetches a fresh ADC access token for each new broker connection, matching Google’s documented short-lived-token flow. Validate this against the real cluster before depending on it. If interoperability fails, use Google’s official local-auth sidecar with a supported librdkafka client; never fall back to a service-account key.
- PostgreSQL 16 in Cloud SQL Enterprise, a right-sized single-zone `db-custom-1-3840` instance, 20 GiB SSD, automated backups, PITR, private IP, and deletion protection disabled only because the demo must be Terraform-destroyable.
- Kustomize, which is already built into kubectl, instead of Helm.
- Regional Standard Cloud Storage with uniform bucket-level access and public-access prevention.

Pin container bases and GitHub Actions by immutable versions; use image digests for deployed revisions.

## GCP isolation rules

These rules are mandatory because the selected project already hosts unrelated resources:

1. Use `vigil-` for every mutable GCP resource name where supported.
2. Apply labels such as `app=vigil`, `environment=demo`, `managed_by=terraform`, and `owner=fullstack-nick`.
3. Create `vigil-vpc` and a dedicated `europe-west3` subnet with separate primary, Pod, Service, and private-service-access ranges. Do not attach to `boltstream-vpc` or `default`.
4. Use private GKE nodes, Cloud NAT for controlled outbound HLS access, Private Google Access, GKE Dataplane V2, and namespace NetworkPolicies.
5. Use private IP for Cloud SQL. Use the Cloud SQL Auth Proxy sidecar in GKE and a Cloud SQL connector/private path in Cloud Run.
6. Create one Kubernetes namespace, `vigil`, and namespace-scoped RBAC. The scheduler may create/watch/delete Jobs only in that namespace.
7. Create dedicated service accounts for control API, lease service, backend worker, scheduler, recorder, migration, URL signing, and deployment. Never use the default Compute service account.
8. Use Workload Identity Federation for GKE and GitHub Actions. Create no service-account keys.
9. Use individual Terraform IAM-member resources, never authoritative project IAM policy/binding resources that could remove existing principals.
10. Manage APIs with `disable_on_destroy = false` so tearing Vigil down cannot disable an API needed by an unrelated workload.
11. Use a dedicated state bucket and separate `bootstrap`, `foundation/demo`, and `platform/demo` state prefixes. Never reuse or import an unrelated resource into Vigil state.
12. Before every apply, inspect the plan and reject any update/delete outside `vigil-*` resources. State isolation makes that invariant mechanically checkable.
13. Use a separate recording bucket and Artifact Registry repository. Do not place objects/images into unrelated buckets or repositories.
14. A project-scoped billing budget will also observe the small existing BoltStream footprint. Resource labels should be used where billing attribution supports them, but they are not assumed to be perfect.

## Public surface and abuse prevention

The portfolio page should be small but polished enough to explain and demonstrate the system:

- architecture summary and current system health;
- test creator consent toggle;
- “record demo source” action;
- live state/timeline with segment progress;
- final HTML5 video playback;
- links to OpenAPI, dashboard screenshots, runbook, and postmortem.

Security defaults:

- Public unauthenticated access is read-only and exposes only records explicitly marked as public demos.
- `PUT /creators/:id/consent`, `POST /recordings`, `POST /recordings/:id/stop`, arbitrary record lookup, and signed playback URL generation require an operator credential.
- The owner enters the operator credential into the UI; it is never compiled into the frontend or committed. The API stores only a strong hash or reads the secret from Secret Manager and compares in constant time. Use a short-lived, HttpOnly, SameSite session cookie after login.
- Apply same-origin CORS, CSRF protection for cookie-authenticated mutations, CSP/security headers, request-size limits, rate limits, and structured audit logs.
- `POST /recordings` requires an `Idempotency-Key` header and has a database uniqueness constraint.
- The deployed demo accepts only the configured in-cluster synthetic HLS source. A developer-mode allowlist may permit additional HTTPS HLS hosts.
- Never pass an unrestricted user URL directly to FFmpeg. This avoids turning a public recorder into an SSRF/network-scanning service. Reject credentials in URLs, non-HTTP(S) schemes, redirects outside the allowlist, loopback/link-local/private/metadata destinations, and oversized playlists.
- Do not log source query strings, operator credentials, signed URLs, database passwords, tokens, or consent evidence.

## Consent and lease invariants

- Consent history is append-only: grant/revoke rows record creator, action, actor, timestamp, and policy version. “Current consent” is derived from the latest valid action.
- A recording request and its outbox command are inserted in one PostgreSQL transaction.
- Acquire is allowed only when consent is currently granted, no stop was requested, duration/concurrency limits pass, and the Job identity matches the scheduled recording.
- Lease TTL is 45 seconds; renew every 15 seconds.
- A worker watchdog stops FFmpeg before the last known lease expires if renewals cannot succeed. A network partition must fail closed.
- Consent revocation and operator stop are distinct reasons but both reject the next renewal. Privacy wins over completion if cancellation and completion conflict.
- On cancellation, cancel in-flight uploads, terminate FFmpeg gracefully, remove local spool data, delete any final object, schedule raw-prefix deletion, publish one deterministic stopped event, and expose no playback URL.
- Releasing a lease is idempotent.
- A creator revocation stops active recordings; retroactive deletion of previously completed recordings is out of scope beyond the normal retention policy.

## Event, command, and projection correctness

### Contracts

Keep protobuf under `vigil.recording.v1`. In addition to the baseline event payloads, add a `RecordingFinalizing` event so the visible state has a typed cause. Define a typed `StartRecordingCommand` envelope with `command_id`, `recording_id`, `requested_at`, and source reference.

No external schema registry is needed for this project. The repository schema plus Buf lint, breaking-change detection, deterministic generation, and cross-language fixtures form the contract boundary.

### Deterministic identities

- Kafka keys are `recording_id`, preserving normal per-recording partition order while never relying on it for correctness.
- Segment object names remain deterministic.
- Upload with a “does not exist” generation precondition. If the object already exists, verify size/checksum and treat a match as success; a mismatch is a hard integrity failure.
- Event IDs are deterministic for a logical fact, for example a stable hash/UUID derived from recording, attempt, event kind, and sequence. Retrying a worker must not invent a second business event.
- Store a hash of the serialized payload. Reuse of an event ID with different bytes is quarantined as a contract/integrity error rather than silently treated as a duplicate.
- Make `(attempt_id, sequence)` unique in addition to `event_id`.

### Projection algorithm

For the deliberately small event history, correctness is clearer than clever incremental transitions:

1. Begin a database transaction.
2. Insert the raw event using `ON CONFLICT DO NOTHING`.
3. If the event ID already exists with the same hash, increment the duplicate metric and acknowledge after commit.
4. If the ID or sequence conflicts with different content, store/quarantine the error and do not mutate the projection.
5. For a new event, load that recording attempt’s complete event history.
6. Sort by logical sequence with deterministic tie validation.
7. Rebuild the projection using one pure reducer.
8. Persist the projection and commit.
9. Commit the Kafka offset only after the database commit.

A delayed earlier event is retained but cannot regress a later state. Conflicting terminal results resolve deterministically, with consent/operator cancellation taking privacy precedence. A `READY` result requires a valid final object and a lease that remained authorized through finalization.

### Transactional outbox semantics

- Poll with `FOR UPDATE SKIP LOCKED` in small batches.
- Publish with `acks=all`.
- Mark published only after broker acknowledgement.
- A crash between publish and mark creates a duplicate command by design.
- The scheduler creates a deterministic Job name. “Already exists” is a successful replay, not a second Job.
- The scheduler commits its command offset only after the Job exists.

## Recorder mechanics

- Synthetic source: one Deployment with FFmpeg generating H.264/AAC test video/audio into an `emptyDir` and nginx serving the HLS playlist through a ClusterIP Service.
- Recording: FFmpeg reads HLS and writes five-second MPEG-TS segments using temporary-file/atomic rename behavior. Go uploads only completed segment files.
- Spool: six queued segments, 512 MiB queued-byte cap, two upload workers, 2 GiB Pod ephemeral-storage limit, and explicit disk accounting.
- Duration: hard deadline at ten minutes through both application context cancellation and Kubernetes `activeDeadlineSeconds`.
- Concurrency: PostgreSQL advisory-lock enforcement plus a namespace ResourceQuota limiting active recorder resources. Never rely only on a UI counter.
- Finalization: after capture, fetch/retain the bounded uploaded segments needed for concat, create an H.264/AAC MP4 with stream copy and `faststart`, validate it with ffprobe, upload using an object precondition, and then publish `RecordingCompleted`.
- Codec scope: the deployed synthetic source is fixed to H.264/AAC so stream-copy finalization is deterministic. Generic transcoding and arbitrary codec repair remain out of scope.
- Job policy: `backoffLimit: 0`. Seamless media resume is deliberately not implemented. The scheduler watches Jobs and publishes a deterministic failure event if a Pod is killed or the Job fails, ensuring a terminal state instead of an indefinitely stuck recording.

## Storage, playback, and retention

- Object layout:
  - `raw/{recording_id}/{attempt_id}/segment-000001.ts`
  - `vod/{recording_id}/recording.mp4`
- Bucket settings: uniform access, public-access prevention, no public ACLs, regional location, lifecycle delete safety net.
- The API creates V4 read-only signed URLs lasting 15 minutes. Signing uses IAM `signBlob` through a dedicated service account; no private key file exists.
- Default retention is 24 hours from completion.
- A backend-worker retention loop deletes raw and VOD prefixes at `retention_expires_at` and sets `purged_at`. Storage lifecycle deletes objects missed by the application.
- Recording lifecycle status remains terminal (`READY`/`FAILED`/`CANCELLED`); playback availability is represented separately by `purged_at` rather than moving the business state backwards.

## Database shape

Keep the six baseline tables, with the following critical fields/constraints:

- `creators`: ID and display metadata for the synthetic demo creator.
- `consent_grants`: append-only action, actor, policy version, occurred time.
- `recordings`: creator, source reference, status, idempotency key, requested/stop/completed timestamps, object path, retention expiry, purge timestamp, projection version.
- `recording_attempts`: attempt, recording, Job UID/name, lease owner, expiry, start/end, terminal reason.
- `recording_events`: event ID primary key, recording, attempt, sequence, type, occurrence time, payload bytes/JSON, payload hash, processing time; unique attempt/sequence.
- `outbox_messages`: command ID primary key, aggregate, topic/key, payload, created/published timestamps, attempts, last error, lock metadata.

Use database constraints for valid statuses, positive sequence/byte counts, duration bounds, and uniqueness. Use explicit transactions and SQL rather than hiding correctness behind an ORM.

## GCP deployment specification

### Foundation

- APIs required by Terraform, GKE, Cloud Run, Cloud SQL, Managed Kafka, Artifact Registry, Storage, Secret Manager, Monitoring, IAM Credentials, Service Networking, Cloud Resource Manager, and Billing Budgets.
- Dedicated VPC, subnet/IP ranges, router/NAT, private service access.
- Regional GKE Autopilot cluster with Workload Identity Federation, Dataplane V2/network policy, release channel, managed Prometheus, and cost allocation labels.
- Managed Kafka at the minimum 3 vCPU/3 GiB size; three partitions and replication factor three for both `vigil.recording.commands.v1` and `vigil.recording.events.v1`.
- Explicit Kafka ACLs. Managed Kafka’s permissive “no ACL found” behavior means every Vigil topic and consumer-group pattern must receive an ACL before application identities are admitted.
- Private Cloud SQL PostgreSQL.
- Dedicated Storage bucket, Artifact Registry repository, Secret Manager secrets, service accounts, and least-privilege IAM.
- Project-scoped budget alerts at configurable thresholds. They monitor; they do not shut services down.

### Workloads

- GKE Deployments: backend worker, scheduler, synthetic HLS source.
- GKE Jobs: one recorder per accepted recording; one migration Job per release.
- Cloud Run services: REST/UI and gRPC lease endpoint.
- Cloud Monitoring dashboard, two alert policies, notification channel supplied through uncommitted Terraform variables.

### Managed Kafka creation gate

The implementation must try the real Terraform resource first. Cluster creation can take about 30 minutes.

If the provider returns an account/trial/quota prohibition that cannot be resolved without upgrading billing or requesting quota, record the exact error in an ADR and switch the deployment variable to the GKE Kafka fallback. Do not treat ordinary provisioning time as failure, and do not request a quota increase from a free-trial billing account.

## Minimal, meaningful test strategy

There is no coverage target and no broad unit-test layer.

Keep only these tests:

1. **Pure projection table test**: a compact table covers duplicate, out-of-order, terminal-regression, and conflicting-terminal privacy precedence. This is a unit test because the reducer is the core correctness boundary.
2. **Cross-language protobuf fixture**: Go serializes and TypeScript deserializes, and vice versa; compare canonical fields and bytes where deterministic.
3. **Local integration scenario**: Docker Compose runs PostgreSQL, one Apache Kafka KRaft broker, fake GCS, synthetic HLS, and the services. One script verifies a complete MP4 with ffprobe.
4. **Failure scenario suite**: duplicate delivery, out-of-order delivery, projector outage/restart, consent revocation, and recorder Job/Pod death. Run locally where possible and against GKE for Kubernetes behavior.
5. **Cloud smoke**: after deployment, grant consent, record a short source, verify storage/events/READY/playback, then revoke another recording and kill a third Job.

Tests must be deterministic, have bounded timeouts, print useful diagnostics, and clean up their own records/objects. Do not add snapshot churn, trivial accessor tests, or generated-code tests.

## Minimal CI/CD

### `verify.yml` — pull requests and pushes

Fast gates only:

- install pinned dependencies from lockfiles;
- Buf lint, breaking check against the default branch, and generated-code drift check;
- TypeScript typecheck/build;
- Go format check and `go build ./...`;
- Terraform format and validate;
- `kubectl kustomize` render check;
- secret scan and a small public-branding guard for product-facing files.

Do **not** run the integration/failure suites or conventional unit-test suite in CI. The one pure reducer test and contract fixture are run locally before a release; they may be added to CI later only if they remain consistently fast and valuable.

### `deploy.yml` — manual `workflow_dispatch`

- GitHub OIDC to GCP through Workload Identity Federation; no JSON key secret.
- Apply bootstrap/foundation when required.
- Build images, push to the dedicated Artifact Registry, and capture immutable digests.
- Apply the platform stack with those digests.
- Run the migration Job.
- Apply the Kustomize overlay and wait for rollouts.
- Run a single read-only health/smoke probe.

Manual deployment is intentional: Managed Kafka/Cloud SQL/GKE provisioning is expensive and slow, and automatic deployment on every commit has no portfolio value.

## Implementation sequence

### Phase 0 — branding and cloud preflight

1. Record the resolved Vigil name and protected-control decision.
2. Initialize Git and create the public `fullstack-nick/vigil` repository.
3. Install Buf; start Docker Desktop; confirm all pinned versions.
4. Create the isolated Terraform bootstrap/state and GitHub WIF resources.
5. Generate and inspect a foundation plan proving that no existing resource is changed or destroyed.
6. Apply the Managed Kafka/API/network preflight and exercise a minimal Go and TypeScript authenticated producer/consumer.
7. Activate the documented Kafka fallback only on a definitive provider/account rejection.

### Phase 1 — local vertical media slice

1. Synthetic HLS source.
2. Go recorder with lease stub, bounded spool, fake GCS upload, final MP4, and ffprobe validation.
3. One Docker Compose demonstration.

### Phase 2 — control plane

1. Migrations and data model.
2. REST endpoints, operator auth, idempotency key, concurrency guard, and OpenAPI.
3. Authenticated gRPC lease service and worker watchdog.
4. Small portfolio UI.

### Phase 3 — event-driven state

1. Protobuf commands/events and generated Go/TypeScript.
2. Transactional outbox.
3. Scheduler and deterministic Job creation.
4. Recorder events.
5. Idempotent event projector and pure reducer.

### Phase 4 — reliability and retention

1. Five focused failure scenarios.
2. Deterministic object/event retry behavior.
3. Stop/revoke cleanup.
4. Retention loop and bucket lifecycle.
5. Stuck-Job/expired-lease reconciliation.

### Phase 5 — GCP and operations

1. Complete foundation/platform Terraform.
2. Kustomize workloads and Workload Identity.
3. Managed Prometheus, dashboard, alerts, SLO.
4. Minimal GitHub Actions verification and manual deployment.
5. Intentional storage-permission incident, recovery, and one-page postmortem.

### Phase 6 — portfolio finish

1. README with a concise product story, architecture, invariants, demo, and cost/teardown notes.
2. Architecture and failure-flow diagrams.
3. Screenshots or a short demo recording generated from Vigil itself.
4. Runbook, ADRs, threat notes, API examples, and exact local/cloud quick starts.
5. Final scan ensuring product-facing artifacts contain no prohibited company/product references or borrowed branding.

## Refined definition of done

The baseline demonstration remains required, plus:

- Public repo exists under the chosen final name and has an independent license/provenance.
- Public UI is readable without credentials, while all spend-causing actions are protected.
- A Terraform plan and state listing prove no unrelated GCP resource is managed.
- GitHub Actions and GKE use federation, not service-account keys.
- Kafka topic/group ACLs are explicit.
- Source URL handling cannot reach arbitrary internal/metadata endpoints in the deployed configuration.
- A duplicate logical segment cannot create a duplicate event or overwrite different bytes.
- Consent/stop cancellation wins any race with final playback exposure.
- The killed Job reaches `FAILED` through scheduler reconciliation with no seamless-resume claim.
- Application cleanup runs at 24 hours and bucket lifecycle is a backstop.
- CI contains no slow test suite; local critical tests and the cloud smoke pass.
- Deployment docs state the real always-on cost shape and that budget alerts are not a hard cap.
- Terraform can destroy the Vigil environment without disabling shared APIs or touching unrelated resources.

## Resolved decisions

### 1. Exact public name

The owner selected **Vigil**. The public repository path is `fullstack-nick/vigil`, product-facing identifiers use Vigil, and cloud resources use the `vigil-` prefix.

### 2. Public demo interaction

Visitors receive read-only access. Only the owner can grant consent and start or stop recordings after entering an operator credential, which creates a short-lived, HttpOnly, SameSite session. The credential is never embedded in the client bundle. Anonymous visitors cannot launch workloads or spend cloud resources.

Everything else has a recommended default and does not require another design meeting.

---

# Appendix A — original user-supplied plan (verbatim)

The content below is copied exactly and is intentionally not edited.

## Build this: **a consent-gated live-stream recording control plane**

Although the job is advertised through OWN3D/StreamTV, the position is specifically centered on **Reecorder**: a system that records creators’ live streams with consent and turns the pipeline’s raw events into a reliable product. The role sits between a TypeScript/Postgres backend and a Go/Kubernetes recording pipeline, with Kafka, gRPC/protobuf, idempotency, resource constraints, retention, and production operations all explicitly mentioned. ([Own3d Jobs][1])

Your project should therefore be:

> **A small service where a creator grants consent, an operator submits a live HLS stream URL, and the system launches a Go recording worker on Kubernetes. The worker records the stream into bounded segments, uploads them to Cloud Storage, and publishes lifecycle events that a TypeScript backend reliably projects into Postgres.**

Call it something generic such as **StreamVault** or **Mini Reecorder**.

Do **not** build the AI clipping system. The recording/control-plane seam is already a complete and highly representative project.

---

## What the finished system should do

1. Create a test creator and grant them recording consent.
2. Submit a generic HLS stream URL for recording.
3. Create a `recording` in the TypeScript backend with status `REQUESTED`.
4. Publish a start command to Kafka using a transactional outbox.
5. Have a Go scheduler consume the command and create a Kubernetes Job.
6. Have the Go recorder:

   * Ask the TypeScript control plane over gRPC whether recording is currently authorized.
   * Record short HLS segments into bounded temporary storage.
   * Upload segments to Google Cloud Storage.
   * Periodically renew its consent/recording lease.
   * Publish protobuf lifecycle events to Kafka.
7. Have a TypeScript consumer store those events idempotently in Postgres and update the recording’s visible state.
8. When the stream ends, produce one final playable MP4 and expose a signed playback URL.
9. Automatically delete the recording after a short retention period.

The public product surface can remain tiny:

```text
PUT  /creators/:creatorId/consent
POST /recordings
GET  /recordings/:recordingId
POST /recordings/:recordingId/stop
```

No full customer-facing frontend is needed. An OpenAPI page or one barebones internal status screen is enough.

---

## The architecture

```text
                         ┌─────────────────────────────┐
 Operator / tiny UI ───► │ TypeScript Control API      │
                         │ Cloud Run                    │
                         │ REST + internal gRPC         │
                         └──────────────┬──────────────┘
                                        │
                              Cloud SQL PostgreSQL
                                        │
                              transactional outbox
                                        │
                                        ▼
                               Kafka: recording.commands
                                        │
                                        ▼
                         ┌─────────────────────────────┐
                         │ Go Recorder Scheduler        │
                         │ GKE Autopilot Deployment     │
                         └──────────────┬──────────────┘
                                        │ creates
                                        ▼
                         ┌─────────────────────────────┐
 HLS test stream ──────► │ Go Recorder Kubernetes Job  │
                         │ one Job per recording        │
                         └───────┬───────────┬─────────┘
                                 │           │
                       segments / MP4        │ protobuf events
                                 ▼           ▼
                        Cloud Storage   Kafka: recording.events
                                             │
                                             ▼
                                  ┌──────────────────────┐
                                  │ TypeScript Projector │
                                  │ GKE Deployment       │
                                  └──────────┬───────────┘
                                             │
                                      Cloud SQL Postgres
```

Cloud Run is a good home for the TypeScript control plane because it can serve both HTTP and gRPC, including unary and streaming gRPC methods. GKE Autopilot gives you Kubernetes while keeping the cluster-management work limited; importantly for this exercise, its scheduling is driven by the CPU, memory, and storage requests you define for the recorder. ([Google Cloud Documentation][2])

---

## Keep the scope deliberately narrow

### Include

* One generic HLS source type.
* Maximum of three simultaneous recordings.
* Maximum recording duration of ten minutes.
* One video quality; copy the existing codecs where possible.
* Five- or ten-second segments.
* One European GCP region.
* One creator consent model: granted or revoked.
* One final MP4.
* One retention policy.
* Four lifecycle endpoints.
* One dashboard and two meaningful alerts.

### Explicitly exclude

* TikTok authentication or stream discovery.
* Twitch, YouTube, or Kick integrations.
* AI transcription, classification, clipping, captions, or recommendations.
* Multiple encoding qualities.
* Billing, payouts, subscriptions, entitlements, or community features.
* A polished creator-facing application.
* Multi-region failover.
* Hundreds of real concurrent video streams.

Use a synthetic HLS source rather than integrating with TikTok. A small FFmpeg container can generate a moving test pattern and audio tone into an HLS playlist. That keeps the exercise about backend reliability instead of platform APIs and account restrictions.

---

## The most important technical part: event correctness

Your project should not be impressive because it records a video. FFmpeg already does that.

It should be impressive because **nothing breaks when events are delivered twice, late, or in an unexpected order**.

Use a protobuf envelope resembling:

```proto
message RecordingEvent {
  string event_id = 1;
  string recording_id = 2;
  string attempt_id = 3;
  uint64 sequence = 4;
  google.protobuf.Timestamp occurred_at = 5;

  oneof payload {
    RecordingStarted started = 10;
    SegmentUploaded segment_uploaded = 11;
    RecordingCompleted completed = 12;
    RecordingFailed failed = 13;
    RecordingStopped stopped = 14;
  }
}
```

Generate TypeScript and Go code from the same schema. Add a cross-language fixture test in which Go serializes an event and TypeScript deserializes it, and vice versa. Put protobuf breaking-change detection in CI. That directly mirrors the posting’s emphasis on typed, contract-first systems and cross-language parity tests. ([Own3d Jobs][1])

### Postgres model

Keep it to roughly these tables:

```text
creators
consent_grants
recordings
recording_attempts
recording_events
outbox_messages
```

`recording_events.event_id` must be unique.

When consuming an event:

1. Start a Postgres transaction.
2. Insert the event with `ON CONFLICT DO NOTHING`.
3. If it already exists, increment a duplicate metric and acknowledge it.
4. If it is new, update or rebuild the recording projection.
5. Commit before acknowledging the Kafka message.

Do not treat the Kafka offset as the business-level ordering mechanism. Store `attempt_id`, `sequence`, and `occurred_at` in the domain event.

A sensible state machine is:

```text
REQUESTED
   │
   ▼
STARTING ─────► REJECTED_NO_CONSENT
   │
   ▼
RECORDING
   │
   ▼
FINALIZING
   │
   ▼
READY

Any nonterminal state ──► CANCELLED
Any nonterminal state ──► FAILED
```

Earlier events must never move a terminal recording backwards. For example, a delayed `RecordingStarted` event arriving after `RecordingCompleted` should be recorded in the event history but should not change `READY` back to `RECORDING`.

---

## Make consent part of the running pipeline

Consent should not just be a boolean checked when the API request arrives.

Give the Go worker a gRPC control-plane interaction such as:

```text
AcquireRecordingLease(recording_id, worker_id)
RenewRecordingLease(recording_id, attempt_id)
ReleaseRecordingLease(recording_id, attempt_id)
```

`AcquireRecordingLease` returns:

```text
authorized
attempt_id
source_url
storage_prefix
lease_expires_at
```

The worker renews the lease every 15 seconds. If consent is revoked:

1. The next renewal is rejected.
2. FFmpeg receives a graceful stop signal.
3. The worker removes temporary spool data.
4. It publishes `RecordingStopped` with reason `CONSENT_REVOKED`.
5. The backend reaches `CANCELLED`.

That is a small feature, but it makes the project feel like an actual creator-consent product rather than a generic video downloader.

---

## Give the recorder a real resource budget

Configure every recording Job with explicit limits, for example:

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
    ephemeral-storage: "1Gi"
  limits:
    cpu: "1"
    memory: "1Gi"
    ephemeral-storage: "2Gi"
```

Implement a spool policy:

```text
segment duration:        5 seconds
maximum queued segments: 6
maximum spool bytes:     512 MiB
upload concurrency:      2
```

If uploads fall behind and the spool reaches its limit, stop recording with a clear `SPOOL_EXHAUSTED` error rather than filling the Pod’s disk.

This gives you something concrete to discuss around the posting’s references to memory budgets, segment spool windows, worker capacity, egress, and scaling concurrent recordings. ([Own3d Jobs][1])

Use deterministic object names:

```text
raw/{recording_id}/{attempt_id}/segment-000001.ts
raw/{recording_id}/{attempt_id}/segment-000002.ts
vod/{recording_id}/recording.mp4
```

That makes worker retries safer: re-uploading segment 12 does not silently create a second copy under a different name.

---

## Failure scenarios you should deliberately test

These are more valuable than adding extra features.

### 1. Duplicate Kafka delivery

Publish every event twice.

Expected result:

* One `recording_events` row per event ID.
* Correct segment count.
* Correct byte total.
* Recording reaches `READY` exactly once.

### 2. Out-of-order events

Deliver:

```text
SegmentUploaded(sequence=2)
RecordingCompleted(sequence=4)
RecordingStarted(sequence=1)
SegmentUploaded(sequence=3)
```

Expected result:

* All four events are retained.
* Projection ends in `READY`.
* Start time and completion time are correct.
* No impossible transition is exposed to the API.

### 3. Recorder Pod dies

Kill the recorder while it is running.

Expected result:

* Kubernetes retries according to the Job policy.
* Existing uploaded segments are not duplicated.
* The recording either resumes as the same attempt or cleanly reaches `FAILED`.
* It never remains in `STARTING` forever.

For the smaller version, cleanly reaching `FAILED` is entirely acceptable. Seamless video recovery is unnecessary scope.

### 4. Consent is revoked

Revoke consent during the stream.

Expected result:

* The worker stops within one lease-renewal interval.
* No final `READY` VOD is exposed.
* Temporary objects are deleted or marked for cleanup.
* The final status is `CANCELLED`.

### 5. Projector is offline

Stop the TypeScript Kafka consumer, let events accumulate, and restart it.

Expected result:

* It catches up.
* Replayed messages do not corrupt totals.
* The final Postgres projection matches the event history.

---

## GCP deployment

Use:

* **Cloud Run** for the TypeScript REST/gRPC control plane.
* **GKE Autopilot** for the Go scheduler, TypeScript Kafka projector, synthetic HLS source, and short-lived recorder Jobs.
* **Cloud SQL for PostgreSQL** for product state and the event log.
* **Google Cloud Managed Service for Apache Kafka** for commands and recording events.
* **Cloud Storage** for raw segments and finalized VODs.
* **Artifact Registry** for images.
* **Secret Manager** for configuration and credentials.
* **Cloud Monitoring and Managed Service for Prometheus** for dashboards and alerts.
* **Terraform** for the complete environment.

Cloud SQL is Google’s managed PostgreSQL offering. Cloud Storage lifecycle rules can automatically delete objects after a specified age, which is ideal for implementing your deliberately short demo retention period. Managed Prometheus collection is integrated with GKE and can collect your application’s Prometheus metrics without you running a complete Prometheus installation yourself. ([Google Cloud Documentation][3])

A reasonable location is Frankfurt, `europe-west3`; it is currently among the European regions listed for Google Cloud Managed Service for Apache Kafka. ([Google Cloud Documentation][4])

### Kafka cost warning

Google Cloud Managed Service for Apache Kafka has a minimum cluster size of three vCPUs and three GiB of memory, and clusters are distributed across three zones. It is production-shaped infrastructure, not a scale-to-zero development service. ([Google Cloud Documentation][5])

For normal development:

* Run a single local Kafka broker through Docker.
* Keep the Kafka client configuration provider-neutral.
* Create the managed GCP cluster through Terraform for deployed testing.
* Destroy it when you are not actively using the environment.

Google’s managed service runs compatible open-source Kafka, so your producer and consumer application code can remain essentially the same between local and managed environments. ([Google Cloud Documentation][6])

---

## Metrics and operational work

Expose at least:

```text
recordings_active
recording_start_latency_seconds
recording_duration_seconds
recording_failures_total{reason}
segments_uploaded_total
segment_upload_failures_total
recorder_spool_bytes
recording_event_processing_lag_seconds
recording_events_duplicate_total
recording_events_out_of_order_total
consent_revocations_total
```

Create one dashboard containing:

* Active recordings.
* Success/failure count.
* Start latency.
* Kafka event-processing lag.
* Spool usage.
* Segment upload error rate.

Create two alerts:

1. An active recording has not uploaded a segment for 30 seconds.
2. The event projector is more than 60 seconds behind.

Define one modest SLO:

> 99% of accepted recordings must reach a terminal state within 60 seconds of the source ending.

The terminal state can be `READY`, `FAILED`, or `CANCELLED`; the important property is that recordings do not become permanently stuck.

Then intentionally break storage permissions, observe the alert, fix the problem, and write a one-page postmortem. The posting explicitly expects ownership of dashboards, alerts, error budgets, deploy discipline, incident response, and postmortems, so this document is more representative than another application feature. ([Own3d Jobs][1])

---

## Suggested repository structure

```text
streamvault/
├── apps/
│   ├── control-api/          # TypeScript REST and gRPC server
│   └── backend-worker/       # TypeScript outbox publisher and event projector
├── go/
│   ├── cmd/
│   │   ├── scheduler/        # consumes commands and creates Kubernetes Jobs
│   │   └── recorder/         # FFmpeg, spool, GCS upload, Kafka events
│   └── internal/
├── proto/
│   └── recording/v1/
├── database/
│   └── migrations/
├── deploy/
│   ├── kubernetes/
│   └── helm/
├── infra/
│   └── terraform/
├── tests/
│   ├── contracts/
│   ├── integration/
│   └── failure-scenarios/
└── docs/
    ├── architecture.md
    ├── adr/
    ├── runbook.md
    └── postmortem.md
```

Keep TypeScript in a small `pnpm` workspace. You do not need an elaborate monorepo framework.

---

## Build it in this order

### Milestone 1: the vertical slice

* Synthetic HLS source.
* Manually launched Go recorder Job.
* Record one minute.
* Upload one final MP4 to Cloud Storage.

Do not add Kafka until this works.

### Milestone 2: product control plane

* Creator and consent tables.
* `POST /recordings`.
* gRPC lease acquisition.
* Scheduler creates the Kubernetes Job.

### Milestone 3: event-driven state

* Protobuf contracts.
* Kafka commands and lifecycle events.
* Transactional outbox.
* TypeScript event projector.
* Recording state API.

### Milestone 4: reliability

* Duplicate event handling.
* Out-of-order event handling.
* Worker termination.
* Consent revocation.
* Retention cleanup.

### Milestone 5: production ownership

* Terraform.
* CI contract gates.
* Metrics.
* Dashboard.
* Alerts.
* Runbook.
* One intentional incident and postmortem.

---

## Definition of done

The project is finished when you can run one demonstration that shows:

1. Consent is granted.
2. A recording is requested.
3. A Kubernetes Job appears.
4. Segments arrive in Cloud Storage.
5. Kafka events update Postgres.
6. A completed MP4 becomes available.
7. Replaying all events does not change the result.
8. Revoking consent stops another recording.
9. Killing a worker produces a sensible terminal state.
10. The dashboard and alert reveal the failure.
11. Terraform can create and remove the environment.
12. The README explains the contracts, invariants, failure modes, and operational decisions.

That is a realistically sized project with a very small product surface. Its depth comes from making one recording lifecycle correct under failure—which is much closer to this job than building a larger streaming application with many superficial features.

[1]: https://own3d.jobs.personio.de/job/2758605?language=en "Backend Engineer (m/f/x) | Jobs at StreamTV Media GmbH"
[2]: https://docs.cloud.google.com/run/docs/triggering/grpc?utm_source=chatgpt.com "Using gRPC | Cloud Run"
[3]: https://docs.cloud.google.com/sql/docs/postgres?utm_source=chatgpt.com "Cloud SQL for PostgreSQL"
[4]: https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/locations "Managed Service for Apache Kafka locations  |  Google Cloud Documentation"
[5]: https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/plan-cluster-size?utm_source=chatgpt.com "Plan the size of your Managed Service for Apache Kafka ..."
[6]: https://docs.cloud.google.com/managed-service-for-apache-kafka/docs/overview?utm_source=chatgpt.com "Managed Service for Apache Kafka overview"

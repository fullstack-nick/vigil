# ADR-0004: isolated GCP deployment and managed Kafka gate

- Status: accepted
- Date: 2026-08-27

## Context

The GCP account cannot create another project, and the chosen existing project contains unrelated resources. The desired managed Kafka service can also be unavailable because of account or quota constraints.

## Decision

Deploy into `boltstream-r7m5o9ld` in `europe-west3`, but own only dedicated `vigil-*` resources in separate Terraform states. Use a new VPC, subnet/ranges, bucket, repository, identities, cluster, database, Kafka cluster, and namespace. Manage IAM with additive member resources; never import existing resources. Enabled APIs remain enabled on destroy.

Attempt the minimum real Managed Kafka cluster first. Switch to a dedicated GKE KRaft fallback only after a definitive provider, account, or quota rejection that cannot be resolved without a billing upgrade or quota request.

## Consequences

The deployment can coexist with unrelated workloads and be torn down independently. A full managed stack has meaningful always-on cost and provisioning time. Any fallback activation and exact provider error must be appended to this record.

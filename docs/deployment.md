# GCP deployment, cost shape, and teardown

## Fixed target and isolation

- Account: the active `nickaccturk@gmail.com` gcloud identity
- Existing project: `boltstream-r7m5o9ld`
- Region: `europe-west3`
- Repository: `fullstack-nick/vigil`
- Resource prefix: `vigil-`

The bootstrap, foundation, and platform states are independent. The foundation owns no pre-existing resource. Project API resources use `disable_on_destroy = false`; teardown therefore cannot disable an API that an unrelated workload might need.

## One-time deployment

The checked-in driver performs the same plan/apply/build sequence used for the first release:

```powershell
pwsh -NoProfile -File scripts/deploy.ps1
```

It verifies the active account, creates only the bootstrap resources with local state, migrates foundation/platform state into the dedicated bucket, requires immutable image digests, applies GKE manifests, waits for rollouts, and runs the cloud smoke. Plans must be inspected before each apply; a plan containing an unrelated resource address or any unexpected update/delete is a stop condition.

Managed Kafka creation can take roughly half an hour. Provisioning time is not a fallback trigger. Only a definitive account, billing, or quota prohibition permits the documented KRaft fallback.

## Manual GitHub deployment

After bootstrap, set repository variables to its outputs:

```powershell
$provider = terraform "-chdir=infra/bootstrap" output -raw github_workload_identity_provider
$serviceAccount = terraform "-chdir=infra/bootstrap" output -raw github_service_account
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo fullstack-nick/vigil --body $provider
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --repo fullstack-nick/vigil --body $serviceAccount
```

The `Deploy demo` workflow is manual. It authenticates through GitHub OIDC, builds and pushes three images, applies only the platform state, renders digest-pinned Kubernetes resources, waits for rollouts, and performs a read-only public probe. Foundation changes remain an explicit local operator action because they are expensive and infrequent.

## Cost shape

The primary always-on costs are:

- Managed Kafka at 3 vCPU and 3 GiB with replicated storage;
- Cloud SQL at 1 vCPU, 3.75 GiB memory, 20 GiB SSD, backups, and PITR logs;
- the GKE Autopilot requests for the worker, scheduler, synthetic source, system overhead, and temporary recorder Jobs;
- one minimum `vigil-lease` Cloud Run instance;
- Cloud Storage, Artifact Registry, logging, monitoring, NAT, and network egress according to use.

`vigil-api` may scale to zero. Storage objects expire after application retention and a two-day lifecycle backstop. A project-scoped USD 300 monthly budget sends threshold signals at 50%, 80%, and 100%, but it does not stop resources. The budget also sees any small unrelated project spend, so labels and named resources are the attribution boundary.

## Teardown

Destroy from consumers to foundations:

```powershell
$stateBucket = terraform "-chdir=infra/bootstrap" output -raw state_bucket
$kafkaBrokers = gcloud managed-kafka clusters describe vigil-events --project boltstream-r7m5o9ld --location europe-west3 --format="value(bootstrapAddress)"
$env:TF_VAR_state_bucket = $stateBucket
$env:TF_VAR_kafka_brokers = $kafkaBrokers
$env:TF_VAR_node_image = "<last deployed digest>"

terraform "-chdir=infra/platform" init -reconfigure -backend-config="bucket=$stateBucket" -backend-config="prefix=platform/demo"
terraform "-chdir=infra/platform" destroy
kubectl delete namespace vigil --ignore-not-found
terraform "-chdir=infra/foundation" init -reconfigure -backend-config="bucket=$stateBucket" -backend-config="prefix=foundation/demo"
terraform "-chdir=infra/foundation" destroy
terraform "-chdir=infra/bootstrap" destroy
```

Review every destroy plan. The recording and state buckets use `force_destroy` so the final two commands can remove demo data and versioned state; that deletion is irreversible. Existing non-Vigil networks, buckets, images, services, and IAM bindings are out of scope and must never appear in the plans.

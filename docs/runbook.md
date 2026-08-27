# Vigil operator runbook

All examples pin the project and region explicitly so the workstation's default GCP project is irrelevant.

```powershell
$vigilProject = "boltstream-r7m5o9ld"
$vigilRegion = "europe-west3"
```

## Fast health triage

```powershell
$vigilUrl = gcloud run services describe vigil-api --project $vigilProject --region $vigilRegion --format="value(status.url)"
Invoke-RestMethod "$vigilUrl/readyz"
Invoke-RestMethod "$vigilUrl/api/public/summary"

gcloud container clusters get-credentials vigil-autopilot --project $vigilProject --region $vigilRegion
kubectl get deploy,job,pod,svc -n vigil -o wide
kubectl get events -n vigil --sort-by=.lastTimestamp
```

## Recording stuck in REQUESTED

1. Inspect the outbox worker and scheduler.
2. Confirm the command topic and consumer group ACLs still exist.
3. Do not manually mark the outbox row published.

```powershell
kubectl logs deployment/vigil-backend-worker -n vigil -c worker --since=20m
kubectl logs deployment/vigil-scheduler -n vigil --since=20m
kubectl describe resourcequota vigil-runtime -n vigil
gcloud managed-kafka acls list --cluster vigil-events --location $vigilRegion --project $vigilProject
```

The scheduler retains a command whose Job could not be created and retries with bounded backoff. Finished recorder Jobs normally expire after 60 seconds. If the Job quota is still exhausted, inspect the labeled Jobs and remove only terminal demo Jobs; never delete an active recorder to make room. The safe broker recovery is to restore access and restart the affected Deployment so the outbox and committed offsets replay.

## Recording stuck in RECORDING or FINALIZING

```powershell
kubectl get jobs -n vigil -l app=vigil,component=recorder
kubectl logs -n vigil -l app=vigil,component=recorder --all-containers --tail=200
kubectl logs deployment/vigil-backend-worker -n vigil -c worker --since=20m
```

If the Pod vanished, wait for failed-Job or expired-lease reconciliation. Do not fabricate a completion event or expose an object manually. A failed attempt remains failed; seamless resume is outside scope.

## Consent revocation did not settle

The API immediately marks active rows cancelled and hides playback. The recorder normally observes denial on its next 15-second renewal.

```powershell
gcloud run services logs read vigil-lease --project $vigilProject --region $vigilRegion --limit=100
kubectl logs -n vigil -l app=vigil,component=recorder --tail=200
```

If no recorder remains, expired-lease reconciliation is the backstop. Confirm that no `vod/{recording_id}/recording.mp4` is publicly exposed; the bucket enforces public-access prevention.

## Event integrity conflict alert

Treat this as evidence, not a retryable duplicate. Preserve the stored payload and conflict hash before changing anything.

```powershell
kubectl logs deployment/vigil-backend-worker -n vigil -c worker --since=1h | Select-String "event identity conflict quarantined"
gcloud logging read 'jsonPayload.message="event identity conflict quarantined"' --project $vigilProject --freshness=1h --limit=50 --format=json
```

Find the event through a read-only SQL session, compare producer logs, and determine which identity was reused. The projector intentionally leaves the prior projection unchanged.

## Storage permission failure

Symptoms are a failed recorder, `403` upload errors with URL details redacted, and no playback. Check the bucket-level binding for `vigil-recorder@...` and restore it through Terraform or the exact IAM member command in the incident procedure. Never grant `allUsers` access.

## Rollback

Deployments use immutable image digests. Re-run the manual deployment workflow with a known-good commit, or apply `infra/platform` and the rendered Kustomize overlay with the prior digests. Database migrations are forward-only; inspect a migration before rolling application code behind its schema.

## Owner credential rotation

```powershell
$newCredential = Read-Host "New owner credential" -AsSecureString
# Convert only in memory, then add a new Secret Manager version.
```

Add the value to `vigil-operator-credential`, deploy a new API revision, verify login, and disable the old secret version. Rotating `vigil-session-secret` invalidates every owner session immediately.

## Evidence collection

Record UTC start/end times, recording ID, attempt ID, immutable image digests, relevant structured logs, alert state, and the exact recovery command. Never paste credentials, signed URLs, source query strings, or database passwords into an incident record.

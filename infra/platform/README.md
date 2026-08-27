# Platform

This stack creates the migration Job, public REST/UI service, IAM-protected h2c lease service, dashboard, and two alerts. The migration executes once for each immutable Node image before either service is updated.

Both `node_image` and the GKE image inputs used by the deployment script must be digest-pinned. Obtain the Kafka bootstrap address with:

```powershell
gcloud managed-kafka clusters describe vigil-events --project boltstream-r7m5o9ld --location europe-west3 --format="value(bootstrapAddress)"
```

Initialize this state with prefix `platform/demo`, then pass the state bucket, image digest, and broker address through an uncommitted `.tfvars` file or `TF_VAR_*` environment variables.


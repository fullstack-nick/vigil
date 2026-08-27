# Foundation

This state owns only `vigil-*` resources in `boltstream-r7m5o9ld`: APIs (with `disable_on_destroy = false`), a dedicated VPC, private data services, identities, GKE, Managed Kafka, storage, Artifact Registry, and a project-scoped budget alert.

Initialize with the bucket created by `infra/bootstrap`:

```powershell
$bucket = terraform -chdir=infra/bootstrap output -raw state_bucket
terraform -chdir=infra/foundation init -backend-config="bucket=$bucket" -backend-config="prefix=foundation/demo"
terraform -chdir=infra/foundation plan -out foundation.tfplan
terraform -chdir=infra/foundation show foundation.tfplan
terraform -chdir=infra/foundation apply foundation.tfplan
```

Reject a plan containing update/delete actions for anything without the Vigil prefix. API resources are the only intentionally project-scoped exceptions and are never disabled on destroy.


# Bootstrap

This stack is intentionally the only stack with local state. It creates the dedicated, versioned Vigil state bucket and the repository-scoped GitHub OIDC identity. It never imports or manages existing project resources.

```powershell
terraform "-chdir=infra/bootstrap" init
terraform "-chdir=infra/bootstrap" plan "-out=bootstrap.tfplan"
terraform "-chdir=infra/bootstrap" apply bootstrap.tfplan
```

Foundation and platform state use separate prefixes in the bucket emitted as `state_bucket`.

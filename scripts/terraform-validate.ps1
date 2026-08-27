$ErrorActionPreference = "Stop"

$infraRoot = Join-Path $PSScriptRoot "..\infra"
foreach ($stack in @("bootstrap", "foundation", "platform")) {
  $path = Join-Path $infraRoot $stack
  & terraform "-chdir=$path" init -backend=false -input=false -lockfile=readonly
  if ($LASTEXITCODE -ne 0) { throw "terraform init failed for $stack" }
  & terraform "-chdir=$path" validate
  if ($LASTEXITCODE -ne 0) { throw "terraform validate failed for $stack" }
}


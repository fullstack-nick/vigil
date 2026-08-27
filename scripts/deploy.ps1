[CmdletBinding()]
param(
  [switch]$SkipFoundation,
  [switch]$SkipImages,
  [switch]$SkipSmoke
)

$ErrorActionPreference = "Stop"
$vigilProject = "boltstream-r7m5o9ld"
$vigilRegion = "europe-west3"
$expectedAccount = "nickaccturk@gmail.com"

function Assert-NativeSuccess([string]$Description) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE"
  }
}

function Assert-SafePlan([string]$Directory, [string]$PlanFile) {
  $json = terraform "-chdir=$Directory" show -json $PlanFile | ConvertFrom-Json -Depth 100
  Assert-NativeSuccess "Read Terraform plan in $Directory"
  $destructive = @($json.resource_changes | Where-Object { $_.change.actions -contains "delete" })
  if ($destructive.Count -gt 0) {
    $addresses = ($destructive.address -join ", ")
    throw "Refusing destructive Terraform plan in ${Directory}: $addresses"
  }
  $unexpected = @($json.resource_changes | Where-Object {
    $_.type -notmatch '^google_' -and $_.type -notin @('random_password', 'terraform_data')
  })
  if ($unexpected.Count -gt 0) {
    throw "Unexpected provider resource in ${Directory}: $($unexpected.address -join ', ')"
  }
}

function Get-ImageDigest([string]$TaggedImage) {
  $inspection = docker buildx imagetools inspect $TaggedImage
  Assert-NativeSuccess "Inspect image $TaggedImage"
  $match = [regex]::Match(($inspection -join "`n"), 'Digest:\s+(sha256:[a-f0-9]{64})')
  if (-not $match.Success) {
    throw "Could not resolve an immutable digest for $TaggedImage"
  }
  return $match.Groups[1].Value
}

$activeAccounts = @(gcloud auth list --filter="status:ACTIVE" --format="value(account)")
Assert-NativeSuccess "Read active gcloud account"
if ($activeAccounts -notcontains $expectedAccount) {
  throw "Expected active gcloud account $expectedAccount; found $($activeAccounts -join ', ')"
}

$projectNumber = (gcloud projects describe $vigilProject --format="value(projectNumber)").Trim()
Assert-NativeSuccess "Read target GCP project"
gcloud auth application-default set-quota-project $vigilProject --quiet
Assert-NativeSuccess "Set the Application Default Credentials quota project"
Write-Host "Deploying Vigil only to $vigilProject ($projectNumber), $vigilRegion."

terraform "-chdir=infra/bootstrap" init "-input=false"
Assert-NativeSuccess "Initialize bootstrap"
terraform "-chdir=infra/bootstrap" plan "-input=false" "-out=bootstrap.tfplan"
Assert-NativeSuccess "Plan bootstrap"
Assert-SafePlan "infra/bootstrap" "bootstrap.tfplan"
terraform "-chdir=infra/bootstrap" apply "-input=false" -auto-approve bootstrap.tfplan
Assert-NativeSuccess "Apply bootstrap"

$stateBucket = (terraform "-chdir=infra/bootstrap" output -raw state_bucket).Trim()
Assert-NativeSuccess "Read state bucket"

if (-not $SkipFoundation) {
  terraform "-chdir=infra/foundation" init "-input=false" -reconfigure "-backend-config=bucket=$stateBucket" "-backend-config=prefix=foundation/demo"
  Assert-NativeSuccess "Initialize foundation"
  terraform "-chdir=infra/foundation" plan "-input=false" "-out=foundation.tfplan"
  Assert-NativeSuccess "Plan foundation"
  Assert-SafePlan "infra/foundation" "foundation.tfplan"
  terraform "-chdir=infra/foundation" apply "-input=false" -auto-approve foundation.tfplan
  Assert-NativeSuccess "Apply foundation"
}

terraform "-chdir=infra/foundation" init "-input=false" -reconfigure "-backend-config=bucket=$stateBucket" "-backend-config=prefix=foundation/demo"
Assert-NativeSuccess "Open foundation state"
$imageRepository = (terraform "-chdir=infra/foundation" output -raw artifact_registry_repository).Trim()
$recordingsBucket = (terraform "-chdir=infra/foundation" output -raw recordings_bucket).Trim()
$sqlConnection = (terraform "-chdir=infra/foundation" output -raw sql_instance_connection_name).Trim()
$serviceAccounts = terraform "-chdir=infra/foundation" output -json service_accounts | ConvertFrom-Json
Assert-NativeSuccess "Read foundation outputs"

if (-not $SkipImages) {
  gcloud auth configure-docker "$vigilRegion-docker.pkg.dev" --quiet
  Assert-NativeSuccess "Configure Artifact Registry Docker authentication"
  $revision = (git rev-parse --short=12 HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $revision) { $revision = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString() }
  $nodeTag = "$imageRepository/node:$revision"
  $goTag = "$imageRepository/go:$revision"
  $sourceTag = "$imageRepository/synthetic-hls:$revision"
  docker buildx build --platform linux/amd64 --file deploy/images/node/Dockerfile --tag $nodeTag --push .
  Assert-NativeSuccess "Build Node image"
  docker buildx build --platform linux/amd64 --file deploy/images/go/Dockerfile --tag $goTag --push .
  Assert-NativeSuccess "Build Go image"
  docker buildx build --platform linux/amd64 --file deploy/images/synthetic-hls/Dockerfile --tag $sourceTag --push .
  Assert-NativeSuccess "Build synthetic HLS image"
  $nodeImage = "$imageRepository/node@$(Get-ImageDigest $nodeTag)"
  $goImage = "$imageRepository/go@$(Get-ImageDigest $goTag)"
  $sourceImage = "$imageRepository/synthetic-hls@$(Get-ImageDigest $sourceTag)"
} else {
  if (-not $env:VIGIL_NODE_IMAGE -or -not $env:VIGIL_GO_IMAGE -or -not $env:VIGIL_SYNTHETIC_IMAGE) {
    throw "-SkipImages requires VIGIL_NODE_IMAGE, VIGIL_GO_IMAGE, and VIGIL_SYNTHETIC_IMAGE digests"
  }
  $nodeImage = $env:VIGIL_NODE_IMAGE
  $goImage = $env:VIGIL_GO_IMAGE
  $sourceImage = $env:VIGIL_SYNTHETIC_IMAGE
}

$kafkaBrokers = (gcloud managed-kafka clusters describe vigil-events --project $vigilProject --location $vigilRegion --format="value(bootstrapAddress)").Trim()
Assert-NativeSuccess "Read Managed Kafka bootstrap address"
$env:TF_VAR_state_bucket = $stateBucket
$env:TF_VAR_node_image = $nodeImage
$env:TF_VAR_kafka_brokers = $kafkaBrokers
terraform "-chdir=infra/platform" init "-input=false" -reconfigure "-backend-config=bucket=$stateBucket" "-backend-config=prefix=platform/demo"
Assert-NativeSuccess "Initialize platform"
terraform "-chdir=infra/platform" plan "-input=false" "-out=platform.tfplan"
Assert-NativeSuccess "Plan platform"
Assert-SafePlan "infra/platform" "platform.tfplan"
terraform "-chdir=infra/platform" apply "-input=false" -auto-approve platform.tfplan
Assert-NativeSuccess "Apply platform"

$apiUrl = (terraform "-chdir=infra/platform" output -raw api_url).Trim()
$leaseUrl = (terraform "-chdir=infra/platform" output -raw lease_url).Trim()
$leaseEndpoint = (terraform "-chdir=infra/platform" output -raw lease_endpoint).Trim()

gcloud container clusters get-credentials vigil-autopilot --project $vigilProject --region $vigilRegion
Assert-NativeSuccess "Get GKE credentials"
$env:VIGIL_NODE_IMAGE = $nodeImage
$env:VIGIL_GO_IMAGE = $goImage
$env:VIGIL_SYNTHETIC_IMAGE = $sourceImage
$env:VIGIL_KAFKA_BROKERS = $kafkaBrokers
$env:VIGIL_LEASE_ENDPOINT = $leaseEndpoint
$env:VIGIL_LEASE_AUDIENCE = $leaseUrl
$env:VIGIL_STORAGE_BUCKET = $recordingsBucket
$env:VIGIL_SQL_CONNECTION_NAME = $sqlConnection
$env:VIGIL_PROJECT_NUMBER = $projectNumber
$env:VIGIL_WORKER_SERVICE_ACCOUNT = $serviceAccounts.worker
$env:VIGIL_SCHEDULER_SERVICE_ACCOUNT = $serviceAccounts.scheduler
$env:VIGIL_RECORDER_SERVICE_ACCOUNT = $serviceAccounts.recorder
node scripts/deploy-kubernetes.mjs
Assert-NativeSuccess "Apply Kubernetes workloads"
kubectl rollout status deployment/vigil-synthetic-hls -n vigil --timeout=10m
Assert-NativeSuccess "Wait for synthetic HLS"
kubectl rollout status deployment/vigil-backend-worker -n vigil --timeout=10m
Assert-NativeSuccess "Wait for backend worker"
kubectl rollout status deployment/vigil-scheduler -n vigil --timeout=10m
Assert-NativeSuccess "Wait for scheduler"

$repoExists = gh repo view fullstack-nick/vigil --json nameWithOwner 2>$null
if ($LASTEXITCODE -eq 0) {
  $provider = (terraform "-chdir=infra/bootstrap" output -raw github_workload_identity_provider).Trim()
  $deployAccount = (terraform "-chdir=infra/bootstrap" output -raw github_service_account).Trim()
  gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo fullstack-nick/vigil --body $provider
  Assert-NativeSuccess "Set GitHub WIF provider variable"
  gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --repo fullstack-nick/vigil --body $deployAccount
  Assert-NativeSuccess "Set GitHub deploy account variable"
}

if (-not $SkipSmoke) {
  $env:VIGIL_API_URL = $apiUrl
  $env:VIGIL_PROJECT_ID = $vigilProject
  $env:VIGIL_REGION = $vigilRegion
  node scripts/cloud-smoke.mjs
  Assert-NativeSuccess "Run cloud smoke"
}

Write-Host "Vigil deployment complete: $apiUrl"
Write-Host "Owner credential remains in Secret Manager secret vigil-operator-credential."

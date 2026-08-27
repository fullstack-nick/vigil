$ErrorActionPreference = "Stop"

$goRoot = Join-Path $PSScriptRoot "..\go"
$unformatted = & gofmt -l (Get-ChildItem -Path $goRoot -Recurse -Filter "*.go" | ForEach-Object FullName)
if ($unformatted) {
  Write-Error "gofmt is required for:`n$($unformatted -join "`n")"
}

Push-Location $goRoot
try {
  & go test ./...
  if ($LASTEXITCODE -ne 0) { throw "go test failed" }
  & go build ./...
  if ($LASTEXITCODE -ne 0) { throw "go build failed" }
} finally {
  Pop-Location
}


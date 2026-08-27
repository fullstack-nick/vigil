# API examples

Set the deployed base URL without a trailing slash:

```powershell
$vigilUrl = "https://example.run.app"
```

Public reads need no credential:

```powershell
Invoke-RestMethod "$vigilUrl/api/public/summary"
Invoke-RestMethod "$vigilUrl/api/public/recordings?limit=10"
```

For mutations, create a web session. Keep the credential out of shell history in real use; this interactive example reads it securely:

```powershell
$ownerCredential = Read-Host "Vigil owner credential" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ownerCredential)
try { $plainCredential = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$login = Invoke-RestMethod "$vigilUrl/api/operator/session" `
  -Method Post -WebSession $session -ContentType "application/json" `
  -Body (@{ credential = $plainCredential } | ConvertTo-Json)
$plainCredential = $null
$headers = @{ "x-csrf-token" = $login.csrf; origin = $vigilUrl }
```

Grant synthetic creator consent and request a 20-second public demo:

```powershell
$creatorId = "00000000-0000-4000-8000-000000000001"
Invoke-RestMethod "$vigilUrl/api/creators/$creatorId/consent" `
  -Method Put -WebSession $session -Headers $headers -ContentType "application/json" `
  -Body '{"granted":true,"evidence":"Owner-approved portfolio demonstration"}'

$headers["idempotency-key"] = [guid]::NewGuid().ToString()
$recording = Invoke-RestMethod "$vigilUrl/api/recordings" `
  -Method Post -WebSession $session -Headers $headers -ContentType "application/json" `
  -Body '{"maxDurationSeconds":20,"publicDemo":true}'
```

Reuse of that idempotency key with the same body returns the original recording. Reuse with a different body returns `409 IDEMPOTENCY_CONFLICT`.

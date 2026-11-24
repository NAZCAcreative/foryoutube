param([int]$Port = 4001)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$studioUrl = "http://127.0.0.1:$Port"
try {
  $runningStudio = Invoke-RestMethod -Uri "$studioUrl/api/config" -TimeoutSec 2
  if ($null -ne $runningStudio.PSObject.Properties['speech'] -and $null -ne $runningStudio.PSObject.Properties['demo']) {
    Write-Output $studioUrl
    exit 0
  }
} catch {
  # The normal launch path starts when the port is free.
}
$studioPython = if (Test-Path -LiteralPath '.venv/Scripts/python.exe') { (Resolve-Path '.venv/Scripts/python.exe').Path } else { (Get-Command python.exe).Source }
& $studioPython -X utf8 -m uvicorn cutroom.server:app --host 127.0.0.1 --port $Port
exit $LASTEXITCODE

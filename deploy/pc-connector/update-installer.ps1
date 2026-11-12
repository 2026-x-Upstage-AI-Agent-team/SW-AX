param([Parameter(Mandatory)][string]$Key,[Parameter(Mandatory)][string]$Sha256,
      [Parameter(Mandatory)][string]$PreviousSha256,[Parameter(Mandatory)][ValidatePattern('^pc-[0-9-]+-installer$')][string]$Tag)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Import-Module AWSPowerShell
$cfg=Get-Content -Raw C:\swax\config\deployment.json | ConvertFrom-Json
if ($cfg.deployment_id -ne 'd1110a' -or $cfg.api_environment.AWARDS_PC_ENABLED -ne 'true') { throw 'Unexpected deployment mode' }
$installer='C:\swax\current\pc\SWAX-PC-Setup.exe'
if ((Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $PreviousSha256) { throw 'Installer changed; inspect before updating' }
$download=Join-Path C:\swax\downloads ($Tag+'.exe')
$backup=Join-Path C:\swax\backups ($Tag+'.exe')
if ((Test-Path -LiteralPath $download) -or (Test-Path -LiteralPath $backup)) { throw 'Update path exists; inspect before overwriting' }
Read-S3Object -BucketName 'swax-demo-d1110a-artifacts-416775509196' -Key $Key -File $download -Region ap-northeast-2 | Out-Null
if ((Get-FileHash $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) { throw 'Installer hash mismatch' }
# Atomic publication: downloads see either the complete old EXE or the complete new EXE.
[IO.File]::Replace($download,$installer,$backup)
[pscustomobject]@{updated=$true;installer_sha256=(Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant();api_restarted=$false} | ConvertTo-Json

param([Parameter(Mandatory)][string]$Key,[Parameter(Mandatory)][string]$Sha256,
      [Parameter(Mandatory)][string]$PreviousSha256,[Parameter(Mandatory)][ValidatePattern('^pc-[0-9-]+-retry$')][string]$Tag)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Import-Module AWSPowerShell
$cfg=Get-Content -Raw C:\swax\config\deployment.json | ConvertFrom-Json
if ($cfg.deployment_id -ne 'd1110a' -or $cfg.api_environment.AWARDS_PC_ENABLED -ne 'true') { throw 'Unexpected deployment mode' }
$jar='C:\swax\current\app\swax-intake.jar'
if ((Get-FileHash $jar -Algorithm SHA256).Hash.ToLowerInvariant() -ne $PreviousSha256) { throw 'Current JAR changed; inspect before updating' }
$download=Join-Path C:\swax\downloads ($Tag+'.jar')
$backup=Join-Path C:\swax\backups ($Tag+'.jar')
if ((Test-Path -LiteralPath $download) -or (Test-Path -LiteralPath $backup)) { throw 'Update path exists; inspect before overwriting' }
Read-S3Object -BucketName 'swax-demo-d1110a-artifacts-416775509196' -Key $Key -File $download -Region ap-northeast-2 | Out-Null
if ((Get-FileHash $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) { throw 'Update hash mismatch' }
Copy-Item -LiteralPath $jar -Destination $backup
function Stop-Api {
    Stop-ScheduledTask SWAX-API
    Start-Sleep -Seconds 2
    $apiId=[int](Get-Content C:\swax\logs\api.pid)
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$apiId)
    if ($process) {
        if ($process.Name -ne 'java.exe' -or $process.CommandLine -notlike '*C:\swax\current\app\swax-intake.jar*') { throw 'API PID identity changed' }
        Stop-Process -Id $apiId -Force
    }
}
try {
    Stop-Api
    Copy-Item -LiteralPath $download -Destination $jar -Force
    Start-ScheduledTask SWAX-API
    $deadline=(Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 3
        try { $health=Invoke-RestMethod http://127.0.0.1:18765/actuator/health -TimeoutSec 5 } catch { $health=$null }
        if ((Get-Date) -gt $deadline) { throw 'API health timeout' }
    } while ($health.status -ne 'UP')
    [pscustomobject]@{updated=$true;health=$health.status;jar_sha256=(Get-FileHash $jar -Algorithm SHA256).Hash.ToLowerInvariant();only_pc_tasks_changed=$true} | ConvertTo-Json
} catch {
    $failure=$_.Exception.Message
    Stop-Api
    Copy-Item -LiteralPath $backup -Destination $jar -Force
    Start-ScheduledTask SWAX-API
    throw ('Update failed; prior JAR restored: '+$failure)
}

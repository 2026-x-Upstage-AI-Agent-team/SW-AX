param([Parameter(Mandatory)][string]$BundleKey,[Parameter(Mandatory)][string]$BundleSha256,
      [Parameter(Mandatory)][ValidatePattern('^pc-[0-9-]+$')][string]$PatchId)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Import-Module AWSPowerShell
Add-Type -AssemblyName System.IO.Compression.FileSystem
if ((Get-Content -Raw C:\swax\config\deployment.json | ConvertFrom-Json).deployment_id -ne 'd1110a') { throw 'Wrong deployment' }
$token=Invoke-RestMethod -Method Put -Uri 'http://169.254.169.254/latest/api/token' -Headers @{'X-aws-ec2-metadata-token-ttl-seconds'='60'}
$type=Invoke-RestMethod -Uri 'http://169.254.169.254/latest/meta-data/instance-type' -Headers @{'X-aws-ec2-metadata-token'=$token}
if ($type -ne 't3.medium') { throw 'Expected the existing t3.medium instance' }
if (Get-ScheduledTask SWAX-prepare -ErrorAction SilentlyContinue) { throw 'Preparation task exists; inspect before replacing' }
$createdPrepare=$false
$work=[IO.Path]::GetFullPath((Join-Path 'C:\swax\downloads' $PatchId))
$backup=[IO.Path]::GetFullPath((Join-Path 'C:\swax\backups' $PatchId))
if (!$work.StartsWith('C:\swax\downloads\') -or !$backup.StartsWith('C:\swax\backups\')) { throw 'Invalid patch path' }
if ((Test-Path -LiteralPath $work) -or (Test-Path -LiteralPath $backup)) { throw 'Patch folder exists; inspect before retrying' }
New-Item -ItemType Directory -Path $work,$backup | Out-Null
$zip=Join-Path $work 'bundle.zip'
Read-S3Object -BucketName 'swax-demo-d1110a-artifacts-416775509196' -Key $BundleKey -File $zip -Region ap-northeast-2 | Out-Null
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $BundleSha256) { throw 'Bundle hash mismatch' }
$archive=[IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach ($entry in $archive.Entries) {
        $target=[IO.Path]::GetFullPath((Join-Path $work $entry.FullName))
        if (!$target.StartsWith($work+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escape' }
    }
} finally { $archive.Dispose() }
Expand-Archive -LiteralPath $zip -DestinationPath $work
$manifest=Get-Content -Raw (Join-Path $work 'manifest.json') | ConvertFrom-Json
foreach ($file in $manifest.files.PSObject.Properties) {
    $source=Join-Path $work $file.Name
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.Value.sha256) { throw 'Payload hash mismatch' }
}
$jar='C:\swax\current\app\swax-intake.jar'
$prep='C:\swax\current\worker\operations\preparation.py'
$aux='C:\swax\current\bin\run-auxiliary.ps1'
foreach ($pair in @(@($jar,$manifest.base_jar_sha256),@($prep,$manifest.previous_preparation_sha256),@($aux,$manifest.previous_aux_sha256))) {
    if ((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pair[1]) { throw ('Baseline changed: '+$pair[0]) }
}
Copy-Item -LiteralPath $jar -Destination (Join-Path $backup 'api.jar')
Copy-Item -LiteralPath $prep -Destination (Join-Path $backup 'preparation.py')
Copy-Item -LiteralPath $aux -Destination (Join-Path $backup 'run-auxiliary.ps1')
Copy-Item -LiteralPath C:\swax\config\deployment.json -Destination (Join-Path $backup 'deployment.json')
function Stop-Api {
    Stop-ScheduledTask -TaskName SWAX-API
    $limit=(Get-Date).AddSeconds(15)
    while ((Get-ScheduledTask SWAX-API).State -eq 'Running') {
        if ((Get-Date) -gt $limit) { throw 'API task stop timeout' }
        Start-Sleep -Milliseconds 200
    }
    $apiId=[int](Get-Content C:\swax\logs\api.pid)
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$apiId)
    if ($process) {
        if ($process.Name -ne 'java.exe' -or $process.CommandLine -notlike '*C:\swax\current\app\swax-intake.jar*') { throw 'API PID identity changed' }
        Stop-Process -Id $apiId -Force
    }
}
try {
    Stop-Api
    Copy-Item -LiteralPath (Join-Path $work 'app\swax-intake.jar') -Destination $jar -Force
    Copy-Item -LiteralPath (Join-Path $work 'worker\preparation.py') -Destination $prep -Force
    Copy-Item -LiteralPath (Join-Path $work 'bin\run-auxiliary.ps1') -Destination $aux -Force
    $pc='C:\swax\current\pc'
    New-Item -ItemType Directory -Path $pc -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $work 'pc\SWAX-PC-Setup.exe') -Destination (Join-Path $pc 'SWAX-PC-Setup.exe') -Force
    $cfg=Get-Content -Raw C:\swax\config\deployment.json | ConvertFrom-Json
    $cfg.api_environment | Add-Member -NotePropertyName AWARDS_PC_ENABLED -NotePropertyValue 'true' -Force
    $cfg.api_environment | Add-Member -NotePropertyName AWARDS_PC_INSTALLER -NotePropertyValue (Join-Path $pc 'SWAX-PC-Setup.exe') -Force
    $cfg | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 C:\swax\config\deployment.json
    Start-ScheduledTask SWAX-API
    $limit=(Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 3
        try { $health=Invoke-RestMethod http://127.0.0.1:18765/actuator/health -TimeoutSec 5 } catch { $health=$null }
        if ((Get-Date) -gt $limit) { throw 'Updated API did not become healthy' }
    } while ($health.status -ne 'UP')
    $template=Get-ScheduledTask SWAX-studio
    $action=New-ScheduledTaskAction -Execute $template.Actions[0].Execute -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\swax\current\bin\run-auxiliary.ps1" -Role prepare' -WorkingDirectory 'C:\swax'
    Register-ScheduledTask -TaskName SWAX-prepare -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $template.Principal -Settings $template.Settings | Out-Null
    $createdPrepare=$true
    Start-ScheduledTask SWAX-prepare
    [pscustomobject]@{deployed=$true;patch=$PatchId;instance_type=$type;api_health=$health.status;
        jar_sha256=(Get-FileHash $jar -Algorithm SHA256).Hash.ToLowerInvariant();
        installer_sha256=(Get-FileHash (Join-Path $pc 'SWAX-PC-Setup.exe') -Algorithm SHA256).Hash.ToLowerInvariant();
        backup=$backup;tasks=@(Get-ScheduledTask -TaskName 'SWAX-*' | Select-Object TaskName,State)} | ConvertTo-Json -Depth 5
} catch {
    $failure=$_.Exception.Message
    if ($createdPrepare) {
        Stop-ScheduledTask SWAX-prepare -ErrorAction SilentlyContinue
        Unregister-ScheduledTask SWAX-prepare -Confirm:$false
    }
    Stop-Api
    Copy-Item -LiteralPath (Join-Path $backup 'api.jar') -Destination $jar -Force
    Copy-Item -LiteralPath (Join-Path $backup 'preparation.py') -Destination $prep -Force
    Copy-Item -LiteralPath (Join-Path $backup 'run-auxiliary.ps1') -Destination $aux -Force
    Copy-Item -LiteralPath (Join-Path $backup 'deployment.json') -Destination C:\swax\config\deployment.json -Force
    Start-ScheduledTask SWAX-API
    throw ('PC connector deployment failed; previous files restored: '+$failure)
}

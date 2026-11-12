param([Parameter(Mandatory)][string]$BundleKey,[Parameter(Mandatory)][string]$BundleSha256,
      [Parameter(Mandatory)][ValidatePattern('^pc-parallel-[0-9-]+$')][string]$PatchId)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Import-Module AWSPowerShell
$cfg=Get-Content -Raw C:\swax\config\deployment.json | ConvertFrom-Json
if($cfg.deployment_id -ne 'd1110a' -or $cfg.api_environment.AWARDS_PC_ENABLED -ne 'true'){throw 'Unexpected deployment'}
$token=Invoke-RestMethod -Method Put -Uri 'http://169.254.169.254/latest/api/token' -Headers @{'X-aws-ec2-metadata-token-ttl-seconds'='60'}
$type=Invoke-RestMethod -Uri 'http://169.254.169.254/latest/meta-data/instance-type' -Headers @{'X-aws-ec2-metadata-token'=$token}
if($type -ne 't3.medium'){throw 'Expected the existing t3.medium'}
$work=Join-Path 'C:\swax\downloads' $PatchId
$backup=Join-Path 'C:\swax\backups' $PatchId
if((Test-Path -LiteralPath $work) -or (Test-Path -LiteralPath $backup)){throw 'Patch folder exists; inspect before retrying'}
New-Item -ItemType Directory -Path $work,$backup | Out-Null
$zip=Join-Path $work 'bundle.zip'
Read-S3Object -BucketName 'swax-demo-d1110a-artifacts-416775509196' -Key $BundleKey -File $zip -Region ap-northeast-2 | Out-Null
if((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $BundleSha256){throw 'Bundle hash mismatch'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach($entry in $archive.Entries){
        $target=[IO.Path]::GetFullPath((Join-Path $work $entry.FullName))
        if(!$target.StartsWith($work+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Archive path escape'}
    }
} finally {$archive.Dispose()}
Expand-Archive -LiteralPath $zip -DestinationPath $work
$manifest=Get-Content -Raw (Join-Path $work 'manifest.json') | ConvertFrom-Json
foreach($file in $manifest.files.PSObject.Properties){
    if((Get-FileHash -LiteralPath (Join-Path $work $file.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.Value.sha256){throw 'Payload hash mismatch'}
}
$jar='C:\swax\current\app\swax-intake.jar'
$installer='C:\swax\current\pc\SWAX-PC-Setup.exe'
if((Get-FileHash $jar -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.base_jar_sha256){throw 'Current JAR changed'}
if((Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.previous_installer_sha256){throw 'Current installer changed'}
$credential=(Get-SECSecretValue -SecretId $cfg.secrets.worker_db -Region ap-northeast-2).SecretString | ConvertFrom-Json
$env:PC_PARALLEL_DB=$cfg.database.jdbc_url
$env:PC_PARALLEL_USER=$credential.username
$env:PC_PARALLEL_PASSWORD=$credential.password
$probe=@'
import os,psycopg
with psycopg.connect(os.environ['PC_PARALLEL_DB'].removeprefix('jdbc:'),user=os.environ['PC_PARALLEL_USER'],password=os.environ['PC_PARALLEL_PASSWORD'],connect_timeout=5,options='-c default_transaction_read_only=on -c statement_timeout=5000') as db:
    active=db.execute("SELECT count(*) FROM pc_file_conversion WHERE state='running' AND lease_until>clock_timestamp()").fetchone()[0]
    reports=db.execute("SELECT count(*) FROM award_report WHERE state IN ('queued','building','printing','verifying')").fetchone()[0]
    studio=db.execute('SELECT count(*) FROM studio_execution WHERE occupies_slot').fetchone()[0]
    if active or reports or studio:raise SystemExit('Active work; no API restart attempted')
'@
try {
    $probe | & C:\swax\venv\Scripts\python.exe -
    if($LASTEXITCODE -ne 0){throw 'Pre-deployment check failed'}
} finally {Remove-Item env:PC_PARALLEL_DB,env:PC_PARALLEL_USER,env:PC_PARALLEL_PASSWORD}
Copy-Item -LiteralPath $jar -Destination (Join-Path $backup 'original-api.jar')
Copy-Item -LiteralPath $installer -Destination (Join-Path $backup 'SWAX-PC-Setup.exe')
function Stop-Api {
    Stop-ScheduledTask SWAX-API
    Start-Sleep -Seconds 2
    $apiId=[int](Get-Content C:\swax\logs\api.pid)
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$apiId)
    if($process){
        if($process.Name -ne 'java.exe' -or $process.CommandLine -notlike '*C:\swax\current\app\swax-intake.jar*'){throw 'API PID identity changed'}
        Stop-Process -Id $apiId -Force
    }
}
try {
    Stop-Api
    Copy-Item -LiteralPath (Join-Path $work 'swax-intake.jar') -Destination $jar -Force
    Copy-Item -LiteralPath (Join-Path $work 'SWAX-PC-Setup.exe') -Destination $installer -Force
    Start-ScheduledTask SWAX-API
    $deadline=(Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 3
        try {$health=Invoke-RestMethod http://127.0.0.1:18765/actuator/health -TimeoutSec 5} catch {$health=$null}
        if((Get-Date) -gt $deadline){throw 'API health timeout'}
    } while($health.status -ne 'UP')
} catch {
    $failure=$_.Exception.Message
    Stop-Api
    # Retain V7 in rollback so Flyway can validate a migration already committed by the update.
    Copy-Item -LiteralPath (Join-Path $work 'rollback.jar') -Destination $jar -Force
    Copy-Item -LiteralPath (Join-Path $backup 'SWAX-PC-Setup.exe') -Destination $installer -Force
    Start-ScheduledTask SWAX-API
    throw ('Update failed; migration-compatible prior API and installer restored: '+$failure)
}
[pscustomobject]@{deployed=$true;health=$health.status;instance_type=$type;
    jar_sha256=(Get-FileHash $jar -Algorithm SHA256).Hash.ToLowerInvariant();
    installer_sha256=(Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant();
    installer_version=$manifest.installer_version;backup=$backup} | ConvertTo-Json

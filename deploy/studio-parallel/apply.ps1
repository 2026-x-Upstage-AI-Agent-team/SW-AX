param([Parameter(Mandatory)][string]$BundleKey,[Parameter(Mandatory)][string]$BundleSha256,
      [Parameter(Mandatory)][ValidatePattern('^studio-parallel-[0-9-]+$')][string]$PatchId)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Import-Module AWSPowerShell
$cfg=Get-Content -Raw C:\swax\config\deployment.json | ConvertFrom-Json
if($cfg.deployment_id -ne 'd1110a' -or $cfg.api_environment.AWARDS_PC_ENABLED -ne 'true'){throw 'Unexpected deployment'}
$metaToken=Invoke-RestMethod -Method Put -Uri 'http://169.254.169.254/latest/api/token' -Headers @{'X-aws-ec2-metadata-token-ttl-seconds'='60'}
$instanceType=Invoke-RestMethod -Uri 'http://169.254.169.254/latest/meta-data/instance-type' -Headers @{'X-aws-ec2-metadata-token'=$metaToken}
if($instanceType -ne 't3.medium'){throw 'Expected the existing t3.medium'}
$work=Join-Path 'C:\swax\downloads' $PatchId
$backup=Join-Path 'C:\swax\backups' $PatchId
if((Test-Path -LiteralPath $work) -or (Test-Path -LiteralPath $backup)){throw 'Patch path already exists'}
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
$jar='C:\swax\current\app\swax-intake.jar'
$worker='C:\swax\current\worker\operations\studio_worker.py'
foreach($pair in @(@($jar,$manifest.base_jar_sha256),@($worker,$manifest.previous_worker_sha256),
    @((Join-Path $work 'swax-intake.jar'),$manifest.jar_sha256),@((Join-Path $work 'studio_worker.py'),$manifest.worker_sha256))){
    if((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pair[1]){throw ('Baseline/payload mismatch: '+$pair[0])}
}
$credential=(Get-SECSecretValue -SecretId $cfg.secrets.worker_db -Region ap-northeast-2).SecretString | ConvertFrom-Json
$env:PARALLEL_DB=$cfg.database.jdbc_url
$env:PARALLEL_USER=$credential.username
$env:PARALLEL_PASSWORD=$credential.password
function Check-Database([switch]$Updated){
    $env:PARALLEL_UPDATED=$Updated.IsPresent.ToString()
    $probe=@'
import os,psycopg
with psycopg.connect(os.environ['PARALLEL_DB'].removeprefix('jdbc:'),user=os.environ['PARALLEL_USER'],password=os.environ['PARALLEL_PASSWORD'],connect_timeout=5,options='-c default_transaction_read_only=on -c statement_timeout=5000') as db:
    if os.environ['PARALLEL_UPDATED']=='True':
        assert db.execute("SELECT to_regclass('studio_one_remote') IS NULL").fetchone()[0]
        assert db.execute("SELECT count(*) FROM information_schema.columns WHERE table_name='studio_execution' AND column_name='last_http_status'").fetchone()[0]==1
    else:
        studio=db.execute("SELECT count(*) FROM review_job_status WHERE state IN ('queued','running')").fetchone()[0]
        occupied=db.execute('SELECT count(*) FROM studio_execution WHERE occupies_slot').fetchone()[0]
        pc=db.execute("SELECT count(*) FROM pc_file_conversion WHERE state='running' AND lease_until>clock_timestamp()").fetchone()[0]
        report=db.execute("SELECT count(*) FROM award_report WHERE state IN ('queued','building','printing','verifying')").fetchone()[0]
        if studio or occupied or pc or report:raise SystemExit('Active work; no deployment attempted')
'@
    $probe | & C:\swax\venv\Scripts\python.exe -
    if($LASTEXITCODE -ne 0){throw 'Database check failed'}
}
function Stop-Studio {
    Stop-ScheduledTask SWAX-studio
    Start-Sleep -Seconds 2
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object {
        $_.CommandLine -like '*C:\swax\venv\Scripts\python.exe*' -and
        $_.CommandLine -match 'operations\.worker\s+--role\s+studio(?:\s|$)'
    } | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop}
}
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
    Check-Database
    Copy-Item -LiteralPath $jar -Destination (Join-Path $backup 'swax-intake.jar')
    Copy-Item -LiteralPath $worker -Destination (Join-Path $backup 'studio_worker.py')
    Stop-Studio
    try {
        Check-Database
        Stop-Api
        Copy-Item -LiteralPath (Join-Path $work 'swax-intake.jar') -Destination $jar -Force
        Copy-Item -LiteralPath (Join-Path $work 'studio_worker.py') -Destination $worker -Force
        Start-ScheduledTask SWAX-API
        $deadline=(Get-Date).AddMinutes(3)
        do {
            Start-Sleep -Seconds 3
            try {$health=Invoke-RestMethod http://127.0.0.1:18765/actuator/health -TimeoutSec 5} catch {$health=$null}
            if((Get-Date) -gt $deadline){throw 'API health timeout'}
        } while($health.status -ne 'UP')
        Check-Database -Updated
    } catch {
        $failure=$_.Exception.Message
        Stop-Api
        Copy-Item -LiteralPath (Join-Path $backup 'swax-intake.jar') -Destination $jar -Force
        Copy-Item -LiteralPath (Join-Path $backup 'studio_worker.py') -Destination $worker -Force
        Start-ScheduledTask SWAX-API
        throw ('Deployment failed; previous files restored: '+$failure)
    } finally {Start-ScheduledTask SWAX-studio}
} finally {Remove-Item env:PARALLEL_DB,env:PARALLEL_USER,env:PARALLEL_PASSWORD,env:PARALLEL_UPDATED -ErrorAction SilentlyContinue}
[pscustomobject]@{deployed=$true;instance_type=$instanceType;api_health=$health.status;
    jar_sha256=(Get-FileHash $jar -Algorithm SHA256).Hash.ToLowerInvariant();
    worker_sha256=(Get-FileHash $worker -Algorithm SHA256).Hash.ToLowerInvariant();backup=$backup} | ConvertTo-Json

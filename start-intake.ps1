#Requires -Version 7.2
[CmdletBinding()]
param([switch]$DatabaseOnly, [switch]$ApiOnly, [switch]$RemotePrinter)

$ErrorActionPreference = 'Stop'
$children = @()
$originalJavaOptions = $env:JDK_JAVA_OPTIONS
function Set-WorkerKey([string]$Name, [string]$File) {
    if ([Environment]::GetEnvironmentVariable($Name)) { return }
    $path = Join-Path $env:AWARD_DATA_DIR $File
    if (-not (Test-Path -LiteralPath $path)) {
        $stream = [IO.File]::Open($path, 'CreateNew', 'Write', 'None')
        try { $stream.Write([Text.Encoding]::ASCII.GetBytes([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))) }
        finally { $stream.Dispose() }
    }
    [Environment]::SetEnvironmentVariable($Name, [IO.File]::ReadAllText($path).Trim())
}
Push-Location -LiteralPath $PSScriptRoot
try {
    if (-not $env:AWARD_DATA_DIR) { $env:AWARD_DATA_DIR = Join-Path $PSScriptRoot 'var' }
    if (-not $env:AWARDS_DB_PASSWORD) {
        $dataDir = New-Item -ItemType Directory -Path $env:AWARD_DATA_DIR -Force
        $keyFile = Join-Path $dataDir.FullName 'intake-postgres.key'
        if (-not (Test-Path -LiteralPath $keyFile)) {
            $key = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
            $stream = [IO.File]::Open($keyFile, 'CreateNew', 'Write', 'None')
            try { $stream.Write([Text.Encoding]::ASCII.GetBytes($key)) } finally { $stream.Dispose() }
        }
        $env:AWARDS_DB_PASSWORD = [IO.File]::ReadAllText($keyFile).Trim()
    }

    if (-not $env:AWARDS_DB_URL) {
        & docker compose -f compose.yaml up -d --wait
        if ($LASTEXITCODE -ne 0) { throw '접수용 PostgreSQL을 시작하지 못했습니다. Docker Desktop 상태를 확인하세요.' }
    }
    if ($DatabaseOnly) { return }

    # Gradle writes Windows Java argument files in the local code page, including checkout paths.
    if ($env:JDK_JAVA_OPTIONS -notmatch '(?:^|\s)-Dfile\.encoding=') {
        $env:JDK_JAVA_OPTIONS = ("$originalJavaOptions -Dfile.encoding=COMPAT").Trim()
    }
    $installedJdk = Join-Path $env:ProgramFiles 'Java/jdk-21'
    if (-not $env:JAVA_HOME -and (Test-Path -LiteralPath "$installedJdk/bin/javac.exe")) {
        $env:JAVA_HOME = $installedJdk
    }
    $null = New-Item -ItemType Directory -Force -Path $env:AWARD_DATA_DIR
    Set-WorkerKey 'AWARDS_REVIEW_WORKER_TOKEN' 'review-worker.key'
    Set-WorkerKey 'AWARDS_OUTPUT_WORKER_TOKEN' 'output-worker.key'
    $python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
    if (-not $ApiOnly) {
        if (-not (Test-Path -LiteralPath $python)) { throw '프로젝트 가상환경에 operations/requirements.txt를 설치하세요.' }
        & $python -c 'import psycopg, pypdf, pypdfium2, lxml, httpx'
        if ($LASTEXITCODE -ne 0) { throw 'operations/requirements.txt 의존성을 설치하세요.' }
    }
    Set-Location -LiteralPath (Join-Path $PSScriptRoot 'backend')
    if (-not $ApiOnly) {
        & (Join-Path $PSScriptRoot 'operations/hancom/setup.ps1') -Python $python
        & ./gradlew.bat --console=plain prepareReportConverter
        if ($LASTEXITCODE -ne 0) { throw 'HWP 변환 라이브러리를 준비하지 못했습니다.' }
        $children += Start-Process -FilePath $python -ArgumentList '-m','operations.worker' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
        if (-not $RemotePrinter) {
            if (-not $env:AWARDS_API_URL) { $env:AWARDS_API_URL = 'http://127.0.0.1:' + ($env:AWARDS_PORT ?? '18765') }
            $children += Start-Process -FilePath $python -ArgumentList '-m','operations.printer' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
        }
    }
    & ./gradlew.bat --console=plain bootRun
    if ($LASTEXITCODE -ne 0) { throw '접수 서비스를 시작하지 못했습니다. 위 빌드·실행 메시지를 확인하세요.' }
} finally {
    foreach ($child in $children) { if (-not $child.HasExited) { $child.Kill($true); $child.WaitForExit() } }
    $env:JDK_JAVA_OPTIONS = $originalJavaOptions
    Pop-Location
}

#Requires -Version 7.2
[CmdletBinding()]
param([switch]$DatabaseOnly)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    if (-not $env:AWARDS_DB_PASSWORD) {
        $dataDir = New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'var') -Force
        $keyFile = Join-Path $dataDir.FullName 'intake-postgres.key'
        if (-not (Test-Path -LiteralPath $keyFile)) {
            $key = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
            $stream = [IO.File]::Open($keyFile, 'CreateNew', 'Write', 'None')
            try { $stream.Write([Text.Encoding]::ASCII.GetBytes($key)) } finally { $stream.Dispose() }
        }
        $env:AWARDS_DB_PASSWORD = [IO.File]::ReadAllText($keyFile).Trim()
    }

    & docker compose -f compose.yaml up -d --wait
    if ($LASTEXITCODE -ne 0) { throw '접수용 PostgreSQL을 시작하지 못했습니다. Docker Desktop 상태를 확인하세요.' }
    if ($DatabaseOnly) { return }

    $installedJdk = Join-Path $env:ProgramFiles 'Java/jdk-21'
    if (-not $env:JAVA_HOME -and (Test-Path -LiteralPath "$installedJdk/bin/javac.exe")) {
        $env:JAVA_HOME = $installedJdk
    }
    Set-Location -LiteralPath (Join-Path $PSScriptRoot 'backend')
    & ./gradlew.bat --console=plain bootRun
    if ($LASTEXITCODE -ne 0) { throw '접수 서비스를 시작하지 못했습니다. 위 빌드·실행 메시지를 확인하세요.' }
} finally {
    Pop-Location
}

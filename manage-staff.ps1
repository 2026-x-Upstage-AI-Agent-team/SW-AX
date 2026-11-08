#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('create', 'events', 'grant', 'revoke')][string]$Action,
    [ValidatePattern('^[a-z0-9][a-z0-9._-]{0,63}$')][string]$Login,
    [guid]$EventId,
    [securestring]$Password
)
$ErrorActionPreference = 'Stop'
$actionName = $Action.ToLowerInvariant()
if ($actionName -ne 'events' -and -not $Login) { throw '담당자 ID를 -Login으로 지정하세요.' }
if ($actionName -in 'grant','revoke' -and -not $EventId) { throw '대회 ID를 -EventId로 지정하세요.' }
$dbPassword = $env:AWARDS_DB_PASSWORD
Push-Location -LiteralPath (Join-Path $PSScriptRoot 'backend')
try {
    if (-not $env:AWARDS_DB_PASSWORD) {
        $env:AWARDS_DB_PASSWORD = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'var/intake-postgres.key')).Trim()
    }
    $jdk = Join-Path $env:ProgramFiles 'Java/jdk-21'
    if (-not $env:JAVA_HOME -and (Test-Path -LiteralPath "$jdk/bin/javac.exe")) { $env:JAVA_HOME = $jdk }
    if ($actionName -eq 'create') {
        if (-not $Password) { $Password = Read-Host '담당자 비밀번호' -AsSecureString }
        [Net.NetworkCredential]::new('', $Password).Password | & ./gradlew.bat -q --console=plain staffAdmin "--args=create $Login"
    } else {
        $arguments = if ($actionName -eq 'events') { 'events' } else { "$actionName $Login $EventId" }
        & ./gradlew.bat -q --console=plain staffAdmin "--args=$arguments"
    }
    if ($LASTEXITCODE -ne 0) { throw '담당자 관리 명령에 실패했습니다.' }
} finally {
    $env:AWARDS_DB_PASSWORD = $dbPassword
    Pop-Location
}

#Requires -Version 7.2
[CmdletBinding()]
param([switch]$InstallAtStartup, [switch]$Prepare)
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    $python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
    if (-not $env:AWARD_DATA_DIR) { $env:AWARD_DATA_DIR = Join-Path $PSScriptRoot 'var' }
    $data = [IO.Directory]::CreateDirectory($env:AWARD_DATA_DIR).FullName
    $config = Join-Path $data 'output-printer.xml'
    if ($Prepare) {
        $url = Read-Host 'Spring Boot 서버 HTTPS 주소 (같은 PC는 http://127.0.0.1:18765)'
        $uri = [uri]$url
        if (-not $uri.IsAbsoluteUri -or ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback))) {
            throw '서버 주소를 확인하세요.'
        }
        $key = Read-Host -AsSecureString '출력 전용 토큰'
        if ($key.Length -eq 0) { throw '출력 전용 토큰을 입력하세요.' }
        & ./operations/hancom/setup.ps1 -Python $python
        [pscustomobject]@{ Server=$uri.AbsoluteUri; Token=$key } | Export-Clixml -LiteralPath $config
        return
    }
    if ($InstallAtStartup) {
        if (-not (Test-Path -LiteralPath $config)) { throw '먼저 같은 Windows 계정에서 -Prepare를 실행하세요.' }
        $owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $credential = Get-Credential -UserName $owner -Message '부팅 후에도 한글을 실행할 전용 Windows 계정'
        if ($credential.UserName -ne $owner) { throw '출력 프로필을 준비한 동일 계정을 지정하세요.' }
        $action = New-ScheduledTaskAction -Execute (Get-Command pwsh).Source -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $PSCommandPath + '"') -WorkingDirectory $PSScriptRoot
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName 'SWAX 보고서 PDF 출력' -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -User $owner -Password $credential.GetNetworkCredential().Password -Force | Out-Null
        return
    }
    if (Test-Path -LiteralPath $config) {
        $printerSettings = Import-Clixml -LiteralPath $config
        $env:AWARDS_API_URL = $printerSettings.Server
        $env:AWARDS_OUTPUT_WORKER_TOKEN = [Net.NetworkCredential]::new('', $printerSettings.Token).Password
    }
    & $python -m operations.printer
    exit $LASTEXITCODE
} finally { Pop-Location }

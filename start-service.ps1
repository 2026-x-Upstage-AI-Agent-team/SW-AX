#Requires -Version 7.0
[CmdletBinding()]
param([ValidateRange(1024,65535)][int]$Port = 8765)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $python)) {
    throw '프로젝트 가상환경에 service/requirements.txt를 설치한 뒤 실행하세요. docs/LOCAL_SERVICE.md를 참고하세요.'
}
Write-Host "시상금 서류 검토  http://127.0.0.1:$Port"
& $python -m uvicorn service.app:app --host 127.0.0.1 --port $Port --no-access-log
exit $LASTEXITCODE

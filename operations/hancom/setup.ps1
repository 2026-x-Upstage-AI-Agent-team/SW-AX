#Requires -Version 7.2
[CmdletBinding()]
param([string]$Directory, [string]$Python)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $Directory) {
    $data = if ($env:AWARD_DATA_DIR) { $env:AWARD_DATA_DIR } else { Join-Path $root 'var' }
    $Directory = Join-Path $data 'hancom'
}
if (-not $Python) { $Python = Join-Path $root '.venv/Scripts/python.exe' }
$folder = [IO.Directory]::CreateDirectory($Directory).FullName
$null = [IO.Directory]::CreateDirectory((Join-Path $folder 'jobs'))
$tag = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($folder.ToUpperInvariant()))).Substring(0,24)
$code = Join-Path $PSScriptRoot 'PathGuard.c'
$version = (Get-FileHash $code).Hash.Substring(0,12)
foreach ($arch in 'x86','x86_64') {
    $bits = if ($arch -eq 'x86') { '32' } else { '64' }
    $dll = Join-Path $folder "guard-$version-$bits.dll"
    if (-not (Test-Path -LiteralPath $dll)) {
        $exports = @()
        if ($arch -eq 'x86') {
            $def = Join-Path $folder 'guard32.def'
            [IO.File]::WriteAllLines($def,@('EXPORTS','IsAccessiblePath=IsAccessiblePath@16'))
            $exports += $def
        }
        $temp = Join-Path $folder ("build-" + [Guid]::NewGuid().ToString('N') + '.dll')
        & $Python -m ziglang cc -target "$arch-windows-gnu" -shared -Os -s $code @exports -o $temp
        if ($LASTEXITCODE -ne 0) { throw '한글 파일 접근 모듈을 빌드하지 못했습니다. operations/requirements.txt를 설치하세요.' }
        [IO.File]::Move($temp,$dll)
    }
    $view = if ($bits -eq '32') { [Microsoft.Win32.RegistryView]::Registry32 } else { [Microsoft.Win32.RegistryView]::Registry64 }
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser',$view)
    try {
        $key = $hive.CreateSubKey('Software\HNC\HwpAutomation\Modules')
        try { $key.SetValue("SWAX-Reports-$tag-$bits",$dll,[Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
    } finally { $hive.Dispose() }
}
Write-Host '한글 워커의 작업별 입력·출력 경로 확인 모듈을 준비했습니다.'

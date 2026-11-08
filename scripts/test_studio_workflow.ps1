#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Submit')]
param(
    [Parameter(ParameterSetName = 'Submit')][Parameter(ParameterSetName = 'Check')]
    [ValidatePattern('^set(0[1-9]|10)$')][string]$CaseId = 'set01',
    [Parameter(ParameterSetName = 'Check', Mandatory)][switch]$CheckInput,
    [Parameter(ParameterSetName = 'Submit')][string]$AgentId,
    [Parameter(ParameterSetName = 'Submit')][string]$ConfigId,
    [Parameter(ParameterSetName = 'Resume', Mandatory)]
    [ValidatePattern('\A[A-Za-z0-9_-]+\z')][string]$JobId
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataset = Join-Path $root 'test case/유잇_미션2_테스트set.zip'

function Get-Setting([string]$name) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (!$value) { $value = [Environment]::GetEnvironmentVariable($name, 'User') }
    if ($value) { $value.Trim() }
}

function Invoke-Upstage([string]$method, [string]$path, [hashtable]$options = @{}) {
    try {
        Invoke-RestMethod -Uri "https://api.upstage.ai/v2/$path" -Method $method @auth @options
    } catch {
        $status = $_.Exception.Response.StatusCode
        if ($status) {
            $detail = ''
            try { $detail = (ConvertFrom-Json -InputObject $_.ErrorDetails.Message -ErrorAction Stop).error.message }
            catch { $detail = '' }
            if ($detail -is [string]) {
                $detail = $detail.Replace($key, '[masked]') -replace 'data:application/[^;]+;base64,[A-Za-z0-9+/=]+', '[input]'
                $detail = $detail.Substring(0, [Math]::Min(240, $detail.Length))
            }
            throw "Upstage $method $path HTTP $([int]$status) $detail"
        }
        throw "Upstage $method $path 응답을 받지 못했습니다. $($_.Exception.GetType().Name)"
    }
}

function Read-CaseDocuments {
    $archive = [IO.Compression.ZipFile]::OpenRead($dataset)
    $editor = $null
    $work = $null
    try {
        $prefix = '유잇_미션2_테스트set/' + $CaseId.ToLowerInvariant() + '/'
        $entries = @($archive.Entries | Where-Object {
            $_.FullName -ceq ($prefix + $_.Name) -and [IO.Path]::GetExtension($_.Name) -in '.hwp', '.hwpx' -and $_.Name -notmatch '^00(?:\D|$)'
        })
        if (!$entries.Count) { throw "$CaseId 폴더에 한글 제출 파일이 없습니다." }
        if ($CheckInput) {
            foreach ($entry in $entries) {
                $stream = $entry.Open()
                try { $stream.CopyTo([IO.Stream]::Null) } finally { $stream.Dispose() }
                Write-Output "$CaseId  $($entry.Name)  ($($entry.Length) bytes)"
            }
            return
        }

        $tempParent = [IO.Path]::GetTempPath().TrimEnd([IO.Path]::DirectorySeparatorChar)
        $workName = 'studio-input-' + [guid]::NewGuid().ToString('N')
        $work = [IO.Directory]::CreateDirectory((Join-Path $tempParent $workName)).FullName
        $editor = New-Object -ComObject HWPFrame.HwpObject
        $editor.XHwpWindows.Item(0).Visible = $false
        $null = $editor.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule')
        for ($i = 0; $i -lt $entries.Count; $i++) {
            $entry = $entries[$i]
            $ext = [IO.Path]::GetExtension($entry.Name)
            $source = Join-Path $work ("$i" + $ext)
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $source)
            if (!$editor.Open($source, $ext.Substring(1).ToUpperInvariant(), 'forceopen:true')) { throw "한글 열기 실패 $($entry.Name)" }
            $pages = [int]$editor.PageCount
            $pdf = Join-Path $work "$i.pdf"
            if (!$editor.SaveAs($pdf, 'PDF', '') -or (Get-Item -LiteralPath $pdf).Length -eq 0) { throw "PDF 변환 실패 $($entry.Name)" }
            $null = $editor.Clear(1)
            [pscustomobject]@{
                source = $entry.Name; pages = $pages
                input_file = @{ type = 'input_file'; filename = [IO.Path]::ChangeExtension($entry.Name, '.pdf'); file_data = 'data:application/pdf;base64,' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($pdf)) }
            }
        }
    } finally {
        $archive.Dispose()
        try { if ($editor) { $null = $editor.Quit() } }
        finally {
            if ($work) {
                $owned = (Resolve-Path -LiteralPath $work).Path
                if ([IO.Path]::GetDirectoryName($owned) -eq $tempParent -and [IO.Path]::GetFileName($owned) -eq $workName) {
                    Remove-Item -LiteralPath $owned -Recurse -Force
                }
            }
        }
    }
}

if ($CheckInput) { Read-CaseDocuments; return }
if (!$JobId) {
    if (!$AgentId) { $AgentId = Get-Setting 'UPSTAGE_AGENT_ID' }
    if (!$AgentId) { throw 'Studio에서 확인한 Agent ID를 -AgentId 또는 UPSTAGE_AGENT_ID로 지정해 주세요.' }
    if (!$ConfigId) { $ConfigId = Get-Setting 'UPSTAGE_CONFIG_ID' }
}

$key = $null
$keyFile = Join-Path $root '.env.local'
if (Test-Path -LiteralPath $keyFile -PathType Leaf) {
    $entry = Select-String -LiteralPath $keyFile -Pattern '^\s*UPSTAGE_API_KEY\s*=(.*)$' | Select-Object -First 1
    if ($entry) { $key = $entry.Matches[0].Groups[1].Value.Trim().Trim('"', "'") }
}
if (!$key) { $key = Get-Setting 'UPSTAGE_API_KEY' }
if (!$key) { throw '프로젝트의 .env.local 파일에서 UPSTAGE_API_KEY= 오른쪽에 키를 입력해 주세요.' }
$auth = @{ Authentication = 'Bearer'; Token = ConvertTo-SecureString $key -AsPlainText -Force; MaximumRedirection = 0; TimeoutSec = 60 }
$outputDir = [IO.Directory]::CreateDirectory((Join-Path $root 'output/upstage')).FullName

if (!$JobId) {
    $documents = @(Read-CaseDocuments)
    $content = @($documents | ForEach-Object { $_.input_file })
    $body = @{ model = $AgentId; input = @(@{ role = 'user'; content = $content }); include = @('all'); background = $true }
    if ($ConfigId) {
        $config = Invoke-Upstage 'Get' ('agents/{0}/configs/{1}' -f [Uri]::EscapeDataString($AgentId), [Uri]::EscapeDataString($ConfigId))
        if (!$config.id) { throw "Studio 설정 $ConfigId 의 ID를 확인할 수 없습니다." }
        $body.config_id = $config.id
    }
    $request = [ordered]@{
        case_id = $CaseId; agent_id = $AgentId; config_id = $ConfigId; resolved_config_id = $body.config_id
        source_zip_sha256 = (Get-FileHash -LiteralPath $dataset).Hash; sources = @($documents | Select-Object source,pages)
        input_method = 'file_data'; filenames = @($content | ForEach-Object { $_.filename }); job_id = $null
    }
    $receipt = Join-Path $outputDir ("${CaseId}-" + [guid]::NewGuid().ToString('N') + '.json')
    $request | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receipt -Encoding utf8
    try {
        $jsonBytes = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 8 -Compress))
        $job = Invoke-Upstage 'Post' 'responses' @{ ContentType = 'application/json; charset=utf-8'; Body = $jsonBytes }
        if ($job.id -notmatch '\A[A-Za-z0-9_-]+\z') { throw '생성 응답에 유효한 Job ID가 없습니다.' }
    } catch {
        throw "$_ 새 Job을 요청하기 전에 Studio 모니터링에서 생성 이력을 확인하세요. 요청 기록 $receipt"
    }
    $JobId = $job.id
    Write-Host "Job ID  $JobId"
    $request.job_id = $JobId
    $request | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receipt -Encoding utf8
}

$until = [DateTime]::UtcNow.AddMinutes(10)
do {
    try { $job = Invoke-Upstage 'Get' "responses/${JobId}?include%5B%5D=all" }
    catch { throw "$_ 같은 Job을 다시 조회하려면 -JobId $JobId 로 실행하세요." }
    if ($job.id -ne $JobId) { throw "조회 응답의 ID가 $JobId 와 일치하지 않습니다." }
    if ($job.status -notin 'queued', 'in_progress') { break }
    if ([DateTime]::UtcNow -ge $until) { throw "조회 대기 시간이 지났습니다. -JobId $JobId 로 이어서 조회하세요." }
    Start-Sleep -Seconds 3
} while ($true)

$result = Join-Path $outputDir "result-$JobId.json"
$job | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $result -Encoding utf8
if ($job.status -ne 'completed') { throw "Job $JobId 상태 $($job.status). 응답 파일 $result" }
if (!$job.output) { throw "Job $JobId 응답에 단계 출력이 없습니다. 응답 파일 $result" }
Write-Output "Job $JobId 완료. 단계 출력 $(@($job.output).Count)개. 응답 파일 $result"

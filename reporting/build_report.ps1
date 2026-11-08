# Requires Hancom Hangul, PowerShell 7, and Python with reporting/requirements.txt.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Template,
    [Parameter(Mandatory)][string]$DataPath,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$templateFile = (Get-Item -LiteralPath $Template).FullName
$dataFile = Get-Item -LiteralPath $DataPath
$report = Get-Content -LiteralPath $dataFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
$documents = foreach ($team in $report.teams) {
    if (@($team.documents).Count -ne 3) { throw "Select 01, 02, and 03 for $($team.team_name) before compiling." }
    foreach ($path in $team.documents) {
        $file = Get-Item -LiteralPath ([IO.Path]::GetFullPath($path, $dataFile.DirectoryName))
        if ($file.Extension -notin '.hwp','.hwpx') { throw "Expected a Hangul evidence document: $($file.Name)" }
        $file
    }
}
if (!$documents) { throw 'Select at least one team.' }

$destination = [IO.Path]::GetFullPath($OutputDirectory, (Get-Location).Path)
if (Test-Path -LiteralPath $destination) { throw "Choose a new output directory: $destination" }
$parent = [IO.Path]::GetDirectoryName($destination)
$null = [IO.Directory]::CreateDirectory($parent)
$workName = '.award-report-' + [guid]::NewGuid().ToString('N')
$work = [IO.Path]::GetFullPath([IO.Path]::Combine($parent, $workName))
$result = [IO.Path]::Combine($work, 'result')
$null = [IO.Directory]::CreateDirectory($result)
$editor = $null

function Open-HangulDocument([string]$path) {
    $format = [IO.Path]::GetExtension($path).TrimStart('.').ToUpperInvariant()
    if (!$editor.Open($path, $format, 'forceopen:true')) { throw "Hancom could not open $path" }
}

function Save-HangulDocument([string]$path, [string]$format) {
    if (!$editor.SaveAs($path, $format, '') -or (Get-Item -LiteralPath $path).Length -eq 0) {
        throw "Hancom could not save $path"
    }
}

try {
    $editor = New-Object -ComObject HWPFrame.HwpObject
    . (Join-Path $PSScriptRoot 'guard_hancom.ps1')
    Protect-ConverterEditor $editor
    $editor.XHwpWindows.Item(0).Visible = $false
    $null = $editor.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule')

    $layout = Join-Path $work 'layout.hwpx'
    if ([IO.Path]::GetExtension($templateFile) -ieq '.hwpx') {
        [IO.File]::Copy($templateFile, $layout)
    } else {
        $copy = Join-Path $work 'layout-source.hwp'
        [IO.File]::Copy($templateFile, $copy)
        Open-HangulDocument $copy
        Save-HangulDocument $layout 'HWPX'
        $editor.Clear(1)
    }
    $cover = Join-Path $work 'cover.hwpx'
    & $Python (Join-Path $PSScriptRoot 'fill_award_form.py') $layout $dataFile.FullName $cover
    if ($LASTEXITCODE -ne 0) { throw 'Could not fill the award tables.' }

    $attachments = @()
    $references = @()
    $sourcePages = 0
    foreach ($file in $documents) {
        $number = $attachments.Count + 1
        $copy = Join-Path $work ("source-{0}{1}" -f $number, $file.Extension)
        [IO.File]::Copy($file.FullName, $copy)
        Open-HangulDocument $copy
        $sourcePages += $editor.PageCount
        $reference = Join-Path $work ("source-{0}.pdf" -f $number)
        Save-HangulDocument $reference 'PDF'
        $references += $reference
        if ($file.Extension -ieq '.hwp') {
            $converted = Join-Path $work ("source-{0}.hwpx" -f $number)
            Save-HangulDocument $converted 'HWPX'
        } else { $converted = $copy }
        $editor.Clear(1)
        $isolated = Join-Path $work ("attachment-{0}.hwpx" -f $number)
        & $Python (Join-Path $PSScriptRoot 'prepare_evidence.py') $converted $isolated
        if ($LASTEXITCODE -ne 0) { throw "Could not prepare attachment $number." }
        $attachments += $isolated
    }

    Open-HangulDocument $cover
    $coverPages = $editor.PageCount
    foreach ($path in $attachments) {
        $null = $editor.HAction.Run('MoveDocEnd')
        $insert = $editor.CreateAction('InsertFile')
        $params = $insert.CreateSet()
        $null = $insert.GetDefault($params)
        $params.SetItem('FileName', $path)
        foreach ($option in @('KeepSection','KeepCharshape','KeepParashape','KeepStyle')) {
            $params.SetItem($option, 1)
        }
        if (!$insert.Execute($params)) { throw "Hancom could not insert $path" }
    }
    $hwpx = Join-Path $result '시상금_지급내역서.hwpx'
    $pdf = Join-Path $result '시상금_지급내역서.pdf'
    Save-HangulDocument $hwpx 'HWPX'
    $editor.Clear(1)
    Open-HangulDocument $hwpx
    $actualPages = $editor.PageCount
    if ($actualPages -ne $coverPages + $sourcePages) {
        throw "Pagination mismatch: $actualPages pages, expected $coverPages + $sourcePages."
    }
    Save-HangulDocument $pdf 'PDF'
    $editor.Clear(1)
    & $Python (Join-Path $PSScriptRoot 'verify_evidence.py') $pdf $coverPages @references
    if ($LASTEXITCODE -ne 0) { throw 'The report differs from the original evidence.' }

    # Publish the pair together only after reopening the HWPX and checking its PDF.
    if ([IO.Path]::GetDirectoryName($result) -ne $work -or [IO.Path]::GetDirectoryName($destination) -ne $parent) {
        throw 'Unexpected output paths.'
    }
    [IO.Directory]::Move($result, $destination)
    Write-Output "Report saved in $destination ($coverPages cover pages, $sourcePages evidence pages)."
} finally {
    try {
        if ($editor) { $editor.Quit() }
    } finally {
        if (Test-Path -LiteralPath $work) {
            $owned = (Resolve-Path -LiteralPath $work).Path
            if ([IO.Path]::GetDirectoryName($owned) -eq $parent -and [IO.Path]::GetFileName($owned) -eq $workName) {
                Remove-Item -LiteralPath $owned -Recurse -Force
            }
        }
    }
}

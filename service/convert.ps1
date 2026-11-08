param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [string]$Guard)
$ErrorActionPreference = 'Stop'
$doc = $null
try {
    $doc = New-Object -ComObject HWPFrame.HwpObject
    . (Join-Path $PSScriptRoot '../reporting/guard_hancom.ps1')
    Protect-ConverterEditor $doc
    $doc.XHwpWindows.Item(0).Visible = $false
    if ($Guard) {
        if (-not ($doc.RegisterModule('FilePathCheckDLL', "$Guard-32") -or $doc.RegisterModule('FilePathCheckDLL', "$Guard-64"))) {
            throw 'The scoped Hancom path module is unavailable.'
        }
    } else {
        $null = $doc.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule')
    }
    $null = $doc.SetMessageBoxMode(0x00020000)
    $format = [IO.Path]::GetExtension($Source).TrimStart('.').ToUpperInvariant()
    if (!$doc.Open($Source, $format, 'forceopen:true')) { throw 'Cannot open document' }
    if (!$doc.SaveAs($Destination, 'PDF', '')) { throw 'Cannot render document' }
} finally {
    if ($doc) { $doc.Quit() }
}

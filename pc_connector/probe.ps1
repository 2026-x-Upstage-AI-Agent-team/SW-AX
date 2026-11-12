param([Parameter(Mandatory)][string]$Destination,[Parameter(Mandatory)][string]$Guard)
$ErrorActionPreference = 'Stop'
$doc = $null
try {
    $doc = New-Object -ComObject HWPFrame.HwpObject
    . (Join-Path $PSScriptRoot '../reporting/guard_hancom.ps1')
    Protect-ConverterEditor $doc
    $doc.XHwpWindows.Item(0).Visible = $false
    if (-not ($doc.RegisterModule('FilePathCheckDLL', "$Guard-32") -or $doc.RegisterModule('FilePathCheckDLL', "$Guard-64"))) {
        throw 'The scoped Hancom module is unavailable.'
    }
    $null = $doc.SetMessageBoxMode(0x00020000)
    if (!$doc.SaveAs($Destination,'PDF','')) { throw 'Cannot print a test page' }
} finally {
    if ($doc) { $doc.Quit() }
}

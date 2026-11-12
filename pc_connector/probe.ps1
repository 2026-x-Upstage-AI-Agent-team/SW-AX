param([Parameter(Mandatory)][string]$Destination,[Parameter(Mandatory)][string]$Guard,[switch]$WaitForOwner)
$ErrorActionPreference = 'Stop'
if($WaitForOwner -and ([Console]::ReadLine() -cne 'SWAX-OWNED')){throw 'Converter owner is unavailable'}
$doc = $null
$owned = $false
try {
    $doc = New-Object -ComObject HWPFrame.HwpObject
    . (Join-Path $PSScriptRoot '../reporting/guard_hancom.ps1')
    Protect-ConverterEditor $doc
    $owned = $true
    $doc.XHwpWindows.Item(0).Visible = $false
    if (-not ($doc.RegisterModule('FilePathCheckDLL', "$Guard-32") -or $doc.RegisterModule('FilePathCheckDLL', "$Guard-64"))) {
        throw 'The scoped Hancom module is unavailable.'
    }
    $null = $doc.SetMessageBoxMode(0x00020000)
    if (!$doc.SaveAs($Destination,'PDF','')) { throw 'Cannot print a test page' }
} finally {
    if ($doc -and $owned) { $doc.Quit() }
}

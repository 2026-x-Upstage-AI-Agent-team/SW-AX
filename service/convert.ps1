param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
$doc = $null
try {
    $doc = New-Object -ComObject HWPFrame.HwpObject
    . (Join-Path $PSScriptRoot '../reporting/guard_hancom.ps1')
    Protect-ConverterEditor $doc
    $doc.XHwpWindows.Item(0).Visible = $false
    $null = $doc.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule')
    $null = $doc.SetMessageBoxMode(0x00020000)
    $format = [IO.Path]::GetExtension($Source).TrimStart('.').ToUpperInvariant()
    if (!$doc.Open($Source, $format, 'forceopen:true')) { throw 'Cannot open document' }
    if (!$doc.SaveAs($Destination, 'PDF', '')) { throw 'Cannot render document' }
} finally {
    if ($doc) { $doc.Quit() }
}

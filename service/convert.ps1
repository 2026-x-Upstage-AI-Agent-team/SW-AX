param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [string]$Guard, [switch]$WaitForOwner)
$ErrorActionPreference = 'Stop'
if($WaitForOwner -and ([Console]::ReadLine() -cne 'SWAX-OWNED')){throw 'Converter owner is unavailable'}
$doc = $null
$owned = $false
try {
    $doc = New-Object -ComObject HWPFrame.HwpObject
    . (Join-Path $PSScriptRoot '../reporting/guard_hancom.ps1')
    Protect-ConverterEditor $doc
    $owned = $true
    $started = [DateTime]::UtcNow
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
    # SaveAs can return before the PDF writer has closed its output, especially under load.
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    $complete=$false
    do {
        $stream=$null
        try {
            $stream=[IO.File]::Open($Destination,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            if($stream.Length -ge 8){
                $header=New-Object byte[] 5
                $null=$stream.Read($header,0,5)
                $tail=New-Object byte[] ([int][Math]::Min(1024,$stream.Length))
                $null=$stream.Seek(-$tail.Length,[IO.SeekOrigin]::End)
                $null=$stream.Read($tail,0,$tail.Length)
                $complete=([Text.Encoding]::ASCII.GetString($header) -ceq '%PDF-') -and
                    [Text.Encoding]::ASCII.GetString($tail).Contains('%%EOF')
            }
        } catch [IO.IOException] {} finally {if($stream){$stream.Dispose()}}
        if(!$complete){Start-Sleep -Milliseconds 100}
    } while(!$complete -and [DateTime]::UtcNow -lt $deadline)
    if(!$complete){throw 'PDF writer did not finish its output'}
    [pscustomobject]@{converter_pid=$PID;editor_pid=[AwardEditorLifetime]::EditorId;
        editor_started_at=[AwardEditorLifetime]::EditorStartedAt.ToString('o');
        started_at=$started.ToString('o');completed_at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
} finally {
    if ($doc -and $owned) { $doc.Quit() }
}

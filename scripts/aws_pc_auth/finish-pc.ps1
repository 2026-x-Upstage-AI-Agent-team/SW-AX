# Run on the original PC after receiving the public CloudFormation output file.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$CloudResult)
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$python=Join-Path $root '.venv\Scripts\python.exe'
$marker=Join-Path $root 'var\aws-pc-auth-d1110a\ready.json'
$old=$null;if(Test-Path -LiteralPath $marker){$old=[IO.File]::ReadAllBytes($marker)}
try{
    & $python -X utf8 (Join-Path $PSScriptRoot 'configure_pc.py') --cloud-result $CloudResult
    if($LASTEXITCODE){throw 'Device authentication validation failed; human login configuration is unchanged.'}
    & $python -X utf8 (Join-Path $root 'var\aws-integration-d1110a\verify-native-reconnect.py')
    if($LASTEXITCODE){throw 'Device-authenticated tunnel verification failed.'}
}catch{
    if(Test-Path -LiteralPath $marker){
        [IO.File]::ReadAllBytes($marker) | Out-Null
        if($null -eq $old){Remove-Item -LiteralPath $marker}else{[IO.File]::WriteAllBytes($marker,$old)}
    }
    throw
}
Stop-ScheduledTask -TaskName 'SWAX-d1110a-PC-Recovery'
$deadline=(Get-Date).AddSeconds(15)
while((Get-ScheduledTask -TaskName 'SWAX-d1110a-PC-Recovery').State -eq 'Running'){
    if((Get-Date) -gt $deadline){throw 'Recovery task is still stopping; inspect before starting another instance.'}
    Start-Sleep -Milliseconds 300
}
Start-ScheduledTask -TaskName 'SWAX-d1110a-PC-Recovery'
foreach($role in @('prepare','printer')){
    & $python -X utf8 (Join-Path $root 'var\aws-integration-d1110a\start-native-repaired.py') --role $role
    if($LASTEXITCODE){throw ('Device activated, but worker startup failed: '+$role)}
}
Write-Output 'Device certificate authentication activated; healthy workers adopted and exited roles restarted.'

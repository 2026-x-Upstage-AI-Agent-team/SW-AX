param([Parameter(Mandatory)][string]$Executable)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$digest = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($identity.User.Value))
$tag = ([BitConverter]::ToString($digest)).Replace('-','').Substring(0,12)
$name = 'SWAX-PC-Connector-' + $tag
$action = New-ScheduledTaskAction -Execute $Executable -Argument '--background'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$recovery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($trigger,$recovery) -Principal $principal -Settings $settings -Force | Out-Null
[pscustomobject]@{task_name=$name;user=$identity.Name} | ConvertTo-Json -Compress

# Registers the "CARD MAX bots" task: starts the bots when this Windows user signs in (owner OK, 2026-10-25).
# Remove it with: Unregister-ScheduledTask -TaskName 'CARD MAX bots' -Confirm:$false
$start = Join-Path $PSScriptRoot 'start-bots.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'CARD MAX bots' -Action $action -Trigger $trigger -Settings $settings -Description 'CARD MAX Messenger bot, comment bot and dashboard' -Force | Out-Null
Get-ScheduledTask -TaskName 'CARD MAX bots' | Select-Object TaskName, State

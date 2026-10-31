# Stops every copy of the bots and their keepers, then starts exactly one set again (start-bots.ps1).
# Use it when the logs show "Another watcher is already running" or "EADDRINUSE 8790" over and over.
$here = $PSScriptRoot
Write-Host 'Stopping bot keepers...'
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'keep-running\.ps1' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host 'Stopping bots...'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dist[\\/](watch|commentwatch|dashboard)\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
Write-Host 'Starting one set of bots...'
& (Join-Path $here 'start-bots.ps1')
Start-Sleep -Seconds 8
$n = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dist[\\/](watch|commentwatch|dashboard)\.js' }).Count
Write-Host "Running bots: $n (expected 3). Dashboard: http://localhost:8790"

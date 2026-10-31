# Keeps one bot running: starts it, and when it stops (crash, lost connection, another copy already running),
# waits and starts it again. The bots' own locks make sure only one Messenger and one comment bot run at a time.
# Logs never contain names, messages or tokens (the bots scrub them).
param(
  [Parameter(Mandatory = $true)][ValidateSet('watch', 'commentwatch', 'dashboard')][string]$Bot,
  [int]$RestartAfterSec = 30
)
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "$Bot.log"
Set-Location $root
# Only one keeper per bot: if start-bots ran twice (sign-in task + a manual run), the second keeper
# would retry every 30 s forever against the first one's lock/port. Leave quietly instead.
$mutex = New-Object System.Threading.Mutex($false, "Local\fb-automation-keep-running-$Bot")
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
  Add-Content -Path $log -Value "[keep-running $(Get-Date -Format s)] another keeper already runs $Bot; this copy exits" -Encoding utf8
  exit 0
}
while ($true) {
  Add-Content -Path $log -Value "[keep-running $(Get-Date -Format s)] starting $Bot" -Encoding utf8
  $p = Start-Process -FilePath 'node' -ArgumentList "dist/$Bot.js" -WorkingDirectory $root -NoNewWindow -PassThru `
    -RedirectStandardError "$log.err" -RedirectStandardOutput "$log.out"
  $null = $p.Handle  # keeps the exit code readable after the process ends
  $p.WaitForExit()
  Get-Content "$log.err", "$log.out" -ErrorAction SilentlyContinue | Add-Content -Path $log -Encoding utf8
  Add-Content -Path $log -Value "[keep-running $(Get-Date -Format s)] $Bot stopped (exit $($p.ExitCode)); again in $RestartAfterSec s" -Encoding utf8
  # Keep the log small: last 2000 lines.
  $lines = Get-Content $log -Tail 2000; Set-Content -Path $log -Value $lines -Encoding utf8
  Start-Sleep -Seconds $RestartAfterSec
}

# Starts the Messenger bot, the comment bot and the dashboard in the background, each kept running by
# keep-running.ps1. Run at Windows sign-in by the "CARD MAX bots" scheduled task (scripts/install-autostart.ps1).
$here = $PSScriptRoot
foreach ($bot in 'watch', 'commentwatch', 'dashboard') {
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'keep-running.ps1'), '-Bot', $bot
  )
}

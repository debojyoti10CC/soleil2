$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot '.runtime\server.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output 'No managed Soleil process was recorded.'; exit 0 }
$serverPid = [int](Get-Content -LiteralPath $pidPath -Raw)
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
if ($serverProcess -and $serverProcess.CommandLine -and $serverProcess.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $serverProcess.CommandLine -match 'dist-server') { Stop-Process -Id $serverPid; Write-Output 'Soleil stopped.' }
elseif ($serverProcess) { throw 'The recorded PID belongs to another process; no process was stopped.' }
Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue

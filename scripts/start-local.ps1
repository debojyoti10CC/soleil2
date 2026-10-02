param([switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
$entryScript = Join-Path $projectRoot 'dist-server\server\index.js'
$applicationUrl = 'http://localhost:3001'
# Match HOST=127.0.0.1 exactly. localhost can resolve to ::1 first and exhaust
# a short HTTP timeout before IPv4 fallback, even while the server is healthy.
$healthUrl = 'http://127.0.0.1:3001/api/health'
function Get-SoleilHealth {
    param([int]$TimeoutMilliseconds = 1500)
    $request = [System.Net.HttpWebRequest]::Create($healthUrl)
    $request.Method = 'GET'
    $request.Accept = 'application/json'
    $request.Proxy = $null
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $request.KeepAlive = $false
    $response = $null
    $reader = $null
    try {
        $response = $request.GetResponse()
        $reader = [System.IO.StreamReader]::new($response.GetResponseStream())
        $body = $reader.ReadToEnd()
        if ($body.Length -gt 4096) { throw 'Unexpected oversized local health response.' }
        return ($body | ConvertFrom-Json)
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}
function Test-SoleilIdentity {
    param($Health)
    return ($Health -and $Health.ok -eq $true -and $Health.service -eq 'soleil' -and $Health.mode -in @('local-simulation', 'native-testnet', 'testnet', 'tempo-testnet'))
}
try { $health = Get-SoleilHealth } catch { $health = $null }
if (Test-SoleilIdentity $health) {
    Write-Output "Soleil is already running at $applicationUrl"
    if ($OpenBrowser) { Start-Process $applicationUrl }
    exit 0
}
if ($health) { throw 'Port 3001 returned another service identity. No process was started or stopped.' }
Push-Location -LiteralPath $projectRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' } }
    if (-not (Test-Path -LiteralPath $entryScript) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' } }
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    $env:NODE_ENV = 'production'
    $env:HOST = '127.0.0.1'
    $env:PORT = '3001'
    $env:SOLEIL_DEMO_ENABLED = 'true'
    $env:SOLEIL_NATIVE_ENABLED = 'true'
    $env:SOLEIL_APP_ORIGIN = $applicationUrl
    $env:NODE_USE_ENV_PROXY = '1'
    $nodePath = (Get-Command node.exe).Source
    $server = Start-Process -FilePath $nodePath -ArgumentList @('--use-env-proxy', '--env-file-if-exists=.env', ('"' + $entryScript + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'server.out.log') -RedirectStandardError (Join-Path $runtimeRoot 'server.err.log') -PassThru
    Set-Content -LiteralPath (Join-Path $runtimeRoot 'server.pid') -Value $server.Id -NoNewline
    $ready = $false
    $startupTimer = [Diagnostics.Stopwatch]::StartNew()
    $lastProbe = 'No response'
    $attempt = 0
    while ($startupTimer.ElapsedMilliseconds -lt 12000) {
        $server.Refresh()
        if ($server.HasExited) { throw "The managed Soleil process exited with code $($server.ExitCode). Check .runtime/server.err.log." }
        $attempt++
        $remaining = 12000 - $startupTimer.ElapsedMilliseconds
        $probeTimeout = [int][Math]::Max(1, [Math]::Min(1500, $remaining))
        try {
            $candidate = Get-SoleilHealth -TimeoutMilliseconds $probeTimeout
            if (Test-SoleilIdentity $candidate) { $ready = $true; break }
            $lastProbe = 'Unexpected service identity'
        } catch { $lastProbe = $_.Exception.GetType().Name }
        $remaining = 12000 - $startupTimer.ElapsedMilliseconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(300, $remaining)) }
    }
    if (-not $ready) {
        throw "Soleil readiness failed after $attempt probes in $($startupTimer.ElapsedMilliseconds) ms at $healthUrl (last result: $lastProbe; managed PID: $($server.Id)). Check .runtime/server.err.log."
    }
    Write-Output "Soleil is ready at $applicationUrl"
    if ($OpenBrowser) { Start-Process $applicationUrl }
} finally { Pop-Location }

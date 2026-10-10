param([switch]$ImportDockerData, [switch]$SkipInstall)
$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$pythonExecutable = Join-Path $repoRoot "backend/.venv/Scripts/python.exe"
$logDirectory = Join-Path $repoRoot "logs"
$runtimeDirectory = Join-Path $repoRoot "data/runtime"
# .env is optional: every setting has a localhost default and the workspace has no login.
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
Push-Location $repoRoot
try {
    if (-not $SkipInstall) {
        & uv sync --project backend --extra test --python 3.12
        if ($LASTEXITCODE -ne 0) { throw "Backend dependency setup failed." }
        Push-Location (Join-Path $repoRoot "frontend")
        try {
            & npm ci
            if ($LASTEXITCODE -ne 0) { throw "Frontend dependency setup failed." }
        } finally { Pop-Location }
    }
    if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw "Project Python environment is missing." }
    if ($ImportDockerData) {
        & (Join-Path $PSScriptRoot "import-docker-data.ps1")
    } else {
        & docker compose stop api worker frontend
        if ($LASTEXITCODE -ne 0) { throw "Could not stop Docker application services." }
    }
    & docker compose up -d redis
    if ($LASTEXITCODE -ne 0) { throw "Could not start local Redis infrastructure." }
    foreach ($port in @(8000,5173)) {
        for ($retry=0; $retry -lt 20; $retry++) {
            if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
            throw "Port $port is occupied. Stop the existing native process before starting again."
        }
    }
    $env:DATA_DIR = Join-Path $repoRoot "data"
    $env:LOG_DIR = $logDirectory
    $env:REDIS_URL = "redis://127.0.0.1:6379/0"
    $env:APP_ORIGIN = "http://127.0.0.1:5173"
    $env:OAUTH_REDIRECT_URI = "http://127.0.0.1:8000/auth/chatgpt/callback"
    $apiProcess = Start-Process -FilePath $pythonExecutable -ArgumentList @("-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8000","--no-access-log") -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory "api-console.log") -RedirectStandardError (Join-Path $logDirectory "api-console-error.log")
    $workerProcess = Start-Process -FilePath $pythonExecutable -ArgumentList @("-m","app.worker") -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory "worker-console.log") -RedirectStandardError (Join-Path $logDirectory "worker-console-error.log")
    $nodeExecutable = (Get-Command node).Source
    $viteScript = Join-Path $repoRoot "frontend/node_modules/vite/bin/vite.js"
    $uiProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @(('"' + $viteScript + '"'),"--host","127.0.0.1","--port","5173","--strictPort") -WorkingDirectory (Join-Path $repoRoot "frontend") -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory "ui-console.log") -RedirectStandardError (Join-Path $logDirectory "ui-console-error.log")
    # Serialize each entry on its own: Windows PowerShell 5.1 wraps piped arrays in a value/Count object.
    $entries = foreach ($process in @($apiProcess,$workerProcess,$uiProcess)) {
        [pscustomobject]@{ process_id = $process.Id; started_at = $process.StartTime.ToUniversalTime().ToString("o"); executable = $process.Path } | ConvertTo-Json -Compress
    }
    "[" + ($entries -join ",") + "]" | Set-Content -LiteralPath (Join-Path $runtimeDirectory "native-processes.json") -Encoding utf8
    $ready = $false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        try { $health = Invoke-RestMethod "http://127.0.0.1:8000/health" -TimeoutSec 2; $ready = $health.oauth_setup -eq "host_sign_in"; if ($ready) { break } } catch {}
        Start-Sleep -Milliseconds 300
    }
    if (-not $ready) { throw "Native API failed to start. Inspect logs/api-console-error.log." }
    if ($workerProcess.HasExited -or $uiProcess.HasExited) { throw "A native service stopped during startup. Inspect logs/ console-error files." }
    Write-Host "Native workspace ready: http://127.0.0.1:5173"
    Write-Host "No login is needed. Choose Connect AI to analyse in the top bar to connect ChatGPT; tokens stay in this Windows user's credential store."
} finally { Pop-Location }

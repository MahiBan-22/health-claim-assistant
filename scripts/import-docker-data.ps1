param()
$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$dataDirectory = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "data"))
if (-not $dataDirectory.StartsWith($repoRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The data target must remain inside the repository."
}
if (Test-Path -LiteralPath (Join-Path $dataDirectory "app.sqlite")) {
    throw "Native app.sqlite already exists. Import stopped to avoid overwriting it."
}
$pythonExecutable = Join-Path $repoRoot "backend/.venv/Scripts/python.exe"
if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw "Install backend dependencies first with uv sync --project backend --extra test --python 3.12." }
Push-Location $repoRoot
try {
    & docker compose stop api worker frontend
    if ($LASTEXITCODE -ne 0) { throw "Could not stop application containers before copying their data." }
    New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    & docker cp "claimevidenceassistant-api-1:/data/." $dataDirectory
    if ($LASTEXITCODE -ne 0) { throw "Docker data copy failed. The original Docker volume has been preserved." }
    & $pythonExecutable -m app.migrate_native $dataDirectory
    if ($LASTEXITCODE -ne 0) { throw "Native data validation failed. The Docker source volume remains unchanged." }
    Write-Host "Imported and verified Docker data into $dataDirectory. Original Docker volume preserved."
} finally { Pop-Location }

param()
$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$python = Join-Path $repoRoot "backend/.venv/Scripts/python.exe"
if (Test-Path -LiteralPath $python) {
    & $python (Join-Path $PSScriptRoot "build_backend.py")
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3.12 (Join-Path $PSScriptRoot "build_backend.py")
} else {
    & python3.12 (Join-Path $PSScriptRoot "build_backend.py")
}
if ($LASTEXITCODE -ne 0) { throw "Backend packaging failed." }

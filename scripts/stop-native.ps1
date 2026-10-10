$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$stateFile = Join-Path $repoRoot "data/runtime/native-processes.json"
if (-not (Test-Path -LiteralPath $stateFile)) { Write-Host "No recorded native services."; exit 0 }
function Stop-OwnedTree([int]$ProcessNumber) {
    $children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $ProcessNumber) -ErrorAction SilentlyContinue)
    foreach ($child in $children) { Stop-OwnedTree -ProcessNumber $child.ProcessId }
    Stop-Process -Id $ProcessNumber -ErrorAction SilentlyContinue
}
$entries = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
foreach ($entry in $entries) {
    $process = Get-Process -Id $entry.process_id -ErrorAction SilentlyContinue
    if ($null -eq $process) { continue }
    $sameStart = $process.StartTime.ToUniversalTime().ToString("o") -eq $entry.started_at
    $sameExecutable = $process.Path -eq $entry.executable
    if ($sameStart -and $sameExecutable) { Stop-OwnedTree -ProcessNumber $process.Id }
}
Write-Host "Stopped recorded native services. Redis and all stored data are preserved."

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$stateFile = Join-Path $repoRoot "data/runtime/native-processes.json"
if (-not (Test-Path -LiteralPath $stateFile)) { Write-Host "No recorded native services."; exit 0 }
function Stop-OwnedTree([int]$ProcessNumber) {
    $children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $ProcessNumber) -ErrorAction SilentlyContinue)
    foreach ($child in $children) { Stop-OwnedTree -ProcessNumber $child.ProcessId }
    Stop-Process -Id $ProcessNumber -ErrorAction SilentlyContinue
}
# Older state files nested the list under "value"; accept both shapes.
# Assign before looping: Windows PowerShell passes the parsed array down the pipeline as one object.
$parsed = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$entries = foreach ($entry in $parsed) { if ($entry.PSObject.Properties['value']) { $entry.value } else { $entry } }
foreach ($entry in $entries) {
    if (-not $entry.process_id) { continue }
    $process = Get-Process -Id $entry.process_id -ErrorAction SilentlyContinue
    if ($null -eq $process) { continue }
    # ConvertFrom-Json turns the ISO timestamp into a DateTime, so compare instants rather than text.
    $recordedStart = ([datetime]$entry.started_at).ToUniversalTime()
    $sameStart = [math]::Abs(($process.StartTime.ToUniversalTime() - $recordedStart).TotalSeconds) -lt 2
    $sameExecutable = $process.Path -eq $entry.executable
    if ($sameStart -and $sameExecutable) { Stop-OwnedTree -ProcessNumber $process.Id }
}
Write-Host "Stopped recorded native services. Redis and all stored data are preserved."

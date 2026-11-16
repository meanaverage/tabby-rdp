param([Parameter(Mandatory=$true)][string]$Output, [Parameter(Mandatory=$true)][string]$StopFile)
# Dedicated client VM: records every Tabby process (including WASM utility) and native FreeRDP child.
# Cumulative CPU seconds; Windows working sets count shared pages in each process, private bytes do not.
$ErrorActionPreference='Stop'
$writer=[IO.StreamWriter]::new($Output,$false,[Text.UTF8Encoding]::new($false))
try {
 while(-not (Test-Path -LiteralPath $StopFile)) {
  $rows=@(Get-Process Tabby,tabby-freerdp -ErrorAction SilentlyContinue | ForEach-Object {
   try { @{pid=$_.Id;name=$_.ProcessName;startUtc=$_.StartTime.ToUniversalTime().ToString('o');cpuSeconds=$_.TotalProcessorTime.TotalSeconds;workingSetBytes=$_.WorkingSet64;privateBytes=$_.PrivateMemorySize64} } catch {}
  })
  $writer.WriteLine((@{at=[DateTime]::UtcNow.ToString('o');processes=$rows}|ConvertTo-Json -Depth 4 -Compress));$writer.Flush()
  Start-Sleep -Milliseconds 1000
 }
} finally { $writer.Dispose() }

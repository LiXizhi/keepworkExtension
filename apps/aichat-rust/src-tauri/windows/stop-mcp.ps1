param([Parameter(Mandatory = $true)][string]$InstallDir)

$ErrorActionPreference = 'Stop'
$installRoot = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\', '/') + '\'
$processes = Get-Process -Name 'keepwork-mcp', 'keepworkmcp' -ErrorAction SilentlyContinue
foreach ($process in $processes) {
    try {
        $executable = $process.Path
        if (!$executable) { continue }
        if (![IO.Path]::GetFullPath($executable).StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        # Retain the verified process handle until it has exited.
        $null = $process.Handle
        if ($process.HasExited) { continue }
        $process.Kill()
        if (!$process.WaitForExit(10000)) {
            throw "Keepwork MCP process $($process.Id) did not exit"
        }
    } catch {
        if (!$process.HasExited) { throw }
    } finally {
        $process.Dispose()
    }
}

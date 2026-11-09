# Chromium names its per-profile message-only singleton window with the full profile path.
$ErrorActionPreference = 'Stop'
Add-Type -Namespace AIChat -Name Singleton -MemberDefinition @"
[DllImport("user32.dll", CharSet=CharSet.Unicode)]
public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
"@
foreach ($profile in $args) {
    $window = [AIChat.Singleton]::FindWindowEx([IntPtr](-3), [IntPtr]::Zero, 'Chrome_MessageWindow', $profile)
    if ($window -eq [IntPtr]::Zero) { continue }
    $owner = 0
    [void][AIChat.Singleton]::GetWindowThreadProcessId($window, [ref]$owner)
    $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if (!$process) { continue }
    try {
        # Hold a process handle and confirm ownership again before terminating it.
        $null = $process.Handle
        $currentOwner = 0
        [void][AIChat.Singleton]::GetWindowThreadProcessId($window, [ref]$currentOwner)
        if ($currentOwner -ne $owner) { continue }
        $process.Kill()
        if (!$process.WaitForExit(10000)) { throw "Desktop process $owner did not exit" }
    } finally { $process.Dispose() }
}

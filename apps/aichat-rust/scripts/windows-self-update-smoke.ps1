param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows packaged self-update smoke requires Windows' }
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This packaged GUI smoke requires a disposable GitHub Actions runner' }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
# This smoke installs and restarts only its new app on a disposable CI runner.
# Do not overwrite registry ownership of an existing installation on a workstation.
if (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Keepwork') {
  throw 'Packaged updater smoke requires a clean disposable Windows runner'
}
$protocolKey = 'HKCU:\Software\Classes\keepwork-secondbrain'
$protocolCommandKey = 'HKEY_CURRENT_USER\Software\Classes\keepwork-secondbrain\shell\open\command'
if (Test-Path -LiteralPath $protocolKey) {
  throw 'Packaged updater smoke requires an unclaimed protocol on its disposable runner'
}
foreach ($port in @(8089, 18089)) {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
  try { $listener.Start() } finally { $listener.Stop() }
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('keepwork-self-update-' + [guid]::NewGuid())
$install = Join-Path $root 'Keepwork 中文 custom directory'
$external = Join-Path $root 'other-install'
$profile = Join-Path $root 'private profile 中文'
$owned = [Collections.Generic.List[Diagnostics.Process]]::new()
$uninstalled = $false
$fixtureProtocolCommand = $null
New-Item -ItemType Directory -Path $install, $external, $profile | Out-Null
function Get-ProtocolCommand {
  return [Microsoft.Win32.Registry]::GetValue($protocolCommandKey, '', $null)
}
function Assert-ProtocolCommand([string]$executableName) {
  # Use NSIS's recorded installation spelling, including short-name expansion.
  $location = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Keepwork').InstallLocation
  if (-not $location) { throw 'Installer did not record its installation directory' }
  $expected = '"' + (Join-Path $location $executableName) + '" --launch-url "%1"'
  if (-not [string]::Equals((Get-ProtocolCommand), $expected, [StringComparison]::Ordinal)) {
    throw 'Installed URL protocol command was not quoted exactly'
  }
  return $expected
}
function Start-Owned([string]$file, [string]$arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new($file)
  $info.Arguments = $arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($info)
  $owned.Add($process)
  return $process
}
function Wait-Code([Diagnostics.Process]$process, [int]$expected, [int]$timeout = 120000) {
  if (-not $process.WaitForExit($timeout)) { throw 'Owned installer/helper timed out' }
  if ($process.ExitCode -ne $expected) { throw "Unexpected exit code $($process.ExitCode), expected $expected" }
}
function Retain-Relaunched([string]$executable, [DateTime]$since) {
  $name = [IO.Path]::GetFileNameWithoutExtension($executable)
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($candidate in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      $keep = $false
      try {
        # Retain the same process handle used for path/time validation and cleanup.
        $null = $candidate.Handle
        if ($candidate.StartTime.ToUniversalTime() -ge $since -and
            [string]::Equals($candidate.MainModule.FileName, $executable, [StringComparison]::OrdinalIgnoreCase)) {
          $owned.Add($candidate)
          $keep = $true
          return $candidate
        }
      } catch [InvalidOperationException] {
        # A process can exit while its identity is being inspected.
      } finally {
        if (-not $keep) { $candidate.Dispose() }
      }
    }
    Start-Sleep -Milliseconds 100
  }
  throw 'NSIS /R did not launch this installation within 45 seconds'
}
try {
  Wait-Code (Start-Owned $Installer "/S /D=$install") 0
  # The installer can expand RUNNER~1 in its persisted path. Use that spelling
  # for executable identity and exact uninstall ownership checks from now on.
  $install = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Keepwork').InstallLocation
  if (-not $install) { throw 'Installer did not record its installation directory' }
  $apps = @(Get-ChildItem -LiteralPath $install -File | Where-Object { $_.Name -in @('Keepwork.exe', 'aichat-rust.exe') })
  if ($apps.Count -ne 1) { throw 'Installed application identity is ambiguous' }
  $application = $apps[0].FullName
  $protocolCommand = Assert-ProtocolCommand $apps[0].Name
  $expectedHash = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash
  $helper = Join-Path $root 'fixture-installer-helper.exe'
  Copy-Item -LiteralPath $application -Destination $helper
  $data = Join-Path $install 'user-data-marker.txt'
  Set-Content -LiteralPath $data -Value 'must survive update' -NoNewline
  # Two owned node processes have the same image basename. Only the target
  # install is allowed to block updating; the other installation stays alive.
  Copy-Item -LiteralPath (Get-Command node).Source -Destination $application -Force
  $externalExe = Join-Path $external $apps[0].Name
  Copy-Item -LiteralPath (Get-Command node).Source -Destination $externalExe
  $other = Start-Owned $externalExe '-e "setTimeout(() => {}, 300000)"'
  # A reopened historical executable must block before MCP cleanup or writes.
  $alternateName = if ($apps[0].Name -ieq 'Keepwork.exe') { 'aichat-rust.exe' } else { 'Keepwork.exe' }
  $alternateExe = Join-Path $install $alternateName
  Copy-Item -LiteralPath (Get-Command node).Source -Destination $alternateExe
  $reopened = Start-Owned $alternateExe '-e "setTimeout(() => {}, 120000)"'
  $fixtureMcpExe = Join-Path $install 'resources\mcp-runtime\keepworkmcp.exe'
  if (Test-Path -LiteralPath $fixtureMcpExe) { throw 'Fixture MCP path unexpectedly exists in the package' }
  Copy-Item -LiteralPath (Get-Command node).Source -Destination $fixtureMcpExe
  $fixtureMcp = Start-Owned $fixtureMcpExe '-e "setTimeout(() => {}, 120000)"'
  $beforeRejectedUpdate = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash
  Wait-Code (Start-Owned $Installer "/S /UPDATE /D=$install") 2
  if ($reopened.HasExited -or $fixtureMcp.HasExited -or $other.HasExited) {
    throw 'A rejected update stopped the reopened desktop or a service'
  }
  if ((Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash -ne $beforeRejectedUpdate) {
    throw 'A rejected update changed application bytes'
  }
  $reopened.Kill(); $reopened.WaitForExit()
  $fixtureMcp.Kill(); $fixtureMcp.WaitForExit()
  Remove-Item -LiteralPath $alternateExe, $fixtureMcpExe -Force
  $parent = Start-Owned $application '-e "setTimeout(() => {}, 15000)"'
  $stamp = $parent.StartTime.ToUniversalTime().ToFileTimeUtc()
  Wait-Code (Start-Owned $helper "--wait-for-desktop $($parent.Id):$($stamp + 1) `"$application`"") 2
  if ($parent.HasExited -or $other.HasExited) { throw 'Identity rejection terminated a process' }
  Wait-Code (Start-Owned $helper "--check-desktop-stopped `"$application`"") 2
  if ($parent.HasExited) { throw 'Busy check terminated the target app' }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $updater = Start-Owned $Installer "/S /UPDATE /KEEPWORK_PARENT=$($parent.Id):$stamp /KEEPWORK_EXE=$($apps[0].Name) /D=$install"
  Wait-Code $updater 0
  Wait-Code $parent 0
  if ($other.HasExited) { throw 'Update stopped another installation' }
  if ((Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Updater did not restore the new application bytes' }
  if ((Get-Content -LiteralPath $data -Raw) -ne 'must survive update') { throw 'Updater damaged user data' }
  $receipt = Get-Content -LiteralPath "$Installer.result.json" -Raw | ConvertFrom-Json
  if ($receipt.state -ne 'installed') { throw 'Installer did not persist its successful result' }
  Wait-Code (Start-Owned $helper "--check-desktop-stopped `"$application`"") 0
  # Manual repair omits KEEPWORK_PARENT but must replace a prior failure receipt.
  [IO.File]::WriteAllText("$Installer.result.json", '{"state":"failed","code":"fixture-previous-failure"}', [Text.Encoding]::ASCII)
  # Exercise the real NSIS restart flag and the actual packaged desktop binary.
  $restartSince = [DateTime]::UtcNow
  # GetOptions('/ARGS') preserves the inner quotes because the returned value
  # begins with '--', not a quote. RunAsUser then parses this as one argv.
  Wait-Code (Start-Owned $Installer "/S /UPDATE /R /ARGS --user-data-dir=`"$profile`" /D=$install") 0
  $repairedReceipt = Get-Content -LiteralPath "$Installer.result.json" -Raw | ConvertFrom-Json
  if ($repairedReceipt.state -ne 'installed') { throw 'Manual repair left a stale installer failure receipt' }
  $restarted = Retain-Relaunched $application $restartSince
  if ($restarted.WaitForExit(2000)) { throw 'The relaunched desktop exited immediately' }
  $recordPath = Join-Path $profile 'desktop-instance.json'
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $recordPath) -and [DateTime]::UtcNow -lt $deadline) {
    if ($restarted.HasExited) { throw 'The relaunched desktop exited before profile initialization' }
    Start-Sleep -Milliseconds 100
  }
  $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  if ($record.pid -ne $restarted.Id -or
      -not [string]::Equals($record.executable, $application, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The relaunched desktop did not own the isolated profile'
  }
  if ($other.HasExited) { throw 'Restart affected another installation' }
  $restarted.Kill(); $restarted.WaitForExit()
  Wait-Code (Start-Owned $helper "--stop-mcp `"$install`"") 0
  $protocolCommand = Assert-ProtocolCommand $apps[0].Name
  $uninstall = Join-Path $install 'uninstall.exe'
  foreach ($foreignCommand in @(
    ('"{0}" --launch-url "%1"' -f $externalExe)
    ($protocolCommand + ' --foreign-owner')
    ($protocolCommand.Replace('--launch-url', '--LAUNCH-URL'))
  )) {
    [Microsoft.Win32.Registry]::SetValue($protocolCommandKey, '', $foreignCommand, [Microsoft.Win32.RegistryValueKind]::String)
    $fixtureProtocolCommand = $foreignCommand
    Wait-Code (Start-Owned $uninstall "/S _?=$install") 0
    if (-not [string]::Equals((Get-ProtocolCommand), $foreignCommand, [StringComparison]::Ordinal)) {
      throw 'Uninstall modified a URL protocol command owned by another installation or handler'
    }
    if ($other.HasExited) { throw 'Uninstall stopped another installation' }
    Remove-Item -LiteralPath $protocolKey -Recurse -Force
    $fixtureProtocolCommand = $null
    Wait-Code (Start-Owned $Installer "/S /D=$install") 0
    $install = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Keepwork').InstallLocation
    if (-not $install) { throw 'Reinstalled application did not record its directory' }
    $uninstall = Join-Path $install 'uninstall.exe'
    $protocolCommand = Assert-ProtocolCommand $apps[0].Name
  }
  Wait-Code (Start-Owned $uninstall "/S _?=$install") 0
  $uninstalled = $true
  if (Test-Path -LiteralPath $protocolKey) { throw 'Uninstall retained its own URL protocol registration' }
  Write-Output (@{ result='passed'; cases=@('silent-custom-install', 'quoted-protocol-command', 'both-native-names-block-before-mcp-cleanup', 'parent-identity-rejection', 'no-force-desktop-check', 'parent-exit-before-replacement', 'silent-overwrite', 'custom-directory-preserved', 'user-data-preserved', 'external-install-untouched', 'manual-repair-clears-failure-receipt', 'real-nsis-relaunch', 'isolated-relaunch-profile', 'foreign-protocol-owner-preserved', 'own-protocol-registration-removed'); elapsedMs=$watch.ElapsedMilliseconds; relaunchTested=$true; applicationHealthTested=$false } | ConvertTo-Json -Compress)
} finally {
  # Kill only processes created and retained by this fixture, never by name/PID lookup.
  foreach ($process in $owned) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() } }
  if ($helper -and (Test-Path -LiteralPath $helper)) {
    Wait-Code (Start-Owned $helper "--stop-mcp `"$install`"") 0
  }
  $uninstall = Join-Path $install 'uninstall.exe'
  if (-not $uninstalled -and (Test-Path -LiteralPath $uninstall)) {
    $cleanup = Start-Owned $uninstall "/S _?=$install"
    Wait-Code $cleanup 0
  }
  if ($fixtureProtocolCommand -and [string]::Equals((Get-ProtocolCommand), $fixtureProtocolCommand, [StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $protocolKey -Recurse -Force
  }
  Remove-Item -LiteralPath $root -Recurse -Force
}

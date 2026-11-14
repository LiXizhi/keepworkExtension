# PowerShell 2.0 / .NET 3.5 test harness. This is a QA prerequisite, not an
# application dependency. Run separately in Win7 SP1 / Win8 / Win8.1 x64 VMs
# with a staged legacy MCP runtime; no shared 8089 or user-profile changes.
param(
  [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
try { Add-Type -AssemblyName System.Web.Extensions }
catch {
  $serializerAssembly = [Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions')
  if ($null -eq $serializerAssembly) { throw 'This QA harness requires .NET 3.5 System.Web.Extensions; it is not a product runtime dependency.' }
}
$script:Json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$script:Json.MaxJsonLength = 1048576
$script:Utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false

function Assert-Condition([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Normalize-Path([string]$Value) {
  if ($Value.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
    $Value = '\\' + $Value.Substring(8)
  } elseif ($Value.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
    $Value = $Value.Substring(4)
  }
  return [IO.Path]::GetFullPath($Value).TrimEnd('\')
}

function Quote-Argument([string]$Value) {
  $builder = New-Object Text.StringBuilder
  $null = $builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) { $slashes++; continue }
    if ($character -eq [char]34) {
      $null = $builder.Append([char]92, ($slashes * 2 + 1))
    } else {
      $null = $builder.Append([char]92, $slashes)
    }
    $slashes = 0
    $null = $builder.Append($character)
  }
  $null = $builder.Append([char]92, ($slashes * 2))
  $null = $builder.Append('"')
  return $builder.ToString()
}

function Get-Sha256([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally { $algorithm.Clear(); $stream.Close() }
}

function Invoke-Http([string]$Base, [string]$Route, [string]$Method = 'GET',
    $Body = $null, [string]$Token = '', [hashtable]$Headers = @{}) {
  $request = [Net.HttpWebRequest]::Create($Base + $Route)
  $request.Method = $Method
  $request.Proxy = $null
  $request.AllowAutoRedirect = $false
  $request.Timeout = 10000
  $request.ReadWriteTimeout = 10000
  $request.Accept = 'application/json, text/event-stream'
  $request.Headers['Origin'] = 'https://keepwork.com'
  if ($Token) { $request.Headers['Authorization'] = 'Bearer ' + $Token }
  foreach ($key in $Headers.Keys) { $request.Headers[$key] = [string]$Headers[$key] }
  if ($null -ne $Body) {
    if ($Body -is [string]) { $text = $Body } else { $text = $script:Json.Serialize($Body) }
    $bytes = $script:Utf8.GetBytes($text)
    $request.ContentType = 'application/json; charset=utf-8'
    $request.ContentLength = $bytes.Length
    $write = $request.GetRequestStream()
    try { $write.Write($bytes, 0, $bytes.Length) } finally { $write.Close() }
  }
  $response = $null
  try {
    try { $response = $request.GetResponse() }
    catch [Net.WebException] {
      if ($null -eq $_.Exception.Response) { throw }
      $response = $_.Exception.Response
    }
    $stream = $response.GetResponseStream()
    $memory = New-Object IO.MemoryStream
    try {
      $buffer = New-Object byte[] 8192
      while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        Assert-Condition (($memory.Length + $count) -le 1048576) 'HTTP response exceeded the smoke size limit'
        $memory.Write($buffer, 0, $count)
      }
      $text = $script:Utf8.GetString($memory.ToArray())
    } finally { $memory.Close(); $stream.Close() }
    $document = $null
    if ($text) { try { $document = $script:Json.DeserializeObject($text) } catch {} }
    return @{ Status = [int]$response.StatusCode; Text = $text; Json = $document;
      Session = $response.Headers['mcp-session-id'] }
  } finally { if ($null -ne $response) { $response.Close() } }
}

function Get-OwnedHealth($Child, [string]$Base, [string]$Workspace, $Expected, [bool]$Auth) {
  $Child.Refresh()
  Assert-Condition (-not $Child.HasExited) 'Owned daemon exited before the operation completed'
  $reply = Invoke-Http $Base '/health'
  Assert-Condition ($reply.Status -eq 200 -and $null -ne $reply.Json) 'Owned health endpoint did not return JSON'
  $health = $reply.Json
  Assert-Condition ($health['pid'] -eq $Child.Id) 'Endpoint PID differs from the owned child; no mutation was sent'
  Assert-Condition ($health['name'] -eq 'keepwork-mcp') 'Unexpected service name'
  Assert-Condition ($health['runtimeEngine'] -eq 'rust' -and $health['runtimeVariant'] -eq 'win7-win8') 'Endpoint is not a Win7/Win8 Rust runtime'
  Assert-Condition ($health['runtimeVersion'] -eq $Expected['version'] -and $health['runtimeCommit'] -eq $Expected['commit']) 'Compiled runtime identity differs from its staged metadata'
  Assert-Condition ((Normalize-Path $health['workspaceRoot']) -eq (Normalize-Path $Workspace)) 'Endpoint workspace differs from the isolated workspace'
  Assert-Condition ($health['requireAuth'] -eq $Auth) 'Authentication setting did not match the child environment'
  Assert-Condition (-not $health.ContainsKey('terminalApi')) 'Win7 runtime must not advertise PTY'
  $baseline = @($health['minWindows'])
  Assert-Condition ($baseline.Length -eq 3 -and $baseline[0] -eq 6 -and $baseline[1] -eq 1 -and $baseline[2] -eq 7601) 'Win7 baseline is missing or incorrect'
  $Child.Refresh()
  Assert-Condition (-not $Child.HasExited) 'Owned daemon exited during health validation'
  return $health
}

function Invoke-Owned($Child, [string]$Base, [string]$Workspace, $Expected, [bool]$Auth,
    [string]$Route, [string]$Method, $Body, [string]$Token, [hashtable]$Headers = @{}) {
  $null = Get-OwnedHealth $Child $Base $Workspace $Expected $Auth
  return Invoke-Http $Base $Route $Method $Body $Token $Headers
}

function Test-FolderLocations($Document, [string]$ProfileDirectory, [string]$Workspace) {
  Assert-Condition ($null -ne $Document -and $Document['platform'] -eq 'win32') 'Folder locations did not identify the Windows host'
  Assert-Condition ((Normalize-Path $Document['home']) -eq (Normalize-Path $ProfileDirectory)) 'Folder picker Home escaped the isolated profile'
  foreach ($key in @('locations', 'volumes')) {
    Assert-Condition ($Document.ContainsKey($key) -and $null -ne $Document[$key] -and
      $Document[$key] -is [Collections.IEnumerable] -and -not ($Document[$key] -is [string]) -and
      -not ($Document[$key] -is [Collections.IDictionary])) ('Invalid folder-picker collection: ' + $key)
  }
  $seen = @{}
  $common = @()
  foreach ($location in @($Document['locations'])) {
    $id = [string]$location['id']; $folder = [string]$location['path']
    Assert-Condition (-not [string]::IsNullOrEmpty($id) -and -not $seen.ContainsKey($id)) 'Missing or duplicate folder-picker location ID'
    $seen[$id] = $true
    Assert-Condition (-not [string]::IsNullOrEmpty([string]$location['name'])) 'Folder-picker location is missing its display name'
    Assert-Condition ($folder -match '^(?:[A-Za-z]:[\\/]|\\\\)' -and [IO.Directory]::Exists($folder)) 'A returned folder location is not an existing absolute directory'
    if ($id -eq 'home') {
      Assert-Condition ((Normalize-Path $folder) -eq (Normalize-Path $ProfileDirectory)) 'The Home entry differs from the isolated profile'
    } else {
      Assert-Condition (@('desktop', 'documents', 'downloads', 'pictures', 'music', 'videos') -contains $id) 'Unknown Windows common-folder ID'
      # KnownFolder paths belong to the logged-on user's real configuration.
      # They may be redirected or absent; do not create them or assume they
      # are children of the test process's isolated USERPROFILE.
      $common += @{ id = $id; path = $folder }
    }
  }
  Assert-Condition ($seen.ContainsKey('home')) 'Folder picker omitted the Home entry'
  $seenVolumes = @{}
  foreach ($volume in @($Document['volumes'])) {
    $volumePath = [string]$volume['path']
    Assert-Condition ($volumePath -match '^[A-Za-z]:\\$' -and [IO.Directory]::Exists($volumePath)) 'Folder picker returned an invalid or missing drive root'
    Assert-Condition (-not $seenVolumes.ContainsKey($volumePath) -and -not [string]::IsNullOrEmpty([string]$volume['name'])) 'Missing or duplicate volume metadata'
    $seenVolumes[$volumePath] = $true
  }
  $workspaceDrive = [IO.Path]::GetPathRoot($Workspace)
  if ($workspaceDrive -match '^[C-Z]:\\$') {
    Assert-Condition ($seenVolumes.ContainsKey($workspaceDrive)) 'Folder picker omitted the existing workspace drive'
  }
  return @{ home = $Document['home']; commonFolders = $common; volumeCount = $seenVolumes.Count;
    allSixCommonFoldersRequired = $false }
}

function Run-Case([bool]$Auth, [string]$Executable, [string]$CaseDirectory, $Expected) {
  $caseProfileDirectory = Join-Path $CaseDirectory 'isolated-profile'
  $workspace = Join-Path $CaseDirectory 'workspace with spaces'
  $null = [IO.Directory]::CreateDirectory($caseProfileDirectory)
  $null = [IO.Directory]::CreateDirectory($workspace)
  $listener = New-Object Net.Sockets.TcpListener -ArgumentList @([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
  Assert-Condition ($port -ne 8089) 'Smoke must never use the shared MCP port'
  $base = 'http://127.0.0.1:' + $port
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $Executable
  $start.Arguments = '--port ' + $port + ' --root ' + (Quote-Argument $workspace)
  $start.WorkingDirectory = [IO.Path]::GetDirectoryName($Executable)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['USERPROFILE'] = $caseProfileDirectory
  foreach ($entry in @(@{ key = 'APPDATA'; directory = 'AppData\Roaming' },
      @{ key = 'LOCALAPPDATA'; directory = 'AppData\Local' },
      @{ key = 'TEMP'; directory = 'Temp' }, @{ key = 'TMP'; directory = 'Temp' })) {
    $isolatedDirectory = Join-Path $caseProfileDirectory $entry['directory']
    $null = [IO.Directory]::CreateDirectory($isolatedDirectory)
    $start.EnvironmentVariables[$entry['key']] = $isolatedDirectory
  }
  $start.EnvironmentVariables['KEEPWORK_MCP_REQUIRE_AUTH'] = [string][int]$Auth
  $start.EnvironmentVariables['KEEPWORK_MCP_HOST_KIND'] = 'win7-acceptance'
  foreach ($key in @('KEEPWORK_MCP_RUNTIME_VERSION', 'KEEPWORK_MCP_RUNTIME_COMMIT', 'KEEPWORK_MCP_RUNTIME_BUILT_AT', 'KEEPWORK_MCP_HOST_VERSION')) {
    $start.EnvironmentVariables.Remove($key)
  }
  $child = New-Object Diagnostics.Process
  $child.StartInfo = $start
  $caseReport = @{ requireAuth = $Auth; port = $port; passed = $false; checks = @(); profileIsolated = $true }
  try {
    Assert-Condition ($child.Start()) 'Could not start the owned runtime'
    $caseReport['pid'] = $child.Id
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $health = $null
    while ($null -eq $health -and [DateTime]::UtcNow -lt $deadline) {
      $child.Refresh()
      Assert-Condition (-not $child.HasExited) 'Owned runtime exited during startup'
      try { $health = Get-OwnedHealth $child $base $workspace $Expected $Auth }
      catch {
        # Abort immediately if anything answered on our isolated port with a
        # different identity. Never wait for, stop, or mutate that peer.
        try { $probe = Invoke-Http $base '/health' } catch { $probe = $null }
        if ($null -ne $probe) { throw }
        Start-Sleep -Milliseconds 100
      }
    }
    Assert-Condition ($null -ne $health) 'Owned runtime did not become healthy within 20 seconds'
    $token = ''
    if ($Auth) {
      $tokenPath = Join-Path $caseProfileDirectory '.keepwork-mcp\token'
      Assert-Condition ([IO.File]::Exists($tokenPath)) 'Isolated token was not created'
      $token = [IO.File]::ReadAllText($tokenPath).Trim()
      Assert-Condition ($token.Length -gt 0 -and $token.Length -le 4096 -and $token.IndexOf([char]10) -lt 0 -and $token.IndexOf([char]13) -lt 0) 'Invalid isolated token'
      $unauthorized = Invoke-Owned $child $base $workspace $Expected $Auth '/terminal/sessions' 'POST' @{} ''
      Assert-Condition ($unauthorized.Status -eq 401) 'Authentication must precede unsupported-feature handling'
    }
    $forbidden = Invoke-Owned $child $base $workspace $Expected $Auth '/terminal/sessions' 'POST' @{} $token @{ Origin = 'https://evil.example' }
    Assert-Condition ($forbidden.Status -eq 403) 'Disallowed Origin must remain rejected'
    $init = Invoke-Owned $child $base $workspace $Expected $Auth '/mcp' 'POST' @{
      jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{
        protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'win7-native-smoke'; version = '1' }
      }
    } $token
    Assert-Condition ($init.Status -eq 200 -and $init.Session -and $null -ne $init.Json['result']) 'MCP initialization failed'
    $sessionHeaders = @{ 'mcp-session-id' = $init.Session }
    $list = Invoke-Owned $child $base $workspace $Expected $Auth '/mcp' 'POST' @{ jsonrpc = '2.0'; id = 2; method = 'tools/list' } $token $sessionHeaders
    Assert-Condition ($list.Status -eq 200 -and $null -ne $list.Json['result']['tools']) 'MCP tools/list failed'
    $caseReport['checks'] += 'owned-health-and-mcp-initialize'

    if ($Auth) {
      $privateLocations = Invoke-Owned $child $base $workspace $Expected $Auth '/fs/locations' 'GET' $null ''
      Assert-Condition ($privateLocations.Status -eq 401) 'Folder locations leaked through the authentication boundary'
    }
    $locations = Invoke-Owned $child $base $workspace $Expected $Auth '/fs/locations' 'GET' $null $token
    Assert-Condition ($locations.Status -eq 200 -and $null -ne $locations.Json) 'Folder locations failed'
    $caseReport['folderLocations'] = Test-FolderLocations $locations.Json $caseProfileDirectory $workspace
    $caseReport['checks'] += 'folder-locations-home-volumes-and-returned-common-directories'

    $fileName = ([string][char]0x4e2d) + ([string][char]0x6587) + ' note.txt'
    $query = '?root=' + [Uri]::EscapeDataString($workspace) + '&path=' + [Uri]::EscapeDataString($fileName)
    $content = 'WIN7_NATIVE_FILE_ROUNDTRIP'
    $written = Invoke-Owned $child $base $workspace $Expected $Auth ('/fs/file' + $query) 'PUT' $content $token
    Assert-Condition ($written.Status -eq 200) 'Confined file write failed'
    $read = Invoke-Owned $child $base $workspace $Expected $Auth ('/fs/file' + $query) 'GET' $null $token
    Assert-Condition ($read.Status -eq 200 -and $read.Text -eq $content) 'Confined file read did not round-trip'
    Assert-Condition ([IO.File]::ReadAllText((Join-Path $workspace $fileName)) -eq $content) 'On-disk file bytes differ from the API result'
    $caseReport['checks'] += 'utf8-filename-and-file-roundtrip'

    foreach ($operation in @(
        @{ id = 3; name = 'grep_files'; arguments = @{ pattern = $content; path = '.'; maxMatches = 10 } },
        @{ id = 4; name = 'run_terminal'; arguments = @{ command = 'echo WIN7_NATIVE_COMMAND_OK'; cwd = $workspace; timeoutMs = 5000 } }
      )) {
      $reply = Invoke-Owned $child $base $workspace $Expected $Auth '/mcp' 'POST' @{ jsonrpc = '2.0'; id = $operation['id']; method = 'tools/call'; params = @{ name = $operation['name']; arguments = $operation['arguments'] } } $token $sessionHeaders
      Assert-Condition ($reply.Status -eq 200 -and $null -ne $reply.Json['result'] -and -not $reply.Json['result']['isError']) ('MCP tool failed: ' + $operation['name'])
      $toolText = $script:Json.Serialize($reply.Json['result']['content'])
      if ($operation['name'] -eq 'grep_files') { Assert-Condition ($toolText.Contains($content)) 'grep_files did not find the isolated file' }
      else { Assert-Condition ($toolText.Contains('WIN7_NATIVE_COMMAND_OK')) 'Ordinary command output is missing' }
      $caseReport['checks'] += $operation['name']
    }
    $pty = Invoke-Owned $child $base $workspace $Expected $Auth '/terminal/sessions' 'POST' @{} $token
    Assert-Condition ($pty.Status -eq 501 -and $pty.Json['code'] -eq 'UNSUPPORTED_FEATURE' -and $pty.Json['feature'] -eq 'pty-session-v1') 'PTY must return a bounded unsupported-feature error'
    $null = Get-OwnedHealth $child $base $workspace $Expected $Auth
    $status = Invoke-Owned $child $base $workspace $Expected $Auth '/mcp' 'POST' @{ jsonrpc = '2.0'; id = 5; method = 'tools/call'; params = @{ name = 'mcp_status'; arguments = @{} } } $token $sessionHeaders
    Assert-Condition ($status.Status -eq 200 -and -not $status.Json['result']['isError']) 'Ordinary MCP operations failed after the unsupported PTY request'
    $caseReport['checks'] += 'pty-refused-with-daemon-and-mcp-still-healthy'
    $closed = Invoke-Owned $child $base $workspace $Expected $Auth '/mcp' 'DELETE' $null $token $sessionHeaders
    Assert-Condition ($closed.Status -ge 200 -and $closed.Status -lt 300) 'MCP session cleanup failed'
    $null = Invoke-Owned $child $base $workspace $Expected $Auth '/admin/stop' 'POST' $null $token
    Assert-Condition ($child.WaitForExit(10000)) 'Owned daemon did not exit after its verified stop request'
    Assert-Condition ($child.ExitCode -eq 0) 'Owned daemon exited with an error'
    $caseReport['checks'] += 'owned-graceful-shutdown'
    $caseReport['passed'] = $true
  } catch {
    $caseReport['error'] = $_.Exception.Message
  } finally {
    try {
      $child.Refresh()
      if (-not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(10000) }
      Assert-Condition ($child.HasExited) 'Owned daemon could not be reaped; isolated profile was retained'
      foreach ($entry in @(@{ reader = $child.StandardOutput; name = 'stdout.log' }, @{ reader = $child.StandardError; name = 'stderr.log' })) {
        $captured = $entry['reader'].ReadToEnd()
        if ($captured.Length -gt 65536) { $captured = $captured.Substring($captured.Length - 65536) }
        [IO.File]::WriteAllText((Join-Path $CaseDirectory $entry['name']), $captured, $script:Utf8)
      }
      $caseReport['ownedProcessReaped'] = $true
      [IO.Directory]::Delete($caseProfileDirectory, $true)
      $caseReport['isolatedProfileRemoved'] = $true
    } catch {
      $caseReport['passed'] = $false
      $caseReport['cleanupError'] = $_.Exception.Message
    }
    $child.Dispose()
  }
  return $caseReport
}

Assert-Condition ($env:OS -eq 'Windows_NT') 'Run this acceptance harness on Windows'
$runtime = [IO.Path]::GetFullPath($RuntimeDirectory)
$output = [IO.Path]::GetFullPath($OutputDirectory)
Assert-Condition (-not (Test-Path -LiteralPath $output)) 'Use a new output directory'
$null = [IO.Directory]::CreateDirectory($output)
$report = @{ schemaVersion = 1; scope = 'mcp-native-basic-smoke'; nativeLegacyVerified = $false; nativeWin7Verified = $false;
  cefUiVerified = $false; passed = $false; startedAtUtc = [DateTime]::UtcNow.ToString('o'); cases = @() }
try {
  $osInfo = Get-WmiObject -Class Win32_OperatingSystem
  $computer = Get-WmiObject -Class Win32_ComputerSystem
  $osVersion = [Version]([string]$osInfo.Version)
  $report['system'] = @{ caption = $osInfo.Caption; version = $osInfo.Version; servicePackMajor = $osInfo.ServicePackMajorVersion;
    architecture = $osInfo.OSArchitecture; productType = $osInfo.ProductType; manufacturer = $computer.Manufacturer; model = $computer.Model;
    powershell = $PSVersionTable.PSVersion.ToString(); clr = [Environment]::Version.ToString() }
  $isNativeWin7 = $osInfo.Version.StartsWith('6.1.') -and $osVersion.Build -ge 7601 -and [int]$osInfo.ServicePackMajorVersion -ge 1 -and [int]$osInfo.ProductType -eq 1 -and $osInfo.OSArchitecture -match '^64'
  $osFamily = 'other-windows'
  if ($osInfo.Version.StartsWith('6.1.')) {
    if ([int]$osInfo.ServicePackMajorVersion -ge 1) { $osFamily = 'windows7-sp1' } else { $osFamily = 'windows7-without-sp1' }
  } elseif ($osInfo.Version.StartsWith('6.2.')) { $osFamily = 'windows8' }
  elseif ($osInfo.Version.StartsWith('6.3.')) { $osFamily = 'windows8.1' }
  $report['system']['osFamily'] = $osFamily
  $legacyBaselinePassed = (($osFamily -eq 'windows7-sp1' -and $osVersion.Build -ge 7601) -or
    ($osFamily -eq 'windows8' -and $osVersion.Build -ge 9200) -or
    ($osFamily -eq 'windows8.1' -and $osVersion.Build -ge 9600))
  $isNativeLegacy = [int]$osInfo.ProductType -eq 1 -and $osInfo.OSArchitecture -match '^64' -and $legacyBaselinePassed
  $manifestPath = Join-Path $runtime 'runtime.json'
  $expected = $script:Json.DeserializeObject([IO.File]::ReadAllText($manifestPath))
  Assert-Condition ($expected['variant'] -eq 'win7-win8' -and $expected['buildTarget'] -eq 'x86_64-win7-windows-msvc' -and $expected['platform'] -eq 'windows' -and $expected['arch'] -eq 'x64' -and $expected['entry'] -eq 'bin/keepwork-mcp.exe') 'Supply a staged Win7/Win8 x64 MCP runtime'
  $executable = Join-Path $runtime 'bin\keepwork-mcp.exe'
  $binaryInfo = New-Object IO.FileInfo -ArgumentList $executable
  $report['artifact'] = @{ executable = $executable; sha256 = Get-Sha256 $executable; size = $binaryInfo.Length;
    version = $expected['version']; commit = $expected['commit']; sourceHash = $expected['sourceHash']; buildTarget = $expected['buildTarget']; runtimeManifestSha256 = Get-Sha256 $manifestPath }
  foreach ($auth in @($false, $true)) {
    $caseDirectory = Join-Path $output ('auth-' + [string][int]$auth)
    $null = [IO.Directory]::CreateDirectory($caseDirectory)
    $caseResult = Run-Case $auth $executable $caseDirectory $expected
    $report['cases'] += $caseResult
    Assert-Condition ($caseResult['passed']) ('Native MCP case failed (requireAuth=' + $auth + '); inspect the local report')
  }
  $report['passed'] = $true
  $report['nativeLegacyVerified'] = [bool]$isNativeLegacy
  $report['nativeWin7Verified'] = [bool]$isNativeWin7
} catch {
  $report['error'] = $_.Exception.Message
} finally {
  $report['completedAtUtc'] = [DateTime]::UtcNow.ToString('o')
  $reportPath = Join-Path $output 'report.json'
  [IO.File]::WriteAllText($reportPath, $script:Json.Serialize($report), $script:Utf8)
}
Write-Output ('Native MCP smoke report: ' + $reportPath)
if (-not $report['passed']) { exit 1 }
if (-not $report['nativeLegacyVerified']) { Write-Output 'Passed on this host; native Win7/Win8 verification remains false.' }
Write-Output 'This report covers only its recorded OS and MCP smoke; other legacy VMs and CEF UI need separate acceptance.'

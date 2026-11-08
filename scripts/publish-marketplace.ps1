$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    $version = node scripts/stable-release.cjs --mode validate
    if ($LASTEXITCODE) { throw 'Extension and MCP release versions must match.' }
    $head = git rev-parse HEAD
    $remote = git ls-remote origin refs/heads/main
    if ($LASTEXITCODE -or !($remote -like "$head`t*") -or (git status --porcelain --untracked-files=normal)) {
        throw 'Publish from a clean checkout of the release commit on origin/main.'
    }
    $vsix = "apps/vscode-extension/keepwork-$version.vsix"
    if (!(Test-Path -LiteralPath $vsix)) { throw "Missing release artifact $vsix" }
    $azureCli = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin'
    if (!(Get-Command az -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $azureCli)) {
        $env:PATH = "$azureCli;$env:PATH"
    }
    & ./apps/vscode-extension/node_modules/.bin/vsce.cmd publish --azure-credential --packagePath $vsix
    if ($LASTEXITCODE) { throw 'Marketplace publish failed.' }
    gh workflow run keepwork-stable.yml --repo LiXizhi/keepworkExtension --ref main -f "marketplace_version=$version"
    if ($LASTEXITCODE) { throw "Marketplace published. Retry coordinated MCP and Desktop code dispatch for version $version." }
} finally {
    Pop-Location
}

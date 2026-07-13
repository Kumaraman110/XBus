<#
.SYNOPSIS
  XBus release-asset installer (Windows). PATH-free by design.

.DESCRIPTION
  Run from an extracted XBus release asset (or a built source checkout). This
  bootstraps the supported entrypoint: it verifies Node, then runs the built CLI's
  `install` from THIS directory. It does NOT modify PATH, the registry, or a shell
  profile. After install, invoke XBus via `node .\dist\cli\main.js <command>` or the
  installed plugin's absolute path (see INSTALL.txt in this folder).

.NOTES
  Requires Node.js >= 22.13 and < 25 (Node 25+ is not yet supported). The bundled
  CLI enforces this floor and refuses an unsupported runtime with an actionable message.
#>
[CmdletBinding()]
param(
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli  = Join-Path $here 'dist\cli\main.js'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is not on PATH. Install Node 22 LTS or Node 24, then re-run .\install.ps1"
  exit 1
}
if (-not (Test-Path $cli)) {
  Write-Error "Built CLI not found at $cli. If this is a source checkout, run: npm install; npm run build"
  exit 1
}

Write-Host "XBus install (PATH-free; no registry or shell-profile changes)..."
$nodeVer = (node --version)
Write-Host "  node: $nodeVer"

if ($DryRun) {
  & node $cli install --dry-run
} else {
  & node $cli install
  if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Installed. XBus did NOT modify PATH. Invoke it with:"
    Write-Host "  node `"$cli`" doctor"
    Write-Host "  node `"$here\dist\launcher\xclaude.js`""
    Write-Host "See INSTALL.txt (in this folder) for verify, launch, and uninstall steps."
  }
}
exit $LASTEXITCODE

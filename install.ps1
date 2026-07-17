<#
.SYNOPSIS
  AgenTel release-asset installer (Windows). Bundled-runtime-first; PATH-free by design.

.DESCRIPTION
  Run from an extracted AgenTel release asset (or a built source checkout). The official Windows
  ZIP ships its OWN pinned Node runtime at runtime\node.exe — this installer VERIFIES that runtime's
  SHA-256 against the asset's SHA256SUMS and then uses it to run the built CLI's `install` from THIS
  directory. You do NOT need Node, npm, NVM, admin rights, or any PATH change. A Node already on
  PATH (even Node 25) is IGNORED when a bundled runtime is present. It does NOT modify PATH, the
  registry, or a shell profile.

  Runtime resolution order:
    1. <extracted-release-root>\runtime\node.exe  (official bundled release — always preferred,
       and only after its SHA-256 is verified against SHA256SUMS)
    2. a complete supported Node 22/24 from PATH   (SOURCE-CHECKOUT / development fallback only)
    3. otherwise: fail with precise remediation

.NOTES
  Supported runtime floor: Node.js >= 22.13 and < 25 (Node 25+ is not yet validated). The bundled
  runtime is a pinned in-floor Node; the PATH fallback is checked against this floor.
#>
[CmdletBinding()]
param(
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$here        = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli         = Join-Path $here 'dist\cli\main.js'
$bundledNode = Join-Path $here 'runtime\node.exe'
$sumsPath    = Join-Path $here 'SHA256SUMS'

function Fail($msg) { Write-Error $msg; exit 1 }

# --- Node version floor check ([22.13, 25)) for the PATH fallback --------------------------------
function Test-NodeInFloor([string]$nodeExe) {
  try { $v = (& $nodeExe --version) 2>$null } catch { return $false }
  if ($v -notmatch '^v(\d+)\.(\d+)\.') { return $false }
  $major = [int]$Matches[1]; $minor = [int]$Matches[2]
  if ($major -lt 22) { return $false }
  if ($major -eq 22 -and $minor -lt 13) { return $false }
  if ($major -ge 25) { return $false }
  return $true
}

# --- Verify the bundled runtime's bytes against SHA256SUMS BEFORE ever executing it --------------
function Test-BundledRuntimeIntegrity {
  if (-not (Test-Path $sumsPath)) {
    Fail "SHA256SUMS is missing from this asset ($sumsPath). Refusing to run the bundled runtime unverified. Re-download the official AgenTel release ZIP."
  }
  # SHA256SUMS lines are: "<hex>  runtime/node.exe" (forward slashes, two spaces).
  $entry = $null
  foreach ($line in (Get-Content -LiteralPath $sumsPath)) {
    if ($line -match '^([0-9a-fA-F]{64})\s+runtime/node\.exe\s*$') { $entry = $Matches[1]; break }
  }
  if (-not $entry) {
    Fail "No SHA256SUMS entry for runtime/node.exe. Refusing to run an unverified bundled runtime. Re-download the official AgenTel release ZIP."
  }
  $actual = (Get-FileHash -LiteralPath $bundledNode -Algorithm SHA256).Hash
  if ($actual -ine $entry) {
    Fail ("Bundled runtime FAILED integrity verification.`n  expected: $($entry.ToLower())`n  actual:   $($actual.ToLower())`nThe file runtime\node.exe does not match SHA256SUMS. Refusing to execute a tampered/corrupted runtime. Re-download the official AgenTel release ZIP.")
  }
}

# --- Resolve the runtime (bundled-first, then PATH fallback) -------------------------------------
$resolvedNode = $null
$runtimeSource = $null

if (Test-Path $bundledNode) {
  # An official bundled release: ALWAYS use runtime\node.exe (never a PATH Node), but only after
  # its integrity is verified. Never silently fall back to global Node when a bundled runtime
  # exists but fails verification — that would defeat the supply-chain check.
  Test-BundledRuntimeIntegrity
  $resolvedNode  = $bundledNode
  $runtimeSource = 'bundled'
} else {
  # Source-checkout / development fallback: a complete supported Node 22/24 from PATH.
  $pathNode = (Get-Command node -ErrorAction SilentlyContinue)
  if ($pathNode -and (Test-NodeInFloor $pathNode.Source)) {
    $resolvedNode  = $pathNode.Source
    $runtimeSource = 'path-fallback'
  } else {
    if ($pathNode) {
      Fail ("No bundled runtime (runtime\node.exe) in this folder, and the Node on PATH ($((& $pathNode.Source --version) 2>$null)) is outside the supported floor [22.13, 25).`nInstall Node 22 LTS or Node 24, or use the official AgenTel release ZIP (which bundles its own runtime).")
    }
    Fail ("No bundled runtime (runtime\node.exe) in this folder, and no Node on PATH.`nFor a source checkout: install Node 22 LTS or Node 24 and re-run .\install.ps1.`nFor an end user: download the official AgenTel Windows release ZIP, which includes its own pinned Node runtime (no Node install needed).")
  }
}

if (-not (Test-Path $cli)) {
  Fail "Built CLI not found at $cli. If this is a source checkout, run: npm install; npm run build"
}

# --- Concise output ------------------------------------------------------------------------------
$nodeVer = (& $resolvedNode --version)
$action  = if ($DryRun) { 'dry-run (no changes written)' } else { 'install (user scope; no PATH/registry/profile changes)' }
Write-Host "AgenTel installer"
Write-Host "  runtime source: $runtimeSource"
Write-Host "  runtime:        $resolvedNode ($nodeVer)"
Write-Host "  action:         $action"

# --- Invoke the CLI by the RESOLVED ABSOLUTE runtime path ----------------------------------------
# The CLI defaults its install SOURCE to the current working directory (process.cwd()). The plugin
# payload lives in THIS folder ($here), so the CLI must run WITH $here as the cwd — otherwise, when
# install.ps1 is invoked from another directory, the source resolves to the caller's cwd and the CLI
# rejects it ("source is not a valid XBus plugin payload"). Save the caller's directory, switch to
# $here for the invocation, and ALWAYS restore it in `finally`. Preserve the CLI exit code.
$callerCwd = (Get-Location).Path
$cliExit = 1
try {
  Set-Location -LiteralPath $here
  if ($DryRun) {
    & $resolvedNode $cli install --dry-run
    $cliExit = $LASTEXITCODE
  } else {
    & $resolvedNode $cli install
    $cliExit = $LASTEXITCODE
    if ($cliExit -eq 0) {
      Write-Host ""
      Write-Host "Installed. AgenTel did NOT modify PATH, the registry, or your shell profile. Invoke it with:"
      Write-Host "  & `"$resolvedNode`" `"$cli`" doctor"
      Write-Host "  & `"$resolvedNode`" `"$here\dist\launcher\xclaude.js`""
      Write-Host "See INSTALL.txt (in this folder) for verify, launch, and uninstall steps."
    }
  }
} finally {
  Set-Location -LiteralPath $callerCwd
}
exit $cliExit

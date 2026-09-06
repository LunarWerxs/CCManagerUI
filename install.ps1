<#
.SYNOPSIS
  Install AgentHydra on Windows, verifying the download against the release's published SHA-256.

.DESCRIPTION
  We ship a bare .exe and a ZIP, and the instructions were "download it and put it somewhere". That
  works, and it also means nobody checks what they downloaded — so this script exists mainly to make
  the checksum step the DEFAULT rather than an extra thing a careful person does by hand.

  THE VERIFICATION IS THE POINT, so it is not optional and there is no -SkipVerify switch. Every
  release publishes SHA256SUMS.txt (see docs/RELEASING.md), generated in the same workflow job that
  uploads the binaries. This downloads that file, finds the line for the asset it just fetched, and
  compares. A mismatch deletes the download and stops. An installer that would proceed anyway is an
  installer whose checksum step is decoration.

  What it does NOT do, deliberately:
    * No elevation. Everything lands under %LOCALAPPDATA%, so this never needs Administrator, and a
      script fetched from the internet asking for admin is a habit worth not teaching.
    * No PATH edit, no registry writes, no service. It copies files and optionally makes a shortcut.
    * No auto-start. AgentHydra has its own update path once installed (docs/RELEASING.md).

.PARAMETER Version
  A specific release tag (e.g. v0.19.3). Defaults to the latest published release.

.PARAMETER InstallDir
  Where to install. Defaults to %LOCALAPPDATA%\Programs\AgentHydra.

.PARAMETER NoShortcut
  Skip creating the Start Menu shortcut.

.PARAMETER Force
  Install even though AgentHydra (or its tray host) appears to be running. Without this, a
  detected running instance stops the install before anything on disk is touched (AH-40 — a
  running exe or tray host can hold files open mid-copy, which used to corrupt an in-place copy
  silently instead of refusing).

.PARAMETER FromZip
  Install this local ZIP instead of downloading a release (skips the GitHub API lookup and the
  SHA256SUMS.txt fetch). For offline/test use; real users never need this.

.PARAMETER Sha256
  Verify -FromZip against this SHA-256 hash before installing it. Optional; only meaningful with
  -FromZip (the normal download path always verifies against the release's own SHA256SUMS.txt).

.PARAMETER NoLaunch
  Skip copying the shortcut into the real Start Menu (the per-install shortcut file is still
  written). Used by the test suite so an offline install never touches the machine's actual
  Start Menu.

.EXAMPLE
  irm https://raw.githubusercontent.com/LunarWerxs/AgentHydra/main/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Version v0.19.3 -InstallDir D:\Tools\AgentHydra
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\AgentHydra'),
  [switch]$NoShortcut,
  [switch]$Force,
  [string]$FromZip,
  [string]$Sha256,
  [switch]$NoLaunch,
  # TEST SEAM (AH-40), not documented above on purpose: throw right after the named component has
  # been renamed aside but before its replacement is moved in, to prove the rollback path restores
  # a fully-working prior install. Real installs never pass this.
  [ValidateSet('exe', 'misc', 'orchestrator')]
  [string]$FailAfterStage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Sha256 -and -not $FromZip) { throw "-Sha256 only applies together with -FromZip." }

$Repo = 'LunarWerxs/AgentHydra'

# --- release-owned components ---------------------------------------------------------------
# The complete windows-x64 payload, per .github/workflows/release.yml's "Compile + package" step
# (~line 90-137): AgentHydra.exe at the root, plus misc/ and orchestrator/ beside it. This is the
# other consumer is server/src/github-updater.ts's RELEASE_COMPONENTS, which since AH-08 swaps
# orchestrator/ and reconciles misc/ alongside the exe. The two lists must name the same
# components, and they cannot drift unnoticed: server/tests/github-updater-components.test.ts
# parses THIS block and asserts it matches RELEASE_COMPONENTS.
$ReleaseComponents = @(
  [pscustomobject]@{ Name = 'exe';          RelPath = 'AgentHydra.exe' }
  [pscustomobject]@{ Name = 'misc';         RelPath = 'misc' }
  [pscustomobject]@{ Name = 'orchestrator'; RelPath = 'orchestrator' }
)

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }

# --- architecture -------------------------------------------------------------
# Only windows-x64 is built today (see the matrix in .github/workflows/release.yml). An arm64
# machine is told so plainly rather than handed an x64 binary that will run under emulation with no
# indication of why it is slow.
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') {
  throw "No ARM64 build is published yet. On an ARM64 machine, run the x64 build under emulation at your own discretion, or build from source with 'bun run dist'."
}
if ($arch -ne 'AMD64') {
  throw "Unsupported architecture '$arch'. AgentHydra publishes a Windows x64 build."
}
$target = 'windows-x64'

# --- which release ------------------------------------------------------------
$tag = $null
$release = $null
$asset = $null
$sums = $null
if ($FromZip) {
  Write-Step 'Using a local ZIP (offline/test install)'
  if (-not (Test-Path $FromZip)) { throw "-FromZip path does not exist: $FromZip" }
  Write-Note (Resolve-Path $FromZip).Path
} else {
  Write-Step 'Finding the release'
  $headers = @{ 'User-Agent' = 'agenthydra-install' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

  $releaseUrl = if ($Version) {
    "https://api.github.com/repos/$Repo/releases/tags/$Version"
  } else {
    "https://api.github.com/repos/$Repo/releases/latest"
  }
  $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers
  $tag = $release.tag_name
  Write-Note "release $tag"

  # The ZIP, not the bare .exe: it carries the tray toolkit (misc\), without which the app can only
  # run console-style. That was a real regression once — see the long comment in release.yml.
  $assetName = "AgentHydra-$($tag.TrimStart('v'))-$target.zip"
  $asset = $release.assets | Where-Object { $_.name -eq $assetName }
  if (-not $asset) {
    $available = ($release.assets | ForEach-Object { $_.name }) -join ', '
    throw "Release $tag has no asset named '$assetName'. It published: $available"
  }
  $sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }
  if (-not $sums) {
    throw "Release $tag published no SHA256SUMS.txt, so the download cannot be verified. Refusing to install."
  }
}

# --- download -----------------------------------------------------------------
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("agenthydra-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  if ($FromZip) {
    $assetName = Split-Path $FromZip -Leaf
    $zipPath = Join-Path $work $assetName
    Copy-Item -LiteralPath $FromZip -Destination $zipPath -Force
    if ($Sha256) {
      Write-Step 'Verifying SHA-256'
      $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
      $expectedHash = $Sha256.Trim().ToLowerInvariant()
      if ($actual -ne $expectedHash) {
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        throw "Checksum mismatch for $assetName.`n  expected $expectedHash`n  actual   $actual`nThe file was not installed."
      }
      Write-Note "sha256 $actual"
    }
  } else {
    $zipPath = Join-Path $work $assetName
    Write-Step "Downloading $assetName"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -Headers $headers

    Write-Step 'Verifying SHA-256'
    $sumsPath = Join-Path $work 'SHA256SUMS.txt'
    Invoke-WebRequest -Uri $sums.browser_download_url -OutFile $sumsPath -Headers $headers

    # sha256sum's format is "<hash>  <path>", and the path side carries the build's own directory
    # prefix (`out/`), so match on the leaf rather than the whole field.
    $expected = $null
    foreach ($line in Get-Content $sumsPath) {
      $parts = $line -split '\s+', 2
      if ($parts.Count -eq 2 -and ((Split-Path $parts[1].Trim() -Leaf) -eq $assetName)) {
        $expected = $parts[0].Trim().ToLowerInvariant()
        break
      }
    }
    if (-not $expected) { throw "SHA256SUMS.txt has no entry for $assetName. Refusing to install." }

    $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
      throw "Checksum mismatch for $assetName.`n  expected $expected`n  actual   $actual`nThe download was deleted. Do not install it."
    }
    Write-Note "sha256 $actual"
  }

  # --- install ----------------------------------------------------------------
  Write-Step "Installing to $InstallDir"

  $extract = Join-Path $work 'extract'
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  # The archive holds one top-level folder named after the release.
  $payload = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
  if (-not $payload) { throw "The archive did not contain the expected folder." }

  # --- (a) stage the payload on the DESTINATION volume ---------------------------------------
  # A sibling of $InstallDir shares its drive even before $InstallDir itself exists (a fresh
  # install), so the real swap below (Move-Item / Rename-Item) is a rename, never a cross-volume
  # copy — the thing that made the old in-place Copy-Item vulnerable to a disk-full or interrupted
  # partial write in the first place (AH-40).
  $stamp = Get-Date -Format 'yyyyMMddHHmmssfff'
  $staging = "$InstallDir.staging-$stamp"
  if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  try {
    Copy-Item -Path (Join-Path $payload.FullName '*') -Destination $staging -Recurse -Force

    # --- (b) validate the COMPLETE staged payload before anything real is touched ------------
    foreach ($c in $ReleaseComponents) {
      $p = Join-Path $staging $c.RelPath
      if (-not (Test-Path $p)) {
        throw "The staged release is missing '$($c.RelPath)' ($($c.Name)) — refusing to install a partial payload."
      }
    }
    $stagedExe = Join-Path $staging 'AgentHydra.exe'

    # Canary, the same one the release workflow and the self-updater run — but on the STAGED
    # copy, before anything real is replaced. A binary that cannot print its own version, or
    # prints the wrong one, is not one to swap in for a working install.
    $reported = & $stagedExe --version
    if ($LASTEXITCODE -ne 0) {
      throw "The staged AgentHydra.exe exited $LASTEXITCODE on --version — refusing to install it."
    }
    $reportedVersion = ([string]$reported).Trim().TrimStart('v')
    $expectedVersion = $null
    if ($tag) {
      $expectedVersion = $tag.TrimStart('v')
    } elseif ($payload.Name -match '^AgentHydra-(?<v>[0-9][0-9.]*)-') {
      $expectedVersion = $Matches['v']
    }
    if ($expectedVersion -and $reportedVersion -ne $expectedVersion) {
      throw "Version canary failed: the staged build reports '$reportedVersion' but the release is '$expectedVersion' — refusing to install it."
    }
    Write-Note "staged version $reportedVersion"

    # --- (c) refuse to swap under a running instance, unless told otherwise ------------------
    if (-not $Force) {
      $runningProcs = Get-Process -Name 'AgentHydra', 'lunarwerx-tray' -ErrorAction SilentlyContinue
      $configDir = if ($env:AGENTHYDRA_HOME) { $env:AGENTHYDRA_HOME } else { Join-Path $env:USERPROFILE '.agenthydra' }
      $runtimeFile = Join-Path $configDir 'runtime.json'
      $liveFromPointer = $false
      if (Test-Path $runtimeFile) {
        try {
          $ptr = Get-Content $runtimeFile -Raw | ConvertFrom-Json
          if ($ptr.pid -and (Get-Process -Id $ptr.pid -ErrorAction SilentlyContinue)) { $liveFromPointer = $true }
        } catch { }
      }
      if ($runningProcs -or $liveFromPointer) {
        $names = ($runningProcs | Select-Object -ExpandProperty Name -Unique) -join ', '
        throw "AgentHydra appears to be running$(if ($names) { " (process: $names)" }). Quit it from the tray (or pass -Force) and run this again."
      }
    }

    # --- (d) swap each release-owned component atomically, with a same-transaction rollback --
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $movedAside = @()
    try {
      foreach ($c in $ReleaseComponents) {
        $target = Join-Path $InstallDir $c.RelPath
        $aside = "$target.old-$stamp"
        $wasPresent = Test-Path $target
        if ($wasPresent) {
          Rename-Item -LiteralPath $target -NewName (Split-Path $aside -Leaf) -Force
        }
        $movedAside += [pscustomobject]@{ Name = $c.Name; Target = $target; Aside = $aside; WasPresent = $wasPresent }

        # (e) orchestrator/state/ is USER data (the scheduler's ledger, see
        # orchestrator/scripts/lib/ledgerlib.py's _state_dir()) living inside an otherwise
        # release-owned folder. Carry it across rather than let a fresh orchestrator/ drop it.
        #
        # COPY, NEVER MOVE, and the distinction is the whole transaction. A move takes the only
        # copy of the ledger OUT of the rollback aside and into the staging directory - and the
        # outer `finally` deletes staging unconditionally. So a failure anywhere after this point
        # (the component move below, a later component, the injected test seam) rolled back an
        # orchestrator/ whose state/ had already been deleted with the staging dir: the one folder
        # this whole transactional install exists to protect. Copying leaves the ledger in the
        # aside until the swap has fully succeeded, and the aside is removed only then, so no
        # duplicate survives either. Found by adversarial verification of AH-40, 2026-09-06.
        if ($c.Name -eq 'orchestrator' -and $wasPresent) {
          $oldState = Join-Path $aside 'state'
          if (Test-Path $oldState) {
            $newState = Join-Path (Join-Path $staging $c.RelPath) 'state'
            if (Test-Path $newState) { Remove-Item $newState -Recurse -Force }
            Copy-Item -LiteralPath $oldState -Destination $newState -Recurse -Force
          }
        }

        if ($FailAfterStage -eq $c.Name) {
          throw "injected failure after staging '$($c.Name)' aside (test seam -FailAfterStage)"
        }

        Move-Item -LiteralPath (Join-Path $staging $c.RelPath) -Destination $target -Force
      }
      # Every component landed — the old copies are no longer needed.
      foreach ($m in $movedAside) {
        if ($m.WasPresent -and (Test-Path $m.Aside)) { Remove-Item $m.Aside -Recurse -Force -ErrorAction SilentlyContinue }
      }
    } catch {
      Write-Step 'Install failed mid-swap — rolling back'
      foreach ($m in $movedAside) {
        if (Test-Path $m.Target) { Remove-Item $m.Target -Recurse -Force -ErrorAction SilentlyContinue }
        if ($m.WasPresent -and (Test-Path $m.Aside)) {
          Rename-Item -LiteralPath $m.Aside -NewName (Split-Path $m.Target -Leaf) -Force
        }
      }
      throw
    }
  } finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
  }

  $exe = Join-Path $InstallDir 'AgentHydra.exe'
  if (-not (Test-Path $exe)) { throw "AgentHydra.exe is missing from $InstallDir after installing." }
  Write-Note "installed version $reportedVersion"

  if (-not $NoShortcut) {
    Write-Step 'Creating the tray shortcut'
    # The shortcut launches misc\lunarwerx-tray.exe, NOT AgentHydra.exe. The exe on its own runs
    # the daemon and opens the UI; the tray icon, the auto-restart supervisor and Quit all live in
    # the tray HOST. A shortcut aimed at the bare exe (which is what this block used to make)
    # produced a working app with no tray on every machine that never also ran
    # misc\Create-Shortcut.ps1 by hand - a separate step the docs asked for and nobody took
    # (owner's PC, 2026-09-03). One recipe, the kit's own, so this cannot drift from what
    # Create-Shortcut.ps1 makes: it drops AgentHydra.lnk beside the exe, and the Start Menu gets a
    # copy of that same file.
    $misc = Join-Path $InstallDir 'misc'
    . (Join-Path $misc 'New-TrayShortcut.ps1')
    New-TrayShortcut -Root $InstallDir -ScriptDir $misc `
      -LnkName 'AgentHydra' `
      -IconFile 'AgentHydra.ico' `
      -Description 'Launch AgentHydra (system tray)' `
      -ExeFile 'lunarwerx-tray.exe' `
      -ExeArguments 'AgentHydra-Tray.json'
    $lnk = Join-Path $InstallDir 'AgentHydra.lnk'
    if (-not $NoLaunch) {
      $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
      Copy-Item -LiteralPath $lnk -Destination (Join-Path $startMenu 'AgentHydra.lnk') -Force
    } else {
      Write-Note "Skipping the Start Menu entry (-NoLaunch) — the shortcut still lives at $lnk"
    }
  }

  Write-Host ''
  Write-Host "AgentHydra $reported is installed." -ForegroundColor Green
  Write-Host "  $exe"
  if (-not $NoShortcut) {
    Write-Host "  Launch it from the Start Menu entry 'AgentHydra' (or $InstallDir\AgentHydra.lnk) to get the tray icon."
  }
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

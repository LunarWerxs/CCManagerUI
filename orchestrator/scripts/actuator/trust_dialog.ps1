# trust_dialog.ps1 - answer the desktop app's "Trust this workspace?" modal for ONE named
# folder, through the app's own control (accessibility invoke: no cursor, no coordinates).
#
# WHY THIS EXISTS (owner, 2026-09-01: "you don't seem to understand how to trust workspaces
# when starting a chat on one that's not trusted"). A chat asked to start in a folder the app
# has not trusted stops on a modal. Nothing else in this toolbox can answer a modal, so the
# chat sits there forever, invisible to every rail.
#
# ⛔ AND THE FILE-FIRST FIX DOES NOT WORK, measured twice on 2026-09-01: writing
# `projects["<path>"].hasTrustDialogAccepted = true` into ~/.claude.json (both slash forms)
# left the dialog appearing anyway. That file is the CLI's trust list; the DESKTOP app keeps
# its own, and its checker memoizes. So the honest mechanical answer is the same one the rest
# of this system uses for app state: drive the app's own control.
#
# THE AIM RAIL, because this is a SECURITY dialog and a wrong click trusts the wrong folder:
# the dialog must NAME the exact folder we expect (-Folder, compared case-insensitively with
# both slash forms). No match = refuse (exit 4). It never "just clicks Trust" on whatever is
# on screen, and it never answers a dialog it cannot read the folder out of.
#
# Exit: 0 trusted - 3 no trust dialog on screen (nothing to do) - 4 a dialog is up but for a
#       DIFFERENT folder (refused) - 1 error.
#
# -Instance IS MANDATORY (2026-09-06, review: an unscoped scan could answer a DIFFERENT
# spawned instance's dialog). Matched exactly the same way every sibling actuator matches: an
# exact --user-data-dir for a path-shaped -Instance, an exact leaf-folder-name match
# (case-insensitive) for a bare one - never a substring, never "take the first" on ambiguity.
param(
  [Parameter(Mandatory = $true)][string]$Folder,
  [Parameter(Mandatory = $true)][string]$Instance,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Norm([string]$p) { return ($p -replace '\\', '/').TrimEnd('/').ToLowerInvariant() }
$want = Norm $Folder

# Resolve THIS instance's process first, so the dialog scan below is scoped to windows ONLY
# this process owns - never a different spawned instance's dialog.
$mains = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    $m = [regex]::Match($_.CommandLine, '"--user-data-dir=([^"]+)"')
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(\S+)') }
    $dir = if ($m.Success) { $m.Groups[1].Value.Trim() } else { Join-Path $env:APPDATA 'Claude' }
    [pscustomobject]@{ ProcId = $_.ProcessId; Dir = $dir }
  }
if ($Instance -match '[\\/]') {
  $mains = @($mains | Where-Object { $_.Dir.TrimEnd('\') -eq $Instance.TrimEnd('\') })
} else {
  $mains = @($mains | Where-Object { (Split-Path $_.Dir -Leaf) -ieq $Instance })
}
if ($mains.Count -ne 1) {
  $candidates = ($mains | ForEach-Object { $_.Dir }) -join ', '
  Write-Output "FAIL: $($mains.Count) running process(es) match instance '$Instance'$(if ($candidates) { " - candidates: $candidates" })"
  exit 1
}
$procId = [int]$mains[0].ProcId

$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = [System.Windows.Automation.TreeScope]::Children
$desc = [System.Windows.Automation.TreeScope]::Descendants
# Scope every top-level window this scan looks at to THIS instance's process id - the aim rail
# that makes the folder-name check below a second, belt-and-braces confirmation rather than the
# only thing standing between this actuator and someone else's dialog.
$pidCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procId)

$sawAnyDialog = $false
foreach ($w in $root.FindAll($children, $pidCond)) {
  $wn = $w.Current.Name
  if (-not $wn -or ($wn -notmatch 'Claude' -and $wn -notmatch 'Trust this workspace')) { continue }
  $all = $w.FindAll($desc, [System.Windows.Automation.Condition]::TrueCondition)

  $sawDialog = $false
  $folderMatches = $false
  foreach ($e in $all) {
    $n = $e.Current.Name
    if (-not $n) { continue }
    if ($n -match 'Trust this workspace') { $sawDialog = $true }
    # the dialog prints the folder as its own text element
    if ((Norm $n) -eq $want) { $folderMatches = $true }
  }
  if (-not $sawDialog) { continue }
  $sawAnyDialog = $true
  if (-not $folderMatches) {
    # this instance can own more than one top-level window (main + dialog); another one of
    # THIS SAME process's windows may still carry our dialog - keep scanning instead of
    # refusing off the first mismatch (race fix). The pid scope above already rules out a
    # DIFFERENT instance's window reaching this point at all.
    continue
  }
  foreach ($e in $all) {
    try {
      if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.Button') { continue }
      if ($e.Current.IsOffscreen) { continue }
      $bn = $e.Current.Name
      if (-not $bn -or $bn -notmatch '^(Trust workspace|Trust|Yes, I trust)') { continue }
      if ($WhatIf) { Write-Output "WOULD INVOKE '$bn' for $Folder"; exit 0 }
      $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      Write-Output "TRUSTED '$Folder' through the app's own control (button '$bn')"
      exit 0
    } catch { continue }
  }
  Write-Output "FAIL: the dialog for '$Folder' is up but exposes no invokable trust button"
  exit 1
}
if ($sawAnyDialog) {
  Write-Output "REFUSED: a trust dialog is up, but none of them name '$Folder' - not trusting someone else's folder"
  exit 4
}
Write-Output "no trust dialog on screen"
exit 3

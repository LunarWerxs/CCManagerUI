# window_placement.ps1 - remember how the owner had a desktop window, and put it back.
#
# WHY (owner, 2026-09-01: "often I'm noticing you end up full screening the desktop instance
# for some reason - we should stop that from happening").
#
# THE CAUSE, and it is not a stray click: every re-render route the toolbox has goes through
# the app's OWN deeplink (claude://resume?session=... to re-render a row, claude://code/new
# to spawn one). Electron's single-instance lock forwards that URL to the RUNNING app, and the
# app's second-instance handler shows/restores/raises its window as part of handling it. That
# is the app being helpful, not us clicking - so it cannot be switched off from outside. What
# CAN be done is what a considerate person would do: note how the window was before, and put
# it back exactly that way afterwards.
#
# So this is capture/restore of the Win32 WINDOWPLACEMENT (the same struct Windows itself uses
# to remember a window across a restore), keyed by the instance's --user-data-dir.
#
#   -Capture -Instance <dir>            -> one JSON line: the placement, to hand back later
#   -Apply   -Instance <dir> -State <j> -> put it back, but ONLY if it actually changed
#
# ⛔ IT NEVER RAISES, FOCUSES OR MOVES A WINDOW ON ITS OWN. SetWindowPlacement with the exact
# struct that was read a moment earlier is a no-op when nothing changed, and this refuses to
# call it at all in that case - so the quiet path stays genuinely quiet. It also never touches
# a window the owner has MINIMIZED between the two calls: a person who minimized it since we
# looked has said something, and restoring over that would be the same rudeness in reverse.
#
# Exit: 0 fine (captured, restored, or nothing to do) - 1 no matching window.

param(
  [switch]$Capture,
  [switch]$Apply,
  [Parameter(Mandatory = $true)][string]$Instance,
  [string]$State = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace Orch -Name Win -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)]
public struct WINDOWPLACEMENT {
  public int length; public int flags; public int showCmd;
  public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
}
[DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
[DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
'@

# The instance's MAIN window, matched the same way every sibling actuator matches (2026-09-06):
# exact --user-data-dir for a path-shaped -Instance, exact LEAF folder name for a bare one - never
# a substring ("pap3r rotate" is inside "pap3r rotate2") - and anything but exactly one match is
# a refusal.
$procs = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    $m = [regex]::Match($_.CommandLine, '"--user-data-dir=([^"]+)"')
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(\S+)') }
    $dir = if ($m.Success) { $m.Groups[1].Value.Trim() } else { Join-Path $env:APPDATA 'Claude' }
    [pscustomobject]@{ ProcId = $_.ProcessId; Dir = $dir }
  }
if ($Instance -match '[\\/]') {
  $procs = @($procs | Where-Object { $_.Dir.TrimEnd('\') -eq $Instance.TrimEnd('\') })
} else {
  # EXACT leaf-name match, never a substring: '-Instance main' must not also match 'main2'
  # (mirrors rename_first.ps1's aim rail; review, 2026-09-06 - a substring hit could place a
  # WRONG window's window).
  $procs = @($procs | Where-Object { (Split-Path $_.Dir -Leaf) -ieq $Instance })
}
# ZERO or MORE THAN ONE match is a refusal, never "take the first" (2026-09-06).
if ($procs.Count -ne 1) {
  $candidates = ($procs | ForEach-Object { $_.Dir }) -join ', '
  Write-Output "FAIL: $($procs.Count) running window(s) match instance '$Instance'$(if ($candidates) { " - candidates: $candidates" })"
  exit 1
}

$hwnd = [IntPtr]::Zero
foreach ($p in $procs) {
  $h = (Get-Process -Id $p.ProcId -ErrorAction SilentlyContinue).MainWindowHandle
  if ($h -and $h -ne [IntPtr]::Zero) { $hwnd = $h; break }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "no window for instance '$Instance'"; exit 1 }

$wp = New-Object Orch.Win+WINDOWPLACEMENT
$wp.length = [System.Runtime.InteropServices.Marshal]::SizeOf($wp)
[void][Orch.Win]::GetWindowPlacement($hwnd, [ref]$wp)

if ($Capture) {
  # showCmd: 1 normal, 2 minimized, 3 maximized. rcNormalPosition is the RESTORE rect, which
  # is what makes putting a window back honest rather than approximate.
  $out = @{
    showCmd = $wp.showCmd; flags = $wp.flags
    left = $wp.rcNormalPosition.Left; top = $wp.rcNormalPosition.Top
    right = $wp.rcNormalPosition.Right; bottom = $wp.rcNormalPosition.Bottom
  }
  Write-Output ($out | ConvertTo-Json -Compress)
  exit 0
}

if (-not $Apply) { Write-Output 'pass -Capture or -Apply'; exit 1 }
if (-not $State) { Write-Output 'no -State to restore'; exit 1 }
$want = $State | ConvertFrom-Json

if ($wp.showCmd -eq $want.showCmd) { Write-Output "unchanged (showCmd $($wp.showCmd)) - left alone"; exit 0 }
if ($wp.showCmd -eq 2) { Write-Output 'the owner minimized it since - left alone'; exit 0 }

$wp.showCmd = [int]$want.showCmd
$wp.rcNormalPosition.Left = [int]$want.left
$wp.rcNormalPosition.Top = [int]$want.top
$wp.rcNormalPosition.Right = [int]$want.right
$wp.rcNormalPosition.Bottom = [int]$want.bottom
[void][Orch.Win]::SetWindowPlacement($hwnd, [ref]$wp)
Write-Output "restored showCmd $($want.showCmd) for '$Instance'"
exit 0

# actuator/rename_first.ps1 - THE NAMING PASS's UIA half (proven live 11/11, 2026-08-31).
# A deliberate variant of AgentHydra's Manage-DesktopChat.ps1 rename path: when several
# rendered rows share the target name (a batch of fresh imports all rendering the same
# no-name), it takes the FIRST match instead of refusing - safe ONLY because the caller
# (scripts/name_chats.py) renames to a unique PROBE name and then identifies which chat took
# it from the app's own meta re-save. Everything else (focus-free UIA, label tables,
# structural editor detection) is cloned from the proven original. Should eventually live in
# AgentHydra as a daemon endpoint; it sits here so the orchestrator's naming law is
# enforceable today.
param(
  [string]$Instance = 'temp1',
  [string[]]$MatchNames = @('Untitled', 'General coding session'),
  [Parameter(Mandatory = $true)][string]$NewTitle
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$src = @'
using System;using System.Runtime.InteropServices;using System.Collections.Generic;using System.Text;
public static class Ax{
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumFunc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int m);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [In,Out,MarshalAs(UnmanagedType.IUnknown)] ref object p);
  [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  delegate bool EnumFunc(IntPtr h, IntPtr l);
  static List<IntPtr> widgets(IntPtr top){
    var ws = new List<IntPtr>();
    EnumChildWindows(top, (h,l) => { var sb = new StringBuilder(256); GetClassName(h, sb, 256); if (sb.ToString().Contains("Chrome_RenderWidgetHostHWND")) ws.Add(h); return true; }, IntPtr.Zero);
    return ws;
  }
  public static void PostEnter(IntPtr top){
    foreach (var w in widgets(top)) {
      PostMessageW(w, 0x0100, (IntPtr)0x0D, (IntPtr)0x001C0001);
      System.Threading.Thread.Sleep(50);
      PostMessageW(w, 0x0101, (IntPtr)0x0D, unchecked((IntPtr)(long)0xC01C0001));
    }
  }
  public static void PostEsc(IntPtr top){
    foreach (var w in widgets(top)) {
      PostMessageW(w, 0x0100, (IntPtr)0x1B, (IntPtr)0x00010001);
      System.Threading.Thread.Sleep(50);
      PostMessageW(w, 0x0101, (IntPtr)0x1B, unchecked((IntPtr)(long)0xC0010001));
    }
  }
  public static void Wake(IntPtr top){
    Guid g = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    var ws = new List<IntPtr>();
    EnumChildWindows(top, (h,l) => { var sb = new StringBuilder(256); GetClassName(h, sb, 256); if (sb.ToString().Contains("Chrome_RenderWidgetHostHWND")) ws.Add(h); return true; }, IntPtr.Zero);
    foreach (var w in ws) { object a = null; AccessibleObjectFromWindow(w, 0xFFFFFFFC, ref g, ref a); }
  }
}
'@
Add-Type -TypeDefinition $src

$root = [System.Windows.Automation.AutomationElement]::RootElement
$TREE = [System.Windows.Automation.TreeScope]::Descendants
$BTN = [System.Windows.Automation.ControlType]::Button

function Wake([IntPtr]$hwnd) { [Ax]::Wake($hwnd); Start-Sleep -Milliseconds 800; return [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) }
function TryPattern($e, $pat) { try { return $e.GetCurrentPattern($pat) } catch { return $null } }

$RENAME_LABELS = @('Rename', 'Umbenennen', 'Renommer', 'Cambiar nombre', 'Rinomina', 'Hernoemen')

$mains = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    $m = [regex]::Match($_.CommandLine, '"--user-data-dir=([^"]+)"')
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir="([^"]+)"') }
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(\S+)') }
    $dir = if ($m.Success) { $m.Groups[1].Value.Trim() } else { Join-Path $env:APPDATA 'Claude' }
    [pscustomobject]@{ ProcId = $_.ProcessId; Dir = $dir }
  }
# EXACT leaf-name match, never a substring: '-Instance main' must not also match 'main2', and
# with several hits $mains[0] would be whichever WMI enumerated first - a wrong-window probe
# renames a random chat in an UNRELATED instance (review finding, 2026-08-31).
$mains = @($mains | Where-Object { (Split-Path $_.Dir -Leaf) -ieq $Instance })
if (-not $mains) { Write-Output "FAIL: no running instance whose dir leaf is exactly '$Instance'"; exit 1 }
if ($mains.Count -gt 1) { Write-Output "FAIL: $($mains.Count) running instances share the leaf '$Instance' - refusing to guess"; exit 1 }
$m = $mains[0]

$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$m.ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output 'FAIL: no top-level window for that pid'; exit 1 }
$hwndTop = [IntPtr]$win.Current.NativeWindowHandle
# Start clean: dismiss any context menu or editor a previous flaked pass left open.
[Ax]::PostEsc($hwndTop); Start-Sleep -Milliseconds 400
$el = Wake $hwndTop

# LEAVE THE SIDEBAR AS IT WAS FOUND, AND OPEN ONLY SIDEBAR GROUPS (owner, 2026-09-04:
# "something keeps clicking interface buttons on my Claude desktop, like the repo names").
# This pass used to expand EVERY collapsed ExpandCollapse control with a short name - the exact
# shape the owner caught on 2026-09-01 ("it's still clicking random shit... trying to select the
# model"), fixed in manage_desktop_chat.ps1 that day and never here: the MODEL PICKER and every
# toolbar dropdown are ExpandCollapse controls with short names. Now: a group is identified
# POSITIVELY by its "New session in <group>" companion button (the app's own shape, nothing
# else in the window has one), every group this run opens is remembered, and the finally folds
# them all back whatever the outcome (`exit` runs the finally).
$script:OpenedGroups = @()
function RestoreGroups {
  $n = 0
  foreach ($ecp in $script:OpenedGroups) { try { $ecp.Collapse(); $n++ } catch { } }
  $script:OpenedGroups = @()
  if ($n -gt 0) { Write-Output "collapsed $n sidebar group(s) back the way they were" }
}
try {
$groupNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$landmarkElems = @()
foreach ($b in $el.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
  try {
    $n = $b.Current.Name
    if ($n -and $n.Length -gt 15 -and $n.StartsWith('New session in ')) { [void]$groupNames.Add($n.Substring(15).Trim()); $landmarkElems += $b }
  } catch { continue }
}
foreach ($e in $el.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
  try {
    $n = $e.Current.Name
    if (-not $n -or -not $groupNames.Contains($n.Trim())) { continue }
    $ec = TryPattern $e ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if (-not $ec) { continue }
    if ($ec.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Collapsed) { continue }
    $ec.Expand(); $script:OpenedGroups += $ec; Start-Sleep -Milliseconds 250
  } catch { continue }
}
$el = Wake $hwndTop

# LOCATE THE SIDEBAR/CHAT-LIST CONTAINER POSITIVELY, THEN SCOPE THE KEBAB SEARCH TO IT
# (2026-09-06, review: an unscoped FindAll over the WHOLE window can pick up a kebab-shaped
# button elsewhere in the UI - e.g. a leftover dialog from a previous flaked pass - and rename
# the wrong thing). Same landmark technique the group-expand pass above already uses: walk up
# from a "New session in X" button (the app's own per-group marker, nothing else in the window
# has one) to the nearest ancestor that contains ALL of them - that ancestor IS the chat list.
$sidebar = $null
if ($landmarkElems.Count -gt 0) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $cur = $null
  try { $cur = $walker.GetParent($landmarkElems[0]) } catch { $cur = $null }
  $depth = 0
  while ($cur -and $depth -lt 25) {
    $hits = 0
    try {
      foreach ($e in $cur.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
        try { $n = $e.Current.Name; if ($n -and $n.Length -gt 15 -and $n.StartsWith('New session in ')) { $hits++ } } catch { continue }
      }
    } catch { $hits = 0 }
    if ($hits -ge $landmarkElems.Count) { $sidebar = $cur; break }
    $parent = $null
    try { $parent = $walker.GetParent($cur) } catch { $parent = $null }
    if (-not $parent) { break }
    $cur = $parent
    $depth++
  }
}
# No group landmark exists when every chat is ungrouped - fall back to the whole window rather
# than refuse a fleet with no groups at all.
$scope = if ($sidebar) { $sidebar } else { $el }

# First kebab whose name ends with any match name (word-boundary preferred).
$c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
$kebab = $null
$rowName = $null
foreach ($b in $scope.FindAll($TREE, $c)) {
  $n = $b.Current.Name
  if (-not $n) { continue }
  if (-not (TryPattern $b ([System.Windows.Automation.ExpandCollapsePattern]::Pattern))) { continue }
  foreach ($mn in $MatchNames) {
    if ($n.EndsWith(' ' + $mn) -or $n -eq $mn) { $kebab = $b; $rowName = $mn; break }
  }
  if ($kebab) { break }
}
if (-not $kebab) { Write-Output 'NONE-RENDERED: no row matching the no-name patterns is reachable'; exit 3 }
Write-Output "target row renders as '$rowName' (kebab: '$($kebab.Current.Name)')"
# The kebab's position anchors the editor search below: the inline rename editor materialises
# AT the row, while the message composer lives elsewhere in the window.
$kebabRect = $kebab.Current.BoundingRectangle

$ec = TryPattern $kebab ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
$ec.Expand()
Start-Sleep -Milliseconds 800

# Rename menu item, by label table only - never by position (Delete sits beside it).
$item = $null
$seen = @()
foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
  foreach ($e in $t.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.MenuItem') { continue }
    $n = $e.Current.Name
    if (-not $n) { continue }
    $seen += $n
    if ($RENAME_LABELS -contains $n) { $item = $e; break }
  }
  if ($item) { break }
}
if (-not $item) {
  try { $ec.Collapse() } catch { }
  Write-Output ("FAIL: menu opened but no Rename item. Menu showed: " + ($seen -join ' | '))
  exit 1
}
$inv = TryPattern $item ([System.Windows.Automation.InvokePattern]::Pattern)
$inv.Invoke()
Start-Sleep -Milliseconds 1200

[Ax]::Wake($hwndTop); Start-Sleep -Milliseconds 900
[Ax]::Wake($hwndTop); Start-Sleep -Milliseconds 900

# The editor: the writable Edit currently holding the row's old name (or empty, for a chat
# that never had one). Structural, language-free - clone of the original's detection, PLUS
# two guards the unattended path demands (review finding: an empty message composer is also a
# writable empty Edit, and writing the probe there then posting Enter would SEND A MESSAGE
# into a live chat): never an Edit named 'Prompt' (the composer), and the editor must sit ON
# the row - within 120px vertically of the kebab we just expanded.
$edit = $null
foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
  foreach ($e in $t.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.Edit') { continue }
    if ($e.Current.Name -eq 'Prompt') { continue }
    $v = TryPattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
    if (-not $v -or $v.Current.IsReadOnly) { continue }
    $r = $e.Current.BoundingRectangle
    if (-not $r.IsEmpty -and -not $kebabRect.IsEmpty -and
        [math]::Abs($r.Y - $kebabRect.Y) -gt 120) { continue }
    $held = try { $v.Current.Value } catch { '' }
    if ($held -eq $rowName -or $held -eq '' -or $held -eq 'Untitled') { $edit = $e; break }
  }
  if ($edit) { break }
}
if (-not $edit) {
  # Leave no dangling UI: collapse the menu we opened so the next pass starts clean.
  try { $ec.Collapse() } catch { }
  Write-Output "FAIL: rename editor did not open (no writable Edit holding '$rowName' or empty)"
  exit 1
}

$vp = TryPattern $edit ([System.Windows.Automation.ValuePattern]::Pattern)
$renamed = $false
for ($try = 1; $try -le 3 -and -not $renamed; $try++) {
  # The editor can go stale between detection and write (ElementNotAvailableException seen
  # live); a failed SetValue is a retry, not a crash.
  try { $vp.SetValue($NewTitle) } catch { Start-Sleep -Milliseconds 700; continue }
  Start-Sleep -Milliseconds 500
  $held = try { $vp.Current.Value } catch { '' }
  if ($held -ne $NewTitle) { Start-Sleep -Milliseconds 500; continue }
  [Ax]::PostEnter($hwndTop)
  Start-Sleep -Milliseconds 1500
  $el = Wake $hwndTop
  foreach ($b in $el.FindAll($TREE, $c)) {
    $n = $b.Current.Name
    if ($n -and $n.EndsWith($NewTitle) -and (TryPattern $b ([System.Windows.Automation.ExpandCollapsePattern]::Pattern))) { $renamed = $true; break }
  }
}
if (-not $renamed) { Write-Output 'INVOKED but the row does not render the new name'; exit 2 }
Write-Output "RENAMED first '$rowName' row -> '$NewTitle'"
exit 0
} finally { RestoreGroups }

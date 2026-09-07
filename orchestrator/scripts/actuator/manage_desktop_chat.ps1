# misc/Manage-DesktopChat.ps1 - manage a RUNNING Claude desktop app's chats (archive,
# unarchive, rename, list) WITHOUT stealing
# focus and WITHOUT moving the mouse, by invoking the app's own sidebar controls through the
# Windows UI Automation patterns they expose.
#
# WHY THIS EXISTS (owner directive, Michael, 2026-08-29): a running Electron app holds its chat
# list in memory, so a flag flipped on DISK stays on screen until the app restarts - and
# restarting is not an option. The app's OWN archive action is the one channel that is both
# immediate AND durable (the app makes the write, so its later memory->disk re-saves cannot undo
# it). This drives that action with zero focus theft.
#
# THE MECHANISM, measured 2026-08-29 (do not "simplify" back to cursor clicks):
#   - The row's kebab (localized: "More options for <Title>" / "Weitere Optionen fur <Title>")
#     is exposed as an ExpandCollapse control, NOT
#     an Invoke one. `ExpandCollapsePattern.Expand()` opens its context menu - focus-free.
#   - The "Archive" context-menu item exposes InvokePattern. `Invoke()` fires it - focus-free,
#     and it targets that EXACT element, so unlike a coordinate click it can never land on the
#     "Delete" item that sits directly beneath Archive. No point-verification needed.
#   - Neither call moves the mouse or calls SetForegroundWindow. (A cursor-and-foreground variant
#     was the first cut; this replaced it - it is both safer and genuinely focus-free.)
#   - Chromium/Electron builds its accessibility tree LAZILY. A UIA query alone sees only bare
#     panes; the MSAA poke (AccessibleObjectFromWindow on each Chrome_RenderWidgetHostHWND) is
#     what switches the full tree on. Without it every Find returns nothing.
#
# REACH LIMIT, stated honestly because it is fundamental, not a bug here: the accessibility tree
# contains only RENDERED sidebar rows. A chat in a collapsed folder group, or scrolled out of the
# virtualized list, is not present and cannot be actioned - this script reports that (exit 3)
# rather than pretending. It reliably archives a chat that is currently visible in the sidebar
# (the common "I just finished with this chat" case). It will try to expand the chat's own folder
# group first (focus-free) to bring it into view. Bringing a deeply-scrolled row into a virtualized
# viewport focus-free is not solved (Chromium's scroll container is not reliably drivable), so for
# an off-screen chat, scroll it into view first or archive it from its own window.
#
# NOT AVAILABLE, and why (measured 2026-08-29): a Chrome DevTools Protocol route (--remote-
# debugging-port) would sidestep rendering entirely, but Claude Desktop EXITS when launched with a
# debug port (proven A/B: same instance, plain launch runs, debug launch quits). The app refuses
# remote debugging, so CDP is not an option.
#
# USAGE
#   powershell -File misc/Manage-DesktopChat.ps1 -Title "Exact chat title"
#   powershell -File misc/Manage-DesktopChat.ps1 -Title "..." -Instance 5claude
#   powershell -File misc/Manage-DesktopChat.ps1 -Title "..." -Action Unarchive   # (only reaches
#                                              a currently-rendered archived row)
#   powershell -File misc/Manage-DesktopChat.ps1 -Title "..." -Action Rename -NewTitle "Real name"
#   powershell -File misc/Manage-DesktopChat.ps1 -Title "..." -Action Delete   # row menu Delete +
#                                              the app's own confirm button, both by label
#   powershell -File misc/Manage-DesktopChat.ps1 -List -Instance 5claude          # rendered rows
#
# RENAME (piece 6 of the rebuild, proven live 2026-08-29): the app's own Rename control is the
# ONE write a running app cannot undo (v1 measured every outside metadata write being re-saved
# away), so this is how a landed chat's DISPLAYED name is fixed immediately. Mechanics: the
# Rename menu item Invokes; the inline editor is an Edit named 'Rename' exposing ValuePattern
# (SetValue is focus-free); the commit is a posted WM_KEYDOWN Enter to the render widget - no
# global focus, no cursor. After committing, the app re-saves the metadata itself, so disk and
# app memory AGREE on the name (verified). -NewTitle must be a real name: generic non-names are
# refused here with the same patterns chat-title.ts owns (that file is canonical; keep in sync).
#
# Exit: 0 done (Archive: row left the sidebar - Unarchive: row now present in the active view -
#   Rename: row still present, under NewTitle) - 1 error - 2 invoked but not confirmed (Archive:
#   row still present - Rename: new name not rendered) - 3 not rendered.
param(
  [string]$Title,
  [string]$Instance = '',
  # DELETE (2026-09-04, owner rule: a probe chat must be deleted afterwards, not left in the
  # account): the row's own Delete item, then the app's own confirm button - both by label.
  [ValidateSet('Archive', 'Unarchive', 'Rename', 'Delete')][string]$Action = 'Archive',
  [string]$NewTitle = '',
  # RENAME ONLY: when several rendered rows carry the same title, take the Nth from the top
  # (1-based). A rename is reversible and lands on a row that wears this very title, so a
  # position is an acceptable tie-break there - the caller verifies through the dossier which
  # chat took the name and corrects. NEVER honoured for Archive/Unarchive (a wrong row there
  # is the one mistake this script exists to make impossible).
  [int]$Ordinal = 0,
  [switch]$List
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
# 2026-09-06: push ControlType filtering into a PropertyCondition (see MenuItemFor) instead of
# walking TrueCondition and filtering client-side - same pattern KebabFor already uses for $BTN.
$MENUITEM = [System.Windows.Automation.ControlType]::MenuItem

function Wake([IntPtr]$hwnd) { [Ax]::Wake($hwnd); Start-Sleep -Milliseconds 800; return [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) }
function ByName($scope, $name) { $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name); return $scope.FindFirst($TREE, $c) }
function TryPattern($e, $pat) { try { return $e.GetCurrentPattern($pat) } catch { return $null } }

# THE KEBAB IS LOCALIZED (found live 2026-08-30 on a German-locale app: the row menu reads
# 'Weitere Optionen für <title>', not 'More options for <title>'). Matching the English prefix
# found NOTHING there, so archive/rename/list were silently inert on any non-English app -
# they reported "not rendered" for chats sitting in plain view. Match structurally instead:
# the kebab is the Button whose name ENDS WITH the title and exposes ExpandCollapse (the row
# button itself carries a status prefix like 'Inaktiv <title>' and exposes Invoke, not
# ExpandCollapse), so the pattern - not the language - identifies it.
# THE MENU ITEMS ARE LOCALIZED TOO, and their AutomationIds are React churn
# ('base-ui-_r_l0_'), so neither the English name nor an id can find Archive on a German app
# (measured: 'Archivieren', 'Umbenennen', 'Löschen'). Position is NOT an option - Delete sits
# directly below Archive, which is the one mistake this whole script exists to make
# impossible. So: an explicit label table per action, and if nothing matches we REFUSE and
# print the menu we saw. Never invoke an item we cannot name.
$ACTION_LABELS = @{
  'Archive'   = @('Archive', 'Archivieren', 'Archiver', 'Archivar', 'Archiviare', 'Archiveren')
  'Unarchive' = @('Unarchive', 'Nicht mehr archivieren', 'Désarchiver', 'Desarchivar', 'Dearchiviare', 'Dearchiveren')
  'Rename'    = @('Rename', 'Umbenennen', 'Renommer', 'Cambiar nombre', 'Rinomina', 'Hernoemen')
  'Delete'    = @('Delete', 'Löschen', 'Supprimer', 'Eliminar', 'Elimina', 'Verwijderen')
}
function MenuItemFor($cond, $action) {
  $wanted = $ACTION_LABELS[$action]
  $seen = @()
  # 2026-09-06: ControlType filtering pushed into the FindAll condition itself (matches KebabFor's
  # $BTN PropertyCondition above) instead of walking TrueCondition and discarding non-MenuItems
  # client-side.
  $mic = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $MENUITEM)
  foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    foreach ($e in $t.FindAll($TREE, $mic)) {
      $n = $e.Current.Name
      if (-not $n) { continue }
      $seen += $n
      if ($wanted -contains $n) { return @{ Item = $e; Seen = $seen } }
    }
  }
  return @{ Item = $null; Seen = $seen }
}

# AMBIGUITY IS A REFUSAL: a suffix match means 'Notes' also matches the row for 'My Notes',
# and taking the first hit in tree order would archive the WRONG chat (review-confirmed). If
# several menus end with the title, only an exact-suffix-after-the-phrase match can break the
# tie; otherwise return $null and let the caller report it not-found rather than guess.
# Is this element inside the primary pane (the open chat's own header), rather than the
# sidebar? Walks up the control tree: a 'dframe-pane-primary' class or a 'Primary pane' name
# on any ancestor says yes; reaching the sidebar (dframe-sidebar / 'Sidebar') or the root
# says no. Class names are the app's own CSS hooks, so they do not localize.
function InPrimaryPane($el) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $el
  for ($i = 0; $i -lt 40 -and $node; $i++) {
    try { $node = $walker.GetParent($node) } catch { return $false }
    if (-not $node) { return $false }
    $cls = ''; $nm = ''
    try { $cls = [string]$node.Current.ClassName; $nm = [string]$node.Current.Name } catch { continue }
    if ($cls -like '*pane-primary*' -or $nm -eq 'Primary pane') { return $true }
    if ($cls -like '*sidebar*' -or $nm -eq 'Sidebar') { return $false }
  }
  return $false
}

function KebabFor($scope, $title) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
  $hits = @()
  foreach ($b in $scope.FindAll($TREE, $c)) {
    $n = $b.Current.Name
    if ($n -and $n.EndsWith($title) -and (TryPattern $b ([System.Windows.Automation.ExpandCollapsePattern]::Pattern))) { $hits += $b }
  }
  # THE OPEN CHAT HAS TWO KEBABS (live smoke, 2026-09-01): the chat showing in the primary
  # pane renders a second 'More options for <title>' in its HEADER (Group 'Primary pane',
  # class dframe-pane-primary) beside the sidebar row's own. Counting both made every chat
  # that was currently open read as AMBIGUOUS, so the one chat a person (or the doctrine
  # lane's picker) had just selected could never be archived or renamed through the app -
  # 4 of 4 archive attempts on the smoke chat. The row menu we want lives in the sidebar
  # (Group 'Sidebar', class dframe-sidebar); a hit whose ancestors include the primary pane
  # is the header copy. Drop those first; the duplicate-title refusal below still applies to
  # what is left.
  if ($hits.Count -gt 1) {
    $side = @($hits | Where-Object { -not (InPrimaryPane $_) })
    if ($side.Count -ge 1) { $hits = $side }
  }
  if ($hits.Count -le 1) { return $hits | Select-Object -First 1 }
  if ($Ordinal -ge 1 -and $Action -eq 'Rename') {
    $exact = @($hits | Where-Object { $_.Current.Name.EndsWith(' ' + $title) -or $_.Current.Name -eq $title } |
              Sort-Object { $_.Current.BoundingRectangle.Y })
    if ($Ordinal -le $exact.Count) { return $exact[$Ordinal - 1] }
    $script:KebabAmbiguity = "AMBIGUOUS: asked for row #$Ordinal of '$title' but only $($exact.Count) rendered"
    return $null
  }
  # Prefer the one whose title is preceded by a space (i.e. the whole trailing word matches,
  # not a longer title that merely ends the same way).
  $clean = @($hits | Where-Object { $_.Current.Name.EndsWith(' ' + $title) -or $_.Current.Name -eq $title })
  $others = @($hits | Where-Object { -not ($_.Current.Name.EndsWith(' ' + $title) -or $_.Current.Name -eq $title) })
  if ($clean.Count -eq 1 -and $others.Count -eq 0) { return $clean[0] }
  # THE REFUSAL MESSAGE MUST NOT GO TO THE OUTPUT STREAM. A PowerShell function returns
  # EVERYTHING written to stdout, so a Write-Output here made KebabFor return the two-element
  # array @('AMBIGUOUS: ...', $null). The caller's `if (-not $kebab)` then saw a non-empty
  # array, skipped its not-found branch, and handed a STRING to TryPattern - which threw, so
  # the run died on 'FAIL: kebab does not expose ExpandCollapse (app UI changed?)'. Every
  # duplicate-title refusal was therefore reported as a broken app UI, sending the reader off
  # to hunt an app regression that did not exist (measured 2026-08-31: a rename and an archive
  # both failed this way against a perfectly healthy app). Park the reason on a script-scope
  # variable; the caller prints it.
  $script:KebabAmbiguity = ("AMBIGUOUS: " + $hits.Count + " rendered chats end with '$title' (" +
    (($hits | ForEach-Object { "'" + $_.Current.Name + "'" }) -join ', ') + ') - refusing to guess')
  return $null
}
# -List emits each kebab's accessible name VERBATIM - '<localized more-options phrase>
# <title>' - and does NOT try to carve the title out of it. Deriving the title needs the
# localized phrase, and every heuristic for guessing it (longest common suffix against
# sibling rows) produced junk entries on the real tree ('en', 'gen', 'ungen'). The caller
# already knows the exact disk title it is looking for, so IT matches by suffix - exact,
# language-independent, and with nothing to guess. ui-archive.ts parseListOutput owns that end.
function RenderedKebabNames($scope) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
  $out = @()
  foreach ($b in $scope.FindAll($TREE, $c)) {
    $n = $b.Current.Name
    if ($n -and (TryPattern $b ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) -and $out -notcontains $n) {
      $out += $n
    }
  }
  return $out
}

# Running Claude desktop instances: a main process (no --type=) with --user-data-dir is a
# managed instance; one WITHOUT the flag is the DEFAULT %APPDATA%\Claude install (piece-10
# review: the default profile was structurally invisible here, so the most common app - the
# owner's primary install - could never be listed or clicked).
$mains = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    # ⛔ A PROFILE PATH CONTAINING A SPACE MADE THAT WHOLE ACCOUNT INVISIBLE. The old pattern
    # was '--user-data-dir=("?)([^"]+?)\1(\s|$)', which assumes the quote (if any) sits after
    # the '='. Windows quotes the WHOLE argument instead - "--user-data-dir=C:\...\pap3r
    # rotate2" - so there is no quote after the '=', the lazy body stops at the first space,
    # and the instance resolves to 'C:\...\pap3r'. That never matches any real directory, so
    # every archive, rename, list and delivery for that account reported "no running instance
    # matches" and returned nothing. Measured 2026-08-31: the owner's 'pap3r rotate2' account
    # had been structurally unmanageable, which read from outside as the machinery simply
    # ignoring accounts. Three shapes, most specific first.
    $m = [regex]::Match($_.CommandLine, '"--user-data-dir=([^"]+)"')
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir="([^"]+)"') }
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(\S+)') }
    $dir = if ($m.Success) { $m.Groups[1].Value.Trim() } else { Join-Path $env:APPDATA 'Claude' }
    [pscustomobject]@{ ProcId = $_.ProcessId; Dir = $dir }
  }
# AIM BY IDENTITY, NEVER POSITION (owner rule, 2026-09-06, after an actuator clicked the project
# selector in the wrong account's window): twenty profiles exist with near-duplicate leaf names
# ('pap3r rotate' / 'pap3r rotate2'), so a substring match can select either one. A bare -Instance
# now matches the profile dir's LEAF folder name EXACTLY (case-insensitive), never '-like *name*'.
# A path-shaped hint (contains a slash) still matches the dir EXACTLY, as before.
$allMains = $mains
# Any action that clicks/types/invokes a chat (everything except a pure -List scan) REQUIRES
# -Instance - a blank -Instance used to silently fan out across every running account, which is
# exactly how the wrong window gets clicked. Listing may still omit it (it only reads).
if (-not $List -and -not $Instance) {
  Write-Output "FAIL: -Instance is required for -Action $Action (blank -Instance is only allowed with -List)"
  exit 1
}
if ($Instance) {
  $mains = @($mains | Where-Object {
    if ($Instance -match '[\\/]') { $_.Dir.TrimEnd('\') -eq $Instance.TrimEnd('\') }
    else { (Split-Path -Leaf $_.Dir.TrimEnd('\')) -eq $Instance }
  })
  # ZERO or MORE THAN ONE match is a refusal, never "take the first" - print every candidate dir
  # so the caller can see exactly what -Instance would need to be.
  if ($mains.Count -ne 1) {
    Write-Output "FAIL: -Instance '$Instance' matched $($mains.Count) running instance(s), need exactly 1. Candidates:"
    foreach ($cand in $allMains) { Write-Output ("  " + $cand.Dir) }
    exit 1
  }
}
if (-not $mains) { Write-Output "FAIL: no running Claude desktop instance matches '$Instance'"; exit 1 }

if ($Action -eq 'Rename') {
  # THE NAMING LAW (chat-title.ts is canonical; these mirror its patterns): a rename must land
  # a real name. Canonicalize the same way: strip zero-width chars, collapse whitespace.
  $canon = ($NewTitle -replace "[\u200B-\u200D\uFEFF\u00AD]", '') -replace '\s+', ' '
  $canon = $canon.Trim()
  if (-not $canon -or $canon -match '^(untitled|general coding session|new (chat|session))$' -or $canon -match '^\[plumbing\]') {
    Write-Output "FAIL: -NewTitle '$NewTitle' is a generic non-name (owner rule: real names only)"
    exit 1
  }
  $NewTitle = $canon
}

# LEAVE THE SIDEBAR AS IT WAS FOUND (owner, 2026-09-04: "something keeps clicking interface
# buttons on my Claude desktop, like the repo names or whatever"). Hunting for a row expands the
# collapsed project groups, and nothing ever folded them back - so every archive, rename and
# delete that had to look left his sidebar rearranged. Every group THIS run opens is remembered
# and collapsed again on the way out, whatever the outcome (`exit` runs the finally).
$script:OpenedGroups = @()
function RestoreGroups {
  $n = 0
  foreach ($ecp in $script:OpenedGroups) { try { $ecp.Collapse(); $n++ } catch { } }
  $script:OpenedGroups = @()
  if ($n -gt 0) { Write-Output "collapsed $n sidebar group(s) back the way they were" }
}
try {
# EXACTLY ONE CANDIDATE WINDOW before any action loop runs (2026-09-06 audit): the -Instance
# gate above already forces this for every non-List action, but the check is repeated here,
# at the point of entry to the loop that actually clicks/types, as a second, structural
# guarantee - if more than one running window is in scope, STOP and report every (Dir, Title)
# rather than acting on the first one found.
if (-not $List -and $mains.Count -ne 1) {
  Write-Output "FAIL: $($mains.Count) candidate window(s) in scope for -Action $Action, need exactly 1. Candidates:"
  foreach ($cand in $mains) { Write-Output ("  " + $cand.Dir) }
  exit 1
}
foreach ($m in $mains) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$m.ProcId)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if (-not $win) { continue }
  $el = Wake ([IntPtr]$win.Current.NativeWindowHandle)

  if ($List) {
    Write-Output "== $($m.Dir) (pid $($m.ProcId)) rendered chats =="
    $bc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
    foreach ($t in RenderedKebabNames $el) { '  ' + $t }
    continue
  }

  if (-not $Title) { Write-Output 'FAIL: -Title is required (or use -List)'; exit 1 }

  $script:KebabAmbiguity = $null
  $kebab = KebabFor $el $Title
  # An ambiguous match is a decided refusal, not a miss - expanding groups cannot make two
  # identically-named rows into one, so do not re-look, and do not fall through to the next
  # instance as if the chat were absent. Report it and stop.
  if (-not $kebab -and -not $script:KebabAmbiguity) {
    # Try to bring it into view by expanding its folder group(s) (focus-free), then re-look.
    #
    # ⛔⛔ ONLY GROUP-SHAPED CONTROLS IN THE SIDEBAR (owner, 2026-09-01: "it's still clicking
    # random shit... I think it's the script trying to select the model"). This loop used to
    # expand EVERY collapsed ExpandCollapse element with a name under 40 characters - and the
    # MODEL PICKER is an ExpandCollapse control whose name ("Opus 4.5", "Fable 5") is well
    # under 40. So every archive and every rename that had to hunt for a row was popping the
    # model menu open on a live account. Expanding a folder group is harmless; opening the
    # model picker is one stray click from changing a chat's model, which is a standing rule
    # never to touch. Identify the group POSITIVELY - control type plus the left column,
    # where no picker or toolbar dropdown lives - instead of blacklisting names.
    # The allow-list is DERIVED FROM THE APP: every sidebar project group has a companion
    # button named "New session in <that group>", and nothing else in the window does
    # (measured across five live instances 2026-09-01). A name not in that set is not a group.
    $groupNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($b in $el.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        $n = $b.Current.Name
        if ($n -and $n.Length -gt 15 -and $n.StartsWith('New session in ')) {
          [void]$groupNames.Add($n.Substring(15).Trim())
        }
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
    $el = Wake ([IntPtr]$win.Current.NativeWindowHandle)
    $kebab = KebabFor $el $Title
  }
  if ($script:KebabAmbiguity) { Write-Output $script:KebabAmbiguity; exit 1 }
  if (-not $kebab) { continue }  # not in this instance; try the next

  Write-Output "found '$Title' in $($m.Dir)"
  $ec = TryPattern $kebab ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if (-not $ec) { Write-Output 'FAIL: kebab does not expose ExpandCollapse (app UI changed?)'; exit 1 }
  $ec.Expand()
  # ⛔ A FLAT WAIT, ON PURPOSE (measured 2026-09-06). This was briefly a 150ms poll that invoked
  # the menu item the moment it appeared in the tree - and the rename drill FAILED every time
  # ("rename editor did not open") while the same chat renamed fine with this flat wait. The
  # item is observable in the accessibility tree BEFORE the menu is interactive, so "found" is
  # not "ready"; the adversarial review said exactly this and was right. Do not poll here.
  Start-Sleep -Milliseconds 800

  $found = MenuItemFor $cond $Action
  $item = $found.Item
  if (-not $item) {
    try { $ec.Collapse() } catch { }
    Write-Output ("FAIL: menu opened but no '$Action' item matched a known label. Menu showed: " +
      ($found.Seen -join ' | ') +
      ". Add this locale's label to `$ACTION_LABELS - refusing rather than guessing by position, because Delete sits next to Archive.")
    exit 1
  }
  $inv = TryPattern $item ([System.Windows.Automation.InvokePattern]::Pattern)
  if (-not $inv) { Write-Output "FAIL: '$Action' item does not expose Invoke"; exit 1 }
  # DELETE: the confirm button is identified by DIFFERENCE, never by name alone (review
  # 2026-09-05: a Button called 'Delete …' can exist anywhere in a rendered conversation, and
  # a name match across the whole window could Invoke that one). Snapshot every Delete-labelled
  # Button BEFORE the menu item fires; afterwards only a button that was NOT there before is the
  # app's confirm. Zero new buttons = no dialog (the row check decides); more than one = refuse.
  function DeleteButtons($cond) {
    $out = @()
    foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
      foreach ($e in $t.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
        try {
          if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.Button') { continue }
          $n = ([string]$e.Current.Name).Trim()
          if (-not $n) { continue }
          $hit = $false
          foreach ($lbl in $ACTION_LABELS['Delete']) { if ($n -eq $lbl -or $n.StartsWith($lbl + ' ')) { $hit = $true; break } }
          if ($hit -and (TryPattern $e ([System.Windows.Automation.InvokePattern]::Pattern))) { $out += $e }
        } catch { continue }
      }
    }
    return $out
  }
  function RuntimeKey($e) { try { return (($e.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.') } catch { return '' } }
  $beforeDelete = @{}
  if ($Action -eq 'Delete') { foreach ($b in (DeleteButtons $cond)) { $beforeDelete[(RuntimeKey $b)] = $true } }
  $inv.Invoke()
  Start-Sleep -Milliseconds 1200

  if ($Action -eq 'Delete') {
    $hwndTop = [IntPtr]$win.Current.NativeWindowHandle
    [Ax]::Wake($hwndTop); Start-Sleep -Milliseconds 700
    $fresh = @((DeleteButtons $cond) | Where-Object { -not $beforeDelete.ContainsKey((RuntimeKey $_)) })
    if ($fresh.Count -gt 1) {
      Write-Output ("FAIL: " + $fresh.Count + " new Delete-labelled buttons appeared after the menu item (" +
        (($fresh | ForEach-Object { "'" + $_.Current.Name + "'" }) -join ', ') + ") - refusing to guess which is the confirm")
      exit 1
    }
    if ($fresh.Count -eq 1) {
      $confirm = $fresh[0]
      (TryPattern $confirm ([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
      Start-Sleep -Milliseconds 1500
      Write-Output "confirmed the app's own delete dialog ('$($confirm.Current.Name)')"
    } else {
      Write-Output 'no confirmation dialog appeared after Delete - reading the row to decide'
    }
  }

  if ($Action -eq 'Rename') {
    # The inline editor: an Edit named 'Rename' exposing ValuePattern. SetValue is focus-free;
    # the commit is a posted Enter to the render widget.
    $hwndTop = [IntPtr]$win.Current.NativeWindowHandle
    # Two pokes with a real gap: the editor is materialised lazily AFTER the menu Invoke, and
    # a single 800ms wake caught the tree before it existed (measured - this is why rename
    # read as impossible on a German app).
    [Ax]::Wake($hwndTop); Start-Sleep -Milliseconds 900
    [Ax]::Wake($hwndTop); Start-Sleep -Milliseconds 900
    # The editor may live under a sibling top-level pane, not the main window subtree - search
    # every top-level element of this process (how the working probe found it).
    # THE EDITOR'S NAME IS LOCALIZED TOO ('Sitzungsname' on a German app, 'Rename' on an
    # English one), so it is identified STRUCTURALLY: the writable Edit that currently HOLDS
    # THE OLD TITLE. That value check is what separates it from the message composer (an Edit
    # named 'Prompt' holding placeholder text) without knowing either language.
    # ⛔ The Wake above this block is load-bearing: Chromium materialises the editor lazily,
    # and without a fresh MSAA poke after the menu Invoke the element simply is not in the
    # tree yet - which is what made rename look permanently broken on non-English builds.
    $edit = $null
    foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
      foreach ($e in $t.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.Edit') { continue }
        $v = TryPattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
        if (-not $v -or $v.Current.IsReadOnly) { continue }
        $held = try { $v.Current.Value } catch { '' }
        if ($held -eq $Title) { $edit = $e; break }
      }
      if ($edit) { break }
    }
    if (-not $edit) {
      Write-Output "FAIL: rename editor did not open (no writable Edit holding '$Title')"
      exit 1
    }
    $vp = TryPattern $edit ([System.Windows.Automation.ValuePattern]::Pattern)
    if (-not $vp) { Write-Output 'FAIL: rename editor exposes no ValuePattern'; exit 1 }
    # Commit loop: SetValue, verify the editor actually holds the new text, post Enter, check
    # the row; retry up to 3 times (a posted keystroke can race the editor's first paint).
    $renamed = $false
    for ($try = 1; $try -le 3 -and -not $renamed; $try++) {
      $vp.SetValue($NewTitle)
      Start-Sleep -Milliseconds 500
      $held = try { $vp.Current.Value } catch { '' }
      if ($held -ne $NewTitle) { Start-Sleep -Milliseconds 500; continue }
      [Ax]::PostEnter($hwndTop)
      Start-Sleep -Milliseconds 1500
      $el = Wake $hwndTop
      $renamed = [bool](KebabFor $el $NewTitle)
    }
    if (-not $renamed) { Write-Output 'RENAME INVOKED but the row does not render the new name - report this'; exit 2 }
    Write-Output "Rename done: '$Title' -> '$NewTitle' (focus-free; committed through the app, so disk and app memory agree)"
    exit 0
  }

  $el = Wake ([IntPtr]$win.Current.NativeWindowHandle)
  $still = [bool](KebabFor $el $Title)
  if (($Action -eq 'Archive' -or $Action -eq 'Delete') -and $still) { Write-Output 'INVOKED but row still present - report this, do not blind-retry'; exit 2 }
  Write-Output "$Action done for '$Title' (focus-free: no SetForegroundWindow, no cursor)"
  exit 0
}
} finally { RestoreGroups }
if ($List) { exit 0 }
Write-Output "FAIL: '$Title' not rendered in any searched running instance (collapsed group or virtualized out - scroll it into view, then retry)"
exit 3

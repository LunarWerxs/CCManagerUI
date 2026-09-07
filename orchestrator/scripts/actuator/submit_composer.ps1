# submit_composer.ps1 - press SEND on a composer that already holds the text we put there.
#
# WHY (owner, 2026-09-01: "have it automatically handle spawned chats/chips"). The app's own
# new-chat deeplink (claude://code/new?prompt=...&folder=...) OPENS the chat and PRE-FILLS the
# composer - but it does not submit, so a spawned chat sits there forever with its work typed
# and never started, and no engine registers for it (nothing to peer-message either).
#
# THE AIM RAIL, and it is the strongest one in this toolbox: a brand-new chat has no title and
# no conversation to verify against, so instead the proof is the COMPOSER'S OWN CONTENTS. This
# only ever sends a box whose text CONTAINS -Contains (a slice of the exact prompt we just put
# there). If no composer holds our text, it refuses (exit 4) rather than pressing Send on
# whatever box it found - which would fire someone else's half-written message.
#
# -RequireMode 'Bypass permissions' (2026-09-01): a deeplink-born chat starts in the app's
# DEFAULT permission mode and no disk stamp can stick while it lives, so its very first shell
# call stalls on a prompt nobody is present to click. The composer toolbar carries the app's
# own permission-mode picker - a Button named for the current mode ('Default permissions',
# 'Bypass permissions', ...) that opens a menu of the modes. Before pressing Send this reads
# that button beside OUR composer; if it does not already say the required mode it Invokes
# the button, Invokes the menu item with the required name, and re-reads the button. Only a
# button that now READS the required mode earns the Send (exit 6 otherwise): a chat born in
# the wrong mode is a chat that will stall, and refusing here is cheaper than rescuing later.
# Positive identification only - named controls, never a position or a blind click.
#
# Exit: 0 sent - 3 no composer holds that text (nothing to submit) - 4 found the text but no
#       enabled Send button - 6 the required permission mode could not be set (nothing sent)
#       - 1 error, INCLUDING -Instance blank or matching zero/more-than-one running instance
#       (2026-09-06: -Instance is now required and matched by EXACT leaf-name equality).
param(
  [Parameter(Mandatory = $true)][string]$Contains,
  [Parameter(Mandatory = $true)][string]$Instance,
  [string]$RequireMode = ''
)
# The picker's possible names - the app's own labels for its modes (English; the sibling
# actuators carry localized lists for Send/Stop, extend here the same way if a German app shows up).
$MODE_NAMES = @('Default permissions', 'Accept edits', 'Plan mode', 'Bypass permissions',
                'Ask permissions', 'Auto-accept edits')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$TREE = [System.Windows.Automation.TreeScope]::Descendants
function TryPattern($e, $pat) { try { return $e.GetCurrentPattern($pat) } catch { return $null } }
$SEND_NAMES = @('Send', 'Senden', 'Enviar', 'Envoyer', 'Invia', 'Verzenden')

# AIM BY IDENTITY (2026-09-06): a path-shaped -Instance matches --user-data-dir EXACTLY; a
# BARE -Instance matches the profile dir's LEAF folder name EXACTLY (case-insensitively -
# PowerShell -eq already is), never a substring - "pap3r rotate" must never hit "pap3r
# rotate2". -Instance is REQUIRED: a blank value used to mean "every running instance",
# which is exactly how an actuator can click the wrong account's window. Zero or more than
# one surviving match is a refusal, every candidate dir printed, never "take the first".
$allMains = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    $m = [regex]::Match($_.CommandLine, '"--user-data-dir=([^"]+)"')
    if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(\S+)') }
    $dir = if ($m.Success) { $m.Groups[1].Value.Trim() } else { Join-Path $env:APPDATA 'Claude' }
    [pscustomobject]@{ ProcId = $_.ProcessId; Dir = $dir }
  }
if ([string]::IsNullOrWhiteSpace($Instance)) {
  Write-Output ("REFUSED: -Instance is required (blank refused) - running candidates: " +
    (($allMains | ForEach-Object { $_.Dir }) -join ', '))
  exit 1
}
$mains = @($allMains | Where-Object {
    if ($Instance -match '[\\/]') { $_.Dir.TrimEnd('\') -eq $Instance.TrimEnd('\') }
    else { (Split-Path -Leaf $_.Dir) -eq $Instance }
  })
if ($mains.Count -ne 1) {
  Write-Output ("REFUSED: -Instance '$Instance' matched " + $mains.Count + " running instance(s) - candidates: " +
    (($allMains | ForEach-Object { $_.Dir }) -join ', '))
  exit 1
}

$needle = $Contains.Trim()
if ($needle.Length -gt 60) { $needle = $needle.Substring(0, 60) }

$foundTextNoButton = $false
foreach ($m in $mains) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$m.ProcId)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if (-not $win) { continue }

  # find the COMPOSER holding OUR text - structurally, the way the courier's actuator finds
  # it (review 2026-09-01: this walked EVERY Edit in the window). A composer is a WRITABLE box
  # (ValuePattern, not read-only); a read-only box that merely renders our prompt back can
  # never be the target. ⛔ NO pane-position rule here, unlike the sibling actuators: a
  # brand-new chat's composer sits CENTRED in the window, left of the 38% line, and a
  # same-day attempt at that rule made this exit 3 on every spawn (measured 2026-09-01).
  $editCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit)
  $target = $null
  foreach ($e in $win.FindAll($TREE, $editCond)) {
    try {
      if ($e.Current.IsOffscreen) { continue }
      $vp = TryPattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
      if (-not $vp -or $vp.Current.IsReadOnly) { continue }
      $val = $vp.Current.Value
      if ($val -and $val.Contains($needle)) { $target = $e; break }
    } catch { continue }
  }
  if (-not $target) { continue }

  # ...and the Send button that is ENABLED (the app enables it only once it has the text).
  # ⛔ SCOPED TO THE COMPOSER'S OWN CONTAINER, never the whole window: a window can show two
  # panes, each with its own composer and Send, so a window-wide search could press the OTHER
  # conversation's button and fire someone's half-written message. Walk up a few ancestors
  # from the matched composer and search only there.
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $scope = $target
  for ($up = 0; $up -lt 4; $up++) {
    $parent = $walker.GetParent($scope)
    if (-not $parent) { break }
    $scope = $parent
  }

  # THE PERMISSION MODE, BEFORE THE SEND (see the header). The picker sits in the composer's
  # own toolbar, i.e. inside the same scope as the Send button.
  if ($RequireMode) {
    $btnCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button)
    # 2026-09-06: used to return the FIRST mode-named button in tree order - on a window
    # showing two panes (or a stray second picker) that can be the OTHER conversation's
    # button. Identify by POSITION instead: among every MODE_NAMES match in scope, pick the
    # one whose bounding-rect vertical center is nearest the matched composer's own row;
    # refuse (return null) if two are equally near or none sits within the composer's row
    # band, rather than guess.
    function Find-ModeButton($sc, $refEl) {
      $found = @()
      foreach ($b in $sc.FindAll($TREE, $btnCond)) {
        try { if ($MODE_NAMES -contains $b.Current.Name) { $found += $b } } catch { continue }
      }
      if ($found.Count -eq 0) { return $null }
      # A LONE match is not proof either (review 2026-09-06): the climbed scope can span two
      # panes, and the one mode button it holds may be the OTHER pane's. The row band below
      # applies to one candidate exactly as to several; only with no composer to measure
      # against does a lone match pass on its own.
      if (-not $refEl) { if ($found.Count -eq 1) { return $found[0] } else { return $null } }
      try { $refRect = $refEl.Current.BoundingRectangle } catch { return $null }
      $refY = $refRect.Top + ($refRect.Height / 2)
      $band = [Math]::Max($refRect.Height * 3, 60)
      $scored = @()
      foreach ($b in $found) {
        try {
          $r = $b.Current.BoundingRectangle
          $by = $r.Top + ($r.Height / 2)
          $dist = [Math]::Abs($by - $refY)
          if ($dist -le $band) { $scored += [pscustomobject]@{ Btn = $b; Dist = $dist } }
        } catch { continue }
      }
      if ($scored.Count -eq 0) { return $null }
      $sorted = @($scored | Sort-Object Dist)
      if ($sorted.Count -gt 1 -and $sorted[0].Dist -eq $sorted[1].Dist) { return $null }
      return $sorted[0].Btn
    }
    # ⛔ THE COMPOSER'S OWN SCOPE ONLY - never the whole window (2026-09-01: a window-wide
    # fallback read the PREVIOUSLY open chat's 'Bypass permissions' button, reported the mode
    # already right, sent, and the new chat was born in default mode anyway). The new-chat view
    # may carry no picker at all until the chat exists; then the send goes ahead and the chat is
    # switched right after it registers (approve_prompt.ps1 -SetMode, from spawn_chat and the
    # doctrine lane) - refusing here would mean no chip ever spawns.
    $modeBtn = Find-ModeButton $scope $target
    if (-not $modeBtn) {
      Write-Output "note: no permission picker beside this composer (a new chat shows none until it exists) - sending; the mode is set right after it registers"
    }
    if ($modeBtn -and $modeBtn.Current.Name -ne $RequireMode) {
      $before = $modeBtn.Current.Name
      # The picker on an EXISTING chat exposes ExpandCollapse, not Invoke, and neither opens
      # it (measured 2026-09-01) - only a focused Space does, which approve_prompt.ps1
      # -SetMode performs right after the chat registers. Here, on the new-chat composer, try
      # Invoke; if the control offers none, note it and SEND - refusing here meant no chip
      # ever spawned, and the post-registration picker sets the mode anyway.
      # 2026-09-06: snapshot every RuntimeId in the window BEFORE Invoke-ing the picker, so the
      # menu-item hunt below can require NEW elements only, instead of walking the whole window
      # tree - a whole-tree TrueCondition walk can match a same-named element that was already
      # sitting elsewhere in the window (another chat's mode label, stale menu debris).
      $preMenuIds = New-Object 'System.Collections.Generic.HashSet[string]'
      try {
        $fresh0 = [System.Windows.Automation.AutomationElement]::FromHandle($win.Current.NativeWindowHandle)
        foreach ($e0 in $fresh0.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
          try { [void]$preMenuIds.Add(($e0.GetRuntimeId() -join '.')) } catch { continue }
        }
      } catch { }
      $pi = TryPattern $modeBtn ([System.Windows.Automation.InvokePattern]::Pattern)
      $opened = $false
      if ($pi) { try { $pi.Invoke(); $opened = $true } catch {} }
      if (-not $opened) {
        Write-Output "note: the permission picker ('$before') offers no Invoke here - sending; approve_prompt -SetMode switches it right after the chat registers"
      }
      $item = $null
      if ($opened) {
        Start-Sleep -Milliseconds 700
        # The menu paints inside the same window tree; its items are RadioButtons whose
        # names START with the mode label and carry a description after it. Restricted to
        # elements that are NEW since the picker Invoke (RuntimeId snapshot diff above).
        foreach ($try in 1..4) {
          $fresh = [System.Windows.Automation.AutomationElement]::FromHandle($win.Current.NativeWindowHandle)
          foreach ($e in $fresh.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
            try {
              $rid = ($e.GetRuntimeId() -join '.')
              if ($preMenuIds.Contains($rid)) { continue }
              if (-not $e.Current.Name.StartsWith($RequireMode)) { continue }
              $ct = $e.Current.ControlType.ProgrammaticName
              if ($ct -notmatch 'MenuItem|ListItem|RadioButton') { continue }
              $item = $e; break
            } catch { continue }
          }
          if ($item) { break }
          Start-Sleep -Milliseconds 400
        }
      }
      if ($opened -and -not $item) {
        Write-Output "REFUSED: opened the permission picker ('$before') but no menu item starting with '$RequireMode' appeared - not sending"
        exit 6
      }
      if ($item) {
        # 2026-09-06: snapshot every button RuntimeId BEFORE the pick, so the confirm hunt
        # below can require the dialog's Accept button be NEW since this pick - never "any
        # enabled button named OK/Continue/Yes anywhere in the window", which could fire a
        # pre-existing, unrelated button that happens to share a name.
        $preItemPickIds = New-Object 'System.Collections.Generic.HashSet[string]'
        try {
          $fresh0 = [System.Windows.Automation.AutomationElement]::FromHandle($win.Current.NativeWindowHandle)
          foreach ($b0 in $fresh0.FindAll($TREE, $btnCond)) {
            try { [void]$preItemPickIds.Add(($b0.GetRuntimeId() -join '.')) } catch { continue }
          }
        } catch { }
        $picked = $false
        $sp = TryPattern $item ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($sp) { try { $sp.Select(); $picked = $true } catch {} }
        if (-not $picked) {
          $ii = TryPattern $item ([System.Windows.Automation.InvokePattern]::Pattern)
          if ($ii) { try { $ii.Invoke(); $picked = $true } catch {} }
        }
        if (-not $picked) { Write-Output "REFUSED: the '$RequireMode' item took neither Select nor Invoke"; exit 6 }
        Start-Sleep -Milliseconds 800
        # THE FIRST-TIME CONFIRMATION (owner, 2026-09-01: "when enabling bypass permissions,
        # frequently a popup shows up to confirm - generally the first time a chat was
        # created"). Answered POSITIVELY by name, never by position; Cancel/No never touched.
        # Every existing name/deny rail (exact name, IsOffscreen, MODE_NAMES exclusion) kept -
        # ADDED: the button must also be NEW since the item pick (RuntimeId snapshot diff).
        $ACCEPT_NAMES = @('Yes, I accept', 'I accept', 'Accept', 'Yes, enable', 'Enable', 'Turn on',
                          'Confirm', 'Continue', 'I understand', 'Got it', 'OK', 'Yes',
                          'Ja, ich akzeptiere', 'Akzeptieren', 'Aktivieren', 'Bestätigen', 'Weiter', 'Ja')
        foreach ($round in 1..3) {
          $dlg = $null
          $fresh = [System.Windows.Automation.AutomationElement]::FromHandle($win.Current.NativeWindowHandle)
          foreach ($want in $ACCEPT_NAMES) {
            foreach ($b in $fresh.FindAll($TREE, $btnCond)) {
              try {
                $n = $b.Current.Name
                if (-not $n -or $n.Trim() -ne $want -or ($MODE_NAMES -contains $n.Trim())) { continue }
                if ($b.Current.IsOffscreen) { continue }
                $rid = ($b.GetRuntimeId() -join '.')
                if ($preItemPickIds.Contains($rid)) { continue }
                $dlg = $b; break
              } catch { continue }
            }
            if ($dlg) { break }
          }
          if (-not $dlg) { break }
          $dinv = TryPattern $dlg ([System.Windows.Automation.InvokePattern]::Pattern)
          if ($dinv) { try { $dinv.Invoke() } catch {} }
          Write-Output "confirmed the app's '$($dlg.Current.Name)' prompt"
          # consumed - remember its id so a lingering re-render in the next round can't re-match it
          try { [void]$preItemPickIds.Add(($dlg.GetRuntimeId() -join '.')) } catch { }
          Start-Sleep -Milliseconds 900
        }
      }
      Start-Sleep -Milliseconds 700
      $fresh = [System.Windows.Automation.AutomationElement]::FromHandle($win.Current.NativeWindowHandle)
      if ($item) {
        $modeBtn = Find-ModeButton $fresh $target
        if (-not $modeBtn -or $modeBtn.Current.Name -ne $RequireMode) {
          $now = if ($modeBtn) { $modeBtn.Current.Name } else { 'gone' }
          Write-Output "REFUSED: picked '$RequireMode' but the picker now reads '$now' - the mode did not take; not sending"
          exit 6
        }
        Write-Output "permission mode set: '$before' -> '$RequireMode'"
      }
      # the tree re-rendered under the menu: re-find the composer scope for the Send search
      $target = $null
      foreach ($e in $fresh.FindAll($TREE, $editCond)) {
        try {
          if ($e.Current.IsOffscreen) { continue }
          $vp2 = TryPattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
          if (-not $vp2 -or $vp2.Current.IsReadOnly) { continue }
          $val2 = $vp2.Current.Value
          if ($val2 -and $val2.Contains($needle)) { $target = $e; break }
        } catch { continue }
      }
      if (-not $target) { Write-Output "REFUSED: the composer lost our text while the mode was being set - not sending"; exit 4 }
      $scope = $target
      for ($up = 0; $up -lt 4; $up++) {
        $parent = $walker.GetParent($scope)
        if (-not $parent) { break }
        $scope = $parent
      }
    } elseif ($modeBtn) {
      Write-Output "permission mode already '$RequireMode'"
    }
  }
  foreach ($b in $scope.FindAll($TREE, (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)))) {
    try {
      $bn = $b.Current.Name
      if (-not $bn -or ($SEND_NAMES -notcontains $bn)) { continue }
      if (-not $b.Current.IsEnabled) { continue }
      $inv = TryPattern $b ([System.Windows.Automation.InvokePattern]::Pattern)
      if (-not $inv) { continue }
      $inv.Invoke()
      Write-Output "SENT the pre-filled composer in $($m.Dir) (button '$bn')"
      exit 0
    } catch { continue }
  }
  # Found the text here but no enabled Send yet - another $mains entry (bare-name substring
  # can match several instances) may still hold the real, sendable target, so keep looking
  # instead of exiting on the first non-sendable hit.
  $foundTextNoButton = $true
}
if ($foundTextNoButton) {
  Write-Output "REFUSED: found our text in a composer but no ENABLED send button beside it"
  exit 4
}
Write-Output "no composer holds that text - nothing to submit"
exit 3

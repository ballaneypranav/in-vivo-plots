# Add staggered treatment starts and a dosing/measurement schedule to an existing study workbook, with Excel.
# Windows with Excel 365 only (LET, XLOOKUP, FILTER, SEQUENCE). Usage:
#   powershell -ExecutionPolicy Bypass -File tools/add-schedule.ps1 -Path "C:\full\path\Study Data.xlsx"
# A copy of the workbook is saved next to it first (<name>.backup-<date-time>.xlsx). Safe to run again: each step is
# skipped when it is already there. What it adds (see PLAN.md, Input format):
#   Mice      Treatment start (typed: the mouse's own start; blank = its group's) and Start used (formula: the start
#             that applies), as new columns at the end of the table.
#   Regimens  Days (typed, as text: days from each mouse's start to give that drug, e.g. "0, 2, 4"), at the end.
#   Groups    Measure every (days) and Measure from, in K1:L2 (names MeasureEvery, MeasureFrom).
#   Checklist B1 defaults to today; D1 says whether it is a measurement day; Inj shows only the drugs due that day
#             (with volume), or "not started"; Weight, L and B are greyed on days without measurements.
#   Plan      A new sheet: alive mice x the next 21 days, the drugs due each day, M over measurement days.
#   Injected Drugs  "missed" only for mice that had started by that day (not for mice not yet enrolled).
# The script is ASCII only, so Windows PowerShell 5.1 reads it correctly; the micro sign is built with [char].
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'

$Path = (Resolve-Path $Path).Path
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'  # seconds, so a second run never overwrites the first backup
$backup = Join-Path (Split-Path $Path) ("{0}.backup-{1}.xlsx" -f [IO.Path]::GetFileNameWithoutExtension($Path), $stamp)
Copy-Item $Path $backup
Write-Output "Backup: $backup"

function Find-Column($lo, [string[]]$names) {
  foreach ($c in $lo.ListColumns) { if ($names -contains $c.Name) { return $c.Name } }
  return $null
}

# Add a column at the right edge of a table by writing its header and resizing the table, so cells to the right
# (helper columns, spills) are never shifted. Refuses if that column of the sheet is not empty.
function Add-TableColumn($lo, [string]$name) {
  # Write-Host, not Write-Output: anything written to the output would become part of the return value.
  if (Find-Column $lo @($name)) { Write-Host "  $($lo.Name)[$name] already there"; return $false }
  $ws = $lo.Parent
  $r = $lo.Range
  $col = $r.Column + $r.Columns.Count
  $top = $r.Row
  $bottom = $top + $r.Rows.Count - 1
  $cells = $ws.Range($ws.Cells.Item($top, $col), $ws.Cells.Item($bottom, $col))
  if ($ws.Application.WorksheetFunction.CountA($cells) -gt 0) {
    throw "The column right of table $($lo.Name) ($($cells.Address($false, $false))) is not empty; move what is there and run again."
  }
  $ws.Cells.Item($top, $col).Value2 = $name
  [void]$lo.Resize($ws.Range($ws.Cells.Item($top, $r.Column), $ws.Cells.Item($bottom, $col)))
  Write-Host "  added $($lo.Name)[$name] in column $col"
  return $true
}

function Set-Formula($range, [string]$f) {
  try { $range.Formula2 = $f } catch { $range.Formula = $f }
}

function Set-Name($wb, [string]$name, [string]$refersTo) {
  foreach ($n in $wb.Names) { if ($n.Name -eq $name) { $n.Delete(); break } }
  [void]$wb.Names.Add($name, $refersTo)
}

function Add-HelpLine($ws, [int]$col, [string]$text) {
  # Append a line under the sheet's "How this works" notes (column $col), unless it is there already.
  $last = $ws.Cells.Item($ws.Rows.Count, $col).End(-4162).Row  # xlUp
  for ($r = 1; $r -le $last; $r++) { if ([string]$ws.Cells.Item($r, $col).Value2 -eq $text) { return } }
  $ws.Cells.Item($last + 1, $col).Value2 = $text
}

$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Open($Path)
  $mice = $wb.Worksheets.Item('Mice').ListObjects.Item('Mice')
  $reg = $wb.Worksheets.Item('Regimens').ListObjects.Item('Regimens')
  $groups = $wb.Worksheets.Item('Groups')
  $id = Find-Column $mice @('Animal ID', 'Mouse ID')
  $vol = Find-Column $reg @(('Volume (' + [char]0xB5 + 'L)'), 'Volume (uL)', 'Volume')
  if (-not $id) { throw 'The Mice table has no Animal ID or Mouse ID column.' }

  # The group's start: the Groups sheet column headed "Treatment start".
  $gs = $groups.Rows.Item(1).Find('Treatment start', [Type]::Missing, -4163, 1)  # xlValues, xlWhole
  if (-not $gs) { throw 'The Groups sheet has no "Treatment start" header in row 1.' }
  $gcol = $groups.Range($groups.Cells.Item(2, $gs.Column), $groups.Cells.Item(500, $gs.Column)).Address($true, $true)
  $gname = $groups.Range('A2:A500').Address($true, $true)

  Write-Output 'Mice'
  if (Add-TableColumn $mice 'Treatment start') {
    $c = $mice.ListColumns.Item('Treatment start').DataBodyRange
    $c.NumberFormat = 'yyyy-mm-dd'
    $c.Validation.Delete()
    [void]$c.Validation.Add(4, 1, 7, '=DATE(2020,1,1)')  # xlValidateDate, stop, >=
    $c.Validation.InputMessage = "This mouse's own treatment start (the day it was enrolled). Leave blank to use its group's start (Groups sheet)."
  }
  if (Add-TableColumn $mice 'Start used') {
    $c = $mice.ListColumns.Item('Start used').DataBodyRange
    Set-Formula $c ('=LET(s,Mice[@[Treatment start]],g,IFERROR(INDEX(Groups!{G},MATCH(Mice[@Group],Groups!{N},0)),""),IF(s<>"",s,IF(OR(g="",g=0),"",g)))'.Replace('{G}', $gcol).Replace('{N}', $gname))
    $c.NumberFormat = 'yyyy-mm-dd'
    $c.Font.Color = 0x7F7F7F
  }

  Write-Output 'Regimens'
  $rws = $reg.Parent
  if (Add-TableColumn $reg 'Days') {
    $col = $reg.ListColumns.Item('Days').Range.Column
    # Text, so Excel keeps "0, 2" as typed (as a number "10,100" would become 10100).
    $rws.Range($rws.Cells.Item(2, $col), $rws.Cells.Item(500, $col)).NumberFormat = '@'
    $help = $rws.Rows.Item(1).Find('How this works', [Type]::Missing, -4163, 1)
    if ($help) {
      Add-HelpLine $rws $help.Column 'Days: when to give the drug, in days from each mouse''s treatment start (0 = the start day), separated by commas, e.g. 0, 2, 4. Leave it empty for a drug not on a schedule. The Checklist, the Plan sheet and the app read it.'
    }
  }

  Write-Output 'Groups'
  $found = $groups.UsedRange.Find('Measure every (days)', [Type]::Missing, -4163, 1)
  if ($found) {
    Write-Output "  measurement settings already at $($found.Address($false, $false))"
    $every = $found.Offset(0, 1); $from = $found.Offset(1, 1)
  } else {
    if ($xl.WorksheetFunction.CountA($groups.Range('K1:L2')) -gt 0) { throw 'Groups!K1:L2 is not empty; clear it and run again.' }
    $groups.Range('K1').Value2 = 'Measure every (days)'
    $groups.Range('K2').Value2 = 'Measure from'
    $groups.Range('K1:K2').Font.Bold = $true
    $groups.Range('L1').Value2 = 2
    $dates = $wb.Worksheets.Item('Measurements').ListObjects.Item('Measurements').ListColumns.Item('Date').DataBodyRange
    $groups.Range('L2').Value2 = $xl.WorksheetFunction.Max($dates)  # the latest session; change it if you skip a day
    $groups.Range('L2').NumberFormat = 'yyyy-mm-dd'
    $groups.Range('L1:L2').Interior.Color = 0xCCF2FF  # light yellow: typed settings
    [void]$groups.Columns.Item('K').AutoFit()
    $every = $groups.Range('L1'); $from = $groups.Range('L2')
    $help = $groups.Rows.Item(1).Find('How this works', [Type]::Missing, -4163, 1)
    if ($help) {
      Add-HelpLine $groups $help.Column 'Measure every (days) and Measure from (K1:L2): mice are weighed and measured every that many days, counting from that date. If you skip or move a day, set Measure from to the new measurement day. The Checklist, the Plan sheet and the app read it.'
      Add-HelpLine $groups $help.Column 'Treatment start here is the group''s; a mouse''s own Treatment start on the Mice sheet (staggered enrollment) wins over it.'
    }
    Write-Output '  added Measure every (days) = 2 and Measure from in K1:L2'
  }
  Set-Name $wb 'MeasureEvery' ("='" + $every.Worksheet.Name + "'!" + $every.Address($true, $true))
  Set-Name $wb 'MeasureFrom' ("='" + $from.Worksheet.Name + "'!" + $from.Address($true, $true))

  # Drugs due for the mouse in column A (group in column B) on the date in $dateRef: drug and volume, joined by " + ".
  # A day k is due when ",k," is in "," & the Days text without spaces & "," (the app reads Days the same way).
  $volPart = if ($vol) { '&IF(Regimens[{V}]="",""," "&Regimens[{V}]&" "&UNICHAR(181)&"L")'.Replace('{V}', $vol) } else { '' }
  $due = 'IFERROR(TEXTJOIN(" + ",TRUE,FILTER(Regimens[Drug]{VOL},(Regimens[Group]=$B{R})*ISNUMBER(SEARCH(","&({D}-s)&",",","&SUBSTITUTE(Regimens[Days]&""," ","")&",")),"")),"")'.Replace('{VOL}', $volPart)
  $startOf = 'XLOOKUP($A{R},Mice[{ID}],Mice[Start used],"")'.Replace('{ID}', $id)

  Write-Output 'Checklist'
  $cl = $wb.Worksheets.Item('Checklist')
  if ([string]$cl.Range('H5').Formula -like '*SEARCH*') {
    Write-Output '  already done'
  } else {
    if ([string]$cl.Range('B1').Formula -eq '') { $cl.Range('B1').Formula = '=TODAY()' }
    $cl.Range('B1').NumberFormat = 'ddd yyyy-mm-dd'
    $cl.Range('B1').Font.Bold = $true
    Set-Formula $cl.Range('D1') '=IF(B1="","",IF(MOD(B1-MeasureFrom,MeasureEvery)=0,"Measure day","Injections only, no measurements"))'
    $cl.Range('D1').Font.Bold = $true
    $cl.Range('H4').ClearContents()  # the old spill (all of the group's drugs)
    $inj = '=IF(OR($A{R}="",$B$1=""),"",LET(s,{START},IF(OR(s="",s=0),"not started",{DUE})))'.Replace('{START}', $startOf).Replace('{DUE}', $due.Replace('{D}', '$B$1')).Replace('{R}', '4')
    Set-Formula $cl.Range('H4:H300') $inj
    # New rules first, so they win over the group colors on A4:I300.
    $fc = $cl.Range('H4:H300').FormatConditions.Add(2, [Type]::Missing, '=AND($H4<>"",$H4<>"not started")')  # xlExpression
    $fc.Interior.Color = 0x99E6FF; $fc.Font.Bold = $true; $fc.SetFirstPriority()
    $fc = $cl.Range('H4:H300').FormatConditions.Add(2, [Type]::Missing, '=$H4="not started"')
    $fc.Font.Color = 0x7F7F7F; $fc.Font.Italic = $true; $fc.SetFirstPriority()
    $fc = $cl.Range('E4:G300').FormatConditions.Add(2, [Type]::Missing, '=AND($A4<>"",$B$1<>"",MOD($B$1-MeasureFrom,MeasureEvery)<>0)')
    $fc.Interior.Color = 0xD9D9D9; $fc.SetFirstPriority()
    $cl.Columns.Item('H').ColumnWidth = [Math]::Max($cl.Columns.Item('H').ColumnWidth, 22)
    Write-Output '  B1 = today, D1 = measure day or not, Inj = drugs due that day'
  }

  # Injected Drugs marks "missed <drug>" when a groupmate got a drug that day and this mouse did not. With staggered
  # enrollment a mouse not started by that day (Start used blank or later) was not due anything: skip it there.
  Write-Output 'Injected Drugs'
  $idr = $null
  foreach ($s in $wb.Worksheets) { if ($s.Name -eq 'Injected Drugs') { $idr = $s } }
  if (-not $idr) {
    Write-Output '  no Injected Drugs sheet'
  } elseif ([string]$idr.Range('E2').Formula -like '*Start used*') {
    Write-Output '  already done'
  } else {
    $what = 'IF(OR(grp="Ungrouped",ended),""'
    $with = 'IF(OR(grp="Ungrouped",ended,LET(s,XLOOKUP(id,Mice[{ID}],Mice[Start used],""),OR(s="",s=0,s>d))),""'.Replace('{ID}', $id)
    # The sheet may be protected (no password) to keep its formulas from being typed over: Replace silently does
    # nothing there. Unprotect it for the change and protect it again with the same options.
    $prot = $null
    if ($idr.ProtectContents -or $idr.ProtectDrawingObjects -or $idr.ProtectScenarios) {
      $p = $idr.Protection
      $prot = @($idr.ProtectDrawingObjects, $idr.ProtectContents, $idr.ProtectScenarios, $false,
        $p.AllowFormattingCells, $p.AllowFormattingColumns, $p.AllowFormattingRows, $p.AllowInsertingColumns,
        $p.AllowInsertingRows, $p.AllowInsertingHyperlinks, $p.AllowDeletingColumns, $p.AllowDeletingRows,
        $p.AllowSorting, $p.AllowFiltering, $p.AllowUsingPivotTables)
      $idr.Unprotect()  # throws if it has a password: unprotect it in Excel and run again
    }
    # Not Range.Replace: it rewrites through the legacy Formula property, which turns every table reference into an
    # implicit intersection (Injections[@Drug]) and breaks the formula. Instead, take the block of formulas around E2
    # (one formula filled across it), check every cell holds the same R1C1 formula, and write it back as Formula2R1C1.
    $old = [string]$idr.Range('E2').Formula2R1C1
    $block = $null
    foreach ($a in $idr.UsedRange.SpecialCells(-4123).Areas) {  # xlCellTypeFormulas
      # Bounds, not Application.Intersect (PowerShell cannot call it with fewer than its 30 arguments).
      if ($a.Row -le 2 -and $a.Row + $a.Rows.Count -gt 2 -and $a.Column -le 5 -and $a.Column + $a.Columns.Count -gt 5) { $block = $a }
    }
    $same = $true
    if ($block) { foreach ($c in $block.Cells) { if ([string]$c.Formula2R1C1 -ne $old) { $same = $false; break } } }
    if ($block -and $same -and $old.Contains($what)) {
      $block.Formula2R1C1 = $old.Replace($what, $with)
      Write-Host "  rewrote $($block.Address($false, $false))"
    }
    if ($prot) {
      $idr.Protect([Type]::Missing, $prot[0], $prot[1], $prot[2], $prot[3], $prot[4], $prot[5], $prot[6], $prot[7],
        $prot[8], $prot[9], $prot[10], $prot[11], $prot[12], $prot[13], $prot[14])
    }
    if ([string]$idr.Range('E2').Formula -like '*Start used*') {
      Write-Output '  "missed" now only for mice started by that day'
    } else {
      Write-Output '  NOT changed: its formula is not the expected one; mice not yet started may show "missed" there'
    }
  }

  Write-Output 'Plan'
  $plan = $null
  foreach ($s in $wb.Worksheets) { if ($s.Name -eq 'Plan') { $plan = $s } }
  if ($plan) {
    Write-Output '  already there'
  } else {
    $plan = $wb.Worksheets.Add([Type]::Missing, $cl)
    $plan.Name = 'Plan'
    $plan.Range('A1').Value2 = 'From:'
    $plan.Range('B1').Formula = '=TODAY()'
    $plan.Range('B1').NumberFormat = 'ddd yyyy-mm-dd'
    $plan.Range('A1:B1').Font.Bold = $true
    $plan.Range('D1').Value2 = 'Drugs due each day from each mouse''s treatment start (Regimens Days). M = measurement day. Type a date in B1 to look further ahead.'
    $plan.Range('A2').Value2 = 'Measure:'
    # By address: Cells.Item(3, $k + 1) in a loop fails here with "Specified cast is not valid".
    $plan.Range('A3').Value2 = 'Animal ID'
    $plan.Range('B3').Value2 = 'Group'
    $plan.Range('C3').Value2 = 'Cage ID'
    $plan.Range('D3').Value2 = '#'
    Set-Formula $plan.Range('E3') '=SEQUENCE(1,21,$B$1)'
    $plan.Range('E3:Y3').NumberFormat = 'ddd d'
    Set-Formula $plan.Range('E2:Y2') '=IF(MOD(E$3-MeasureFrom,MeasureEvery)=0,"M","")'
    $plan.Range('A2:Y3').Font.Bold = $true
    $plan.Range('E2:Y3').HorizontalAlignment = -4108  # center
    # The same mice as the Checklist: alive, by current cage and tail mark.
    Set-Formula $plan.Range('A4') ('=LET(m,CHOOSE({1,2,3,4},Mice[{ID}],Mice[Group]&"",Mice[Current cage],Mice[Current tail mark]),SORT(FILTER(m,(Mice[{ID}]<>"")*((Mice[Status]="alive")+(Mice[Status]="")),""),{3,4}))'.Replace('{ID}', $id))
    $cell = '=IF($A{R}="","",LET(s,{START},IF(OR(s="",s=0),"",{DUE})))'.Replace('{START}', $startOf).Replace('{DUE}', $due.Replace('{D}', 'E$3')).Replace('{R}', '4')
    Set-Formula $plan.Range('E4:Y203') $cell
    $fc = $plan.Range('E4:Y203').FormatConditions.Add(2, [Type]::Missing, '=E4<>""')
    $fc.Interior.Color = 0x99E6FF
    $fc = $plan.Range('E2:Y203').FormatConditions.Add(2, [Type]::Missing, '=AND($A$1<>"",E$2="M")')
    $fc.Borders.Item(-4131).LineStyle = 1; $fc.Borders.Item(-4152).LineStyle = 1  # xlLeft, xlRight
    $plan.Columns.Item('A').ColumnWidth = 11
    $plan.Range('E:Y').ColumnWidth = 9
    $plan.Range('E4:Y203').Font.Size = 9
    $plan.Activate()
    $xl.ActiveWindow.FreezePanes = $false
    [void]$plan.Range('E4').Select()
    $xl.ActiveWindow.FreezePanes = $true
    Write-Output '  added Plan (21 days from B1)'
  }

  $xl.CalculateFull()
  $wb.Save()
  $wb.Close($false)
  Write-Output "Saved $Path"
} finally {
  $xl.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
  [GC]::Collect()
}

# Build a study workbook (.xlsx) with Excel from the JSON that note-to-workbook.js writes.
# Windows with Excel only. Usage:
#   powershell -File tools/build-workbook.ps1 -Json rows.json -Out "C:\path\Study Data.xlsx"
# Sheets: Measurements (one row per mouse per session) and Mice (one row per mouse), each an Excel table,
# with dropdowns for Status, End reason and the Mouse ID of a measurement. -Out must be an absolute path.
param(
  [Parameter(Mandatory = $true)][string]$Json,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$data = [IO.File]::ReadAllText((Resolve-Path $Json), [Text.Encoding]::UTF8) | ConvertFrom-Json

function Write-Table($ws, [string]$name, [object[]]$columns, [object[]]$rows) {
  # $columns: @{ head; key; format } where format is '@' (text), 'date', or a number format.
  $n = $rows.Count + 1
  $m = $columns.Count
  for ($c = 0; $c -lt $m; $c++) {
    $f = $columns[$c].format
    if ($f -eq '@') { $ws.Columns.Item($c + 1).NumberFormat = '@' }
  }
  $arr = New-Object 'object[,]' $n, $m
  for ($c = 0; $c -lt $m; $c++) { $arr[0, $c] = $columns[$c].head }
  for ($r = 0; $r -lt $rows.Count; $r++) {
    for ($c = 0; $c -lt $m; $c++) {
      $v = $rows[$r].($columns[$c].key)
      if ($null -eq $v) { continue }
      if ($columns[$c].format -eq 'date') { $v = [DateTime]::ParseExact($v, 'yyyy-MM-dd', $null).ToOADate() }
      elseif ($columns[$c].format -eq '@') { $v = [string]$v }
      $arr[($r + 1), $c] = $v
    }
  }
  $range = $ws.Range($ws.Cells.Item(1, 1), $ws.Cells.Item($n, $m))
  $range.Value2 = $arr
  $lo = $ws.ListObjects.Add(1, $range, $null, 1)  # xlSrcRange, has headers
  $lo.Name = $name
  $lo.TableStyle = 'TableStyleMedium2'
  for ($c = 0; $c -lt $m; $c++) {
    $f = $columns[$c].format
    if ($f -and $f -ne '@' -and $lo.ListColumns.Item($c + 1).DataBodyRange) {
      $lo.ListColumns.Item($c + 1).DataBodyRange.NumberFormat = $(if ($f -eq 'date') { 'yyyy-mm-dd' } else { $f })
    }
  }
  [void]$ws.UsedRange.Columns.AutoFit()
  for ($c = 1; $c -le $m; $c++) { if ($ws.Columns.Item($c).ColumnWidth -lt 11) { $ws.Columns.Item($c).ColumnWidth = 11 } }
  return $lo
}

function Add-List($range, [string]$formula, [int]$alert) {
  # xlValidateList = 3, alert: 1 stop, 2 warning
  $range.Validation.Delete()
  [void]$range.Validation.Add(3, $alert, 1, $formula)
  $range.Validation.IgnoreBlank = $true
}

function Freeze-Header($xl, $ws) {
  $ws.Activate()
  $xl.ActiveWindow.FreezePanes = $false
  $xl.ActiveWindow.SplitColumn = 0
  $xl.ActiveWindow.SplitRow = 1
  $xl.ActiveWindow.FreezePanes = $true
}

$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Add()
  while ($wb.Worksheets.Count -lt 2) { [void]$wb.Worksheets.Add([Type]::Missing, $wb.Worksheets.Item($wb.Worksheets.Count)) }
  while ($wb.Worksheets.Count -gt 2) { $wb.Worksheets.Item($wb.Worksheets.Count).Delete() }
  $ms = $wb.Worksheets.Item(1); $ms.Name = 'Measurements'
  $mi = $wb.Worksheets.Item(2); $mi.Name = 'Mice'

  $miceCols = @(
    @{ head = 'Mouse ID'; key = 'id'; format = '@' },
    @{ head = 'Sex'; key = 'sex' },
    @{ head = 'Group'; key = 'group'; format = '@' },
    @{ head = 'Status'; key = 'status' },
    @{ head = 'End date'; key = 'endDate'; format = 'date' },
    @{ head = 'End reason'; key = 'endReason' },
    @{ head = 'Notes'; key = 'notes' }
  )
  $miceTable = Write-Table $mi 'Mice' $miceCols @($data.mice)
  Add-List $miceTable.ListColumns.Item(4).DataBodyRange 'alive,euthanized,found dead,removed' 1
  Add-List $miceTable.ListColumns.Item(6).DataBodyRange 'weight loss,tumor volume,ulceration,body condition,end of study,other' 2
  Add-List $miceTable.ListColumns.Item(2).DataBodyRange 'F,M' 2

  $measCols = @(
    @{ head = 'Date'; key = 'date'; format = 'date' },
    @{ head = 'Cage'; key = 'cage' },
    @{ head = 'Tail mark'; key = 'mark' },
    @{ head = 'Mouse ID'; key = 'id'; format = '@' },
    @{ head = 'Weight (g)'; key = 'weight'; format = '0.00' },
    @{ head = 'Tumor Length'; key = 'length'; format = '0.00' },
    @{ head = 'Tumor Breadth'; key = 'breadth'; format = '0.00' },
    @{ head = 'Notes'; key = 'notes' }
  )
  $measTable = Write-Table $ms 'Measurements' $measCols @($data.measurements)
  Add-List $measTable.ListColumns.Item(4).DataBodyRange '=INDIRECT("Mice[Mouse ID]")' 2
  $ms.Columns.Item(8).ColumnWidth = 30
  $mi.Columns.Item(7).ColumnWidth = 40

  if ($data.about) {
    $ab = $wb.Worksheets.Add([Type]::Missing, $wb.Worksheets.Item($wb.Worksheets.Count))
    $ab.Name = 'About'
    $ab.Cells.Item(1, 1).Value2 = $data.about
    $ab.Cells.Item(1, 1).Font.Bold = $true
  }

  Freeze-Header $xl $mi
  Freeze-Header $xl $ms
  if (Test-Path $Out) { Remove-Item $Out -Force }
  $wb.SaveAs($Out, 51)  # xlOpenXMLWorkbook
  $wb.Close($false)
  Write-Output "Wrote $Out ($($data.mice.Count) mice, $($data.measurements.Count) measurement rows)"
} finally {
  $xl.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
  [GC]::Collect()
}

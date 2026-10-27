<#
.SYNOPSIS
  Export the result tables of a CATE / EVO Access database (.mdb) to CSV files the dashboard can load.

.DESCRIPTION
  Uses the Microsoft Access Database Engine (ACE OLEDB 12.0) that ships with Office. Writes one CSV per
  table in the same layout as the Access "export to text" CSVs (every field quoted, header row), named
  <Prefix>_<Table>.csv, e.g. CATE1001_Sensitivity.csv, so the dashboard detects both the machine and the
  measurement from the file name. Also writes <Prefix>_<Table>.count.txt with the row count, and (unless
  -NoBundle) <Prefix>.csv: every exported table in one file, each introduced by a "#table=<Table>" line, which
  the dashboard loads like the .mdb itself.

  How it works: the database is opened read-only through ADODB, the schema rowset tells which of the
  requested tables exist, and each table is read with "SELECT * ORDER BY AutoNumber". Rows are pulled in
  blocks of -Chunk records with Recordset.GetString using the control characters 0x01 / 0x02 as column and
  row delimiters, then turned into quoted CSV text by three string replacements (fast; no per-field loop).
  The bundle file is built by concatenating the per-table CSVs behind a "#table=<Table>" marker line.
  dev/test-jet.js uses the exported files as the oracle for the browser's Access reader; tools/export_mdb.bat wraps this script.

.PARAMETER Mdb      Source database (.mdb / .accdb).
.PARAMETER OutDir   Output folder, created when missing.
.PARAMETER Tables   Tables to export (default: every result table of the CATE and EVO testers); missing ones are skipped.
.PARAMETER Prefix   File-name prefix; default = machine name found in the database name (CATE_1001 -> CATE1001).
.PARAMETER NoBundle Skip the <Prefix>.csv bundle.
.PARAMETER Chunk    Rows per GetString call.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\export_mdb.ps1 -Mdb ..\data\CATE_1001.mdb -OutDir ..\data\ref\CATE1001
#>
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string[]]$Tables = @('Sensitivity', 'MCBiasResults', 'MuxAuxPSResults', 'OscillationResults', 'SCPreResults', 'NoiseResults', 'BTEResults', 'MEMSCurrentResults', 'MEMSSCResults'),
  [string]$Prefix = '',
  [switch]$NoBundle,
  [int]$Chunk = 50000
)
$ErrorActionPreference = 'Stop'
$Mdb = (Resolve-Path $Mdb).Path
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$OutDir = (Resolve-Path $OutDir).Path
# machine prefix from the database name unless given
if ($Prefix -eq '') {
  $m = [regex]::Match([IO.Path]::GetFileNameWithoutExtension($Mdb), '(CATE|EVO)[_ -]?(\d{4})', 'IgnoreCase')
  $Prefix = if ($m.Success) { $m.Groups[1].Value.ToUpper() + $m.Groups[2].Value } else { [IO.Path]::GetFileNameWithoutExtension($Mdb) }
}
$c = New-Object -ComObject ADODB.Connection
$c.Open("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$Mdb;Mode=Read")
try {
  # adSchemaTables (20): list the user tables so missing ones can be skipped cleanly
  $schema = $c.OpenSchema(20)
  $present = @{}
  while (-not $schema.EOF) { if ($schema.Fields.Item('TABLE_TYPE').Value -eq 'TABLE') { $present[$schema.Fields.Item('TABLE_NAME').Value] = $true }; $schema.MoveNext() }
  $colDelim = [string][char]1; $rowDelim = [string][char]2
  $exported = @()
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  foreach ($t in $Tables) {
    if (-not $present.ContainsKey($t)) { Write-Output "skip $t (not in database)"; continue }
    $path = Join-Path $OutDir ($Prefix + '_' + $t + '.csv')
    $sw = New-Object System.IO.StreamWriter($path, $false, $utf8)
    $rs = $c.Execute("SELECT * FROM [$t] ORDER BY AutoNumber")
    $names = @(); for ($i = 0; $i -lt $rs.Fields.Count; $i++) { $names += ('"' + $rs.Fields.Item($i).Name + '"') }
    $sw.Write(($names -join ',') + "`r`n")
    $rows = 0
    # GetString(adClipString = 2) returns up to $Chunk rows joined by the delimiters; escape quotes, then turn the delimiters into CSV field / record separators
    while (-not $rs.EOF) {
      $s = $rs.GetString(2, $Chunk, $colDelim, $rowDelim, '')
      if ($s.Length -eq 0) { break }
      $rows += ([regex]::Matches($s, $rowDelim)).Count
      $s = $s.Replace('"', '""').Replace($colDelim, '","').Replace($rowDelim, "`"`r`n`"")
      $sw.Write('"' + $s.Substring(0, $s.Length - 1))
    }
    $sw.Close()
    Set-Content -Path (Join-Path $OutDir ($Prefix + '_' + $t + '.count.txt')) -Value $rows
    Write-Output ("{0}: {1} rows -> {2}" -f $t, $rows, $path)
    if ($rows -gt 0) { $exported += $t }
  }
} finally { $c.Close() }
# bundle: marker line + the per-table CSV bytes, in export order
if (-not $NoBundle -and $exported.Count) {
  $bundlePath = Join-Path $OutDir ($Prefix + '.csv')
  $bs = [IO.File]::Create($bundlePath)
  foreach ($t in $exported) {
    $mark = $utf8.GetBytes("#table=$t`r`n"); $bs.Write($mark, 0, $mark.Length)
    $src = [IO.File]::OpenRead((Join-Path $OutDir ($Prefix + '_' + $t + '.csv'))); $src.CopyTo($bs); $src.Close()
  }
  $bs.Close()
  Write-Output ("bundle: {0} tables -> {1}" -f $exported.Count, $bundlePath)
}

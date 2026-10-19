# ATE Run Chart Dashboard

A single-page, backend-free replacement for `generate_all_run_charts.py`. Open `CATEDASHBOARD.html` in a browser, drop the machine CSV exports or the Access `.mdb` databases, pick a date range and a measurement, and browse the run charts per coil.

## How to open

Double-click `cateDashboard/CATEDASHBOARD.html` (or drag it into Chrome / Edge). No server, no install, no internet. The page works from a `file://` URL and never makes a network request.

## Workflow

1. **Data files**: drop `.csv` exports or `.mdb` databases. The machine is detected from the file name, which must contain `CATE1001`, `CATE1003`, `CATE1006`, `CATE1007`, `EVO1001`, `EVO1002` or `NATE1001` (any case; `CATE_1001.mdb` and `EVO1002_Data_Results.mdb` also match). An `.mdb` is read directly in the browser with a built-in Access (Jet4) page reader and loads every result table it contains (`Sensitivity`, `MCBiasResults`, `MuxAuxPSResults`, `OscillationResults`, `SCPreResults`), Sensitivity first; the file is streamed page by page, never loaded whole. A CSV holds one table: the measurement is taken from a table name in the file name (e.g. `CATE1001_MCBiasResults.csv`) or, failing that, from the columns (`NetName` with/without `USL`, `Frequency`, `TestCase` without `LSL`) and the `Units` of the first row (`dB` = Sensitivity, `V`/`A` = MCBias). A CSV can also be a **bundle** holding every table of a machine: each table is introduced by a `#table=<TableName>` line followed by its own header row (a second header row without a marker starts a new table too, detected from its columns). `tools/export_mdb.ps1` writes such a bundle (`CATE1001.csv`, `EVO1002.csv`) next to its per-table files, and `tools/atml_to_mdb.ps1` writes `NATE1001.csv`; dropping the bundle loads every table exactly like the `.mdb`. Sections for non-measurement tables (`IdentifyCoil`, `SourceFiles`, `SkippedFiles`) are skipped, empty sections stay "(no data)". Dropping an `.mdb` replaces everything loaded for that machine; dropping a CSV replaces only that machine's dataset(s) for the measurement(s) it holds, so several CSVs per machine can be combined. Each file parses in its own background worker with a progress bar. The file list shows one summary line per machine (table count and date span); hover a row for the per-table rows, dates and dropped counts, or click it to keep them open. On the overview, clicking a machine in the Data coverage table selects it (purple) and restricts Charts by coil to the coils that machine has data for in the current measurement, with that machine's chart and point counts; opening a coil from that list applies the machine filter. Click the row again to show every machine. The *Tables loaded* column shows one chip per data type a machine holds; the chip of the data type listed below is outlined, and clicking a chip selects that machine **and** switches Charts by coil to that data type (a *Data type* chip row under the Charts by coil heading does the same for every machine). Files with Windows-1252 characters are handled automatically. EVO databases are accepted through the same path (they have no Sensitivity table); EVO-specific handling is a later iteration. `tools/export_mdb.bat <file.mdb>` exports the same tables to dashboard-ready CSVs with the Access engine, as a fallback and as the test oracle for the reader.
2. **Date range**: the range is inclusive of both days (rows with `start <= TimeDate < end + 1 day`). Presets fill the range from the data actually loaded. Per-coil overrides give individual coils their own range; the coil is picked from a dropdown of every coil found in the loaded CSV files (the Python default `1.5T GEM PA: 2026-01-01 .. today` is pre-seeded). Settings persist in the browser's local storage.
3. **Coils**: charts regenerate automatically when data or the range changes. Click a coil to open the viewer.
4. **Viewer**: *Single* shows one chart at a time with Prev / Next, arrow keys, filters (measurement, machine, mode, test case or net), read-only Channel / Element readouts for the chart on screen, a hover tooltip, and a PNG download at the same 3900 x 2100 size as the Python output. The Machine selector defaults to all machines overlaid; choosing one machine redraws every chart with only that machine's points (title suffix and file name gain the machine name, e.g. `TC01_Ch14_EL1_CATE1003.png`) and hides charts that machine has no data for. *Library* shows a scrollable grid of thumbnails drawn lazily as they come into view; click one to open it. *Download all (zip)* renders every chart of the coil into `<coil>/Mode_<mode>/TC##_Ch#_E#.png` inside a zip.

You can start browsing as soon as the first file has loaded. While other files are still processing, the viewer shows a "partial data" banner, charts update automatically as each file finishes, and PNGs downloaded in that window carry a "PARTIAL DATA" watermark.

## What the charts reproduce

The same cleaning, grouping and styling as the Python script: one scatter chart per coil x (Mode, TestCase, Channel, Element), machines overlaid in the fixed order CATE1001, CATE1007, CATE1003, CATE1006, EVO1001, EVO1002 with the matplotlib colours (green down-triangles and cyan hexagons for the EVO machines), LSL (red dashed) and USL (dark red dash-dot) lines, legend with distinct coil and point counts, `- Single CATE` title suffix, `Specification limit: N/A` note, and the same output file names. Two intentional differences: CATE1007 is labelled with its real name (the script labelled it CATE1002), and each machine also has its own marker shape so the series remain distinguishable for colour-blind readers.

## Measurements

In the viewer, picking a measurement the open coil has no rows for (or none in the current date range) keeps the coil open: the dropdown snaps back and a note under the title explains why; such entries are labelled "(none for this coil)". The **Measurement** selector in the filter row switches the whole dashboard (coil list, overview, viewer, library, zip) between the result tables that have been loaded; entries without data are greyed out, and the choice is remembered. If the remembered measurement has no data after a load (for example Noise was open and only Sensitivity CSVs were dropped), the dashboard falls back to the first measurement that has data, and an empty Charts by coil list says why (no rows in the date range, or no machine has that measurement). Each is plotted as measurement value over time with the specification limits read from that table's own `LSL` / `USL` columns (see *Spec revisions* below):

| Measurement | Table | One chart per | Limits | Units |
|---|---|---|---|---|
| Sensitivity (default) | `Sensitivity` | Mode, TestCase, Channel, Element | LSL / USL | dB |
| MCBias | `MCBiasResults` | Mode, TestCase, Channel, Element | LSL / USL | V (A for a few coils) |
| MuxAuxPS | `MuxAuxPSResults` | Mode, NetName | LSL / USL | A |
| Oscillation | `OscillationResults` | Mode, TestCase, Channel, Element | USL only | dB |
| SCPre | `SCPreResults` | Mode, NetName | LSL only | V |
| Noise (EVO) | `NoiseResults` | Mode, TestCase, Channel, Element | LSL / USL on **Difference** | dB (Difference = Measurement − Baseline; Measurement in dBm/Hz) |
| BTE (EVO, unverified) | `BTEResults` | Mode, TestedLine | LSL / USL | from data |
| MEMSCurrent (EVO, unverified) | `MEMSCurrentResults` | Mode, TestedLine | LSL / USL | from data |
| MEMSSC (EVO, unverified) | `MEMSSCResults` | Mode, TestedLine | LSL only | from data |

**Spec revisions.** When a group's `LSL` or `USL` changed over time (a spec revision rolled out to the testers), each limit is drawn only over the period it applied: the first value runs from the left edge to the first row of the next value, the latest value runs to the right edge, and a thin dotted riser marks the first test date of each new value. If the testers switched on different dates the old line keeps running past the riser until its last use, so the overlap is visible. The legend labels the revisions `LSL 1 = -6.93 to 07/10/2026`, `LSL 2 = -7.50 from 04/01/2026`. Statistics judge each point against the limit of its own row (the spec in force on that test date) and compute Cpk against the latest revision; the footnote says so. Hovering a point shows that row's own LSL / USL.

NetName and TestedLine tables use a **Net** / **Line** filter instead of Test case and are saved as `Net_<name>.png` / `Line_<name>.png`; their titles read `P_MUX1 MuxAuxPS vs Date`. The y-axis label, tooltip, legend and statistics use the units found in the data (the `SCPreResults` table swaps its PassFail and Units columns in some rows; the dashboard takes whichever is not PASS/FAIL). Voltage and current measurements print three decimals and use smaller axis padding and outlier floors than the dB tables (see below).

## EVO testers

`EVO1001_Data_Results.mdb` and `EVO1002_Data_Results.mdb` load through the same reader. They have no `Sensitivity` table; they share `MCBiasResults`, `MuxAuxPSResults`, `OscillationResults` (units dBm, with the oscillation `Frequency` shown in the tooltip) and `SCPreResults` with the CATE testers, and add:

- **NoiseResults**: the pass/fail limits apply to `Difference = Measurement − Baseline` (the baseline is a constant −147.50 dBm/Hz), so the Noise chart plots the Difference in dB against its LSL/USL; the raw Measurement and the Baseline appear in the tooltip. Rows whose limits are `NA` are plotted without spec lines.
- **BTEResults, MEMSCurrentResults, MEMSSCResults**: keyed by `TestedLine`. Both EVO files have these tables empty, so the schemas are in place but unverified; they appear in the Measurement list as soon as a file with rows is loaded. Empty tables are skipped silently (the measurement stays "(no data)").
- **Port**: every EVO row carries the tester port (1 or 2). It is shown in the tooltip, and a **Port** filter appears in the filter row whenever a coil has data on more than one port (it also restricts the drawn points and adds `· Port N` to the title).
- `IdentifyCoil` is a coil-identity log, not a measurement, and is ignored.

EVO modes are short codes (`1`, `1A`, `5E` …) while CATE uses `ALL` / `All Modes`, so the same coil usually gets separate EVO and CATE charts; where the mode names coincide the machines are overlaid as usual. The title suffix reads `- Single EVO` or `- Single CATE` when only one machine has data. Serial numbers come in two forms (`00251` and `000835-302823625`); for distinct-coil counts the part before the dash with leading zeros stripped is used, so both forms count as one coil (the full serial number is still shown in the tooltip).

## NATE tester (CATE 2.0 ATML reports)

The NATE / CATE 2.0 tester does not write a database: TestStand saves one ATML XML report per run (`<PN>_<SN>_<DD>_<Mon>_<YYYY>_<HHMM>_log.xml`, about 14,600 files / 8 GB in `data/NATE CATE 2/DataArchive/FAC/FAC`). `tools/atml_to_mdb.ps1` converts them into one Access database with the CATE/EVO table layout (every column `TEXT(255)`, `AutoNumber` key, plus `Port` and a `RunID` that links each row to its report in the `SourceFiles` table); `tools/convert_nate.bat trial|sample|full|rebuild` wraps it. The parser is C# compiled by PowerShell at run time; the database is written with the Access engine (ADOX + DAO), so nothing has to be installed. About 14,000 reports convert in roughly 10 minutes; re-running only adds reports not yet listed in `SourceFiles` / `SkippedFiles`.

| XML test group | Table | Notes |
|---|---|---|
| sensitivity | `Sensitivity` | S21 in **dBm**; alternating biased / unbiased test cases |
| multicoil_bias (Bias Voltage) | `MCBiasResults` | V |
| multicoil_bias (Bias Current) | `MCBiasCurrentResults` | A (new measurement **MCBias Current**) |
| noise_power_density | `NoiseResults` | stored in the EVO convention: `Baseline` = reference reading, `Difference` = Measurement − Baseline, LSL/USL shifted by the baseline |
| preamp_short_circuit | `SCPreResults` | NetName = PREAMP_A / B / BX, LSL and USL |
| power_draw, mux_sink | `MuxAuxPSResults` | NetName = supply net or `MUX_SINK` |
| coil_present | `CoilPresentResults` | NetName = task (P1CoilPresent …); new measurement **Coil Present** |
| coil_id FileContent | `IdentifyCoil` | ROM serial, EPROM page text and the expected text |

`Channel` is the physical channel named in the test case's bias list; unbiased test cases take the channel the same element was biased on in that run (else the element). Mode is the tester's `File Mode` (`1` for almost every run), so NATE charts do not merge with CATE/EVO charts of the same coil. Aborted runs contribute whatever Coil Present / Coil ID rows they recorded; failed runs are kept in full with `PassFail = FAIL`. Empty and malformed reports are listed in `SkippedFiles`, as are TestStand's `TempReport*.xml` copies of a run that is also saved under its normal name (same run uuid; the normally named report wins). NATE1001 draws in red with the same circle markers as CATE1001.

With `-KeepCsv` (every mode of the .bat) the converter also writes the tables as dashboard-ready CSVs in `_csv_NATE1001`: one per table (`NATE1001_<Table>.csv`, exactly the database columns) and the bundle `NATE1001.csv` with all of them; dropping the bundle on the dashboard loads the same seven measurement tables as the .mdb. Checks: `python tools/verify_atml.py <csv folder>` re-derives every row from the XML with an independent parser and compares it with those CSVs; `node dev/test-nate.js <mdb> <csv folder>` reads the database with the dashboard's Jet reader and parse-core, compares row for row, and loads every measurement CSV through the dashboard's CSV path to confirm it detects the right table with the same row count.

## Outliers and statistics

The filter row has three chart options, remembered between sessions:

- **Outliers**: *Flag (off-scale band)* is the default. Each chart's points (all machines pooled, after the machine filter) are tested with a robust modified z-score: a point is flagged when |value − median| exceeds k × 1.4826 × MAD (median absolute deviation), with a floor on the scale (0.5 dB for Sensitivity / Oscillation, 0.01 V for MCBias / SCPre, 0.001 A for MuxAuxPS) and no flagging below 5 points. The axis is scaled to the normal points plus the spec lines. A flagged point that fits within 50 % extra range stays at its true position; points that would stretch the axis are pinned into a shaded band at the top or bottom edge, drawn with a coral ring and their true value printed beside them whenever the text fits without covering another value or marker (crowded values are left unprinted). Hovering a point shows a tooltip with its details; a flagged point adds an OUTLIER line with the actual value, and when several points are drawn on the same spot the tooltip lists them all (up to eight). The tooltip always stays inside the chart frame. *Exclude* removes flagged points from the chart, the statistics and the exported PNG / zip, and prints a note on the chart. *Off* reproduces the Python output with every point on a common scale.
- **k (MAD)**: the threshold (default 3.5; higher is less sensitive).
- **Statistics**: when checked, a table is drawn under the chart (one row per machine plus an overall row) with n, coils, mean, median, sample std dev, min, max, range, outliers, % in spec with pass/fail counts, and Cpk (Cpu or Cpl with a single limit, using the tightest limit when several exist). By default the statistics count every point drawn on the chart, including flagged outliers, so the in-spec percentage and Cpk reflect the real readings. Untick **Include outliers in stats** to describe the non-flagged points only (the Outliers column then reads *excl.* instead of *incl.*). The toggle only applies in Flag mode: Exclude removes the points from chart and statistics alike, and Off never flags any. Footnotes state which choice was in effect. The table is part of the canvas, so Download PNG and the zip include it when it is on and omit it when it is off (the image height changes accordingly). Library thumbnails never show the table.

## Theme

The page chrome uses the GE HealthCare palette from the April 2024 Accent Color Guidelines: Compassion Purple `#6022A6` (Pantone 267 C) as the primary colour with its 80/60/40/20% tints, Gray `#E4E4E4` for borders, and the accent colours only functionally (Turquoise `#45B2C5` for progress on the purple bar, Yellow `#F8D754` for the partial-data banner, Coral `#F37F63` for errors). All colour values are CSS variables at the top of `css/styles.css`. Chart colours are unchanged so the charts still match the Python PNGs.

## Where the data lives

- CSVs and `.mdb` files are read with the browser File API straight into typed arrays in the tab's memory (about 120 MB for the four Sensitivity files; roughly 200 MB when all five tables of `CATE_1001.mdb` are loaded). The `.mdb` itself is read in 4 MB slices as needed.
- Charts are drawn on demand into canvas elements. They are not stored anywhere.
- A PNG or zip exists only when you click Download; it is built in memory and handed to the browser's save dialog.
- Local storage holds only the date-range settings (a few hundred bytes).
- Closing the tab discards everything. Re-drop the CSVs next time.

## Development checks

```
cd cateDashboard
node dev/test-parse.js ../data/CATE1007.csv            # parser unit tests (CSV, measurement detection) + one real file
powershell -ExecutionPolicy Bypass -File tools/export_mdb.ps1 -Mdb ../data/CATE_1001.mdb -OutDir ../data/ref/CATE1001
node --max-old-space-size=4096 dev/test-jet.js ../data/CATE_1001.mdb ../data/ref/CATE1001   # Jet reader vs. Access export, every row and field
powershell -ExecutionPolicy Bypass -File tools/export_mdb.ps1 -Mdb ../data/EVO1002_Data_Results.mdb -OutDir ../data/ref/EVO1002   # same oracle for the EVO files (and EVO1001)
node --max-old-space-size=4096 dev/test-jet.js ../data/EVO1002_Data_Results.mdb ../data/ref/EVO1002
tools\convert_nate.bat sample 300                              # NATE: 300 random ATML reports -> NATE1001_trial.mdb + CSV copies
python tools/verify_atml.py "../data/NATE CATE 2/_csv_NATE1001_trial"           # independent XML re-parse vs. the CSV copies
node dev/test-nate.js "../data/NATE CATE 2/NATE1001_trial.mdb" "../data/NATE CATE 2/_csv_NATE1001_trial"   # Jet reader + parse-core vs. the CSV copies
node --max-old-space-size=6144 dev/test-model.js       # loads data/, compares chart counts with All_Coil_RunCharts/, then reads CATE_1001.mdb and EVO1002_Data_Results.mdb
node dev/make-sample.js ../data ../data/ref/CATE1001 ../data/ref/EVO1002   # regenerates dev/sample-data.js (CATE + EVO excerpts) for the headless-browser pages
node dev/headless.js --url "file:///.../dev/ui-test.html?coil=1.5T%20GEM%20PA&meas=MuxAuxPS" --until "ui ready" --out shot.png   # real-time headless Chrome (DevTools protocol), waits for workers; add &mdb=file:///.../CATE_1001.mdb --until "mdb ready" to drop a real database (then &mdbcoil=/&mdbmeas=/&mdbchart= to open a chart, &mdbcov=CATE1003 to click that machine in the Data coverage table; &nosample starts without the sample CSVs; &preset=all|last7|last30|ytd clicks a date-range preset; &thenmeas=Noise picks a measurement after the coil opened; &covchip=EVO1002/Noise clicks a data-type chip in Data coverage)
```

Files: `js/parse-core.js` (streaming CSV parser, measurement schemas, record sink and the `.mdb` driver; embedded into the worker), `js/jet-core.js` (read-only Access Jet4 page reader, also embedded into the worker), `js/loader.js` (file slots with one dataset per measurement, workers, progress), `tools/export_mdb.ps1` / `.bat` (Access-engine CSV export), `js/model.js` (columnar store, grouping, chart specs), `js/ticks.js` (tick locators), `js/chart.js` (canvas renderer, PNG export), `js/zip.js` (store-only zip writer), `js/app.js` (UI).

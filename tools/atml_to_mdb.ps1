<#
.SYNOPSIS
  Converts TestStand ATML XML reports (NATE / CATE 2.0 tester) into one Access .mdb laid out like the
  CATE / EVO result databases, so the dashboard and other tools can read it.

.DESCRIPTION
  How it works, in order:
  1. The C# parser below (AtmlParser) is compiled with Add-Type on first use. For one report it reads the
     TestResults, takes the coil identity from the SelectMode session action (part_description, part_number,
     File Mode, port), walks every TestGroup, decodes its "Test Configuration" JSON and maps each test group
     name to a result table (sensitivity -> Sensitivity, multicoil_bias -> MCBiasResults and
     MCBiasCurrentResults, noise_power_density -> NoiseResults, preamp_short_circuit -> SCPreResults,
     power_draw / mux_sink -> MuxAuxPSResults, coil_present -> CoilPresentResults, coil_id -> IdentifyCoil).
     Every run also yields a SourceFiles row; unreadable reports yield a SkippedFiles row.
  2. The target .mdb is created with ADOX (Jet 4 format, every column TEXT(255), AutoNumber key) when
     missing; rows are appended with DAO table-type recordsets inside 5000-row transactions.
  3. Reports already listed in SourceFiles / SkippedFiles are skipped, and a report whose run uuid was
     already imported from another file (TestStand's TempReport copies) is recorded as a duplicate.
  4. With -KeepCsv / -DryRun the same rows go to per-table CSVs and an all-tables bundle CSV.
  5. The database is compacted at the end unless -NoCompact. Progress goes to <Out>.import.log.
  tools/convert_nate.bat wraps the usual invocations; tools/verify_atml.py and dev/test-nate.js check the output.

.EXAMPLE
  # trial run: first 50 reports into a scratch database
  powershell -ExecutionPolicy Bypass -File tools\atml_to_mdb.ps1 -Source "..\data\NATE CATE 2\DataArchive\FAC\FAC" -Out "..\data\NATE CATE 2\NATE1001_trial.mdb" -Limit 50 -Rebuild

  # 200 random reports, keep CSV copies of what was written for inspection
  ... -Sample 200 -Rebuild -KeepCsv

  # everything (incremental: reports already listed in SourceFiles / SkippedFiles are skipped)
  ... -Out "..\data\NATE CATE 2\NATE1001.mdb"

.PARAMETER Source     Folder with the *.xml reports (searched recursively).
.PARAMETER Out        Target .mdb (created when missing; appended to otherwise).
.PARAMETER Limit      Only the first N eligible reports (sorted by name).
.PARAMETER Sample     N randomly chosen eligible reports.
.PARAMETER Match      Wildcard on the file name, e.g. '7771502_*'.
.PARAMETER Rebuild    Delete the target database first.
.PARAMETER DryRun     Parse and write CSV copies only; no database is touched.
.PARAMETER KeepCsv    Also write the tables as dashboard-ready CSVs next to the database (folder _csv_<name>):
                      one file per table (<name>_<Table>.csv) and one bundle <name>.csv holding every table
                      ("#table=<Table>" line before each table's header). Dropping the bundle on the dashboard
                      loads all tables, exactly like the .mdb.
.PARAMETER NoCompact  Skip the final compact step.
.PARAMETER CsvDir     Folder for the CSV copies (default: _csv_<name> next to the database).

.NOTES
  Needs only what Windows + Office ship with: .NET Framework (the parser is C# compiled at run time),
  the Access Database Engine (ACE OLEDB / DAO 12) for writing the .mdb.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Source,
  [string] $Out = (Join-Path (Get-Location) 'NATE1001.mdb'),
  [int] $Limit = 0,
  [int] $Sample = 0,
  [string] $Match = '*.xml',
  [switch] $Rebuild,
  [switch] $DryRun,
  [switch] $KeepCsv,
  [switch] $NoCompact,
  [string] $CsvDir = ''
)
$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture
$Source = (Resolve-Path $Source).Path
$Out = [IO.Path]::GetFullPath($Out)
if (-not $CsvDir) { $CsvDir = Join-Path ([IO.Path]::GetDirectoryName($Out)) ('_csv_' + [IO.Path]::GetFileNameWithoutExtension($Out)) }
$logPath = [IO.Path]::ChangeExtension($Out, '.import.log')
$writeCsv = $DryRun -or $KeepCsv
$writeDb = -not $DryRun

# ====================================================================== parser (C#, compiled on first use)
$parserSource = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Xml;
using System.Web.Script.Serialization;

// One output row: the target table name and its values in Columns[Table] order (null = field left empty).
public class AtmlRow { public string Table; public string[] Values; }

// Stateless parser: Parse(path, importedAt) turns one ATML report into AtmlRow objects for every table.
public static class AtmlParser
{
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    const string NS_TR = "urn:IEEE-1636.1:2011:01:TestResults", NS_C = "urn:IEEE-1671:2010:Common",
                 NS_TRC = "urn:IEEE-1636.1:2011:01:TestResultsCollection", NS_TS = "www.ni.com/TestStand/ATMLTestResults/2.0";

    // table layout: CATE / EVO column order, then Port and RunID
    static readonly string[] Common = { "CoilName", "CoilSN", "CoilPN", "Mode", "Operator", "TimeDate" };
    public static readonly string[] TableOrder = { "Sensitivity", "MCBiasResults", "MCBiasCurrentResults", "NoiseResults", "MuxAuxPSResults",
                                                   "SCPreResults", "CoilPresentResults", "IdentifyCoil", "SourceFiles", "SkippedFiles" };
    public static readonly Dictionary<string, string[]> Columns = new Dictionary<string, string[]>();
    public static readonly HashSet<string> MemoColumns = new HashSet<string>();   // every column is TEXT(255) like the CATE/EVO databases (the dashboard reader has no MEMO support)
    static readonly Dictionary<string, Dictionary<string, int>> Index = new Dictionary<string, Dictionary<string, int>>();

    // Cat(more...): the common identity columns followed by the table-specific ones.
    static string[] Cat(params string[] more) { var l = new List<string>(Common); l.AddRange(more); return l.ToArray(); }
    // Static initialiser: column layout per table (CATE / EVO order, then Port and RunID) and a name -> index map.
    static AtmlParser()
    {
        Columns["Sensitivity"] = Cat("TestCase", "Channel", "Element", "Measurement", "LSL", "USL", "PassFail", "Units", "Port", "RunID");
        Columns["MCBiasResults"] = Cat("TestCase", "Channel", "Element", "LSL", "Measurement", "USL", "PassFail", "Units", "Port", "RunID");
        Columns["MCBiasCurrentResults"] = Columns["MCBiasResults"];
        Columns["NoiseResults"] = Cat("TestCase", "Channel", "Element", "Baseline", "Measurement", "LSL", "Difference", "USL", "PassFail", "Units", "Port", "RunID");
        Columns["MuxAuxPSResults"] = Cat("NetName", "LSL", "Measurement", "USL", "PassFail", "Units", "Port", "RunID");
        Columns["SCPreResults"] = Columns["MuxAuxPSResults"];
        Columns["CoilPresentResults"] = Columns["MuxAuxPSResults"];
        Columns["IdentifyCoil"] = Cat("ROM_SN", "Page", "Expected", "PassFail", "Port", "RunID");
        Columns["SourceFiles"] = new[] { "RunID", "FileName", "FilePath", "FileSize", "Station", "SequenceFile", "StartDateTime", "EndDateTime", "Outcome", "Rows", "ImportedAt" };
        Columns["SkippedFiles"] = new[] { "FileName", "FilePath", "FileSize", "Reason", "ImportedAt" };
        foreach (var kv in Columns) { var d = new Dictionary<string, int>(); for (int i = 0; i < kv.Value.Length; i++) d[kv.Value[i]] = i; Index[kv.Key] = d; }
    }

    // ---------------------------------------------------------------- helpers
    // Converts an ATML ISO timestamp to the CATE TimeDate text form; returns the input unchanged when it does not parse.
    public static string CateDate(string iso)
    {   // 2024-07-09T13:59:45.542 -> 7/9/2024 1:59:45 PM (the CATE TimeDate text form)
        DateTime dt;
        if (DateTime.TryParse(iso, Inv, DateTimeStyles.None, out dt)) return dt.ToString("M/d/yyyy h:mm:ss tt", Inv);
        return iso ?? "";
    }
    // Maps a tr:Outcome element to PASS / FAIL; other outcomes (Aborted, Terminated ...) use the qualifier or value upper-cased.
    static string Outcome2PF(XmlElement el)
    {
        if (el == null) return "";
        string v = el.GetAttribute("value"), q = el.GetAttribute("qualifier");
        if (v == "Passed") return "PASS";
        if (v == "Failed") return "FAIL";
        return (q.Length > 0 ? q : v).ToUpperInvariant();
    }
    // Value of a c:Datum: the value attribute when present, else the nested c:Value text; null without a datum.
    static string DatumValue(XmlElement d, XmlNamespaceManager ns)
    {
        if (d == null) return null;
        if (d.HasAttribute("value")) return d.GetAttribute("value");
        var v = d.SelectSingleNode("c:Value", ns);
        return v == null ? null : v.InnerText.Trim();
    }
    // Lower / upper limit and expected value of a TestResult, as the text found in the report.
    class Lim { public string lo, hi, expected; }
    // Reads LimitPair / SingleLimit comparators (GE, GT -> lo; LE, LT -> hi) and the Expected datum of a TestResult.
    static Lim Limits(XmlElement tr, XmlNamespaceManager ns)
    {
        var l = new Lim();
        foreach (XmlElement lim in tr.SelectNodes("tr:TestLimits/tr:Limits/c:LimitPair/c:Limit | tr:TestLimits/tr:Limits/c:SingleLimit", ns))
        {
            string cmp = lim.GetAttribute("comparator"), val = DatumValue(lim.SelectSingleNode("c:Datum", ns) as XmlElement, ns);
            if (cmp == "GE" || cmp == "GT") l.lo = val; else if (cmp == "LE" || cmp == "LT") l.hi = val;
        }
        var exp = tr.SelectSingleNode("tr:TestLimits/tr:Limits/c:Expected/c:Datum", ns) as XmlElement;
        if (exp != null) l.expected = DatumValue(exp, ns);
        return l;
    }
    // Safe lookup of a key in a JSON object deserialised to Dictionary<string, object>; null when missing or not an object.
    static object Prop(object obj, string name)
    {
        var d = obj as Dictionary<string, object>;
        object v;
        return d != null && d.TryGetValue(name, out v) ? v : null;
    }
    // Invariant-culture string of a JSON value ("" for null).
    static string S(object o) { return o == null ? "" : Convert.ToString(o, Inv); }
    // Invariant parse of a number, null when the text is not numeric (e.g. "NA" or missing).
    static double? ToDouble(string s)
    {
        double d;
        if (s != null && double.TryParse(s, NumberStyles.Float, Inv, out d)) return d;
        return null;
    }
    // Two-decimal invariant text (the form the EVO Noise table uses).
    static string F2(double d) { return d.ToString("F2", Inv); }
    // Reads the "bias" (else "mux") section of the test configuration and joins its P1 / P2 channel lists.
    static string ChannelOf(object cfg)
    {   // the physical channel(s) biased (else muxed) for this test case; "" when none
        foreach (var k in new[] { "bias", "mux" })
        {
            var o = Prop(cfg, k);
            if (o == null) continue;
            var chans = new List<string>();
            foreach (var p in new[] { "P1", "P2" })
            {
                var lst = Prop(o, p) as System.Collections.IEnumerable;
                if (lst == null || lst is string) continue;
                foreach (var x in lst) chans.Add(S(x));
            }
            if (chans.Count > 0) return string.Join(",", chans.ToArray());
        }
        return "";
    }
    // NetName for power tests: the first entry of the configuration's power list, else the given fallback (TC<n>).
    static string NetOf(object cfg, string fallback)
    {
        var pw = Prop(cfg, "power") as System.Collections.IList;
        if (pw != null && pw.Count > 0)
        {
            var first = pw[0] as System.Collections.IList;
            if (first != null && first.Count > 0 && first[0] != null) return S(first[0]);
        }
        return fallback;
    }
    // Builds an AtmlRow from a name -> value map, placing values in the table's column order and truncating to 255 chars.
    static AtmlRow Row(string table, Dictionary<string, string> vals)
    {
        var cols = Columns[table]; var arr = new string[cols.Length];
        for (int i = 0; i < cols.Length; i++)
        {
            string v;
            if (!vals.TryGetValue(cols[i], out v) || v == null) continue;
            if (v.Length > 255 && !MemoColumns.Contains(cols[i])) v = v.Substring(0, 255);
            arr[i] = v;
        }
        return new AtmlRow { Table = table, Values = arr };
    }
    // Formats values as one CSV record with every field quoted and " doubled (the layout the dashboard expects).
    public static string CsvLine(string[] values)
    {
        var sb = new StringBuilder();
        for (int i = 0; i < values.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append('"').Append((values[i] ?? "").Replace("\"", "\"\"")).Append('"');
        }
        return sb.ToString();
    }
    // Convenience for the PowerShell side: a one-row list holding a SkippedFiles entry for the given file.
    public static List<AtmlRow> SkipRows(string path, string reason, string importedAt)
    {
        return new List<AtmlRow> { Skip(new FileInfo(path), reason, importedAt) };
    }
    // The SkippedFiles row for a file and a reason.
    static AtmlRow Skip(FileInfo f, string reason, string importedAt)
    {
        return Row("SkippedFiles", new Dictionary<string, string> { { "FileName", f.Name }, { "FilePath", f.FullName }, { "FileSize", f.Length.ToString(Inv) }, { "Reason", reason }, { "ImportedAt", importedAt } });
    }

    // ---------------------------------------------------------------- one report -> rows
    // Parses one report file and returns every row it yields (result tables, one SourceFiles row per
    // TestResults element, or a SkippedFiles row for empty / malformed files). Two passes per run: the
    // first collects the test groups with their configuration JSON and learns which physical channel each
    // element was biased on; the second emits the rows, giving unbiased test cases the channel of their
    // element. Coil identity falls back to the <PN>_<SN>_..._log.xml file name when the report lacks it.
    public static List<AtmlRow> Parse(string path, string importedAt)
    {
        var rows = new List<AtmlRow>();
        var f = new FileInfo(path);
        if (f.Length == 0) { rows.Add(Skip(f, "empty file", importedAt)); return rows; }
        var doc = new XmlDocument();
        try { doc.Load(path); }
        catch (Exception e) { rows.Add(Skip(f, "XML load failed: " + e.Message, importedAt)); return rows; }
        var ns = new XmlNamespaceManager(doc.NameTable);
        ns.AddNamespace("tr", NS_TR); ns.AddNamespace("c", NS_C); ns.AddNamespace("trc", NS_TRC); ns.AddNamespace("ts", NS_TS);
        var results = doc.SelectNodes("/trc:TestResultsCollection/trc:TestResults", ns);
        if (results.Count == 0) { rows.Add(Skip(f, "no TestResults element", importedAt)); return rows; }

        // file-name fallback: <PN>_<SN>_<DD>_<Mon>_<YYYY>_<HHMM>_log.xml
        string fnPN = "", fnSN = "";
        var m = System.Text.RegularExpressions.Regex.Match(f.Name, @"^(\d*)_([^_]+)_\d{2}_[A-Za-z]{3}_\d{4}_\d{4}_log\.xml$");
        if (m.Success) { fnPN = m.Groups[1].Value; fnSN = m.Groups[2].Value; }
        var json = new JavaScriptSerializer();

        foreach (XmlElement res in results)
        {
            string runId = res.GetAttribute("uuid");
            if (runId.Length == 0) runId = Guid.NewGuid().ToString();
            var rs = res.SelectSingleNode("tr:ResultSet", ns) as XmlElement;
            if (rs == null) { rows.Add(Skip(f, "no ResultSet", importedAt)); continue; }
            var opEl = res.SelectSingleNode("tr:Personnel/tr:SystemOperator", ns) as XmlElement;
            string operatorId = opEl == null ? "" : opEl.GetAttribute("name");
            var stEl = res.SelectSingleNode("tr:TestStation/c:SerialNumber", ns);
            string station = stEl == null ? "" : stEl.InnerText.Trim();
            var snEl = res.SelectSingleNode("tr:UUT/c:SerialNumber", ns);
            string uutSn = snEl == null ? "" : snEl.InnerText.Trim();
            string seqFile = Path.GetFileName(rs.GetAttribute("name").Split('#')[0]);
            var outEl = rs.SelectSingleNode("tr:Outcome", ns) as XmlElement;
            string outcome = outEl == null ? "" : outEl.GetAttribute("value");

            // UUT selection block -> coil identity
            string coilName = "", coilPN = fnPN, mode = "", port = "";
            var sel = rs.SelectSingleNode(".//tr:SessionAction[@name='SelectMode']//c:Value", ns);
            if (sel != null)
            {
                string txt = sel.InnerText;
                var mm = System.Text.RegularExpressions.Regex.Match(txt, "part_description:\\s*\"([^\"]*)\""); if (mm.Success) coilName = mm.Groups[1].Value;
                mm = System.Text.RegularExpressions.Regex.Match(txt, "part_number:\\s*\"([^\"]*)\""); if (mm.Success) coilPN = mm.Groups[1].Value;
                mm = System.Text.RegularExpressions.Regex.Match(txt, "File Mode:\\s*\"([^\"]*)\""); if (mm.Success) mode = mm.Groups[1].Value;
                mm = System.Text.RegularExpressions.Regex.Match(txt, "port:\\s*\"P?(\\d+)\""); if (mm.Success) port = mm.Groups[1].Value;
            }
            if (port.Length == 0)
            {
                var gp = rs.SelectSingleNode(".//tr:SessionAction[@name='GetPort']//c:Value", ns);
                if (gp != null) { var mm = System.Text.RegularExpressions.Regex.Match(gp.InnerText.Trim(), "P?(\\d+)"); if (mm.Success) port = mm.Groups[1].Value; }
            }
            string coilSN = uutSn.Length > 0 ? uutSn : fnSN;
            int rowsBefore = rows.Count;
            string romSn = "";

            // pass 1: test groups + their config JSON; element -> physical channel map from the biased test cases
            var groups = new List<object[]>();
            var elemChan = new Dictionary<string, string>();
            foreach (XmlElement g in rs.SelectNodes(".//tr:TestGroup", ns))
            {
                string gname = g.GetAttribute("name"); int hash = gname.LastIndexOf('#'); if (hash >= 0) gname = gname.Substring(hash + 1);
                object cfg = null;
                var cfgNode = g.SelectSingleNode("tr:SessionAction[@name='Test Configuration']//c:Value", ns);
                if (cfgNode != null) { try { cfg = json.DeserializeObject(cfgNode.InnerText); } catch { cfg = null; } }
                groups.Add(new object[] { g, gname, cfg });
                string e = S(Prop(cfg, "element")), c = ChannelOf(cfg);
                if (e.Length > 0 && c.Length > 0 && !elemChan.ContainsKey(e)) elemChan[e] = c;
            }
            // pass 2: rows
            foreach (var grp in groups)
            {
                var g = (XmlElement)grp[0]; string gname = (string)grp[1]; object cfg = grp[2];
                if (gname == "coil_id")
                {
                    var snNode = g.SelectSingleNode(".//c:Item[contains(@name,'Serial Number')]//c:Value", ns);   // ReadCoilID is an Action in passed runs, a Test in aborted ones
                    if (snNode != null) romSn = snNode.InnerText.Trim();
                }
                string tc = S(Prop(cfg, "test_case")), el = S(Prop(cfg, "element")), chRaw = ChannelOf(cfg), ch = chRaw;
                // unbiased test cases name no channel: use the channel the same element was biased on (else the element itself)
                if (ch.Length == 0 && el.Length > 0) { string c2; ch = elemChan.TryGetValue(el, out c2) ? c2 : el; }

                foreach (XmlElement t in g.SelectNodes("tr:Test", ns))
                {
                    string tname = t.GetAttribute("name");
                    var trs = new Dictionary<string, object[]>();      // name -> { value, unit, Lim }
                    foreach (XmlElement tr in t.SelectNodes("tr:TestResult", ns))
                    {
                        var d = tr.SelectSingleNode("tr:TestData/c:Datum", ns) as XmlElement;
                        trs[tr.GetAttribute("name")] = new object[] { DatumValue(d, ns), d == null ? "" : d.GetAttribute("nonStandardUnit"), Limits(tr, ns) };
                    }
                    if (trs.Count == 0) continue;
                    var row = new Dictionary<string, string> {
                        { "CoilName", coilName }, { "CoilSN", coilSN }, { "CoilPN", coilPN }, { "Mode", mode }, { "Operator", operatorId },
                        { "Port", port }, { "RunID", runId }, { "TimeDate", CateDate(t.GetAttribute("startDateTime")) },
                        { "PassFail", Outcome2PF(t.SelectSingleNode("tr:Outcome", ns) as XmlElement) } };
                    object[] r;
                    switch (gname)
                    {
                        case "sensitivity":
                            if (!trs.TryGetValue("Numeric", out r)) break;
                            row["TestCase"] = tc; row["Channel"] = ch; row["Element"] = el;
                            row["Measurement"] = (string)r[0]; row["LSL"] = ((Lim)r[2]).lo; row["USL"] = ((Lim)r[2]).hi; row["Units"] = ((string)r[1]).Length > 0 ? (string)r[1] : "dBm";
                            rows.Add(Row("Sensitivity", row));
                            break;
                        case "multicoil_bias":
                            if (trs.TryGetValue("Bias Voltage", out r))
                            {
                                var rv = new Dictionary<string, string>(row);
                                rv["TestCase"] = tc; rv["Channel"] = ch; rv["Element"] = el;
                                rv["Measurement"] = (string)r[0]; rv["LSL"] = ((Lim)r[2]).lo; rv["USL"] = ((Lim)r[2]).hi; rv["Units"] = ((string)r[1]).Length > 0 ? (string)r[1] : "V";
                                rows.Add(Row("MCBiasResults", rv));
                            }
                            if (trs.TryGetValue("Bias Current", out r))
                            {
                                var ri = new Dictionary<string, string>(row);
                                ri["TestCase"] = tc; ri["Channel"] = ch; ri["Element"] = el;
                                ri["Measurement"] = (string)r[0]; ri["LSL"] = ((Lim)r[2]).lo; ri["USL"] = ((Lim)r[2]).hi; ri["Units"] = ((string)r[1]).Length > 0 ? (string)r[1] : "A";
                                rows.Add(Row("MCBiasCurrentResults", ri));
                            }
                            break;
                        case "noise_power_density":
                        {
                            if (!trs.TryGetValue("Numeric", out r)) break;
                            double? meas = ToDouble((string)r[0]);
                            object[] rr; double? refv = null;
                            if (trs.TryGetValue("measuredRef", out rr)) refv = ToDouble((string)rr[0]);
                            row["TestCase"] = tc; row["Channel"] = ch; row["Element"] = el;
                            row["Measurement"] = (string)r[0]; row["Units"] = "dBm/Hz";
                            var lim = (Lim)r[2];
                            if (refv.HasValue)
                            {   // EVO convention: Difference and its limits are relative to the baseline (reference) reading
                                row["Baseline"] = F2(refv.Value);
                                row["Difference"] = meas.HasValue ? F2(meas.Value - refv.Value) : "";
                                double? lo = ToDouble(lim.lo), hi = ToDouble(lim.hi);
                                row["LSL"] = lo.HasValue ? F2(lo.Value - refv.Value) : "NA";
                                row["USL"] = hi.HasValue ? F2(hi.Value - refv.Value) : "NA";
                            }
                            else { row["Baseline"] = ""; row["Difference"] = ""; row["LSL"] = lim.lo; row["USL"] = lim.hi; }
                            rows.Add(Row("NoiseResults", row));
                            break;
                        }
                        case "preamp_short_circuit":
                            if (!trs.TryGetValue("Numeric", out r)) break;
                            row["NetName"] = NetOf(cfg, "TC" + tc); row["Measurement"] = (string)r[0]; row["LSL"] = ((Lim)r[2]).lo; row["USL"] = ((Lim)r[2]).hi; row["Units"] = ((string)r[1]).Length > 0 ? (string)r[1] : "V";
                            rows.Add(Row("SCPreResults", row));
                            break;
                        case "power_draw":
                            if (!trs.TryGetValue("Numeric", out r)) break;
                            row["NetName"] = NetOf(cfg, "TC" + tc); row["Measurement"] = (string)r[0]; row["LSL"] = ((Lim)r[2]).lo; row["USL"] = ((Lim)r[2]).hi; row["Units"] = ((string)r[1]).Length > 0 ? (string)r[1] : "A";
                            rows.Add(Row("MuxAuxPSResults", row));
                            break;
                        case "mux_sink":
                            if (!trs.TryGetValue("Numeric", out r)) break;
                            row["NetName"] = chRaw.Length > 0 ? "MUX_SINK_" + chRaw : "MUX_SINK"; row["Measurement"] = (string)r[0]; row["LSL"] = ((Lim)r[2]).lo; row["USL"] = ((Lim)r[2]).hi; row["Units"] = ((string)r[1]).Length > 0 ? (string)r[1] : "A";
                            rows.Add(Row("MuxAuxPSResults", row));
                            break;
                        case "coil_present":
                        {
                            if (!trs.TryGetValue("Numeric", out r)) break;
                            string task = S(Prop(cfg, "ai_task")); if (task.Length == 0) task = "TC" + tc;
                            row["NetName"] = task; row["Measurement"] = (string)r[0]; row["LSL"] = ((Lim)r[2]).lo; row["USL"] = ((Lim)r[2]).hi; row["Units"] = ((string)r[1]).Length > 0 ? (string)r[1] : "V";
                            rows.Add(Row("CoilPresentResults", row));
                            break;
                        }
                        case "coil_id":
                            if (tname != "FileContent" || !trs.TryGetValue("String", out r)) break;
                            row["ROM_SN"] = romSn; row["Page"] = (string)r[0]; row["Expected"] = ((Lim)r[2]).expected;
                            rows.Add(Row("IdentifyCoil", row));
                            break;
                    }
                }
            }
            rows.Add(Row("SourceFiles", new Dictionary<string, string> {
                { "RunID", runId }, { "FileName", f.Name }, { "FilePath", f.FullName }, { "FileSize", f.Length.ToString(Inv) }, { "Station", station }, { "SequenceFile", seqFile },
                { "StartDateTime", CateDate(rs.GetAttribute("startDateTime")) }, { "EndDateTime", CateDate(rs.GetAttribute("endDateTime")) }, { "Outcome", outcome },
                { "Rows", (rows.Count - rowsBefore).ToString(Inv) }, { "ImportedAt", importedAt } }));
        }
        return rows;
    }
}
'@
if (-not ('AtmlParser' -as [type])) { Add-Type -TypeDefinition $parserSource -ReferencedAssemblies System.Xml, System.Web.Extensions -Language CSharp }
$TABLE_ORDER = [AtmlParser]::TableOrder
$COLUMNS = [AtmlParser]::Columns
$MEMO = [AtmlParser]::MemoColumns

# ====================================================================== outputs: database (DAO) and/or CSV copies
# Log(msg): timestamped line to the console and to <Out>.import.log.
function Log($msg) { $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg; Write-Host $line; Add-Content -Path $logPath -Value $line -Encoding UTF8 }
if (Test-Path $logPath) { Remove-Item $logPath }
Log "source $Source"
Log "out    $Out"
if ($Rebuild -and $writeDb -and (Test-Path $Out)) { Remove-Item $Out; Log "removed existing $Out" }

# $already: file names already imported (skipped on incremental runs); $seenRuns: RunID -> first file that held it.
$already = @{}
$seenRuns = @{}          # RunID -> file already imported (TestStand's TempReport_*.xml copies repeat a run saved under its normal name)
$dbe = $null; $db = $null; $rsets = @{}; $fieldObjs = @{}
if ($writeDb) {
  if (-not (Test-Path $Out)) {
    $cat = New-Object -ComObject ADOX.Catalog
    $cat.Create("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$Out;Jet OLEDB:Engine Type=5") | Out-Null       # Jet 4 (Access 2000-2003) .mdb
    $cn = $cat.ActiveConnection
    foreach ($t in $TABLE_ORDER) {
      $defs = @('[AutoNumber] AUTOINCREMENT PRIMARY KEY')
      foreach ($c in $COLUMNS[$t]) { $defs += $(if ($MEMO.Contains($c)) { "[$c] MEMO" } else { "[$c] TEXT(255)" }) }
      $cn.Execute("CREATE TABLE [$t] (" + ($defs -join ', ') + ')') | Out-Null
    }
    $cn.Execute('CREATE INDEX idxSourceFile ON [SourceFiles] ([FileName])') | Out-Null
    $cn.Close()
    Log "created $Out"
  }
  $dbe = New-Object -ComObject DAO.DBEngine.120
  $db = $dbe.OpenDatabase($Out)
  foreach ($t in $TABLE_ORDER) {
    $rs = $db.OpenRecordset($t, 1)            # dbOpenTable: append cursor
    $rsets[$t] = $rs
    $fieldObjs[$t] = @(foreach ($c in $COLUMNS[$t]) { $rs.Fields.Item($c) })
  }
  if (-not $Rebuild) {
    foreach ($tbl in 'SourceFiles', 'SkippedFiles') {
      $q = $db.OpenRecordset("SELECT FileName FROM [$tbl]")
      while (-not $q.EOF) { $already[[string] $q.Fields.Item(0).Value] = $true; $q.MoveNext() }
      $q.Close()
    }
    $q = $db.OpenRecordset('SELECT RunID, FileName FROM [SourceFiles]')
    while (-not $q.EOF) { $seenRuns[[string] $q.Fields.Item(0).Value] = [string] $q.Fields.Item(1).Value; $q.MoveNext() }
    $q.Close()
    if ($already.Count) { Log "database already holds $($already.Count) files; they are skipped" }
  }
}
# CSV writers (one per table) when -KeepCsv / -DryRun; headers are written now, rows as they come.
$writers = @{}
if ($writeCsv) {
  if (Test-Path $CsvDir) { Remove-Item $CsvDir -Recurse -Force }
  New-Item -ItemType Directory -Path $CsvDir | Out-Null
  $utf8 = New-Object Text.UTF8Encoding($false)
  $csvPrefix = [IO.Path]::GetFileNameWithoutExtension($Out) + '_'
  foreach ($t in $TABLE_ORDER) {
    $w = New-Object IO.StreamWriter((Join-Path $CsvDir ($csvPrefix + "$t.csv")), $false, $utf8)
    $w.WriteLine([AtmlParser]::CsvLine($COLUMNS[$t]))
    $writers[$t] = $w
  }
}
$counts = @{}; foreach ($t in $TABLE_ORDER) { $counts[$t] = 0 }

# ====================================================================== which files
$all = @(Get-ChildItem -Path $Source -Recurse -File -Filter $Match | Sort-Object @{ Expression = { $_.Name -like 'TempReport*' } }, Name)
$files = @($all | Where-Object { -not $already.ContainsKey($_.Name) })
if ($Sample -gt 0 -and $files.Count -gt 0) { $files = @($files | Get-Random -Count ([Math]::Min($Sample, $files.Count)) | Sort-Object Name) }
if ($Limit -gt 0) { $files = @($files | Select-Object -First $Limit) }
Log "$($all.Count) report files found, $($files.Count) selected"

# ====================================================================== convert
$importedAt = (Get-Date).ToString('M/d/yyyy h:mm:ss tt', $inv)
$sw = [Diagnostics.Stopwatch]::StartNew()
$nDone = 0; $nSkipped = 0; $nRows = 0; $txRows = 0
if ($writeDb) { $dbe.BeginTrans() }
# Main loop: parse each report, drop duplicate runs, append rows to the recordsets and / or the CSV writers.
foreach ($f in $files) {
  $nDone++
  if ($nDone % 500 -eq 0 -or $nDone -eq $files.Count) {
    Write-Progress -Activity 'Converting reports' -Status "$nDone / $($files.Count)  rows $nRows" -PercentComplete ([int](100 * $nDone / [Math]::Max(1, $files.Count)))
    Log ("{0,6}/{1}  rows {2}  {3:F0}s" -f $nDone, $files.Count, $nRows, $sw.Elapsed.TotalSeconds)
  }
  $rows = [AtmlParser]::Parse($f.FullName, $importedAt)
  # a report whose RunID was already imported from another file is a duplicate copy: record it, keep nothing
  $dupOf = $null
  foreach ($r in $rows) { if ($r.Table -eq 'SourceFiles') { $rid = $r.Values[0]; if ($seenRuns.ContainsKey($rid)) { $dupOf = $seenRuns[$rid] } else { $seenRuns[$rid] = $f.Name } } }
  if ($dupOf) { $rows = [AtmlParser]::SkipRows($f.FullName, 'duplicate of ' + $dupOf + ' (same run uuid)', $importedAt) }
  foreach ($r in $rows) {
    $t = $r.Table; $v = $r.Values
    if ($t -eq 'SkippedFiles') { $nSkipped++ } elseif ($t -ne 'SourceFiles') { $nRows++ }
    $counts[$t]++
    if ($writeDb) {
      $rs = $rsets[$t]; $fo = $fieldObjs[$t]
      $rs.AddNew()
      for ($i = 0; $i -lt $v.Length; $i++) { if ($null -ne $v[$i]) { $fo[$i].Value = $v[$i] } }
      $rs.Update()
      if (++$txRows -ge 5000) { $dbe.CommitTrans(); $dbe.BeginTrans(); $txRows = 0 }
    }
    if ($writeCsv) { $writers[$t].WriteLine([AtmlParser]::CsvLine($v)) }
  }
}
Write-Progress -Activity 'Converting reports' -Completed
if ($writeDb) {
  $dbe.CommitTrans()
  foreach ($rs in $rsets.Values) { $rs.Close() }
  $db.Close()
}
foreach ($w in $writers.Values) { $w.Close() }
if ($writeCsv) {
  # one bundle CSV with every table: "#table=<Table>" marker, header, rows (the dashboard loads it like the .mdb)
  $bundlePath = Join-Path $CsvDir ([IO.Path]::GetFileNameWithoutExtension($Out) + '.csv')
  $bs = [IO.File]::Create($bundlePath)
  foreach ($t in $TABLE_ORDER) {
    if ($counts[$t] -eq 0) { continue }
    $mark = $utf8.GetBytes("#table=$t`n"); $bs.Write($mark, 0, $mark.Length)
    $src = [IO.File]::OpenRead((Join-Path $CsvDir ($csvPrefix + "$t.csv"))); $src.CopyTo($bs); $src.Close()
  }
  $bs.Close()
}
Log ("parsed {0} files ({1} skipped) -> {2} result rows in {3:F0}s" -f $nDone, $nSkipped, $nRows, $sw.Elapsed.TotalSeconds)
foreach ($t in $TABLE_ORDER) { Log ("  {0,-22} {1,8}" -f $t, $counts[$t]) }
if ($writeCsv) { Log "csv copies in $CsvDir (per table, plus the all-tables bundle $([IO.Path]::GetFileName($bundlePath)))" }
if (-not $writeDb) { exit 0 }

if (-not $NoCompact) {
  try {
    $tmp = [IO.Path]::ChangeExtension($Out, '.compact.tmp')
    if (Test-Path $tmp) { Remove-Item $tmp }
    $dbe.CompactDatabase($Out, $tmp)
    Move-Item $tmp $Out -Force
    Log 'compacted'
  } catch { Log "compact skipped: $($_.Exception.Message)" }
}
Log ("done: {0}  {1:N1} MB" -f $Out, ((Get-Item $Out).Length / 1MB))

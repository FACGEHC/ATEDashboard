/* model.js - columnar data store (per machine + measurement), coil/date-range filtering, grouping, chart specs.
 * Attached to globalThis.CATE so it runs in the browser and in Node tests.
 *
 * How it fits in: parse-core.js (in a worker, see loader.js) turns one CSV / .mdb result table into a
 * 'dataset' payload (typed columns + local string dictionaries); addDataset() merges it into CATE.model,
 * the single in-memory store that the UI (app.js), the renderer (chart.js) and the exports read from.
 * Nothing in this file touches the DOM.
 *
 * Store layout: Model.machines[m] (m = index into CATE.MACHINES) -> { datasets: { measurement: ds } }.
 * A dataset ds holds one result table of one machine as parallel typed arrays indexed by row:
 *   time (epoch ms), meas, lsl, usl (Float64, NaN = no limit), tc (test case number), coil, mode, chan,
 *   elem, net, sn, units, port (Int32 ids into the global string dictionaries in Model.dict, -1 = none),
 *   pf (Int8 PassFail: 1 pass, 0 fail, -1 not recorded), extras (optional per-measurement columns).
 * ds.rowsByCoil[coilId] lists the row indices of each coil type so a coil's charts never scan the whole table.
 * Serial numbers are kept twice: dict.sn holds the raw string, snClean[snId] the id of its cleaned form
 * (cleanSn: part before a dash, leading zeros stripped) used for counting distinct coils and grouping runs.
 *
 * What the file provides, in order:
 *   - constants: machine list / styles, default date ranges, the MEASUREMENTS catalogue (one result table each);
 *   - build() / buildCoil(): group the rows of a coil type and date range per chart key (Mode|TC|Ch|Elem or
 *     Mode|Net), collecting spec-limit revisions, units, ports and distinct coil counts per machine;
 *   - chartSpec(): turn one group into pure chart data (series, spec lines, y range, outlier flags, stats);
 *   - outlier / descriptive statistics helpers (robustScale, detectOutliers, describe);
 *   - runs() / yieldReport() / serialList(): test-run reconstruction and the first pass yield report;
 *   - summaryRows() / toCsv(): summary tables and CSV output for the exports.
 * Model.version increments on every add / remove so cached results (runs(), the UI's build cache) can be invalidated.
 */
(function (root) {
  'use strict';
  var CATE = root.CATE || (root.CATE = {});
  var T = CATE.ticks;   // ticks.js is loaded first (date formatting for spec revisions)
  var DAY = 86400000;

  CATE.MACHINES = ['CATE1001', 'CATE1007', 'CATE1003', 'CATE1006', 'EVO1001', 'EVO1002', 'NATE1001'];      // plot + legend order
  CATE.MACHINE_STYLE = {
    CATE1001: { color: '#1f77b4', shape: 'circle',       big: false },
    CATE1007: { color: '#9467bd', shape: 'diamond',      big: true },
    CATE1003: { color: '#ff7f0e', shape: 'triangle',     big: false },
    CATE1006: { color: '#808080', shape: 'square',       big: false },
    EVO1001:  { color: '#2ca02c', shape: 'triangleDown', big: false },
    EVO1002:  { color: '#17becf', shape: 'hexagon',      big: false },
    NATE1001: { color: '#d62728', shape: 'circle',       big: false }
  };
  CATE.DEFAULTS = {
    start: '2026-09-26', end: '2026-10-01',
    overrides: [{ coil: '1.5T GEM PA', start: '2026-01-01', end: 'today' }]
  };
  CATE.EXCLUDED_COIL_KEYWORDS = ['coil id'];

  /* Measurement types: one result table each. keyKind 'tc' charts per Mode/TestCase/Channel/Element,
   * 'net' per Mode/NetName. floor = MAD floor for outlier detection and minPad = minimum axis padding,
   * both in the measurement's units (the dB values would swamp volt / ampere data). */
  CATE.MEASUREMENT_ORDER = ['Sensitivity', 'MCBias', 'MuxAuxPS', 'Oscillation', 'SCPre', 'Noise', 'BTE', 'MEMSCurrent', 'MEMSSC', 'MCBiasCurrent', 'CoilPresent'];
  CATE.MEASUREMENTS = {
    Sensitivity: { key: 'Sensitivity', label: 'Sensitivity', table: 'Sensitivity',        keyKind: 'tc',  floor: 0.5,   minPad: 1,     decimals: 2, defaultUnits: 'dB' },
    MCBias:      { key: 'MCBias',      label: 'MCBias',      table: 'MCBiasResults',      keyKind: 'tc',  floor: 0.01,  minPad: 0.05,  decimals: 3, defaultUnits: 'V' },
    MuxAuxPS:    { key: 'MuxAuxPS',    label: 'MuxAuxPS',    table: 'MuxAuxPSResults',    keyKind: 'net', floor: 0.001, minPad: 0.005, decimals: 3, defaultUnits: 'A', keyLabel: 'Net', filePrefix: 'Net_' },
    Oscillation: { key: 'Oscillation', label: 'Oscillation', table: 'OscillationResults', keyKind: 'tc',  floor: 0.5,   minPad: 1,     decimals: 2, defaultUnits: 'dB', extras: { Frequency: { label: 'Frequency', units: 'Hz', decimals: 0 } } },
    SCPre:       { key: 'SCPre',       label: 'SCPre',       table: 'SCPreResults',       keyKind: 'net', floor: 0.01,  minPad: 0.05,  decimals: 3, defaultUnits: 'V', keyLabel: 'Net', filePrefix: 'Net_' },
    Noise:       { key: 'Noise',       label: 'Noise',       table: 'NoiseResults',       keyKind: 'tc',  floor: 0.5,   minPad: 1,     decimals: 2, defaultUnits: 'dB', valueLabel: 'Noise / Difference from baseline (dB)',
                   extras: { Measurement: { label: 'Measurement', units: 'dBm/Hz', decimals: 2 }, Baseline: { label: 'Baseline', units: 'dBm/Hz', decimals: 2 } } },
    BTE:         { key: 'BTE',         label: 'BTE',         table: 'BTEResults',         keyKind: 'net', floor: 0.01,  minPad: 0.05,  decimals: 3, defaultUnits: '',  keyLabel: 'Line', filePrefix: 'Line_', unverified: true },
    MEMSCurrent: { key: 'MEMSCurrent', label: 'MEMSCurrent', table: 'MEMSCurrentResults', keyKind: 'net', floor: 0.01,  minPad: 0.05,  decimals: 3, defaultUnits: '',  keyLabel: 'Line', filePrefix: 'Line_', unverified: true },
    MEMSSC:      { key: 'MEMSSC',      label: 'MEMSSC',      table: 'MEMSSCResults',      keyKind: 'net', floor: 0.01,  minPad: 0.05,  decimals: 3, defaultUnits: '',  keyLabel: 'Line', filePrefix: 'Line_', unverified: true },
    MCBiasCurrent: { key: 'MCBiasCurrent', label: 'MCBias Current', table: 'MCBiasCurrentResults', keyKind: 'tc', floor: 0.001, minPad: 0.005, decimals: 4, defaultUnits: 'A' },
    CoilPresent: { key: 'CoilPresent', label: 'Coil Present', table: 'CoilPresentResults', keyKind: 'net', floor: 0.01,  minPad: 0.05,  decimals: 3, defaultUnits: 'V', keyLabel: 'Test', filePrefix: 'Test_' }
  };
  /* Family of a machine name: 'CATE', 'EVO' or 'NATE' (used for the "- Single CATE" title suffix). */
  function machineFamily(name) { var m = /^(EVO|NATE)/i.exec(name || ''); return m ? m[1].toUpperCase() : 'CATE'; }
  /* Serial number used for distinct-coil counting: the part before a dash, leading zeros stripped
   * ("000835-302823625" and "00835" are the same coil).
   * An all-zero serial keeps its base ("000" stays "000"); an empty base (e.g. "-123") falls back to the raw string.
   */
  function cleanSn(sn) {
    var base = String(sn).replace(/-.*$/, '').trim();
    var cleaned = base.replace(/^0+/, '');
    return cleaned === '' ? (base === '' ? String(sn) : base) : cleaned;
  }

  /* Index into CATE.MACHINES of the machine named in a file name ("CATE_1001.mdb", "evo1002_Data_Results.mdb"):
   * family word, optional separator, four digits, any case. Returns -1 when no known machine is named. */
  function machineIndexFromName(name) {
    var m = /(CATE|EVO|NATE)[_ -]?(\d{4})/i.exec(name || '');
    if (!m) return -1;
    return CATE.MACHINES.indexOf(m[1].toUpperCase() + m[2]);
  }

  /* Python make_safe_name
   * Turns a coil / mode / channel name into a file-system safe folder or file name: characters illegal in
   * Windows names become '-', runs of whitespace become one '_', repeated '_' collapse, and leading / trailing
   * spaces, dots and underscores are trimmed. Must match the Python version so exported paths equal the old output.
   */
  function makeSafeName(value) {
    var text = String(value).trim();
    text = text.replace(/[<>:"/\\|?*]/g, '-');
    text = text.replace(/\s+/g, '_');
    text = text.replace(/_+/g, '_');
    return text.replace(/^[ ._]+|[ ._]+$/g, '');
  }

  /* Comparator for sort(): plain code-point string order, so names sort the same as in the Python script. */
  function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }     // code-point order like Python
  /* Two-digit zero padding (test case numbers: "TC05"). */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* String dictionary: interns strings as small integer ids so the columnar store can hold Int32 ids instead
   * of strings. list[id] gives the string back, map.get(string) the id. One Dict per string column (coil,
   * mode, chan, elem, net, sn, units, port) lives in Model.dict and is shared by every dataset. */
  function Dict() { this.list = []; this.map = new Map(); }
  /* Id of string s, adding it to the dictionary on first sight. */
  Dict.prototype.id = function (s) {
    var v = this.map.get(s);
    if (v === undefined) { v = this.list.length; this.list.push(s); this.map.set(s, v); }
    return v;
  };

  /* The in-memory store. dict: global string dictionaries; snClean / snCleanDict: raw serial id -> cleaned
   * serial id; machines[m]: null or { name, index, datasets: { measurement: ds } }; version: bumped on every
   * change so consumers can cache derived results (runs(), chart builds) keyed on it. CATE.model is the
   * single instance used by the dashboard. */
  function Model() {
    this.dict = { coil: new Dict(), mode: new Dict(), chan: new Dict(), elem: new Dict(), net: new Dict(), sn: new Dict(), units: new Dict(), port: new Dict() };
    this.snClean = [];          // sn id -> cleaned-sn id (distinct coil counting)
    this.snCleanDict = new Dict();
    this.machines = CATE.MACHINES.map(function () { return null; });   // m -> { name, index, datasets: { measurement: ds } }
    this.version = 0;
  }

  /* Merge a worker 'dataset' payload for machine m / measurement into the global store.
   * parsed = { columns: { time, meas, lsl, usl, tc, coil, mode, chan, elem, net, sn, units, port?, pf?, extras? },
   *            dicts: { coil, mode, ...: [strings] }, n, keyKind?, stats: { tMin, tMax, ... } }.
   * The worker interned strings in its own local dictionaries, so each string column is remapped in place
   * from local ids to the global ids of Model.dict (rows holding -1 stay -1); a serial seen for the first
   * time also gets its cleaned form registered in snClean. Missing port / pf columns are filled with -1
   * (older payloads). Builds ds.rowsByCoil, replaces any dataset already loaded for that machine +
   * measurement, bumps version and returns the new ds. The typed arrays are adopted, not copied.
   */
  Model.prototype.addDataset = function (m, measurement, parsed) {
    var self = this;
    var cols = parsed.columns;
    var n = parsed.n;
    if (!cols.port) { cols.port = new Int32Array(n); cols.port.fill(-1); }
    if (!cols.pf) { cols.pf = new Int8Array(n); cols.pf.fill(-1); }          // datasets parsed before the PassFail column existed
    ['coil', 'mode', 'chan', 'elem', 'net', 'sn', 'units', 'port'].forEach(function (d) {
      var local = parsed.dicts[d] || [];
      var map = new Int32Array(local.length);
      for (var i = 0; i < local.length; i++) {
        var gid = self.dict[d].id(local[i]);
        map[i] = gid;
        if (d === 'sn' && self.snClean[gid] === undefined) self.snClean[gid] = self.snCleanDict.id(cleanSn(local[i]));
      }
      var col = cols[d];
      for (var j = 0; j < n; j++) { if (col[j] >= 0) col[j] = map[col[j]]; }
    });
    var ds = {
      name: CATE.MACHINES[m], index: m, measurement: measurement,
      keyKind: parsed.keyKind || CATE.MEASUREMENTS[measurement].keyKind, n: n,
      time: cols.time, meas: cols.meas, lsl: cols.lsl, usl: cols.usl, tc: cols.tc,
      coil: cols.coil, mode: cols.mode, chan: cols.chan, elem: cols.elem, net: cols.net, sn: cols.sn, units: cols.units, port: cols.port,
      pf: cols.pf, extras: cols.extras || {},
      stats: parsed.stats, rowsByCoil: null
    };
    ds.rowsByCoil = buildRowsByCoil(ds, this.dict.coil.list.length);
    var mach = this.machines[m] || (this.machines[m] = { name: CATE.MACHINES[m], index: m, datasets: {} });
    mach.datasets[measurement] = ds;
    this.version++;
    return ds;
  };
  /* Backwards-compatible alias (Sensitivity CSV). */
  Model.prototype.addMachine = function (m, parsed) { return this.addDataset(m, parsed.measurement || 'Sensitivity', parsed); };

  /* Drop one measurement of a machine; the machine entry goes too when it has no datasets left. */
  Model.prototype.removeDataset = function (m, measurement) {
    var mach = this.machines[m];
    if (!mach) return;
    delete mach.datasets[measurement];
    if (!Object.keys(mach.datasets).length) this.machines[m] = null;
    this.version++;
  };
  /* Drop everything loaded for machine m (a new .mdb replaces the whole machine). */
  Model.prototype.removeMachine = function (m) { this.machines[m] = null; this.version++; };
  /* Machine entries with data, in CATE.MACHINES order (nulls skipped). */
  Model.prototype.loadedMachines = function () { return this.machines.filter(function (x) { return !!x; }); };
  /* Datasets of one measurement in machine order: [{ m, ds }]. */
  Model.prototype.datasetsFor = function (measurement) {
    var out = [];
    for (var m = 0; m < this.machines.length; m++) {
      var mach = this.machines[m];
      if (mach && mach.datasets[measurement]) out.push({ m: m, ds: mach.datasets[measurement] });
    }
    return out;
  };
  /* True when something is loaded for `measurement`, or for any measurement when none is given. */
  Model.prototype.hasData = function (measurement) {
    return measurement ? this.datasetsFor(measurement).length > 0 : this.loadedMachines().length > 0;
  };
  /* Measurement keys that have at least one dataset, in CATE.MEASUREMENT_ORDER. */
  Model.prototype.measurementsLoaded = function () {
    var self = this;
    return CATE.MEASUREMENT_ORDER.filter(function (k) { return self.datasetsFor(k).length > 0; });
  };
  /* Time extent of one machine's loaded data, or null when nothing is loaded for it. */
  Model.prototype.machineExtent = function (m) {
    var mach = this.machines[m], mn = Infinity, mx = -Infinity;
    if (!mach) return null;
    Object.keys(mach.datasets).forEach(function (k) {
      var st = mach.datasets[k].stats;
      if (st && !isNaN(st.tMin)) { mn = Math.min(mn, st.tMin); mx = Math.max(mx, st.tMax); }
    });
    return mn === Infinity ? null : { tMin: mn, tMax: mx };
  };
  /* Time extent of the loaded data (one measurement, or everything). */
  Model.prototype.extent = function (measurement) {
    var mn = Infinity, mx = -Infinity;
    this.loadedMachines().forEach(function (mach) {
      Object.keys(mach.datasets).forEach(function (k) {
        if (measurement && k !== measurement) return;
        var st = mach.datasets[k].stats;
        if (st && !isNaN(st.tMin)) { mn = Math.min(mn, st.tMin); mx = Math.max(mx, st.tMax); }
      });
    });
    return mn === Infinity ? null : { tMin: mn, tMax: mx };
  };

  /* Index a dataset's rows by coil id: out[coilId] is a Uint32Array of row indices (a subarray view into one
   * shared ordering, rows in original order). Counting sort in two passes over ds.coil: histogram -> prefix
   * sums give each coil's slice, then rows are scattered into their slice. nCoils is the size of the global
   * coil dictionary at the time, so coils added later by other datasets are simply absent (undefined). */
  function buildRowsByCoil(ds, nCoils) {
    var n = ds.n, coil = ds.coil;
    var counts = new Uint32Array(nCoils + 1);
    for (var i = 0; i < n; i++) counts[coil[i] + 1]++;
    for (var c = 0; c < nCoils; c++) counts[c + 1] += counts[c];
    var order = new Uint32Array(n);
    var fill = counts.slice(0, nCoils);
    for (var j = 0; j < n; j++) order[fill[coil[j]]++] = j;
    var out = new Array(nCoils);
    for (var k = 0; k < nCoils; k++) out[k] = order.subarray(counts[k], counts[k + 1]);
    return out;
  }

  /* Coil names (sorted) minus excluded keywords; limited to coils with rows in `measurement` when given. */
  Model.prototype.coilList = function (measurement) {
    var list = this.dict.coil.list, out = [];
    var present = null;
    if (measurement) {
      present = new Uint8Array(list.length);
      this.datasetsFor(measurement).forEach(function (e) {
        var rbc = e.ds.rowsByCoil;
        for (var c = 0; c < rbc.length; c++) if (rbc[c] && rbc[c].length) present[c] = 1;
      });
    }
    for (var i = 0; i < list.length; i++) {
      if (present && !present[i]) continue;
      var lower = list[i].toLowerCase(), skip = false;
      for (var k = 0; k < CATE.EXCLUDED_COIL_KEYWORDS.length; k++) if (lower.indexOf(CATE.EXCLUDED_COIL_KEYWORDS[k]) >= 0) skip = true;
      if (!skip) out.push({ id: i, name: list[i] });
    }
    out.sort(function (a, b) { return cmpStr(a.name, b.name); });
    return out;
  };

  /* Resolve settings into per-coil ranges.
   * settings = { start: ms, end: ms (inclusive day), overrides: [{coil, start: ms, end: ms}] }
   * Returns { start, endIncl, endExcl, override }: the coil's own override when its name matches one exactly,
   * otherwise the global range. endExcl = inclusive end day + 1 day, so rows are kept with start <= t < endExcl.
   */
  function rangeForCoil(settings, coilName) {
    var ov = settings.overrides || [];
    for (var i = 0; i < ov.length; i++) {
      if (ov[i].coil === coilName) return { start: ov[i].start, endIncl: ov[i].end, endExcl: ov[i].end + DAY, override: true };
    }
    return { start: settings.start, endIncl: settings.end, endExcl: settings.end + DAY, override: false };
  }

  /* Array with one slot per machine (CATE.MACHINES order) filled with v, or with v() when v is a factory. */
  function emptyPerMachine(v) { return CATE.MACHINES.map(function () { return typeof v === 'function' ? v() : v; }); }

  /* Spec limits can change over time (a spec revision): remember the first and last row date of each
   * distinct value so the chart can draw every limit only over the period it applied. */
  function noteSpec(seen, value, t) {
    var sp = seen.get(value);
    if (!sp) seen.set(value, { value: value, tFirst: t, tLast: t });
    else { if (t < sp.tFirst) sp.tFirst = t; if (t > sp.tLast) sp.tLast = t; }
  }
  /* Spec revisions of one side as a list sorted by first use (ties by value): [{ value, tFirst, tLast }]. */
  function specSpans(seen) {
    return Array.from(seen.values()).sort(function (a, b) { return a.tFirst - b.tFirst || a.value - b.value; });
  }
  /* Chart lines for one side (LSL or USL). With a single value the line spans the whole chart; with a
   * revision history each value runs from its first row to its last row (or to the next value's first
   * row when the change was clean), the first one from the left edge and the latest one to the right edge.
   * A vertical riser marks the first use of each new value; when machines switched on different dates the
   * old line keeps running past the riser until its last use. */
  function specLines(spans, side, dec) {
    var n = spans.length;
    return spans.map(function (sp, i) {
      var prev = i > 0 ? spans[i - 1] : null, next = i < n - 1 ? spans[i + 1] : null;
      var x0 = prev ? sp.tFirst : null;                                      // null = chart edge
      var x1 = next ? Math.max(sp.tLast, next.tFirst) : null;
      var clean = !!prev && prev.tLast <= sp.tFirst;                           // old value no longer used once the new one appears
      var when = '';
      if (n > 1) {
        if (!prev) when = ' to ' + T.formatDate(sp.tLast);
        else if (!next) when = ' from ' + T.formatDate(sp.tFirst);
        else when = ' ' + T.formatDate(sp.tFirst) + ' – ' + T.formatDate(sp.tLast);
      }
      return { value: sp.value, label: (n > 1 ? side + ' ' + (i + 1) : side) + ' = ' + sp.value.toFixed(dec) + when,
               x0: x0, x1: x1, riserFrom: prev ? prev.value : null, clean: clean, tFirst: sp.tFirst, tLast: sp.tLast };
    });
  }

  /* Build groups for one coil and measurement. Returns coilResult.
   * coilEntry = { id, name } from coilList(); settings as rangeForCoil(). Walks the coil's rows in every
   * loaded dataset of the measurement, keeps those inside the coil's date range and buckets them by chart
   * key: Mode|TC|Ch|Elem for 'tc' measurements, Mode|Net for 'net' ones. Per group it records, per machine,
   * the row indices (sorted by time), point count and number of distinct cleaned serials, plus the LSL / USL
   * revision history (noteSpec), the units seen (majority wins, unitsMixed when more than one), the ports
   * used, and the derived names mode, modeDir, fileName and caption (matching the Python output paths).
   * Groups are sorted by mode, then test case / channel / element or net name.
   * Returns { coilId, name, safeName, start, endIncl, endExcl, override, rowCount, groups, modes, measurement }.
   */
  Model.prototype.buildCoil = function (coilEntry, settings, measurement) {
    measurement = measurement || 'Sensitivity';
    var MEAS = CATE.MEASUREMENTS[measurement], kind = MEAS.keyKind;
    var range = rangeForCoil(settings, coilEntry.name);
    var start = range.start, endExcl = range.endExcl;
    var groups = new Map();
    var rowCount = 0;
    var dict = this.dict, self = this;
    var NM = CATE.MACHINES.length;
    this.datasetsFor(measurement).forEach(function (entry) {
      var m = entry.m, ds = entry.ds;
      var rows = ds.rowsByCoil[coilEntry.id];
      if (!rows) return;
      var time = ds.time, mode = ds.mode, tc = ds.tc, chan = ds.chan, elem = ds.elem, net = ds.net, units = ds.units, port = ds.port;
      var lsl = ds.lsl, usl = ds.usl, sn = ds.sn;
      for (var r = 0; r < rows.length; r++) {
        var idx = rows[r];
        var t = time[idx];
        if (t < start || t >= endExcl) continue;
        rowCount++;
        var key = kind === 'tc' ? mode[idx] + '|' + tc[idx] + '|' + chan[idx] + '|' + elem[idx] : mode[idx] + '|' + net[idx];
        var g = groups.get(key);
        if (!g) {
          g = { modeId: mode[idx], tc: kind === 'tc' ? tc[idx] : -1, chanId: chan[idx], elemId: elem[idx], netId: net[idx], key: key,
                tmp: emptyPerMachine(function () { return []; }), lslSeen: new Map(), uslSeen: new Map(), unitsCount: new Map(), portSet: new Set(),
                snSets: emptyPerMachine(null) };
          groups.set(key, g);
        }
        g.tmp[m].push(idx);
        if (port[idx] >= 0) g.portSet.add(port[idx]);
        var lv = lsl[idx]; if (lv === lv) noteSpec(g.lslSeen, lv, t);
        var uv = usl[idx]; if (uv === uv) noteSpec(g.uslSeen, uv, t);
        var u = units[idx]; g.unitsCount.set(u, (g.unitsCount.get(u) || 0) + 1);
        var s = sn[idx];
        if (s >= 0) { if (!g.snSets[m]) g.snSets[m] = new Set(); g.snSets[m].add(self.snClean[s]); }
      }
    });
    var list = [];
    groups.forEach(function (g) {
      g.rows = emptyPerMachine(null); g.nPts = emptyPerMachine(0); g.nCoils = emptyPerMachine(0); g.machinesPresent = 0;
      for (var m = 0; m < NM; m++) {
        var arr = g.tmp[m];
        if (arr.length) {
          var time = self.machines[m].datasets[measurement].time;
          arr.sort(function (a, b) { return time[a] - time[b]; });
          g.rows[m] = Uint32Array.from(arr);
          g.nPts[m] = arr.length;
          g.nCoils[m] = g.snSets[m] ? g.snSets[m].size : 0;
          g.machinesPresent++;
        }
      }
      g.lslSpans = specSpans(g.lslSeen); g.uslSpans = specSpans(g.uslSeen);     // in order of first use
      g.lsl = g.lslSpans.map(function (sp) { return sp.value; }).sort(function (a, b) { return a - b; });
      g.usl = g.uslSpans.map(function (sp) { return sp.value; }).sort(function (a, b) { return a - b; });
      g.missingSpec = g.lsl.length === 0 && g.usl.length === 0;
      var bestU = -1, bestN = -1;
      g.unitsCount.forEach(function (cnt, u) { if (cnt > bestN) { bestN = cnt; bestU = u; } });
      g.units = bestU >= 0 ? dict.units.list[bestU] : MEAS.defaultUnits;
      g.unitsMixed = g.unitsCount.size > 1;
      g.ports = Array.from(g.portSet).map(function (p) { return dict.port.list[p]; }).sort(cmpStr);
      g.measurement = measurement; g.keyKind = kind;
      g.mode = dict.mode.list[g.modeId];
      g.modeDir = 'Mode_' + makeSafeName(g.mode);
      if (kind === 'tc') {
        g.chan = dict.chan.list[g.chanId]; g.elem = dict.elem.list[g.elemId]; g.net = '';
        g.fileName = 'TC' + pad2(g.tc) + '_Ch' + makeSafeName(g.chan) + '_E' + makeSafeName(g.elem) + '.png';
        g.caption = 'Mode ' + g.mode + ' · TC' + pad2(g.tc) + ' Ch' + g.chan + ' E' + g.elem;
      } else {
        g.net = dict.net.list[g.netId]; g.chan = ''; g.elem = '';
        g.fileName = (MEAS.filePrefix || 'Net_') + makeSafeName(g.net) + '.png';
        g.caption = 'Mode ' + g.mode + ' · ' + (MEAS.keyLabel || 'Net') + ' ' + g.net;
      }
      delete g.tmp; delete g.lslSeen; delete g.uslSeen; delete g.snSets; delete g.unitsCount; delete g.portSet;
      list.push(g);
    });
    list.sort(function (a, b) {
      if (kind === 'tc') return cmpStr(a.mode, b.mode) || (a.tc - b.tc) || cmpStr(a.chan, b.chan) || cmpStr(a.elem, b.elem);
      return cmpStr(a.mode, b.mode) || cmpStr(a.net, b.net);
    });
    var modes = [];
    list.forEach(function (g) { if (modes.indexOf(g.mode) < 0) modes.push(g.mode); });
    return {
      coilId: coilEntry.id, name: coilEntry.name, safeName: makeSafeName(coilEntry.name),
      start: start, endIncl: range.endIncl, endExcl: endExcl, override: range.override,
      rowCount: rowCount, groups: list, modes: modes, measurement: measurement
    };
  };

  /* Build every coil for a measurement.
   * Runs buildCoil() for every coil in coilList(measurement) and returns
   * { coils: [coilResult], totalCharts, version, measurement }. version is the model version the result was
   * built from; app.js compares it to decide whether a cached build is still valid.
   */
  Model.prototype.build = function (settings, measurement) {
    measurement = measurement || 'Sensitivity';
    var coils = this.coilList(measurement);
    var results = [], totalCharts = 0;
    for (var i = 0; i < coils.length; i++) {
      var res = this.buildCoil(coils[i], settings, measurement);
      totalCharts += res.groups.length;
      results.push(res);
    }
    return { coils: results, totalCharts: totalCharts, version: this.version, measurement: measurement };
  };

  /* ---------- outlier detection + descriptive statistics (pure) ---------- */
  CATE.OUTLIER_DEFAULTS = { mode: 'flag', k: 3.5, minN: 5, floor: 0.5 };   // floor in dB (Sensitivity); other measurements use MEASUREMENTS[].floor

  /* Median of an already sorted numeric array (NaN when empty). */
  function median(sorted) {
    var n = sorted.length;
    if (!n) return NaN;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }
  /* Ascending plain-array copy of any array-like of numbers. */
  function sortedCopy(ys) { var a = Array.from(ys); a.sort(function (x, y) { return x - y; }); return a; }

  /* Robust centre/scale: median and MAD; scale = max(1.4826*MAD, floor). */
  function robustScale(ys, floor) {
    if (floor === undefined) floor = CATE.OUTLIER_DEFAULTS.floor;
    var s = sortedCopy(ys), n = s.length;
    var med = median(s);
    var dev = new Array(n);
    for (var i = 0; i < n; i++) dev[i] = Math.abs(s[i] - med);
    dev.sort(function (x, y) { return x - y; });
    var mad = median(dev);
    return { n: n, median: med, mad: mad, scale: Math.max(1.4826 * mad, floor) };
  }

  /* flags[i]: 0 normal, 1 high outlier, 2 low outlier. No flags when n < minN.
   * Modified z-score rule: a value is an outlier when |y - median| > k * scale, scale from robustScale() (the
   * MAD floor keeps near-constant data from flagging tiny deviations). opts: { minN, floor }.
   * Returns { flags, median, mad, scale, k, n, nHigh, nLow, count }; centre and scale are still reported when
   * n < minN or k <= 0 (so the footnote can show them) but no point is flagged.
   */
  function detectOutliers(ys, k, opts) {
    opts = opts || {};
    var minN = opts.minN !== undefined ? opts.minN : CATE.OUTLIER_DEFAULTS.minN;
    var n = ys.length;
    var flags = new Uint8Array(n);
    var out = { flags: flags, median: NaN, mad: NaN, scale: NaN, k: k, n: n, nHigh: 0, nLow: 0, count: 0 };
    if (n < minN || !(k > 0)) { if (n) { var r0 = robustScale(ys, opts.floor); out.median = r0.median; out.mad = r0.mad; out.scale = r0.scale; } return out; }
    var r = robustScale(ys, opts.floor);
    out.median = r.median; out.mad = r.mad; out.scale = r.scale;
    var lim = k * r.scale;
    for (var i = 0; i < n; i++) {
      var d = ys[i] - r.median;
      if (d > lim) { flags[i] = 1; out.nHigh++; }
      else if (d < -lim) { flags[i] = 2; out.nLow++; }
    }
    out.count = out.nHigh + out.nLow;
    return out;
  }

  /* Descriptive stats + capability. lsl/usl (may be NaN) feed Cpk; rowL/rowU, when given, hold each
   * value's own limits (NaN = none) so pass/fail follows the spec in force on that test date.
   * std is the sample std dev (n-1). */
  function describe(values, lsl, usl, rowL, rowU) {
    var n = values.length;
    var r = { n: n, mean: NaN, median: NaN, std: NaN, min: NaN, max: NaN, range: NaN, pass: 0, fail: 0, inSpecPct: NaN, cpk: NaN, cpu: NaN, cpl: NaN };
    if (!n) return r;
    var sum = 0, mn = Infinity, mx = -Infinity;
    for (var i = 0; i < n; i++) { var v = values[i]; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; }
    r.mean = sum / n; r.min = mn; r.max = mx; r.range = mx - mn;
    r.median = median(sortedCopy(values));
    if (n > 1) { var ss = 0; for (var j = 0; j < n; j++) { var d = values[j] - r.mean; ss += d * d; } r.std = Math.sqrt(ss / (n - 1)); }
    var hasL = lsl === lsl, hasU = usl === usl;
    if (hasL || hasU) {
      for (var q = 0; q < n; q++) {
        var y = values[q], lq = rowL ? rowL[q] : lsl, uq = rowU ? rowU[q] : usl;
        if ((lq === lq && y < lq) || (uq === uq && y > uq)) r.fail++; else r.pass++;
      }
      r.inSpecPct = r.pass / n * 100;
      if (r.std > 0) {
        if (hasU) r.cpu = (usl - r.mean) / (3 * r.std);
        if (hasL) r.cpl = (r.mean - lsl) / (3 * r.std);
        r.cpk = hasU && hasL ? Math.min(r.cpu, r.cpl) : (hasU ? r.cpu : r.cpl);
      }
    }
    return r;
  }
  CATE.robustScale = robustScale;
  CATE.detectOutliers = detectOutliers;
  CATE.describe = describe;
  CATE.rowVerdict = rowVerdict;

  /* Fixed-decimal formatting with a typographic minus sign (U+2212) for negatives, as the chart labels use. */
  function fmtD(v, d) { return (v < 0 ? '−' : '') + Math.abs(v).toFixed(d); }

  /* Chart spec for the renderer (pure data).
   * onlyMachine (optional, 0..MACHINES.length-1): draw just that machine's series.
   * opts: { outlierMode: 'flag'|'exclude'|'off', k, stats, statsOutliers: 'include'|'exclude', port: 'N' (only that port's rows),
   *         runs: 'all'|'latest'|'first' (every row, or only each coil's latest / first test of this measurement) }
   *   (default: off, no stats; statsOutliers defaults to 'include' and only matters in flag mode,
   *    since exclude mode removes the points and off mode never flags any)
   * How it works, in order:
   *   1. rowsFor[m]: the group's rows per machine after the onlyMachine and port filters;
   *   2. runs 'latest' / 'first': find each cleaned serial's latest (first) timestamp across the drawn
   *      machines and keep only rows at that time (rows without a serial are kept); runsCoils = serials seen;
   *   3. one series per machine with xs / ys / rows typed arrays and the machine's colour and marker;
   *   4. outlier detection pooled over every drawn point (MAD floor from MEASUREMENTS[].floor), flags written
   *      back into each series (1 high, 2 low);
   *   5. y range from the unflagged points plus every spec value, padded by max(10% of range, minPad);
   *   6. pin rule: a flagged point within 0.5 x the core range of the axis stays on scale (flag 3) and the
   *      axis is re-padded around it; the rest are counted in outliers.nPinned and drawn off-scale by chart.js;
   *   7. exclude mode drops the flagged points from the series entirely;
   *   8. series labels "MACHINE (n coils, n pts)" recomputed over the included rows;
   *   9. optional stats (describe() per machine + 'All machines'): capability uses the latest spec revision,
   *      pass / fail the limit of each row's own date; footnotes describe the outlier, runs and spec settings.
   * Returns the spec consumed by chart.js: { title1, title2, series, lsl, usl (specLines), xMin, xMax, yMin,
   * yMax, missingSpec, fileName, relPath, machine, measurement, units, decimals, yLabel, port, runs, runsCoils,
   * outlierMode, outliers, stats, statsOutliers, excludedNote }. Pure: neither g nor the model is mutated.
   */
  Model.prototype.chartSpec = function (coilResult, g, onlyMachine, opts) {
    opts = opts || {};
    var mode = opts.outlierMode || 'off';
    var k = opts.k > 0 ? +opts.k : CATE.OUTLIER_DEFAULTS.k;
    var statsOut = opts.statsOutliers === 'exclude' ? 'exclude' : 'include';
    var measurement = g.measurement || coilResult.measurement || 'Sensitivity';
    var MEAS = CATE.MEASUREMENTS[measurement];
    var dec = MEAS.decimals, units = g.units || MEAS.defaultUnits;
    var fmt2 = function (v) { return fmtD(v, dec); };
    var self = this, NM = CATE.MACHINES.length;
    var series = [];
    var filtered = typeof onlyMachine === 'number' && onlyMachine >= 0;
    function dsOf(m) { var mach = self.machines[m]; return mach ? mach.datasets[measurement] : null; }
    var portId = opts.port ? self.dict.port.map.get(String(opts.port)) : undefined;
    var runsMode = opts.runs === 'latest' || opts.runs === 'first' ? opts.runs : 'all';
    var rowsFor = emptyPerMachine(null);                   // rows to draw per machine, after the machine and port filters
    for (var m = 0; m < CATE.MACHINES.length; m++) {
      var rows = g.rows[m];
      if (!rows) continue;
      if (filtered && m !== onlyMachine) continue;
      var ds = dsOf(m);
      if (!ds) continue;
      if (opts.port) {                                     // keep only the rows measured on that port
        if (portId === undefined) continue;
        var kept = [];
        for (var q = 0; q < rows.length; q++) if (ds.port[rows[q]] === portId) kept.push(rows[q]);
        if (!kept.length) continue;
        rows = Uint32Array.from(kept);
      }
      rowsFor[m] = rows;
    }
    // Latest / first run per coil: of every serial number keep only the row(s) at its latest (first) test
    // date across the machines drawn, so a coil retested after a failure shows one point. Within one
    // chart each test is measured once per run, so that row is the coil's latest (first) run of this test.
    // Rows without a serial number are kept.
    var runsCoils = 0;
    if (runsMode !== 'all') {
      var best = new Map();
      for (var mb = 0; mb < NM; mb++) {
        var rb = rowsFor[mb]; if (!rb) continue;
        var dsb = dsOf(mb);
        for (var ib = 0; ib < rb.length; ib++) {
          var sb = dsb.sn[rb[ib]]; if (sb < 0) continue;
          var scb = self.snClean[sb], tb = dsb.time[rb[ib]], curB = best.get(scb);
          if (curB === undefined || (runsMode === 'latest' ? tb > curB : tb < curB)) best.set(scb, tb);
        }
      }
      runsCoils = best.size;
      for (var mk = 0; mk < NM; mk++) {
        var rk = rowsFor[mk]; if (!rk) continue;
        var dsk = dsOf(mk), keep = [];
        for (var ik = 0; ik < rk.length; ik++) { var sk = dsk.sn[rk[ik]]; if (sk < 0 || dsk.time[rk[ik]] === best.get(self.snClean[sk])) keep.push(rk[ik]); }
        rowsFor[mk] = keep.length ? Uint32Array.from(keep) : null;
      }
    }
    for (var ms = 0; ms < NM; ms++) {
      var rs = rowsFor[ms];
      if (!rs) continue;
      var dss = dsOf(ms);
      var xs = new Float64Array(rs.length), ys = new Float64Array(rs.length), snSet = new Set();
      for (var i = 0; i < rs.length; i++) { xs[i] = dss.time[rs[i]]; ys[i] = dss.meas[rs[i]]; var sni = dss.sn[rs[i]]; if (sni >= 0) snSet.add(self.snClean[sni]); }
      var name = CATE.MACHINES[ms], st = CATE.MACHINE_STYLE[name];
      series.push({ machine: name, m: ms, nCoils: runsMode === 'all' ? g.nCoils[ms] : snSet.size, label: '',
                    color: st.color, shape: st.shape, big: st.big, xs: xs, ys: ys, rows: rs, flags: null, nOut: 0 });
    }

    // --- outlier detection over all drawn points
    var outliers = null;
    if (mode !== 'off' && series.length) {
      var pooled = [], owner = [];
      series.forEach(function (s, si) { for (var i = 0; i < s.ys.length; i++) { pooled.push(s.ys[i]); owner.push(si, i); } });
      var det = detectOutliers(pooled, k, { minN: CATE.OUTLIER_DEFAULTS.minN, floor: MEAS.floor });
      outliers = { k: k, median: det.median, mad: det.mad, scale: det.scale, n: det.n, nHigh: det.nHigh, nLow: det.nLow, count: det.count, nPinned: 0, items: [] };
      if (det.count) {
        series.forEach(function (s) { s.flags = new Uint8Array(s.ys.length); });
        for (var p = 0; p < pooled.length; p++) {
          if (det.flags[p]) { var s2 = series[owner[2 * p]], i2 = owner[2 * p + 1]; s2.flags[i2] = det.flags[p]; s2.nOut++; }
        }
      }
    }

    // --- y range from non-flagged points + spec values (Python rule: pad = max(10% range, minPad))
    var yMin = Infinity, yMax = -Infinity;
    series.forEach(function (s) {
      for (var i = 0; i < s.ys.length; i++) { if (s.flags && s.flags[i]) continue; var v = s.ys[i]; if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
    });
    g.lsl.concat(g.usl).forEach(function (v) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; });
    if (yMin === Infinity) { // every point flagged (cannot happen with MAD rule, but be safe)
      series.forEach(function (s) { for (var i = 0; i < s.ys.length; i++) { if (s.ys[i] < yMin) yMin = s.ys[i]; if (s.ys[i] > yMax) yMax = s.ys[i]; } });
    }
    var pad = Math.max((yMax - yMin) * 0.10, MEAS.minPad);
    yMin -= pad; yMax += pad;

    // --- pin rule: a flagged point stays in place (flag 3) if it stretches the axis by at most
    //     STRETCH x the core range on its side; the axis is then re-padded around the kept points.
    if (outliers && outliers.count) {
      var STRETCH = 0.5, coreRange = yMax - yMin;
      var loLimit = yMin - STRETCH * coreRange, hiLimit = yMax + STRETCH * coreRange;
      var kMin = Infinity, kMax = -Infinity;
      series.forEach(function (s, si) {
        for (var i = 0; i < s.ys.length; i++) {
          var f = s.flags[i];
          if (!f) continue;
          var y = s.ys[i];
          if (y >= loLimit && y <= hiLimit) { s.flags[i] = 3; if (y < kMin) kMin = y; if (y > kMax) kMax = y; }
          else { outliers.nPinned++; }
          outliers.items.push({ s: si, i: i, y: y, m: s.m, row: s.rows[i], flag: s.flags[i] });
        }
      });
      if (kMin < yMin + pad || kMax > yMax - pad) {   // re-pad around normal points + kept flagged points
        var nMin = Math.min(yMin + pad, kMin), nMax = Math.max(yMax - pad, kMax);
        var pad2 = Math.max((nMax - nMin) * 0.10, MEAS.minPad);
        yMin = nMin - pad2; yMax = nMax + pad2;
      }
      outliers.nHigh = 0; outliers.nLow = 0;
      series.forEach(function (s) { for (var i = 0; i < s.flags.length; i++) { if (s.flags[i] === 1) outliers.nHigh++; else if (s.flags[i] === 2) outliers.nLow++; } });
    }

    // --- exclude mode: drop flagged points from the series
    if (mode === 'exclude' && outliers && outliers.count) {
      series.forEach(function (s) {
        if (!s.nOut) return;
        var keep = s.ys.length - s.nOut;
        var xs2 = new Float64Array(keep), ys2 = new Float64Array(keep), rows2 = new Uint32Array(keep), j = 0;
        for (var i = 0; i < s.ys.length; i++) { if (s.flags[i]) continue; xs2[j] = s.xs[i]; ys2[j] = s.ys[i]; rows2[j] = s.rows[i]; j++; }
        s.xs = xs2; s.ys = ys2; s.rows = rows2; s.flags = null;
      });
    }

    // --- per-series labels (coils recomputed over included rows)
    series.forEach(function (s) {
      var ds = dsOf(s.m), sns = new Set(), nPts = 0;
      for (var i = 0; i < s.rows.length; i++) {
        if (s.flags && s.flags[i]) continue;
        nPts++;
        var sn = ds.sn[s.rows[i]]; if (sn >= 0) sns.add(self.snClean[sn]);
      }
      s.nIncluded = nPts; s.coilsIncluded = sns.size;
      var shown = mode === 'flag' ? s.ys.length : nPts;
      s.label = s.machine + ' (' + (mode === 'flag' ? s.nCoils : sns.size) + ' coils, ' + shown + ' pts)';
    });

    // --- statistics
    var stats = null;
    if (opts.stats) {
      // capability against the latest spec revision; pass/fail judges each point by the limit of its own row
      var lslT = g.lslSpans.length ? g.lslSpans[g.lslSpans.length - 1].value : NaN;
      var uslT = g.uslSpans.length ? g.uslSpans[g.uslSpans.length - 1].value : NaN;
      var revised = g.lslSpans.length > 1 || g.uslSpans.length > 1;
      // In flag mode the flagged points are still on the chart; statsOut decides whether they count.
      var skipFlagged = !(mode === 'flag' && statsOut === 'include');
      var rowsOut = [], all = [], allL = [], allU = [];
      series.forEach(function (s) {
        var vals = [], rl = [], ru = [], dsr = dsOf(s.m);
        for (var i = 0; i < s.ys.length; i++) {
          if (skipFlagged && s.flags && s.flags[i]) continue;
          vals.push(s.ys[i]); rl.push(dsr.lsl[s.rows[i]]); ru.push(dsr.usl[s.rows[i]]);
        }
        Array.prototype.push.apply(all, vals); Array.prototype.push.apply(allL, rl); Array.prototype.push.apply(allU, ru);
        var d = describe(vals, lslT, uslT, rl, ru);
        d.label = s.machine; d.color = s.color; d.shape = s.shape; d.big = s.big; d.coils = skipFlagged ? s.coilsIncluded : s.nCoils; d.outliers = s.nOut;
        rowsOut.push(d);
      });
      if (series.length > 1) {
        var dAll = describe(all, lslT, uslT, allL, allU);
        var coilsAll = new Set();
        series.forEach(function (s) { var ds = dsOf(s.m); for (var i = 0; i < s.rows.length; i++) { if (skipFlagged && s.flags && s.flags[i]) continue; var sn = ds.sn[s.rows[i]]; if (sn >= 0) coilsAll.add(self.snClean[sn]); } });
        dAll.label = 'All machines'; dAll.color = null; dAll.coils = coilsAll.size; dAll.outliers = outliers ? outliers.count : 0;
        rowsOut.push(dAll);
      }
      var hasL = lslT === lslT, hasU = uslT === uslT;
      var foot = [];
      if (mode === 'flag' && outliers) {
        var detTxt = 'modified z-score k = ' + k + ', median ' + fmt2(outliers.median) + ', MAD ' + fmt2(outliers.mad);
        foot.push(outliers.count ? 'Statistics ' + (skipFlagged ? 'exclude ' : 'include ') + outliers.count + ' flagged outlier' + (outliers.count === 1 ? '' : 's') + ' (' + outliers.nPinned + ' shown off-scale); ' + detTxt + '.'
                              : 'No outliers flagged (modified z-score k = ' + k + (outliers.n < CATE.OUTLIER_DEFAULTS.minN ? ', fewer than ' + CATE.OUTLIER_DEFAULTS.minN + ' points' : ', median ' + fmt2(outliers.median) + ', MAD ' + fmt2(outliers.mad)) + ').');
      } else if (mode === 'exclude' && outliers) {
        foot.push(outliers.count ? outliers.count + ' outlier' + (outliers.count === 1 ? '' : 's') + ' excluded from chart and statistics (modified z-score k = ' + k + ', median ' + fmt2(outliers.median) + ', MAD ' + fmt2(outliers.mad) + ').'
                              : 'No outliers excluded (modified z-score k = ' + k + ').');
      } else {
        foot.push('All points included (outlier detection off).');
      }
      if (runsMode !== 'all') foot.push((runsMode === 'latest' ? 'Latest' : 'First') + ' run per coil only: ' + runsCoils + ' coil' + (runsCoils === 1 ? '' : 's') + ', one point each (rows without a serial number kept).');
      var specTxt = [];
      if (hasL) specTxt.push('LSL ' + fmt2(lslT) + (g.lslSpans.length > 1 ? ' (latest of ' + g.lslSpans.length + ' revisions)' : ''));
      if (hasU) specTxt.push('USL ' + fmt2(uslT) + (g.uslSpans.length > 1 ? ' (latest of ' + g.uslSpans.length + ' revisions)' : ''));
      foot.push((specTxt.length ? 'Spec: ' + specTxt.join(', ') + (revised ? '; in spec uses the limit in force on each test date' : '') + ' · ' : 'No spec limits · ') + 'σ = sample std dev' +
                (hasL && hasU ? ' · Cpk = min((USL − mean), (mean − LSL)) / 3σ' : hasU ? ' · Cpu = (USL − mean) / 3σ' : hasL ? ' · Cpl = (mean − LSL) / 3σ' : '') +
                (g.unitsMixed ? ' · mixed units in this group' : ''));
      stats = { rows: rowsOut, lsl: lslT, usl: uslT, capHeader: hasL && hasU ? 'Cpk' : hasU ? 'Cpu' : hasL ? 'Cpl' : '', footnotes: foot,
                includesOutliers: !skipFlagged };
    }

    var title2 = g.keyKind === 'net'
      ? g.net + ' ' + MEAS.label + ' vs Date'
      : 'Test Case ' + g.tc + ' Ch' + g.chan + ' E' + g.elem + ' ' + MEAS.label + ' vs Date';
    var fileName = g.fileName;
    if (filtered) {
      title2 += ' - ' + CATE.MACHINES[onlyMachine];
      fileName = g.fileName.replace(/\.png$/, '') + '_' + CATE.MACHINES[onlyMachine] + '.png';
    } else if (g.machinesPresent === 1) {
      var only = -1; for (var mp = 0; mp < g.rows.length; mp++) if (g.rows[mp]) only = mp;
      title2 += ' - Single ' + machineFamily(CATE.MACHINES[only]);
    }
    if (opts.port) title2 += ' · Port ' + opts.port;
    if (runsMode !== 'all') { title2 += ' · ' + runsMode + ' run per coil'; fileName = fileName.replace(/\.png$/, '') + '_' + runsMode + '.png'; }
    return {
      title1: coilResult.name + ' - Mode ' + g.mode, title2: title2,
      series: series,
      lsl: specLines(g.lslSpans, 'LSL', dec),
      usl: specLines(g.uslSpans, 'USL', dec),
      xMin: coilResult.start, xMax: coilResult.endExcl,
      yMin: yMin, yMax: yMax,
      missingSpec: g.missingSpec,
      fileName: fileName, relPath: coilResult.safeName + '/' + g.modeDir + '/' + fileName,
      machine: filtered ? CATE.MACHINES[onlyMachine] : null,
      measurement: measurement, units: units, decimals: dec, yLabel: MEAS.valueLabel || (MEAS.label + ' / Measurement (' + units + ')'),
      port: opts.port || null, runs: runsMode, runsCoils: runsCoils,
      outlierMode: mode, outliers: outliers, stats: stats, statsOutliers: statsOut,
      excludedNote: (mode === 'exclude' && outliers && outliers.count) ? outliers.count + ' outlier' + (outliers.count === 1 ? '' : 's') + ' excluded (modified z-score, k = ' + k + ')' : null
    };
  };

  /* Row detail for tooltips.
   * m: machine index, idx: row index into that machine's dataset for `measurement`. Resolves the dictionary
   * ids back to strings and returns { machine, time, meas, sn, lsl, usl, units, port, pf, extras }.
   */
  Model.prototype.rowInfo = function (m, idx, measurement) {
    measurement = measurement || 'Sensitivity';
    var ds = this.machines[m].datasets[measurement];
    var s = ds.sn[idx];
    var extras = {};
    Object.keys(ds.extras || {}).forEach(function (k) { extras[k] = ds.extras[k][idx]; });
    return {
      machine: CATE.MACHINES[m], time: ds.time[idx], meas: ds.meas[idx],
      sn: s >= 0 ? this.dict.sn.list[s] : '(none)',
      lsl: ds.lsl[idx], usl: ds.usl[idx],
      units: ds.units[idx] >= 0 ? this.dict.units.list[ds.units[idx]] : CATE.MEASUREMENTS[measurement].defaultUnits,
      port: ds.port && ds.port[idx] >= 0 ? this.dict.port.list[ds.port[idx]] : '',
      pf: ds.pf ? ds.pf[idx] : -1,                       // 1 PASS, 0 FAIL, -1 not recorded
      extras: extras
    };
  };

  /* ---------- test runs and first pass yield ----------
   * A run is one pass of a tester over one coil (serial number): its rows across every loaded result
   * table, in time order. A new run starts when the gap to the previous row exceeds gapMs, or when a
   * measurement key (table, mode, test case, channel, element / net) repeats at a later time, i.e. the
   * tester has started the sequence again. Rows that share a timestamp always belong to one run. The
   * verdict of a row is its PassFail column, or its own LSL / USL when that column is missing; a run
   * fails when any row fails, passes when at least one row is judged and none fails, else it is unjudged.
   * Rows without a serial number cannot be attributed to a coil and are left out. */
  CATE.RUN_GAP_MINUTES = 15;
  /* Verdict of one row: 1 pass, 0 fail, -1 unjudged. The tester's PassFail column wins when recorded; otherwise
   * the value is compared with the row's own LSL / USL (NaN = no limit; no limit on either side = unjudged). */
  function rowVerdict(ds, idx) {
    var pf = ds.pf ? ds.pf[idx] : -1;
    if (pf >= 0) return pf;
    var y = ds.meas[idx], l = ds.lsl[idx], u = ds.usl[idx];
    if (l !== l && u !== u) return -1;
    return ((l === l && y < l) || (u === u && y > u)) ? 0 : 1;
  }
  /* Reconstruct the test runs of every coil type (rules in the section comment above).
   * gapMs: idle time that ends a run (default CATE.RUN_GAP_MINUTES). Cached on this._runs and reused while
   * the model version and gapMs are unchanged.
   * For each coil id the rows of every loaded dataset (dsList, in machine and MEASUREMENT_ORDER) that carry a
   * serial number are gathered into parallel arrays time / src (dsList index) / row / sc (cleaned serial id),
   * then an index `order` is sorted by cleaned serial, then time. Walking that order, a new run starts when
   * the serial changes, the gap to the previous row exceeds gapMs, or the row's measurement key
   * (table|mode|tc|chan|elem|net) was already seen in the current run at an earlier time. Each run records
   * { sc, sn (raw id of its first row), m (machine of its first row), t0, t1, start / end (slice of `order`),
   * n, verdict (1 / 0 / -1), failMask and judgedMask (one bit per MEASUREMENT_ORDER index), machineMask }.
   * Returns { version, gapMs, dsList, coils: [{ runs, order, src, row, time, n }] } indexed by coil id. */
  Model.prototype.runs = function (gapMs) {
    gapMs = gapMs > 0 ? gapMs : CATE.RUN_GAP_MINUTES * 60000;
    if (this._runs && this._runs.version === this.version && this._runs.gapMs === gapMs) return this._runs;
    var self = this, nCoils = this.dict.coil.list.length;
    var dsList = [];                                       // every loaded dataset: { m, k, mi (MEASUREMENT_ORDER index), ds }
    this.loadedMachines().forEach(function (mach) {
      CATE.MEASUREMENT_ORDER.forEach(function (k, mi) { if (mach.datasets[k]) dsList.push({ m: mach.index, k: k, mi: mi, ds: mach.datasets[k] }); });
    });
    var coils = new Array(nCoils);
    for (var c = 0; c < nCoils; c++) {
      var n = 0;
      dsList.forEach(function (e) { var r = e.ds.rowsByCoil[c]; if (r) n += r.length; });
      var time = new Float64Array(n), src = new Uint16Array(n), row = new Uint32Array(n), sc = new Int32Array(n), p = 0;
      dsList.forEach(function (e, di) {
        var r = e.ds.rowsByCoil[c]; if (!r) return;
        var ds = e.ds;
        for (var i = 0; i < r.length; i++) {
          var idx = r[i], s = ds.sn[idx];
          if (s < 0) continue;
          time[p] = ds.time[idx]; src[p] = di; row[p] = idx; sc[p] = self.snClean[s]; p++;
        }
      });
      n = p;
      var order = new Uint32Array(n);
      for (var i0 = 0; i0 < n; i0++) order[i0] = i0;
      order.sort(function (a, b) { return sc[a] - sc[b] || time[a] - time[b]; });
      var runs = [], cur = null, keys = null, prevT = 0;
      for (var q = 0; q < n; q++) {
        var o = order[q], e = dsList[src[o]], ds2 = e.ds, idx2 = row[o], t = time[o];
        var key = e.mi + '|' + ds2.mode[idx2] + '|' + ds2.tc[idx2] + '|' + ds2.chan[idx2] + '|' + ds2.elem[idx2] + '|' + ds2.net[idx2];
        if (!cur || cur.sc !== sc[o] || t - prevT > gapMs || (t > prevT && keys.has(key))) {
          cur = { sc: sc[o], sn: ds2.sn[idx2], m: e.m, t0: t, t1: t, start: q, end: q, n: 0, verdict: -1, failMask: 0, judgedMask: 0, machineMask: 0 };
          runs.push(cur); keys = new Set();
        }
        keys.add(key);
        cur.t1 = t; cur.end = q + 1; cur.n++; cur.machineMask |= (1 << e.m);
        var v = rowVerdict(ds2, idx2);
        if (v >= 0) { cur.judgedMask |= (1 << e.mi); if (v === 0) { cur.failMask |= (1 << e.mi); cur.verdict = 0; } else if (cur.verdict < 0) cur.verdict = 1; }
        prevT = t;
      }
      coils[c] = { runs: runs, order: order, src: src, row: row, time: time, n: n };
    }
    this._runs = { version: this.version, gapMs: gapMs, dsList: dsList, coils: coils };
    return this._runs;
  };

  /* First pass yield per coil type.
   * settings: as build() (date range + per-coil overrides);
   * opts: { gapMs, machine (0..n-1, or -1 for every machine), includeTestKits,
   *         excludeSn: raw serial numbers whose runs are left out, as an array / Set of strings (case-insensitive), a RegExp or a predicate }
   * A serial number counts as tested when its first run (over every loaded date, on the chosen machines)
   * starts inside the coil's date range. It passed first time when that run passed; its final result is
   * its latest run. Rates use the serials whose first run was judged (pass or fail). */
  CATE.TEST_KIT_PATTERN = /test kit/i;
  /* Production serial numbers as the testers record them: up to five digits (zero-padded on the CATE testers),
   * optionally followed by a dash and a numeric suffix, e.g. 00827-301424423. Anything else (eval / test / engineering
   * labels, names, mistyped entries) is a dummy serial, left out of the yield by default. */
  CATE.SERIAL_FORMAT = /^\d{1,5}(-\d+)?$/;
  CATE.SERIAL_DUMMY = /test|tst|eval/i;
  /* Default dummy rule for the yield report and the serial picker: true when sn matches SERIAL_DUMMY or fails SERIAL_FORMAT. */
  CATE.isDummySerial = function (sn) { return CATE.SERIAL_DUMMY.test(sn) || !CATE.SERIAL_FORMAT.test(sn); };
  /* Normalise an excludeSn spec into a predicate (raw serial string -> boolean), or null when nothing is
   * excluded: a function is used as is, a RegExp is tested, an array / Set of strings becomes a
   * case-insensitive membership test. */
  function serialPredicate(spec) {
    if (!spec) return null;
    if (typeof spec === 'function') return spec;
    if (spec instanceof RegExp) return function (sn) { return spec.test(sn); };
    var set = new Set();
    (spec instanceof Set ? Array.from(spec) : spec).forEach(function (sn) { set.add(String(sn).toLowerCase()); });
    return set.size ? function (sn) { return set.has(sn.toLowerCase()); } : null;
  }
  CATE.serialPredicate = serialPredicate;

  /* Every raw serial number in the loaded data (as the tester recorded it) with how often it was run, for the
   * exclusion picker: [{ sn, variants, cleaned, dummy, runs, failed, coils (number of coil types), coilNames (up to three) }].
   * Serials that differ only by case (TST / tst) are one entry, shown as the most-run spelling with the others in
   * `variants`. Dummy serials (CATE.isDummySerial) come first in alphabetical order, then production serials by number. */
  Model.prototype.serialList = function (gapMs) {
    var R = this.runs(gapMs), names = this.dict.coil.list, rawList = this.dict.sn.list, cleanList = this.snCleanDict.list;
    var by = new Map();
    R.coils.forEach(function (rc, c) {
      if (!rc) return;
      rc.runs.forEach(function (r) {
        var sn = rawList[r.sn], key = sn.toLowerCase(), e = by.get(key);
        if (!e) by.set(key, e = { runs: 0, failed: 0, coilIds: new Set(), forms: new Map(), cleaned: cleanList[r.sc] });
        e.runs++; if (r.verdict === 0) e.failed++; e.coilIds.add(c); e.forms.set(sn, (e.forms.get(sn) || 0) + 1);
      });
    });
    var out = Array.from(by.values()).map(function (e) {
      var ids = Array.from(e.coilIds);
      var forms = Array.from(e.forms.entries()).sort(function (a, b) { return b[1] - a[1] || cmpStr(a[0], b[0]); }).map(function (f) { return f[0]; });
      return { sn: forms[0], variants: forms.slice(1), cleaned: e.cleaned, dummy: CATE.isDummySerial(forms[0]), runs: e.runs, failed: e.failed,
               coils: ids.length, coilNames: ids.slice(0, 3).map(function (c) { return names[c]; }) };
    });
    out.sort(function (a, b) {
      if (a.dummy !== b.dummy) return a.dummy ? -1 : 1;
      if (!a.dummy) return (parseInt(a.cleaned, 10) - parseInt(b.cleaned, 10)) || cmpStr(a.sn, b.sn);
      return cmpStr(a.sn.toLowerCase(), b.sn.toLowerCase()) || cmpStr(a.sn, b.sn);
    });
    return out;
  };

  /* First pass yield report (counting rules in the comment above CATE.TEST_KIT_PATTERN).
   * Returns { coils: [agg], total: agg, skippedTestKits, gapMs, machine, tables, version } where agg =
   * { coil, coilId, start, endIncl, override, tested, judged, firstPass, firstFail, unjudged, retested,
   *   finalPass, runs, runsFailed, excluded, fpyPct, finalPct, byMeas, byMachine, failTests }.
   * How it works: for every coil type (test kits skipped unless includeTestKits) the runs from runs() are
   * grouped by cleaned serial, honouring the machine filter; runs recorded under an excluded raw serial are
   * dropped (a serial whose runs all drop out is not tested; drops inside the range count in `excluded`).
   * A serial is tested when its first remaining run starts inside the coil's range; that first run decides
   * firstPass / firstFail / unjudged, the per-machine and per-measurement counts and the failing test labels,
   * its last run decides finalPass. Per-coil aggregates roll into `total`, then rates() derives the
   * percentages. Coils are sorted by tested count descending, then name. */
  Model.prototype.yieldReport = function (settings, opts) {
    opts = opts || {};
    var R = this.runs(opts.gapMs), self = this, dict = this.dict;
    var onlyM = typeof opts.machine === 'number' && opts.machine >= 0 ? opts.machine : -1;
    var excluded = serialPredicate(opts.excludeSn);
    var ORDER = CATE.MEASUREMENT_ORDER, NMEAS = ORDER.length;
    /* Empty aggregate for one coil type (or the total) with per-measurement and per-machine counters. */
    function newAgg(name) {
      return { coil: name, tested: 0, judged: 0, firstPass: 0, firstFail: 0, unjudged: 0, retested: 0, finalPass: 0, runs: 0, runsFailed: 0, excluded: 0,
               byMeas: ORDER.map(function (k) { return { measurement: k, label: CATE.MEASUREMENTS[k].label, judged: 0, failed: 0 }; }),
               byMachine: CATE.MACHINES.map(function (nm) { return { machine: nm, tested: 0, pass: 0, fail: 0 }; }),
               failTests: new Map(), fpyPct: NaN, finalPct: NaN };
    }
    /* Finish an aggregate: derive judged / fpyPct / finalPct, drop empty per-measurement and per-machine rows
     * and turn failTests into a list sorted by coil count. Mutates and returns a. */
    function rates(a) {
      a.judged = a.firstPass + a.firstFail;
      a.fpyPct = a.judged ? a.firstPass / a.judged * 100 : NaN;
      a.finalPct = a.judged ? a.finalPass / a.judged * 100 : NaN;
      a.byMeas = a.byMeas.filter(function (x) { return x.judged > 0; });
      a.byMachine = a.byMachine.filter(function (x) { return x.tested > 0; });
      a.failTests = Array.from(a.failTests.entries()).map(function (kv) { return { test: kv[0], coils: kv[1] }; })
        .sort(function (x, y) { return y.coils - x.coils || cmpStr(x.test, y.test); });
      return a;
    }
    /* Label of one row's test, e.g. "Sensitivity · Mode 1 · TC03 Ch1 E2" or "SCPre · Mode 1 · Net X". */
    function testLabel(e, ds, idx) {
      var MEAS = CATE.MEASUREMENTS[e.k];
      var head = MEAS.label + ' · Mode ' + dict.mode.list[ds.mode[idx]] + ' · ';
      if (ds.keyKind === 'net') return head + (MEAS.keyLabel || 'Net') + ' ' + dict.net.list[ds.net[idx]];
      return head + 'TC' + pad2(ds.tc[idx]) + ' Ch' + dict.chan.list[ds.chan[idx]] + ' E' + dict.elem.list[ds.elem[idx]];
    }
    var coils = [], tot = newAgg('All coil types'), skippedKits = 0;
    this.coilList().forEach(function (ce) {
      if (!opts.includeTestKits && CATE.TEST_KIT_PATTERN.test(ce.name)) { skippedKits++; return; }
      var rc = R.coils[ce.id];
      if (!rc || !rc.runs.length) return;
      var range = rangeForCoil(settings, ce.name);
      var bySn = new Map();
      rc.runs.forEach(function (r) {
        if (onlyM >= 0 && r.m !== onlyM) return;
        var l = bySn.get(r.sc); if (!l) bySn.set(r.sc, l = []);
        l.push(r);                                         // time order within a serial (runs were built that way)
      });
      var agg = newAgg(ce.name), exclKeys = new Set();          // excluded serials, counted case-insensitively (TST and tst are one)
      agg.coilId = ce.id; agg.start = range.start; agg.endIncl = range.endIncl; agg.override = range.override;
      bySn.forEach(function (list, sc) {
        if (excluded) {                                      // runs recorded under an excluded raw serial drop out; the coil keeps its other runs
          var kept = [];
          list.forEach(function (r) {
            var raw = dict.sn.list[r.sn];
            if (!excluded(raw)) kept.push(r);
            else if (r.t0 >= range.start && r.t0 < range.endExcl) exclKeys.add(raw.toLowerCase());
          });
          if (!kept.length) return;
          list = kept;
        }
        var first = list[0], last = list[list.length - 1];
        if (first.t0 < range.start || first.t0 >= range.endExcl) return;
        agg.tested++; agg.runs += list.length;
        list.forEach(function (r) { if (r.verdict === 0) agg.runsFailed++; });
        if (list.length > 1) agg.retested++;
        if (first.verdict === 1) agg.firstPass++; else if (first.verdict === 0) agg.firstFail++; else agg.unjudged++;
        if (last.verdict === 1 && first.verdict >= 0) agg.finalPass++;
        var bm = agg.byMachine[first.m]; bm.tested++; if (first.verdict === 1) bm.pass++; else if (first.verdict === 0) bm.fail++;
        for (var mi = 0; mi < NMEAS; mi++) {
          if (first.judgedMask & (1 << mi)) { agg.byMeas[mi].judged++; if (first.failMask & (1 << mi)) agg.byMeas[mi].failed++; }
        }
        if (first.verdict === 0) {                         // which tests failed on the first run
          var seen = new Set();
          for (var q = first.start; q < first.end; q++) {
            var o = rc.order[q], e = R.dsList[rc.src[o]], idx = rc.row[o];
            if (rowVerdict(e.ds, idx) !== 0) continue;
            var label = testLabel(e, e.ds, idx);
            if (seen.has(label)) continue;
            seen.add(label);
            agg.failTests.set(label, (agg.failTests.get(label) || 0) + 1);
          }
        }
      });
      agg.excluded = exclKeys.size;
      tot.excluded += agg.excluded;                            // counted even when the coil type is not listed
      if (!agg.tested) return;                                 // only dummy serials in range: no row
      ['tested', 'firstPass', 'firstFail', 'unjudged', 'retested', 'finalPass', 'runs', 'runsFailed'].forEach(function (f) { tot[f] += agg[f]; });
      agg.byMeas.forEach(function (x, mi) { tot.byMeas[mi].judged += x.judged; tot.byMeas[mi].failed += x.failed; });
      agg.byMachine.forEach(function (x, m) { tot.byMachine[m].tested += x.tested; tot.byMachine[m].pass += x.pass; tot.byMachine[m].fail += x.fail; });
      agg.failTests.forEach(function (cnt, label) { tot.failTests.set(agg.coil + ' · ' + label, cnt); });
      coils.push(rates(agg));
    });
    coils.sort(function (a, b) { return b.tested - a.tested || cmpStr(a.coil, b.coil); });
    return { coils: coils, total: rates(tot), skippedTestKits: skippedKits, gapMs: R.gapMs, machine: onlyM >= 0 ? CATE.MACHINES[onlyM] : null,
             tables: this.measurementsLoaded().map(function (k) { return CATE.MEASUREMENTS[k].label; }), version: this.version };
  };

  /* Summaries (charts_generated_by_coil / by_coil_mode)
   * From a build() result: byCoil = [{ coil, charts, rows }] and byCoilMode = [{ coil, mode, charts }] for
   * coils that produced at least one chart, mirroring the two summary CSVs the Python script wrote.
   */
  function summaryRows(build) {
    var byCoil = [], byCoilMode = [];
    build.coils.forEach(function (c) {
      if (!c.groups.length) return;
      byCoil.push({ coil: c.name, charts: c.groups.length, rows: c.rowCount });
      var counts = {};
      c.groups.forEach(function (g) { counts[g.mode] = (counts[g.mode] || 0) + 1; });
      Object.keys(counts).sort(cmpStr).forEach(function (mo) { byCoilMode.push({ coil: c.name, mode: mo, charts: counts[mo] }); });
    });
    return { byCoil: byCoil, byCoilMode: byCoilMode };
  }

  /* Quote a CSV field when it holds a comma, quote or line break (quotes doubled). */
  function csvEscape(v) { v = String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  /* Serialise rows (objects) to CSV text in the given column order; CRLF line endings, missing values empty. */
  function toCsv(rows, cols) {
    var lines = [cols.join(',')];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return csvEscape(r[c] === undefined ? '' : r[c]); }).join(',')); });
    return lines.join('\r\n') + '\r\n';
  }

  /* Public surface: the Model class, the shared instance and the helpers other modules and tests reuse. */
  CATE.Model = Model;
  CATE.model = new Model();
  CATE.makeSafeName = makeSafeName;
  CATE.machineIndexFromName = machineIndexFromName;
  CATE.machineFamily = machineFamily;
  CATE.cleanSn = cleanSn;
  CATE.summaryRows = summaryRows;
  CATE.toCsv = toCsv;
  CATE.cmpStr = cmpStr;
})(typeof globalThis !== 'undefined' ? globalThis : this);

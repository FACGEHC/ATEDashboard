/* model.js - columnar data store (per machine + measurement), coil/date-range filtering, grouping, chart specs.
 * Attached to globalThis.CATE so it runs in the browser and in Node tests.
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
   * ("000835-302823625" and "00835" are the same coil). */
  function cleanSn(sn) {
    var base = String(sn).replace(/-.*$/, '').trim();
    var cleaned = base.replace(/^0+/, '');
    return cleaned === '' ? (base === '' ? String(sn) : base) : cleaned;
  }

  function machineIndexFromName(name) {
    var m = /(CATE|EVO|NATE)[_ -]?(\d{4})/i.exec(name || '');
    if (!m) return -1;
    return CATE.MACHINES.indexOf(m[1].toUpperCase() + m[2]);
  }

  /* Python make_safe_name */
  function makeSafeName(value) {
    var text = String(value).trim();
    text = text.replace(/[<>:"/\\|?*]/g, '-');
    text = text.replace(/\s+/g, '_');
    text = text.replace(/_+/g, '_');
    return text.replace(/^[ ._]+|[ ._]+$/g, '');
  }

  function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }     // code-point order like Python
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function Dict() { this.list = []; this.map = new Map(); }
  Dict.prototype.id = function (s) {
    var v = this.map.get(s);
    if (v === undefined) { v = this.list.length; this.list.push(s); this.map.set(s, v); }
    return v;
  };

  function Model() {
    this.dict = { coil: new Dict(), mode: new Dict(), chan: new Dict(), elem: new Dict(), net: new Dict(), sn: new Dict(), units: new Dict(), port: new Dict() };
    this.snClean = [];          // sn id -> cleaned-sn id (distinct coil counting)
    this.snCleanDict = new Dict();
    this.machines = CATE.MACHINES.map(function () { return null; });   // m -> { name, index, datasets: { measurement: ds } }
    this.version = 0;
  }

  /* Merge a worker 'dataset' payload for machine m / measurement into the global store. */
  Model.prototype.addDataset = function (m, measurement, parsed) {
    var self = this;
    var cols = parsed.columns;
    var n = parsed.n;
    if (!cols.port) { cols.port = new Int32Array(n); cols.port.fill(-1); }
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
      extras: cols.extras || {},
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

  Model.prototype.removeDataset = function (m, measurement) {
    var mach = this.machines[m];
    if (!mach) return;
    delete mach.datasets[measurement];
    if (!Object.keys(mach.datasets).length) this.machines[m] = null;
    this.version++;
  };
  Model.prototype.removeMachine = function (m) { this.machines[m] = null; this.version++; };
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
  Model.prototype.hasData = function (measurement) {
    return measurement ? this.datasetsFor(measurement).length > 0 : this.loadedMachines().length > 0;
  };
  Model.prototype.measurementsLoaded = function () {
    var self = this;
    return CATE.MEASUREMENT_ORDER.filter(function (k) { return self.datasetsFor(k).length > 0; });
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
   */
  function rangeForCoil(settings, coilName) {
    var ov = settings.overrides || [];
    for (var i = 0; i < ov.length; i++) {
      if (ov[i].coil === coilName) return { start: ov[i].start, endIncl: ov[i].end, endExcl: ov[i].end + DAY, override: true };
    }
    return { start: settings.start, endIncl: settings.end, endExcl: settings.end + DAY, override: false };
  }

  function emptyPerMachine(v) { return CATE.MACHINES.map(function () { return typeof v === 'function' ? v() : v; }); }

  /* Spec limits can change over time (a spec revision): remember the first and last row date of each
   * distinct value so the chart can draw every limit only over the period it applied. */
  function noteSpec(seen, value, t) {
    var sp = seen.get(value);
    if (!sp) seen.set(value, { value: value, tFirst: t, tLast: t });
    else { if (t < sp.tFirst) sp.tFirst = t; if (t > sp.tLast) sp.tLast = t; }
  }
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

  /* Build groups for one coil and measurement. Returns coilResult. */
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

  /* Build every coil for a measurement. */
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

  function median(sorted) {
    var n = sorted.length;
    if (!n) return NaN;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }
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

  /* flags[i]: 0 normal, 1 high outlier, 2 low outlier. No flags when n < minN. */
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

  function fmtD(v, d) { return (v < 0 ? '−' : '') + Math.abs(v).toFixed(d); }

  /* Chart spec for the renderer (pure data).
   * onlyMachine (optional, 0..MACHINES.length-1): draw just that machine's series.
   * opts: { outlierMode: 'flag'|'exclude'|'off', k, stats, statsOutliers: 'include'|'exclude', port: 'N' (only that port's rows) }
   *   (default: off, no stats; statsOutliers defaults to 'include' and only matters in flag mode,
   *    since exclude mode removes the points and off mode never flags any)
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
    var self = this;
    var series = [];
    var filtered = typeof onlyMachine === 'number' && onlyMachine >= 0;
    function dsOf(m) { var mach = self.machines[m]; return mach ? mach.datasets[measurement] : null; }
    var portId = opts.port ? self.dict.port.map.get(String(opts.port)) : undefined;
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
      var xs = new Float64Array(rows.length), ys = new Float64Array(rows.length);
      for (var i = 0; i < rows.length; i++) { xs[i] = ds.time[rows[i]]; ys[i] = ds.meas[rows[i]]; }
      var name = CATE.MACHINES[m], st = CATE.MACHINE_STYLE[name];
      series.push({ machine: name, m: m, nCoils: g.nCoils[m], label: '',
                    color: st.color, shape: st.shape, big: st.big, xs: xs, ys: ys, rows: rows, flags: null, nOut: 0 });
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
      port: opts.port || null,
      outlierMode: mode, outliers: outliers, stats: stats, statsOutliers: statsOut,
      excludedNote: (mode === 'exclude' && outliers && outliers.count) ? outliers.count + ' outlier' + (outliers.count === 1 ? '' : 's') + ' excluded (modified z-score, k = ' + k + ')' : null
    };
  };

  /* Row detail for tooltips. */
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
      extras: extras
    };
  };

  /* Summaries (charts_generated_by_coil / by_coil_mode) */
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

  function csvEscape(v) { v = String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function toCsv(rows, cols) {
    var lines = [cols.join(',')];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return csvEscape(r[c] === undefined ? '' : r[c]); }).join(',')); });
    return lines.join('\r\n') + '\r\n';
  }

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

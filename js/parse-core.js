/* parse-core.js
 * Self-contained parsing core for the CATE dashboard: CSV exports and Access (.mdb) result tables
 * both end up as the same columnar dataset per machine + measurement.
 *
 * IMPORTANT: this function must not reference anything outside itself.
 * loader.js embeds `cateParseCore.toString()` into a Blob-URL Web Worker, and
 * also calls it directly on the main thread as a fallback. Everything it needs
 * (TextDecoder, Blob.slice, typed arrays, Map) is available in both contexts.
 * The .mdb path receives a cateJetCore() instance through opts.jet.
 */
function cateParseCore() {
  'use strict';

  /* ---------- measurement schemas ----------
   * keyKind 'tc'  : one chart per Mode / TestCase / Channel / Element
   * keyKind 'net' : one chart per Mode / NetName
   * LSL / USL / Units are optional columns (missing -> NaN / default units). */
  /* keyKind 'net' = one chart per Mode + a single string column named by keyColumn (NetName or TestedLine).
   * valueColumn is the plotted value (default Measurement); extras are numeric columns kept for the tooltip;
   * fixedUnits overrides the Units column when it describes a different quantity than the plotted one. */
  var KEY_TC = ['CoilName', 'CoilSN', 'Mode', 'TimeDate', 'TestCase', 'Channel', 'Element', 'Measurement'];
  var KEY_NET = ['CoilName', 'CoilSN', 'Mode', 'TimeDate', 'NetName', 'Measurement'];
  var KEY_LINE = ['CoilName', 'CoilSN', 'Mode', 'TimeDate', 'TestedLine', 'Measurement'];
  var KEY_NOISE = ['CoilName', 'CoilSN', 'Mode', 'TimeDate', 'TestCase', 'Channel', 'Element', 'Difference'];
  var MEASUREMENT_ORDER = ['Sensitivity', 'MCBias', 'MuxAuxPS', 'Oscillation', 'SCPre', 'Noise', 'BTE', 'MEMSCurrent', 'MEMSSC', 'MCBiasCurrent', 'CoilPresent'];
  var MEASUREMENTS = {
    Sensitivity: { key: 'Sensitivity', table: 'Sensitivity',        keyKind: 'tc',  required: KEY_TC,    defaultUnits: 'dB' },
    MCBias:      { key: 'MCBias',      table: 'MCBiasResults',      keyKind: 'tc',  required: KEY_TC,    defaultUnits: 'V' },
    MuxAuxPS:    { key: 'MuxAuxPS',    table: 'MuxAuxPSResults',    keyKind: 'net', required: KEY_NET,   defaultUnits: 'A', keyColumn: 'NetName' },
    Oscillation: { key: 'Oscillation', table: 'OscillationResults', keyKind: 'tc',  required: KEY_TC,    defaultUnits: 'dB', extras: ['Frequency'] },
    SCPre:       { key: 'SCPre',       table: 'SCPreResults',       keyKind: 'net', required: KEY_NET,   defaultUnits: 'V', keyColumn: 'NetName' },
    Noise:       { key: 'Noise',       table: 'NoiseResults',       keyKind: 'tc',  required: KEY_NOISE, defaultUnits: 'dB', valueColumn: 'Difference', fixedUnits: 'dB', extras: ['Measurement', 'Baseline'] },
    BTE:         { key: 'BTE',         table: 'BTEResults',         keyKind: 'net', required: KEY_LINE,  defaultUnits: '',  keyColumn: 'TestedLine' },
    MEMSCurrent: { key: 'MEMSCurrent', table: 'MEMSCurrentResults', keyKind: 'net', required: KEY_LINE,  defaultUnits: '',  keyColumn: 'TestedLine' },
    MEMSSC:      { key: 'MEMSSC',      table: 'MEMSSCResults',      keyKind: 'net', required: KEY_LINE,  defaultUnits: '',  keyColumn: 'TestedLine' },
    // NATE (CATE 2.0 tester) tables written by tools/atml_to_mdb.ps1
    MCBiasCurrent: { key: 'MCBiasCurrent', table: 'MCBiasCurrentResults', keyKind: 'tc', required: KEY_TC, defaultUnits: 'A' },
    CoilPresent:   { key: 'CoilPresent',   table: 'CoilPresentResults',   keyKind: 'net', required: KEY_NET, defaultUnits: 'V', keyColumn: 'NetName' }
  };
  var OPTIONAL = ['LSL', 'USL', 'Units', 'PassFail', 'Port', 'Baseline', 'Difference', 'Frequency', 'NetName', 'TestedLine'];

  // pandas default NA tokens (subset that can realistically occur after trim)
  var NA_TOKENS = Object.create(null);
  ['', 'NA', 'N/A', 'n/a', 'NULL', 'null', 'NaN', 'nan', '-NaN', '-nan',
   'None', '#N/A', '#NA', '<NA>', '#N/A N/A', '1.#IND', '1.#QNAN',
   '-1.#IND', '-1.#QNAN'].forEach(function (t) { NA_TOKENS[t] = true; });

  var EXCLUDED_MODES = Object.create(null);
  EXCLUDED_MODES['Post. Coil ID Check'] = true;

  var SEG = 262144;          // rows per typed-array segment
  var CHUNK = 8 * 1024 * 1024;

  /* ---------- dates ---------- */

  // Howard Hinnant's days_from_civil: days since 1970-01-01 for a proleptic
  // Gregorian y-m-d. Pure integer math, no Date objects.
  function daysFromCivil(y, m, d) {
    y -= (m <= 2) ? 1 : 0;
    var era = Math.floor(y / 400);
    var yoe = y - era * 400;
    var mp = (m + 9) % 12;                     // March = 0
    var doy = Math.floor((153 * mp + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  var DIM = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

  // Strict "M/D/YYYY h:mm:ss AM|PM" -> epoch ms (naive, treated as UTC). NaN on failure.
  function parseDate(s) {
    var n = s.length, i = 0, c;
    function readInt(maxDigits) {
      var v = 0, k = 0;
      while (i < n) {
        c = s.charCodeAt(i);
        if (c < 48 || c > 57) break;
        v = v * 10 + (c - 48); i++; k++;
        if (k > maxDigits) return -1;
      }
      return k === 0 ? -1 : v;
    }
    var mo = readInt(2); if (mo < 1 || mo > 12 || s.charCodeAt(i++) !== 47) return NaN;
    var d = readInt(2);  if (d < 1 || s.charCodeAt(i++) !== 47) return NaN;
    var y = readInt(4);  if (y < 1 || s.charCodeAt(i++) !== 32) return NaN;
    if (d > DIM[mo - 1] || (mo === 2 && d === 29 && !isLeap(y))) return NaN;
    var h = readInt(2);  if (h < 1 || h > 12 || s.charCodeAt(i++) !== 58) return NaN;
    var mi = readInt(2); if (mi < 0 || mi > 59 || s.charCodeAt(i++) !== 58) return NaN;
    var se = readInt(2); if (se < 0 || se > 59 || s.charCodeAt(i++) !== 32) return NaN;
    var ap = s.charCodeAt(i++); var m2 = s.charCodeAt(i++);
    var pm;
    if ((ap === 65 || ap === 97) && (m2 === 77 || m2 === 109)) pm = false;        // AM
    else if ((ap === 80 || ap === 112) && (m2 === 77 || m2 === 109)) pm = true;   // PM
    else return NaN;
    if (i !== n) return NaN;
    var hh = (h % 12) + (pm ? 12 : 0);
    return daysFromCivil(y, mo, d) * 86400000 + (hh * 3600 + mi * 60 + se) * 1000;
  }

  /* ---------- numbers ---------- */

  function parseNum(s) {
    if (s === '' || NA_TOKENS[s] === true) return NaN;
    return Number(s);                       // Number('abc') === NaN, '' handled above
  }

  /* ---------- dictionary + growable columns ---------- */

  function Dict() { this.list = []; this.map = new Map(); }
  Dict.prototype.id = function (s) {
    var v = this.map.get(s);
    if (v === undefined) { v = this.list.length; this.list.push(s); this.map.set(s, v); }
    return v;
  };

  function Col(Type) { this.Type = Type; this.segs = []; this.cur = new Type(SEG); this.pos = 0; this.n = 0; }
  Col.prototype.push = function (v) {
    if (this.pos === SEG) { this.segs.push(this.cur); this.cur = new this.Type(SEG); this.pos = 0; }
    this.cur[this.pos++] = v; this.n++;
  };
  Col.prototype.finish = function () {
    var out = new this.Type(this.n), off = 0;
    for (var k = 0; k < this.segs.length; k++) { out.set(this.segs[k], off); off += SEG; }
    out.set(this.cur.subarray(0, this.pos), off);
    this.segs = []; this.cur = null;
    return out;
  };

  /* ---------- measurement detection for CSV files ----------
   * Returns a measurement key, or null when the header is a TestCase table whose kind
   * (Sensitivity vs MCBias) can only be told from the Units of the first row, or an
   * {error} object when the header fits nothing. */
  function detectMeasurement(fileName, header) {
    var has = {};
    header.forEach(function (h) { has[h] = true; });
    var m = /(?:^|[^a-z])(sensitivity|mcbiascurrent|mcbias|muxauxps|oscillation|scpre|noise|memscurrent|memssc|bte|coilpresent)(?:results)?(?=[^a-z]|$)/i.exec(fileName || '');
    if (m) {
      var tok = m[1].toLowerCase();
      for (var i = 0; i < MEASUREMENT_ORDER.length; i++) if (MEASUREMENT_ORDER[i].toLowerCase() === tok) return MEASUREMENT_ORDER[i];
    }
    if (has.Difference && has.Baseline) return 'Noise';
    if (has.NetName) return has.USL ? 'MuxAuxPS' : 'SCPre';
    if (has.TestedLine) return has.USL ? 'BTE' : 'MEMSSC';     // MEMSCurrent shares BTE's columns: only by file name
    if (has.TestCase) {
      if (has.Frequency || !has.LSL) return 'Oscillation';
      return null;                                   // Sensitivity or MCBias: decided by Units
    }
    return { error: 'Cannot tell which result table this file holds (no TestCase/Channel/Element, NetName or TestedLine columns)' };
  }
  function measurementFromUnits(units) {
    return /^db$/i.test(units) ? 'Sensitivity' : (/^[va]$/i.test(units) ? 'MCBias' : 'Sensitivity');
  }

  /* ---------- record sink: header + records -> dataset ----------
   * measurement may be null for a TestCase table until the first row reveals the units. */
  function RecordSink(measurement, meta) {
    this.measurement = measurement;
    this.spec = measurement ? MEASUREMENTS[measurement] : MEASUREMENTS.Sensitivity;
    this.keyKind = this.spec.keyKind;
    this.dicts = { coil: new Dict(), mode: new Dict(), chan: new Dict(), elem: new Dict(), net: new Dict(), sn: new Dict(), units: new Dict(), port: new Dict() };
    this.cols = {
      time: new Col(Float64Array), meas: new Col(Float64Array),
      lsl: new Col(Float64Array), usl: new Col(Float64Array),
      tc: new Col(Int32Array), coil: new Col(Int32Array), mode: new Col(Int32Array),
      chan: new Col(Int32Array), elem: new Col(Int32Array), net: new Col(Int32Array),
      sn: new Col(Int32Array), units: new Col(Int32Array), port: new Col(Int32Array),
      pf: new Col(Int8Array)                              // PassFail verdict of the row: 1 PASS, 0 FAIL, -1 none / NA
    };
    this.extras = [];                                   // [{ name, idx, col }] filled by setHeader
    this.stats = {
      fileName: meta.fileName || '', fileSize: meta.fileSize || 0, encoding: meta.encoding || '', table: meta.table || '',
      rowsRead: 0, rowsKept: 0,
      dropped: { badDate: 0, badMeasurement: 0, badTestCase: 0, nullKey: 0, excludedMode: 0, shortRow: 0 },
      tMin: Infinity, tMax: -Infinity
    };
    this.header = null; this.ci = null; this.maxIdx = 0; this.defaultUnitsId = -1;
  }
  /* Returns an error string or null. */
  RecordSink.prototype.setHeader = function (fields) {
    var header = fields.map(function (h) { return String(h).replace(/^﻿/, '').trim(); });
    var ci = {};
    for (var k = 0; k < header.length; k++) ci[header[k]] = k;
    var missing = this.spec.required.filter(function (r) { return ci[r] === undefined; });
    if (missing.length) return 'Missing required column(s): ' + missing.join(', ');
    this.header = header; this.ci = ci;
    var maxIdx = 0;
    this.spec.required.concat(OPTIONAL).forEach(function (c) { if (ci[c] !== undefined && ci[c] > maxIdx) maxIdx = ci[c]; });
    this.maxIdx = maxIdx;
    this.extras = (this.spec.extras || []).map(function (n) { return { name: n, idx: ci[n], col: new Col(Float64Array) }; });
    return null;
  };
  RecordSink.prototype.record = function (fields) {
    var ci = this.ci, stats = this.stats, dicts = this.dicts, cols = this.cols;
    stats.rowsRead++;
    if (fields.length <= this.maxIdx) { stats.dropped.shortRow++; return; }

    var coilName = fields[ci.CoilName].trim();
    var mode = fields[ci.Mode].trim();
    if (NA_TOKENS[coilName] === true || NA_TOKENS[mode] === true) { stats.dropped.nullKey++; return; }
    var chan = '', elem = '', net = '';
    if (this.keyKind === 'tc') {
      chan = fields[ci.Channel].trim(); elem = fields[ci.Element].trim();
      if (NA_TOKENS[chan] === true || NA_TOKENS[elem] === true) { stats.dropped.nullKey++; return; }
    } else {
      net = fields[ci[this.spec.keyColumn || 'NetName']].trim();
      if (NA_TOKENS[net] === true) { stats.dropped.nullKey++; return; }
    }
    if (EXCLUDED_MODES[mode] === true) { stats.dropped.excludedMode++; return; }

    var t = parseDate(fields[ci.TimeDate].trim());
    if (t !== t) { stats.dropped.badDate++; return; }
    var tcv = -1;
    if (this.keyKind === 'tc') {
      tcv = parseNum(fields[ci.TestCase].trim());
      if (tcv !== tcv) { stats.dropped.badTestCase++; return; }
      tcv = Math.trunc(tcv);
    }
    var meas = parseNum(fields[ci[this.spec.valueColumn || 'Measurement']].trim());
    if (meas !== meas) { stats.dropped.badMeasurement++; return; }
    var lsl = ci.LSL !== undefined ? parseNum(fields[ci.LSL].trim()) : NaN;
    var usl = ci.USL !== undefined ? parseNum(fields[ci.USL].trim()) : NaN;

    // units: the Units column, unless it is missing / NA / a PASS-FAIL token (SCPre exports swap
    // PassFail and Units in some rows), in which case try PassFail, then the schema default
    var units = ci.Units !== undefined ? fields[ci.Units].trim() : '';
    var pfRaw = ci.PassFail !== undefined ? fields[ci.PassFail].trim() : '';
    if (!isUnits(units) && ci.PassFail !== undefined) { var swap = units; units = pfRaw; pfRaw = swap; }
    if (!isUnits(units)) units = '';
    var pf = /^pass$/i.test(pfRaw) ? 1 : (/^fail$/i.test(pfRaw) ? 0 : -1);
    if (this.measurement === null) {               // Sensitivity vs MCBias decided by the first row
      this.measurement = measurementFromUnits(units);
      this.spec = MEASUREMENTS[this.measurement];
    }
    if (this.spec.fixedUnits) units = this.spec.fixedUnits;
    if (units === '') units = this.spec.defaultUnits;

    var snRaw = fields[ci.CoilSN].trim();
    var snId = (NA_TOKENS[snRaw] === true) ? -1 : dicts.sn.id(snRaw);
    var portId = -1;
    if (ci.Port !== undefined) { var portRaw = fields[ci.Port].trim(); if (NA_TOKENS[portRaw] !== true) portId = dicts.port.id(portRaw); }

    cols.time.push(t); cols.meas.push(meas); cols.lsl.push(lsl); cols.usl.push(usl);
    cols.tc.push(tcv);
    cols.coil.push(dicts.coil.id(coilName));
    cols.mode.push(dicts.mode.id(mode));
    cols.chan.push(this.keyKind === 'tc' ? dicts.chan.id(chan) : -1);
    cols.elem.push(this.keyKind === 'tc' ? dicts.elem.id(elem) : -1);
    cols.net.push(this.keyKind === 'net' ? dicts.net.id(net) : -1);
    cols.sn.push(snId);
    cols.units.push(dicts.units.id(units));
    cols.port.push(portId);
    cols.pf.push(pf);
    for (var x = 0; x < this.extras.length; x++) { var ex = this.extras[x]; ex.col.push(ex.idx === undefined ? NaN : parseNum(fields[ex.idx].trim())); }
    stats.rowsKept++;
    if (t < stats.tMin) stats.tMin = t;
    if (t > stats.tMax) stats.tMax = t;
  };
  function isUnits(s) { return s !== '' && NA_TOKENS[s] !== true && !/^(pass|fail)$/i.test(s); }
  /* Returns { message, transfer } ready for post(). */
  RecordSink.prototype.finish = function () {
    var columns = {}, transfer = [], cols = this.cols, dicts = this.dicts, stats = this.stats;
    for (var k in cols) { columns[k] = cols[k].finish(); transfer.push(columns[k].buffer); }
    columns.extras = {};
    this.extras.forEach(function (ex) { columns.extras[ex.name] = ex.col.finish(); transfer.push(columns.extras[ex.name].buffer); });
    var dictLists = {};
    for (var d in dicts) dictLists[d] = dicts[d].list;
    if (stats.rowsKept === 0) { stats.tMin = NaN; stats.tMax = NaN; }
    var measurement = this.measurement || 'Sensitivity';
    return { message: { type: 'dataset', measurement: measurement, keyKind: MEASUREMENTS[measurement].keyKind,
                        n: stats.rowsKept, columns: columns, dicts: dictLists, stats: stats }, transfer: transfer };
  };

  /* ---------- CSV scanner ----------
   * Scans `text` from 0, calling onRecord(fields) for every complete record.
   * Returns the index just past the last complete record (the rest is carry).
   * Handles quoted fields, "" escapes, commas inside quotes, CRLF, LF.
   */
  function scan(text, onRecord) {
    var n = text.length, i = 0, lastComplete = 0;
    var fields = [], fieldStart = 0, inQuotes = false, quoted = false, hasEscape = false;
    var c;
    while (i < n) {
      c = text.charCodeAt(i);
      if (inQuotes) {
        if (c === 34) {                                   // "
          if (i + 1 < n && text.charCodeAt(i + 1) === 34) { hasEscape = true; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        i++; continue;
      }
      if (c === 34) {                                     // opening quote at field start
        if (i === fieldStart) { inQuotes = true; quoted = true; }
        i++; continue;
      }
      if (c === 44 || c === 10 || c === 13) {             // , \n \r
        var end = i;
        var f;
        if (quoted) {
          f = text.substring(fieldStart + 1, end - 1 >= fieldStart + 1 ? end - 1 : fieldStart + 1);
          if (hasEscape) f = f.replace(/""/g, '"');
        } else {
          f = text.substring(fieldStart, end);
        }
        fields.push(f);
        quoted = false; hasEscape = false;
        if (c === 44) { i++; fieldStart = i; continue; }
        // record end
        if (c === 13 && i + 1 < n && text.charCodeAt(i + 1) === 10) i++;
        i++;
        if (c === 13 && i >= n && text.charCodeAt(n - 1) === 13) {
          // lone \r at the very end of the chunk: cannot know if \n follows; treat as incomplete
          fields = []; fieldStart = lastComplete; quoted = false; hasEscape = false;
          return lastComplete;
        }
        if (!(fields.length === 1 && fields[0] === '')) onRecord(fields);
        fields = []; fieldStart = i; lastComplete = i;
        continue;
      }
      i++;
    }
    return lastComplete;
  }

  /* ---------- CSV file parser ----------
   * parseFile(file, post, opts) reads a File/Blob in chunks and calls post(msg[, transfer]).
   * Messages: {type:'progress', bytesDone, bytesTotal, rowsRead, rowsKept, table}
   *           {type:'detected', measurement}
   *           {type:'error', message}
   *           {type:'dataset', measurement, keyKind, n, columns:{...}, dicts:{...}, stats:{...}}
   *           {type:'done'}
   * opts: { chunkSize, yieldFn, fileName, measurement (force) }
   */
  function parseFile(file, post, opts) {
    opts = opts || {};
    var chunkSize = opts.chunkSize || CHUNK;
    var yieldFn = opts.yieldFn || null;           // main-thread fallback: await between chunks
    var total = file.size;
    var fileName = opts.fileName || file.name || '';

    return attempt('utf-8', true).then(function (res) {
      if (res && res.encodingError) return attempt('windows-1252', false);
      return res;
    });

    function attempt(encoding, fatal) {
      var decoder;
      try { decoder = new TextDecoder(encoding, { fatal: fatal }); }
      catch (e) { decoder = new TextDecoder('utf-8'); encoding = 'utf-8 (fallback)'; }

      var sink = null, headerError = null, detectedPosted = false;
      var carry = '';
      var off = 0;
      var lastProgress = 0;
      /* A CSV may bundle several tables (what tools/export_mdb.ps1 and tools/atml_to_mdb.ps1 write as
       * <machine>.csv): each table starts with a "#table=<TableName>" line followed by its own header row.
       * A second header row without a marker also starts a new table (detected from its columns). */
      var bundle = false, sectionTable = null, skipSection = false, datasets = 0;

      function measurementForTable(name) {
        for (var i = 0; i < MEASUREMENT_ORDER.length; i++) if (MEASUREMENTS[MEASUREMENT_ORDER[i]].table.toLowerCase() === name.toLowerCase()) return MEASUREMENT_ORDER[i];
        return null;
      }
      function looksLikeHeader(fields) {
        var has = {}; fields.forEach(function (h) { has[h.replace(/^﻿/, '').trim()] = true; });
        return !!(has.CoilName && has.TimeDate);
      }
      function closeSection() {
        if (sink !== null && !skipSection && !headerError) {
          var out = sink.finish();
          if (out.message.n > 0 || !bundle) { post(out.message, out.transfer); datasets++; }
          else if (sink.measurement) post({ type: 'tablesEmpty', measurements: [sink.measurement] });
        }
        sink = null; headerError = null; detectedPosted = false; skipSection = false;
      }
      function onRecord(fields) {
        var f0 = (fields[0] || '').replace(/^﻿/, '').trim();
        if (fields.length <= 2 && (/^#table=/i.test(f0) || /^\[[A-Za-z0-9_ ]+\]$/.test(f0))) {   // section marker
          closeSection();
          bundle = true; sectionTable = f0.replace(/^#table=/i, '').replace(/^\[|\]$/g, '').trim();
          return;
        }
        if (sink === null) {
          if (skipSection) return;
          var header = fields.map(function (h) { return h.replace(/^﻿/, '').trim(); });
          var meas;
          if (sectionTable) {
            meas = measurementForTable(sectionTable);
            if (!meas) { skipSection = true; post({ type: 'tableSkipped', table: sectionTable }); return; }   // SourceFiles, IdentifyCoil, ...
          } else {
            meas = opts.measurement || detectMeasurement(fileName, header);
          }
          if (meas && meas.error) { headerError = meas.error; sink = new RecordSink('Sensitivity', {}); return; }
          sink = new RecordSink(meas, { fileName: fileName, fileSize: total, encoding: encoding, table: meas ? MEASUREMENTS[meas].table : '' });
          headerError = sink.setHeader(header);
          if (headerError && sectionTable) {        // a bad section does not spoil the rest of a bundle
            post({ type: 'tableError', measurement: meas, table: sectionTable, message: headerError });
            sink = null; headerError = null; skipSection = true;
          }
          return;
        }
        if (headerError) return;
        if (sink.stats.rowsRead > 0 && looksLikeHeader(fields)) {   // a new header row: next table of a bundle
          closeSection(); bundle = true; sectionTable = null;
          onRecord(fields);
          return;
        }
        sink.record(fields);
        if (!detectedPosted && sink.measurement) {
          detectedPosted = true;
          sink.stats.table = MEASUREMENTS[sink.measurement].table;
          post({ type: 'detected', measurement: sink.measurement });
        }
      }

      function step() {
        if (off >= total) return finish();
        var end = Math.min(off + chunkSize, total);
        return file.slice(off, end).arrayBuffer().then(function (buf) {
          var decoded;
          try { decoded = decoder.decode(buf, { stream: true }); }
          catch (e) { return { encodingError: true }; }
          var text = carry.length ? carry + decoded : decoded;
          var consumed = scan(text, onRecord);
          carry = text.substring(consumed);
          off = end;
          if (headerError) { post({ type: 'error', message: headerError }); return { error: headerError }; }
          var now = Date.now();
          if (now - lastProgress > 80 || off >= total) {
            lastProgress = now;
            post({ type: 'progress', bytesDone: off, bytesTotal: total, rowsRead: sink ? sink.stats.rowsRead : 0, rowsKept: sink ? sink.stats.rowsKept : 0,
                   table: sink && sink.measurement ? MEASUREMENTS[sink.measurement].table : '' });
          }
          if (yieldFn) return yieldFn().then(step);
          return step();
        });
      }

      function finish() {
        var tail;
        try { tail = decoder.decode(); } catch (e) { return { encodingError: true }; }
        var text = carry + tail;
        if (text.length) {
          if (!/\n$/.test(text)) text += '\n';
          scan(text, onRecord);
        }
        if (headerError) { post({ type: 'error', message: headerError }); return { error: headerError }; }
        if (sink === null && !bundle) { post({ type: 'error', message: 'Empty file' }); return { error: 'Empty file' }; }
        closeSection();
        if (bundle && datasets === 0) { post({ type: 'error', message: 'No result tables with data found in ' + fileName }); return { error: 'empty bundle' }; }
        post({ type: 'done' });
        return { done: true };
      }

      return step();
    }
  }

  /* ---------- Access database parser ----------
   * parseMdb(file, post, opts) reads every known result table from a .mdb and posts one
   * 'dataset' message per table (Sensitivity first), then 'done'. Tables with an unexpected
   * layout post {type:'tableError', measurement, table, message} and are skipped.
   * opts: { jet: cateJetCore() instance (required), yieldFn, tables: [measurement keys] }
   */
  function parseMdb(file, post, opts) {
    opts = opts || {};
    var jet = opts.jet;
    if (!jet) return Promise.reject(new Error('parseMdb needs opts.jet'));
    var fileName = opts.fileName || file.name || '';
    var src = jet.fileSource(file);
    var wanted = opts.tables || MEASUREMENT_ORDER;
    var lastProgress = 0;
    return jet.open(src).then(function (db) {
      var present = wanted.filter(function (k) { return db.tables.has(MEASUREMENTS[k].table); });
      if (!present.length) {
        var msg = 'No result tables found in ' + fileName + ' (expected ' + MEASUREMENT_ORDER.map(function (k) { return MEASUREMENTS[k].table; }).join(', ') + '; found ' +
                  db.tableNames().filter(function (n) { return !/^MSys/.test(n); }).join(', ') + ')';
        post({ type: 'error', message: msg });
        return { error: msg };
      }
      // table definitions + page counts first so progress can be reported in bytes
      var plan = [], skipped = [];
      var chain = Promise.resolve();
      present.forEach(function (k) {
        chain = chain.then(function () { return db.table(MEASUREMENTS[k].table); })
          .then(function (tdef) {
            if (!tdef.numRows) { skipped.push(k); return; }          // empty table: no dataset, stays "(no data)"
            return db.pagesOf(tdef).then(function (pages) { plan.push({ key: k, tdef: tdef, pages: pages.length }); });
          });
      });
      return chain.then(function () {
        var totalPages = plan.reduce(function (a, p) { return a + p.pages; }, 0);
        var bytesTotal = totalPages * jet.PG, pagesBefore = 0;
        var idx = 0;
        if (skipped.length) post({ type: 'tablesEmpty', measurements: skipped });
        if (!plan.length) { post({ type: 'error', message: 'Every result table in ' + fileName + ' is empty' }); return { error: 'empty' }; }
        function nextTable() {
          if (idx >= plan.length) { post({ type: 'done' }); return { done: true }; }
          var p = plan[idx++], spec = MEASUREMENTS[p.key];
          var names = p.tdef.cols.map(function (c) { return c.name; });
          var sink = new RecordSink(p.key, { fileName: fileName, fileSize: file.size, encoding: 'mdb', table: spec.table });
          var err = sink.setHeader(names);
          if (err) { post({ type: 'tableError', measurement: p.key, table: spec.table, message: err }); pagesBefore += p.pages; return nextTable(); }
          post({ type: 'progress', bytesDone: pagesBefore * jet.PG, bytesTotal: bytesTotal, rowsRead: 0, rowsKept: 0, table: spec.table, measurement: p.key });
          var fields = new Array(names.length);
          return db.scan(p.tdef, names, function (f) {
            for (var i = 0; i < f.length; i++) fields[i] = f[i] === null ? '' : f[i];
            sink.record(fields);
          }, {
            batchPages: opts.batchPages || 1024,
            yieldFn: opts.yieldFn || null,
            onProgress: function (done) {
              var now = Date.now();
              if (now - lastProgress > 80 || done === p.pages) {
                lastProgress = now;
                post({ type: 'progress', bytesDone: (pagesBefore + done) * jet.PG, bytesTotal: bytesTotal,
                       rowsRead: sink.stats.rowsRead, rowsKept: sink.stats.rowsKept, table: spec.table, measurement: p.key });
              }
            }
          }).then(function (scanStats) {
            pagesBefore += p.pages;
            sink.stats.scan = scanStats;
            if (!sink.stats.rowsKept) { post({ type: 'tablesEmpty', measurements: [p.key], dropped: sink.stats.dropped }); return nextTable(); }
            var out = sink.finish();
            post(out.message, out.transfer);
            return nextTable();
          });
        }
        return nextTable();
      });
    });
  }

  return { parseFile: parseFile, parseMdb: parseMdb, parseDate: parseDate, parseNum: parseNum, scan: scan, daysFromCivil: daysFromCivil,
           detectMeasurement: detectMeasurement, RecordSink: RecordSink, MEASUREMENTS: MEASUREMENTS, MEASUREMENT_ORDER: MEASUREMENT_ORDER };
}

if (typeof module !== 'undefined' && module.exports) module.exports = cateParseCore;

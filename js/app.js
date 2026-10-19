/* app.js - UI wiring: file slots, date range, generate, viewer (single + library), downloads. */
(function () {
  'use strict';
  var T = CATE.ticks, model = CATE.model, chart = CATE.chart;
  var loader = new CATE.Loader(model);
  var $ = function (id) { return document.getElementById(id); };
  var STORAGE_KEY = 'cateDashboard.settings.v1';

  var state = {
    pinnedSlots: {},          // machines whose per-table details stay open in the file list
    coverageMachine: null,    // machine selected in the overview's Data coverage table (filters Charts by coil)
    settings: loadSettings(),
    build: null,                 // result of model.build
    selectedCoil: null,          // coil name
    viewMode: 'single',
    filters: { machine: '', mode: '', tc: '', net: '', port: '' },     // machine = '' (all) or 'CATE1001' etc.
    filtered: [],                // groups after filters
    index: 0,
    currentKey: null,            // group key of the open chart
    specCache: new Map(),        // key -> spec (for the selected coil, current build)
    renderInfo: null,
    rangeAuto: true,             // range follows loaded data until the user edits it
    zipCancel: false
  };

  /* ---------------- settings ---------------- */
  function loadSettings() {
    var s = { start: CATE.DEFAULTS.start, end: CATE.DEFAULTS.end,
              overrides: CATE.DEFAULTS.overrides.map(function (o) { return { coil: o.coil, start: o.start, end: o.end }; }),
              outlierMode: CATE.OUTLIER_DEFAULTS.mode, outlierK: CATE.OUTLIER_DEFAULTS.k, stats: true, statsOutliers: true,
              measurement: 'Sensitivity' };
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && p.start && p.end) {
          s.start = p.start; s.end = p.end;
          s.overrides = Array.isArray(p.overrides) ? p.overrides : [];
          if (['flag', 'exclude', 'off'].indexOf(p.outlierMode) >= 0) s.outlierMode = p.outlierMode;
          if (isFinite(+p.outlierK) && +p.outlierK >= 1 && +p.outlierK <= 20) s.outlierK = +p.outlierK;
          if (typeof p.stats === 'boolean') s.stats = p.stats;
          if (typeof p.statsOutliers === 'boolean') s.statsOutliers = p.statsOutliers;
          if (CATE.MEASUREMENTS[p.measurement]) s.measurement = p.measurement;
        }
      }
    } catch (e) { /* ignore */ }
    return s;
  }
  function saveSettings() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ } }

  function resolvedSettings() {
    var s = state.settings;
    var start = T.parseIsoDate(s.start), end = T.parseIsoDate(s.end);
    if (isNaN(start) || isNaN(end)) return { error: 'Enter a valid start and end date.' };
    if (end < start) return { error: 'End date is before start date.' };
    var overrides = [];
    for (var i = 0; i < s.overrides.length; i++) {
      var o = s.overrides[i];
      var os = T.parseIsoDate(o.start);
      var oe = (!o.end || String(o.end).toLowerCase() === 'today') ? T.todayUtc() : T.parseIsoDate(o.end);
      if (isNaN(os) || isNaN(oe)) return { error: 'Override for "' + o.coil + '" has an invalid date.' };
      if (oe < os) return { error: 'Override for "' + o.coil + '" ends before it starts.' };
      overrides.push({ coil: o.coil, start: os, end: oe });
    }
    return { start: start, end: end, overrides: overrides };
  }

  /* ---------------- helpers ---------------- */
  function fmtBytes(b) { if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB'; if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'; if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB'; return b + ' B'; }
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  var debounceTimers = {};
  function debounce(key, fn, ms) { clearTimeout(debounceTimers[key]); debounceTimers[key] = setTimeout(fn, ms); }

  /* ---------------- file slots UI ---------------- */
  function renderFileTable() {
    var tb = $('fileTable').querySelector('tbody');
    tb.innerHTML = '';
    loader.slots.forEach(function (s) {
      var st = CATE.MACHINE_STYLE[s.name];
      var tr = el('tr');
      tr.appendChild(el('td', { class: 'mname' }, [el('span', { class: 'swatch', style: 'background:' + st.color }), s.name]));
      var fileCell = el('td');
      var rowsCell = el('td');
      var clearCell = el('td');
      if (s.status === 'empty') {
        fileCell.appendChild(el('div', { class: 'status', text: 'not loaded' }));
      } else {
        var names = {}; Object.keys(s.datasets).forEach(function (k) { names[s.datasets[k].fileName] = true; });
        if (s.file && !names[s.file.name]) names[s.file.name] = true;
        var fnames = Object.keys(names).join(', ');
        fileCell.appendChild(el('div', { class: 'fname', title: fnames, text: fnames }));
        if (s.status === 'parsing') {
          var pct = Math.round(s.progress * 100);
          var elapsed = (Date.now() - s.startedAt) / 1000;
          var rate = elapsed > 0.3 ? s.bytesDone / elapsed : 0;
          var eta = rate > 0 ? Math.max(0, (s.bytesTotal - s.bytesDone) / rate) : 0;
          fileCell.appendChild(el('div', { class: 'bar' }, [el('div', { class: 'fill', style: 'width:' + pct + '%' })]));
          fileCell.appendChild(el('div', { class: 'status', text: 'parsing ' + (s.currentTable ? s.currentTable + ' ' : '') + pct + '%' + (rate ? ' · ' + fmtBytes(rate) + '/s · ' + Math.ceil(eta) + 's left' : '') }));
        } else if (s.status === 'indexing') {
          fileCell.appendChild(el('div', { class: 'bar' }, [el('div', { class: 'fill', style: 'width:100%' })]));
          fileCell.appendChild(el('div', { class: 'status', text: 'indexing' + (s.currentTable ? ' ' + s.currentTable : '') + '…' }));
        } else if (s.status === 'error') {
          fileCell.appendChild(el('div', { class: 'status err', text: s.error }));
        }
        // one line per loaded measurement, folded away until the row is hovered (or clicked to pin)
        var keys = CATE.MEASUREMENT_ORDER.filter(function (k) { return !!s.datasets[k]; });
        var details = el('div', { class: 'details' });
        var tMin = Infinity, tMax = -Infinity;
        keys.forEach(function (k) { var q = s.datasets[k].stats; if (!isNaN(q.tMin)) { tMin = Math.min(tMin, q.tMin); tMax = Math.max(tMax, q.tMax); } });
        if (keys.length) {
          var sum = keys.length + (keys.length === 1 ? ' table' : ' tables') + (tMin < Infinity ? ' · ' + T.formatDate(tMin) + ' – ' + T.formatDate(tMax) : '');
          fileCell.appendChild(el('div', { class: 'status summary', text: sum, title: 'Hover for the per-table details, click to keep them open' }));
        }
        keys.forEach(function (k) {
          var d = s.datasets[k], st2 = d.stats;
          var dropped = 0; Object.keys(st2.dropped).forEach(function (q) { dropped += st2.dropped[q]; });
          var txt = CATE.MEASUREMENTS[k].label + ': ' + fmtInt(d.rowsKept) + ' rows';
          if (!isNaN(st2.tMin)) txt += ' · ' + T.formatDate(st2.tMin) + ' – ' + T.formatDate(st2.tMax);
          if (dropped) txt += ' · ' + fmtInt(dropped) + ' dropped';
          var line = el('div', { class: 'status' + (k === state.settings.measurement ? ' current' : ''), title: (dropped ? 'Dropped: ' + JSON.stringify(st2.dropped) + ' · ' : '') + 'encoding ' + st2.encoding, text: txt });
          details.appendChild(line);
        });
        if (s.status === 'done' && s.file) details.appendChild(el('div', { class: 'status', text: fmtBytes(s.file.size) + (s.kind === 'mdb' ? ' · Access database' : '') }));
        if (details.childNodes.length) fileCell.appendChild(details);
        (s.tableErrors || []).forEach(function (te) { fileCell.appendChild(el('div', { class: 'status err', text: (te.table || te.measurement) + ': ' + te.message })); });
        if (s.queue && s.queue.length) fileCell.appendChild(el('div', { class: 'status', text: s.queue.length + ' more file' + (s.queue.length === 1 ? '' : 's') + ' queued' }));
      }
      rowsCell.textContent = s.status === 'empty' ? '' : fmtInt(s.rowsKept);
      if (s.status !== 'empty') clearCell.appendChild(el('button', { class: 'clear', title: 'Remove this file', text: '✕', onclick: function () { loader.clear(s.index); } }));
      tr.appendChild(fileCell); tr.appendChild(rowsCell); tr.appendChild(clearCell);
      if (state.pinnedSlots[s.name]) tr.className = 'pinned';
      tr.onclick = function (ev) { if (ev.target.tagName === 'BUTTON') return; state.pinnedSlots[s.name] = !state.pinnedSlots[s.name]; tr.classList.toggle('pinned', !!state.pinnedSlots[s.name]); };
      tb.appendChild(tr);
    });
  }

  function renderGlobalProgress() {
    var busy = loader.slots.filter(function (s) { return s.status === 'parsing' || s.status === 'indexing'; });
    var gp = $('globalProgress');
    if (!busy.length) { gp.hidden = true; return; }
    gp.hidden = false;
    var done = 0, total = 0;
    busy.forEach(function (s) { done += s.bytesDone; total += s.bytesTotal; });
    var loadedSlots = loader.slots.filter(function (s) { return s.status !== 'empty'; }).length;
    $('globalProgressFill').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    $('globalProgressLabel').textContent = 'Processing ' + busy.length + ' of ' + loadedSlots + ' file' + (loadedSlots === 1 ? '' : 's') + ' (' + busy.map(function (s) { return s.name; }).join(', ') + ')';
  }

  function renderStatus() {
    var loaded = loader.slots.filter(function (s) { return s.status === 'done'; });
    var busy = loader.isBusy();
    var txt;
    if (!loaded.length && !busy) txt = 'No data loaded. Drop CSV or MDB files to begin.';
    else {
      var rows = 0; loaded.forEach(function (s) { rows += s.rowsKept; });
      txt = loaded.length + ' machine' + (loaded.length === 1 ? '' : 's') + ' loaded · ' + fmtInt(rows) + ' rows';
      if (state.build) txt += ' · ' + fmtInt(state.build.totalCharts) + ' charts';
      if (busy) txt += ' · loading more…';
    }
    $('globalStatus').textContent = txt;
  }

  loader.on('slot', function () { renderFileTable(); renderGlobalProgress(); renderStatus(); renderPartialBanner(); });
  loader.on('dataChanged', function () {
    renderFileTable(); renderGlobalProgress();
    $('generateBtn').disabled = !model.hasData();
    $('coilSearch').disabled = !model.hasData();
    updateCoilDatalist();
    populateMeasurementSelect();
    // Follow the data with "last 7 days" until the user edits the range by hand.
    if (state.rangeAuto && model.hasData()) applyPreset('last7', true);
    debounce('gen', generate, 250);
  });

  /* ---------------- drag & drop ---------------- */
  var dz = $('dropZone');
  ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); }); });
  dz.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) { e.preventDefault(); if (e.target !== dz && !dz.contains(e.target)) handleFiles(e.dataTransfer.files); });
  $('fileInput').addEventListener('change', function (e) { handleFiles(e.target.files); e.target.value = ''; });
  function handleFiles(files) {
    var r = loader.addFiles(files);
    $('ignoredFiles').textContent = r.ignored.length ? 'Ignored (not a .csv/.mdb, or no machine name CATE1001/1003/1006/1007, EVO1001/1002 or NATE1001 in the file name): ' + r.ignored.join(', ') : '';
  }

  /* ---------------- date range UI ---------------- */
  function syncRangeInputs() {
    $('startDate').value = state.settings.start;
    $('endDate').value = state.settings.end;
    renderOverrides();
  }
  $('startDate').addEventListener('change', function () { state.rangeAuto = false; state.settings.start = this.value; saveSettings(); debounce('gen', generate, 150); });
  $('endDate').addEventListener('change', function () { state.rangeAuto = false; state.settings.end = this.value; saveSettings(); debounce('gen', generate, 150); });
  document.querySelectorAll('[data-preset]').forEach(function (b) { b.addEventListener('click', function () { state.rangeAuto = false; applyPreset(b.getAttribute('data-preset'), false); }); });

  function dataExtent() {
    var ext = model.extent(state.settings.measurement) || model.extent();
    if (!ext) return null;
    return { min: Math.floor(ext.tMin / T.DAY) * T.DAY, max: Math.floor(ext.tMax / T.DAY) * T.DAY };
  }

  /* ---------------- measurement select ---------------- */
  function populateMeasurementSelect() {
    var sel = $('fMeasure'), cur = state.settings.measurement;
    // The remembered measurement may not exist in the data now loaded (e.g. Noise remembered from an EVO
    // database, then Sensitivity-only CSVs dropped): fall back to the first measurement that has data.
    if (!model.hasData(cur) && model.hasData()) {
      var avail = CATE.MEASUREMENT_ORDER.filter(function (k) { return model.hasData(k); });
      cur = state.settings.measurement = avail[0]; saveSettings();
      state.specCache = new Map();
      state.filters = { machine: state.filters.machine, mode: '', tc: '', net: '', port: '' };
    }
    sel.innerHTML = '';
    var open = !$('viewer').hidden ? state.selectedCoil : null;
    CATE.MEASUREMENT_ORDER.forEach(function (k) {
      var has = model.hasData(k);
      var forCoil = has && open && k !== cur && !coilHasMeasurement(open, k);
      var o = el('option', { value: k, text: CATE.MEASUREMENTS[k].label + (has ? (forCoil ? ' (none for this coil)' : '') : ' (no data)') });
      if (!has && k !== cur) o.disabled = true;
      sel.appendChild(o);
    });
    sel.value = cur;
  }
  /* Does this coil have any rows (in any machine, any date) for the measurement? */
  function coilHasMeasurement(name, k) {
    var list = model.coilList(k);
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return true;
    return false;
  }
  /* Why the open coil cannot be shown for measurement k: null when it can, otherwise a message. */
  function coilMeasurementProblem(name, k) {
    var label = CATE.MEASUREMENTS[k].label;
    var list = model.coilList(k), entry = null;
    for (var i = 0; i < list.length; i++) if (list[i].name === name) { entry = list[i]; break; }
    if (!entry) return name + ' has no ' + label + ' data in the loaded files.';
    var rs = resolvedSettings(); if (rs.error) return null;
    if (model.buildCoil(entry, rs, k).groups.length) return null;
    var mn = Infinity, mx = -Infinity;
    model.datasetsFor(k).forEach(function (e) {
      var rows = e.ds.rowsByCoil[entry.id]; if (!rows) return;
      for (var j = 0; j < rows.length; j++) { var t = e.ds.time[rows[j]]; if (t < mn) mn = t; if (t > mx) mx = t; }
    });
    return name + ' has no ' + label + ' rows between ' + state.settings.start + ' and ' + state.settings.end + ' (its ' + label + ' data spans ' + T.formatDate(mn) + ' – ' + T.formatDate(mx) + '). Widen the date range on the left to see them.';
  }
  var measureNoteTimer = null;
  function showMeasureNote(msg) {
    var b = $('measureNote');
    b.textContent = msg; b.hidden = !msg;
    if (measureNoteTimer) clearTimeout(measureNoteTimer);
    if (msg) measureNoteTimer = setTimeout(function () { b.hidden = true; }, 8000);
  }
  $('fMeasure').addEventListener('change', function () {
    var k = $('fMeasure').value;
    if (!CATE.MEASUREMENTS[k]) return;
    var prev = state.settings.measurement;
    if (k !== prev && state.selectedCoil && !$('viewer').hidden) {
      // stay on the coil: a measurement this coil has nothing for would otherwise drop it from the build and fall back to the overview
      var problem = coilMeasurementProblem(state.selectedCoil, k);
      if (problem) { $('fMeasure').value = prev; showMeasureNote(problem); return; }
    }
    showMeasureNote('');
    state.settings.measurement = k; saveSettings();
    state.specCache = new Map();
    state.filters = { machine: state.filters.machine, mode: '', tc: '', net: '', port: '' };
    if (state.rangeAuto && model.hasData(k)) applyPreset('last7', true);
    generate();
  });
  function applyPreset(name, silent) {
    var ext = dataExtent();
    if (!ext) { if (!silent) showRangeError('Load data first.'); return; }
    var end = ext.max, start;
    if (name === 'last7') start = end - 6 * T.DAY;
    else if (name === 'last30') start = end - 29 * T.DAY;
    else if (name === 'ytd') { var d = new Date(end); start = Date.UTC(d.getUTCFullYear(), 0, 1); }
    else start = ext.min;
    state.settings.start = T.isoDate(start); state.settings.end = T.isoDate(end);
    saveSettings(); syncRangeInputs(); debounce('gen', generate, 50);
  }
  function showRangeError(msg) { var e = $('rangeError'); e.hidden = !msg; e.textContent = msg || ''; }

  function renderOverrides() {
    var tb = $('overrideTable').querySelector('tbody');
    tb.innerHTML = '';
    state.settings.overrides.forEach(function (o, i) {
      tb.appendChild(el('tr', null, [
        el('td', { text: o.coil, title: o.coil }),
        el('td', { text: o.start + ' → ' + (o.end || 'today') }),
        el('td', null, [el('button', { class: 'clear', title: 'Remove', text: '✕', onclick: function () { state.settings.overrides.splice(i, 1); saveSettings(); renderOverrides(); debounce('gen', generate, 50); } })])
      ]));
    });
    $('overrideCount').textContent = state.settings.overrides.length;
  }
  $('ovAdd').addEventListener('click', function () {
    var coil = $('ovCoil').value.trim(), start = $('ovStart').value, end = $('ovEnd').value;
    if (!coil) { showRangeError('Override needs a coil: pick one from the list (load CSV files first).'); return; }
    if (!start) { showRangeError('Override needs a start date.'); return; }
    showRangeError('');
    state.settings.overrides = state.settings.overrides.filter(function (o) { return o.coil !== coil; });
    state.settings.overrides.push({ coil: coil, start: start, end: end || 'today' });
    saveSettings(); renderOverrides(); $('ovCoil').value = ''; $('ovStart').value = ''; $('ovEnd').value = '';
    $('overridesBox').open = true;
    debounce('gen', generate, 50);
  });
  /* Rebuild the override coil <select> from every coil present in the loaded data (keeps the current pick). */
  function updateCoilDatalist() {
    var sel = $('ovCoil'), prev = sel.value, coils = model.hasData() ? model.coilList() : [];
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '', text: coils.length ? 'Select a coil…' : 'Load CSV files to list coils' }));
    coils.forEach(function (c) { sel.appendChild(el('option', { value: c.name, text: c.name })); });
    sel.disabled = !coils.length;
    if (prev && coils.some(function (c) { return c.name === prev; })) sel.value = prev;
  }

  /* ---------------- generate ---------------- */
  $('generateBtn').addEventListener('click', generate);
  function generate() {
    if (!model.hasData()) { state.build = null; renderCoilList(); renderSummary(); renderStatus(); return; }
    var rs = resolvedSettings();
    if (rs.error) { showRangeError(rs.error); return; }
    showRangeError('');
    state.build = model.build(rs, state.settings.measurement);
    state.specCache = new Map();
    renderFileTable();
    renderCoilList();
    renderSummary();
    renderStatus();
    if (state.selectedCoil) openCoil(state.selectedCoil, true);
  }

  $('coilSearch').addEventListener('input', renderCoilList);
  function renderCoilList() {
    var ul = $('coilList'); ul.innerHTML = '';
    if (!state.build) { $('coilSummary').textContent = ''; return; }
    var q = $('coilSearch').value.trim().toLowerCase();
    var withCharts = 0;
    state.build.coils.forEach(function (c) {
      if (c.groups.length) withCharts++;
      if (q && c.name.toLowerCase().indexOf(q) < 0) return;
      var li = el('li', { class: (c.groups.length ? '' : 'empty ') + (c.name === state.selectedCoil ? 'active' : ''), title: c.name + (c.override ? ' (custom range)' : '') });
      li.appendChild(el('span', { class: 'cname', text: c.name }));
      li.appendChild(el('span', { class: 'count' + (c.override ? ' ov' : ''), text: c.groups.length ? c.groups.length + ' charts' + (c.override ? ' •' : '') : 'no rows in range' }));
      if (c.groups.length) li.addEventListener('click', function () { openCoil(c.name, false); });
      ul.appendChild(li);
    });
    $('coilSummary').textContent = withCharts + ' of ' + state.build.coils.length + ' coils have data in range · ' + fmtInt(state.build.totalCharts) + ' charts';
  }

  /* ---------------- summary view ---------------- */
  function renderSummary() {
    var cov = $('coverage'); cov.innerHTML = '';
    cov.appendChild(el('h3', { text: 'Data coverage' }));
    var tbl = el('table');
    tbl.appendChild(el('thead', null, [el('tr', null, [el('th', { text: 'Machine' }), el('th', { text: 'File' }), el('th', { text: 'Tables loaded' }), el('th', { class: 'num', text: 'Rows kept' }), el('th', { class: 'num', text: 'Dropped' }), el('th', { text: 'First date' }), el('th', { text: 'Last date' })])]));
    var tb = el('tbody');
    loader.slots.forEach(function (s) {
      var keys = CATE.MEASUREMENT_ORDER.filter(function (k) { return !!s.datasets[k]; });
      var dropped = 0, rows = 0, tMin = Infinity, tMax = -Infinity, dropDetail = {};
      keys.forEach(function (k) {
        var st = s.datasets[k].stats; rows += s.datasets[k].rowsKept; dropDetail[k] = st.dropped;
        Object.keys(st.dropped).forEach(function (q) { dropped += st.dropped[q]; });
        if (!isNaN(st.tMin)) { tMin = Math.min(tMin, st.tMin); tMax = Math.max(tMax, st.tMax); }
      });
      var fnames = {}; keys.forEach(function (k) { fnames[s.datasets[k].fileName] = true; }); if (s.file) fnames[s.file.name] = true;
      var selected = state.coverageMachine === s.name;
      var row = el('tr', { class: (keys.length ? 'selectable' : '') + (selected ? ' selected' : ''), title: keys.length ? (selected ? 'Click to show every machine again' : 'Click to list only the coils this machine has data for') : '' }, [
        el('td', { text: s.name }),
        el('td', { text: Object.keys(fnames).join(', ') || '—', class: s.status === 'done' ? '' : 'muted' }),
        tablesCell(s, keys, selected),
        el('td', { class: 'num', text: keys.length ? fmtInt(rows) : (s.status === 'empty' ? '' : s.status) }),
        el('td', { class: 'num', text: keys.length ? fmtInt(dropped) : '', title: keys.length ? JSON.stringify(dropDetail) : '' }),
        el('td', { text: tMin !== Infinity ? T.formatDate(tMin) : '' }),
        el('td', { text: tMax !== -Infinity ? T.formatDate(tMax) : '' })
      ]);
      if (keys.length) row.onclick = function () { state.coverageMachine = selected ? null : s.name; renderSummary(); };
      tb.appendChild(row);
    });
    tbl.appendChild(tb); cov.appendChild(tbl);
    // "Tables loaded": one chip per data type; the chip of the measurement shown below is outlined, and
    // filled when its machine is the selected one. Clicking a chip selects that machine and data type.
    function tablesCell(s, keys, selected) {
      var td = el('td');
      keys.forEach(function (k) {
        var cur = state.build && k === state.build.measurement;
        td.appendChild(el('button', { class: 'chip' + (cur ? (selected ? ' on' : ' cur') : ''), type: 'button',
          text: CATE.MEASUREMENTS[k].label + ' (' + fmtInt(s.datasets[k].rowsKept) + ')',
          title: selected && cur ? 'Click the row to show every machine again' : 'List the coils with ' + s.name + ' ' + CATE.MEASUREMENTS[k].label + ' data',
          onclick: function (e) { e.stopPropagation(); selectMachineMeasurement(s.name, k); } }));
      });
      if (s.status === 'parsing' || s.status === 'indexing') td.appendChild(el('span', { class: 'muted', text: 'loading ' + (s.currentTable || '') + '…' }));
      return td;
    }

    var cs = $('chartSummary'); cs.innerHTML = '';
    if (!state.build) return;
    var sum = CATE.summaryRows(state.build);
    // with a machine selected in the coverage table, only its coils / charts are listed
    var selM = state.coverageMachine ? CATE.MACHINES.indexOf(state.coverageMachine) : -1;
    if (selM >= 0 && !loader.slots[selM].datasets[state.build.measurement]) selM = -1;   // nothing of this measurement for that machine
    var listed = state.build.coils.map(function (c) {
      var groups = selM < 0 ? c.groups : c.groups.filter(function (g) { return !!g.rows[selM]; });
      var rows = selM < 0 ? c.rowCount : groups.reduce(function (a, g) { return a + g.nPts[selM]; }, 0);
      var modes = selM < 0 ? c.modes : c.modes.filter(function (md) { return groups.some(function (g) { return g.mode === md; }); });
      return { coil: c, groups: groups, rows: rows, modes: modes };
    }).filter(function (x) { return x.groups.length > 0; });
    var totalCharts = selM < 0 ? state.build.totalCharts : listed.reduce(function (a, x) { return a + x.groups.length; }, 0);
    cs.appendChild(el('h3', { text: 'Charts by coil — ' + CATE.MEASUREMENTS[state.build.measurement].label + ' (' + fmtInt(totalCharts) + (selM >= 0 ? ' with ' + state.coverageMachine + ' data' : ' total') + ')' }));
    // data-type chips: every loaded measurement, the one listed below highlighted
    var chips = el('div', { class: 'chips' }, [el('span', { class: 'muted small', text: 'Data type:' })]);
    CATE.MEASUREMENT_ORDER.forEach(function (k) {
      if (!model.hasData(k)) return;
      var on = k === state.build.measurement;
      chips.appendChild(el('button', { class: 'chip' + (on ? ' on' : ''), type: 'button', text: CATE.MEASUREMENTS[k].label,
        title: on ? 'Shown now' : 'List charts by coil for ' + CATE.MEASUREMENTS[k].label + (state.coverageMachine ? ' (' + state.coverageMachine + ')' : ''),
        onclick: function () { selectMachineMeasurement(state.coverageMachine, k); } }));
    });
    cs.appendChild(chips);
    if (!listed.length) {
      var ext = dataExtent(), mlabel = CATE.MEASUREMENTS[state.build.measurement].label;
      var mst = selM >= 0 ? loader.slots[selM].datasets[state.build.measurement].stats : null;   // the selected machine's own span
      cs.appendChild(el('div', { class: 'muted', text: selM >= 0
        ? state.coverageMachine + ' has no ' + mlabel + ' rows between ' + state.settings.start + ' and ' + state.settings.end
          + (mst && !isNaN(mst.tMin) ? '; its ' + mlabel + ' data spans ' + T.formatDate(mst.tMin) + ' – ' + T.formatDate(mst.tMax) : '')
          + '. Widen the date range (or use a preset on the left) to see its coils; if the file should hold newer tests, copy the current database from that tester.'
        : model.hasData(state.build.measurement)
        ? 'No ' + mlabel + ' rows fall in the selected date range' + (ext ? ' (data spans ' + T.formatDate(ext.min) + ' – ' + T.formatDate(ext.max) + '; use the range presets on the left)' : '') + '.'
        : 'No machine has loaded ' + mlabel + ' data; pick another measurement.' }));
    }
    if (state.coverageMachine && selM < 0) cs.appendChild(el('div', { class: 'muted', text: state.coverageMachine + ' has no ' + CATE.MEASUREMENTS[state.build.measurement].label + ' data; showing every machine.' }));
    cs.appendChild(el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn-small', text: 'Export charts by coil (CSV)', onclick: function () { download(new Blob([CATE.toCsv(sum.byCoil, ['coil', 'charts', 'rows'])], { type: 'text/csv' }), 'charts_generated_by_coil.csv'); } }),
      el('button', { class: 'btn btn-small', text: 'Export charts by coil and mode (CSV)', onclick: function () { download(new Blob([CATE.toCsv(sum.byCoilMode, ['coil', 'mode', 'charts'])], { type: 'text/csv' }), 'charts_generated_by_coil_mode.csv'); } })
    ]));
    var t2 = el('table');
    t2.appendChild(el('thead', null, [el('tr', null, [el('th', { text: 'Coil' }), el('th', { text: 'Modes' }), el('th', { class: 'num', text: 'Charts' }), el('th', { class: 'num', text: 'Rows' }), el('th', { text: 'Range' })])]));
    var tb2 = el('tbody');
    listed.forEach(function (x) {
      var c = x.coil;
      var tr = el('tr', null, [
        el('td', null, [el('a', { href: '#', text: c.name, onclick: function (e) {
          e.preventDefault(); openCoil(c.name, false);
          if (selM >= 0) { var sel = $('fMachine'); sel.value = state.coverageMachine; sel.dispatchEvent(new Event('change')); }   // open it filtered to that machine
        } })]),
        el('td', { text: x.modes.join(', ') }),
        el('td', { class: 'num', text: fmtInt(x.groups.length) }),
        el('td', { class: 'num', text: fmtInt(x.rows) }),
        el('td', { text: T.formatDate(c.start) + ' – ' + T.formatDate(c.endIncl) + (c.override ? ' (override)' : '') })
      ]);
      tb2.appendChild(tr);
    });
    t2.appendChild(tb2); cs.appendChild(t2);
  }

  /* Overview chips: select a machine (null = every machine) and switch the listed data type. */
  function selectMachineMeasurement(machine, k) {
    state.coverageMachine = machine;
    if (k !== state.settings.measurement && model.hasData(k)) { $('fMeasure').value = k; $('fMeasure').dispatchEvent(new Event('change')); }   // generate() re-renders the overview
    else renderSummary();
  }

  /* ---------------- viewer ---------------- */
  function currentCoil() {
    if (!state.build || !state.selectedCoil) return null;
    for (var i = 0; i < state.build.coils.length; i++) if (state.build.coils[i].name === state.selectedCoil) return state.build.coils[i];
    return null;
  }
  function machineIndex() { return state.filters.machine ? CATE.MACHINES.indexOf(state.filters.machine) : -1; }
  function chartOpts() {
    var s = state.settings;
    return { outlierMode: s.outlierMode, k: s.outlierK, stats: s.stats, statsOutliers: s.statsOutliers ? 'include' : 'exclude', port: state.filters.port || null };
  }
  function specFor(coil, g) {
    var mi = machineIndex(), o = chartOpts();
    var key = g.measurement + '#' + g.key + '#' + mi + '#' + o.outlierMode + '#' + o.k + '#' + (o.stats ? 1 : 0) + '#' + o.statsOutliers + '#' + (o.port || '');
    var s = state.specCache.get(key);
    if (!s) { s = model.chartSpec(coil, g, mi, o); state.specCache.set(key, s); }
    return s;
  }
  function syncOutlierControls() {
    $('fOutliers').value = state.settings.outlierMode;
    $('fK').value = state.settings.outlierK;
    $('fStats').checked = !!state.settings.stats;
    $('fStatsOut').checked = !!state.settings.statsOutliers;
    // the toggle only has an effect in Flag mode (Exclude drops the points, Off never flags any)
    $('fStatsOut').disabled = state.settings.outlierMode !== 'flag' || !state.settings.stats;
  }
  function onChartOptsChanged() {
    var mode = $('fOutliers').value, k = parseFloat($('fK').value);
    if (!(k >= 1 && k <= 20)) { k = state.settings.outlierK; $('fK').value = k; }
    state.settings.outlierMode = mode; state.settings.outlierK = k; state.settings.stats = $('fStats').checked;
    state.settings.statsOutliers = $('fStatsOut').checked;
    $('fStatsOut').disabled = mode !== 'flag' || !state.settings.stats;
    saveSettings();
    state.specCache = new Map();
    if ($('viewer').hidden) return;
    if (state.viewMode === 'single') renderSingle(); else renderLibrary();
  }
  ['fOutliers', 'fK', 'fStats', 'fStatsOut'].forEach(function (id) { $(id).addEventListener('change', onChartOptsChanged); });
  function isPartial() { return loader.isBusy(); }
  function renderPartialBanner() {
    var b = $('partialBanner');
    if (!isPartial() || $('viewer').hidden) { b.hidden = true; return; }
    var busy = loader.slots.filter(function (s) { return s.status === 'parsing' || s.status === 'indexing'; });
    b.hidden = false;
    b.textContent = 'Partial data: ' + busy.map(function (s) { return s.name + (s.status === 'parsing' ? ' ' + Math.round(s.progress * 100) + '%' : ' indexing'); }).join(', ') + ' still loading. Charts update automatically when each file finishes.';
    $('downloadAllBtn').disabled = true;
  }

  function openCoil(name, keepPosition) {
    var prevKey = keepPosition ? state.currentKey : null;
    state.selectedCoil = name;
    var coil = currentCoil();
    if (!coil) { showSummary(); return; }
    $('summaryView').hidden = true; $('viewer').hidden = false;
    populateMeasurementSelect();
    $('viewerTitle').textContent = coil.name;
    $('viewerMeta').textContent = CATE.MEASUREMENTS[coil.measurement].label + ' · ' + coil.groups.length + ' charts · modes ' + coil.modes.join(', ') + ' · ' + fmtInt(coil.rowCount) + ' rows · ' + T.formatDate(coil.start) + ' – ' + T.formatDate(coil.endIncl) + (coil.override ? ' (override)' : '');
    $('downloadAllBtn').disabled = isPartial();
    if (!keepPosition) state.filters = { machine: '', mode: '', tc: '', net: '', port: '' };
    populateFilters(coil);
    applyFilters(prevKey);
    renderCoilList();
    renderPartialBanner();
  }
  $('backBtn').addEventListener('click', showSummary);
  function showSummary() {
    state.selectedCoil = null; state.currentKey = null;
    $('viewer').hidden = true; $('summaryView').hidden = false;
    showMeasureNote(''); populateMeasurementSelect();
    renderCoilList();
  }

  function populateFilters(coil) {
    var sets = { mode: new Set(), tc: new Set(), net: new Set(), port: new Set() };
    var present = CATE.MACHINES.map(function () { return false; });
    var MEAS = CATE.MEASUREMENTS[coil.measurement], isNet = MEAS.keyKind === 'net';
    coil.groups.forEach(function (g) {
      sets.mode.add(g.mode); if (isNet) sets.net.add(g.net); else sets.tc.add(g.tc);
      (g.ports || []).forEach(function (p) { sets.port.add(p); });
      for (var m = 0; m < CATE.MACHINES.length; m++) if (g.rows[m]) present[m] = true;
    });
    var machines = CATE.MACHINES.filter(function (name, m) { return present[m]; });
    fillSelect($('fMachine'), machines, state.filters.machine, 'All machines');
    fillSelect($('fMode'), Array.from(sets.mode).sort(CATE.cmpStr), state.filters.mode, 'All modes');
    fillSelect($('fTc'), Array.from(sets.tc).sort(function (a, b) { return a - b; }).map(String), state.filters.tc, 'All test cases');
    var keyLabel = MEAS.keyLabel || 'Net';
    $('netFilterLabel').textContent = keyLabel;
    fillSelect($('fNet'), Array.from(sets.net).sort(CATE.cmpStr), state.filters.net, 'All ' + keyLabel.toLowerCase() + 's');
    var ports = Array.from(sets.port).sort(CATE.cmpStr);
    fillSelect($('fPort'), ports, state.filters.port, 'All ports');
    if (ports.indexOf(state.filters.port) < 0) state.filters.port = '';
    $('tcFilter').hidden = isNet; $('netFilter').hidden = !isNet;
    $('portFilter').hidden = ports.length < 2;           // only EVO data carries ports; shown when a coil was tested on more than one
  }
  function fillSelect(sel, values, current, allLabel) {
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '', text: allLabel }));
    values.forEach(function (v) { sel.appendChild(el('option', { value: v, text: v })); });
    sel.value = values.indexOf(current) >= 0 ? current : '';
  }
  ['fMachine', 'fMode', 'fTc', 'fNet', 'fPort'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      state.filters = { machine: $('fMachine').value, mode: $('fMode').value, tc: $('fTc').value, net: $('fNet').value, port: $('fPort').value };
      state.specCache = new Map();                       // the port filter changes the drawn points
      applyFilters(state.currentKey);
    });
  });
  function updateReadouts(g) {
    var isNet = CATE.MEASUREMENTS[state.settings.measurement].keyKind === 'net';
    $('fChanValue').textContent = g ? g.chan : '—';
    $('fElemValue').textContent = g ? g.elem : '—';
    $('chanReadout').hidden = $('elemReadout').hidden = (state.viewMode !== 'single') || isNet;
  }
  function applyFilters(preferKey) {
    var coil = currentCoil(); if (!coil) return;
    var f = state.filters, mi = machineIndex();
    state.filtered = coil.groups.filter(function (g) {
      return (mi < 0 || !!g.rows[mi]) && (!f.mode || g.mode === f.mode) && (!f.tc || String(g.tc) === f.tc) && (!f.net || g.net === f.net) &&
             (!f.port || (g.ports || []).indexOf(f.port) >= 0);
    });
    $('filterCount').textContent = state.filtered.length === coil.groups.length ? '' : state.filtered.length + ' of ' + coil.groups.length + ' charts match';
    var idx = 0;
    if (preferKey) { for (var i = 0; i < state.filtered.length; i++) if (state.filtered[i].key === preferKey) { idx = i; break; } }
    state.index = idx;
    if (state.viewMode === 'single') renderSingle(); else renderLibrary();
  }

  /* view mode toggle */
  $('modeSingle').addEventListener('click', function () { setViewMode('single'); });
  $('modeLibrary').addEventListener('click', function () { setViewMode('library'); });
  function setViewMode(mode) {
    state.viewMode = mode;
    $('modeSingle').classList.toggle('active', mode === 'single');
    $('modeLibrary').classList.toggle('active', mode === 'library');
    $('singleView').hidden = mode !== 'single';
    $('libraryView').hidden = mode !== 'library';
    if (mode === 'single') renderSingle(); else { renderLibrary(); updateReadouts(null); }
  }

  /* single chart */
  function renderSingle() {
    var coil = currentCoil();
    var n = state.filtered.length;
    var cv = $('mainCanvas');
    if (!coil || !n) {
      $('posLabel').textContent = '0 / 0'; $('posCaption').textContent = 'No charts match the current filters.';
      cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
      state.renderInfo = null; state.currentKey = null;
      updateReadouts(null);
      return;
    }
    if (state.index >= n) state.index = n - 1; if (state.index < 0) state.index = 0;
    var g = state.filtered[state.index];
    state.currentKey = g.key;
    $('posLabel').textContent = (state.index + 1) + ' / ' + n;
    updateReadouts(g);
    var spec0 = specFor(coil, g);
    var outTxt = '';
    if (spec0.outliers && spec0.outliers.count) {
      outTxt = spec0.outlierMode === 'exclude' ? ' · ' + spec0.outliers.count + ' outliers excluded'
             : ' · ' + spec0.outliers.count + ' outliers flagged (' + spec0.outliers.nPinned + ' off-scale)';
    }
    $('posCaption').textContent = g.caption + (spec0.machine ? ' · ' + spec0.machine : '') + ' · ' + g.modeDir + '/' + spec0.fileName + outTxt;
    $('prevBtn').disabled = state.index === 0; $('nextBtn').disabled = state.index === n - 1;
    var spec = specFor(coil, g);
    var wrap = $('canvasWrap');
    var cssW = Math.max(300, wrap.clientWidth - 16);
    state.renderInfo = chart.render(cv, spec, { cssWidth: cssW, watermark: isPartial() ? 'PARTIAL DATA — files still loading' : null });
    state.currentSpec = spec;
    $('tooltip').hidden = true;
  }
  function step(delta) {
    var n = state.filtered.length; if (!n) return;
    var i = Math.min(n - 1, Math.max(0, state.index + delta));
    if (i === state.index) return;
    state.index = i; renderSingle();
  }
  $('prevBtn').addEventListener('click', function () { step(-1); });
  $('nextBtn').addEventListener('click', function () { step(1); });
  document.addEventListener('keydown', function (e) {
    if ($('viewer').hidden || state.viewMode !== 'single') return;
    var t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
    else if (e.key === 'Home') { state.index = 0; renderSingle(); e.preventDefault(); }
    else if (e.key === 'End') { state.index = state.filtered.length - 1; renderSingle(); e.preventDefault(); }
  });
  window.addEventListener('resize', function () { debounce('resize', function () { if (!$('viewer').hidden && state.viewMode === 'single') renderSingle(); }, 150); });

  /* hover tooltip */
  var cvMain = $('mainCanvas');
  /* Show the tooltip for the point nearest to canvas-relative CSS position (cx, cy). Returns the hit or null. */
  function showTooltipAt(cx, cy) {
    var tip = $('tooltip');
    if (!state.renderInfo || !state.currentSpec) { tip.hidden = true; return null; }
    var spec = state.currentSpec;
    var hit = chart.hitTest(state.renderInfo, spec, cx, cy, 9);
    if (!hit) { tip.hidden = true; return null; }
    var units = spec.units || 'dB', dec = spec.decimals === undefined ? 2 : spec.decimals;
    var info = model.rowInfo(hit.series.m, hit.series.rows[hit.i], spec.measurement);
    tip.innerHTML = '';
    tip.appendChild(el('div', { class: 'tt-m', text: info.machine + (info.port ? ' · Port ' + info.port : '') }));
    tip.appendChild(el('div', { text: 'SN ' + info.sn }));
    tip.appendChild(el('div', { text: T.formatDateTime(info.time) }));
    tip.appendChild(el('div', { text: info.meas.toFixed(dec) + ' ' + units + (!isNaN(info.lsl) ? ' · LSL ' + info.lsl.toFixed(dec) : '') + (!isNaN(info.usl) ? ' · USL ' + info.usl.toFixed(dec) : '') }));
    var exDefs = CATE.MEASUREMENTS[spec.measurement].extras || {};
    var exTxt = Object.keys(exDefs).filter(function (k) { return info.extras && info.extras[k] === info.extras[k]; }).map(function (k) {
      var d = exDefs[k], v = info.extras[k];
      return d.label + ' ' + (d.decimals === 0 ? Math.round(v).toLocaleString('en-US') : v.toFixed(d.decimals)) + (d.units ? ' ' + d.units : '');
    });
    if (exTxt.length) tip.appendChild(el('div', { text: exTxt.join(' · ') }));
    if (hit.flag && spec.outliers) {
      var o = spec.outliers;
      var dev = Math.abs(info.meas - o.median) / o.scale;
      tip.appendChild(el('div', { class: 'tt-out', text: (hit.flag === 3 ? 'OUTLIER (shown in place)' : 'OUTLIER — shown off-scale') +
        '. Actual value ' + info.meas.toFixed(dec) + ' ' + units + ' (median ' + o.median.toFixed(dec) + ', ' + dev.toFixed(1) + ' MAD units, k = ' + o.k + ')' }));
    }
    if (hit.stacked && hit.stacked.length) {
      var st = el('div', { class: 'tt-stack' });
      st.appendChild(el('div', { class: 'tt-m', text: '+' + hit.stackedTotal + ' more at this spot' }));
      hit.stacked.forEach(function (p) {
        var pi = model.rowInfo(p.series.m, p.series.rows[p.i], spec.measurement);
        var line = pi.machine + ' · SN ' + pi.sn + ' · ' + T.formatDateTime(pi.time) + ' · ' + pi.meas.toFixed(dec) + ' ' + units;
        st.appendChild(el('div', { class: p.flag ? 'tt-out' : '', text: line + (p.flag ? ' (OUTLIER)' : '') }));
      });
      if (hit.stackedTotal > hit.stacked.length) st.appendChild(el('div', { class: 'muted-light', text: '+' + (hit.stackedTotal - hit.stacked.length) + ' more' }));
      tip.appendChild(st);
    }
    tip.hidden = false;
    // position: right of the marker, flip left when it would overflow, then clamp inside the wrap on all sides
    var wrap = $('canvasWrap');
    var W = wrap.clientWidth, H = wrap.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
    var x = hit.px + 8 + 14, y = hit.py + 8 - 10;
    if (x + tw > W) x = hit.px + 8 - tw - 14;
    x = Math.max(0, Math.min(x, W - tw));
    y = Math.max(0, Math.min(y, H - th));
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    return hit;
  }
  cvMain.addEventListener('mousemove', function (e) {
    var r = cvMain.getBoundingClientRect();
    showTooltipAt(e.clientX - r.left, e.clientY - r.top);
  });
  cvMain.addEventListener('mouseleave', function () { $('tooltip').hidden = true; });

  /* download single */
  $('downloadBtn').addEventListener('click', function () {
    var coil = currentCoil(); if (!coil || !state.filtered.length) return;
    var g = state.filtered[state.index];
    var spec = specFor(coil, g);
    chart.renderToBlob(spec, { width: 3900, watermark: isPartial() ? 'PARTIAL DATA — files still loading' : null })
      .then(function (b) { download(b, coil.safeName + '__' + g.modeDir + '__' + spec.fileName); });
  });

  /* library */
  var observer = null, renderQueue = [], queueScheduled = false;
  function renderLibrary() {
    var grid = $('libraryGrid'); grid.innerHTML = '';
    if (observer) { observer.disconnect(); }
    renderQueue = [];
    var coil = currentCoil(); if (!coil) return;
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var card = en.target;
        if (en.isIntersecting) { if (!card._rendered && !card._queued) { card._queued = true; renderQueue.push(card); scheduleQueue(); } }
        else if (card._rendered) { var c = card._canvas; c.width = 0; c.height = 0; card._rendered = false; }
      });
    }, { root: $('libraryGrid').closest('.main'), rootMargin: '600px 0px' });
    state.filtered.forEach(function (g, i) {
      var canvas = el('canvas');
      var card = el('div', { class: 'card', title: g.modeDir + '/' + g.fileName + (state.filters.machine ? ' (' + state.filters.machine + ')' : '') }, [canvas, el('div', { class: 'cap' }, [el('b', { text: g.caption }), el('span', { text: (i + 1) + ' / ' + state.filtered.length })])]);
      card._group = g; card._canvas = canvas; card._rendered = false; card._queued = false;
      card.addEventListener('click', function () { state.index = i; setViewMode('single'); });
      $('libraryGrid').appendChild(card);
      observer.observe(card);
    });
  }
  function scheduleQueue() {
    if (queueScheduled) return;
    queueScheduled = true;
    setTimeout(function () {
      queueScheduled = false;
      var coil = currentCoil(); if (!coil) { renderQueue = []; return; }
      var budget = 4;
      while (renderQueue.length && budget-- > 0) {
        var card = renderQueue.shift();
        card._queued = false;
        if (card._rendered || !card.isConnected) continue;
        var spec = specFor(coil, card._group);
        var w = Math.max(200, card.clientWidth - 12);
        chart.render(card._canvas, spec, { cssWidth: w, dpr: Math.min(1.25, window.devicePixelRatio || 1), noStats: true, watermark: isPartial() ? 'PARTIAL DATA' : null });
        card._rendered = true;
      }
      if (renderQueue.length) scheduleQueue();
    });
  }

  /* download all (zip) */
  $('downloadAllBtn').addEventListener('click', function () {
    var coil = currentCoil(); if (!coil) return;
    var groups = state.filtered.length ? state.filtered : coil.groups;
    var zip = new CATE.ZipWriter();
    state.zipCancel = false;
    $('zipModal').hidden = false; $('zipTitle').textContent = 'Rendering ' + groups.length + ' charts for ' + coil.name;
    var i = 0;
    function next() {
      if (state.zipCancel) { $('zipModal').hidden = true; return; }
      if (i >= groups.length) {
        $('zipLabel').textContent = 'Packing zip…';
        setTimeout(function () { download(zip.toBlob(), coil.safeName + '_' + coil.measurement + (state.filters.machine ? '_' + state.filters.machine : '') + '_RunCharts.zip'); $('zipModal').hidden = true; }, 20);
        return;
      }
      var g = groups[i];
      $('zipFill').style.width = Math.round(i / groups.length * 100) + '%';
      $('zipLabel').textContent = (i + 1) + ' / ' + groups.length + ' · ' + g.modeDir + '/' + g.fileName;
      var zspec = specFor(coil, g);
      chart.renderToBlob(zspec, { width: 3900 }).then(function (b) { return b.arrayBuffer(); }).then(function (buf) {
        zip.add(coil.safeName + '/' + g.modeDir + '/' + zspec.fileName, new Uint8Array(buf));
        i++; setTimeout(next, 0);
      }).catch(function (e) { $('zipLabel').textContent = 'Failed: ' + e.message; });
    }
    next();
  });
  $('zipCancel').addEventListener('click', function () { state.zipCancel = true; });

  /* ---------------- init ---------------- */
  syncRangeInputs();
  syncOutlierControls();
  updateCoilDatalist();
  populateMeasurementSelect();
  renderFileTable();
  renderSummary();
  renderStatus();

  // Small hook for dev/ui-test.html (no effect on normal use).
  window.cateApp = {
    loadFiles: handleFiles, loader: loader, state: state, openCoil: openCoil, setViewMode: setViewMode, generate: generate,
    goTo: function (modeDir, fileName) {
      for (var i = 0; i < state.filtered.length; i++) {
        if (state.filtered[i].modeDir === modeDir && state.filtered[i].fileName === fileName) { state.index = i; renderSingle(); return true; }
      }
      return false;
    },
    hoverAt: showTooltipAt,
    setMeasurement: function (k) { if (!CATE.MEASUREMENTS[k]) return; $('fMeasure').value = k; $('fMeasure').dispatchEvent(new Event('change')); },
    setOutliers: function (mode, k, stats, statsOutliers) {
      if (mode) $('fOutliers').value = mode;
      if (k) $('fK').value = k;
      if (stats !== undefined) $('fStats').checked = !!stats;
      if (statsOutliers !== undefined) $('fStatsOut').checked = !!statsOutliers;
      onChartOptsChanged();
    }
  };
})();

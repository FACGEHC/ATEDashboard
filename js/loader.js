/* loader.js - file slots (one per machine, several datasets each), Blob-URL worker parsing with a
 * main-thread fallback, progress events.
 *
 * A slot holds the datasets of one machine keyed by measurement (Sensitivity, MCBias, ...).
 * Dropping an .mdb replaces every dataset of that machine (all result tables are read);
 * dropping a .csv replaces only the dataset of the measurement that file holds.
 */
(function (root) {
  'use strict';
  var CATE = root.CATE || (root.CATE = {});

  function fileKind(name) {
    if (/\.mdb$/i.test(name) || /\.accdb$/i.test(name)) return 'mdb';
    if (/\.csv$/i.test(name) || /\.txt$/i.test(name)) return 'csv';
    return null;
  }

  function Loader(model) {
    this.model = model;
    this.slots = CATE.MACHINES.map(function (name, i) {
      return { index: i, name: name, file: null, kind: null, status: 'empty', progress: 0, rowsRead: 0, rowsKept: 0,
               bytesDone: 0, bytesTotal: 0, startedAt: 0, worker: null, error: null, stats: null, gen: 0,
               currentTable: '', datasets: {}, tableErrors: [], queue: [], pending: 0, finishWhenIdle: false };
    });
    this.listeners = {};
    this.workerUrl = null;
  }

  Loader.prototype.on = function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; };
  Loader.prototype.emit = function (ev, data) { (this.listeners[ev] || []).forEach(function (fn) { fn(data); }); };

  Loader.prototype.isBusy = function () { return this.slots.some(function (s) { return s.status === 'parsing' || s.status === 'indexing'; }); };
  Loader.prototype.loadedCount = function () { return this.slots.filter(function (s) { return s.status === 'done'; }).length; };
  Loader.prototype.fileKind = fileKind;

  /* Accept a FileList / array of File. Returns {accepted:[], ignored:[]}.
   * Several files may target one machine (e.g. CATE1001_Sensitivity.csv + CATE1001_MCBiasResults.csv);
   * an .mdb in the same drop supersedes that machine's CSVs. */
  Loader.prototype.addFiles = function (files) {
    var self = this, accepted = [], ignored = [];
    var byMachine = {};
    Array.prototype.forEach.call(files, function (f) {
      var kind = fileKind(f.name);
      var m = CATE.machineIndexFromName(f.name);
      if (m < 0 || !kind) { ignored.push(f.name); return; }
      accepted.push(f.name);
      var list = byMachine[m] || (byMachine[m] = []);
      list.push({ file: f, kind: kind });
    });
    Object.keys(byMachine).forEach(function (mk) {
      var m = +mk, list = byMachine[mk];
      var mdbs = list.filter(function (x) { return x.kind === 'mdb'; });
      if (mdbs.length) list = [mdbs[mdbs.length - 1]];
      list.forEach(function (x) { self.enqueue(m, x.file, x.kind); });
    });
    return { accepted: accepted, ignored: ignored };
  };

  Loader.prototype.enqueue = function (m, file, kind) {
    var slot = this.slots[m];
    if (slot.status === 'parsing' || slot.status === 'indexing') { slot.queue.push({ file: file, kind: kind }); this.emit('slot', slot); return; }
    this.startFile(m, file, kind);
  };

  /* Remove everything loaded for a machine. */
  Loader.prototype.clear = function (m) {
    var slot = this.slots[m];
    this.stopWorker(slot);
    slot.gen++;
    slot.file = null; slot.kind = null; slot.status = 'empty'; slot.progress = 0; slot.error = null; slot.stats = null;
    slot.rowsRead = slot.rowsKept = slot.bytesDone = slot.bytesTotal = 0;
    slot.currentTable = ''; slot.datasets = {}; slot.tableErrors = []; slot.queue = []; slot.pending = 0; slot.finishWhenIdle = false;
    this.model.removeMachine(m);
    this.emit('slot', slot);
    this.emit('dataChanged', { machine: m, removed: true });
  };

  /* Remove one measurement's dataset for a machine (keeps the others). */
  Loader.prototype.clearDataset = function (m, measurement) {
    var slot = this.slots[m];
    if (!slot.datasets[measurement]) return;
    delete slot.datasets[measurement];
    this.model.removeDataset(m, measurement);
    this.recount(slot);
    if (!Object.keys(slot.datasets).length && slot.status === 'done') { slot.status = 'empty'; slot.file = null; slot.kind = null; slot.stats = null; }
    this.emit('slot', slot);
    this.emit('dataChanged', { machine: m, measurement: measurement, removed: true });
  };

  Loader.prototype.stopWorker = function (slot) {
    if (slot.worker) { try { slot.worker.terminate(); } catch (e) { /* ignore */ } slot.worker = null; }
  };
  Loader.prototype.recount = function (slot) {
    var rows = 0; Object.keys(slot.datasets).forEach(function (k) { rows += slot.datasets[k].rowsKept; });
    slot.rowsKept = rows;
  };

  Loader.prototype.startFile = function (m, file, kind) {
    var self = this, slot = this.slots[m];
    if (kind === 'mdb') { this.clear(m); }
    else { this.stopWorker(slot); slot.gen++; }
    var gen = slot.gen;
    slot.file = file; slot.kind = kind; slot.status = 'parsing'; slot.error = null;
    slot.bytesTotal = file.size; slot.bytesDone = 0; slot.progress = 0; slot.rowsRead = 0; slot.startedAt = Date.now();
    slot.currentTable = ''; slot.pending = 0; slot.finishWhenIdle = false;
    if (kind === 'mdb') slot.tableErrors = [];
    this.emit('slot', slot);

    function finalize() {
      if (slot.gen !== gen) return;
      slot.status = Object.keys(slot.datasets).length ? 'done' : (slot.error ? 'error' : 'empty');
      slot.progress = 1; slot.worker = null; slot.currentTable = '';
      self.emit('slot', slot);
      if (slot.queue.length) { var nx = slot.queue.shift(); self.startFile(m, nx.file, nx.kind); }
    }

    function onMessage(msg) {
      if (slot.gen !== gen) return;           // stale
      if (msg.type === 'progress') {
        slot.bytesDone = msg.bytesDone; slot.rowsRead = msg.rowsRead;
        slot.progress = msg.bytesTotal ? msg.bytesDone / msg.bytesTotal : 1;
        if (msg.table) slot.currentTable = msg.table;
        if (slot.status === 'parsing') self.emit('slot', slot);
      } else if (msg.type === 'detected') {
        slot.currentTable = CATE.MEASUREMENTS && CATE.MEASUREMENTS[msg.measurement] ? CATE.MEASUREMENTS[msg.measurement].table : msg.measurement;
        self.emit('slot', slot);
      } else if (msg.type === 'tablesEmpty') {
        slot.emptyTables = (slot.emptyTables || []).concat(msg.measurements || []);
      } else if (msg.type === 'tableError') {
        slot.tableErrors.push({ measurement: msg.measurement, table: msg.table, message: msg.message });
        self.emit('slot', slot);
      } else if (msg.type === 'error') {
        slot.status = 'error'; slot.error = msg.message; slot.worker = null;
        self.emit('slot', slot);
        if (slot.queue.length) { var nx = slot.queue.shift(); self.startFile(m, nx.file, nx.kind); }
      } else if (msg.type === 'dataset') {
        slot.status = 'indexing'; slot.pending++;
        self.emit('slot', slot);
        // index on the next frame so the progress UI can paint
        setTimeout(function () {
          if (slot.gen !== gen) return;
          try {
            self.model.addDataset(m, msg.measurement, msg);
            slot.datasets[msg.measurement] = { fileName: file.name, rowsKept: msg.n, stats: msg.stats, keyKind: msg.keyKind };
            slot.stats = msg.stats;
            self.recount(slot);
            slot.pending--;
            slot.status = 'parsing';
            self.emit('slot', slot);
            self.emit('dataChanged', { machine: m, measurement: msg.measurement, removed: false });
          } catch (e) {
            slot.pending--;
            slot.error = 'Indexing failed: ' + (e && e.message ? e.message : e);
            slot.tableErrors.push({ measurement: msg.measurement, table: msg.stats && msg.stats.table, message: slot.error });
            slot.status = 'parsing';
            self.emit('slot', slot);
          }
          if (slot.finishWhenIdle && slot.pending === 0) finalize();
        }, 0);
      } else if (msg.type === 'done') {
        slot.finishWhenIdle = true;
        if (slot.pending === 0) finalize();
      }
    }

    var gotProgress = false;
    function runOnMainThread() {
      // main-thread fallback: yield between chunks so the UI stays responsive
      var core = cateParseCore();
      var yieldFn = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
      var p = kind === 'mdb' ? core.parseMdb(file, function (msg) { onMessage(msg); }, { jet: cateJetCore(), yieldFn: yieldFn })
                             : core.parseFile(file, function (msg) { onMessage(msg); }, { yieldFn: yieldFn, fileName: file.name });
      p.catch(function (e) { onMessage({ type: 'error', message: String(e && e.message || e) }); });
    }

    var worker = this.spawnWorker();
    if (worker) {
      slot.worker = worker;
      worker.onmessage = function (e) { gotProgress = true; onMessage(e.data); };
      worker.onerror = function (e) {
        if (slot.gen !== gen) return;
        try { worker.terminate(); } catch (err) { /* ignore */ }
        slot.worker = null;
        if (!gotProgress) {                      // worker never started (e.g. blocked blob workers): fall back
          self.workerUrl = null; self.workersBlocked = true;
          runOnMainThread();
        } else {
          slot.status = 'error'; slot.error = 'Worker error: ' + (e.message || 'unknown');
          self.emit('slot', slot);
        }
      };
      worker.postMessage({ kind: kind, file: file, fileName: file.name });
    } else {
      runOnMainThread();
    }
  };

  Loader.prototype.spawnWorker = function () {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || this.workersBlocked) return null;
    try {
      if (!this.workerUrl) {
        var src = 'var cateParseCore = ' + cateParseCore.toString() + ';\n' +
          'var cateJetCore = ' + cateJetCore.toString() + ';\n' +
          'var core = cateParseCore();\n' +
          'self.onmessage = function (e) {\n' +
          '  var d = e.data, post = function (msg, transfer) { self.postMessage(msg, transfer || []); };\n' +
          '  var p = d.kind === "mdb" ? core.parseMdb(d.file, post, { jet: cateJetCore(), fileName: d.fileName })\n' +
          '                           : core.parseFile(d.file, post, { fileName: d.fileName });\n' +
          '  p.then(function () {}, function (err) { post({ type: "error", message: String(err && err.message || err) }); });\n' +
          '};\n';
        this.workerUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      }
      var w = new Worker(this.workerUrl);
      return w;
    } catch (e) {
      return null;
    }
  };

  CATE.Loader = Loader;
})(typeof globalThis !== 'undefined' ? globalThis : this);

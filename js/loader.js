/* loader.js - file slots (one per machine, several datasets each), Blob-URL worker parsing with a
 * main-thread fallback, progress events.
 *
 * A slot holds the datasets of one machine keyed by measurement (Sensitivity, MCBias, ...).
 * Dropping an .mdb replaces every dataset of that machine (all result tables are read);
 * dropping a .csv replaces only the dataset of the measurement that file holds.
 *
 * How it works: app.js hands dropped File objects to Loader.addFiles, which routes each file to the slot
 * of the machine named in the file name (CATE.machineIndexFromName) and queues it. startFile runs the
 * parser (parse-core.js, plus jet-core.js for .mdb) in a Web Worker whose source is built from the parsers'
 * toString() and served from a Blob URL; when blob workers are blocked the same code runs on the main
 * thread, yielding between chunks. The parser posts progress / detected / dataset / tableError / done
 * messages; every 'dataset' message is handed to model.addDataset (the columnar store in model.js) and the
 * slot's per-measurement bookkeeping is updated. Listeners (app.js) subscribe with loader.on('slot', fn)
 * for progress / status changes and loader.on('dataChanged', fn) when the model gained or lost a dataset.
 * A per-slot generation counter (slot.gen) is bumped whenever a slot is cleared or restarted so that
 * messages from a superseded worker are ignored.
 */
(function (root) {
  'use strict';
  var CATE = root.CATE || (root.CATE = {});

  /* Classify a file by its extension: 'mdb' for Access databases (.mdb/.accdb), 'csv' for text exports
   * (.csv/.txt), null for anything else (addFiles reports such files as ignored). */
  function fileKind(name) {
    if (/\.mdb$/i.test(name) || /\.accdb$/i.test(name)) return 'mdb';
    if (/\.csv$/i.test(name) || /\.txt$/i.test(name)) return 'csv';
    return null;
  }

  /* Loader constructor. `model` is the CATE.model instance that receives the parsed datasets. Creates one
   * slot per entry of CATE.MACHINES (same index order) holding the file, its status ('empty' | 'parsing' |
   * 'indexing' | 'done' | 'error'), progress counters, the live worker, the loaded datasets by measurement,
   * per-table errors, a queue of files waiting for this machine and the generation counter. */
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

  /* Minimal event emitter: on(ev, fn) registers a listener (chainable); emit(ev, data) calls every listener of
   * that event synchronously. Events: 'slot' (a slot changed; data = the slot) and 'dataChanged'
   * ({machine, measurement?, removed}). */
  Loader.prototype.on = function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; };
  Loader.prototype.emit = function (ev, data) { (this.listeners[ev] || []).forEach(function (fn) { fn(data); }); };

  /* isBusy: any slot still parsing or indexing (app.js shows the partial-data banner while true).
   * loadedCount: number of slots in the 'done' state. fileKind is re-exported for the UI. */
  Loader.prototype.isBusy = function () { return this.slots.some(function (s) { return s.status === 'parsing' || s.status === 'indexing'; }); };
  Loader.prototype.loadedCount = function () { return this.slots.filter(function (s) { return s.status === 'done'; }).length; };
  Loader.prototype.fileKind = fileKind;

  /* Accept a FileList / array of File. Returns {accepted:[], ignored:[]} (file names).
   * Several files may target one machine (e.g. CATE1001_Sensitivity.csv + CATE1001_MCBiasResults.csv);
   * an .mdb in the same drop supersedes that machine's CSVs.
   * How: each file is classified (fileKind) and mapped to a machine with CATE.machineIndexFromName; files
   * with no machine in the name or an unknown extension are ignored. Per machine, when any .mdb is present
   * only the last one is kept, otherwise every CSV is enqueued in drop order. */
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

  /* Queue a file for machine m: while the slot is busy (parsing / indexing) the file waits in slot.queue and
   * is started by finalize() when the current file ends; otherwise it starts right away. */
  Loader.prototype.enqueue = function (m, file, kind) {
    var slot = this.slots[m];
    if (slot.status === 'parsing' || slot.status === 'indexing') { slot.queue.push({ file: file, kind: kind }); this.emit('slot', slot); return; }
    this.startFile(m, file, kind);
  };

  /* Remove everything loaded for a machine: terminates the worker, bumps slot.gen so late messages from it
   * are dropped, resets every slot field (including the queue), removes the machine from the model and
   * emits 'slot' and 'dataChanged' {removed: true}. */
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

  /* Remove one measurement's dataset for a machine (keeps the others). Recounts the slot's rows; when the
   * last dataset goes the slot returns to 'empty'. Emits 'slot' and 'dataChanged'. No-op when absent. */
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

  /* Terminate the slot's worker (if any) and forget it; errors from terminate() are ignored. */
  Loader.prototype.stopWorker = function (slot) {
    if (slot.worker) { try { slot.worker.terminate(); } catch (e) { /* ignore */ } slot.worker = null; }
  };
  /* Recompute slot.rowsKept as the sum of rowsKept over the slot's loaded datasets. */
  Loader.prototype.recount = function (slot) {
    var rows = 0; Object.keys(slot.datasets).forEach(function (k) { rows += slot.datasets[k].rowsKept; });
    slot.rowsKept = rows;
  };

  /* Start parsing `file` (kind 'mdb' | 'csv') into the slot of machine m. An .mdb first clears the whole
   * machine (every table is replaced); a .csv only stops a running worker and bumps the generation, so the
   * other measurements' datasets survive and only the CSV's measurement is replaced when its dataset arrives.
   * Parsing runs in a worker when spawnWorker succeeds, otherwise on the main thread. Parser messages:
   *   progress    - update byte / row counters and the current table name (emits 'slot')
   *   detected    - the parser found which measurement a CSV holds
   *   tablesEmpty - .mdb result tables without rows (remembered in slot.emptyTables)
   *   tableError  - one .mdb table failed; the others continue
   *   error       - the whole file failed; the next queued file (if any) starts
   *   dataset     - one measurement's columnar arrays; indexed into the model on a setTimeout(0) so the
   *                 progress UI can paint first (slot.pending counts indexing still in flight)
   *   done        - the parser finished; finalize() runs once pending indexing reaches zero
   * `gen` is captured at start; every callback checks slot.gen === gen and ignores stale messages. */
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

    /* Called once parsing and indexing are both complete: set the final status ('done' with at least one
     * dataset, else 'error' / 'empty'), emit 'slot', and start the next queued file for this machine. */
    function finalize() {
      if (slot.gen !== gen) return;
      slot.status = Object.keys(slot.datasets).length ? 'done' : (slot.error ? 'error' : 'empty');
      slot.progress = 1; slot.worker = null; slot.currentTable = '';
      self.emit('slot', slot);
      if (slot.queue.length) { var nx = slot.queue.shift(); self.startFile(m, nx.file, nx.kind); }
    }

    /* Dispatch one parser message (see the list above). Shared by the worker and main-thread paths. */
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
    /* Fallback when no worker could be created, or the blob worker failed before reporting anything: run the
     * same parse-core / jet-core parsers on the main thread with a yieldFn that returns to the event loop
     * between chunks. A rejected promise becomes an 'error' message. */
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

  /* Create a Web Worker that runs the parsers. The worker source is assembled once from the toString() of
   * cateParseCore and cateJetCore (globals defined by parse-core.js / jet-core.js) plus an onmessage shim,
   * and served from a Blob URL cached in this.workerUrl. Returns null when Worker / Blob are unavailable,
   * when workers were found to be blocked earlier (this.workersBlocked) or when construction throws; the
   * caller then parses on the main thread. */
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

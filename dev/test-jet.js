// Node test for js/jet-core.js: compares the pure-JS Access reader against the ACE OLEDB export
// produced by tools/export_mdb.ps1.
//   node dev/test-jet.js ../data/CATE_1001.mdb ../data/ref/CATE1001 [TableName ...]
// Without arguments only the self-contained unit checks run.
const fs = require('fs');
const path = require('path');
const cateJetCore = require('../js/jet-core.js');
const jet = cateJetCore();

let fails = 0;
function eq(a, b, msg) {
  const ok = (Number.isNaN(a) && Number.isNaN(b)) || a === b || JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { fails++; console.error('FAIL', msg, '\n  got     ', a, '\n  expected', b); } else console.log('ok  ', msg);
}

// ---------- unit checks: text decoding
const B = (...xs) => Uint8Array.from(xs);
eq(jet.decodeText(B(0xFF, 0xFE, 0x41, 0x42, 0x43), 0, 5), 'ABC', 'compressed ascii');
eq(jet.decodeText(B(0xFF, 0xFE, 0x41, 0x00, 0x3B, 0x03, 0x00, 0x42), 0, 8), 'A̻B', 'compressed with a UTF-16 segment');
eq(jet.decodeText(B(0x41, 0x00, 0x42, 0x00), 0, 4), 'AB', 'plain utf-16le');
eq(jet.decodeText(B(0xFF, 0xFE, 0xB0), 0, 3), '°', 'compressed cp1252 degree sign');
eq(jet.decodeText(B(), 0, 0), '', 'empty');

// ---------- unit check: a hand-built data page with one row of [LONG, TEXT, TEXT(null)]
(function () {
  const PG = 4096, page = new Uint8Array(PG);
  page[0] = 0x01; page[4] = 80;                       // data page owned by TDEF page 80
  page[0x0C] = 1;                                     // one row
  // row layout: numCols(2) | fixed LONG(4) | var text "hi" (FF FE 68 69) | varOffs[1], varOffs[0] | nVar | nullmask
  const row = [];
  row.push(3, 0);                                     // 3 columns
  row.push(0x2A, 0, 0, 0);                            // LONG 42 at fixedOffset 0
  const varStart = row.length;                        // 6
  row.push(0xFF, 0xFE, 0x68, 0x69);                   // "hi"
  const varEnd = row.length;                          // 10
  // offsets table (from the end): offs[0] at offBase, offs[1] at offBase-2; then nVar, then mask
  row.push(varEnd & 255, varEnd >> 8);                // offs[1] (end of var col 0)   <- offBase - 2
  row.push(varStart & 255, varStart >> 8);            // offs[0] (start of var col 0) <- offBase
  row.push(1, 0);                                     // nVar = 1
  row.push(0b011);                                    // null mask: col0 present, col1 present, col2 null
  const start = PG - row.length;
  page.set(row, start);
  page[0x0E] = start & 255; page[0x0F] = start >> 8;
  const tdef = { page: 80, numCols: 3, cols: [
    { name: 'Id', type: 4, num: 0, varNum: 0, fixed: true, fixedOffset: 0, size: 4 },
    { name: 'Name', type: 10, num: 1, varNum: 0, fixed: false, fixedOffset: 0, size: 255 },
    { name: 'Other', type: 10, num: 2, varNum: 1, fixed: false, fixedOffset: 0, size: 255 }] };
  tdef.byName = {}; tdef.cols.forEach(c => { tdef.byName[c.name] = c; });
  const sp = jet.rowSpan(page, 0);
  eq([sp.start, sp.end, sp.deleted], [start, PG, false], 'rowSpan of the single row');
  const out = [];
  eq(jet.decodeRow(tdef, page, sp.start, sp.end, [tdef.byName.Name, tdef.byName.Id, tdef.byName.Other], out), true, 'decodeRow ok');
  eq(out, ['hi', '42', null], 'decoded fields in wanted order');
})();

// ---------- reference comparison
const mdbPath = process.argv[2], refDir = process.argv[3];
const only = process.argv.slice(4);
if (!mdbPath) { finish(); }
else (async () => {
  const fd = fs.openSync(mdbPath, 'r'); const size = fs.fstatSync(fd).size;
  const src = { size, read: (o, l) => { const b = Buffer.alloc(Math.min(l, size - o)); fs.readSync(fd, b, 0, b.length, o); return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); } };
  const db = await jet.open(src);
  console.log('opened', path.basename(mdbPath), db.signature, 'v' + db.version, 'tables:', db.tableNames().filter(n => !/^MSys/.test(n)).join(', '));
  const tables = only.length ? only : ['Sensitivity', 'MCBiasResults', 'MuxAuxPSResults', 'OscillationResults', 'SCPreResults', 'NoiseResults', 'BTEResults', 'MEMSCurrentResults', 'MEMSSCResults'];
  for (const name of tables) {
    if (!db.tables.has(name)) { console.log('skip', name, '(not in database)'); continue; }
    const t0 = Date.now();
    const tdef = await db.table(name);
    const refFile = refDir && findRef(refDir, name);
    if (!refFile) { // count only
      let n = 0; const st = await db.scan(tdef, [], () => { n++; });
      console.log(name, 'rows', n, 'tdef.numRows', tdef.numRows, JSON.stringify(st), (Date.now() - t0) + ' ms');
      eq(n, tdef.numRows, name + ': scanned rows equal the TDEF row count');
      continue;
    }
    // reference header
    const refHeader = await readHeader(refFile);
    const names = tdef.cols.map(c => c.name);
    eq(names.slice().sort(), refHeader.slice().sort(), name + ': column names match the Access export');
    // index the JS rows by AutoNumber: hash of the joined row (strings only for small tables)
    const idIdx = refHeader.indexOf('AutoNumber');
    const small = tdef.numRows < 250000;
    // (an AutoNumber can occur twice in a damaged table, so each id maps to a list of row hashes)
    const jsRows = new Map(); let nJs = 0, dupJs = 0;
    const st = await db.scan(tdef, refHeader, f => {
      nJs++;
      const key = f[idIdx];
      const joined = f.map(v => v === null ? '' : v).join('\u0001');
      const list = jsRows.get(key);
      const val = small ? joined : fnv(joined);
      if (list) { dupJs++; list.push(val); } else jsRows.set(key, [val]);
    });
    const tJs = Date.now() - t0;
    // stream the reference CSV (header row skipped)
    let nRef = 0, mismatch = 0, missingInJs = 0; const examples = [];
    await streamCsv(refFile, (fields) => {
      nRef++;
      const key = fields[idIdx];
      const joined = fields.join('\u0001');
      const list = jsRows.get(key);
      if (!list) { missingInJs++; if (examples.length < 10) examples.push({ id: key, ref: joined, js: '(missing)' }); return; }
      const want = small ? joined : fnv(joined);
      const at = list.indexOf(want);
      if (at < 0) { mismatch++; if (examples.length < 10) examples.push({ id: key, ref: joined, js: small ? list.join(' || ') : '(hash differs)' }); list.shift(); }
      else list.splice(at, 1);
      if (!list.length) jsRows.delete(key);
    });
    const count = refDir && readCount(refDir, name);
    console.log(`${name}: js ${nJs} rows (${tJs} ms, dup ids ${dupJs}, ${JSON.stringify(st)}), ref ${nRef} rows${count !== null ? ' (count file ' + count + ')' : ''}`);
    eq(nJs, nRef, name + ': row count equals the Access export');
    eq(mismatch, 0, name + ': no field mismatches');
    eq(missingInJs, 0, name + ': every exported row found');
    eq(jsRows.size, 0, name + ': no extra rows in the JS scan');
    if (jsRows.size) { let k = 0; for (const [id, v] of jsRows) { if (k++ >= 10) break; console.log('  extra in js:', id, small ? v : '(hash)'); } }
    examples.forEach(e => console.log('  mismatch id', e.id, '\n    ref', e.ref.replace(/\u0001/g, ' | '), '\n    js ', e.js.replace(/\u0001/g, ' | ')));
  }
  finish();
})().catch(e => { console.error('ERROR', e); process.exit(1); });

function finish() { console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASSED'); process.exit(fails ? 1 : 0); }
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; }
function findRef(dir, table) {
  const cands = fs.readdirSync(dir).filter(f => f.toLowerCase() === (table + '.csv').toLowerCase() || f.toLowerCase().endsWith('_' + table.toLowerCase() + '.csv'));
  return cands.length ? path.join(dir, cands[0]) : null;
}
function readCount(dir, table) {
  const c = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(table.toLowerCase() + '.count.txt'));
  return c.length ? parseInt(fs.readFileSync(path.join(dir, c[0]), 'utf8'), 10) : null;
}
async function readHeader(file) { let h = null; await streamCsv(file, () => false, (f) => { h = f; return false; }); return h; }
/* Minimal streaming CSV reader for the exporter's output (every field quoted, "" escapes, CRLF).
 * onHeader (optional) gets the first record; onRow every later one. Returning false stops the read. */
async function streamCsv(file, onRow, onHeader) {
  const rs = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 22 });
  let carry = '', first = true, stop = false;
  for await (const chunk of rs) {
    let text = carry + chunk, i = 0, n = text.length, fields = [], fieldStart = 0, inQ = false, lastComplete = 0;
    while (i < n && !stop) {
      const c = text.charCodeAt(i);
      if (inQ) { if (c === 34) { if (i + 1 < n && text.charCodeAt(i + 1) === 34) { i += 2; continue; } inQ = false; } i++; continue; }
      if (c === 34 && i === fieldStart) { inQ = true; i++; continue; }
      if (c === 44 || c === 10 || c === 13) {
        let f = text.substring(fieldStart, i);
        if (f.length >= 2 && f[0] === '"' && f[f.length - 1] === '"') f = f.substring(1, f.length - 1).replace(/""/g, '"');
        fields.push(f);
        if (c === 44) { i++; fieldStart = i; continue; }
        if (c === 13 && i + 1 < n && text.charCodeAt(i + 1) === 10) i++;
        i++;
        if (!(fields.length === 1 && fields[0] === '')) {
          if (first) { first = false; if (onHeader && onHeader(fields) === false) stop = true; }
          else if (onRow(fields) === false) stop = true;
        }
        fields = []; fieldStart = i; lastComplete = i;
        continue;
      }
      i++;
    }
    if (stop) { rs.destroy(); return; }
    carry = text.substring(lastComplete);
  }
  if (carry.trim()) { // last line without newline
    const fields = carry.replace(/\r?\n$/, '').split(',').map(f => f.length >= 2 && f[0] === '"' ? f.substring(1, f.length - 1).replace(/""/g, '"') : f);
    if (first) { first = false; if (onHeader) onHeader(fields); } else onRow(fields);
  }
}

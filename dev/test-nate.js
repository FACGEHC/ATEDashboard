// Checks a database produced by tools/atml_to_mdb.ps1 with the dashboard's own Jet reader:
//   node dev/test-nate.js <NATE.mdb> [<_csv_ folder written with -KeepCsv>]
// 1. every table is readable by js/jet-core.js and (with the CSV folder) matches the converter's
//    CSV copies row for row (AutoNumber order = write order; MEMO columns are compared too);
// 2. js/parse-core.js loads the database like the browser would and reports a dataset per
//    populated measurement table with the same row counts.
// How it works: the .mdb is opened through jet.fileSource over a Node file shim (slice -> arrayBuffer),
// every user table is scanned in full and sorted by AutoNumber; the CSV copy is parsed with a small
// quote-aware reader and compared cell for cell. parse-core then loads the same file via parseMdb (the
// browser worker path) and, with the CSV folder, each per-table CSV and the <machine>.csv bundle via
// parseFile. Exit code 1 and "N FAILURES" on any difference, else "ALL CHECKS PASSED".
const fs = require('fs');
const path = require('path');
const cateJetCore = require('../js/jet-core.js');
const cateParseCore = require('../js/parse-core.js');

const mdb = process.argv[2];
const csvDir = process.argv[3];
if (!mdb) { console.error('usage: node dev/test-nate.js <NATE.mdb> [<csv folder>]'); process.exit(2); }
let fails = 0;
// Counts a failure and prints the first 40 messages.
function fail(msg) { fails++; if (fails <= 40) console.error('FAIL', msg); }

// Minimal in-memory CSV parser (quoted fields, "" escapes, CR ignored); returns an array of rows.
function parseCsv(text) {
  const rows = []; let row = [], field = '', i = 0, q = false;
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { q = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Locates the converter's CSV copy of a table in the csv folder (null without a folder or file).
function findCsv(table) {           // <Table>.csv or <machine>_<Table>.csv
  if (!csvDir) return null;
  const hit = fs.readdirSync(csvDir).find(n => n.toLowerCase() === (table + '.csv').toLowerCase() || n.toLowerCase().endsWith('_' + table.toLowerCase() + '.csv'));
  return hit ? path.join(csvDir, hit) : null;
}
// Wraps a file on disk as the subset of the browser File API that jet-core and parse-core use:
// {name, size, slice(a, b).arrayBuffer()} backed by fs.readSync.
function nodeFile(p) {
  const fd = fs.openSync(p, 'r'), size = fs.statSync(p).size;
  return { name: path.basename(p), size, slice: (a, b) => ({ arrayBuffer: () => { const buf = Buffer.alloc(Math.min(b, size) - a); fs.readSync(fd, buf, 0, buf.length, a); return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)); } }) };
}

// Main flow: Jet scan + CSV comparison per table, then the parse-core mdb, per-table CSV and bundle paths.
(async () => {
  const jet = cateJetCore();
  const file = nodeFile(mdb);
  const db = await jet.open(jet.fileSource(file));
  const tables = db.tableNames().filter(n => !/^MSys/.test(n)).sort();
  console.log('tables:', tables.join(', '));
  const counts = {};
  for (const t of tables) {
    const tdef = await db.table(t);
    const names = tdef.cols.map(c => c.name);
    const rows = [];
    const stats = await db.scan(tdef, names, f => rows.push(f.map(v => v === null ? '' : String(v))), { batchPages: 256 });
    counts[t] = rows.length;
    console.log(`  ${t.padEnd(22)} ${String(rows.length).padStart(8)} rows  (tdef numRows ${tdef.numRows}, pages ${stats.pages}, deleted ${stats.deleted})`);
    if (rows.length !== tdef.numRows) fail(`${t}: scanned ${rows.length} rows but the table definition says ${tdef.numRows}`);
    if (!csvDir) continue;
    const p = findCsv(t);
    if (!p) { fail(`no CSV copy for ${t}`); continue; }
    const csv = parseCsv(fs.readFileSync(p, 'utf8'));
    const header = csv[0], data = csv.slice(1);
    const colIdx = header.map(h => names.indexOf(h));
    if (colIdx.some(i => i < 0)) { fail(`${t}: CSV columns ${header.join(',')} not all present in the table (${names.join(',')})`); continue; }
    if (data.length !== rows.length) { fail(`${t}: CSV has ${data.length} rows, table has ${rows.length}`); continue; }
    const an = names.indexOf('AutoNumber');
    rows.sort((a, b) => Number(a[an]) - Number(b[an]));
    let bad = 0;
    for (let r = 0; r < data.length; r++) {
      for (let c = 0; c < header.length; c++) {
        const want = data[r][c], got = rows[r][colIdx[c]];
        if (want !== got) { bad++; if (bad <= 5) fail(`${t} row ${r + 1} ${header[c]}: table ${JSON.stringify(got)} csv ${JSON.stringify(want)}`); }
      }
    }
    if (!bad) console.log(`  ${''.padEnd(22)} matches the CSV copy field for field`);
  }

  // the dashboard parser path
  const core = cateParseCore();
  const seen = {}; const empties = []; const errors = [];
  await core.parseMdb(file, msg => {
    if (msg.type === 'dataset') seen[msg.measurement] = msg;
    else if (msg.type === 'tablesEmpty') empties.push(...msg.measurements);
    else if (msg.type === 'tableError') errors.push(msg);
    else if (msg.type === 'error') errors.push(msg);
  }, { jet });
  console.log('parse-core datasets:', Object.keys(seen).map(k => `${k}=${seen[k].n}`).join(', ') || '(none)');
  if (empties.length) console.log('parse-core empty tables:', empties.join(', '));
  errors.forEach(e => fail('parse-core: ' + (e.table || '') + ' ' + e.message));
  const M = core.MEASUREMENTS;
  for (const k of core.MEASUREMENT_ORDER) {
    const t = M[k].table;
    if (!(t in counts)) continue;
    if (counts[t] === 0) { if (!empties.includes(k)) fail(`${k}: empty table not reported as empty`); continue; }
    if (!seen[k]) { fail(`${k}: table ${t} has ${counts[t]} rows but no dataset was produced`); continue; }
    if (seen[k].n !== counts[t]) fail(`${k}: dataset has ${seen[k].n} rows, table ${t} has ${counts[t]}`);
    const u = seen[k].dicts.units; console.log(`  ${k.padEnd(14)} ${String(seen[k].n).padStart(8)} rows, units ${JSON.stringify(u)}, coils ${seen[k].dicts.coil.length}, ports ${JSON.stringify(seen[k].dicts.port)}`);
  }
  // the dashboard CSV path: every measurement CSV must detect its table from the file name and keep the same rows as the .mdb
  if (csvDir) {
    for (const k of core.MEASUREMENT_ORDER) {
      const t = M[k].table, p = findCsv(t);
      if (!p || !(t in counts) || counts[t] === 0) continue;
      let ds = null, err = null;
      await core.parseFile(nodeFile(p), msg => { if (msg.type === 'dataset') ds = msg; else if (msg.type === 'error') err = msg.message; }, { fileName: path.basename(p) });
      if (err) { fail(`csv ${path.basename(p)}: ${err}`); continue; }
      if (!ds) { fail(`csv ${path.basename(p)}: no dataset`); continue; }
      if (ds.measurement !== k) fail(`csv ${path.basename(p)}: detected as ${ds.measurement}, expected ${k}`);
      if (ds.n !== counts[t]) fail(`csv ${path.basename(p)}: ${ds.n} rows, table has ${counts[t]}`);
      else console.log(`  csv ${path.basename(p).padEnd(34)} -> ${k.padEnd(14)} ${String(ds.n).padStart(8)} rows (same as the table)`);
    }
  }
  // the all-tables bundle (<machine>.csv) must load every measurement table like the .mdb
  if (csvDir) {
    const bundleName = fs.readdirSync(csvDir).find(n => /^[A-Za-z]+\d{4}(_[A-Za-z]+)?\.csv$/i.test(n) && !/_(Results|Sensitivity|IdentifyCoil|SourceFiles|SkippedFiles)\.csv$/i.test(n));
    if (!bundleName) fail('no bundle <machine>.csv in ' + csvDir);
    else {
      const got = {}; let err = null;
      await core.parseFile(nodeFile(path.join(csvDir, bundleName)), msg => { if (msg.type === 'dataset') got[msg.measurement] = msg.n; else if (msg.type === 'error') err = msg.message; }, { fileName: bundleName });
      if (err) fail(`bundle ${bundleName}: ${err}`);
      for (const k of core.MEASUREMENT_ORDER) {
        const t = M[k].table;
        if (!(t in counts) || counts[t] === 0) continue;
        if (got[k] !== counts[t]) fail(`bundle ${bundleName}: ${k} ${got[k]} rows, table has ${counts[t]}`);
      }
      console.log(`  bundle ${bundleName}: ${Object.keys(got).map(k => k + '=' + got[k]).join(', ')}`);
    }
  }
  console.log(fails ? `${fails} FAILURES` : 'ALL CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

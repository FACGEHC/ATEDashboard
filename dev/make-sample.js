// Builds dev/sample-data.js: small CSV excerpts of the real files for browser render tests.
//   node dev/make-sample.js ../data [../data/ref/CATE1001]
// Emits window.SAMPLE_CSV (machine -> Sensitivity CSV text, legacy) and window.SAMPLE_FILES
// ([{name, text}] including per-table CSVs exported from CATE_1001.mdb with tools/export_mdb.ps1).
// Arguments: <data dir> (default ../../data), <CATE1001 ref dir> (default <data>/ref/CATE1001, the per-table
// CSVs written by tools/export_mdb.ps1) and <EVO1002 ref dir> (default <data>/ref/EVO1002).
// How it works: each source CSV is streamed line by line (latin1, so bytes round-trip unchanged); the header
// line is always kept and every data line passes through a keep* predicate that selects a few coils and a
// short date window, which keeps the sample small while still exercising every measurement table.
// The result is consumed by dev/ui-test.html and dev/render-test.html through <script src="sample-data.js">;
// the file is generated, gitignored and must be rebuilt after the data exports change.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const dataDir = process.argv[2] || path.join(__dirname, '..', '..', 'data');
const refDir = process.argv[3] || path.join(dataDir, 'ref', 'CATE1001');
const evoRef = process.argv[4] || path.join(dataDir, 'ref', 'EVO1002');

// Row filter for TestCase tables (Sensitivity, MCBias, Oscillation) of the CATE machines: true when the
// quoted CoilName / TimeDate / TestCase fields of the raw CSV line fall into the sampled coils and dates.
function keepTc(line) {
  // 1.5T GEM PA, 2026, TestCase 1 or 2 ; 1.5T GEM HNU Sep/Oct 2026 ; 3T Kizuna Breast Coil Sep/Oct 2026
  if (line.includes('"1.5T GEM PA"') && /"\d{1,2}\/\d{1,2}\/2026 /.test(line) && /2026 [^"]*","[12]",/.test(line)) return true;
  if (line.includes('"1.5T GEM HNU"') && /"(9|10)\/\d{1,2}\/2026 /.test(line)) return true;
  if (line.includes('"3T Kizuna Breast Coil"') && /"(9|10)\/\d{1,2}\/2026 /.test(line)) return true;
  return false;
}
// Row filter for NetName tables (MuxAuxPS, SCPre): same coils and dates, no TestCase condition.
function keepNet(line) {
  if (line.includes('"1.5T GEM PA"') && /"\d{1,2}\/\d{1,2}\/2026 /.test(line)) return true;
  if (line.includes('"1.5T GEM HNU"') && /"(9|10)\/\d{1,2}\/2026 /.test(line)) return true;
  return false;
}
// Row filter for the EVO1002 tables; the TestCase condition only applies to lines that have a numeric
// TestCase field after the date (NetName tables pass on coil and date alone).
function keepEvo(line) {
  // EVO1002: 1.5T GEM PA all of 2026 (TestCase 1-2 for TestCase tables), 48CH Head Posterior Sep/Oct 2026
  if (line.includes('"1.5T GEM PA"') && /"\d{1,2}\/\d{1,2}\/2026 /.test(line) && (!/2026 [^"]*","\d+","/.test(line) || /2026 [^"]*","[12]",/.test(line))) return true;
  if (line.includes('"48CH Head Posterior Non-MEMS"') && /"(9|10)\/\d{1,2}\/2026 /.test(line)) return true;
  return false;
}

// Streams one CSV file and returns the header line plus every data line accepted by keep(line).
async function excerpt(file, keep) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'latin1' }) });
  const lines = [];
  let first = true;
  for await (const line of rl) {
    if (first) { lines.push(line); first = false; continue; }
    if (keep(line)) lines.push(line);
  }
  return lines;
}

// Builds the two globals: SAMPLE_CSV (machine -> Sensitivity CSV text) from the four CATE machine exports,
// SAMPLE_FILES (every excerpt as {name, text}, named so the dashboard detects machine and table), then writes
// dev/sample-data.js. Missing source files are reported and skipped.
(async () => {
  const csv = {}, files = [];
  for (const name of ['CATE1001', 'CATE1007', 'CATE1003', 'CATE1006']) {
    const file = path.join(dataDir, name + '.csv');
    if (!fs.existsSync(file)) continue;
    const lines = await excerpt(file, keepTc);
    csv[name] = lines.join('\n') + '\n';
    files.push({ name: name + '.csv', text: csv[name] });
    console.log(name, lines.length - 1, 'rows');
  }
  for (const t of ['MCBiasResults', 'MuxAuxPSResults', 'OscillationResults', 'SCPreResults']) {
    const file = path.join(refDir, 'CATE1001_' + t + '.csv');
    if (!fs.existsSync(file)) { console.log('missing', file); continue; }
    const lines = await excerpt(file, /Net|SCPre|MuxAux/.test(t) ? keepNet : keepTc);
    files.push({ name: 'CATE1001_' + t + '.csv', text: lines.join('\n') + '\n' });
    console.log(t, lines.length - 1, 'rows');
  }
  for (const t of ['NoiseResults', 'MCBiasResults', 'OscillationResults', 'MuxAuxPSResults']) {
    const file = path.join(evoRef, 'EVO1002_' + t + '.csv');
    if (!fs.existsSync(file)) { console.log('missing', file); continue; }
    const lines = await excerpt(file, keepEvo);
    files.push({ name: 'EVO1002_' + t + '.csv', text: lines.join('\n') + '\n' });
    console.log('EVO1002 ' + t, lines.length - 1, 'rows');
  }
  fs.writeFileSync(path.join(__dirname, 'sample-data.js'),
    'window.SAMPLE_CSV = ' + JSON.stringify(csv) + ';\n' +
    'window.SAMPLE_FILES = ' + JSON.stringify(files) + ';\n');
})();

// Node test for parse-core.js:  node dev/test-parse.js [path/to/CATE1007.csv]
const path = require('path');
const fs = require('fs');
const cateParseCore = require('../js/parse-core.js');
const core = cateParseCore();

let fails = 0;
function eq(a, b, msg) {
  const ok = (Number.isNaN(a) && Number.isNaN(b)) || a === b || JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { fails++; console.error('FAIL', msg, '\n  got     ', a, '\n  expected', b); }
  else console.log('ok  ', msg);
}

// --- date parser
const U = (y, m, d, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s);
eq(core.parseDate('4/3/2024 10:03:23 AM'), U(2024, 4, 3, 10, 3, 23), 'basic AM');
eq(core.parseDate('12/7/2016 10:35:26 AM'), U(2016, 12, 7, 10, 35, 26), 'two-digit month');
eq(core.parseDate('9/23/2026 8:02:21 PM'), U(2026, 9, 23, 20, 2, 21), 'PM');
eq(core.parseDate('1/1/2026 12:00:00 AM'), U(2026, 1, 1, 0, 0, 0), '12 AM = midnight');
eq(core.parseDate('1/1/2026 12:30:00 PM'), U(2026, 1, 1, 12, 30, 0), '12 PM = noon');
eq(core.parseDate('2/29/2024 1:00:00 AM'), U(2024, 2, 29, 1), 'leap day ok');
eq(core.parseDate('2/29/2023 1:00:00 AM'), NaN, 'non-leap feb 29 rejected');
eq(core.parseDate('4/3/2024 10:03:23'), NaN, 'missing AM/PM rejected');
eq(core.parseDate('4/3/2024'), NaN, 'date only rejected');
eq(core.parseDate('2024-04-03 10:03:23'), NaN, 'ISO rejected');
eq(core.parseDate(''), NaN, 'empty rejected');
eq(core.parseDate('4/3/2024 10:03:23 AM x'), NaN, 'trailing junk rejected');

// --- numbers
eq(core.parseNum('-92.98'), -92.98, 'number');
eq(core.parseNum('NA'), NaN, 'NA -> NaN');
eq(core.parseNum(''), NaN, 'empty -> NaN (not 0)');
eq(core.parseNum('abc'), NaN, 'junk -> NaN');

// --- scanner
function records(text) { const out = []; const consumed = core.scan(text, f => out.push(f)); return { out, consumed }; }
let r = records('a,b,c\n1,"x, y",3\n');
eq(r.out, [['a', 'b', 'c'], ['1', 'x, y', '3']], 'comma inside quotes');
eq(r.consumed, 'a,b,c\n1,"x, y",3\n'.length, 'consumed all');
r = records('a,"he said ""hi""",c\r\n');
eq(r.out, [['a', 'he said "hi"', 'c']], 'escaped quotes + CRLF');
r = records('a,b\n1,"unterminated');
eq(r.out, [['a', 'b']], 'partial quoted record not emitted');
eq(r.consumed, 4, 'consumed stops before partial record');
r = records('a,b\n1,2');
eq(r.out, [['a', 'b']], 'partial unquoted record not emitted');
r = records('a,,c\n');
eq(r.out, [['a', '', 'c']], 'empty field');
r = records('"",x\n');
eq(r.out, [['', 'x']], 'empty quoted field');
r = records('\n\na,b\n');
eq(r.out, [['a', 'b']], 'blank lines skipped');

// --- chunk-boundary robustness: parse a synthetic file with tiny chunks
async function parseBlob(blob, chunkSize, opts) {
  const msgs = [];
  await core.parseFile(blob, (m) => msgs.push(m), Object.assign({ chunkSize }, opts || {}));
  const ds = msgs.filter(m => m.type === 'dataset')[0];
  if (ds) { ds.messages = msgs.map(m => m.type); return ds; }
  return msgs[msgs.length - 1];
}
// --- measurement detection
eq(core.detectMeasurement('CATE1001.csv', ['CoilName', 'TestCase', 'Channel', 'Element', 'Measurement', 'LSL', 'USL', 'Units']), null, 'detect: plain TestCase table is decided by units');
eq(core.detectMeasurement('CATE1001_MCBiasResults.csv', ['CoilName', 'TestCase']), 'MCBias', 'detect: file-name token wins');
eq(core.detectMeasurement('x.csv', ['CoilName', 'NetName', 'LSL', 'USL', 'Measurement']), 'MuxAuxPS', 'detect: NetName + USL');
eq(core.detectMeasurement('x.csv', ['CoilName', 'NetName', 'LSL', 'Measurement']), 'SCPre', 'detect: NetName without USL');
eq(core.detectMeasurement('x.csv', ['CoilName', 'TestCase', 'Measurement', 'USL', 'Frequency']), 'Oscillation', 'detect: Frequency column');
eq(core.detectMeasurement('x.csv', ['CoilName', 'TestCase', 'Measurement', 'USL']), 'Oscillation', 'detect: TestCase without LSL');
eq(!!core.detectMeasurement('x.csv', ['A', 'B']).error, true, 'detect: unknown header -> error');
eq(core.detectMeasurement('EVO1002_NoiseResults.csv', ['CoilName']), 'Noise', 'detect: Noise by file name');
eq(core.detectMeasurement('x.csv', ['CoilName', 'TestCase', 'Baseline', 'Measurement', 'LSL', 'Difference', 'USL']), 'Noise', 'detect: Noise by Difference + Baseline');
eq(core.detectMeasurement('x.csv', ['CoilName', 'TestedLine', 'LSL', 'Measurement', 'USL']), 'BTE', 'detect: TestedLine + USL -> BTE');
eq(core.detectMeasurement('x.csv', ['CoilName', 'TestedLine', 'LSL', 'Measurement']), 'MEMSSC', 'detect: TestedLine without USL -> MEMSSC');
eq(core.detectMeasurement('EVO1001_MEMSCurrentResults.csv', ['CoilName', 'TestedLine']), 'MEMSCurrent', 'detect: MEMSCurrent by file name');
eq(core.detectMeasurement('subtest_data.csv', ['CoilName', 'TestCase', 'LSL', 'USL']), null, 'detect: "bte" inside another word is not a token');
(async () => {
  const header = '"AutoNumber","CoilName","CoilSN","CoilPN","Mode","Operator","TimeDate","TestCase","Channel","Element","Measurement","LSL","USL","PassFail","Units"\r\n';
  const rows = [
    '1,"1.5T AIR AA, 30CH Coil","0047","p","1","op","4/3/2024 10:03:23 AM","1","5","L1","-92.98","-25.00","NA","FAIL","dB"',
    '2,"1.5T AIR AA, 30CH Coil","47","p","1","op","4/3/2024 10:03:23 AM","2","5","L1","-85.81","NA","-40.00","PASS","dB"',
    '3,"Coil X","NA","p","Post. Coil ID Check","op","4/3/2024 10:03:23 AM","2","5","L1","-85.81","NA","-40.00","PASS","dB"',
    '4,"Coil X","9","p","1","op","bad date","2","5","L1","-85.81","NA","-40.00","PASS","dB"',
    '5,"Coil X","9","p","1","op","4/3/2024 10:03:23 AM","2","5","L1","","NA","-40.00","PASS","dB"',
    '6,"Coil ""Q""","9","p","1","op","5/3/2024 1:03:23 PM","2","5","E1 RT","-1.5","NA","-40.00","PASS","dB"',
  ];
  const text = '﻿' + header + rows.join('\r\n');  // BOM, no trailing newline
  const buf = Buffer.from(text, 'utf8');
  for (const cs of [7, 64, 1 << 20]) {
    const done = await parseBlob(new Blob([buf]), cs);
    eq(done.type, 'dataset', `chunk ${cs}: dataset message`);
    eq(done.messages[done.messages.length - 1], 'done', `chunk ${cs}: done after dataset`);
    eq(done.measurement, 'Sensitivity', `chunk ${cs}: Sensitivity by units`);
    eq(done.n, 3, `chunk ${cs}: 3 rows kept`);
    eq(Array.from(done.columns.net), [-1, -1, -1], `chunk ${cs}: net = -1 for a TestCase table`);
    eq(done.dicts.units, ['dB'], `chunk ${cs}: units dict`);
    eq(done.stats.dropped, { badDate: 1, badMeasurement: 1, badTestCase: 0, nullKey: 0, excludedMode: 1, shortRow: 0 }, `chunk ${cs}: drop reasons`);
    eq(done.dicts.coil, ['1.5T AIR AA, 30CH Coil', 'Coil "Q"'], `chunk ${cs}: coil dict`);
    eq(done.dicts.elem, ['L1', 'E1 RT'], `chunk ${cs}: elem dict`);
    eq(Array.from(done.columns.tc), [1, 2, 2], `chunk ${cs}: tc`);
    eq(Number.isNaN(done.columns.usl[0]) && done.columns.usl[1] === -40, true, `chunk ${cs}: NA spec -> NaN`);
    eq(done.stats.encoding, 'utf-8', `chunk ${cs}: utf-8`);
  }
  // cp1252 fallback: 0xA0 byte in CoilPN
  const bad = Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from('7,"C","1","', 'utf8'), Buffer.from([0xA0]), Buffer.from('p","1","op","4/3/2024 10:03:23 AM","1","5","5","-1","NA","NA","PASS","dB"\n', 'utf8')]);
  const done2 = await parseBlob(new Blob([bad]), 16);
  eq(done2.stats.encoding, 'windows-1252', 'cp1252 fallback engaged');
  eq(done2.n, 1, 'cp1252 row kept');

  // MCBias by units; MuxAuxPS (NetName) table; SCPre with swapped PassFail/Units and no USL column
  const mc = await parseBlob(new Blob([header + '1,"C","1","p","All Modes","op","4/3/2024 10:03:23 AM","1","14","L1/L3","3.547","3.140","3.910","PASS","V"\n']), 1 << 20);
  eq(mc.measurement, 'MCBias', 'MCBias detected from units V');
  eq(mc.dicts.units, ['V'], 'MCBias units');
  const muxHdr = '"AutoNumber","CoilName","CoilSN","CoilPN","Mode","Operator","TimeDate","NetName","LSL","Measurement","USL","PassFail","Units"\n';
  const mux = await parseBlob(new Blob([muxHdr + '1,"1.5T GEM PA","00901","p","All Modes","op","1/6/2017 8:05:11 AM","P_MUX1","-0.002","0.000","0.007","PASS","A"\n2,"1.5T GEM PA","00901","p","All Modes","op","1/6/2017 8:05:12 AM","NA","-0.002","0.000","0.007","PASS","A"\n']), 1 << 20);
  eq(mux.measurement, 'MuxAuxPS', 'MuxAuxPS detected from NetName + USL');
  eq(mux.n, 1, 'MuxAuxPS: NA NetName dropped');
  eq(mux.stats.dropped.nullKey, 1, 'MuxAuxPS: nullKey counted');
  eq(mux.dicts.net, ['P_MUX1'], 'MuxAuxPS: net dict');
  eq(Array.from(mux.columns.tc), [-1], 'MuxAuxPS: tc = -1');
  eq(mux.columns.usl[0], 0.007, 'MuxAuxPS: USL');
  const scHdr = '"AutoNumber","CoilName","CoilSN","CoilPN","Mode","Operator","TimeDate","NetName","LSL","Measurement","PassFail","Units"\n';
  const sc = await parseBlob(new Blob([scHdr + '1,"C","b","p","Head 36","op","12/8/2016 12:51:20 PM","10_V_AUX_P_A","1.000","1.871","V","PASS"\n2,"C","b","p","Head 36","op","12/8/2016 12:51:21 PM","10_V_AUX_P_A","1.000","1.871","PASS","V"\n']), 1 << 20);
  eq(sc.measurement, 'SCPre', 'SCPre detected (NetName, no USL)');
  eq(sc.dicts.units, ['V'], 'SCPre: units taken from whichever column is not PASS/FAIL');
  eq(Number.isNaN(sc.columns.usl[0]), true, 'SCPre: missing USL column -> NaN');
  eq(sc.columns.lsl[0], 1, 'SCPre: LSL kept');
  // forced measurement + short-row guard still works with optional columns absent
  const osc = await parseBlob(new Blob(['"CoilName","CoilSN","Mode","TimeDate","TestCase","Channel","Element","Measurement","USL"\n"C","1","M","4/3/2024 10:03:23 AM","1","21","1","-41.19","20.00"\n"C","1","M","4/3/2024 10:03:23 AM","1"\n']), 1 << 20);
  eq(osc.measurement, 'Oscillation', 'Oscillation detected (TestCase, no LSL)');
  eq(osc.n, 1, 'Oscillation: 1 row kept'); eq(osc.stats.dropped.shortRow, 1, 'Oscillation: short row dropped');

  // EVO Noise: plotted value is Difference, Measurement/Baseline kept as extras, Port stored, units forced to dB
  const noiseHdr = '"AutoNumber","CoilName","CoilSN","CoilPN","Mode","Operator","TimeDate","TestCase","Channel","Element","Baseline","Measurement","LSL","Difference","USL","PassFail","Units","Port"\n';
  const noise = await parseBlob(new Blob([noiseHdr +
    '1,"1.5T AIR MP M","01367-302693331","p","1","op","2/24/2026 3:22:05 PM","1","1","1","-147.50","-128.24","15.00","19.26","23.50","PASS","dBm/Hz","1"\n' +
    '2,"1.5T AIR MP M","01367-302693331","p","1","op","2/24/2026 3:22:06 PM","2","1","1","-147.50","-121.52","NA","25.98","NA","NA","dBm/Hz","2"\n']), 1 << 20);
  eq(noise.measurement, 'Noise', 'Noise detected'); eq(noise.n, 2, 'Noise: 2 rows kept');
  eq(Array.from(noise.columns.meas), [19.26, 25.98], 'Noise: Difference is the plotted value');
  eq(noise.columns.lsl[0], 15 && noise.columns.usl[0] === 23.5 ? 15 : -1, 'Noise: LSL/USL kept');
  eq(Number.isNaN(noise.columns.lsl[1]), true, 'Noise: NA limits -> NaN');
  eq(Array.from(noise.columns.extras.Measurement), [-128.24, -121.52], 'Noise: extras.Measurement');
  eq(Array.from(noise.columns.extras.Baseline), [-147.5, -147.5], 'Noise: extras.Baseline');
  eq(noise.dicts.units, ['dB'], 'Noise: units forced to dB (Units column describes the raw measurement)');
  eq(noise.dicts.port, ['1', '2'], 'Noise: port dict'); eq(Array.from(noise.columns.port), [0, 1], 'Noise: port ids');
  // EVO Oscillation carries Frequency; CATE-style rows without Port get port -1
  const oscE = await parseBlob(new Blob(['"CoilName","CoilSN","Mode","TimeDate","TestCase","Channel","Element","Measurement","USL","PassFail","Units","Frequency","Port"\n"C","1","1","2/24/2026 3:22:56 PM","1","1","1","-47.21","-30.00","PASS","dBm","60490000","1"\n']), 1 << 20);
  eq(oscE.measurement, 'Oscillation', 'EVO Oscillation detected'); eq(oscE.columns.extras.Frequency[0], 60490000, 'Oscillation: extras.Frequency'); eq(oscE.dicts.units, ['dBm'], 'Oscillation: dBm units from data');
  eq(Array.from(mux.columns.port), [-1], 'CATE rows without a Port column -> -1');
  // TestedLine tables (no data yet in the EVO files): schema accepted
  const bte = await parseBlob(new Blob(['"CoilName","CoilSN","Mode","TimeDate","TestedLine","LSL","Measurement","USL","PassFail","Units","Port"\n"C","1","1","2/24/2026 3:22:56 PM","LINE_A","0.5","0.7","0.9","PASS","V","2"\n']), 1 << 20);
  eq(bte.measurement, 'BTE', 'BTE detected'); eq(bte.dicts.net, ['LINE_A'], 'BTE: TestedLine stored as the net key'); eq(bte.dicts.units, ['V'], 'BTE: units from data');

  // real file if given
  const real = process.argv[2];
  if (real) {
    const t0 = Date.now();
    const data = fs.readFileSync(real);
    const done3 = await parseBlob(new Blob([data]), 8 * 1024 * 1024);
    console.log(path.basename(real), 'rows kept', done3.n, 'read', done3.stats.rowsRead, 'enc', done3.stats.encoding,
      'dropped', JSON.stringify(done3.stats.dropped), 'coils', done3.dicts.coil.length,
      'tMin', new Date(done3.stats.tMin).toISOString(), 'tMax', new Date(done3.stats.tMax).toISOString(),
      `${Date.now() - t0} ms`);
  }
  // --- bundle CSV: several tables in one file, "#table=" markers (export_mdb.ps1 / atml_to_mdb.ps1 output)
  {
    const noiseB = '"AutoNumber","CoilName","CoilSN","CoilPN","Mode","Operator","TimeDate","TestCase","Channel","Element","Baseline","Measurement","LSL","Difference","USL","PassFail","Units","Port"\n' +
                   '"1","C","1","p","1","op","2/24/2026 3:22:05 PM","1","1","1","-147.50","-128.24","15.00","19.26","23.50","PASS","dBm/Hz","1"\n';
    const bundleText = '#table=Sensitivity\n' + header + '1,"C","1","p","All Modes","op","4/3/2024 10:03:23 AM","1","14","L1","-16.76","-18.48","NA","PASS","dB"\n' +
                       '#table=MCBiasCurrentResults\n' + header + '1,"C","1","p","All Modes","op","4/3/2024 10:03:23 AM","1","14","L1","0.12","-1000","1000","PASS","A"\n' +
                       '#table=NoiseResults\n' + noiseB +
                       '#table=SourceFiles\n"RunID","FileName","Rows"\n"u","f.xml","3"\n' +
                       '#table=BTEResults\n"CoilName","CoilSN","Mode","TimeDate","TestedLine","LSL","Measurement","USL","PassFail","Units","Port"\n';
    const msgs = [];
    await core.parseFile(new Blob([bundleText]), (m) => msgs.push(m), { chunkSize: 7, fileName: 'NATE1001.csv' });
    const ds = msgs.filter(m => m.type === 'dataset');
    eq(ds.map(d => d.measurement), ['Sensitivity', 'MCBiasCurrent', 'Noise'], 'bundle: one dataset per measurement table, in file order');
    eq(ds.map(d => d.n), [1, 1, 1], 'bundle: rows per table');
    eq(ds[1].dicts.units, ['A'], 'bundle: MCBiasCurrent detected from the marker, not from the units');
    eq(msgs.filter(m => m.type === 'tableSkipped').map(m => m.table), ['SourceFiles'], 'bundle: non-measurement table skipped');
    eq(msgs.filter(m => m.type === 'tablesEmpty').length, 1, 'bundle: empty BTE section reported empty');
    eq(msgs.some(m => m.type === 'error'), false, 'bundle: no error');
    eq(msgs[msgs.length - 1].type, 'done', 'bundle: done last');
    // two headers back to back without markers: second table detected from its columns
    const msgs2 = [];
    await core.parseFile(new Blob([header + '1,"C","1","p","All Modes","op","4/3/2024 10:03:23 AM","1","14","L1","-16.76","-18.48","NA","PASS","dB"\n' + muxHdr +
                                   '1,"C","1","p","All Modes","op","1/6/2017 8:05:11 AM","P_MUX1","-0.002","0.000","0.007","PASS","A"\n']), (m) => msgs2.push(m), { chunkSize: 1 << 20, fileName: 'CATE1001.csv' });
    eq(msgs2.filter(m => m.type === 'dataset').map(d => d.measurement), ['Sensitivity', 'MuxAuxPS'], 'bundle without markers: new header row starts a new table');
    // a plain single-table file still works as before (no marker, no second header)
    const single = await parseBlob(new Blob([header + '1,"C","1","p","All Modes","op","4/3/2024 10:03:23 AM","1","14","L1","-16.76","-18.48","NA","PASS","dB"\n']), 1 << 20);
    eq(single.measurement + '/' + single.n, 'Sensitivity/1', 'single-table CSV unchanged');
  }

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();

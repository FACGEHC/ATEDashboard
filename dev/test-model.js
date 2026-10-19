// Node end-to-end test: node --max-old-space-size=4096 dev/test-model.js ../data
// Loads all four CSVs, builds with the Python defaults, compares chart counts to All_Coil_RunCharts.
const fs = require('fs');
const path = require('path');
const cateParseCore = require('../js/parse-core.js');
const cateJetCore = require('../js/jet-core.js');
require('../js/ticks.js');
require('../js/model.js');
const CATE = globalThis.CATE;
const core = cateParseCore();

// --- machine names
let fails = 0;
eq(CATE.machineIndexFromName('CATE1001.csv'), 0, 'machine: CATE1001.csv');
eq(CATE.machineIndexFromName('CATE_1001.mdb'), 0, 'machine: CATE_1001.mdb');
eq(CATE.machineIndexFromName('CATE1001_MCBiasResults.csv'), 0, 'machine: per-table csv');
eq(CATE.machineIndexFromName('EVO1002_Data_Results.mdb'), CATE.MACHINES.indexOf('EVO1002'), 'machine: EVO1002 mdb');
eq(CATE.machineIndexFromName('evo1001.csv'), CATE.MACHINES.indexOf('EVO1001'), 'machine: lower-case EVO');
eq(CATE.machineIndexFromName('CATE1002.csv'), -1, 'machine: unknown number ignored');
eq(CATE.MACHINES.length, 7, 'seven machines');
eq(CATE.MACHINES.length, Object.keys(CATE.MACHINE_STYLE).length, 'every machine has a style');
eq(CATE.machineIndexFromName('NATE1001.mdb'), CATE.MACHINES.indexOf('NATE1001'), 'machine: NATE1001.mdb');
eq(CATE.machineIndexFromName('nate1001_trial.mdb'), CATE.MACHINES.indexOf('NATE1001'), 'machine: lower-case NATE');
eq(CATE.cleanSn('000835-302823625'), '835', 'cleanSn: dash form');
eq(CATE.cleanSn('00835'), '835', 'cleanSn: plain form');
eq(CATE.cleanSn('04211-302706899'), '4211', 'cleanSn: CATE dash form');
eq(CATE.cleanSn('0000'), '0000', 'cleanSn: all zeros kept');
eq(CATE.cleanSn('test'), 'test', 'cleanSn: text');
eq(CATE.machineFamily('EVO1002'), 'EVO', 'family: EVO'); eq(CATE.machineFamily('CATE1001'), 'CATE', 'family: CATE');
eq(CATE.machineFamily('NATE1001'), 'NATE', 'family: NATE');

function eq(a, b, msg) {
  const ok = (Number.isNaN(a) && Number.isNaN(b)) || a === b || JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { fails++; console.error('FAIL', msg, '\n  got     ', a, '\n  expected', b); } else console.log('ok  ', msg);
}
function near(a, b, eps, msg) { const ok = Math.abs(a - b) <= eps; if (!ok) { fails++; console.error('FAIL', msg, 'got', a, 'expected', b); } else console.log('ok  ', msg); }

// --- synthetic outlier / statistics checks
let d = CATE.detectOutliers([-5, -5.1, -4.9, -5.2, -4.8, -61], 3.5);
eq(Array.from(d.flags), [0, 0, 0, 0, 0, 2], 'detect: -61 flagged low');
near(d.median, -5.05, 1e-9, 'detect: median');
near(d.scale, 0.5, 1e-9, 'detect: floor scale 0.5 when MAD small');
eq(d.count, 1, 'detect: count 1');
eq(CATE.detectOutliers([-5, -5, -61, -5], 3.5).count, 0, 'detect: n<5 -> none');
eq(Array.from(CATE.detectOutliers([-5, -5, -5, -5, -5, -5, -7], 3.5).flags), [0, 0, 0, 0, 0, 0, 2], 'detect: MAD=0 floor flags -7');
eq(CATE.detectOutliers([-5, -5, -5, -5, -5, -5, -6.5], 3.5).count, 0, 'detect: MAD=0 floor keeps -6.5');
let s = CATE.describe([2, 4, 4, 4, 5, 5, 7, 9], 0, 10);
near(s.mean, 5, 1e-12, 'describe: mean'); near(s.median, 4.5, 1e-12, 'describe: median');
near(s.std, 2.138089935, 1e-6, 'describe: sample std'); eq(s.range, 7, 'describe: range');
eq(s.pass, 8, 'describe: pass'); near(s.cpk, 0.7795, 1e-3, 'describe: cpk');
s = CATE.describe([5], 0, 10); eq(Number.isNaN(s.std) && Number.isNaN(s.cpk), true, 'describe: n=1 std/cpk NaN');
s = CATE.describe([2, 4, 4, 4, 5, 5, 7, 9], NaN, 10); eq(Number.isNaN(s.cpl) && !Number.isNaN(s.cpu) && s.cpk === s.cpu, true, 'describe: one-sided -> cpu');

const dataDir = process.argv[2] || path.join(__dirname, '..', '..', 'data');
const refDir = process.argv[3] || path.join(__dirname, '..', '..', 'All_Coil_RunCharts');

async function load(file) {
  const m = CATE.machineIndexFromName(path.basename(file));
  const buf = fs.readFileSync(file);
  let done = null;
  const t0 = Date.now();
  await core.parseFile(new Blob([buf]), (msg) => { if (msg.type === 'dataset') done = msg; if (msg.type === 'error') throw new Error(msg.message); }, { fileName: path.basename(file) });
  const t1 = Date.now();
  CATE.model.addDataset(m, done.measurement, done);
  console.log(`${path.basename(file)} -> ${CATE.MACHINES[m]} ${done.measurement}: ${done.n} rows kept / ${done.stats.rowsRead} read, ${done.stats.encoding}, parse ${t1 - t0} ms, index ${Date.now() - t1} ms`);
}

(async () => {
  for (const f of ['CATE1001.csv', 'CATE1007.csv', 'CATE1003.csv', 'CATE1006.csv']) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) await load(p); else console.log('missing', p);
  }
  const T = CATE.ticks;
  const settings = {
    start: T.parseIsoDate(CATE.DEFAULTS.start), end: T.parseIsoDate(CATE.DEFAULTS.end),
    overrides: CATE.DEFAULTS.overrides.map(o => ({ coil: o.coil, start: T.parseIsoDate(o.start), end: o.end === 'today' ? T.todayUtc() : T.parseIsoDate(o.end) }))
  };
  const t0 = Date.now();
  const build = CATE.model.build(settings, 'Sensitivity');
  console.log(`build: ${build.coils.length} coils, ${build.totalCharts} charts, ${Date.now() - t0} ms`);
  eq(build.measurement, 'Sensitivity', 'build: measurement recorded');
  eq(CATE.model.build(settings, 'MCBias').totalCharts, 0, 'build: no MCBias data yet -> 0 charts');

  // compare with reference folder
  const manifest = [];
  for (const c of build.coils) {
    if (!c.groups.length) continue;
    const dir = path.join(refDir, c.safeName);
    let refCount = -1;
    if (fs.existsSync(dir)) {
      refCount = 0;
      for (const md of fs.readdirSync(dir)) {
        const mdp = path.join(dir, md);
        if (fs.statSync(mdp).isDirectory()) refCount += fs.readdirSync(mdp).filter(x => x.endsWith('.png')).length;
      }
    }
    const ok = refCount === c.groups.length;
    if (!ok && c.name !== '3T Kizuna Breast Coil') fails++;   // Kizuna: Python run was interrupted (5 of 16 PNGs)
    console.log(`${ok ? 'ok  ' : 'DIFF'} ${c.name.padEnd(28)} charts ${String(c.groups.length).padStart(4)} ref ${String(refCount).padStart(4)}  modes ${c.modes.join('/')}  rows ${c.rowCount}`);
    for (const g of c.groups) manifest.push(c.safeName + '/' + g.modeDir + '/' + g.fileName);
  }
  // manifest diff
  const refFiles = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d)) {
      const p = path.join(d, e);
      if (fs.statSync(p).isDirectory()) { if (!e.startsWith('_')) walk(p, rel ? rel + '/' + e : e); }
      else if (e.endsWith('.png')) refFiles.push(rel + '/' + e);
    }
  })(refDir, '');
  const refSet = new Set(refFiles), ourSet = new Set(manifest);
  const missing = refFiles.filter(f => !ourSet.has(f));
  const extra = manifest.filter(f => !refSet.has(f));
  console.log(`manifest: ours ${manifest.length}, ref ${refFiles.length}, missing ${missing.length}, extra ${extra.length}`);
  missing.slice(0, 10).forEach(f => console.log('  missing', f));
  extra.slice(0, 10).forEach(f => console.log('  extra  ', f));

  // spot check spec
  const gem = build.coils.find(c => c.name === '1.5T GEM PA');
  if (gem) {
    const g = gem.groups.find(g => g.fileName === 'TC01_Ch14_EL1.png' && g.modeDir === 'Mode_ALL');
    if (g) {
      const spec = CATE.model.chartSpec(gem, g);
      console.log('spot 1.5T GEM PA TC01_Ch14_EL1:', spec.series.map(s => s.label).join(' | '), '|', spec.lsl.map(l => l.label).join(' | '), spec.usl.map(l => l.label).join(' | '));
      console.log('  y range', spec.yMin.toFixed(2), spec.yMax.toFixed(2), ' title2:', spec.title2);
      console.log('  x ticks', T.dateTicks(spec.xMin, spec.xMax).map(T.formatDate).join(' '));
      console.log('  y ticks', T.numericTicks(spec.yMin, spec.yMax).ticks.join(' '));
      const yMinOff = spec.yMin;
      const fl = CATE.model.chartSpec(gem, g, -1, { outlierMode: 'flag', k: 3.5, stats: true });
      eq(fl.outliers.count, 11, 'flag: 11 outliers flagged');
      eq(fl.outliers.nPinned, 8, 'flag: 8 pinned off-scale (-9.0 and -10.3 stay in place)');
      near(Math.min(...fl.outliers.items.map(o => o.y)), -61.27, 0.01, 'flag: lowest outlier');
      eq(fl.yMin > -13 && fl.yMin < -10.3, true, 'flag: y range tightened (yMin between -13 and -10.3), got ' + fl.yMin.toFixed(2));
      const nLoaded = CATE.model.datasetsFor('Sensitivity').length, last = fl.stats.rows.length - 1;
      eq(fl.stats.rows.length, nLoaded + 1, 'flag: one stats row per loaded machine + All machines');
      eq(fl.stats.rows[last].label, 'All machines', 'flag: last row All machines');
      eq(fl.stats.includesOutliers, true, 'flag: statistics include outliers by default');
      eq(fl.stats.rows[last].n, 656, 'flag (include): All machines n = 656 (all drawn points)');
      eq(fl.stats.rows[last].fail > 0, true, 'flag (include): out-of-spec outliers counted as failures, got ' + fl.stats.rows[last].fail);
      eq(fl.units, 'dB', 'spec: units dB'); eq(fl.decimals, 2, 'spec: 2 decimals'); eq(fl.yLabel, 'Sensitivity / Measurement (dB)', 'spec: y label');
      eq(fl.measurement, 'Sensitivity', 'spec: measurement');
      eq(fl.stats.capHeader, 'Cpl', 'flag: capability header Cpl');
      console.log('  footnotes:', fl.stats.footnotes.join(' | '));
      console.log('  rows:', fl.stats.rows.map(r => `${r.label} n=${r.n} coils=${r.coils} mean=${r.mean.toFixed(2)} std=${r.std.toFixed(2)} inSpec=${r.inSpecPct.toFixed(1)}% cpl=${r.cpl.toFixed(2)} out=${r.outliers}`).join('\n        '));
      const flx = CATE.model.chartSpec(gem, g, -1, { outlierMode: 'flag', k: 3.5, stats: true, statsOutliers: 'exclude' });
      eq(flx.stats.includesOutliers, false, 'flag (exclude): statistics exclude outliers');
      eq(flx.stats.rows[last].n, 645, 'flag (exclude): All machines n = 645');
      eq(flx.stats.rows[last].n + flx.stats.rows[last].outliers, fl.stats.rows[last].n, 'flag: n(excluded) + outliers = n(included)');
      eq(flx.stats.rows[last].fail < fl.stats.rows[last].fail, true, 'flag (exclude): fewer failures than include');
      eq(flx.series.reduce((a, s) => a + s.ys.length, 0), 656, 'flag (exclude): all 656 points still drawn');
      console.log('  footnotes (excl):', flx.stats.footnotes.join(' | '));
      console.log('  rows (excl):', flx.stats.rows.map(r => `${r.label} n=${r.n} inSpec=${r.inSpecPct.toFixed(1)}% (${r.pass}/${r.n})`).join(' | '));
      const ex = CATE.model.chartSpec(gem, g, -1, { outlierMode: 'exclude', k: 3.5, stats: true });
      eq(ex.series.reduce((a, s) => a + s.ys.length, 0), 645, 'exclude: 645 points drawn');
      eq(ex.excludedNote, '11 outliers excluded (modified z-score, k = 3.5)', 'exclude: note');
      const off = CATE.model.chartSpec(gem, g, -1, { outlierMode: 'off', k: 3.5, stats: true });
      eq(off.yMin, yMinOff, 'off: y range unchanged');
      eq(off.outliers, null, 'off: no detection');
    }
  }
  const hnu = build.coils.find(c => c.name === '1.5T GEM HNU');
  if (hnu) {
    const g = hnu.groups.find(g => g.fileName === 'TC01_Ch29_E7.png' && g.modeDir === 'Mode_3C');
    if (g) {
      const spec = CATE.model.chartSpec(hnu, g);
      console.log('spot 1.5T GEM HNU 3C TC01_Ch29_E7:', spec.series.map(s => s.label).join(' | '), '|', spec.lsl.map(l => l.label).join(' | '), '| title2:', spec.title2);
      console.log('  x ticks', T.dateTicks(spec.xMin, spec.xMax).map(T.formatDate).join(' '));
      console.log('  y ticks', T.numericTicks(spec.yMin, spec.yMax).ticks.join(' '));
    }
  }

  // --- Access database: every result table through parseMdb + addDataset (skipped when the file is absent)
  const mdbPath = path.join(dataDir, 'CATE_1001.mdb');
  if (fs.existsSync(mdbPath)) {
    const jet = cateJetCore();
    const fd = fs.openSync(mdbPath, 'r'); const size = fs.fstatSync(fd).size;
    const file = { name: 'CATE_1001.mdb', size, slice: (a, b) => ({ arrayBuffer: () => { const buf = Buffer.alloc(Math.min(b, size) - a); fs.readSync(fd, buf, 0, buf.length, a); return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)); } }) };
    const m = CATE.machineIndexFromName(file.name);
    const csvSens = CATE.model.machines[m].datasets.Sensitivity;
    const csvRows = csvSens ? csvSens.n : -1;
    CATE.model.removeMachine(m);
    const types = [], datasets = {};
    const t0m = Date.now();
    await core.parseMdb(file, (msg) => { types.push(msg.type); if (msg.type === 'dataset') { datasets[msg.measurement] = msg; CATE.model.addDataset(m, msg.measurement, msg); } if (msg.type === 'error') throw new Error(msg.message); }, { jet });
    console.log('mdb: parsed all tables in', Date.now() - t0m, 'ms; messages', types.filter(t => t !== 'progress').join(','));
    eq(Object.keys(datasets).sort(), ['MCBias', 'MuxAuxPS', 'Oscillation', 'SCPre', 'Sensitivity'], 'mdb: five datasets');
    eq(types[0], 'progress', 'mdb: progress first'); eq(types[types.length - 1], 'done', 'mdb: done last');
    eq(types.filter(t => t === 'dataset')[0] === 'dataset' && Object.keys(datasets)[0] === 'Sensitivity', true, 'mdb: Sensitivity emitted first');
    console.log('mdb rows kept:', Object.keys(datasets).map(k => k + '=' + datasets[k].n + ' (read ' + datasets[k].stats.rowsRead + ', dropped ' + JSON.stringify(datasets[k].stats.dropped) + ')').join(' | '));
    eq(Math.abs(datasets.Sensitivity.n - csvRows) <= 2000, true, `mdb: Sensitivity rows (${datasets.Sensitivity.n}) close to the CSV export (${csvRows})`);
    eq(CATE.model.measurementsLoaded(), ['Sensitivity', 'MCBias', 'MuxAuxPS', 'Oscillation', 'SCPre'], 'mdb: measurementsLoaded order');
    const mux = CATE.model.build(settings, 'MuxAuxPS');
    const gemMux = mux.coils.find(c => c.name === '1.5T GEM PA');
    eq(!!gemMux && gemMux.groups.length > 0, true, 'MuxAuxPS: 1.5T GEM PA has groups');
    if (gemMux) {
      const g1 = gemMux.groups.find(g => g.net === 'P_MUX1');
      eq(!!g1, true, 'MuxAuxPS: P_MUX1 group');
      if (g1) {
        eq(g1.fileName, 'Net_P_MUX1.png', 'MuxAuxPS: file name'); eq(g1.caption, 'Mode ' + g1.mode + ' · Net P_MUX1', 'MuxAuxPS: caption');
        eq(g1.units, 'A', 'MuxAuxPS: units A'); eq(g1.keyKind, 'net', 'MuxAuxPS: keyKind'); eq(g1.tc, -1, 'MuxAuxPS: no test case');
        eq(g1.lsl.length > 0 && g1.usl.length > 0, true, 'MuxAuxPS: LSL and USL found');
        const sp = CATE.model.chartSpec(gemMux, g1, -1, { outlierMode: 'flag', k: 3.5, stats: true });
        eq(sp.title2, 'P_MUX1 MuxAuxPS vs Date - Single CATE', 'MuxAuxPS: title'); eq(sp.yLabel, 'MuxAuxPS / Measurement (A)', 'MuxAuxPS: y label');
        eq(sp.decimals, 3, 'MuxAuxPS: 3 decimals'); eq(sp.series.length, 1, 'MuxAuxPS: one series (CATE1001)');
        eq(sp.yMax - sp.yMin < 1, true, 'MuxAuxPS: y range in amperes, not padded by 1 dB, got ' + (sp.yMax - sp.yMin).toFixed(3));
        const ri = CATE.model.rowInfo(m, sp.series[0].rows[0], 'MuxAuxPS');
        eq(ri.units, 'A', 'rowInfo: units'); eq(ri.machine, 'CATE1001', 'rowInfo: machine');
        console.log('  MuxAuxPS P_MUX1:', sp.series[0].label, 'LSL', sp.lsl.map(l => l.label).join('/'), 'USL', sp.usl.map(l => l.label).join('/'), 'y', sp.yMin.toFixed(3), sp.yMax.toFixed(3), 'outliers', sp.outliers && sp.outliers.count);
      }
    }
    const osc = CATE.model.build(settings, 'Oscillation');
    const gemOsc = osc.coils.find(c => c.name === '1.5T GEM PA');
    const gO = gemOsc && gemOsc.groups[0];
    eq(!!gO, true, 'Oscillation: 1.5T GEM PA has groups');
    if (gO) { eq(gO.lsl.length, 0, 'Oscillation: no LSL'); eq(gO.usl.length > 0, true, 'Oscillation: USL present'); eq(gO.units, 'dB', 'Oscillation: units dB'); eq(/^TC\d\d_Ch/.test(gO.fileName), true, 'Oscillation: TC file name'); }
    const sc = CATE.model.build(settings, 'SCPre');
    const anySc = sc.coils.find(c => c.groups.length);
    eq(!!anySc, true, 'SCPre: some coil has groups in range');
    if (anySc) { const gS = anySc.groups[0]; eq(gS.usl.length, 0, 'SCPre: no USL'); eq(gS.units, 'V', 'SCPre: units V (despite swapped columns)'); }
    const mc = CATE.model.build(settings, 'MCBias');
    const gemMc = mc.coils.find(c => c.name === '1.5T GEM PA');
    eq(!!gemMc && gemMc.groups.length > 0, true, 'MCBias: 1.5T GEM PA has groups');
    if (gemMc) { const gM = gemMc.groups[0]; eq(gM.units, 'V', 'MCBias: units V'); const spM = CATE.model.chartSpec(gemMc, gM, -1, {}); eq(spM.decimals, 3, 'MCBias: 3 decimals'); }
    // the Sensitivity build from the mdb must match the CSV-based one chart for chart on this coil
    const build2 = CATE.model.build(settings, 'Sensitivity');
    const gem2 = build2.coils.find(c => c.name === '1.5T GEM PA');
    const gem1 = build.coils.find(c => c.name === '1.5T GEM PA');
    eq(gem2 && gem1 && gem2.groups.length === gem1.groups.length, true, 'mdb Sensitivity: same chart count for 1.5T GEM PA as the CSV');
    eq(build2.totalCharts >= build.totalCharts, true, `mdb Sensitivity: total charts ${build2.totalCharts} >= CSV ${build.totalCharts}`);
  } else console.log('mdb: CATE_1001.mdb not found, skipping');


  // --- EVO database: Noise + the shared tables through parseMdb (skipped when the file is absent)
  const evoPath = path.join(dataDir, 'EVO1002_Data_Results.mdb');
  if (fs.existsSync(evoPath)) {
    const jet2 = cateJetCore();
    const fd2 = fs.openSync(evoPath, 'r'); const size2 = fs.fstatSync(fd2).size;
    const file2 = { name: 'EVO1002_Data_Results.mdb', size: size2, slice: (a, b) => ({ arrayBuffer: () => { const buf = Buffer.alloc(Math.min(b, size2) - a); fs.readSync(fd2, buf, 0, buf.length, a); return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)); } }) };
    const me = CATE.machineIndexFromName(file2.name);
    eq(CATE.MACHINES[me], 'EVO1002', 'evo: machine from file name');
    const types2 = [], ds2 = {}, empties = [];
    const t0e = Date.now();
    await core.parseMdb(file2, (msg) => { types2.push(msg.type); if (msg.type === 'dataset') { ds2[msg.measurement] = msg; CATE.model.addDataset(me, msg.measurement, msg); } if (msg.type === 'tablesEmpty') empties.push(...msg.measurements); if (msg.type === 'error') throw new Error(msg.message); }, { jet: jet2 });
    console.log('evo: parsed in', Date.now() - t0e, 'ms; datasets', Object.keys(ds2).join(','), '; empty', empties.join(','));
    eq(Object.keys(ds2), ['MCBias', 'MuxAuxPS', 'Oscillation', 'SCPre', 'Noise'], 'evo: five datasets in measurement order');
    eq(empties.sort(), ['BTE', 'MEMSCurrent', 'MEMSSC'], 'evo: empty tables reported, no dataset emitted');
    eq(ds2.Noise.n, 405956, 'evo: all Noise rows kept'); eq(ds2.Noise.stats.dropped.nullKey, 0, 'evo: Noise nullKey 0');
    eq(CATE.model.measurementsLoaded(), ['Sensitivity', 'MCBias', 'MuxAuxPS', 'Oscillation', 'SCPre', 'Noise'], 'evo: measurementsLoaded with CATE data still present');
    const allSettings = { start: T.parseIsoDate('2026-02-01'), end: T.parseIsoDate('2026-10-31'), overrides: [] };
    const nb = CATE.model.build(allSettings, 'Noise');
    const gemN = nb.coils.find(c => c.name === '1.5T GEM PA');
    eq(!!gemN && gemN.groups.length > 0, true, 'Noise: 1.5T GEM PA has groups');
    if (gemN) {
      const g = gemN.groups[0];
      eq(g.units, 'dB', 'Noise: units dB'); eq(g.lsl.length > 0 && g.usl.length > 0, true, 'Noise: LSL and USL present'); eq(g.keyKind, 'tc', 'Noise: TestCase keys');
      const sp = CATE.model.chartSpec(gemN, g, -1, { outlierMode: 'flag', k: 3.5, stats: true });
      eq(sp.yLabel, 'Noise / Difference from baseline (dB)', 'Noise: y label'); eq(/ - Single EVO$/.test(sp.title2), true, 'Noise: Single EVO suffix, got ' + sp.title2);
      eq(sp.series.length, 1 && sp.series[0].machine === 'EVO1002' ? 1 : -1, 'Noise: EVO1002 series');
      const ri = CATE.model.rowInfo(me, sp.series[0].rows[0], 'Noise');
      eq(ri.port === '1' || ri.port === '2', true, 'rowInfo: port'); eq(ri.extras.Baseline, -147.5, 'rowInfo: extras.Baseline'); eq(ri.extras.Measurement < -100, true, 'rowInfo: extras.Measurement');
      eq(Math.abs((ri.extras.Measurement - ri.extras.Baseline) - ri.meas) < 0.02, true, 'Noise: plotted value is Measurement - Baseline');
      const allIn = sp.series[0].ys.every(y => y >= -5 && y <= 60); eq(allIn, true, 'Noise: values in a dB difference range');
      console.log('  Noise', g.caption, sp.series[0].label, 'LSL', sp.lsl.map(l => l.label).join('/'), 'USL', sp.usl.map(l => l.label).join('/'), 'stats n', sp.stats.rows[0].n, 'inSpec', sp.stats.rows[0].inSpecPct.toFixed(1));
      const spP = CATE.model.chartSpec(gemN, g, -1, { port: g.ports[0] });
      eq(spP.series.length, 1, 'Noise: port filter keeps the series'); eq(/ · Port \d$/.test(spP.title2), true, 'Noise: port in title');
      eq(CATE.model.chartSpec(gemN, g, -1, { port: '9' }).series.length, 0, 'Noise: unknown port -> no series');
    }
    const naCoil = nb.coils.find(c => c.groups.some(g => g.missingSpec));
    eq(!!naCoil, true, 'Noise: some group has no limits (NA rows) -> missingSpec');
    const ob = CATE.model.build(allSettings, 'Oscillation');
    const evoOsc = ob.coils.find(c => c.groups.some(g => g.rows[me]));
    eq(!!evoOsc, true, 'Oscillation: EVO groups present');
    if (evoOsc) { const g = evoOsc.groups.find(g => g.rows[me]); eq(g.units, 'dBm', 'Oscillation EVO: units dBm'); const ri = CATE.model.rowInfo(me, g.rows[me][0], 'Oscillation'); eq(ri.extras.Frequency > 1e6, true, 'Oscillation EVO: Frequency extra'); }
    const mb = CATE.model.build(allSettings, 'MCBias');
    const mixed = mb.coils.find(c => c.groups.some(g => g.machinesPresent > 1 && g.rows[me]));
    console.log('  MCBias mixed CATE+EVO group:', mixed ? mixed.name : '(none; EVO modes differ from CATE)');
    eq(mb.totalCharts > 0, true, 'MCBias: CATE + EVO build ok');
    // the SCPre export of EVO is not column-swapped: units still V
    const sb = CATE.model.build(allSettings, 'SCPre'); const sc2 = sb.coils.find(c => c.groups.some(g => g.rows[me]));
    if (sc2) eq(sc2.groups.find(g => g.rows[me]).units, 'V', 'SCPre EVO: units V');
  } else console.log('evo: EVO1002_Data_Results.mdb not found, skipping');

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL ASSERTIONS PASSED (reference folder is missing 11 Kizuna charts from the interrupted Python run)');
})();

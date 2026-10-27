// Synthetic checks for run clustering, the first pass yield report and the latest / first run chart filter:
//   node dev/test-yield.js
// How it works: a small Sensitivity CSV (plus one MCBias row and one MuxAuxPS row on another machine) is
// built from the tc() / net() row helpers so every serial exercises one rule of the yield report: retests
// within / beyond the run gap, a repeated test case starting a new run, dummy serials, cleaned serials
// (0012 = 12-xyz), NA verdicts judged by the limits, unjudged rows, test kits and the machine filter.
// The rows are loaded into CATE.model through parse-core, then model.runs(), model.yieldReport() with its
// options, model.serialList() and the runs=latest/first chart filter are asserted against hand-counted
// values. Needs no data files. Prints ALL PASSED or N FAILURE(S) (exit code 1).
const cateParseCore = require('../js/parse-core.js');
require('../js/ticks.js');
require('../js/model.js');
const CATE = globalThis.CATE;
const core = cateParseCore();

let fails = 0;
// Assertion helper: deep-equal via JSON (NaN == NaN allowed); counts failures, prints ok / FAIL with both values.
function eq(a, b, msg) {
  const ok = (Number.isNaN(a) && Number.isNaN(b)) || a === b || JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { fails++; console.error('FAIL', msg, '\n  got     ', a, '\n  expected', b); } else console.log('ok  ', msg);
}

const HDR = '"CoilName","CoilSN","Mode","TimeDate","TestCase","Channel","Element","Measurement","LSL","USL","PassFail","Units"\n';
// One Sensitivity CSV row for the given coil, serial, timestamp, test case, value and verdict (Channel 1, Element 1).
function tc(coil, sn, time, testCase, meas, pf, lsl = '-20', usl = 'NA') {
  return `"${coil}","${sn}","All Modes","${time}","${testCase}","1","1","${meas}","${lsl}","${usl}","${pf}","dB"\n`;
}
const MUX_HDR = '"CoilName","CoilSN","Mode","TimeDate","NetName","LSL","Measurement","USL","PassFail","Units"\n';
// One MuxAuxPS CSV row (NetName table, limits 0.3 .. 0.7 A).
function net(coil, sn, time, name, meas, pf) { return `"${coil}","${sn}","All Modes","${time}","${name}","0.3","${meas}","0.7","${pf}","A"\n`; }

// Parses CSV text with parse-core and adds the dataset to machine index m; the file name decides the table.
async function load(m, text, fileName) {
  let ds = null;
  await core.parseFile(new Blob([text]), (msg) => { if (msg.type === 'dataset') ds = msg; if (msg.type === 'error') throw new Error(msg.message); }, { fileName });
  CATE.model.addDataset(m, ds.measurement, ds);
  return ds;
}

// Scenario: build the synthetic data, then check runs, the yield report and the chart run filter.
(async () => {
  const sens =
    // SN A: run 1 at 09:00 (TC1 fails), run 2 at 09:20 (20 min later, all pass)
    tc('C1', 'A', '1/10/2026 9:00:00 AM', 1, '-25', 'FAIL') + tc('C1', 'A', '1/10/2026 9:00:05 AM', 2, '-10', 'PASS') +
    tc('C1', 'A', '1/10/2026 9:20:00 AM', 1, '-12', 'PASS') + tc('C1', 'A', '1/10/2026 9:20:05 AM', 2, '-10', 'PASS') +
    // SN B: one passing run
    tc('C1', 'B', '1/11/2026 1:00:00 PM', 1, '-11', 'PASS') + tc('C1', 'B', '1/11/2026 1:00:00 PM', 2, '-11', 'PASS') +
    // SN C: first run before the range (passes), retest inside the range fails -> not counted
    tc('C1', 'C', '1/5/2026 8:00:00 AM', 1, '-11', 'PASS') + tc('C1', 'C', '1/12/2026 8:00:00 AM', 1, '-30', 'FAIL') +
    // SN D: TC1, TC2 pass, then TC1 again three minutes later (key repeats -> new run) fails
    tc('C1', 'D', '1/12/2026 10:00:00 AM', 1, '-11', 'PASS') + tc('C1', 'D', '1/12/2026 10:00:05 AM', 2, '-11', 'PASS') +
    tc('C1', 'D', '1/12/2026 10:03:00 AM', 1, '-40', 'FAIL') +
    // SN tst: excluded by the serial pattern
    tc('C1', 'tst', '1/12/2026 11:00:00 AM', 1, '-40', 'FAIL') +
    // SN 0012 and 12-xyz are the same coil (cleaned serial 12): one run each -> retested, first passes
    tc('C1', '0012', '1/13/2026 9:00:00 AM', 1, '-11', 'PASS') + tc('C1', '12-xyz', '1/13/2026 2:00:00 PM', 1, '-11', 'PASS') +
    // SN E: PassFail column says NA but the limits say fail (judged by LSL)
    tc('C1', 'E', '1/14/2026 9:00:00 AM', 1, '-25', 'NA') +
    // SN F: nothing judged (no limits, no verdict) -> unjudged
    tc('C1', 'F', '1/14/2026 9:30:00 AM', 1, '-25', 'NA', 'NA', 'NA') +
    // SN H: TC1 then TC2 thirty minutes later (different keys): two runs at the 15 min gap, one at 60 min
    tc('C1', 'H', '1/14/2026 11:00:00 AM', 1, '-11', 'PASS') + tc('C1', 'H', '1/14/2026 11:30:00 AM', 2, '-11', 'PASS') +
    // a test kit coil type, excluded by default
    tc('Test Kit CH 1 to CH 16', 'K1', '1/14/2026 10:00:00 AM', 1, '-25', 'FAIL') +
    // another coil type, all pass; its dummy serial ran before the range (not counted as excluded)
    tc('C2', 'X', '1/14/2026 10:00:00 AM', 1, '-11', 'PASS') + tc('C2', 'test', '1/2/2026 10:00:00 AM', 1, '-11', 'PASS') +
    // serial 33 on C2: an eval run (fails) and a production run (passes) share the cleaned serial
    tc('C2', '0033-Eval', '1/13/2026 10:00:00 AM', 1, '-40', 'FAIL') + tc('C2', '0033', '1/13/2026 3:00:00 PM', 1, '-11', 'PASS') +
    // a coil type that only saw a dummy serial in range: excluded is counted in the total but the type is not listed
    tc('C3', 'tst', '1/12/2026 11:30:00 AM', 1, '-11', 'PASS');
  await load(0, HDR + sens, 'CATE1001.csv');
  // MCBias on the same machine: SN A run 1 also measured MCBias (passes), so the first run spans two tables
  await load(0, '"CoilName","CoilSN","Mode","TimeDate","TestCase","Channel","Element","Measurement","LSL","USL","PassFail","Units"\n' +
                `"C1","A","All Modes","1/10/2026 9:01:00 AM","1","1","1","3.5","3.0","4.0","PASS","V"\n`, 'CATE1001_MCBiasResults.csv');
  // MuxAuxPS on CATE1003: SN G tested there (fails)
  await load(2, MUX_HDR + net('C1', 'G', '1/14/2026 3:00:00 PM', 'P_MUX1', '0.9', 'FAIL'), 'CATE1003_MuxAuxPSResults.csv');

  const T = CATE.ticks;
  const settings = { start: T.parseIsoDate('2026-01-10'), end: T.parseIsoDate('2026-01-15'), overrides: [] };

  // --- runs
  const R = CATE.model.runs();
  const c1 = CATE.model.dict.coil.map.get('C1');
  const runsA = R.coils[c1].runs.filter(r => CATE.model.snCleanDict.list[r.sc] === 'A');
  eq(runsA.length, 2, 'runs: SN A has two runs (20 min gap)');
  eq(runsA.map(r => r.n), [3, 2], 'runs: run 1 holds the MCBias row too');
  eq(runsA.map(r => r.verdict), [0, 1], 'runs: SN A fails then passes');
  const runsD = R.coils[c1].runs.filter(r => CATE.model.snCleanDict.list[r.sc] === 'D');
  eq(runsD.length, 2, 'runs: SN D split when TC1 repeats');
  eq(runsD.map(r => r.verdict), [1, 0], 'runs: SN D passes then fails');
  eq(R.coils[c1].runs.filter(r => CATE.model.snCleanDict.list[r.sc] === 'B').length, 1, 'runs: same-timestamp rows stay in one run');
  eq(R.coils[c1].runs.filter(r => CATE.model.snCleanDict.list[r.sc] === '12').length, 2, 'runs: 0012 and 12-xyz are one coil with two runs');

  // --- yield report
  const rep = CATE.model.yieldReport(settings, { excludeSn: /^(tst|test)$/i });
  eq(rep.coils.map(c => c.coil), ['C1', 'C2'], 'yield: coil types (test kit skipped)');
  eq(rep.skippedTestKits, 1, 'yield: one test kit skipped');
  const y = rep.coils[0];
  eq(y.tested, 8, 'yield: C1 tested = A B D 12 E F G H (C first run before range, tst excluded)');
  eq(y.excluded, 1, 'yield: tst excluded');
  eq(y.firstPass, 4, 'yield: first pass = B D 12 H');
  eq(y.firstFail, 3, 'yield: first fail = A E G');
  eq(y.unjudged, 1, 'yield: F unjudged');
  eq(y.judged, 7, 'yield: judged = 7');
  eq(y.fpyPct, 4 / 7 * 100, 'yield: FPY 4 of 7');
  eq(y.retested, 4, 'yield: retested = A D 12 H');
  eq(y.finalPass, 4, 'yield: final pass = A B 12 H (D fails last, E G fail)');
  eq(y.finalPct, 4 / 7 * 100, 'yield: final yield 4 of 7');
  eq(y.runs, 12, 'yield: runs counted');
  eq(y.runsFailed, 4, 'yield: failed runs = A1 D2 E G');
  eq(y.byMeas.map(x => x.label + ':' + x.judged + '/' + x.failed), ['Sensitivity:6/2', 'MCBias:1/0', 'MuxAuxPS:1/1'], 'yield: by table (first runs only)');
  eq(y.byMachine.map(x => x.machine + ':' + x.tested + '/' + x.pass), ['CATE1001:7/4', 'CATE1003:1/0'], 'yield: by machine');
  eq(y.failTests.map(x => x.test + '=' + x.coils), ['Sensitivity · Mode All Modes · TC01 Ch1 E1=2', 'MuxAuxPS · Mode All Modes · Net P_MUX1=1'], 'yield: failing tests of first runs');
  eq(rep.total.tested, 10, 'yield: totals include C2 (X and 33)');
  eq(rep.coils[1].firstFail, 1, 'yield: without an eval rule the eval run is 33\'s first run');
  eq(rep.coils[1].excluded, 0, 'yield: a dummy serial outside the range is not counted as excluded');
  eq(rep.total.excluded, 2, 'yield: total excluded counts C3\'s dummy serial although C3 is not listed');
  eq(rep.total.fpyPct, 5 / 9 * 100, 'yield: total FPY');
  const repEval = CATE.model.yieldReport(settings, { excludeSn: /eval/i });
  const c2e = repEval.coils.find(c => c.coil === 'C2');
  eq([c2e.tested, c2e.firstPass, c2e.excluded, c2e.retested, c2e.runs], [2, 2, 1, 0, 2], 'yield: an excluded run drops out while the serial keeps its production run');
  const dummy = CATE.isDummySerial;
  eq(['00827-301424423', '15000', '1079', '1', '00012-1'].map(dummy), [false, false, false, false, false], 'rule: production serials pass');
  eq(['00569-Evaluation', '202 Test', 'tst', 'TEST 1', 'H120', '301424423', '00424-302731204+', '12-xyz', 'Adam Kruze', '02821.'].map(dummy), [true, true, true, true, true, true, true, true, true, true], 'rule: dummy serials caught');
  const repRule = CATE.model.yieldReport(settings, { excludeSn: dummy });
  eq(repRule.coils.map(c => c.coil + ':' + c.tested + '/' + c.excluded), ['C1:1/10', 'C2:1/2'], 'yield: default rule keeps 0012 and 0033 only (excluded = dummy serials with a run in range)');
  const repKits = CATE.model.yieldReport(settings, { includeTestKits: true });
  eq(repKits.coils.length, 4, 'yield: test kits included on request (and C3 listed once tst counts)');
  eq(repKits.coils.find(c => c.coil === 'C1').tested, 9, 'yield: without the serial pattern tst counts');
  const repM = CATE.model.yieldReport(settings, { machine: 2 });
  eq(repM.coils.map(c => c.coil + ':' + c.tested), ['C1:1'], 'yield: machine filter keeps runs on CATE1003 only');
  const repGap = CATE.model.yieldReport(settings, { gapMs: 60 * 60000, excludeSn: /^tst$/ });
  eq(repGap.coils[0].retested, 3, 'yield: 60 min gap merges SN H (A and D still split by the key repeat)');
  eq(repGap.coils[0].runs, 11, 'yield: one run fewer at 60 min');
  const repList = CATE.model.yieldReport(settings, { excludeSn: ['TST', ' test '] });
  eq(repList.coils[0].tested + '/' + repList.coils[0].excluded, '8/1', 'yield: excludeSn as a list of serials (case-insensitive)');
  eq(CATE.model.yieldReport(settings, { excludeSn: new Set(['a', 'b']) }).coils[0].tested, 7, 'yield: excludeSn as a Set (tst still counts)');
  eq(CATE.model.yieldReport(settings, { excludeSn: [] }).coils[0].tested, 9, 'yield: empty list excludes nothing');
  const sl = CATE.model.serialList();
  eq(sl.map(x => x.sn), ['0033-Eval', '12-xyz', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'K1', 'test', 'tst', 'X', '0012', '0033'], 'serialList: dummy serials first (alphabetical), then production by number');
  eq(sl.find(x => x.sn === 'tst').coils, 2, 'serialList: tst ran on two coil types');
  eq(sl.find(x => x.sn === 'A').runs + '/' + sl.find(x => x.sn === 'A').failed, '2/1', 'serialList: runs and failed runs per serial');
  eq(sl.find(x => x.sn === '12-xyz').cleaned + '/' + sl.find(x => x.sn === '0012').cleaned, '12/12', 'serialList: raw serials carry their cleaned form');
  eq(sl.filter(x => !x.dummy).map(x => x.sn), ['0012', '0033'], 'serialList: dummy flag');
  eq(sl.find(x => x.sn === 'G').coilNames, ['C1'], 'serialList: coil type names');
  const narrow = { start: T.parseIsoDate('2026-01-13'), end: T.parseIsoDate('2026-01-13'), overrides: [] };
  eq(CATE.model.yieldReport(narrow, {}).coils[0].tested, 1, 'yield: only serials whose first run starts in range');

  // --- latest / first run per coil on a chart
  const build = CATE.model.build(settings, 'Sensitivity');
  const coil = build.coils.find(c => c.name === 'C1');
  const g = coil.groups.find(x => x.tc === 1);
  const all = CATE.model.chartSpec(coil, g, -1, { runs: 'all' });
  const latest = CATE.model.chartSpec(coil, g, -1, { runs: 'latest' });
  const first = CATE.model.chartSpec(coil, g, -1, { runs: 'first' });
  eq(all.series[0].xs.length, 12, 'chart: all rows in range (A×2, B, C, D×2, tst, 0012, 12-xyz, E, F, H)');
  eq(latest.series[0].xs.length, 9, 'chart: latest run per coil keeps one point per serial');
  eq(latest.series[0].nCoils, 9, 'chart: coil count recomputed');
  const ysOf = s => Array.from(s.series[0].ys);
  const count = (arr, v) => arr.filter(x => x === v).length;
  eq([count(ysOf(all), -25), count(ysOf(all), -12)], [3, 1], 'chart: all -> -25 from A, E, F and -12 from A');
  eq([count(ysOf(latest), -25), count(ysOf(latest), -12)], [2, 1], 'chart: latest -> A keeps 09:20 (-12), E and F keep -25');
  eq([count(ysOf(first), -25), count(ysOf(first), -12)], [3, 0], 'chart: first -> A keeps 09:00 (-25)');
  eq(latest.title2.indexOf('latest run per coil') > 0, true, 'chart: title suffix');
  eq(latest.fileName, 'TC01_Ch1_E1_latest.png', 'chart: file name suffix');
  eq(all.fileName, 'TC01_Ch1_E1.png', 'chart: default file name unchanged');
  const withStats = CATE.model.chartSpec(coil, g, -1, { runs: 'latest', stats: true });
  eq(withStats.stats.footnotes.some(f => /Latest run per coil only: 9 coils/.test(f)), true, 'chart: statistics footnote');
  eq(CATE.model.rowInfo(0, g.rows[0][0], 'Sensitivity').pf, 0, 'rowInfo: PassFail verdict exposed');

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

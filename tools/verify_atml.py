#!/usr/bin/env python3
"""Independent check of tools/atml_to_mdb.ps1.

Re-derives every result row from the original ATML XML reports (own implementation, no shared code
with the converter) and compares them with the CSV copies the converter wrote (-KeepCsv / -DryRun):

    python tools/verify_atml.py "<csv folder>" [--max N] [--verbose]

The CSV folder is the `_csv_<name>` directory next to the database. Every report listed in
SourceFiles.csv is re-parsed; rows are compared per RunID and table, field by field.
Exit code 0 = everything matches.
"""
import csv, json, os, re, sys, collections
import xml.etree.ElementTree as ET
from datetime import datetime

NS = {'tr': 'urn:IEEE-1636.1:2011:01:TestResults', 'c': 'urn:IEEE-1671:2010:Common',
      'trc': 'urn:IEEE-1636.1:2011:01:TestResultsCollection', 'ts': 'www.ni.com/TestStand/ATMLTestResults/2.0'}
csv.field_size_limit(10 ** 8)

COMMON = ['CoilName', 'CoilSN', 'CoilPN', 'Mode', 'Operator', 'TimeDate']
TABLES = {
    'Sensitivity': COMMON + ['TestCase', 'Channel', 'Element', 'Measurement', 'LSL', 'USL', 'PassFail', 'Units', 'Port', 'RunID'],
    'MCBiasResults': COMMON + ['TestCase', 'Channel', 'Element', 'LSL', 'Measurement', 'USL', 'PassFail', 'Units', 'Port', 'RunID'],
    'MCBiasCurrentResults': COMMON + ['TestCase', 'Channel', 'Element', 'LSL', 'Measurement', 'USL', 'PassFail', 'Units', 'Port', 'RunID'],
    'NoiseResults': COMMON + ['TestCase', 'Channel', 'Element', 'Baseline', 'Measurement', 'LSL', 'Difference', 'USL', 'PassFail', 'Units', 'Port', 'RunID'],
    'MuxAuxPSResults': COMMON + ['NetName', 'LSL', 'Measurement', 'USL', 'PassFail', 'Units', 'Port', 'RunID'],
    'SCPreResults': COMMON + ['NetName', 'LSL', 'Measurement', 'USL', 'PassFail', 'Units', 'Port', 'RunID'],
    'CoilPresentResults': COMMON + ['NetName', 'LSL', 'Measurement', 'USL', 'PassFail', 'Units', 'Port', 'RunID'],
    'IdentifyCoil': COMMON + ['ROM_SN', 'Page', 'Expected', 'PassFail', 'Port', 'RunID'],
}
COMPUTED = {('NoiseResults', 'Baseline'), ('NoiseResults', 'Difference'), ('NoiseResults', 'LSL'), ('NoiseResults', 'USL')}
MEMO = set()   # every column is TEXT(255)


def cate_date(iso):
    try:
        dt = datetime.strptime(iso[:23], '%Y-%m-%dT%H:%M:%S.%f') if '.' in iso else datetime.strptime(iso[:19], '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return iso
    h = dt.hour % 12 or 12
    return '%d/%d/%d %d:%02d:%02d %s' % (dt.month, dt.day, dt.year, h, dt.minute, dt.second, 'AM' if dt.hour < 12 else 'PM')


def datum(d):
    if d is None:
        return None
    if 'value' in d.attrib:
        return d.get('value')
    v = d.find('c:Value', NS)
    return (v.text or '').strip() if v is not None else None


def limits(tr):
    lo = hi = exp = None
    for lim in tr.findall('tr:TestLimits/tr:Limits/c:LimitPair/c:Limit', NS) + tr.findall('tr:TestLimits/tr:Limits/c:SingleLimit', NS):
        cmp_, val = lim.get('comparator'), datum(lim.find('c:Datum', NS))
        if cmp_ in ('GE', 'GT'):
            lo = val
        elif cmp_ in ('LE', 'LT'):
            hi = val
    e = tr.find('tr:TestLimits/tr:Limits/c:Expected/c:Datum', NS)
    if e is not None:
        exp = datum(e)
    return lo, hi, exp


def pf(el):
    if el is None:
        return ''
    v, q = el.get('value'), el.get('qualifier') or ''
    return {'Passed': 'PASS', 'Failed': 'FAIL'}.get(v, (q or v).upper())


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def f2(x):
    return '%.2f' % x


def channel_of(cfg):
    for k in ('bias', 'mux'):
        o = cfg.get(k) if isinstance(cfg, dict) else None
        if not isinstance(o, dict):
            continue
        chans = []
        for p in ('P1', 'P2'):
            lst = o.get(p)
            if isinstance(lst, list):
                chans += [str(x) for x in lst]
        if chans:
            return ','.join(chans)
    return ''


def net_of(cfg, fallback):
    pw = cfg.get('power') if isinstance(cfg, dict) else None
    if isinstance(pw, list) and pw and isinstance(pw[0], list) and pw[0] and pw[0][0] not in (None, ''):
        return str(pw[0][0])
    return fallback


def jnum(v):
    """JSON number -> the text the converter writes (ints stay ints, decimals keep their digits)."""
    return '' if v is None else str(v)


def expected_rows(path):
    """{RunID: {table: [tuple(values)...]}} derived from one report."""
    root = ET.parse(path).getroot()
    out = {}
    m = re.match(r'^(\d*)_([^_]+)_\d{2}_[A-Za-z]{3}_\d{4}_\d{4}_log\.xml$', os.path.basename(path))
    fn_pn, fn_sn = (m.group(1), m.group(2)) if m else ('', '')
    for res in root.findall('trc:TestResults', NS):
        run = res.get('uuid')
        rs = res.find('tr:ResultSet', NS)
        if rs is None:
            continue
        op = res.find('tr:Personnel/tr:SystemOperator', NS)
        operator = op.get('name') if op is not None else ''
        sn = res.find('tr:UUT/c:SerialNumber', NS)
        uut_sn = (sn.text or '').strip() if sn is not None else ''
        coil_name, coil_pn, mode, port = '', fn_pn, '', ''
        sel = rs.find('.//tr:SessionAction[@name="SelectMode"]//c:Value', NS)
        if sel is not None and sel.text:
            t = sel.text
            mm = re.search(r'part_description:\s*"([^"]*)"', t); coil_name = mm.group(1) if mm else ''
            mm = re.search(r'part_number:\s*"([^"]*)"', t); coil_pn = mm.group(1) if mm else coil_pn
            mm = re.search(r'File Mode:\s*"([^"]*)"', t); mode = mm.group(1) if mm else ''
            mm = re.search(r'port:\s*"P?(\d+)"', t); port = mm.group(1) if mm else ''
        if not port:
            gp = rs.find('.//tr:SessionAction[@name="GetPort"]//c:Value', NS)
            if gp is not None and gp.text:
                mm = re.search(r'P?(\d+)', gp.text.strip()); port = mm.group(1) if mm else ''
        coil_sn = uut_sn or fn_sn
        tables = collections.defaultdict(list)
        rom_sn = ''
        groups = []
        elem_chan = {}
        for g in rs.iter('{%s}TestGroup' % NS['tr']):
            gname = g.get('name', '').split('#')[-1]
            cfg = None
            cn = g.find('tr:SessionAction[@name="Test Configuration"]//c:Value', NS)
            if cn is not None and cn.text:
                try:
                    cfg = json.loads(cn.text)
                except ValueError:
                    cfg = None
            groups.append((g, gname, cfg))
            e = jnum(cfg.get('element')) if isinstance(cfg, dict) else ''
            c = channel_of(cfg)
            if e and c and e not in elem_chan:
                elem_chan[e] = c
        for g, gname, cfg in groups:
            if gname == 'coil_id':
                for item in g.iter('{%s}Item' % NS['c']):
                    if 'Serial Number' in (item.get('name') or ''):
                        v = item.find('.//c:Value', NS)
                        if v is not None:
                            rom_sn = (v.text or '').strip()
                        break
            tc = jnum(cfg.get('test_case')) if isinstance(cfg, dict) else ''
            el = jnum(cfg.get('element')) if isinstance(cfg, dict) else ''
            ch_raw = channel_of(cfg)
            ch = ch_raw if ch_raw or not el else elem_chan.get(el, el)
            for t in g.findall('tr:Test', NS):
                trs = {}
                for tr in t.findall('tr:TestResult', NS):
                    d = tr.find('tr:TestData/c:Datum', NS)
                    trs[tr.get('name')] = (datum(d), (d.get('nonStandardUnit') if d is not None else '') or '', limits(tr))
                if not trs:
                    continue
                base = {'CoilName': coil_name, 'CoilSN': coil_sn, 'CoilPN': coil_pn, 'Mode': mode, 'Operator': operator,
                        'TimeDate': cate_date(t.get('startDateTime', '')), 'PassFail': pf(t.find('tr:Outcome', NS)), 'Port': port, 'RunID': run}

                def add(table, **kv):
                    row = dict(base); row.update(kv)
                    tables[table].append(tuple(row.get(c) if row.get(c) is not None else '' for c in TABLES[table]))

                if gname == 'sensitivity' and 'Numeric' in trs:
                    v, u, (lo, hi, _) = trs['Numeric']
                    add('Sensitivity', TestCase=tc, Channel=ch, Element=el, Measurement=v, LSL=lo, USL=hi, Units=u or 'dBm')
                elif gname == 'multicoil_bias':
                    if 'Bias Voltage' in trs:
                        v, u, (lo, hi, _) = trs['Bias Voltage']
                        add('MCBiasResults', TestCase=tc, Channel=ch, Element=el, Measurement=v, LSL=lo, USL=hi, Units=u or 'V')
                    if 'Bias Current' in trs:
                        v, u, (lo, hi, _) = trs['Bias Current']
                        add('MCBiasCurrentResults', TestCase=tc, Channel=ch, Element=el, Measurement=v, LSL=lo, USL=hi, Units=u or 'A')
                elif gname == 'noise_power_density' and 'Numeric' in trs:
                    v, u, (lo, hi, _) = trs['Numeric']
                    ref = num(trs['measuredRef'][0]) if 'measuredRef' in trs else None
                    meas = num(v)
                    if ref is not None:
                        lo_n, hi_n = num(lo), num(hi)
                        add('NoiseResults', TestCase=tc, Channel=ch, Element=el, Baseline=f2(ref), Measurement=v,
                            LSL=f2(lo_n - ref) if lo_n is not None else 'NA', Difference=f2(meas - ref) if meas is not None else '',
                            USL=f2(hi_n - ref) if hi_n is not None else 'NA', Units='dBm/Hz')
                    else:
                        add('NoiseResults', TestCase=tc, Channel=ch, Element=el, Baseline='', Measurement=v, LSL=lo, Difference='', USL=hi, Units='dBm/Hz')
                elif gname == 'preamp_short_circuit' and 'Numeric' in trs:
                    v, u, (lo, hi, _) = trs['Numeric']
                    add('SCPreResults', NetName=net_of(cfg, 'TC' + tc), Measurement=v, LSL=lo, USL=hi, Units=u or 'V')
                elif gname == 'power_draw' and 'Numeric' in trs:
                    v, u, (lo, hi, _) = trs['Numeric']
                    add('MuxAuxPSResults', NetName=net_of(cfg, 'TC' + tc), Measurement=v, LSL=lo, USL=hi, Units=u or 'A')
                elif gname == 'mux_sink' and 'Numeric' in trs:
                    v, u, (lo, hi, _) = trs['Numeric']
                    add('MuxAuxPSResults', NetName='MUX_SINK_' + ch_raw if ch_raw else 'MUX_SINK', Measurement=v, LSL=lo, USL=hi, Units=u or 'A')
                elif gname == 'coil_present' and 'Numeric' in trs:
                    v, u, (lo, hi, _) = trs['Numeric']
                    task = jnum(cfg.get('ai_task')) if isinstance(cfg, dict) else ''
                    add('CoilPresentResults', NetName=task or 'TC' + tc, Measurement=v, LSL=lo, USL=hi, Units=u or 'V')
                elif gname == 'coil_id' and t.get('name') == 'FileContent' and 'String' in trs:
                    v, u, (_, _, exp) = trs['String']
                    add('IdentifyCoil', ROM_SN=rom_sn, Page=v, Expected=exp)
        out[run] = tables
    return out


def truncate(v, col):
    return v if col in MEMO or len(v) <= 255 else v[:255]


def same(table, col, a, b):
    if (table, col) in COMPUTED:
        fa, fb = num(a), num(b)
        if fa is not None and fb is not None:
            # .NET "F2" rounds exact .xx5 ties away from zero, Python rounds them to even: allow one unit in the last place
            return abs(fa - fb) < 0.0101
    return a == b


def find_csv(csv_dir, table):
    """<Table>.csv or <machine>_<Table>.csv (the converter prefixes the database name)."""
    for name in sorted(os.listdir(csv_dir)):
        if name.lower() == (table + '.csv').lower() or name.lower().endswith('_' + table.lower() + '.csv'):
            return os.path.join(csv_dir, name)
    return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        print(__doc__); sys.exit(2)
    csv_dir = args[0]
    max_files = int(sys.argv[sys.argv.index('--max') + 1]) if '--max' in sys.argv else 0
    verbose = '--verbose' in sys.argv

    # converter output grouped by RunID
    got = collections.defaultdict(lambda: collections.defaultdict(list))
    for table, cols in TABLES.items():
        p = find_csv(csv_dir, table)
        if p is None:
            print('missing', os.path.join(csv_dir, '*' + table + '.csv')); sys.exit(2)
        with open(p, encoding='utf-8', newline='') as fh:
            rd = csv.DictReader(fh)
            if rd.fieldnames != cols:
                print('FAIL column layout of', table, rd.fieldnames); sys.exit(1)
            for r in rd:
                got[r['RunID']][table].append(tuple(r[c] for c in cols))
    with open(find_csv(csv_dir, 'SourceFiles'), encoding='utf-8', newline='') as fh:
        sources = list(csv.DictReader(fh))
    with open(find_csv(csv_dir, 'SkippedFiles'), encoding='utf-8', newline='') as fh:
        skipped = list(csv.DictReader(fh))
    print('converter wrote %d runs, %d skipped files' % (len(sources), len(skipped)))
    dup = [r for r, n in collections.Counter(s['RunID'] for s in sources).items() if n > 1]
    for r in dup:
        print('FAIL RunID %s imported from several files: %s' % (r, ', '.join(s['FileName'] for s in sources if s['RunID'] == r)))

    fails = len(dup); checked_rows = 0; checked_files = 0
    by_file = collections.defaultdict(list)
    for s in sources:
        by_file[s['FilePath']].append(s)
    for path, runs in by_file.items():
        if max_files and checked_files >= max_files:
            break
        checked_files += 1
        try:
            exp = expected_rows(path)
        except Exception as e:  # noqa
            print('FAIL cannot re-parse', path, e); fails += 1; continue
        for s in runs:
            run = s['RunID']
            e_tables = exp.get(run)
            if e_tables is None:
                print('FAIL run %s not found in %s' % (run, path)); fails += 1; continue
            e_total = sum(len(v) for v in e_tables.values())
            if int(s['Rows']) != e_total:
                print('FAIL %s run %s: SourceFiles.Rows=%s expected %d' % (os.path.basename(path), run, s['Rows'], e_total)); fails += 1
            for table, cols in TABLES.items():
                e_rows = [tuple(truncate(v, c) for v, c in zip(r, cols)) for r in e_tables.get(table, [])]
                g_rows = got[run].get(table, [])
                if len(e_rows) != len(g_rows):
                    print('FAIL %s %s: converter %d rows, expected %d' % (os.path.basename(path), table, len(g_rows), len(e_rows))); fails += 1; continue
                for er, gr in zip(e_rows, g_rows):          # both are in document order
                    for c, ev, gv in zip(cols, er, gr):
                        if not same(table, c, ev, gv):
                            fails += 1
                            if fails <= 40:
                                print('FAIL %s %s.%s: converter %r expected %r' % (os.path.basename(path), table, c, gv, ev))
                checked_rows += len(e_rows)
            if verbose:
                print('ok', os.path.basename(path), run, e_total, 'rows')
    for sk in skipped:
        p = sk['FilePath']
        if os.path.exists(p) and os.path.getsize(p) > 0 and 'empty' in sk['Reason']:
            print('FAIL skipped as empty but has data:', p); fails += 1
    print('checked %d files, %d result rows, %d failures' % (checked_files, checked_rows, fails))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()

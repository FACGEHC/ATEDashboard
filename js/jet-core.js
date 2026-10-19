/* jet-core.js - minimal read-only Microsoft Access (Jet4 / ACE) page reader.
 *
 * Like parse-core.js this function must not reference anything outside itself: its source text is
 * embedded into the Blob-URL worker. It reads the database lazily through a "source" object
 * ({ size, read(offset, len) -> Promise<ArrayBuffer> }) so a 700 MB file is never held in memory;
 * only the pages of the table being scanned are read, in multi-megabyte runs.
 *
 * Scope: Jet4-format .mdb (Access 2000+) and ACE .accdb headers with 4096-byte pages, TEXT / LONG /
 * INT / BOOL / DOUBLE columns. Memo, OLE and other types decode as null. Overflow rows are skipped.
 * Layout follows the mdbtools HACKING notes and was checked against data/CATE_1001.mdb.
 */
function cateJetCore() {
  'use strict';
  var PG = 4096;
  var OFFSET_MASK = 0x1FFF, FLAG_DELETED = 0x8000, FLAG_LOOKUP = 0x4000;
  var T_BOOL = 0x01, T_BYTE = 0x02, T_INT = 0x03, T_LONG = 0x04, T_DOUBLE = 0x07, T_DATETIME = 0x08, T_TEXT = 0x0A;

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function i16(b, o) { var v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v; }
  function i32(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); }
  function f64(b, o) { return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true); }

  var dec16 = new TextDecoder('utf-16le');
  var dec1252 = null;
  try { dec1252 = new TextDecoder('windows-1252'); } catch (e) { dec1252 = null; }

  /* Jet4 text: "FF FE" prefix marks a compressed string (one byte per char, a 0x00 byte toggles
   * to / from UTF-16LE segments); anything else is plain UTF-16LE. */
  function decodeText(b, start, end) {
    if (end - start >= 2 && b[start] === 0xFF && b[start + 1] === 0xFE) {
      var out = '', i = start + 2, wide = false, run = i;
      while (i < end) {
        if (wide) {
          if (b[i] === 0) { wide = false; i++; run = i; continue; }
          if (i + 1 >= end) break;
          out += String.fromCharCode(u16(b, i)); i += 2;
        } else {
          if (b[i] === 0) { out += flushNarrow(b, run, i); wide = true; i++; continue; }
          i++;
        }
      }
      if (!wide) out += flushNarrow(b, run, i);
      return out;
    }
    return dec16.decode(b.subarray(start, end));
  }
  function flushNarrow(b, s, e) {
    if (e <= s) return '';
    var ascii = true;
    for (var i = s; i < e; i++) if (b[i] >= 0x80) { ascii = false; break; }
    if (ascii || !dec1252) { var r = ''; for (var j = s; j < e; j++) r += String.fromCharCode(b[j]); return r; }
    return dec1252.decode(b.subarray(s, e));
  }

  /* Row r of a data page: { start, end, deleted, lookup } with offsets inside the page, or null. */
  function rowSpan(b, r) {
    var n = u16(b, 0x0C);
    if (r < 0 || r >= n) return null;
    var raw = u16(b, 0x0E + 2 * r);
    var end = r === 0 ? PG : (u16(b, 0x0E + 2 * (r - 1)) & OFFSET_MASK);
    return { start: raw & OFFSET_MASK, end: end, deleted: !!(raw & FLAG_DELETED), lookup: !!(raw & FLAG_LOOKUP) };
  }

  function parseTdef(buf, page) {
    var t = { page: page, numRows: u32(buf, 0x10), numVarCols: u16(buf, 0x2B), numCols: u16(buf, 0x2D),
              numIdx: u32(buf, 0x2F), numRealIdx: u32(buf, 0x33), usageMapPtr: u32(buf, 0x37), freeMapPtr: u32(buf, 0x3B),
              cols: [], byName: {} };
    var pos = 0x3F + 12 * t.numRealIdx;
    for (var c = 0; c < t.numCols; c++) {
      t.cols.push({ type: buf[pos], num: u16(buf, pos + 5), varNum: u16(buf, pos + 7), flags: buf[pos + 15],
                    fixed: !!(buf[pos + 15] & 0x01), fixedOffset: u16(buf, pos + 21), size: u16(buf, pos + 23), name: '' });
      pos += 25;
    }
    for (var k = 0; k < t.numCols; k++) {
      var len = u16(buf, pos); pos += 2;
      t.cols[k].name = dec16.decode(buf.subarray(pos, pos + len)); pos += len;
      t.byName[t.cols[k].name] = t.cols[k];
    }
    return t;
  }

  /* Decode one row into `out` (array aligned with `wanted`, strings or null). */
  function decodeRow(tdef, b, start, end, wanted, out) {
    var ncols = u16(b, start);
    var nm = (ncols + 7) >> 3;
    if (end - start < 2 + nm) return false;
    var maskAt = end - nm;
    var nVar = u16(b, maskAt - 2);
    var offBase = maskAt - 4;                 // offs[i] = u16(offBase - 2*i), i = 0..nVar
    if (offBase - 2 * nVar < start) return false;
    for (var w = 0; w < wanted.length; w++) {
      var col = wanted[w];
      out[w] = null;
      if (!col || col.num >= ncols) continue;
      var present = (b[maskAt + (col.num >> 3)] >> (col.num & 7)) & 1;
      if (col.type === T_BOOL) { out[w] = present ? '1' : '0'; continue; }
      if (!present) continue;
      var s, e;
      if (col.fixed) { s = start + 2 + col.fixedOffset; e = s + col.size; }
      else {
        if (col.varNum >= nVar) continue;
        s = start + u16(b, offBase - 2 * col.varNum);
        e = start + u16(b, offBase - 2 * (col.varNum + 1));
      }
      if (s < start || e > end || e < s) continue;
      switch (col.type) {
        case T_TEXT: out[w] = decodeText(b, s, e); break;
        case T_LONG: out[w] = String(i32(b, s)); break;
        case T_INT: out[w] = String(i16(b, s)); break;
        case T_BYTE: out[w] = String(b[s]); break;
        case T_DOUBLE: case T_DATETIME: out[w] = String(f64(b, s)); break;
        default: out[w] = null;
      }
    }
    return true;
  }

  function open(src) {
    var pageCache = new Map();
    function readPage(p) {
      var hit = pageCache.get(p);
      if (hit) return Promise.resolve(hit);
      return src.read(p * PG, PG).then(function (ab) { var b = new Uint8Array(ab); if (pageCache.size < 512) pageCache.set(p, b); return b; });
    }
    /* TDEF pages chain through the "next page" field at 0x04; later pages contribute their bytes from 0x08. */
    function readTdef(page) {
      var parts = [], total = 0;
      function step(p, first) {
        return readPage(p).then(function (b) {
          if (b[0] !== 0x02) throw new Error('Page ' + p + ' is not a table definition page');
          var part = first ? b : b.subarray(8);
          parts.push(part); total += part.length;
          var next = u32(b, 4);
          if (next && next !== p && parts.length < 64) return step(next, false);
          var buf = new Uint8Array(total), o = 0;
          parts.forEach(function (x) { buf.set(x, o); o += x.length; });
          return parseTdef(buf, page);
        });
      }
      return step(page, true);
    }
    function rowBytes(ptr) {
      var page = ptr >>> 8, row = ptr & 0xFF;
      return readPage(page).then(function (b) {
        var sp = rowSpan(b, row);
        if (!sp || sp.deleted) throw new Error('Bad row pointer ' + ptr.toString(16));
        return b.subarray(sp.start, sp.end);
      });
    }
    /* Pages owned by a table, ascending. */
    function parseUsageMap(ptr) {
      return rowBytes(ptr).then(function (m) {
        var pages = [];
        if (m[0] === 0x00) {
          var startPg = u32(m, 1);
          for (var i = 5; i < m.length; i++) {
            var byte = m[i]; if (!byte) continue;
            for (var bit = 0; bit < 8; bit++) if (byte & (1 << bit)) pages.push(startPg + (i - 5) * 8 + bit);
          }
          return Uint32Array.from(pages);
        }
        if (m[0] === 0x01) {
          var mapPages = [];
          for (var k = 1; k + 4 <= m.length; k += 4) mapPages.push(u32(m, k));
          var per = (PG - 4) * 8;
          var chain = Promise.resolve();
          mapPages.forEach(function (mp, idx) {
            if (!mp) return;
            chain = chain.then(function () { return readPage(mp); }).then(function (b) {
              if (b[0] !== 0x05) throw new Error('Page ' + mp + ' is not a usage bitmap page');
              var base = idx * per;
              for (var i = 4; i < PG; i++) {
                var byte = b[i]; if (!byte) continue;
                for (var bit = 0; bit < 8; bit++) if (byte & (1 << bit)) pages.push(base + (i - 4) * 8 + bit);
              }
            });
          });
          return chain.then(function () { pages.sort(function (a, b) { return a - b; }); return Uint32Array.from(pages); });
        }
        throw new Error('Unknown usage map type ' + m[0]);
      });
    }

    var db = { tables: new Map(), tdefs: new Map(), pageSize: PG, version: 0, signature: '' };

    /* Scan every live row of a table. wantedNames: column names; onRow(fields) gets strings/null in that order.
     * opts: { batchPages (default 1024), onProgress(pagesDone, pagesTotal), yieldFn }. */
    db.scan = function (tdef, wantedNames, onRow, opts) {
      opts = opts || {};
      var batch = opts.batchPages || 1024;
      var wanted = wantedNames.map(function (n) { return tdef.byName[n] || null; });
      var fields = new Array(wanted.length);
      var stats = { rows: 0, deleted: 0, lookup: 0, short: 0, pages: 0, wrongPages: 0 };
      return parseUsageMap(tdef.usageMapPtr).then(function (pages) {
        var runs = [];
        for (var i = 0; i < pages.length;) {
          var s = pages[i], j = i + 1;
          while (j < pages.length && pages[j] === pages[j - 1] + 1 && j - i < batch) j++;
          runs.push({ start: s, len: j - i }); i = j;
        }
        var done = 0, idx = 0;
        function next() {
          if (idx >= runs.length) return Promise.resolve(stats);
          var run = runs[idx++];
          return src.read(run.start * PG, run.len * PG).then(function (ab) {
            var buf = new Uint8Array(ab);
            for (var p = 0; p < run.len; p++) {
              var b = buf.subarray(p * PG, (p + 1) * PG);
              stats.pages++;
              if (b[0] !== 0x01 || u32(b, 4) !== tdef.page) { stats.wrongPages++; continue; }
              var n = u16(b, 0x0C);
              for (var r = 0; r < n; r++) {
                var sp = rowSpan(b, r);
                if (!sp || sp.deleted) { stats.deleted++; continue; }
                if (sp.lookup) { stats.lookup++; continue; }
                if (sp.start >= sp.end) { stats.short++; continue; }
                if (!decodeRow(tdef, b, sp.start, sp.end, wanted, fields)) { stats.short++; continue; }
                stats.rows++;
                onRow(fields);
              }
            }
            done += run.len;
            if (opts.onProgress) opts.onProgress(done, pages.length);
            if (opts.yieldFn) return opts.yieldFn().then(next);
            return next();
          });
        }
        stats.pagesTotal = pages.length;
        return next();
      });
    };
    db.table = function (name) {
      var cached = db.tdefs.get(name);
      if (cached) return Promise.resolve(cached);
      var page = db.tables.get(name);
      if (page === undefined) return Promise.reject(new Error('No table named "' + name + '"'));
      return readTdef(page).then(function (t) { db.tdefs.set(name, t); return t; });
    };
    db.tableNames = function () { return Array.from(db.tables.keys()); };
    db.pagesOf = function (tdef) { return parseUsageMap(tdef.usageMapPtr); };
    db.readTdef = readTdef;

    return readPage(0).then(function (b) {
      var sig = '';
      for (var i = 4; i < 19; i++) sig += String.fromCharCode(b[i]);
      db.signature = sig; db.version = b[0x14];
      if (sig !== 'Standard Jet DB' && sig !== 'Standard ACE DB') throw new Error('Not an Access database (signature "' + sig + '")');
      if (db.version < 1) throw new Error('Access 97 (Jet3) databases are not supported; convert to Access 2000+ format');
      return readTdef(2);                       // MSysObjects
    }).then(function (cat) {
      var catTdef = cat;
      var byName = catTdef.byName;
      if (!byName.Id || !byName.Name || !byName.Type) throw new Error('Unexpected system catalog layout');
      return db.scan(catTdef, ['Id', 'Name', 'Type'], function (f) {
        if (f[2] === '1' && f[1] && f[0] !== null) db.tables.set(f[1], parseInt(f[0], 10) >>> 0);
      }, { batchPages: 64 }).then(function () { return db; });
    });
  }

  /* Browser File -> source */
  function fileSource(file) {
    return { size: file.size, read: function (offset, len) { return file.slice(offset, Math.min(offset + len, file.size)).arrayBuffer(); } };
  }

  return { PG: PG, open: open, fileSource: fileSource, decodeText: decodeText, parseTdef: parseTdef, rowSpan: rowSpan, decodeRow: decodeRow };
}
if (typeof module !== 'undefined' && module.exports) module.exports = cateJetCore;

/* zip.js - minimal STORE-only (no compression) zip writer. PNGs are already compressed. */
(function (root) {
  'use strict';
  var CATE = root.CATE || (root.CATE = {});

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  function ZipWriter() { this.parts = []; this.central = []; this.offset = 0; this.now = dosDateTime(new Date()); }

  ZipWriter.prototype.add = function (name, bytes) {          // bytes: Uint8Array
    var nameBytes = new TextEncoder().encode(name);
    var crc = crc32(bytes);
    var h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, 0, true); h.setUint16(10, this.now.time, true); h.setUint16(12, this.now.date, true);
    h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true);
    h.setUint16(26, nameBytes.length, true); h.setUint16(28, 0, true);
    var c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, this.now.time, true); c.setUint16(14, this.now.date, true);
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true);
    c.setUint16(28, nameBytes.length, true); c.setUint16(30, 0, true); c.setUint16(32, 0, true);
    c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, this.offset, true);
    this.parts.push(h.buffer, nameBytes, bytes);
    this.central.push(c.buffer, nameBytes);
    this.offset += 30 + nameBytes.length + bytes.length;
  };

  ZipWriter.prototype.toBlob = function () {
    var cdSize = 0;
    this.central.forEach(function (p) { cdSize += p.byteLength; });
    var e = new DataView(new ArrayBuffer(22));
    var count = this.central.length / 2;
    e.setUint32(0, 0x06054b50, true); e.setUint16(4, 0, true); e.setUint16(6, 0, true);
    e.setUint16(8, count, true); e.setUint16(10, count, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, this.offset, true); e.setUint16(20, 0, true);
    return new Blob(this.parts.concat(this.central, [e.buffer]), { type: 'application/zip' });
  };

  CATE.ZipWriter = ZipWriter;
  CATE.crc32 = crc32;
})(typeof globalThis !== 'undefined' ? globalThis : this);

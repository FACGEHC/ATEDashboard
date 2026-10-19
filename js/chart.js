/* chart.js - canvas renderer reproducing the matplotlib run charts.
 * Logical coordinate space: 1950 x 1050 (13 x 7 in at 150 dpi) for the chart, plus an optional
 * statistics panel below it. 1 pt = 150/72 px.
 */
(function (root) {
  'use strict';
  var CATE = root.CATE || (root.CATE = {});
  var T = CATE.ticks;

  var W0 = 1950, H0 = 1050;
  var PT = 150 / 72;
  var FONT = '"DejaVu Sans", Verdana, "Segoe UI", Arial, sans-serif';
  var F_TITLE = 12 * PT, F_LABEL = 10 * PT, F_TICK = 10 * PT, F_LEGEND = 8 * PT, F_NOTE = 9 * PT;
  var F_STATS = 8 * PT, F_OUT = 8 * PT;
  var PAD = 1.08 * 10 * PT;            // tight_layout pad
  var TICK_LEN = 3.5 * PT, TICK_PAD = 3.5 * PT, LABEL_PAD = 4 * PT, TITLE_PAD = 6 * PT;
  var LW_AXIS = 0.8 * PT, LW_SPEC = 2.2 * PT;
  var R_SMALL = Math.sqrt(24 / Math.PI) * PT;      // scatter s=24 (pt^2)
  var R_BIG = Math.sqrt(55 / Math.PI) * PT;        // scatter s=55
  var COS45 = Math.SQRT1_2;
  var BAND_FRAC = 0.11;                            // off-scale band height as a fraction of the plot
  var STATS_ROW = 1.7 * F_STATS, STATS_FOOT = 1.4 * F_STATS;
  var COLOR_OUT = '#F37F63';                       // GEHC coral

  function font(px, weight) { return (weight ? weight + ' ' : '') + px.toFixed(2) + 'px ' + FONT; }

  function drawMarker(ctx, shape, x, y, r) {
    ctx.beginPath();
    switch (shape) {
      case 'square':
        ctx.rect(x - r * 0.89, y - r * 0.89, r * 1.78, r * 1.78); break;
      case 'diamond':
        ctx.moveTo(x, y - r * 1.15); ctx.lineTo(x + r * 1.15, y); ctx.lineTo(x, y + r * 1.15); ctx.lineTo(x - r * 1.15, y); ctx.closePath(); break;
      case 'triangle':
        ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.1, y + r * 0.75); ctx.lineTo(x - r * 1.1, y + r * 0.75); ctx.closePath(); break;
      case 'triangleDown':
        ctx.moveTo(x, y + r * 1.2); ctx.lineTo(x + r * 1.1, y - r * 0.75); ctx.lineTo(x - r * 1.1, y - r * 0.75); ctx.closePath(); break;
      case 'hexagon':
        for (var hi = 0; hi < 6; hi++) { var a = Math.PI / 6 + hi * Math.PI / 3; var hx = x + r * 1.1 * Math.cos(a), hy = y + r * 1.1 * Math.sin(a); if (hi) ctx.lineTo(hx, hy); else ctx.moveTo(hx, hy); }
        ctx.closePath(); break;
      default:
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
  }

  function fmtNum(v, d) { return v === v && v !== null && v !== undefined ? T.formatNumber(v, d === undefined ? 2 : d) : '—'; }

  /* ---------- statistics panel height ---------- */
  function statsHeight(spec, opts) {
    opts = opts || {};
    if (!spec.stats || opts.noStats) return 0;
    return 0.5 * PAD + STATS_ROW * (1 + spec.stats.rows.length) + STATS_FOOT * spec.stats.footnotes.length + PAD;
  }
  function heightFor(spec, opts) { return H0 + statsHeight(spec, opts); }

  /* ---------- layout in logical units ---------- */
  function layout(ctx, spec) {
    var yt = T.numericTicks(spec.yMin, spec.yMax);
    var yLabels = yt.ticks.map(function (v) { return T.formatNumber(v, yt.decimals); });
    var xt = T.dateTicks(spec.xMin, spec.xMax);
    var xLabels = xt.map(T.formatDate);

    ctx.font = font(F_TICK);
    var maxYw = 0;
    yLabels.forEach(function (s) { maxYw = Math.max(maxYw, ctx.measureText(s).width); });
    var flagMode = spec.outlierMode === 'flag' && spec.outliers;
    var bandLabels = { top: flagMode && spec.outliers.nHigh ? '▲ ' + spec.outliers.nHigh + ' outlier' + (spec.outliers.nHigh === 1 ? '' : 's') : null,
                       bot: flagMode && spec.outliers.nLow ? '▼ ' + spec.outliers.nLow + ' outlier' + (spec.outliers.nLow === 1 ? '' : 's') : null };
    ctx.font = font(F_OUT);
    [bandLabels.top, bandLabels.bot].forEach(function (s) { if (s) maxYw = Math.max(maxYw, ctx.measureText(s).width); });
    ctx.font = font(F_TICK);
    var maxXw = 0;
    xLabels.forEach(function (s) { maxXw = Math.max(maxXw, ctx.measureText(s).width); });
    var rotExtent = maxXw * COS45 + F_TICK * COS45;

    var top = PAD + 2 * F_TITLE * 1.2 + TITLE_PAD;
    var left = PAD + F_LABEL + LABEL_PAD + maxYw + TICK_PAD + TICK_LEN;
    var bottom = PAD + F_LABEL + LABEL_PAD + rotExtent + TICK_PAD + TICK_LEN;
    var right = PAD + 6;
    var L = { x0: left, y0: top, x1: W0 - right, y1: H0 - bottom, yt: yt, yLabels: yLabels, xt: xt, xLabels: xLabels };
    L.pw = L.x1 - L.x0; L.ph = L.y1 - L.y0;

    // off-scale bands (flag mode only)
    L.bandLabels = bandLabels;
    L.topBand = bandLabels.top ? BAND_FRAC * L.ph : 0;
    L.botBand = bandLabels.bot ? BAND_FRAC * L.ph : 0;
    L.my0 = L.y0 + L.topBand; L.my1 = L.y1 - L.botBand; L.mph = L.my1 - L.my0;
    L.pinTop = L.y0 + L.topBand / 2; L.pinBot = L.y1 - L.botBand / 2;

    var xr = spec.xMax - spec.xMin || 1, yr = spec.yMax - spec.yMin || 1;
    L.sx = function (t) { return L.x0 + (t - spec.xMin) / xr * L.pw; };
    L.sy = function (v) { return L.my1 - (v - spec.yMin) / yr * L.mph; };
    L.ptY = function (s, i) {
      var f = s.flags ? s.flags[i] : 0;
      return f === 1 ? L.pinTop : f === 2 ? L.pinBot : L.sy(s.ys[i]);
    };
    return L;
  }

  /* ---------- legend geometry + best placement ---------- */
  function legendLayout(ctx, spec, L) {
    var entries = [];
    spec.series.forEach(function (s) { entries.push({ kind: 'marker', label: s.label, color: s.color, shape: s.shape, big: s.big }); });
    spec.lsl.forEach(function (l) { entries.push({ kind: 'line', label: l.label, color: '#ff0000', dash: 'dashed' }); });
    spec.usl.forEach(function (l) { entries.push({ kind: 'line', label: l.label, color: '#8b0000', dash: 'dashdot' }); });
    if (spec.outlierMode === 'flag' && spec.outliers && spec.outliers.count) {
      var o = spec.outliers;
      entries.push({ kind: 'outlier', label: 'Outlier: ' + o.count + ' flagged, ' + o.nPinned + ' off-scale (k = ' + o.k + ')' });
    }
    if (!entries.length) return null;
    ctx.font = font(F_LEGEND);
    var fs = F_LEGEND;
    var borderPad = 0.4 * fs, handleLen = 2.0 * fs, handlePad = 0.8 * fs, spacing = 0.5 * fs, axesPad = 0.5 * fs;
    var textW = 0;
    entries.forEach(function (e) { textW = Math.max(textW, ctx.measureText(e.label).width); });
    var rowH = fs * 1.15;
    var w = borderPad * 2 + handleLen + handlePad + textW;
    var h = borderPad * 2 + entries.length * rowH + (entries.length - 1) * spacing;

    // note boxes (top-left of the main region) count as occupied
    var notes = [];
    ctx.font = font(F_NOTE);
    var nx = L.x0 + 0.01 * L.pw, ny = L.my0 + 0.02 * L.ph, bp = 0.3 * F_NOTE;
    [spec.missingSpec ? 'Specification limit: N/A' : null, spec.excludedNote].forEach(function (t) {
      if (!t) return;
      var tw = ctx.measureText(t).width;
      notes.push({ x0: nx - bp, y0: ny - bp, x1: nx + tw + bp, y1: ny + F_NOTE + bp });
      ny += F_NOTE + 2 * bp + 0.4 * F_NOTE;
    });
    ctx.font = font(F_LEGEND);

    // candidate anchors in matplotlib 'best' order, within the main (non-band) region
    var cands = [[1, 1], [0, 1], [0, 0], [1, 0], [1, 0.5], [0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1], [0.5, 0.5]];
    var best = null, bestBad = Infinity;
    for (var c = 0; c < cands.length; c++) {
      var fx = cands[c][0], fy = cands[c][1];
      var bx = L.x0 + axesPad + fx * (L.pw - w - 2 * axesPad);
      var by = L.my1 - axesPad - h - fy * (L.mph - h - 2 * axesPad);
      var bad = 0;
      for (var si = 0; si < spec.series.length && bad < bestBad; si++) {
        var s = spec.series[si];
        for (var i = 0; i < s.xs.length; i++) {
          var px = L.sx(s.xs[i]), py = L.ptY(s, i);
          if (px >= bx && px <= bx + w && py >= by && py <= by + h) { bad++; if (bad >= bestBad) break; }
        }
      }
      spec.lsl.concat(spec.usl).forEach(function (l) { var py = L.sy(l.value); if (py >= by && py <= by + h) bad += 1; });
      notes.forEach(function (nb) { if (bx < nb.x1 && bx + w > nb.x0 && by < nb.y1 && by + h > nb.y0) bad += 50; });
      if (bad < bestBad) { bestBad = bad; best = { x: bx, y: by }; if (bad === 0) break; }
    }
    return { entries: entries, x: best.x, y: best.y, w: w, h: h, fs: fs, borderPad: borderPad, handleLen: handleLen, handlePad: handlePad, spacing: spacing, rowH: rowH };
  }

  function drawOutlierMarker(ctx, shape, x, y, r, color) {
    ctx.save();
    ctx.globalAlpha = 1;
    drawMarker(ctx, shape, x, y, r * 1.15);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.strokeStyle = COLOR_OUT; ctx.lineWidth = 2 * PT; ctx.stroke();
    drawMarker(ctx, shape, x, y, r * 0.5);
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  function noteBox(ctx, text, x, y, color) {
    ctx.save();
    ctx.font = font(F_NOTE);
    var tw = ctx.measureText(text).width, bp = 0.3 * F_NOTE;
    ctx.globalAlpha = 0.8;
    roundRect(ctx, x - bp, y - bp, tw + 2 * bp, F_NOTE + 2 * bp, bp);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = PT; ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
    ctx.restore();
    return F_NOTE + 2 * bp;
  }

  /* ---------- draw the whole chart (and stats panel) in logical units ---------- */
  function draw(ctx, spec, opts) {
    opts = opts || {};
    var H = heightFor(spec, opts);
    var L = layout(ctx, spec);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W0, H);

    // grid (main region only)
    ctx.save();
    ctx.strokeStyle = '#b0b0b0'; ctx.globalAlpha = 0.3; ctx.lineWidth = LW_AXIS;
    ctx.beginPath();
    L.yt.ticks.forEach(function (v) { var y = L.sy(v); ctx.moveTo(L.x0, y); ctx.lineTo(L.x1, y); });
    L.xt.forEach(function (t) { var x = L.sx(t); ctx.moveTo(x, L.my0); ctx.lineTo(x, L.my1); });
    ctx.stroke();
    ctx.restore();

    // clip to axes for data
    ctx.save();
    ctx.beginPath(); ctx.rect(L.x0, L.y0, L.pw, L.ph); ctx.clip();

    // off-scale bands
    var bands = [];
    if (L.topBand) bands.push({ y: L.y0, h: L.topBand, sep: L.my0 });
    if (L.botBand) bands.push({ y: L.my1, h: L.botBand, sep: L.my1 });
    bands.forEach(function (b) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.035)'; ctx.fillRect(L.x0, b.y, L.pw, b.h);
      ctx.strokeStyle = '#9a9a9a'; ctx.lineWidth = LW_AXIS; ctx.setLineDash([4 * PT, 3 * PT]);
      ctx.beginPath(); ctx.moveTo(L.x0, b.sep); ctx.lineTo(L.x1, b.sep); ctx.stroke();
      ctx.restore();
    });

    // spec lines (zorder 2); a revised limit is drawn only over the dates it applied (l.x0/l.x1 in ms,
    // null = chart edge) with a thin dotted riser where the spec changed
    ctx.lineWidth = LW_SPEC;
    function specLine(l, color, dash) {
      var y = L.sy(l.value);
      var xa = l.x0 == null ? L.x0 : Math.max(L.x0, L.sx(l.x0)), xb = l.x1 == null ? L.x1 : Math.min(L.x1, L.sx(l.x1));
      if (xb <= xa) return;
      ctx.strokeStyle = color; ctx.lineWidth = LW_SPEC; ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
      if (l.riserFrom != null && l.x0 != null) {
        ctx.lineWidth = 0.5 * LW_SPEC; ctx.setLineDash([1.2 * LW_SPEC, 1.2 * LW_SPEC]);
        ctx.beginPath(); ctx.moveTo(xa, L.sy(l.riserFrom)); ctx.lineTo(xa, y); ctx.stroke();
      }
    }
    spec.lsl.forEach(function (l) { specLine(l, '#ff0000', [3.7 * LW_SPEC, 1.6 * LW_SPEC]); });
    spec.usl.forEach(function (l) { specLine(l, '#8b0000', [6.4 * LW_SPEC, 1.6 * LW_SPEC, 1.0 * LW_SPEC, 1.6 * LW_SPEC]); });
    ctx.lineWidth = LW_SPEC; ctx.setLineDash([]);

    // series: normal first (zorder 3), then 'big' (zorder 5); flagged points are drawn afterwards
    var ordered = spec.series.filter(function (s) { return !s.big; }).concat(spec.series.filter(function (s) { return s.big; }));
    ordered.forEach(function (s) {
      var r = s.big ? R_BIG : R_SMALL;
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = s.color;
      ctx.strokeStyle = '#000000'; ctx.lineWidth = 0.5 * PT;
      for (var i = 0; i < s.xs.length; i++) {
        if (s.flags && s.flags[i]) continue;
        drawMarker(ctx, s.shape, L.sx(s.xs[i]), L.sy(s.ys[i]), r);
        ctx.fill();
        if (s.big) ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });

    // flagged points: coral ring; pinned ones get their true value printed when it fits
    if (spec.outlierMode === 'flag' && spec.outliers && spec.outliers.count) {
      var labels = { top: [], bot: [] };
      var dec = spec.decimals === undefined ? 2 : spec.decimals;
      spec.series.forEach(function (s) {
        if (!s.flags) return;
        var r = s.big ? R_BIG : R_SMALL;
        for (var i = 0; i < s.flags.length; i++) {
          var f = s.flags[i]; if (!f) continue;
          var x = L.sx(s.xs[i]), y = L.ptY(s, i);
          drawOutlierMarker(ctx, s.shape, x, y, r, s.color);
          if (f === 1) labels.top.push({ x: x, r: r * 1.15, text: T.formatNumber(s.ys[i], dec) });
          else if (f === 2) labels.bot.push({ x: x, r: r * 1.15, text: T.formatNumber(s.ys[i], dec) });
        }
      });
      ctx.font = font(F_OUT); ctx.fillStyle = '#333333'; ctx.textBaseline = 'middle';
      spec.labelStats = { drawn: 0, skipped: 0, rects: [] };
      [['top', L.pinTop, L.topBand, L.y0], ['bot', L.pinBot, L.botBand, L.y1 - L.botBand]].forEach(function (cfg) {
        var list = labels[cfg[0]]; if (!list.length) return;
        var pinY = cfg[1], bandH = cfg[2], bandTop = cfg[3];
        var lanes = [pinY, pinY - 0.32 * bandH, pinY + 0.32 * bandH];   // centre, above, below
        var margin = 0.3 * F_OUT, half = F_OUT / 2;
        var xMin = L.x0 + 2 * PT, xMax = L.x1 - 2 * PT;
        var yMin = bandTop + 1, yMax = bandTop + bandH - 1;
        // every marker in the band blocks text (markers all sit on the pin line)
        var blocks = list.map(function (m) { return { x0: m.x - m.r, x1: m.x + m.r, y0: pinY - m.r, y1: pinY + m.r }; });
        function clear(rc) {
          if (rc.x0 < xMin || rc.x1 > xMax || rc.y0 < yMin || rc.y1 > yMax) return false;
          for (var b = 0; b < blocks.length; b++) {
            var o = blocks[b];
            if (rc.x0 < o.x1 + margin && rc.x1 > o.x0 - margin && rc.y0 < o.y1 + margin && rc.y1 > o.y0 - margin) return false;
          }
          return true;
        }
        list.sort(function (a, b) { return a.x - b.x; });
        list.forEach(function (lb) {
          var w = ctx.measureText(lb.text).width;
          var placed = null;
          // candidates: centre lane right/left, then above, then below
          for (var q = 0; q < 3 && !placed; q++) {
            for (var side = 0; side < 2 && !placed; side++) {
              var left = side === 0 ? lb.x + lb.r + 2 * PT : lb.x - lb.r - 2 * PT - w;
              var rc = { x0: left, x1: left + w, y0: lanes[q] - half, y1: lanes[q] + half };
              if (clear(rc)) placed = rc;
            }
          }
          if (!placed) { spec.labelStats.skipped++; return; }   // no room: the tooltip carries the value
          blocks.push(placed); spec.labelStats.rects.push(placed); spec.labelStats.drawn++;
          ctx.textAlign = 'left';
          ctx.fillText(lb.text, placed.x0, (placed.y0 + placed.y1) / 2);
        });
      });
    }
    ctx.restore();

    // axes frame + ticks
    ctx.strokeStyle = '#000000'; ctx.lineWidth = LW_AXIS; ctx.fillStyle = '#000000';
    ctx.strokeRect(L.x0, L.y0, L.pw, L.ph);
    ctx.beginPath();
    L.yt.ticks.forEach(function (v) { var y = L.sy(v); ctx.moveTo(L.x0, y); ctx.lineTo(L.x0 - TICK_LEN, y); });
    L.xt.forEach(function (t) { var x = L.sx(t); ctx.moveTo(x, L.y1); ctx.lineTo(x, L.y1 + TICK_LEN); });
    ctx.stroke();

    ctx.font = font(F_TICK);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    L.yt.ticks.forEach(function (v, i) { ctx.fillText(L.yLabels[i], L.x0 - TICK_LEN - TICK_PAD, L.sy(v)); });
    // band labels in the tick-label margin
    ctx.save();
    ctx.font = font(F_OUT); ctx.fillStyle = '#555555';
    if (L.bandLabels.top) ctx.fillText(L.bandLabels.top, L.x0 - TICK_LEN - TICK_PAD, L.pinTop);
    if (L.bandLabels.bot) ctx.fillText(L.bandLabels.bot, L.x0 - TICK_LEN - TICK_PAD, L.pinBot);
    ctx.restore();
    L.xt.forEach(function (t, i) {
      ctx.save();
      ctx.translate(L.sx(t), L.y1 + TICK_LEN + TICK_PAD);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillText(L.xLabels[i], 0, 0);
      ctx.restore();
    });

    // axis labels
    ctx.font = font(F_LABEL); ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Date', (L.x0 + L.x1) / 2, H0 - PAD);
    ctx.save();
    ctx.translate(PAD, (L.y0 + L.y1) / 2); ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'top';
    ctx.fillText(spec.yLabel || 'Sensitivity / Measurement (dB)', 0, 0);
    ctx.restore();

    // title
    ctx.font = font(F_TITLE); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    var cx = (L.x0 + L.x1) / 2;
    ctx.fillText(spec.title2, cx, L.y0 - TITLE_PAD);
    ctx.fillText(spec.title1, cx, L.y0 - TITLE_PAD - F_TITLE * 1.2);

    // notes (top-left of the main region)
    var noteY = L.my0 + 0.02 * L.ph, noteX = L.x0 + 0.01 * L.pw;
    if (spec.missingSpec) noteY += noteBox(ctx, 'Specification limit: N/A', noteX, noteY, '#8b0000') + 0.4 * F_NOTE;
    if (spec.excludedNote) noteY += noteBox(ctx, spec.excludedNote, noteX, noteY, '#555555') + 0.4 * F_NOTE;

    // legend
    var G = legendLayout(ctx, spec, L);
    if (G) {
      ctx.save(); ctx.globalAlpha = 0.8;
      roundRect(ctx, G.x, G.y, G.w, G.h, 0.3 * G.fs);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.strokeStyle = '#cccccc'; ctx.lineWidth = LW_AXIS; ctx.stroke();
      ctx.restore();
      ctx.font = font(G.fs); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      var hx = G.x + G.borderPad, tx = hx + G.handleLen + G.handlePad;
      G.entries.forEach(function (e, i) {
        var cy = G.y + G.borderPad + i * (G.rowH + G.spacing) + G.rowH / 2;
        if (e.kind === 'marker') {
          ctx.save(); ctx.globalAlpha = 0.75; ctx.fillStyle = e.color;
          var r = e.big ? R_BIG : R_SMALL;
          drawMarker(ctx, e.shape, hx + G.handleLen / 2, cy, r); ctx.fill();
          if (e.big) { ctx.strokeStyle = '#000'; ctx.lineWidth = 0.5 * PT; ctx.stroke(); }
          ctx.restore();
        } else if (e.kind === 'outlier') {
          drawOutlierMarker(ctx, 'circle', hx + G.handleLen / 2, cy, R_SMALL, '#808080');
        } else {
          ctx.save(); ctx.strokeStyle = e.color; ctx.lineWidth = LW_SPEC;
          ctx.setLineDash(e.dash === 'dashed' ? [3.7 * LW_SPEC, 1.6 * LW_SPEC] : [6.4 * LW_SPEC, 1.6 * LW_SPEC, 1.0 * LW_SPEC, 1.6 * LW_SPEC]);
          ctx.beginPath(); ctx.moveTo(hx, cy); ctx.lineTo(hx + G.handleLen, cy); ctx.stroke();
          ctx.restore();
        }
        ctx.fillStyle = '#000000';
        ctx.fillText(e.label, tx, cy);
      });
    }

    // statistics panel
    if (spec.stats && !opts.noStats) drawStats(ctx, spec, L);

    // watermark (partial data)
    if (opts.watermark) {
      ctx.save();
      ctx.font = font(F_NOTE, 'bold'); ctx.fillStyle = '#8b0000'; ctx.globalAlpha = 0.85;
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(opts.watermark, W0 - PAD, H - 4);
      ctx.restore();
    }
    return L;
  }

  /* ---------- statistics table below the chart ---------- */
  var STAT_COLS = [
    { key: 'label', title: 'Machine', frac: 0.14, align: 'left' },
    { key: 'n', title: 'n', frac: 0.05, align: 'right', fmt: function (r) { return String(r.n); } },
    { key: 'coils', title: 'Coils', frac: 0.05, align: 'right', fmt: function (r) { return String(r.coils); } },
    { key: 'mean', title: 'Mean', frac: 0.08, align: 'right' },
    { key: 'median', title: 'Median', frac: 0.08, align: 'right' },
    { key: 'std', title: 'Std dev', frac: 0.08, align: 'right' },
    { key: 'min', title: 'Min', frac: 0.08, align: 'right' },
    { key: 'max', title: 'Max', frac: 0.08, align: 'right' },
    { key: 'range', title: 'Range', frac: 0.08, align: 'right' },
    { key: 'outliers', title: 'Outliers', frac: 0.08, align: 'right', fmt: function (r, spec) {
        if (spec.outlierMode === 'off') return '—';
        if (!r.outliers) return '0';
        return (spec.stats && spec.stats.includesOutliers ? 'incl. ' : 'excl. ') + r.outliers; } },
    { key: 'inSpec', title: 'In spec', frac: 0.12, align: 'right', fmt: function (r) { return r.inSpecPct === r.inSpecPct ? r.inSpecPct.toFixed(1) + '% (' + r.pass + '/' + r.n + ')' : '—'; } },
    { key: 'cap', title: '', frac: 0.08, align: 'right', fmt: function (r, spec) { var h = spec.stats.capHeader; return h ? fmtNum(h === 'Cpk' ? r.cpk : h === 'Cpu' ? r.cpu : r.cpl) : '—'; } }
  ];

  function drawStats(ctx, spec, L) {
    var st = spec.stats;
    var x0 = L.x0, x1 = L.x1, w = x1 - x0;
    var y = H0 + 0.25 * PAD;
    ctx.save();
    ctx.strokeStyle = '#cccccc'; ctx.lineWidth = LW_AXIS;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    y += 0.25 * PAD;

    // column x positions
    var cols = [], cx = x0;
    STAT_COLS.forEach(function (c) { cols.push({ c: c, x: cx, w: c.frac * w }); cx += c.frac * w; });
    var cellPad = 0.5 * F_STATS;
    function cellX(col) { return col.c.align === 'right' ? col.x + col.w - cellPad : col.x + cellPad; }

    // header
    ctx.font = font(F_STATS, 'bold'); ctx.fillStyle = '#000000'; ctx.textBaseline = 'middle';
    var hy = y + STATS_ROW / 2;
    cols.forEach(function (col) {
      ctx.textAlign = col.c.align;
      ctx.fillText(col.c.key === 'cap' ? (st.capHeader || 'Cpk') : col.c.title, cellX(col), hy);
    });
    y += STATS_ROW;
    ctx.strokeStyle = '#000000'; ctx.lineWidth = LW_AXIS;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();

    // rows
    ctx.font = font(F_STATS);
    st.rows.forEach(function (r, ri) {
      var ry = y + STATS_ROW / 2;
      if (ri === st.rows.length - 1 && r.label === 'All machines') { ctx.font = font(F_STATS, 'bold'); }
      cols.forEach(function (col) {
        var c = col.c, txt;
        if (c.key === 'label') {
          var lx = col.x + cellPad;
          if (r.color) {
            ctx.save(); ctx.globalAlpha = 0.9; ctx.fillStyle = r.color;
            drawMarker(ctx, r.shape, lx + R_SMALL, ry, R_SMALL * 0.9); ctx.fill(); ctx.restore();
            lx += 2 * R_SMALL + 0.5 * F_STATS;
          }
          ctx.textAlign = 'left'; ctx.fillStyle = '#000000';
          ctx.fillText(r.label, lx, ry);
          return;
        }
        txt = c.fmt ? c.fmt(r, spec) : fmtNum(r[c.key], spec.decimals === undefined ? 2 : spec.decimals);
        ctx.textAlign = c.align; ctx.fillStyle = '#000000';
        ctx.fillText(txt, cellX(col), ry);
      });
      y += STATS_ROW;
      ctx.strokeStyle = '#e4e4e4'; ctx.lineWidth = LW_AXIS;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    });

    // footnotes
    ctx.font = font(F_STATS); ctx.fillStyle = '#555555'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    y += 0.3 * STATS_FOOT;
    st.footnotes.forEach(function (f) { ctx.fillText(f, x0, y + STATS_FOOT / 2); y += STATS_FOOT; });
    ctx.restore();
  }

  /* ---------- public API ---------- */

  /* Render into a <canvas> element at CSS width cssW, honouring DPR. Returns layout info for hit testing. */
  function render(canvas, spec, opts) {
    opts = opts || {};
    var H = heightFor(spec, opts);
    var cssW = opts.cssWidth || canvas.clientWidth || 650;
    var cssH = Math.round(cssW * H / W0);
    var dpr = opts.dpr || (root.devicePixelRatio || 1);
    var bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    var ctx = canvas.getContext('2d');
    var k = bw / W0;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    var L = draw(ctx, spec, opts);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { L: L, k: k, cssScale: cssW / W0, H: H };
  }

  /* Render to a PNG Blob at the given pixel width (default 1950); height follows the spec. */
  function renderToBlob(spec, opts) {
    opts = opts || {};
    var H = heightFor(spec, opts);
    var w = opts.width || W0, h = Math.round(w * H / W0);
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    var k = w / W0;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    draw(ctx, spec, opts);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('toBlob failed')); }, 'image/png');
    });
  }

  /* Nearest marker to CSS-pixel position (cx, cy); radius in CSS px. Uses drawn (possibly pinned) positions.
   * Also returns the other points drawn on top of / next to the nearest one (within about one marker radius)
   * as `stacked` (capped at HIT_LIST_MAX - 1, sorted by time), with `stackedTotal` the uncapped count. */
  var HIT_LIST_MAX = 8;
  function hitTest(info, spec, cx, cy, radius) {
    var s = info.cssScale, L = info.L;
    var lx = cx / s, ly = cy / s;
    var r2 = (radius / s) * (radius / s);
    var best = null, bestD = r2, bx = 0, by = 0;
    for (var si = spec.series.length - 1; si >= 0; si--) {
      var ser = spec.series[si];
      for (var i = 0; i < ser.xs.length; i++) {
        var px = L.sx(ser.xs[i]), py = L.ptY(ser, i);
        var dx = px - lx, dy = py - ly;
        var d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bx = px; by = py; best = { series: ser, i: i, px: px * s, py: py * s, flag: ser.flags ? ser.flags[i] : 0 }; }
      }
    }
    if (!best) return null;
    var near = R_BIG * 1.15, near2 = near * near, stack = [];
    for (var sj = 0; sj < spec.series.length; sj++) {
      var s2 = spec.series[sj];
      for (var j = 0; j < s2.xs.length; j++) {
        if (s2 === best.series && j === best.i) continue;
        var qx = L.sx(s2.xs[j]) - bx, qy = L.ptY(s2, j) - by;
        if (qx * qx + qy * qy <= near2) stack.push({ series: s2, i: j, flag: s2.flags ? s2.flags[j] : 0, t: s2.xs[j] });
      }
    }
    stack.sort(function (a, b) { return a.t - b.t; });
    best.stackedTotal = stack.length;
    best.stacked = stack.slice(0, HIT_LIST_MAX - 1);
    return best;
  }

  CATE.chart = { render: render, renderToBlob: renderToBlob, hitTest: hitTest, heightFor: heightFor, W0: W0, H0: H0 };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ticks.js - tick locators/formatters approximating matplotlib defaults.
 * Attached to globalThis.CATE so the same file runs in the browser and in Node tests.
 *
 * The charts reproduce the matplotlib figures of generate_all_run_charts.py, so axis ticks and labels follow
 * matplotlib's MaxNLocator (numeric) and AutoDateLocator (date) rules rather than a canvas library's.
 * chart.js calls numericTicks / dateTicks when drawing a run chart; model.js and app.js use the date helpers
 * for spec revision labels, the date inputs and file names. Every timestamp in the dashboard is a
 * "naive-as-UTC" epoch ms value: the tester's local wall-clock time stored as if it were UTC, so all
 * formatting here uses the UTC getters and never applies the browser's time zone.
 * This file has no dependencies and is loaded first; its API is the CATE.ticks object at the bottom.
 */
(function (root) {
  'use strict';
  var CATE = root.CATE || (root.CATE = {});
  var DAY = 86400000;

  /* Numeric MaxNLocator-like: steps {1,2,2.5,5,10}, ~nbins intervals, ticks inside [lo, hi].
   * raw step = span / nbins, rounded up to the first of {1, 2, 2.5, 5, 10} x its power of ten that gives at
   * most nbins intervals; ticks are the multiples of that step inside [lo, hi] (tiny epsilons guard float
   * rounding). decimals is the number of decimals needed to print the step (2.5 steps always get one).
   * Returns { ticks, step, decimals }; a degenerate range gives the single tick [lo].
   */
  function numericTicks(lo, hi, nbins) {
    nbins = nbins || 9;
    if (!(hi > lo)) { return { ticks: [lo], step: 1, decimals: 0 }; }
    var raw = (hi - lo) / nbins;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var steps = [1, 2, 2.5, 5, 10];
    var step = 10 * mag;
    for (var k = 0; k < steps.length; k++) {
      var s = steps[k] * mag;
      if ((hi - lo) / s <= nbins) { step = s; break; }
    }
    var first = Math.ceil(lo / step - 1e-9) * step;
    var ticks = [];
    for (var v = first; v <= hi + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
    var decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    if (step / Math.pow(10, Math.floor(Math.log10(step))) === 2.5) decimals = Math.max(decimals, 1);
    return { ticks: ticks, step: step, decimals: decimals };
  }

  /* Fixed-decimal tick label with matplotlib's unicode minus; values within 1e-12 of zero print as 0 (no "-0.00"). */
  function formatNumber(v, decimals) {
    var s = Math.abs(v) < 1e-12 ? (0).toFixed(decimals) : v.toFixed(decimals);
    return s.replace('-', '−');             // matplotlib unicode minus
  }

  /* Date AutoDateLocator-like. All timestamps are naive-as-UTC epoch ms. */
  var FREQ = [
    { name: 'year',  unit: 365.25 * DAY, intervals: [1, 2, 4, 5, 10, 20, 50, 100], max: 11 },
    { name: 'month', unit: 30.4375 * DAY, intervals: [1, 2, 3, 4, 6], max: 12 },
    { name: 'day',   unit: DAY, intervals: [1, 2, 3, 7, 14, 21], max: 11 },
    { name: 'hour',  unit: 3600000, intervals: [1, 2, 3, 4, 6, 12], max: 12 },
    { name: 'minute', unit: 60000, intervals: [1, 5, 10, 15, 30], max: 11 },
    { name: 'second', unit: 1000, intervals: [1, 5, 10, 15, 30], max: 11 }
  ];
  var MINTICKS = 5;

  /* Date ticks for [lo, hi] (epoch ms). Picks the coarsest FREQ unit that yields at least MINTICKS ticks and
   * the smallest interval of that unit with at most `max` ticks, then generates ticks aligned the way
   * matplotlib's rrule does: years / months as multiples of the interval, days restarting at the 1st of each
   * month (1, 1+interval, ...), hours / minutes / seconds as multiples of the interval since the epoch.
   * Returns an array of epoch ms, never empty (falls back to [lo]). */
  function dateTicks(lo, hi) {
    if (!(hi > lo)) return [lo];
    var span = hi - lo;
    var chosen = null, interval = 1;
    for (var f = 0; f < FREQ.length; f++) {
      var num = span / FREQ[f].unit;
      if (num < MINTICKS && f < FREQ.length - 1) continue;
      chosen = FREQ[f];
      interval = chosen.intervals[chosen.intervals.length - 1];
      for (var k = 0; k < chosen.intervals.length; k++) {
        if (num / chosen.intervals[k] <= chosen.max) { interval = chosen.intervals[k]; break; }
      }
      break;
    }
    var ticks = [];
    var d = new Date(lo);
    var y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    var t;
    if (chosen.name === 'year') {
      var y0 = Math.floor(y / interval) * interval;
      for (var yy = y0; ; yy += interval) { t = Date.UTC(yy, 0, 1); if (t > hi) break; if (t >= lo) ticks.push(t); }
    } else if (chosen.name === 'month') {
      var m0 = Math.floor(m / interval) * interval;
      for (var i = 0; ; i++) { t = Date.UTC(y, m0 + i * interval, 1); if (t > hi) break; if (t >= lo) ticks.push(t); }
    } else if (chosen.name === 'day') {
      // matplotlib's rrule DAILY with bymonthday: ticks at days 1, 1+interval, ... within each month
      var start = Date.UTC(y, m, 1);
      for (var mi = 0; ; mi++) {
        var mStart = Date.UTC(y, m + mi, 1);
        if (mStart > hi) break;
        var mEnd = Date.UTC(y, m + mi + 1, 1);
        for (t = mStart; t < mEnd; t += interval * DAY) { if (t > hi) break; if (t >= lo) ticks.push(t); }
      }
      void start; void day;
    } else {
      var unit = chosen.unit * interval;
      var first = Math.ceil(lo / unit) * unit;
      for (t = first; t <= hi; t += unit) ticks.push(t);
    }
    if (ticks.length === 0) ticks.push(lo);
    return ticks;
  }

  /* Two-digit zero padding for date and time parts. */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /* Date label as the Python charts printed it. */
  function formatDate(t) {            // mm/dd/yyyy, UTC getters
    var d = new Date(t);
    return pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate()) + '/' + d.getUTCFullYear();
  }
  /* Tooltip timestamp: mm/dd/yyyy h:mm:ss AM/PM (12-hour clock, UTC getters). */
  function formatDateTime(t) {
    var d = new Date(t);
    var h = d.getUTCHours(), ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12;
    return formatDate(t) + ' ' + h + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + ' ' + ap;
  }
  /* Epoch ms -> 'yyyy-mm-dd', the value format of the date inputs and of the saved settings. */
  function isoDate(t) {               // yyyy-mm-dd for <input type=date>
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  /* Inverse of isoDate; the regex only checks the shape, Date.UTC normalises out-of-range month / day values. */
  function parseIsoDate(s) {          // 'yyyy-mm-dd' -> epoch ms (UTC midnight) or NaN
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }
  /* Today's local calendar date as naive-UTC midnight, comparable with the data timestamps ('today' in DEFAULTS). */
  function todayUtc() {               // local calendar date, as naive-UTC midnight
    var d = new Date();
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }

  CATE.ticks = {
    numericTicks: numericTicks, formatNumber: formatNumber,
    dateTicks: dateTicks, formatDate: formatDate, formatDateTime: formatDateTime,
    isoDate: isoDate, parseIsoDate: parseIsoDate, todayUtc: todayUtc, DAY: DAY
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/*
 * FRF RPM별 응답 계산기 — 순수 계산 모듈 (화면·저장소와 무관)
 * 기획서 4장 「과제 B 계산 흐름」과 원문 참고 1·2 를 그대로 옮겼습니다.
 *   가진 주파수 f = 차수 × RPM / 60 (Hz)                     (가정 — 회전 차수 기준)
 *   차수 성분 = |FRF(f)| × 가진력(차수, RPM)                   (원문 참고 1)
 *   overall = √(Σ 차수 성분²)                                (원문 참고 2, RSS)
 *   가진력 추정 = 계측 응답 ÷ |FRF(f)|                         (기획서 4장, 단일 가진점 가정)
 * 브라우저에서는 window.FRFLogic, Node(테스트)에서는 module.exports 로 씁니다.
 * ES module 이 아닌 이유: index.html 을 파일(file://)로 열면 브라우저가 module 스크립트를 막기 때문입니다.
 */
(function (root) {
  'use strict';

  var FORMATS = {
    mag: { ko: '크기만', cols: 1 },
    magphase: { ko: '크기 + 위상', cols: 2 },
    reim: { ko: '실수 + 허수', cols: 2 }
  };
  var INTERP = {
    linear: '선형 보간',
    nearest: '가장 가까운 점',
    loglog: '로그 보간(주파수·크기 모두 로그)'
  };
  var MAX_RPM_POINTS = 20000;

  // ── 숫자 ──────────────────────────────────────────────────────
  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    var s = String(v).trim().replace(/,/g, '').replace(/\s+/g, '');
    if (s === '') return NaN;
    // 「1.2e-3」「-5」「3.」 형태만 숫자로 봅니다(단위가 붙은 값은 숫자가 아님)
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    return Number(s);
  }
  function round(x, n) {
    if (x == null || !isFinite(x)) return x;
    var p = Math.pow(10, n == null ? 6 : n);
    return Math.round(x * p) / p;
  }

  // ── 열 자동 추정 (사용자가 화면에서 고칠 수 있는 첫 제안일 뿐) ────────
  var RE_FREQ = /(freq|주파수|^hz$|\[hz\]|\(hz\))/i;
  var RE_MAG = /(mag|amp|크기|진폭|abs)/i;
  var RE_PHASE = /(phase|위상|deg|ang)/i;
  var RE_RE = /(real|실수|(^|[^a-z])re([^a-z]|$))/i;
  var RE_IM = /(imag|허수|(^|[^a-z])im([^a-z]|$))/i;

  function baseName(h) {
    return String(h).replace(RE_MAG, '').replace(RE_PHASE, '').replace(/real|imag|실수|허수/ig, '')
      .replace(/[\s_\-\[\]\(\)\/:]+$/g, '').replace(/^[\s_\-\[\]\(\)\/:]+/g, '').trim() || String(h);
  }

  function guessMapping(headers) {
    var hs = headers.map(function (h) { return String(h == null ? '' : h).trim(); });
    var freqCol = -1;
    for (var i = 0; i < hs.length; i++) if (RE_FREQ.test(hs[i])) { freqCol = i; break; }
    if (freqCol < 0) freqCol = 0;
    var rest = [];
    for (var j = 0; j < hs.length; j++) if (j !== freqCol && hs[j] !== '') rest.push(j);
    var nPhase = rest.filter(function (c) { return RE_PHASE.test(hs[c]); }).length;
    var nIm = rest.filter(function (c) { return RE_IM.test(hs[c]); }).length;
    var format = 'mag';
    if (nPhase > 0 && nPhase * 2 === rest.length) format = 'magphase';
    else if (nIm > 0 && nIm * 2 === rest.length) format = 'reim';
    var points = [];
    if (format === 'mag') {
      rest.forEach(function (c) { points.push({ name: hs[c], a: c, b: -1, unit: '' }); });
    } else {
      var second = format === 'magphase' ? RE_PHASE : RE_IM;
      var firsts = rest.filter(function (c) { return !second.test(hs[c]); });
      var seconds = rest.filter(function (c) { return second.test(hs[c]); });
      firsts.forEach(function (c, k) { points.push({ name: baseName(hs[c]), a: c, b: seconds[k] == null ? -1 : seconds[k], unit: '' }); });
    }
    return { freqCol: freqCol, format: format, points: points };
  }

  // 표 머리행 찾기: 숫자가 아닌 칸이 가장 많은 첫 행(위 5행 안) — 제목 줄이 있어도 넘어가도록
  function guessHeaderRow(rows) {
    var best = 0, bestScore = -1;
    for (var r = 0; r < Math.min(rows.length, 5); r++) {
      var row = rows[r] || [];
      var text = 0, filled = 0;
      row.forEach(function (v) { if (v !== '' && v != null) { filled++; if (isNaN(toNumber(v))) text++; } });
      var next = rows[r + 1] || [];
      var nextNum = next.filter(function (v) { return !isNaN(toNumber(v)); }).length;
      var score = filled >= 2 && nextNum >= 2 ? text * 10 + filled : -1;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  }

  // ── FRF 표 만들기 ───────────────────────────────────────────────
  function magnitudeOf(format, a, b) {
    if (format === 'reim') return Math.sqrt(a * a + b * b);
    return Math.abs(a); // mag, magphase — 크기는 위상과 무관
  }

  /**
   * rows: 머리행 아래 데이터 행(배열의 배열), mapping: {freqCol, format, points:[{name,a,b,unit}]}
   * 반환: {freq:[], points:[{name,unit,mag:[]}], warnings:[], skipped}
   */
  function buildFrf(rows, mapping) {
    var errors = [];
    if (!mapping || mapping.freqCol == null || mapping.freqCol < 0) errors.push('주파수 열을 지정해 주십시오.');
    if (!FORMATS[mapping && mapping.format]) errors.push('FRF 값 형식을 지정해 주십시오.');
    var pts = (mapping && mapping.points || []).filter(function (p) { return p && p.a != null && p.a >= 0; });
    if (!pts.length) errors.push('응답점 열을 하나 이상 지정해 주십시오.');
    if (mapping && FORMATS[mapping.format] && FORMATS[mapping.format].cols === 2) {
      pts.forEach(function (p) { if (p.b == null || p.b < 0) errors.push('「' + p.name + '」의 두 번째 열(' + (mapping.format === 'reim' ? '허수' : '위상') + ')을 지정해 주십시오.'); });
    }
    var names = {};
    pts.forEach(function (p) {
      var n = String(p.name || '').trim();
      if (!n) errors.push('응답점 이름이 비어 있습니다.');
      else if (names[n]) errors.push('응답점 이름 「' + n + '」이 겹칩니다.');
      names[n] = true;
    });
    if (errors.length) return { ok: false, errors: errors };

    var two = FORMATS[mapping.format].cols === 2;
    var recs = [], skipped = 0;
    rows.forEach(function (row) {
      var f = toNumber(row[mapping.freqCol]);
      if (isNaN(f)) { skipped++; return; }
      var vals = pts.map(function (p) {
        var a = toNumber(row[p.a]);
        var b = two ? toNumber(row[p.b]) : 0;
        return isNaN(a) || isNaN(b) ? NaN : magnitudeOf(mapping.format, a, b);
      });
      recs.push({ f: f, v: vals });
    });
    var warnings = [];
    if (skipped) warnings.push('주파수가 숫자가 아닌 행 ' + skipped + '개를 건너뛰었습니다.');
    var sorted = recs.every(function (r, i) { return i === 0 || recs[i - 1].f <= r.f; });
    if (!sorted) {
      recs.sort(function (x, y) { return x.f - y.f; });
      warnings.push('주파수가 오름차순이 아니어서 정렬했습니다.');
    }
    var uniq = [], dup = 0;
    recs.forEach(function (r) {
      if (uniq.length && uniq[uniq.length - 1].f === r.f) { dup++; return; }
      uniq.push(r);
    });
    if (dup) warnings.push('같은 주파수가 두 번 이상 나온 행 ' + dup + '개는 처음 값만 썼습니다.');
    if (uniq.length < 2) return { ok: false, errors: ['주파수 행이 2개 이상 있어야 보간할 수 있습니다.'] };
    var neg = uniq.filter(function (r) { return r.f < 0; }).length;
    if (neg) warnings.push('음수 주파수 행이 ' + neg + '개 있습니다. 열 지정을 확인해 주십시오.');
    var frf = {
      freq: uniq.map(function (r) { return r.f; }),
      points: pts.map(function (p, k) {
        var mag = uniq.map(function (r) { return r.v[k]; });
        var blank = mag.filter(function (x) { return isNaN(x); }).length;
        if (blank) warnings.push('「' + String(p.name).trim() + '」에 숫자가 아닌 값이 ' + blank + '개 있습니다(그 주파수 근처는 계산하지 않습니다).');
        return { name: String(p.name).trim(), unit: String(p.unit || '').trim(), mag: mag };
      })
    };
    return { ok: true, frf: frf, warnings: warnings, skipped: skipped };
  }

  function frfSummary(frf) {
    var f = frf.freq, diffs = [];
    for (var i = 1; i < f.length; i++) diffs.push(f[i] - f[i - 1]);
    diffs.sort(function (a, b) { return a - b; });
    var med = diffs[Math.floor(diffs.length / 2)];
    return {
      rows: f.length, fmin: f[0], fmax: f[f.length - 1], step: med,
      uneven: diffs.length ? round(diffs[diffs.length - 1] - diffs[0], 9) > Math.abs(med) * 1e-6 : false,
      points: frf.points.length
    };
  }

  function maxMag(mag) {
    var m = 0;
    mag.forEach(function (x) { if (isFinite(x) && x > m) m = x; });
    return m;
  }

  // ── 보간 ──────────────────────────────────────────────────────
  /**
   * freq(오름차순)·vals 에서 f 의 값을 구합니다.
   * status: ok | out_of_range(해석 주파수 범위 밖) | no_data(이웃 값이 숫자가 아님)
   * 로그 보간은 f·값 중 0 이하가 끼면 로그를 쓸 수 없어 그 구간만 선형으로 대신하고 note 를 남깁니다.
   */
  function interpolate(freq, vals, f, method) {
    var n = freq.length;
    if (!(f >= freq[0] && f <= freq[n - 1])) return { value: null, status: 'out_of_range' };
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (freq[mid] <= f) lo = mid; else hi = mid;
    }
    if (freq[lo] === f) return pick(vals[lo]);
    if (freq[hi] === f) return pick(vals[hi]);
    var f0 = freq[lo], f1 = freq[hi], v0 = vals[lo], v1 = vals[hi];
    if (method === 'nearest') {
      // 한가운데면 낮은 주파수 쪽을 씁니다
      return pick(f - f0 <= f1 - f ? v0 : v1);
    }
    if (!isFinite(v0) || !isFinite(v1)) return { value: null, status: 'no_data' };
    var t = (f - f0) / (f1 - f0);
    if (method === 'loglog') {
      if (f0 > 0 && v0 > 0 && v1 > 0) {
        var tl = Math.log(f / f0) / Math.log(f1 / f0);
        return { value: Math.exp(Math.log(v0) + tl * (Math.log(v1) - Math.log(v0))), status: 'ok' };
      }
      return { value: v0 + t * (v1 - v0), status: 'ok', note: 'loglog_fallback_linear' };
    }
    return { value: v0 + t * (v1 - v0), status: 'ok' };
  }
  function pick(v) { return isFinite(v) ? { value: v, status: 'ok' } : { value: null, status: 'no_data' }; }

  // ── RPM·차수 ──────────────────────────────────────────────────
  function excitationFreq(order, rpm) { return order * rpm / 60; }

  function rpmList(start, end, step) {
    var s = toNumber(start), e = toNumber(end), d = toNumber(step);
    var errs = [];
    if (isNaN(s) || isNaN(e) || isNaN(d)) errs.push('RPM 시작·끝·간격을 숫자로 입력해 주십시오.');
    else {
      if (s < 0) errs.push('RPM 시작값은 0 이상이어야 합니다.');
      if (e < s) errs.push('RPM 끝값이 시작값보다 작습니다.');
      if (d <= 0) errs.push('RPM 간격은 0보다 커야 합니다.');
    }
    if (errs.length) return { ok: false, errors: errs };
    var count = Math.floor((e - s) / d + 1e-9) + 1;
    if (count > MAX_RPM_POINTS) return { ok: false, errors: ['RPM 점이 ' + count + '개로 너무 많습니다(최대 ' + MAX_RPM_POINTS + '개). 간격을 늘려 주십시오.'] };
    var list = [];
    for (var i = 0; i < count; i++) list.push(round(s + i * d, 9));
    if (round(list[list.length - 1], 6) < round(e, 6)) list.push(e); // 끝값이 간격에 딱 맞지 않아도 끝값까지 계산
    return { ok: true, list: list };
  }

  /** orders: [{order, force}] (force 는 차수별 상수 모드에서만 필요) */
  function validateOrders(orders, needForce) {
    var errs = [], seen = {}, out = [];
    (orders || []).forEach(function (o, i) {
      if ((o.order === '' || o.order == null) && (o.force === '' || o.force == null)) return; // 빈 줄
      var k = toNumber(o.order), F = toNumber(o.force);
      if (isNaN(k) || k <= 0) { errs.push((i + 1) + '번째 줄: 차수는 0보다 큰 숫자여야 합니다.'); return; }
      if (seen[k]) { errs.push('차수 ' + k + '가 두 번 들어 있습니다.'); return; }
      seen[k] = true;
      if (needForce && (isNaN(F) || F < 0)) { errs.push('차수 ' + k + '의 가진력을 0 이상의 숫자로 입력해 주십시오.'); return; }
      out.push({ order: k, force: needForce ? F : null });
    });
    if (!out.length && !errs.length) errs.push('차수를 하나 이상 입력해 주십시오.');
    out.sort(function (a, b) { return a.order - b.order; });
    return errs.length ? { ok: false, errors: errs } : { ok: true, orders: out };
  }

  /**
   * RPM별 가진력 표 읽기. mapping: {rpmCol, orderCols:[{order, col}]}
   * 반환 table: {rpm:[오름차순], byOrder:{차수: [값…]}}
   */
  function parseForceTable(rows, mapping) {
    var errs = [];
    if (mapping.rpmCol == null || mapping.rpmCol < 0) errs.push('가진력 표의 RPM 열을 지정해 주십시오.');
    var cols = (mapping.orderCols || []).filter(function (c) { return c.col >= 0 && !isNaN(toNumber(c.order)); });
    if (!cols.length) errs.push('가진력 표에서 차수별 열을 하나 이상 지정해 주십시오.');
    if (errs.length) return { ok: false, errors: errs };
    var recs = [];
    rows.forEach(function (r) {
      var rpm = toNumber(r[mapping.rpmCol]);
      if (isNaN(rpm)) return;
      recs.push({ rpm: rpm, v: cols.map(function (c) { return toNumber(r[c.col]); }) });
    });
    recs.sort(function (a, b) { return a.rpm - b.rpm; });
    if (!recs.length) return { ok: false, errors: ['가진력 표에 RPM 이 숫자인 행이 없습니다.'] };
    var table = { rpm: recs.map(function (r) { return r.rpm; }), byOrder: {} };
    cols.forEach(function (c, k) { table.byOrder[toNumber(c.order)] = recs.map(function (r) { return isNaN(r.v[k]) ? null : r.v[k]; }); });
    return { ok: true, table: table };
  }

  /** forceSpec: {mode:'const', orders:[{order,force}]} | {mode:'table', table} */
  function forceAt(spec, order, rpm) {
    if (spec.mode === 'table') {
      var col = spec.table && spec.table.byOrder[order];
      if (!col) return { value: null, status: 'no_force' };
      var r = interpolate(spec.table.rpm, col.map(function (x) { return x == null ? NaN : x; }), rpm, 'linear');
      if (r.status === 'out_of_range') return { value: null, status: 'force_out_of_range' };
      if (r.status !== 'ok') return { value: null, status: 'no_force' };
      return { value: r.value, status: 'ok' };
    }
    for (var i = 0; i < spec.orders.length; i++) if (spec.orders[i].order === order) return { value: spec.orders[i].force, status: 'ok' };
    return { value: null, status: 'no_force' };
  }

  function rss(values) {
    var s = 0, n = 0;
    values.forEach(function (v) { if (v != null && isFinite(v)) { s += v * v; n++; } });
    return { value: n ? Math.sqrt(s) : null, count: n };
  }

  var STATUS_TEXT = {
    ok: '',
    out_of_range: '가진 주파수가 FRF 해석 범위 밖',
    no_data: 'FRF 값 없음(숫자가 아닌 칸)',
    no_force: '가진력 없음',
    force_out_of_range: 'RPM 이 가진력 표 범위 밖'
  };

  /**
   * frf: buildFrf 결과, cfg: {rpms:[..], orders:[{order,force}], force: forceSpec, interp}
   * 반환: {points:[{name, unit, rows:[{rpm, comps:[{order,f,frf,force,resp,status}], overall, used, partial}]}], warnings}
   */
  function computeResponse(frf, cfg) {
    var warnings = [], outCount = 0, fbCount = 0;
    var points = frf.points.map(function (p) {
      var rows = cfg.rpms.map(function (rpm) {
        var comps = cfg.orders.map(function (o) {
          var f = excitationFreq(o.order, rpm);
          var h = interpolate(frf.freq, p.mag, f, cfg.interp);
          if (h.note) fbCount++;
          var F = forceAt(cfg.force, o.order, rpm);
          var status = h.status !== 'ok' ? h.status : F.status;
          if (h.status === 'out_of_range') outCount++;
          var resp = status === 'ok' ? h.value * F.value : null;
          return { order: o.order, f: f, frf: h.value, force: F.value, resp: resp, status: status };
        });
        var o = rss(comps.map(function (c) { return c.resp; }));
        return { rpm: rpm, comps: comps, overall: o.value, used: o.count, partial: o.count < comps.length };
      });
      return { name: p.name, unit: p.unit, rows: rows };
    });
    if (outCount) warnings.push('가진 주파수가 FRF 해석 범위(' + frf.freq[0] + '~' + frf.freq[frf.freq.length - 1] + ' Hz)를 벗어난 칸이 ' + outCount + '개 있습니다. 그 차수는 overall 에서 빠지고 「일부 차수 제외」로 표시됩니다.');
    if (fbCount) warnings.push('로그 보간에서 0 이하 값이 끼어 선형 보간으로 대신한 칸이 ' + fbCount + '개 있습니다.');
    return { points: points, warnings: warnings };
  }

  // ── 가진력 추정 (계측 응답 ÷ |FRF|) ─────────────────────────────
  /**
   * 계측 표 읽기(가정 형식: 한 행 = RPM·차수 하나, 응답점마다 열 하나).
   * mapping: {rpmCol, orderCol, pointCols:{응답점이름: 열번호}}
   */
  function parseMeasured(rows, mapping) {
    var errs = [];
    if (mapping.rpmCol == null || mapping.rpmCol < 0) errs.push('계측 표의 RPM 열을 지정해 주십시오.');
    if (mapping.orderCol == null || mapping.orderCol < 0) errs.push('계측 표의 차수 열을 지정해 주십시오.');
    var names = Object.keys(mapping.pointCols || {}).filter(function (k) { return mapping.pointCols[k] >= 0; });
    if (!names.length) errs.push('FRF 응답점과 짝지을 계측 열을 하나 이상 지정해 주십시오.');
    if (errs.length) return { ok: false, errors: errs };
    var out = [], skipped = 0;
    rows.forEach(function (r) {
      var rpm = toNumber(r[mapping.rpmCol]), k = toNumber(r[mapping.orderCol]);
      if (isNaN(rpm) || isNaN(k)) { skipped++; return; }
      var values = {};
      names.forEach(function (n) { var v = toNumber(r[mapping.pointCols[n]]); values[n] = isNaN(v) ? null : v; });
      out.push({ rpm: rpm, order: k, values: values });
    });
    if (!out.length) return { ok: false, errors: ['RPM·차수가 숫자인 계측 행이 없습니다.'] };
    return { ok: true, rows: out, points: names, skipped: skipped };
  }

  /**
   * opts: {interp, antiRatio} — antiRatio: 그 응답점 최대 |FRF| 대비 이 비율보다 작으면 반공진 부근 경고
   * 종합값: 경고 없는 응답점들로 최소제곱 F = Σ|H|·m / Σ|H|² (가정 — 단일 가진점, 응답점마다 같은 가중)
   */
  function estimateForce(frf, measured, opts) {
    var byName = {};
    frf.points.forEach(function (p) { byName[p.name] = { p: p, max: maxMag(p.mag) }; });
    var ratio = toNumber(opts.antiRatio);
    if (isNaN(ratio) || ratio < 0) ratio = 0;
    var rows = measured.rows.map(function (m) {
      var f = excitationFreq(m.order, m.rpm);
      var pts = measured.points.map(function (name) {
        var ent = byName[name], meas = m.values[name];
        if (!ent) return { name: name, meas: meas, frf: null, force: null, anti: false, status: 'no_point' };
        if (meas == null) return { name: name, meas: null, frf: null, force: null, anti: false, status: 'no_meas' };
        var h = interpolate(frf.freq, ent.p.mag, f, opts.interp);
        if (h.status !== 'ok') return { name: name, meas: meas, frf: null, force: null, anti: false, status: h.status };
        if (!(h.value > 0)) return { name: name, meas: meas, frf: h.value, force: null, anti: true, status: 'zero_frf' };
        var anti = h.value < ratio * ent.max;
        return { name: name, meas: meas, frf: h.value, force: Math.abs(meas) / h.value, anti: anti, status: 'ok' };
      });
      var num = 0, den = 0, used = 0;
      pts.forEach(function (q) { if (q.status === 'ok' && !q.anti) { num += q.frf * Math.abs(q.meas); den += q.frf * q.frf; used++; } });
      return { rpm: m.rpm, order: m.order, f: f, points: pts, ls: used ? num / den : null, used: used };
    });
    return { rows: rows };
  }

  // 추정 결과를 「RPM별 가진력 표」로 바꿔 계산에 다시 쓸 수 있게 합니다
  function estimateToForceTable(est) {
    var rpms = [], orders = [], map = {};
    est.rows.forEach(function (r) {
      if (rpms.indexOf(r.rpm) < 0) rpms.push(r.rpm);
      if (orders.indexOf(r.order) < 0) orders.push(r.order);
      map[r.rpm + '|' + r.order] = r.ls;
    });
    rpms.sort(function (a, b) { return a - b; });
    orders.sort(function (a, b) { return a - b; });
    var table = { rpm: rpms, byOrder: {} };
    orders.forEach(function (k) { table.byOrder[k] = rpms.map(function (r) { var v = map[r + '|' + k]; return v == null ? null : v; }); });
    return { table: table, orders: orders };
  }

  // ── 엑셀 시트 ─────────────────────────────────────────────────
  function sheetName(s, used) {
    var base = String(s).replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 31) || 'Sheet';
    var name = base, i = 2;
    while (used[name]) { var suf = '_' + i++; name = base.slice(0, 31 - suf.length) + suf; }
    used[name] = true;
    return name;
  }
  function orderLabel(k) { return k + '차'; }

  /** meta: {fileName, interp, forceMode, forceUnit, sample, created} */
  function resultToSheets(result, orders, meta) {
    var used = {}, sheets = [];
    var cond = [
      ['항목', '값'],
      ['자료', meta.sample ? '예시 데이터(가상) — 실제 해석 결과가 아닙니다' : '사용자 파일'],
      ['FRF 파일', meta.fileName || ''],
      ['계산 일시', meta.created || ''],
      ['가진 주파수', '차수 × RPM / 60 (Hz)'],
      ['FRF 보간', INTERP[meta.interp] || meta.interp],
      ['차수 성분', '|FRF(가진 주파수)| × 가진력'],
      ['overall', 'RSS = √(Σ 차수 성분²)'],
      ['가진력 입력', meta.forceMode === 'table' ? 'RPM별 가진력 표(RPM 사이 선형 보간)' : '차수별 상수'],
      ['가진력 단위', meta.forceUnit || ''],
      ['차수', orders.map(function (o) { return orderLabel(o.order) + (meta.forceMode === 'table' ? '' : '=' + o.force); }).join(', ')]
    ];
    sheets.push({ name: sheetName('계산조건', used), rows: cond });
    result.points.forEach(function (p) {
      var head = ['RPM'];
      orders.forEach(function (o) {
        var k = orderLabel(o.order);
        head.push(k + ' 가진주파수(Hz)', k + ' |FRF|', k + ' 가진력', k + ' 응답');
      });
      head.push('overall(RSS)', '비고');
      var rows = [head];
      p.rows.forEach(function (r) {
        var line = [r.rpm];
        var notes = [];
        r.comps.forEach(function (c) {
          line.push(round(c.f, 6), c.frf == null ? '' : c.frf, c.force == null ? '' : c.force, c.resp == null ? '' : c.resp);
          if (c.status !== 'ok') notes.push(orderLabel(c.order) + ': ' + STATUS_TEXT[c.status]);
        });
        line.push(r.overall == null ? '' : r.overall, (r.partial ? '일부 차수 제외 — ' : '') + notes.join('; '));
        rows.push(line);
      });
      sheets.push({ name: sheetName('응답_' + p.name, used), rows: rows });
    });
    return sheets;
  }

  function estimateToSheets(est, meta) {
    var used = {};
    var detail = [['RPM', '차수', '가진주파수(Hz)', '응답점', '계측값', '|FRF|', '추정 가진력', '반공진 부근 경고', '비고']];
    var sum = [['RPM', '차수', '가진주파수(Hz)', '종합 추정 가진력(최소제곱)', '쓴 응답점 수']];
    est.rows.forEach(function (r) {
      r.points.forEach(function (q) {
        var note = q.status === 'ok' ? '' : ({ no_point: 'FRF 에 없는 응답점', no_meas: '계측값 없음', zero_frf: '|FRF| 가 0', out_of_range: STATUS_TEXT.out_of_range, no_data: STATUS_TEXT.no_data })[q.status] || q.status;
        detail.push([r.rpm, r.order, round(r.f, 6), q.name, q.meas == null ? '' : q.meas, q.frf == null ? '' : q.frf, q.force == null ? '' : q.force, q.anti ? '예' : '', note]);
      });
      sum.push([r.rpm, r.order, round(r.f, 6), r.ls == null ? '' : r.ls, r.used]);
    });
    var cond = [
      ['항목', '값'],
      ['자료', meta.sample ? '예시 데이터(가상) — 실제 계측·해석 결과가 아닙니다' : '사용자 파일'],
      ['FRF 파일', meta.fileName || ''],
      ['계측 파일', meta.measFile || ''],
      ['계산 일시', meta.created || ''],
      ['추정식', '가진력 = |계측 응답| ÷ |FRF(차수 × RPM / 60)| (단일 가진점 가정)'],
      ['종합값', '반공진 경고가 없는 응답점으로 최소제곱: Σ|FRF|·|계측| ÷ Σ|FRF|²'],
      ['반공진 경고 기준', '그 응답점 최대 |FRF| × ' + meta.antiRatio + ' 보다 작을 때'],
      ['FRF 보간', INTERP[meta.interp] || meta.interp]
    ];
    return [
      { name: sheetName('추정조건', used), rows: cond },
      { name: sheetName('가진력추정_응답점별', used), rows: detail },
      { name: sheetName('가진력추정_종합', used), rows: sum }
    ];
  }

  function toCsv(rows) {
    return '﻿' + rows.map(function (r) {
      return r.map(function (v) {
        var s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n') + '\r\n';
  }

  // ── 그래프 눈금 ────────────────────────────────────────────────
  function niceTicks(min, max, count) {
    if (!(max > min)) { max = min + 1; }
    var span = max - min, raw = span / (count || 5);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks = [];
    for (var v = lo; v <= hi + step * 1e-9; v += step) ticks.push(round(v, 10));
    return ticks;
  }

  function fmt(x, digits) {
    if (x == null || !isFinite(x)) return '';
    if (x === 0) return '0';
    var a = Math.abs(x);
    if (a >= 1e5 || a < 1e-3) return x.toExponential((digits || 4) - 1);
    return String(Number(x.toPrecision(digits || 4)));
  }

  var api = {
    FORMATS: FORMATS, INTERP: INTERP, STATUS_TEXT: STATUS_TEXT, MAX_RPM_POINTS: MAX_RPM_POINTS,
    toNumber: toNumber, round: round, guessMapping: guessMapping, guessHeaderRow: guessHeaderRow,
    magnitudeOf: magnitudeOf, buildFrf: buildFrf, frfSummary: frfSummary, maxMag: maxMag,
    interpolate: interpolate, excitationFreq: excitationFreq, rpmList: rpmList, validateOrders: validateOrders,
    parseForceTable: parseForceTable, forceAt: forceAt, rss: rss, computeResponse: computeResponse,
    parseMeasured: parseMeasured, estimateForce: estimateForce, estimateToForceTable: estimateToForceTable,
    resultToSheets: resultToSheets, estimateToSheets: estimateToSheets, sheetName: sheetName, toCsv: toCsv,
    niceTicks: niceTicks, fmt: fmt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FRFLogic = api;
})(typeof window !== 'undefined' ? window : this);

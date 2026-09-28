/* FRF RPM별 응답 계산기 — 화면 (계산은 js/logic.js) */
(function () {
  'use strict';
  var L = window.FRFLogic, S = window.FRFSample, Store = window.FRFStore;
  var main = document.getElementById('main');

  // ── 상태 ─────────────────────────────────────────────────────
  function defaultSettings() {
    return { rpmStart: '', rpmEnd: '', rpmStep: '', orders: [{ order: '', force: '' }], forceMode: 'const', forceUnit: 'N', interp: 'linear', antiRatio: 0.05 };
  }
  function emptyState() {
    return { sample: false, frfFile: null, frfMap: null, frf: null, frfWarnings: [], settings: defaultSettings(), forceFile: null, forceTable: null, measFile: null, measMap: null };
  }
  var state = Store.load() || emptyState();
  if (!state.settings) state.settings = defaultSettings();
  var result = null, estimate = null;   // 계산 결과는 저장하지 않고 필요할 때 다시 계산
  var ui = { point: 0, logY: false, detail: false };

  function save() {
    var ok = Store.save(state);
    var b = document.getElementById('storeBanner');
    if (!ok) { b.textContent = '파일이 커서 브라우저 저장소에 담지 못했습니다. 이 창을 닫으면 불러온 파일이 사라지니, 결과는 엑셀로 내려받아 두십시오.'; b.hidden = false; }
    else b.hidden = true;
  }

  // ── DOM 도우미 ────────────────────────────────────────────────
  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') n[k] = !!v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
    return n;
  }
  function add(n, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(n, x); }); return; }
    n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  var toastTimer;
  function toast(msg, isErr) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (isErr ? ' error' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function alertBox(kind, title, items) {
    if (!items || !items.length) return null;
    return el('div', { class: 'alert ' + kind, role: kind === 'error' ? 'alert' : null }, title ? el('strong', null, title) : null, el('ul', null, items.map(function (x) { return el('li', null, x); })));
  }
  function field(label, input, help) { return el('label', { class: 'field' }, el('span', null, label), input, help ? el('small', null, help) : null); }
  function colLetter(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function colSelect(name, headers, value, allowNone) {
    var s = el('select', { name: name });
    if (allowNone) s.appendChild(el('option', { value: '-1' }, '(쓰지 않음)'));
    headers.forEach(function (h, i) { s.appendChild(el('option', { value: String(i), selected: i === value }, colLetter(i) + ' · ' + (String(h).trim() || '(빈 머리)'))); });
    if (value == null || value < 0) s.value = allowNone ? '-1' : '0';
    return s;
  }
  function today() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); }
  function nowText() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function baseOf(name) { return String(name || '').replace(/\.[^.]+$/, '').replace(/[\\\/:*?"<>|\s]+/g, '_'); }
  function outName(kind, ext) { return (state.sample ? '예시데이터_' : '') + kind + (state.frfFile && !state.sample ? '_' + baseOf(state.frfFile.name) : '') + '_' + today() + '.' + ext; }

  function download(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function downloadSheets(name, sheets) {
    var wb = XLSX.utils.book_new();
    sheets.forEach(function (s) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name); });
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(name, new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }

  // ── 파일 읽기 (xlsx·xls·csv) — 브라우저 안에서만 ────────────────────
  function readFile(file, cb) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var buf = new Uint8Array(reader.result), wb;
        if (/\.(csv|txt)$/i.test(file.name)) {
          var text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
          catch (e) { text = new TextDecoder('euc-kr').decode(buf); } // 한글 엑셀이 저장한 CSV(CP949)
          wb = XLSX.read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
        } else wb = XLSX.read(buf, { type: 'array' });
        var sheets = {};
        wb.SheetNames.forEach(function (n) { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }); });
        cb(null, { name: file.name, sheetNames: wb.SheetNames, sheets: sheets });
      } catch (e) { cb(e); }
    };
    reader.onerror = function () { cb(reader.error); };
    reader.readAsArrayBuffer(file);
  }
  function fileRowsInfo(f) {
    var rows = f.sheets[f.sheet] || [];
    var hr = Math.max(0, Math.min(f.headerRow || 0, rows.length - 1));
    return { headers: (rows[hr] || []).map(function (h) { return h == null ? '' : h; }), data: rows.slice(hr + 1), rows: rows, hr: hr };
  }
  function prepareFile(raw) {
    var sheet = raw.sheetNames.filter(function (n) { return (raw.sheets[n] || []).length > 1; })[0] || raw.sheetNames[0];
    return { name: raw.name, sheetNames: raw.sheetNames, sheets: raw.sheets, sheet: sheet, headerRow: L.guessHeaderRow(raw.sheets[sheet] || []) };
  }
  function fileControls(f, onChange) {
    if (!f) return null;
    var info = fileRowsInfo(f);
    var sheetSel = el('select', { name: 'sheet', onchange: function () { f.sheet = this.value; f.headerRow = L.guessHeaderRow(f.sheets[f.sheet] || []); onChange(true); } },
      f.sheetNames.map(function (n) { return el('option', { value: n, selected: n === f.sheet }, n); }));
    var hrIn = el('input', { type: 'number', name: 'headerRow', min: 1, value: String(info.hr + 1), onchange: function () { f.headerRow = Math.max(0, (parseInt(this.value, 10) || 1) - 1); onChange(true); } });
    var prev = info.rows.slice(info.hr, info.hr + 6);
    var width = Math.min(Math.max.apply(null, prev.map(function (r) { return r.length; }).concat([1])), 30);
    return el('div', null,
      el('div', { class: 'form-grid' },
        field('시트', sheetSel, f.sheetNames.length + '개 시트'),
        field('머리행 번호', hrIn, '열 이름이 있는 행(자동으로 찾은 값, 고칠 수 있음)'),
        el('div', { class: 'field' }, el('span', null, '데이터'), el('div', null, info.data.length + '행 × ' + info.headers.length + '열'))),
      el('h3', { style: 'margin-top:14px' }, '미리 보기 (머리행 + 5행)'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'grid' },
        el('thead', null, el('tr', null, Array.apply(null, Array(width)).map(function (_, i) { return el('th', null, colLetter(i)); }))),
        el('tbody', null, prev.map(function (r) { return el('tr', null, Array.apply(null, Array(width)).map(function (_, i) { var v = r[i]; return el('td', null, v == null ? '' : String(v)); })); })))));
  }
  function fileInput(label, onFile) {
    return el('label', { class: 'field' }, el('span', null, label),
      el('input', { type: 'file', accept: '.xlsx,.xls,.xlsm,.csv', onchange: function () {
        var file = this.files && this.files[0];
        if (!file) return;
        readFile(file, function (err, raw) {
          if (err) { toast('파일을 읽지 못했습니다: ' + (err.message || err), true); return; }
          onFile(prepareFile(raw));
        });
      } }),
      el('small', null, '엑셀(xlsx·xls) 또는 CSV. 파일은 이 브라우저 안에서만 읽고 외부로 보내지 않습니다.'));
  }

  // ── 1. FRF 불러오기 ───────────────────────────────────────────
  function viewFrf() {
    var f = state.frfFile;
    var wrap = el('div');
    wrap.appendChild(el('div', { class: 'page-head' }, el('h1', null, '1. FRF 해석 결과 불러오기')));
    wrap.appendChild(steps());
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, 'FRF 엑셀 선택'),
      el('p', { class: 'note' }, '단위 가진 FRF 결과 파일을 고르고, 아래에서 주파수 열과 응답점 열을 지정합니다. 실제 파일의 열 배치를 아직 모르기 때문에 열은 화면에서 직접 짝지어 주는 방식입니다.'),
      fileInput('FRF 파일', function (nf) {
        state.frfFile = nf; state.sample = false; state.frf = null; result = null; estimate = null;
        var info = fileRowsInfo(nf);
        state.frfMap = L.guessMapping(info.headers);
        save(); render();
      }),
      f ? el('p', { style: 'margin-top:10px' }, '불러온 파일: ', el('strong', null, f.name)) : el('p', { class: 'note', style: 'margin-top:10px' }, '파일이 없으면 위쪽의 「예시 데이터 불러오기」로 가상 FRF 를 넣어 흐름을 먼저 볼 수 있습니다.')));
    if (!f) return wrap;

    wrap.appendChild(el('section', { class: 'card' }, el('h2', null, '시트·머리행'), fileControls(f, function (reguess) {
      if (reguess) { state.frfMap = L.guessMapping(fileRowsInfo(f).headers); state.frf = null; }
      save(); render();
    })));

    var info = fileRowsInfo(f), m = state.frfMap || L.guessMapping(info.headers);
    state.frfMap = m;
    var two = L.FORMATS[m.format].cols === 2;
    var fmtSel = el('select', { name: 'format', onchange: function () { m.format = this.value; state.frf = null; save(); render(); } },
      Object.keys(L.FORMATS).map(function (k) { return el('option', { value: k, selected: k === m.format }, L.FORMATS[k].ko); }));
    var freqSel = colSelect('freqCol', info.headers, m.freqCol);
    freqSel.addEventListener('change', function () { m.freqCol = +this.value; state.frf = null; save(); });
    var rows = m.points.map(function (p, i) {
      var nameIn = el('input', { class: 'cell-input', name: 'pname', value: p.name, 'aria-label': '응답점 이름', oninput: function () { p.name = this.value; state.frf = null; save(); } });
      var aSel = colSelect('pa', info.headers, p.a); aSel.className = 'cell-input'; aSel.setAttribute('aria-label', '크기 열');
      aSel.addEventListener('change', function () { p.a = +this.value; state.frf = null; save(); });
      var bSel = colSelect('pb', info.headers, p.b, true); bSel.className = 'cell-input'; bSel.setAttribute('aria-label', '두 번째 열');
      bSel.addEventListener('change', function () { p.b = +this.value; state.frf = null; save(); });
      var unitIn = el('input', { class: 'cell-input', name: 'punit', value: p.unit || '', placeholder: '예: Pa/N', 'aria-label': '단위', oninput: function () { p.unit = this.value; state.frf = null; save(); } });
      return el('tr', null, el('td', null, nameIn), el('td', null, aSel), two ? el('td', null, bSel) : null, el('td', null, unitIn),
        el('td', null, el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: function () { m.points.splice(i, 1); state.frf = null; save(); render(); } }, '빼기')));
    });
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, '열 짝짓기'),
      el('div', { class: 'form-grid cols-2' },
        field('주파수 열 (Hz)', freqSel, '주파수 단위는 Hz 로 봅니다(가정).'),
        field('FRF 값 형식', fmtSel, '크기+위상·실수+허수여도 응답 계산에는 크기 |FRF| 만 씁니다(가정).')),
      el('h3', { style: 'margin-top:16px' }, '응답점 (' + m.points.length + '개)'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'grid map' },
        el('thead', null, el('tr', null, el('th', null, '응답점 이름'), el('th', null, two ? (m.format === 'reim' ? '실수 열' : '크기 열') : '크기 열'), two ? el('th', null, m.format === 'reim' ? '허수 열' : '위상 열') : null, el('th', null, '단위(선택)'), el('th', null, ''))),
        el('tbody', null, rows))),
      el('div', { class: 'btn-row', style: 'margin-top:10px' },
        el('button', { type: 'button', class: 'btn btn-small', onclick: function () { m.points.push({ name: '응답점' + (m.points.length + 1), a: -1, b: -1, unit: '' }); save(); render(); } }, '응답점 추가'),
        el('button', { type: 'button', class: 'btn btn-small', onclick: function () { state.frfMap = L.guessMapping(info.headers); state.frf = null; save(); render(); } }, '머리행으로 다시 추정')),
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', id: 'buildFrf', onclick: buildFrf }, 'FRF 표 만들기'))));

    if (state.frf) wrap.appendChild(frfSummaryCard());
    return wrap;
  }
  function buildFrf() {
    var info = fileRowsInfo(state.frfFile);
    var r = L.buildFrf(info.data, state.frfMap);
    if (!r.ok) { state.frf = null; save(); render(); var eb = alertBox('error', 'FRF 표를 만들지 못했습니다', r.errors); eb.id = 'frfErrors'; main.appendChild(eb); eb.scrollIntoView({ block: 'nearest' }); return; }
    state.frf = r.frf; state.frfWarnings = r.warnings; result = null; estimate = null;
    save(); toast('FRF 표를 만들었습니다 — 응답점 ' + r.frf.points.length + '개');
    render();
  }
  function frfSummaryCard() {
    var s = L.frfSummary(state.frf);
    return el('section', { class: 'card', id: 'frfSummary' },
      el('h2', null, 'FRF 표 확인'),
      el('dl', { class: 'summary' },
        el('div', null, el('dt', null, '주파수 범위'), el('dd', null, L.fmt(s.fmin) + ' ~ ' + L.fmt(s.fmax) + ' Hz')),
        el('div', null, el('dt', null, '주파수 간격'), el('dd', null, L.fmt(s.step) + ' Hz' + (s.uneven ? ' (고르지 않음)' : ''))),
        el('div', null, el('dt', null, '행 수'), el('dd', null, String(s.rows))),
        el('div', null, el('dt', null, '응답점'), el('dd', null, state.frf.points.map(function (p) { return p.name + (p.unit ? ' [' + p.unit + ']' : ''); }).join(', ')))),
      alertBox('warn', '확인할 점', state.frfWarnings),
      el('div', { class: 'actions' }, el('a', { class: 'btn btn-primary', href: '#/calc' }, '다음: 계산 조건')));
  }

  // ── 2. 계산 조건 ──────────────────────────────────────────────
  function viewCalc() {
    var st = state.settings;
    var wrap = el('div');
    wrap.appendChild(el('div', { class: 'page-head' }, el('h1', null, '2. 계산 조건')));
    wrap.appendChild(steps());
    if (!state.frf) wrap.appendChild(el('div', { class: 'alert info' }, '먼저 ', el('a', { href: '#/frf' }, '1. FRF 불러오기'), '에서 FRF 표를 만들어 주십시오. 조건은 미리 입력해 둘 수 있습니다.'));
    function num(name, label, help) {
      return field(label, el('input', { type: 'number', name: name, step: 'any', value: st[name] === '' || st[name] == null ? '' : String(st[name]), oninput: function () { st[name] = this.value; save(); } }), help);
    }
    var s = L.frfSummary && state.frf ? L.frfSummary(state.frf) : null;
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, 'RPM 범위'),
      el('div', { class: 'form-grid' }, num('rpmStart', 'RPM 시작'), num('rpmEnd', 'RPM 끝'), num('rpmStep', 'RPM 간격', '끝값이 간격에 맞지 않으면 끝값도 계산합니다.')),
      s ? el('p', { class: 'note', style: 'margin-top:10px' }, 'FRF 해석 범위는 ' + L.fmt(s.fmin) + '~' + L.fmt(s.fmax) + ' Hz 입니다. 가진 주파수(차수 × RPM / 60)가 이 범위를 넘는 칸은 계산하지 않고 표시합니다.') : null));

    var interpSel = el('select', { name: 'interp', onchange: function () { st.interp = this.value; save(); } },
      Object.keys(L.INTERP).map(function (k) { return el('option', { value: k, selected: k === st.interp }, L.INTERP[k]); }));
    var modeRow = el('div', { class: 'radio-row', role: 'radiogroup', 'aria-label': '가진력 입력 방식' },
      [['const', '차수별 상수'], ['table', 'RPM별 가진력 표(엑셀·CSV)']].map(function (o) {
        return el('label', null, el('input', { type: 'radio', name: 'forceMode', value: o[0], checked: st.forceMode === o[0], onchange: function () { st.forceMode = o[0]; save(); render(); } }), o[1]);
      }));
    var isConst = st.forceMode === 'const';
    var orderRows = st.orders.map(function (o, i) {
      return el('tr', null,
        el('td', null, el('input', { class: 'cell-input', type: 'number', step: 'any', name: 'order', value: o.order === '' ? '' : String(o.order), 'aria-label': (i + 1) + '번째 차수', oninput: function () { o.order = this.value; save(); } })),
        isConst ? el('td', null, el('input', { class: 'cell-input', type: 'number', step: 'any', name: 'force', value: o.force === '' || o.force == null ? '' : String(o.force), 'aria-label': (i + 1) + '번째 가진력', oninput: function () { o.force = this.value; save(); } })) : null,
        el('td', null, el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: function () { st.orders.splice(i, 1); if (!st.orders.length) st.orders.push({ order: '', force: '' }); save(); render(); } }, '빼기')));
    });
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, '차수와 가진력'),
      el('p', { class: 'note' }, '차수는 회전 차수로 보고 가진 주파수 = 차수 × RPM / 60 (Hz) 로 계산합니다(가정 — 기획서 10장 확인 사항). 0.5차 같은 소수 차수도 넣을 수 있습니다.'),
      modeRow,
      el('div', { class: 'form-grid', style: 'margin-top:12px' },
        field('가진력 단위', el('input', { name: 'forceUnit', value: st.forceUnit || '', oninput: function () { st.forceUnit = this.value; save(); } }), '표시·엑셀 기록용'),
        field('FRF 보간 방식', interpSel, '가진 주파수가 해석 주파수 사이에 있을 때')),
      el('div', { class: 'table-wrap', style: 'margin-top:14px' }, el('table', { class: 'grid map' },
        el('thead', null, el('tr', null, el('th', null, '차수'), isConst ? el('th', null, '가진력' + (st.forceUnit ? ' (' + st.forceUnit + ')' : '')) : null, el('th', null, ''))),
        el('tbody', null, orderRows))),
      el('div', { class: 'btn-row', style: 'margin-top:10px' }, el('button', { type: 'button', class: 'btn btn-small', onclick: function () { st.orders.push({ order: '', force: '' }); save(); render(); } }, '차수 추가')),
      isConst ? null : forceTableBlock()));

    wrap.appendChild(el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', id: 'calcBtn', onclick: runCalc }, 'RPM별 응답 계산')));
    return wrap;
  }
  function forceTableBlock() {
    var ff = state.forceFile, st = state.settings;
    var box = el('div', { style: 'margin-top:18px' }, el('h3', null, 'RPM별 가진력 표'),
      el('p', { class: 'note' }, '한 행 = RPM 하나, 차수마다 가진력 열 하나인 표를 불러옵니다(가정 형식). 표의 RPM 사이는 선형 보간하고, 표 범위 밖 RPM 은 계산하지 않습니다.'));
    if (ff && ff.source === 'estimate') {
      box.appendChild(el('div', { class: 'alert info' }, '지금 가진력 표는 「4. 가진력 추정」의 종합 추정값에서 왔습니다 (RPM ' + L.fmt(state.forceTable.rpm[0]) + '~' + L.fmt(state.forceTable.rpm[state.forceTable.rpm.length - 1]) + ', 차수 ' + Object.keys(state.forceTable.byOrder).join(', ') + '). 다른 파일을 고르면 바뀝니다.'));
    }
    box.appendChild(fileInput('가진력 표 파일', function (nf) {
      nf.map = guessForceMap(fileRowsInfo(nf).headers);
      state.forceFile = nf; state.forceTable = null; save(); render();
    }));
    if (!ff || ff.source === 'estimate') return box;
    box.appendChild(fileControls(ff, function (reguess) { if (reguess) ff.map = guessForceMap(fileRowsInfo(ff).headers); state.forceTable = null; save(); render(); }));
    var info = fileRowsInfo(ff);
    var rpmSel = colSelect('forceRpmCol', info.headers, ff.map.rpmCol);
    rpmSel.addEventListener('change', function () { ff.map.rpmCol = +this.value; save(); });
    var ords = validOrderNumbers();
    var rows = ords.map(function (k) {
      var cur = (ff.map.orderCols.filter(function (c) { return +c.order === k; })[0] || {}).col;
      var sel = colSelect('forceCol', info.headers, cur == null ? -1 : cur, true);
      sel.className = 'cell-input';
      sel.addEventListener('change', function () {
        ff.map.orderCols = ff.map.orderCols.filter(function (c) { return +c.order !== k; }).concat([{ order: k, col: +this.value }]); save();
      });
      return el('tr', null, el('td', null, k + '차'), el('td', null, sel));
    });
    box.appendChild(el('div', { class: 'form-grid cols-2', style: 'margin-top:14px' }, field('RPM 열', rpmSel)));
    box.appendChild(ords.length
      ? el('div', { class: 'table-wrap', style: 'margin-top:10px' }, el('table', { class: 'grid map' }, el('thead', null, el('tr', null, el('th', null, '차수'), el('th', null, '가진력 열'))), el('tbody', null, rows)))
      : el('p', { class: 'note' }, '위 차수 칸에 차수를 먼저 입력하면 차수별 열을 고를 수 있습니다.'));
    return box;
  }
  function guessForceMap(headers) {
    var rpmCol = 0;
    headers.forEach(function (h, i) { if (/rpm|회전/i.test(String(h)) && rpmCol === 0) rpmCol = i; });
    var orderCols = [];
    headers.forEach(function (h, i) {
      if (i === rpmCol) return;
      var m = String(h).match(/(\d+(?:\.\d+)?)\s*(차|order|ord|x\b)/i) || String(h).match(/^\s*(\d+(?:\.\d+)?)\s*$/);
      if (m) orderCols.push({ order: +m[1], col: i });
    });
    return { rpmCol: rpmCol, orderCols: orderCols };
  }
  function validOrderNumbers() {
    var out = [];
    state.settings.orders.forEach(function (o) { var k = L.toNumber(o.order); if (k > 0 && out.indexOf(k) < 0) out.push(k); });
    return out.sort(function (a, b) { return a - b; });
  }

  function configFromSettings() {
    var st = state.settings, errs = [];
    if (!state.frf) errs.push('FRF 표가 없습니다. 1단계에서 FRF 표를 만들어 주십시오.');
    var rl = L.rpmList(st.rpmStart, st.rpmEnd, st.rpmStep);
    if (!rl.ok) errs = errs.concat(rl.errors);
    var isConst = st.forceMode === 'const';
    var vo = L.validateOrders(st.orders, isConst);
    if (!vo.ok) errs = errs.concat(vo.errors);
    var force = null;
    if (!isConst) {
      if (state.forceFile && state.forceFile.source !== 'estimate') {
        var info = fileRowsInfo(state.forceFile);
        var pt = L.parseForceTable(info.data, state.forceFile.map);
        if (!pt.ok) errs = errs.concat(pt.errors); else state.forceTable = pt.table;
      }
      if (!state.forceTable) { if (!errs.length) errs.push('RPM별 가진력 표를 불러와 주십시오.'); }
      else force = { mode: 'table', table: state.forceTable };
      if (vo.ok && state.forceTable) vo.orders.forEach(function (o) { if (!state.forceTable.byOrder[o.order]) errs.push(o.order + '차의 가진력 열을 지정해 주십시오.'); });
    } else if (vo.ok) force = { mode: 'const', orders: vo.orders };
    var ri = L.INTERP[st.interp] ? st.interp : 'linear';
    if (errs.length) return { ok: false, errors: errs };
    return { ok: true, cfg: { rpms: rl.list, orders: vo.orders, force: force, interp: ri } };
  }
  function runCalc() {
    var c = configFromSettings();
    if (!c.ok) {
      render();
      var box = alertBox('error', '계산하지 못했습니다', c.errors); box.id = 'calcErrors';
      main.appendChild(box); box.scrollIntoView({ block: 'nearest' });
      return;
    }
    result = L.computeResponse(state.frf, c.cfg); result.cfg = c.cfg;
    save(); ui.point = 0;
    location.hash = '#/result';
  }

  // ── 3. 결과 ─────────────────────────────────────────────────
  var COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2'];
  function ensureResult() {
    if (result) return true;
    var c = configFromSettings();
    if (!c.ok) return false;
    result = L.computeResponse(state.frf, c.cfg); result.cfg = c.cfg;
    return true;
  }
  function viewResult() {
    var wrap = el('div');
    wrap.appendChild(el('div', { class: 'page-head' }, el('h1', null, '3. RPM별 응답 결과')));
    wrap.appendChild(steps());
    if (!ensureResult()) {
      wrap.appendChild(el('div', { class: 'alert info' }, '아직 계산 결과가 없습니다. ', el('a', { href: '#/calc' }, '2. 계산 조건'), '에서 「RPM별 응답 계산」을 눌러 주십시오.'));
      return wrap;
    }
    var st = state.settings, cfg = result.cfg;
    if (ui.point >= result.points.length) ui.point = 0;
    var p = result.points[ui.point];
    add(wrap, alertBox('warn', '확인할 점', result.warnings));
    wrap.appendChild(el('section', { class: 'card' },
      el('div', { class: 'btn-row', style: 'justify-content:space-between;margin-bottom:10px' },
        el('p', { class: 'note', style: 'margin:0' }, 'RPM ' + L.fmt(cfg.rpms[0]) + '~' + L.fmt(cfg.rpms[cfg.rpms.length - 1]) + ' (' + cfg.rpms.length + '점) · 차수 ' + cfg.orders.map(function (o) { return o.order; }).join(', ') + ' · ' + L.INTERP[cfg.interp] + ' · 가진력 ' + (cfg.force.mode === 'table' ? 'RPM별 표' : '차수별 상수')),
        el('div', { class: 'btn-row' },
          el('button', { type: 'button', class: 'btn btn-primary', id: 'xlsxBtn', onclick: function () {
            downloadSheets(outName('RPM별응답', 'xlsx'), L.resultToSheets(result, cfg.orders, { fileName: state.frfFile && state.frfFile.name, interp: cfg.interp, forceMode: cfg.force.mode, forceUnit: st.forceUnit, sample: state.sample, created: nowText() }));
          } }, '결과 엑셀 내려받기'),
          el('button', { type: 'button', class: 'btn', id: 'csvBtn', onclick: function () {
            var sh = L.resultToSheets({ points: [p] }, cfg.orders, { forceMode: cfg.force.mode })[1];
            download(outName('RPM별응답_' + baseOf(p.name), 'csv'), new Blob([L.toCsv(sh.rows)], { type: 'text/csv;charset=utf-8' }));
          } }, '이 응답점 CSV'))),
      result.points.length > 1 ? el('div', { class: 'point-tabs', role: 'group', 'aria-label': '응답점' }, result.points.map(function (q, i) {
        return el('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': i === ui.point ? 'true' : 'false', onclick: function () { ui.point = i; render(); } }, q.name);
      })) : null,
      el('div', { class: 'btn-row', style: 'margin-bottom:6px' },
        el('h2', { style: 'margin:0;margin-right:auto' }, p.name + (p.unit ? ' — FRF 단위 ' + p.unit : '')),
        el('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': ui.logY ? 'true' : 'false', onclick: function () { ui.logY = !ui.logY; render(); } }, '세로축 로그'),
        el('button', { type: 'button', class: 'btn btn-small', onclick: function () {
          var svg = document.querySelector('.chart-box svg');
          download(outName('RPM응답그래프_' + baseOf(p.name), 'svg'), new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svg.outerHTML], { type: 'image/svg+xml' }));
        } }, '그래프 SVG 저장')),
      chart(p, cfg.orders)));

    var detail = ui.detail;
    var head = [el('th', null, 'RPM')];
    cfg.orders.forEach(function (o) {
      if (detail) head.push(el('th', null, o.order + '차 f(Hz)'), el('th', null, o.order + '차 |FRF|'), el('th', null, o.order + '차 가진력'));
      head.push(el('th', null, o.order + '차 응답'));
    });
    head.push(el('th', null, 'overall (RSS)'), el('th', { class: 'text' }, '비고'));
    var body = p.rows.map(function (r) {
      var cells = [el('td', null, L.fmt(r.rpm, 6))];
      var notes = [];
      r.comps.forEach(function (c) {
        if (detail) cells.push(el('td', null, L.fmt(c.f, 5)), el('td', null, L.fmt(c.frf)), el('td', null, L.fmt(c.force)));
        cells.push(el('td', null, c.resp == null ? '-' : L.fmt(c.resp)));
        if (c.status !== 'ok') notes.push(c.order + '차 ' + L.STATUS_TEXT[c.status]);
      });
      cells.push(el('td', null, el('strong', null, r.overall == null ? '-' : L.fmt(r.overall))), el('td', { class: 'text' }, (r.partial ? '일부 차수 제외. ' : '') + notes.join('; ')));
      return el('tr', { class: r.partial ? 'partial' : null }, cells);
    });
    wrap.appendChild(el('section', { class: 'card' },
      el('div', { class: 'btn-row', style: 'margin-bottom:10px' },
        el('h2', { style: 'margin:0;margin-right:auto' }, '계산 표'),
        el('label', { class: 'radio-row' }, el('input', { type: 'checkbox', name: 'detail', checked: detail, onchange: function () { ui.detail = this.checked; render(); } }), '가진 주파수·|FRF|·가진력 열도 보기')),
      el('p', { class: 'note' }, '차수 응답 = |FRF(차수 × RPM / 60)| × 가진력, overall = √(Σ 차수 응답²). 응답 단위는 FRF 단위 × 가진력 단위(' + (st.forceUnit || '미입력') + ')입니다. 주황 줄은 일부 차수가 빠진 overall 입니다.'),
      el('div', { class: 'table-wrap tall' }, el('table', { class: 'grid', id: 'resultTable' }, el('thead', null, el('tr', null, head)), el('tbody', null, body)))));
    return wrap;
  }

  // SVG 선 그래프 (외부 라이브러리 없이)
  function chart(p, orders) {
    var W = 900, H = 420, m = { l: 74, r: 18, t: 18, b: 52 };
    var series = orders.map(function (o, k) { return { name: o.order + '차', color: COLORS[k % COLORS.length], width: 2, pts: p.rows.map(function (r) { return [r.rpm, r.comps[k].resp]; }) }; });
    series.push({ name: 'overall', color: '#111', width: 3.5, pts: p.rows.map(function (r) { return [r.rpm, r.overall]; }) });
    var xs = p.rows.map(function (r) { return r.rpm; });
    var ys = [];
    series.forEach(function (s) { s.pts.forEach(function (q) { if (q[1] != null && isFinite(q[1]) && (!ui.logY || q[1] > 0)) ys.push(q[1]); }); });
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    if (xmax === xmin) { xmin -= 1; xmax += 1; }
    var ymin, ymax, ty;
    var NS = 'http://www.w3.org/2000/svg';
    function s(tag, attrs, txt) { var n = document.createElementNS(NS, tag); Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); }); if (txt != null) n.textContent = txt; return n; }
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, xmlns: NS, role: 'img', 'aria-label': p.name + ' RPM별 응답 그래프', 'font-family': 'sans-serif', 'font-size': '14' });
    svg.appendChild(s('rect', { x: 0, y: 0, width: W, height: H, fill: '#fff' }));
    if (!ys.length) { svg.appendChild(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#555' }, '그릴 값이 없습니다')); return el('div', { class: 'chart-box' }, svg); }
    if (ui.logY) {
      var lo = Math.floor(Math.log10(Math.min.apply(null, ys))), hi = Math.ceil(Math.log10(Math.max.apply(null, ys)));
      if (hi === lo) hi = lo + 1;
      ymin = lo; ymax = hi; ty = []; for (var e = lo; e <= hi; e++) ty.push(e);
    } else {
      ty = L.niceTicks(0, Math.max.apply(null, ys), 5); ymin = ty[0]; ymax = ty[ty.length - 1];
    }
    var tx = L.niceTicks(xmin, xmax, 6).filter(function (v) { return v >= xmin && v <= xmax; });
    function X(v) { return m.l + (v - xmin) / (xmax - xmin) * (W - m.l - m.r); }
    function Y(v) { var t = ui.logY ? Math.log10(v) : v; return H - m.b - (t - ymin) / (ymax - ymin) * (H - m.t - m.b); }
    ty.forEach(function (v) {
      var y = H - m.b - (v - ymin) / (ymax - ymin) * (H - m.t - m.b);
      svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, stroke: '#e3e7ec' }));
      svg.appendChild(s('text', { x: m.l - 8, y: y + 5, 'text-anchor': 'end', fill: '#444' }, ui.logY ? L.fmt(Math.pow(10, v), 3) : L.fmt(v, 4)));
    });
    tx.forEach(function (v) {
      svg.appendChild(s('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, stroke: '#eef1f4' }));
      svg.appendChild(s('text', { x: X(v), y: H - m.b + 20, 'text-anchor': 'middle', fill: '#444' }, L.fmt(v, 6)));
    });
    svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: '#333' }));
    svg.appendChild(s('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, stroke: '#333' }));
    svg.appendChild(s('text', { x: (m.l + W - m.r) / 2, y: H - 10, 'text-anchor': 'middle', fill: '#222' }, 'RPM'));
    svg.appendChild(s('text', { x: 16, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', fill: '#222', transform: 'rotate(-90 16 ' + (m.t + H - m.b) / 2 + ')' }, '응답' + (ui.logY ? ' (로그)' : '')));
    series.forEach(function (sr) {
      var d = '', pen = false;
      sr.pts.forEach(function (q) {
        var ok = q[1] != null && isFinite(q[1]) && (!ui.logY || q[1] > 0);
        if (!ok) { pen = false; return; }
        d += (pen ? 'L' : 'M') + X(q[0]).toFixed(1) + ' ' + Y(q[1]).toFixed(1) + ' ';
        pen = true;
      });
      if (d) svg.appendChild(s('path', { d: d, fill: 'none', stroke: sr.color, 'stroke-width': sr.width, 'stroke-linejoin': 'round' }));
    });
    // 범례를 그림 안에도 넣어 SVG 로 저장해도 읽히게
    var lx = m.l + 10;
    series.forEach(function (sr) {
      svg.appendChild(s('line', { x1: lx, x2: lx + 22, y1: m.t + 12, y2: m.t + 12, stroke: sr.color, 'stroke-width': sr.width }));
      svg.appendChild(s('text', { x: lx + 28, y: m.t + 17, fill: '#222' }, sr.name));
      lx += 40 + sr.name.length * 9;
    });
    return el('div', null, el('div', { class: 'chart-box' }, svg),
      el('ul', { class: 'legend' }, series.map(function (sr) { return el('li', null, el('i', { style: 'border-color:' + sr.color + ';border-top-width:' + sr.width + 'px' }), sr.name); })));
  }

  // ── 4. 가진력 추정 ────────────────────────────────────────────
  function viewForce() {
    var wrap = el('div');
    wrap.appendChild(el('div', { class: 'page-head' }, el('h1', null, '4. 계측 데이터로 가진력 추정')));
    wrap.appendChild(steps());
    wrap.appendChild(el('div', { class: 'alert info' },
      el('p', { style: 'margin:0 0 4px' }, '가진력 = |계측 응답| ÷ |FRF(차수 × RPM / 60)| 로 구합니다(단일 가진점 가정, 기획서 4장).'),
      el('p', { style: 'margin:0' }, '계측 파일은 「한 행 = RPM·차수 하나, 응답점마다 계측값 열 하나」로 정리된 표라고 가정합니다. 실제 계측 형식(시간 신호 등)을 받으면 2단계에서 맞춥니다.')));
    if (!state.frf) { wrap.appendChild(el('div', { class: 'alert info' }, '먼저 ', el('a', { href: '#/frf' }, '1. FRF 불러오기'), '에서 FRF 표를 만들어 주십시오.')); return wrap; }
    var mf = state.measFile;
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, '계측 파일'),
      fileInput('계측 응답 파일', function (nf) {
        state.measFile = nf; state.measMap = guessMeasMap(fileRowsInfo(nf).headers); estimate = null; save(); render();
      }),
      mf ? el('p', { style: 'margin-top:10px' }, '불러온 파일: ', el('strong', null, mf.name)) : null,
      mf ? fileControls(mf, function (reguess) { if (reguess) state.measMap = guessMeasMap(fileRowsInfo(mf).headers); estimate = null; save(); render(); }) : null));
    if (!mf) return wrap;
    var info = fileRowsInfo(mf), mm = state.measMap || guessMeasMap(info.headers);
    state.measMap = mm;
    var rpmSel = colSelect('measRpmCol', info.headers, mm.rpmCol); rpmSel.addEventListener('change', function () { mm.rpmCol = +this.value; estimate = null; save(); });
    var ordSel = colSelect('measOrderCol', info.headers, mm.orderCol); ordSel.addEventListener('change', function () { mm.orderCol = +this.value; estimate = null; save(); });
    var st = state.settings;
    var ratioIn = el('input', { type: 'number', name: 'antiRatio', step: 'any', min: 0, value: String(st.antiRatio == null ? '' : st.antiRatio), oninput: function () { st.antiRatio = this.value; estimate = null; save(); } });
    wrap.appendChild(el('section', { class: 'card' },
      el('h2', null, '열 짝짓기'),
      el('div', { class: 'form-grid' }, field('RPM 열', rpmSel), field('차수 열', ordSel),
        field('반공진 경고 기준', ratioIn, '그 응답점 최대 |FRF| 에 이 비율을 곱한 값보다 |FRF| 가 작으면 경고하고 종합값에서 뺍니다. 값은 해석자가 정합니다.')),
      el('div', { class: 'table-wrap', style: 'margin-top:14px' }, el('table', { class: 'grid map' },
        el('thead', null, el('tr', null, el('th', null, 'FRF 응답점'), el('th', null, '계측값 열'))),
        el('tbody', null, state.frf.points.map(function (p) {
          var sel = colSelect('measPointCol', info.headers, mm.pointCols[p.name] == null ? -1 : mm.pointCols[p.name], true);
          sel.className = 'cell-input';
          sel.addEventListener('change', function () { mm.pointCols[p.name] = +this.value; estimate = null; save(); });
          return el('tr', null, el('td', null, p.name), el('td', null, sel));
        })))),
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', id: 'estBtn', onclick: runEstimate }, '가진력 추정'))));
    if (estimate) wrap.appendChild(estimateCard());
    return wrap;
  }
  function guessMeasMap(headers) {
    var rpmCol = -1, orderCol = -1, pointCols = {};
    headers.forEach(function (h, i) {
      var t = String(h);
      if (rpmCol < 0 && /rpm|회전/i.test(t)) rpmCol = i;
      else if (orderCol < 0 && /차수|order/i.test(t)) orderCol = i;
    });
    if (rpmCol < 0) rpmCol = 0;
    if (orderCol < 0) orderCol = rpmCol === 0 ? 1 : 0;
    (state.frf ? state.frf.points : []).forEach(function (p) {
      var i = headers.map(function (h) { return String(h).trim(); }).indexOf(p.name);
      pointCols[p.name] = i;
    });
    return { rpmCol: rpmCol, orderCol: orderCol, pointCols: pointCols };
  }
  function runEstimate() {
    var info = fileRowsInfo(state.measFile);
    var pm = L.parseMeasured(info.data, state.measMap);
    if (!pm.ok) { render(); var b = alertBox('error', '추정하지 못했습니다', pm.errors); b.id = 'estErrors'; main.appendChild(b); return; }
    var ratio = L.toNumber(state.settings.antiRatio);
    if (isNaN(ratio) || ratio < 0) { render(); main.appendChild(alertBox('error', '추정하지 못했습니다', ['반공진 경고 기준을 0 이상의 숫자로 입력해 주십시오.'])); return; }
    estimate = L.estimateForce(state.frf, pm, { interp: state.settings.interp, antiRatio: ratio });
    estimate.meta = { skipped: pm.skipped, points: pm.points, ratio: ratio };
    render();
    var c = document.getElementById('estCard'); if (c) c.scrollIntoView({ block: 'start' });
  }
  function estimateCard() {
    var pts = estimate.meta.points;
    var anti = 0, missing = 0;
    var body = estimate.rows.map(function (r) {
      return el('tr', null, el('td', null, L.fmt(r.rpm, 6)), el('td', null, String(r.order)), el('td', null, L.fmt(r.f, 5)),
        r.points.map(function (q) {
          if (q.anti) anti++;
          if (q.status !== 'ok') missing++;
          return el('td', { class: q.anti ? 'anti' : null, title: q.anti ? '반공진 부근 — 종합값에서 뺌' : null }, q.force == null ? '-' : L.fmt(q.force) + (q.anti ? ' (경고)' : ''));
        }),
        el('td', null, el('strong', null, r.ls == null ? '-' : L.fmt(r.ls))), el('td', null, String(r.used)));
    });
    var notes = [];
    if (anti) notes.push('반공진 부근(|FRF| 가 작아 추정값이 튀기 쉬운 곳)으로 표시된 칸이 ' + anti + '개 있습니다. 종합값에서 뺐습니다.');
    if (missing) notes.push('FRF 범위 밖이거나 계측값이 비어 계산하지 못한 칸이 ' + missing + '개 있습니다.');
    if (estimate.meta.skipped) notes.push('RPM·차수가 숫자가 아닌 행 ' + estimate.meta.skipped + '개를 건너뛰었습니다.');
    return el('section', { class: 'card', id: 'estCard' },
      el('div', { class: 'btn-row', style: 'margin-bottom:10px' },
        el('h2', { style: 'margin:0;margin-right:auto' }, '추정 결과 (' + estimate.rows.length + '행)'),
        el('button', { type: 'button', class: 'btn btn-primary', id: 'estXlsxBtn', onclick: function () {
          downloadSheets(outName('가진력추정', 'xlsx'), L.estimateToSheets(estimate, { fileName: state.frfFile && state.frfFile.name, measFile: state.measFile.name, interp: state.settings.interp, antiRatio: estimate.meta.ratio, sample: state.sample, created: nowText() }));
        } }, '추정 엑셀 내려받기'),
        el('button', { type: 'button', class: 'btn', id: 'useEstBtn', onclick: useEstimate }, '종합값을 가진력 표로 계산에 쓰기')),
      alertBox('warn', null, notes),
      el('p', { class: 'note' }, '종합값 = 경고 없는 응답점들로 구한 최소제곱 값 Σ|FRF|·|계측| ÷ Σ|FRF|² (응답점마다 같은 가중, 가정). 응답점별 값이 서로 크게 다르면 가진점이 여럿이거나 계측점·해석점이 어긋났을 수 있습니다.'),
      el('div', { class: 'table-wrap tall' }, el('table', { class: 'grid', id: 'estTable' },
        el('thead', null, el('tr', null, el('th', null, 'RPM'), el('th', null, '차수'), el('th', null, 'f(Hz)'), pts.map(function (n) { return el('th', null, n); }), el('th', null, '종합'), el('th', null, '쓴 응답점'))),
        el('tbody', null, body))));
  }
  function useEstimate() {
    var t = L.estimateToForceTable(estimate);
    var st = state.settings;
    state.forceTable = t.table;
    state.forceFile = { source: 'estimate', name: '가진력 추정 결과' };
    st.forceMode = 'table';
    st.orders = t.orders.map(function (k) { return { order: k, force: '' }; });
    st.rpmStart = t.table.rpm[0]; st.rpmEnd = t.table.rpm[t.table.rpm.length - 1];
    if (!(L.toNumber(st.rpmStep) > 0)) st.rpmStep = t.table.rpm.length > 1 ? t.table.rpm[1] - t.table.rpm[0] : 1;
    result = null; save();
    toast('종합 추정값을 RPM별 가진력 표로 넣었습니다. 계산 조건을 확인하고 계산해 주십시오.');
    location.hash = '#/calc';
  }

  // ── 계산 방법 ─────────────────────────────────────────────────
  function viewHelp() {
    return el('div', { class: 'prose' },
      el('div', { class: 'page-head' }, el('h1', null, '계산 방법과 가정')),
      el('section', { class: 'card' },
        el('h2', null, '계산식 (수강생 원문 참고 1·2)'),
        el('div', { class: 'formula' }, '가진 주파수   f = 차수 × RPM / 60            [Hz]\n차수 응답     R_k(RPM) = |FRF(f)| × F_k(RPM)\noverall       R(RPM) = √( Σ_k R_k(RPM)² )     (RSS)\n가진력 추정   F_k = |계측 응답| ÷ |FRF(f)|'),
        el('h2', null, '1단계에서 둔 가정 (실제 자료를 받으면 확정)'),
        el('ul', null,
          el('li', null, '차수는 회전 차수이며 가진 주파수 = 차수 × RPM / 60 입니다.'),
          el('li', null, '주파수 열의 단위는 Hz 입니다.'),
          el('li', null, 'FRF 가 크기+위상 또는 실수+허수로 와도 응답 계산에는 크기 |FRF| 만 씁니다. 가진점이 하나라는 가정입니다. 가진점이 여럿이면 위상까지 더하는 방식이 필요해 2단계에서 다룹니다.'),
          el('li', null, '해석 주파수 사이 값은 선택한 방식(선형 / 가장 가까운 점 / 로그)으로 보간합니다. 해석 범위 밖은 계산하지 않고 비고에 적습니다.'),
          el('li', null, '가진력 추정의 계측 파일은 RPM·차수별로 정리된 표입니다. 반공진 경고 기준은 사용자가 정합니다.'),
          el('li', null, 'dB 변환은 기준값을 확인한 뒤 2단계에서 넣습니다.')),
        el('h2', null, '교차 확인'),
        el('p', null, '같은 계산을 하는 파이썬 스크립트 ', el('code', null, 'python/rpm_response.py'), ' 와 코랩 노트북 ', el('code', null, 'python/rpm_response_colab.ipynb'), ' 이 저장소에 있습니다. 웹 결과와 값을 대조할 수 있습니다.'),
        el('h2', null, '데이터 보관'),
        el('p', null, '불러온 파일과 조건은 이 브라우저 저장소에만 남습니다. 다른 PC 로 옮기거나 보관하려면 결과 엑셀을 내려받아 두십시오. 「모두 지우기」로 지울 수 있습니다.')));
  }

  function steps() {
    var done = [!!state.frf, !!(result || (state.settings.rpmStart !== '' && state.settings.rpmEnd !== '')), !!result, !!estimate];
    var items = [['1. FRF 불러오기', '열 짝짓기 → FRF 표'], ['2. 계산 조건', 'RPM·차수·가진력'], ['3. 결과', '그래프·표·엑셀'], ['4. 가진력 추정', '계측이 있을 때']];
    return el('ol', { class: 'steps' }, items.map(function (it, i) { return el('li', { class: done[i] ? 'done' : null }, el('b', null, it[0]), el('span', null, it[1])); }));
  }

  // ── 예시 데이터·지우기 ────────────────────────────────────────
  function loadSample() {
    var s = S.build();
    function asFile(name, rows) { var sh = {}; sh['예시데이터'] = rows; return { name: name, sheetNames: ['예시데이터'], sheets: sh, sheet: '예시데이터', headerRow: 0 }; }
    state = emptyState();
    state.sample = true;
    state.frfFile = asFile(S.FILE_FRF + '.xlsx', s.frfRows);
    state.frfMap = L.guessMapping(s.frfRows[0]);
    state.frfMap.points.forEach(function (p) { p.unit = s.units[p.name] || ''; });
    var b = L.buildFrf(s.frfRows.slice(1), state.frfMap);
    state.frf = b.frf; state.frfWarnings = b.warnings;
    var st = s.settings;
    state.settings = { rpmStart: st.rpmStart, rpmEnd: st.rpmEnd, rpmStep: st.rpmStep, orders: st.orders.map(function (o) { return { order: o.order, force: o.force }; }), forceMode: st.forceMode, forceUnit: st.forceUnit, interp: st.interp, antiRatio: st.antiRatio };
    state.forceFile = asFile(S.FILE_FORCE + '.csv', s.forceRows);
    state.forceFile.map = guessForceMap(s.forceRows[0]);
    state.measFile = asFile(S.FILE_MEAS + '.csv', s.measRows);
    state.measMap = guessMeasMap(s.measRows[0]);
    result = null; estimate = null;
    save();
    toast('예시 데이터를 불러왔습니다(가상 값).');
    if (location.hash === '#/frf') render(); else location.hash = '#/frf';
  }
  function clearAll() {
    if (!window.confirm('불러온 파일·조건·결과를 이 브라우저에서 모두 지웁니다. 계속하시겠습니까?')) return;
    Store.clear(); state = emptyState(); result = null; estimate = null; save();
    toast('모두 지웠습니다.');
    if (location.hash === '#/frf') render(); else location.hash = '#/frf';
  }

  // ── 라우팅 ─────────────────────────────────────────────────
  var ROUTES = { '#/frf': viewFrf, '#/calc': viewCalc, '#/result': viewResult, '#/force': viewForce, '#/help': viewHelp };
  function render() {
    var h = ROUTES[location.hash] ? location.hash : '#/frf';
    main.textContent = '';
    main.appendChild(ROUTES[h]());
    document.getElementById('sampleBanner').hidden = !state.sample;
    Array.prototype.forEach.call(document.querySelectorAll('#nav a'), function (a) {
      if (a.getAttribute('href') === h) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    main.setAttribute('data-route', h);
  }
  var lastRoute = null;
  window.addEventListener('hashchange', function () {
    if (!ROUTES[location.hash]) { location.hash = '#/frf'; return; }
    render();
    if (lastRoute !== location.hash) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
    lastRoute = location.hash;
  });
  document.getElementById('sampleBtn').addEventListener('click', loadSample);
  document.getElementById('clearBtn').addEventListener('click', clearAll);
  if (!Store.available()) {
    var sb = document.getElementById('storeBanner');
    sb.textContent = '이 브라우저는 저장소를 막고 있어, 창을 닫으면 입력이 사라집니다. 결과는 엑셀로 내려받아 두십시오.'; sb.hidden = false;
  }
  if (!ROUTES[location.hash]) history.replaceState(null, '', '#/frf');
  lastRoute = location.hash;
  render();
})();

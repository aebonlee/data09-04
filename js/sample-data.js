/*
 * 예시 데이터 — 화면 시연과 계산 확인용으로 만든 가상의 값입니다.
 * 실제 지게차 해석(OptiStruct) 결과나 계측 결과가 아닙니다.
 * 고유진동수·감쇠·가진력·응답점 이름은 모두 지어낸 값이며, 이름에 「예시」를 붙였습니다.
 *
 *  FRF  : 가상의 모드 5개를 겹친 크기+위상 표 (0~400 Hz, 1 Hz 간격)
 *  계측 : 아래 「가상 참 가진력」 × FRF 에 ±2% 흔들림을 넣은 RPM·차수 표 — 가진력 추정 시연용
 *  가진력 표 : 가상 참 가진력을 RPM 200 간격으로 적은 표 — 「RPM별 가진력 표」 입력 시연용
 */
(function (root) {
  'use strict';
  var MODES = [32, 58, 96, 145, 230];   // 가상 고유진동수(Hz)
  var ZETA = 0.06;                       // 가상 감쇠비
  var POINTS = [
    { name: '예시_운전석바닥_진동', unit: '(m/s²)/N', amp: [0.012, 0.004, 0.009, -0.003, 0.002] },
    { name: '예시_운전자귀_소음', unit: 'Pa/N', amp: [0.020, 0.030, -0.010, 0.015, 0.008] },
    { name: '예시_핸들_진동', unit: '(m/s²)/N', amp: [0.006, -0.008, 0.012, 0.010, -0.004] }
  ];
  var ORDERS = [1, 2, 4];
  var BASE_FORCE = { 1: 120, 2: 60, 4: 25 }; // 가상 가진력(N)

  function H(point, f) {
    var re = 0, im = 0;
    MODES.forEach(function (fn, i) {
      var r = f / fn, a = 1 - r * r, b = 2 * ZETA * r, d = a * a + b * b;
      re += point.amp[i] * a / d;
      im += -point.amp[i] * b / d;
    });
    return { re: re, im: im };
  }
  function r6(x) { return Math.round(x * 1e6) / 1e6; }
  function sig(x) { return Number(x.toPrecision(6)); }

  // 가상 참 가진력: RPM 이 오를수록 커지는 모양(800rpm 에서 기준의 0.8배, 3000rpm 에서 1.2배)
  function trueForce(order, rpm) { return BASE_FORCE[order] * (0.8 + 0.4 * (rpm - 800) / 2200); }

  function build() {
    var head = ['Frequency [Hz]'];
    POINTS.forEach(function (p) { head.push(p.name + ' Mag', p.name + ' Phase'); });
    var frfRows = [head];
    for (var f = 0; f <= 400; f += 1) {
      var row = [f];
      POINTS.forEach(function (p) {
        var h = H(p, f);
        row.push(sig(Math.sqrt(h.re * h.re + h.im * h.im)), r6(Math.atan2(h.im, h.re) * 180 / Math.PI));
      });
      frfRows.push(row);
    }
    // 결정적 흔들림(매번 같은 값): 간단한 선형합동 난수
    var seed = 20260928;
    function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
    var measRows = [['RPM', '차수'].concat(POINTS.map(function (p) { return p.name; }))];
    for (var rpm = 800; rpm <= 3000; rpm += 200) {
      ORDERS.forEach(function (k) {
        var fk = k * rpm / 60, line = [rpm, k];
        POINTS.forEach(function (p) {
          var h = H(p, fk), mag = Math.sqrt(h.re * h.re + h.im * h.im);
          line.push(sig(mag * trueForce(k, rpm) * (1 + (rnd() - 0.5) * 0.04)));
        });
        measRows.push(line);
      });
    }
    var forceRows = [['RPM'].concat(ORDERS.map(function (k) { return k + '차 가진력(N)'; }))];
    for (var r2 = 800; r2 <= 3000; r2 += 200) forceRows.push([r2].concat(ORDERS.map(function (k) { return r6(trueForce(k, r2)); })));
    return {
      frfRows: frfRows,
      measRows: measRows,
      forceRows: forceRows,
      units: POINTS.reduce(function (o, p) { o[p.name] = p.unit; return o; }, {}),
      settings: {
        rpmStart: 800, rpmEnd: 3000, rpmStep: 50,
        orders: ORDERS.map(function (k) { return { order: k, force: BASE_FORCE[k] }; }),
        forceMode: 'const', forceUnit: 'N', interp: 'linear', antiRatio: 0.05
      },
      trueForce: trueForce
    };
  }

  var api = { build: build, FILE_FRF: '예시데이터_FRF', FILE_MEAS: '예시데이터_계측응답', FILE_FORCE: '예시데이터_가진력표' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FRFSample = api;
})(typeof window !== 'undefined' ? window : this);

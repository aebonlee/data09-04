// 실행: node test/logic.test.mjs   (의존성 없음)
// 기대값은 모두 손으로 계산한 값입니다(주석에 계산 과정).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const L = require('../js/logic.js');
const Sample = require('../js/sample-data.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

// 손계산용 작은 FRF: 0·10·20·30 Hz 에서 크기 0·1·3·2
const TINY = { freq: [0, 10, 20, 30], points: [{ name: 'P1', unit: '', mag: [0, 1, 3, 2] }] };

console.log('숫자 읽기');
test('쉼표·지수 표기', () => { assert.equal(L.toNumber('1,234.5'), 1234.5); assert.equal(L.toNumber('1.5E-3'), 0.0015); });
test('빈칸·단위 붙은 값은 숫자 아님', () => { assert.ok(isNaN(L.toNumber(''))); assert.ok(isNaN(L.toNumber('10 Hz'))); });

console.log('가진 주파수 = 차수 × RPM / 60');
test('1차 600rpm → 10Hz', () => near(L.excitationFreq(1, 600), 10));
test('2차 1500rpm → 50Hz', () => near(L.excitationFreq(2, 1500), 50));
test('0.5차 1200rpm → 10Hz', () => near(L.excitationFreq(0.5, 1200), 10));

console.log('FRF 보간');
test('격자점은 그대로', () => near(L.interpolate(TINY.freq, TINY.points[0].mag, 20, 'linear').value, 3));
test('선형: 15Hz → (1+3)/2 = 2', () => near(L.interpolate(TINY.freq, TINY.points[0].mag, 15, 'linear').value, 2));
test('선형: 12.5Hz → 1 + 0.25×2 = 1.5', () => near(L.interpolate(TINY.freq, TINY.points[0].mag, 12.5, 'linear').value, 1.5));
test('가장 가까운 점: 14Hz → 10Hz 값 1, 16Hz → 20Hz 값 3', () => {
  near(L.interpolate(TINY.freq, TINY.points[0].mag, 14, 'nearest').value, 1);
  near(L.interpolate(TINY.freq, TINY.points[0].mag, 16, 'nearest').value, 3);
});
test('가장 가까운 점: 한가운데 15Hz 는 낮은 쪽(1)', () => near(L.interpolate(TINY.freq, TINY.points[0].mag, 15, 'nearest').value, 1));
test('로그 보간: 15Hz → 3^(ln1.5/ln2) = 1.901497', () => near(L.interpolate(TINY.freq, TINY.points[0].mag, 15, 'loglog').value, Math.pow(3, Math.log(1.5) / Math.log(2)), 1e-12));
test('로그 보간: 0Hz·0값 구간은 선형으로 대신', () => {
  const r = L.interpolate(TINY.freq, TINY.points[0].mag, 5, 'loglog');
  near(r.value, 0.5); assert.equal(r.note, 'loglog_fallback_linear');
});
test('범위 밖은 out_of_range', () => {
  assert.equal(L.interpolate(TINY.freq, TINY.points[0].mag, 30.01, 'linear').status, 'out_of_range');
  assert.equal(L.interpolate(TINY.freq, TINY.points[0].mag, -1, 'linear').status, 'out_of_range');
});
test('이웃이 빈 값이면 no_data', () => assert.equal(L.interpolate([0, 10], [1, NaN], 5, 'linear').status, 'no_data'));

console.log('FRF 표 만들기');
test('실수+허수 → 크기 √(3²+4²)=5', () => near(L.magnitudeOf('reim', 3, 4), 5));
test('크기+위상 → 크기는 위상과 무관', () => near(L.magnitudeOf('magphase', -2, 170), 2));
test('열 지정대로 읽고 정렬·중복 처리', () => {
  const rows = [[20, 3, 4], [10, 1, 0], ['x', 9, 9], [10, 7, 7], [0, 0, 0]];
  const r = L.buildFrf(rows, { freqCol: 0, format: 'reim', points: [{ name: 'A', a: 1, b: 2 }] });
  assert.ok(r.ok);
  assert.deepEqual(r.frf.freq, [0, 10, 20]);
  assert.deepEqual(r.frf.points[0].mag, [0, 1, 5]);
  assert.equal(r.skipped, 1);
  assert.equal(r.warnings.length, 3); // 건너뜀·정렬·중복
});
test('두 번째 열 없이 크기+위상이면 오류', () => {
  const r = L.buildFrf([[1, 2, 3]], { freqCol: 0, format: 'magphase', points: [{ name: 'A', a: 1, b: -1 }] });
  assert.equal(r.ok, false);
});
test('열 자동 추정: 크기/위상 짝', () => {
  const g = L.guessMapping(['Frequency [Hz]', 'P1 Mag', 'P1 Phase', 'P2 Mag', 'P2 Phase']);
  assert.equal(g.freqCol, 0); assert.equal(g.format, 'magphase');
  assert.deepEqual(g.points.map(p => [p.name, p.a, p.b]), [['P1', 1, 2], ['P2', 3, 4]]);
});
test('열 자동 추정: 실수/허수 짝', () => {
  const g = L.guessMapping(['주파수', 'A_Real', 'A_Imag']);
  assert.equal(g.format, 'reim'); assert.deepEqual([g.points[0].a, g.points[0].b], [1, 2]);
});
test('머리행 찾기: 제목 줄 건너뜀', () => assert.equal(L.guessHeaderRow([['FRF 결과'], ['Freq', 'P1'], [1, 2], [2, 3]]), 1));

console.log('RPM 목록·차수');
test('800~1000 간격 100 → 3점', () => assert.deepEqual(L.rpmList(800, 1000, 100).list, [800, 900, 1000]));
test('끝값이 간격에 안 맞으면 끝값 추가', () => assert.deepEqual(L.rpmList(800, 950, 100).list, [800, 900, 950]));
test('간격 0 은 오류', () => assert.equal(L.rpmList(800, 900, 0).ok, false));
test('차수 중복은 오류', () => assert.equal(L.validateOrders([{ order: 1, force: 1 }, { order: '1', force: 2 }], true).ok, false));
test('빈 줄은 무시하고 차수 순 정렬', () => {
  const r = L.validateOrders([{ order: 2, force: 1 }, { order: '', force: '' }, { order: 1, force: 3 }], true);
  assert.deepEqual(r.orders, [{ order: 1, force: 3 }, { order: 2, force: 1 }]);
});

console.log('RPM별 응답·overall (원문 참고 1·2)');
// 600rpm: 1차 10Hz |H|=1 ×F1 2 = 2, 2차 20Hz |H|=3 ×F2 1 = 3 → overall √(4+9)=√13
// 900rpm: 1차 15Hz |H|=2 ×2 = 4, 2차 30Hz |H|=2 ×1 = 2 → overall √(16+4)=√20
test('차수 성분과 RSS overall', () => {
  const orders = [{ order: 1, force: 2 }, { order: 2, force: 1 }];
  const r = L.computeResponse(TINY, { rpms: [600, 900], orders, force: { mode: 'const', orders }, interp: 'linear' });
  const [a, b] = r.points[0].rows;
  assert.deepEqual(a.comps.map(c => c.resp), [2, 3]);
  near(a.overall, Math.sqrt(13));
  assert.deepEqual(b.comps.map(c => c.resp), [4, 2]);
  near(b.overall, Math.sqrt(20));
  assert.equal(a.partial, false);
});
test('RSS 는 빈 값 빼고 합침', () => { const r = L.rss([3, null, 4]); near(r.value, 5); assert.equal(r.count, 2); });
test('범위 밖 차수는 빼고 「일부 차수 제외」 + 경고', () => {
  // 1200rpm 2차 = 40Hz > 30Hz → 1차(20Hz, |H|=3 ×2 = 6)만
  const orders = [{ order: 1, force: 2 }, { order: 2, force: 1 }];
  const r = L.computeResponse(TINY, { rpms: [1200], orders, force: { mode: 'const', orders }, interp: 'linear' });
  const row = r.points[0].rows[0];
  near(row.overall, 6); assert.equal(row.partial, true); assert.equal(row.comps[1].status, 'out_of_range');
  assert.equal(r.warnings.length, 1);
});
test('RPM별 가진력 표: RPM 사이 선형 보간', () => {
  // 1차 가진력 600rpm=2, 1200rpm=4 → 900rpm 은 3. 900rpm 1차 15Hz |H|=2 → 6
  const t = L.parseForceTable([['rpm', 'F1'], [1200, 4], [600, 2]].slice(1), { rpmCol: 0, orderCols: [{ order: 1, col: 1 }] });
  assert.ok(t.ok); assert.deepEqual(t.table.rpm, [600, 1200]);
  const orders = [{ order: 1, force: null }];
  const r = L.computeResponse(TINY, { rpms: [900, 1300], orders, force: { mode: 'table', table: t.table }, interp: 'linear' });
  near(r.points[0].rows[0].comps[0].force, 3); near(r.points[0].rows[0].overall, 6);
  assert.equal(r.points[0].rows[1].comps[0].status, 'force_out_of_range');
});

console.log('가진력 추정 (계측 ÷ |FRF|)');
const FRF2 = { freq: [0, 10, 20], points: [{ name: 'A', mag: [1, 2, 2] }, { name: 'B', mag: [1, 4, 4] }] };
test('응답점별 추정과 최소제곱 종합', () => {
  // 600rpm 1차 = 10Hz: A |H|=2, 계측 4 → 2 / B |H|=4, 계측 10 → 2.5 / 종합 (2·4 + 4·10)/(4+16) = 48/20 = 2.4
  const est = L.estimateForce(FRF2, { rows: [{ rpm: 600, order: 1, values: { A: 4, B: 10 } }], points: ['A', 'B'] }, { interp: 'linear', antiRatio: 0 });
  const r = est.rows[0];
  near(r.points[0].force, 2); near(r.points[1].force, 2.5); near(r.ls, 2.4); assert.equal(r.used, 2);
});
test('반공진 경고 응답점은 종합에서 빠짐', () => {
  // B 최대 |H| = 10, 기준 0.5 → 10Hz 의 |H|=1 < 5 이므로 경고. 종합은 A 만: 2·4/4 = 2
  const f = { freq: [0, 10, 20], points: [{ name: 'A', mag: [1, 2, 2] }, { name: 'B', mag: [10, 1, 10] }] };
  const est = L.estimateForce(f, { rows: [{ rpm: 600, order: 1, values: { A: 4, B: 10 } }], points: ['A', 'B'] }, { interp: 'linear', antiRatio: 0.5 });
  assert.equal(est.rows[0].points[1].anti, true); near(est.rows[0].ls, 2); assert.equal(est.rows[0].used, 1);
});
test('추정값을 가진력 표로', () => {
  const est = L.estimateForce(FRF2, { rows: [{ rpm: 600, order: 1, values: { A: 4, B: 8 } }, { rpm: 1200, order: 1, values: { A: 6, B: 12 } }], points: ['A', 'B'] }, { interp: 'linear', antiRatio: 0 });
  const t = L.estimateToForceTable(est);
  assert.deepEqual(t.table.rpm, [600, 1200]); near(t.table.byOrder[1][0], 2); near(t.table.byOrder[1][1], 3);
});
test('계측 표 읽기: RPM·차수 숫자 아닌 행은 건너뜀', () => {
  const m = L.parseMeasured([[600, 1, 4], ['합계', '', 9]], { rpmCol: 0, orderCol: 1, pointCols: { A: 2 } });
  assert.equal(m.rows.length, 1); assert.equal(m.skipped, 1);
});

console.log('내보내기');
test('시트 이름 31자·금지문자·중복 처리', () => {
  const used = {};
  assert.equal(L.sheetName('a/b', used), 'a_b');
  assert.equal(L.sheetName('a/b', used), 'a_b_2');
  assert.equal(L.sheetName('x'.repeat(40), used).length, 31);
});
test('결과 시트: 조건 + 응답점별', () => {
  const orders = [{ order: 1, force: 2 }];
  const r = L.computeResponse(TINY, { rpms: [600], orders, force: { mode: 'const', orders }, interp: 'linear' });
  const s = L.resultToSheets(r, orders, { interp: 'linear', forceMode: 'const', sample: true });
  assert.deepEqual(s.map(x => x.name), ['계산조건', '응답_P1']);
  assert.deepEqual(s[1].rows[1], [600, 10, 1, 2, 2, 2, '']);
  assert.ok(s[0].rows[1][1].includes('예시 데이터'));
});
test('CSV 따옴표 처리', () => assert.equal(L.toCsv([['a,b', 'c"d']]), '﻿"a,b","c""d"\r\n'));

console.log('예시 데이터');
test('예시 FRF 가 표로 읽힘', () => {
  const s = Sample.build();
  const g = L.guessMapping(s.frfRows[0]);
  assert.equal(g.format, 'magphase'); assert.equal(g.points.length, 3);
  const b = L.buildFrf(s.frfRows.slice(1), g);
  assert.ok(b.ok); assert.equal(b.frf.freq.length, s.frfRows.length - 1);
});
test('예시 계측은 예시 가진력으로 만든 값이라 추정값이 그 근처(±5%)', () => {
  const s = Sample.build();
  const b = L.buildFrf(s.frfRows.slice(1), L.guessMapping(s.frfRows[0]));
  const head = s.measRows[0];
  const pc = {}; b.frf.points.forEach(p => { pc[p.name] = head.indexOf(p.name); });
  const m = L.parseMeasured(s.measRows.slice(1), { rpmCol: 0, orderCol: 1, pointCols: pc });
  const est = L.estimateForce(b.frf, m, { interp: 'linear', antiRatio: 0.05 });
  est.rows.forEach(r => {
    const truth = s.trueForce(r.order, r.rpm);
    if (r.ls != null) assert.ok(Math.abs(r.ls / truth - 1) < 0.05, `${r.rpm}rpm ${r.order}차 ${r.ls} vs ${truth}`);
  });
});

console.log('Python 교차 확인');
test('python/rpm_response.py 가 같은 값을 냄', () => {
  let py;
  try { execFileSync('python3', ['--version']); } catch { console.log('       (python3 없음 — 건너뜀)'); return; }
  const out = execFileSync('python3', [path.join(ROOT, 'python', 'rpm_response.py'),
    path.join(ROOT, 'samples', '예시데이터_FRF.csv'), '--orders', '1,2,4', '--forces', '120,60,25',
    '--rpm', '800', '3000', '100', '--interp', 'linear', '--point', '예시_운전석바닥_진동'], { encoding: 'utf8' });
  py = out.trim().split(/\r?\n/).slice(1).map(l => l.split(',').map(Number));
  const s = Sample.build();
  const b = L.buildFrf(s.frfRows.slice(1), L.guessMapping(s.frfRows[0]));
  const orders = [{ order: 1, force: 120 }, { order: 2, force: 60 }, { order: 4, force: 25 }];
  const r = L.computeResponse(b.frf, { rpms: L.rpmList(800, 3000, 100).list, orders, force: { mode: 'const', orders }, interp: 'linear' });
  const js = r.points.find(p => p.name === '예시_운전석바닥_진동').rows;
  assert.equal(py.length, js.length);
  js.forEach((row, i) => { near(py[i][0], row.rpm); near(py[i][py[i].length - 1], row.overall, 1e-6 * Math.max(1, row.overall)); });
});

console.log(`\n${passed}개 통과${process.exitCode ? ' — 실패 있음' : ''}`);

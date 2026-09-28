"""RPM별 응답 계산 — 웹 도구(js/logic.js)와 같은 계산을 파이썬 표준 라이브러리만으로 합니다.

웹 도구 결과를 교차 확인하거나 코랩에서 같은 계산을 돌려 보는 용도입니다.

  가진 주파수 f = 차수 × RPM / 60 (Hz)          (가정: 회전 차수 기준)
  차수 성분     = |FRF(f)| × 가진력               (원문 참고 1)
  overall       = √(Σ 차수 성분²)                 (원문 참고 2, RSS)

실행 예:
  python3 python/rpm_response.py samples/예시데이터_FRF.csv \
      --orders 1,2,4 --forces 120,60,25 --rpm 800 3000 100 --point 예시_운전석바닥_진동

입력 CSV: 첫 행이 머리행, 첫 열이 주파수(Hz).
응답점 열은 「이름」(크기만) / 「이름 Mag」+「이름 Phase」 / 「이름 Real」+「이름 Imag」 중 하나로 찾습니다.
결과는 CSV 로 표준출력에 씁니다(마지막 열이 overall).
"""
import argparse
import csv
import math
import sys


def read_frf(path, point):
    with open(path, encoding="utf-8-sig", newline="") as fp:
        rows = list(csv.reader(fp))
    head = [h.strip() for h in rows[0]]

    def col(name):
        return head.index(name) if name in head else -1

    if col(point) >= 0:
        fmt, a, b = "mag", col(point), -1
    elif col(point + " Mag") >= 0:
        fmt, a, b = "magphase", col(point + " Mag"), col(point + " Phase")
    elif col(point + " Real") >= 0:
        fmt, a, b = "reim", col(point + " Real"), col(point + " Imag")
    else:
        sys.exit("응답점 열을 찾지 못했습니다: " + point)
    recs = {}
    for r in rows[1:]:
        try:
            f = float(r[0])
            va = float(r[a])
            vb = float(r[b]) if b >= 0 else 0.0
        except (ValueError, IndexError):
            continue
        if f in recs:
            continue  # 같은 주파수는 처음 값만 (웹 도구와 같음)
        recs[f] = math.hypot(va, vb) if fmt == "reim" else abs(va)
    freq = sorted(recs)
    return freq, [recs[f] for f in freq]


def interpolate(freq, vals, f, method="linear"):
    if not (freq[0] <= f <= freq[-1]):
        return None
    lo, hi = 0, len(freq) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if freq[mid] <= f:
            lo = mid
        else:
            hi = mid
    if freq[lo] == f:
        return vals[lo]
    if freq[hi] == f:
        return vals[hi]
    f0, f1, v0, v1 = freq[lo], freq[hi], vals[lo], vals[hi]
    if method == "nearest":
        return v0 if f - f0 <= f1 - f else v1
    t = (f - f0) / (f1 - f0)
    if method == "loglog" and f0 > 0 and v0 > 0 and v1 > 0:
        tl = math.log(f / f0) / math.log(f1 / f0)
        return math.exp(math.log(v0) + tl * (math.log(v1) - math.log(v0)))
    return v0 + t * (v1 - v0)


def rpm_list(start, end, step):
    n = int(math.floor((end - start) / step + 1e-9)) + 1
    out = [round(start + i * step, 9) for i in range(n)]
    if round(out[-1], 6) < round(end, 6):
        out.append(end)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("frf_csv")
    ap.add_argument("--point", required=True, help="응답점 이름")
    ap.add_argument("--orders", required=True, help="차수 목록, 예: 1,2,4")
    ap.add_argument("--forces", required=True, help="차수별 가진력, 예: 120,60,25")
    ap.add_argument("--rpm", nargs=3, type=float, required=True, metavar=("시작", "끝", "간격"))
    ap.add_argument("--interp", default="linear", choices=["linear", "nearest", "loglog"])
    a = ap.parse_args()
    orders = [float(x) for x in a.orders.split(",")]
    forces = [float(x) for x in a.forces.split(",")]
    if len(orders) != len(forces):
        sys.exit("차수와 가진력 개수가 다릅니다.")
    freq, mag = read_frf(a.frf_csv, a.point)
    w = csv.writer(sys.stdout, lineterminator="\n")
    w.writerow(["RPM"] + ["%g차 응답" % k for k in orders] + ["overall"])
    for rpm in rpm_list(*a.rpm):
        comps = []
        for k, F in zip(orders, forces):
            h = interpolate(freq, mag, k * rpm / 60.0, a.interp)
            comps.append(None if h is None else h * F)
        s = [c for c in comps if c is not None]
        overall = math.sqrt(sum(c * c for c in s)) if s else ""
        w.writerow(["%g" % rpm] + ["" if c is None else repr(c) for c in comps] + [repr(overall) if s else ""])


if __name__ == "__main__":
    main()

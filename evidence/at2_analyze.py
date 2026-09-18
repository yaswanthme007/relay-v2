"""AT-2 analysis: reads evidence/results/at2_latency.csv (produced by
at2_latency_runner.js's real browser measurements) and computes p50/p90
per mode, comparing against the committed RIME_EVIDENCE.md claim, plus a
histogram of the real trial distributions.

Run: python evidence/at2_analyze.py
"""

import csv
import statistics
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

RESULTS_DIR = Path(__file__).parent / "results"
CSV_PATH = RESULTS_DIR / "at2_latency.csv"
HISTOGRAM_PATH = RESULTS_DIR / "at2_latency_histogram.png"

CLAIM_BASELINE_P50_FLOOR_MS = 1800  # "reduces p50 ... from >1800ms"
CLAIM_TARGET_P50_MS = 250  # "... to <250ms"


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return float("nan")
    values = sorted(values)
    k = (len(values) - 1) * (pct / 100)
    f, c = int(k), min(int(k) + 1, len(values) - 1)
    if f == c:
        return values[f]
    return values[f] + (values[c] - values[f]) * (k - f)


def main() -> None:
    if not CSV_PATH.exists():
        raise SystemExit(f"Missing {CSV_PATH} — run at2_latency_runner.js first")

    rows = list(csv.DictReader(open(CSV_PATH, encoding="utf-8")))
    by_mode: dict[str, list[float]] = {"off": [], "on": []}
    timed_out_count = {"off": 0, "on": 0}
    contaminated_total = 0

    for row in rows:
        mode = row["mode"]
        contaminated_total += int(row.get("contaminated_readings") or 0)
        if row["timed_out"] == "True" or not row["latency_ms"]:
            timed_out_count[mode] += 1
            continue
        by_mode[mode].append(float(row["latency_ms"]))

    print("=" * 70)
    print("AT-2 RESULTS (real browser AudioContext measurements)")
    print("=" * 70)
    summary = {}
    for mode in ("off", "on"):
        vals = by_mode[mode]
        p50 = percentile(vals, 50)
        p90 = percentile(vals, 90)
        summary[mode] = {"n": len(vals), "p50": p50, "p90": p90, "timed_out": timed_out_count[mode]}
        label = "floor-hold OFF" if mode == "off" else "floor-hold ON"
        print(f"\n{label}: n={len(vals)} (timed_out={timed_out_count[mode]})")
        print(f"  p50 = {p50:.1f} ms")
        print(f"  p90 = {p90:.1f} ms")
        if vals:
            print(f"  min = {min(vals):.1f} ms   max = {max(vals):.1f} ms   mean = {statistics.mean(vals):.1f} ms")

    print(f"\nCross-trial contamination readings rejected (see evidence/at2_latency.md): {contaminated_total}")

    print("\n" + "=" * 70)
    print("CLAIM vs MEASURED")
    print("=" * 70)
    off_p50 = summary["off"]["p50"]
    on_p50 = summary["on"]["p50"]
    baseline_claim_pass = off_p50 > CLAIM_BASELINE_P50_FLOOR_MS
    target_claim_pass = on_p50 < CLAIM_TARGET_P50_MS
    print(f"Claim: OFF p50 > {CLAIM_BASELINE_P50_FLOOR_MS}ms   Measured OFF p50 = {off_p50:.1f}ms   {'PASS' if baseline_claim_pass else 'FAIL'}")
    print(f"Claim: ON p50  < {CLAIM_TARGET_P50_MS}ms    Measured ON p50  = {on_p50:.1f}ms    {'PASS' if target_claim_pass else 'FAIL'}")
    if off_p50 and on_p50:
        print(f"Observed reduction: {off_p50 - on_p50:.1f}ms ({(1 - on_p50 / off_p50) * 100:.1f}% reduction)")

    # ---- Histogram ----
    fig, ax = plt.subplots(figsize=(9, 5))
    bins = 20
    if by_mode["off"]:
        ax.hist(by_mode["off"], bins=bins, alpha=0.6, label=f"floor-hold OFF (n={len(by_mode['off'])})", color="#d62728")
    if by_mode["on"]:
        ax.hist(by_mode["on"], bins=bins, alpha=0.6, label=f"floor-hold ON (n={len(by_mode['on'])})", color="#2ca02c")
    ax.axvline(CLAIM_TARGET_P50_MS, color="black", linestyle="--", linewidth=1, label=f"claim target ({CLAIM_TARGET_P50_MS}ms)")
    ax.set_xlabel("End-of-turn -> first audible sample (ms), real AudioContext timing")
    ax.set_ylabel("Trial count")
    ax.set_title("AT-2: Perceived time-to-first-audio — real measured trials")
    ax.legend()
    fig.tight_layout()
    fig.savefig(HISTOGRAM_PATH, dpi=150)
    print(f"\nWrote histogram to {HISTOGRAM_PATH}")


if __name__ == "__main__":
    main()

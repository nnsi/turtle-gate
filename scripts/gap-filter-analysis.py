#!/usr/bin/env python3
"""
Gap filter analysis: Does skipping high-gap days improve OC alpha?

Hypothesis: On days where the overnight gap already moves in the signal
direction, most alpha is consumed. Filtering these out should improve
OC alpha per trade.

Uses existing cached price data from basket-alpha-test.
"""
import pandas as pd
import numpy as np
from scipy import stats
import os
import sys
import importlib.util

# Import PCA_SUB logic from basket-alpha-test
spec = importlib.util.spec_from_file_location(
    "bat", os.path.join(os.path.dirname(__file__), "basket-alpha-test.py")
)
bat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bat)


def load_data():
    cache = "output/_basket_alpha_cache.csv"
    if not os.path.exists(cache):
        print("ERROR: Run basket-alpha-test.py first to create cache")
        sys.exit(1)
    close = pd.read_csv(cache, index_col=0, parse_dates=True)

    # We need Open prices too — fetch or use separate cache
    open_cache = "output/_open_price_cache.csv"
    if os.path.exists(open_cache):
        opens = pd.read_csv(open_cache, index_col=0, parse_dates=True)
    else:
        import yfinance as yf
        all_stocks = list(set(
            bat.US_TICKERS + bat.JP_TICKERS +
            [s for ss in bat.BASKETS_3.values() for s in ss]
        ))
        print(f"Fetching Open prices for {len(all_stocks)} tickers...")
        data = yf.download(all_stocks, start="2010-01-01", end="2025-12-31",
                           auto_adjust=True, progress=True)
        opens = data["Open"]
        if isinstance(opens, pd.Series):
            opens = opens.to_frame()
        opens.index = pd.to_datetime(opens.index)
        os.makedirs("output", exist_ok=True)
        opens.to_csv(open_cache)
        print(f"Cached to {open_cache}")

    return close, opens


def compute_gap_and_oc(results, close_df, open_df):
    """Add gap and OC returns to each result."""
    enriched = []
    for r in results:
        d = r["date"]
        if d not in close_df.index or d not in open_df.index:
            continue

        # Find previous trading day
        loc = close_df.index.get_loc(d)
        if loc == 0:
            continue
        prev_d = close_df.index[loc - 1]

        longs = r["long"]
        shorts = r["short"]

        # ETF gap and OC
        def calc_gap_oc(tickers, close_df, open_df, d, prev_d):
            gaps, ocs = [], []
            for t in tickers:
                if t not in close_df.columns or t not in open_df.columns:
                    continue
                prev_close = close_df.loc[prev_d, t]
                today_open = open_df.loc[d, t]
                today_close = close_df.loc[d, t]
                if pd.isna(prev_close) or pd.isna(today_open) or pd.isna(today_close):
                    continue
                if prev_close <= 0 or today_open <= 0:
                    continue
                gaps.append(np.log(today_open / prev_close))
                ocs.append(np.log(today_close / today_open))
            return (np.mean(gaps) if gaps else np.nan,
                    np.mean(ocs) if ocs else np.nan)

        long_gap, long_oc = calc_gap_oc(longs, close_df, open_df, d, prev_d)
        short_gap, short_oc = calc_gap_oc(shorts, close_df, open_df, d, prev_d)

        if np.isnan(long_gap) or np.isnan(short_gap):
            continue

        strat_gap = long_gap - short_gap  # L/S gap
        strat_oc = long_oc - short_oc      # L/S OC return
        strat_cc = r["etf_return"]          # L/S CC return

        enriched.append({
            **r,
            "strat_gap": strat_gap,
            "strat_oc": strat_oc,
            "strat_cc": strat_cc,
            "oc_cc_ratio": strat_oc / strat_cc if abs(strat_cc) > 1e-8 else np.nan,
            "gap_ratio": strat_gap / strat_cc if abs(strat_cc) > 1e-8 else np.nan,
        })
    return enriched


def analyze(enriched, band_key="band_p90"):
    lines = []
    lines.append("=" * 80)
    lines.append("  Gap Filter Analysis: Can we improve OC alpha by skipping high-gap days?")
    lines.append("=" * 80)

    trade = [r for r in enriched if r[band_key] == "HIGH"
             and not np.isnan(r["strat_oc"])]

    if len(trade) < 20:
        lines.append(f"  Insufficient data: {len(trade)} trade days")
        return "\n".join(lines)

    ocs = np.array([r["strat_oc"] for r in trade])
    ccs = np.array([r["strat_cc"] for r in trade])
    gaps = np.array([r["strat_gap"] for r in trade])

    lines.append(f"\n  {band_key.replace('band_', '').upper()} trade days: {len(trade)}")
    lines.append(f"  Avg CC alpha:  {np.mean(ccs)*10000:.1f} bps")
    lines.append(f"  Avg OC alpha:  {np.mean(ocs)*10000:.1f} bps")
    lines.append(f"  Avg Gap:       {np.mean(gaps)*10000:.1f} bps")
    lines.append(f"  OC/CC ratio:   {np.mean(ocs)/np.mean(ccs):.3f}")

    # Correlation: gap vs OC
    corr_gap_oc = np.corrcoef(gaps, ocs)[0, 1]
    lines.append(f"\n  Correlation (gap vs OC): {corr_gap_oc:.3f}")

    # Split by gap direction alignment with signal
    # Signal direction: if CC > 0, signal was right → gap in same direction is "aligned"
    aligned = [r for r in trade if r["strat_gap"] * r["strat_cc"] > 0]
    opposed = [r for r in trade if r["strat_gap"] * r["strat_cc"] <= 0]

    lines.append(f"\n  --- Gap aligned with signal ({len(aligned)} days) ---")
    if len(aligned) > 5:
        a_oc = np.array([r["strat_oc"] for r in aligned])
        a_cc = np.array([r["strat_cc"] for r in aligned])
        a_gap = np.array([r["strat_gap"] for r in aligned])
        lines.append(f"  CC:  {np.mean(a_cc)*10000:.1f} bps")
        lines.append(f"  Gap: {np.mean(a_gap)*10000:.1f} bps")
        lines.append(f"  OC:  {np.mean(a_oc)*10000:.1f} bps (t={stats.ttest_1samp(a_oc, 0).statistic:.2f})")

    lines.append(f"\n  --- Gap opposed to signal ({len(opposed)} days) ---")
    if len(opposed) > 5:
        o_oc = np.array([r["strat_oc"] for r in opposed])
        o_cc = np.array([r["strat_cc"] for r in opposed])
        o_gap = np.array([r["strat_gap"] for r in opposed])
        lines.append(f"  CC:  {np.mean(o_cc)*10000:.1f} bps")
        lines.append(f"  Gap: {np.mean(o_gap)*10000:.1f} bps")
        lines.append(f"  OC:  {np.mean(o_oc)*10000:.1f} bps (t={stats.ttest_1samp(o_oc, 0).statistic:.2f})")

    # Gap magnitude quintiles
    lines.append(f"\n{'='*80}")
    lines.append("  Gap magnitude quintile analysis")
    lines.append(f"{'='*80}")
    lines.append(f"{'Quintile':>10} {'N':>5} {'Gap(bps)':>10} {'OC(bps)':>10} {'CC(bps)':>10} {'OC/CC':>8}")
    lines.append("-" * 60)

    abs_gaps = np.array([abs(r["strat_gap"]) for r in trade])
    quintile_bounds = np.percentile(abs_gaps, [20, 40, 60, 80])

    for qi in range(5):
        if qi == 0:
            mask = abs_gaps <= quintile_bounds[0]
            label = "Q1 (low)"
        elif qi == 4:
            mask = abs_gaps > quintile_bounds[3]
            label = "Q5 (high)"
        else:
            mask = (abs_gaps > quintile_bounds[qi - 1]) & (abs_gaps <= quintile_bounds[qi])
            label = f"Q{qi + 1}"

        q_trade = [trade[i] for i in range(len(trade)) if mask[i]]
        if len(q_trade) < 3:
            continue
        q_oc = np.mean([r["strat_oc"] for r in q_trade]) * 10000
        q_cc = np.mean([r["strat_cc"] for r in q_trade]) * 10000
        q_gap = np.mean([r["strat_gap"] for r in q_trade]) * 10000
        q_ratio = q_oc / q_cc if abs(q_cc) > 0.1 else float('nan')
        lines.append(f"{label:>10} {len(q_trade):>5} {q_gap:>10.1f} {q_oc:>10.1f} {q_cc:>10.1f} {q_ratio:>8.3f}")

    # Gap filter simulation: skip top N% gap days
    lines.append(f"\n{'='*80}")
    lines.append("  Gap filter simulation: skip days with largest |gap|")
    lines.append(f"{'='*80}")
    lines.append(f"{'Skip%':>8} {'N':>5} {'OC(bps)':>10} {'t-stat':>8} {'AR%':>8} {'MDD%':>8}")
    lines.append("-" * 55)

    for skip_pct in [0, 10, 20, 30, 40, 50]:
        if skip_pct == 0:
            filtered = trade
        else:
            threshold = np.percentile(abs_gaps, 100 - skip_pct)
            filtered = [trade[i] for i in range(len(trade)) if abs_gaps[i] <= threshold]

        if len(filtered) < 10:
            continue
        f_oc = np.array([r["strat_oc"] for r in filtered])
        alpha = np.mean(f_oc) * 10000
        t = stats.ttest_1samp(f_oc, 0).statistic
        ar = np.mean(f_oc) * 252 * 100
        cum = np.cumsum(f_oc)
        mdd = np.min(cum - np.maximum.accumulate(cum)) * 100
        lines.append(f"{skip_pct:>7}% {len(filtered):>5} {alpha:>10.1f} {t:>8.2f} {ar:>8.1f} {mdd:>8.1f}")

    # Alternative: skip aligned-gap days only (gap in signal direction)
    lines.append(f"\n{'='*80}")
    lines.append("  Alternative: skip only aligned-gap days (gap confirms signal)")
    lines.append(f"{'='*80}")
    lines.append(f"{'Skip%':>8} {'N':>5} {'OC(bps)':>10} {'t-stat':>8} {'AR%':>8}")
    lines.append("-" * 45)

    aligned_gaps = np.array([r["strat_gap"] if r["strat_gap"] * r["strat_cc"] > 0
                             else 0.0 for r in trade])
    for skip_pct in [0, 10, 20, 30]:
        if skip_pct == 0:
            filtered = trade
        else:
            threshold = np.percentile(aligned_gaps[aligned_gaps > 0], 100 - skip_pct) \
                if np.sum(aligned_gaps > 0) > 5 else float('inf')
            filtered = [trade[i] for i in range(len(trade)) if aligned_gaps[i] <= threshold]

        if len(filtered) < 10:
            continue
        f_oc = np.array([r["strat_oc"] for r in filtered])
        alpha = np.mean(f_oc) * 10000
        t = stats.ttest_1samp(f_oc, 0).statistic
        ar = np.mean(f_oc) * 252 * 100
        lines.append(f"{skip_pct:>7}% {len(filtered):>5} {alpha:>10.1f} {t:>8.2f} {ar:>8.1f}")

    return "\n".join(lines)


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "output/gap-filter-report.txt"
    close, opens = load_data()

    # Run PCA_SUB backtest (reuse from basket-alpha-test)
    print("Running PCA_SUB backtest...")
    results = bat.run_backtest(close)
    print(f"Generated {len(results)} day results")

    # Enrich with gap/OC data
    print("Computing gap and OC returns...")
    enriched = compute_gap_and_oc(results, close, opens)
    print(f"Enriched {len(enriched)} days with gap/OC data")

    # Analyze
    report = analyze(enriched, "band_p90")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"\nReport saved to {out_path}")
    print(report)


if __name__ == "__main__":
    main()

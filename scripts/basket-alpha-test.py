#!/usr/bin/env python3
"""
A-3 decisive test: PCA_SUB alpha survival in individual stock baskets.

Signal generation uses ETF data (as in production).
Returns are measured using both ETF and basket execution.
If basket alpha is positive and significant, the basket strategy is viable
regardless of tracking error.

Output: output/basket-alpha-report.txt
"""
import pandas as pd
import numpy as np
from scipy import stats
import os
import sys

# ─── Config ───────────────────────────────────────────────────────────────
US_TICKERS = ["XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"]
JP_TICKERS = [
    "1617.T", "1618.T", "1619.T", "1620.T", "1621.T", "1622.T", "1623.T",
    "1624.T", "1625.T", "1626.T", "1627.T", "1628.T", "1629.T", "1630.T",
    "1631.T", "1632.T", "1633.T",
]
JP_NAMES = {
    "1617.T": "食品", "1618.T": "エネ", "1619.T": "建設", "1620.T": "素材",
    "1621.T": "医薬", "1622.T": "自動", "1623.T": "鉄鋼", "1624.T": "機械",
    "1625.T": "電機", "1626.T": "情通", "1627.T": "電ガ", "1628.T": "運輸",
    "1629.T": "商社", "1630.T": "小売", "1631.T": "銀行", "1632.T": "金融",
    "1633.T": "不産",
}

US_CYCLICAL = ["XLB", "XLE", "XLF", "XLRE"]
US_DEFENSIVE = ["XLK", "XLP", "XLU", "XLV"]
JP_CYCLICAL = ["1618.T", "1625.T", "1629.T", "1631.T"]
JP_DEFENSIVE = ["1617.T", "1621.T", "1627.T", "1630.T"]

# Basket definitions (top 3, equal weight for simplicity — we test cap-weight too)
BASKETS_3 = {
    "1617.T": ["2914.T", "2802.T", "2502.T"],
    "1618.T": ["5020.T", "1605.T", "5019.T"],
    "1619.T": ["1925.T", "1928.T", "1812.T"],
    "1620.T": ["4063.T", "4901.T", "4452.T"],
    "1621.T": ["4502.T", "4568.T", "4519.T"],
    "1622.T": ["7203.T", "7267.T", "6902.T"],
    "1623.T": ["5401.T", "5802.T", "5803.T"],
    "1624.T": ["7011.T", "6301.T", "6367.T"],
    "1625.T": ["6758.T", "6501.T", "8035.T"],
    "1626.T": ["7974.T", "6098.T", "9984.T"],
    "1627.T": ["9531.T", "9503.T", "9532.T"],
    "1628.T": ["9020.T", "9022.T", "9101.T"],
    "1629.T": ["8058.T", "8001.T", "8031.T"],
    "1630.T": ["9983.T", "3382.T", "8267.T"],
    "1631.T": ["8306.T", "8316.T", "8411.T"],
    "1632.T": ["8766.T", "8725.T", "8630.T"],
    "1633.T": ["8801.T", "8802.T", "8830.T"],
}

L = 60   # rolling window
K = 3    # principal components
LAMBDA = 0.9
Q = 0.3  # long/short quantile

SIGNAL_START = "2015-01-01"  # exclude Cfull period


# ─── PCA_SUB Implementation ──────────────────────────────────────────────

def build_prior_subspace(us_tickers, jp_tickers):
    """Build 3 prior direction vectors (global, country-spread, cyclical-defensive)."""
    n_us = len(us_tickers)
    n_jp = len(jp_tickers)
    n = n_us + n_jp

    # v1: global (all equal)
    v1 = np.ones(n) / np.sqrt(n)

    # v2: US positive, JP negative, orthogonal to v1
    v2 = np.zeros(n)
    v2[:n_us] = 1.0
    v2[n_us:] = -1.0
    v2 = v2 - np.dot(v2, v1) * v1
    v2 = v2 / np.linalg.norm(v2)

    # v3: cyclical positive, defensive negative, orthogonal to v1, v2
    v3 = np.zeros(n)
    all_tickers = list(us_tickers) + list(jp_tickers)
    for i, t in enumerate(all_tickers):
        if t in US_CYCLICAL or t in JP_CYCLICAL:
            v3[i] = 1.0
        elif t in US_DEFENSIVE or t in JP_DEFENSIVE:
            v3[i] = -1.0
    v3 = v3 - np.dot(v3, v1) * v1 - np.dot(v3, v2) * v2
    norm = np.linalg.norm(v3)
    if norm > 1e-10:
        v3 = v3 / norm
    else:
        v3 = np.zeros(n)

    V = np.column_stack([v1, v2, v3])
    return V


def generate_signals_for_date(window_returns, us_today_ret, us_tickers, jp_tickers):
    """
    Generate JP sector signals for one date.
    window_returns: (L, n_us+n_jp) standardized returns
    us_today_ret: (n_us,) standardized US returns for signal date
    Returns: dict of jp_ticker -> signal value
    """
    n_us = len(us_tickers)
    n_jp = len(jp_tickers)
    n = n_us + n_jp

    if window_returns.shape[0] < L or window_returns.shape[1] != n:
        return None

    # Correlation matrix
    Ct = np.corrcoef(window_returns.T)
    if np.any(np.isnan(Ct)):
        return None

    # Prior subspace
    V = build_prior_subspace(us_tickers, jp_tickers)
    C0 = V @ V.T

    # Regularize
    Creg = (1 - LAMBDA) * Ct + LAMBDA * C0

    # Eigendecomposition
    eigenvalues, eigenvectors = np.linalg.eigh(Creg)
    # Sort descending
    idx = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[idx]
    eigenvectors = eigenvectors[:, idx]

    # Top K
    Vk = eigenvectors[:, :K]  # (n, K)

    # Split US/JP blocks
    Us_block = Vk[:n_us, :]   # (n_us, K)
    Jp_block = Vk[n_us:, :]   # (n_jp, K)

    # Factor scores from US returns
    factor_scores = Us_block.T @ us_today_ret  # (K,)

    # JP signals
    jp_signals = Jp_block @ factor_scores  # (n_jp,)

    return {jp_tickers[i]: jp_signals[i] for i in range(n_jp)}


def run_backtest(close_df, basket_returns_df=None):
    """
    Run PCA_SUB backtest.
    Returns list of day results with ETF returns and optionally basket returns.
    """
    all_tickers = list(US_TICKERS) + list(JP_TICKERS)

    # Filter to available tickers
    avail_us = [t for t in US_TICKERS if t in close_df.columns]
    avail_jp = [t for t in JP_TICKERS if t in close_df.columns]

    if len(avail_us) < 8 or len(avail_jp) < 14:
        print(f"ERROR: Not enough tickers (US={len(avail_us)}, JP={len(avail_jp)})")
        return []

    avail_all = avail_us + avail_jp
    cc_returns = np.log(close_df[avail_all] / close_df[avail_all].shift(1))
    cc_returns = cc_returns.dropna(how="all")

    dates = cc_returns.index
    results = []

    # Signal range history for percentile calculation
    signal_ranges = []

    for i in range(L + 10, len(dates)):
        d = dates[i]
        if str(d.date()) < SIGNAL_START:
            continue

        # Rolling window: take last L*2 rows and drop NaN rows to get clean window
        lookback = min(i, L * 2)
        raw_window = cc_returns.iloc[i - lookback:i][avail_all]

        # Drop rows with any NaN (holiday misalignment)
        clean = raw_window.dropna()
        if len(clean) < L:
            continue

        # Take last L rows
        clean = clean.iloc[-L:]
        w = clean.values

        valid_us = avail_us
        valid_jp = avail_jp

        # Standardize
        mu = w.mean(axis=0)
        sigma = w.std(axis=0)
        sigma[sigma < 1e-10] = 1.0
        w_std = (w - mu) / sigma

        # US returns for signal date (most recent US trading day before date i)
        # Find last row in cc_returns before i where US tickers have data
        us_ret_raw = None
        for j in range(i - 1, max(i - 5, 0), -1):
            row = cc_returns.iloc[j][avail_us]
            if not row.isna().any():
                us_ret_raw = row.values
                break
        if us_ret_raw is None:
            continue

        us_ret_std = (us_ret_raw - mu[:len(valid_us)]) / sigma[:len(valid_us)]

        signals = generate_signals_for_date(w_std, us_ret_std, valid_us, valid_jp)
        if signals is None:
            continue

        # Select long/short candidates
        jp_signals = [(t, signals[t]) for t in valid_jp if t in signals]
        jp_signals.sort(key=lambda x: x[1], reverse=True)

        n_select = max(1, int(len(jp_signals) * Q))
        long_candidates = [t for t, _ in jp_signals[:n_select]]
        short_candidates = [t for t, _ in jp_signals[-n_select:]]

        # Signal range
        long_avg = np.mean([signals[t] for t in long_candidates])
        short_avg = np.mean([signals[t] for t in short_candidates])
        signal_range = long_avg - short_avg
        signal_ranges.append(signal_range)

        # CC return for JP tickers on signal date (day i)
        jp_cc = cc_returns.iloc[i]

        # ETF strategy return
        long_ret_etf = np.mean([jp_cc[t] for t in long_candidates if t in jp_cc.index and not np.isnan(jp_cc[t])])
        short_ret_etf = np.mean([jp_cc[t] for t in short_candidates if t in jp_cc.index and not np.isnan(jp_cc[t])])
        strat_ret_etf = long_ret_etf - short_ret_etf

        # Basket strategy return
        strat_ret_basket = np.nan
        if basket_returns_df is not None:
            d_str = str(d.date()) if hasattr(d, 'date') else str(d)
            if d in basket_returns_df.index:
                bask_row = basket_returns_df.loc[d]
                long_ret_bask = np.nanmean([bask_row[t] for t in long_candidates if t in bask_row.index])
                short_ret_bask = np.nanmean([bask_row[t] for t in short_candidates if t in bask_row.index])
                strat_ret_basket = long_ret_bask - short_ret_bask

        results.append({
            "date": d,
            "signal_range": signal_range,
            "etf_return": strat_ret_etf,
            "basket_return": strat_ret_basket,
            "n_long": len(long_candidates),
            "n_short": len(short_candidates),
            "long": long_candidates,
            "short": short_candidates,
        })

    # Apply confidence filter (expanding window percentile)
    for i, r in enumerate(results):
        past_ranges = [results[j]["signal_range"] for j in range(i + 1)]
        for pct in [90, 80, 75, 65]:
            r[f"p{pct}_threshold"] = np.percentile(past_ranges, pct)
        r["band_p90"] = "HIGH" if r["signal_range"] >= r["p90_threshold"] else \
                        "MED" if r["signal_range"] >= r["p80_threshold"] else "LOW"
        r["band_p75"] = "HIGH" if r["signal_range"] >= r["p75_threshold"] else "LOW"
        r["band_p65"] = "HIGH" if r["signal_range"] >= r["p65_threshold"] else "LOW"

    return results


def compute_stats(returns, label):
    """Compute strategy statistics from daily returns."""
    returns = np.array([r for r in returns if not np.isnan(r)])
    if len(returns) < 10:
        return {"label": label, "n": len(returns), "alpha_bps": 0, "t_stat": 0,
                "ar": 0, "risk": 0, "rr": 0, "mdd": 0}

    alpha_bps = np.mean(returns) * 10000
    t_stat = stats.ttest_1samp(returns, 0).statistic
    ar = np.mean(returns) * 252 * 100  # annualized %
    risk = np.std(returns) * np.sqrt(252) * 100
    rr = ar / risk if risk > 0 else 0

    # MDD
    cum = np.cumsum(returns)
    peak = np.maximum.accumulate(cum)
    dd = cum - peak
    mdd = np.min(dd) * 100

    return {"label": label, "n": len(returns), "alpha_bps": alpha_bps,
            "t_stat": t_stat, "ar": ar, "risk": risk, "rr": rr, "mdd": mdd}


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "output/basket-alpha-report.txt"
    cache_path = "output/_basket_te_cache.csv"

    alpha_cache = "output/_basket_alpha_cache.csv"
    if os.path.exists(alpha_cache):
        print("Loading cached price data...")
        close = pd.read_csv(alpha_cache, index_col=0, parse_dates=True)
    else:
        import yfinance as yf
        # Need US ETFs + JP ETFs + individual stocks
        all_stocks = []
        for stocks in BASKETS_3.values():
            all_stocks.extend(stocks)
        all_tickers = list(set(US_TICKERS + JP_TICKERS + all_stocks))
        print(f"Fetching {len(all_tickers)} tickers (US+JP ETFs + stocks)...")
        data = yf.download(all_tickers, start="2010-01-01", end="2025-12-31",
                           auto_adjust=True, progress=True)
        close = data["Close"]
        if isinstance(close, pd.Series):
            close = close.to_frame()
        close.index = pd.to_datetime(close.index)
        os.makedirs("output", exist_ok=True)
        close.to_csv(alpha_cache)
        print(f"Cached to {alpha_cache}")

    print(f"Data: {len(close)} rows x {len(close.columns)} tickers")

    # Compute basket CC returns (equal-weight 3 stocks)
    cc_all = np.log(close / close.shift(1))
    basket_cc = pd.DataFrame(index=cc_all.index)
    for etf, stocks in BASKETS_3.items():
        avail = [s for s in stocks if s in cc_all.columns]
        if len(avail) >= 2:
            basket_cc[etf] = cc_all[avail].mean(axis=1)

    print(f"Basket CC returns for {len(basket_cc.columns)} sectors")

    # Run backtest
    print("\nRunning PCA_SUB backtest...")
    results = run_backtest(close, basket_cc)
    print(f"Generated {len(results)} day results")

    if not results:
        print("ERROR: No results generated")
        sys.exit(1)

    # ─── Analysis ─────────────────────────────────────────────────────
    lines = []
    lines.append("=" * 90)
    lines.append("  PCA_SUB Alpha Survival Test: ETF vs Individual Stock Basket")
    lines.append("  Signal: PCA_SUB (ETF-based, unchanged)")
    lines.append("  Execution: ETF CC returns vs EW-3 basket CC returns")
    lines.append(f"  Period: {results[0]['date'].date()} to {results[-1]['date'].date()}")
    lines.append(f"  Total signal days: {len(results)}")
    lines.append("=" * 90)

    # Compare at different filter levels
    for band_key, band_label in [("band_p90", "P90"), ("band_p75", "P75"), ("band_p65", "P65")]:
        trade_days = [r for r in results if r[band_key] == "HIGH"]
        non_trade = [r for r in results if r[band_key] != "HIGH"]

        etf_trade = [r["etf_return"] for r in trade_days]
        bask_trade = [r["basket_return"] for r in trade_days]
        etf_nontrade = [r["etf_return"] for r in non_trade]
        bask_nontrade = [r["basket_return"] for r in non_trade]

        s_etf = compute_stats(etf_trade, f"ETF {band_label}")
        s_bask = compute_stats(bask_trade, f"Basket {band_label}")
        s_etf_nt = compute_stats(etf_nontrade, f"ETF non-{band_label}")
        s_bask_nt = compute_stats(bask_nontrade, f"Basket non-{band_label}")

        lines.append(f"\n{'─'*90}")
        lines.append(f"  Filter: {band_label}  (trade days: {len(trade_days)}, "
                      f"~{len(trade_days)/len(results)*100:.0f}%)")
        lines.append(f"{'─'*90}")
        lines.append(f"{'':>20} {'N':>6} {'α(bps)':>8} {'t-stat':>8} {'AR%':>8} {'Risk%':>8} {'R/R':>6} {'MDD%':>8}")
        lines.append("-" * 90)

        for s in [s_etf, s_bask, s_etf_nt, s_bask_nt]:
            lines.append(
                f"{s['label']:>20} {s['n']:>6} {s['alpha_bps']:>8.1f} {s['t_stat']:>8.2f} "
                f"{s['ar']:>8.1f} {s['risk']:>8.1f} {s['rr']:>6.2f} {s['mdd']:>8.1f}"
            )

        # Alpha retention ratio
        if s_etf["alpha_bps"] > 0:
            retention = s_bask["alpha_bps"] / s_etf["alpha_bps"] * 100
            lines.append(f"\n  Alpha retention: {retention:.0f}% (basket / ETF)")
        else:
            lines.append(f"\n  Alpha retention: N/A (ETF alpha <= 0)")

        # Correlation between daily ETF and basket strategy returns
        paired = [(r["etf_return"], r["basket_return"]) for r in trade_days
                  if not np.isnan(r["etf_return"]) and not np.isnan(r["basket_return"])]
        if len(paired) > 10:
            etf_r, bask_r = zip(*paired)
            corr = np.corrcoef(etf_r, bask_r)[0, 1]
            lines.append(f"  Strategy return correlation (ETF vs Basket): {corr:.4f}")

    # ─── Go/No-Go ─────────────────────────────────────────────────────
    trade_p90 = [r for r in results if r["band_p90"] == "HIGH"]
    bask_p90 = [r["basket_return"] for r in trade_p90 if not np.isnan(r["basket_return"])]
    bask_alpha = np.mean(bask_p90) * 10000 if bask_p90 else 0
    bask_t = stats.ttest_1samp(bask_p90, 0).statistic if len(bask_p90) > 10 else 0

    lines.append(f"\n{'='*90}")
    lines.append("  VERDICT")
    lines.append(f"{'='*90}")
    lines.append(f"  Basket P90 alpha: {bask_alpha:.1f} bps/day (t={bask_t:.2f})")

    if bask_alpha > 15 and bask_t > 2.0:
        lines.append("  --> ALPHA SURVIVES. Basket execution is viable.")
        lines.append("     Proceed with individual stock basket strategy.")
    elif bask_alpha > 5 and bask_t > 1.5:
        lines.append("  --> ALPHA WEAKENED but present. Marginal viability.")
        lines.append("     Consider: need PTS improvement to offset higher noise.")
    else:
        lines.append("  --> ALPHA DOES NOT SURVIVE. Basket execution destroys the signal.")
        lines.append("     Abandon basket approach. Stay with ETF execution.")

    report = "\n".join(lines)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"\nReport saved to {out_path}")
    print(report)


if __name__ == "__main__":
    main()

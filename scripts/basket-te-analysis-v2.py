#!/usr/bin/env python3
"""
A-3: バスケットTE検証 v2
均等加重3銘柄 / 時価総額加重3銘柄 / 時価総額加重5銘柄 の3パターンで比較。

出力: output/basket-te-report.txt
"""
import yfinance as yf
import pandas as pd
import numpy as np
import sys
import os

# TOPIX-17 ETF -> 個別株バスケット
# weights: ETF構成比から正規化（上位銘柄のみなので合計1.0に再正規化）
SECTOR_BASKETS = {
    "1617.T": {
        "name": "食品",
        "stocks5": [
            ("2914.T", 21.3), ("2802.T", 14.4), ("2502.T", 9.9),
            ("2503.T", 6.8), ("2875.T", 3.7),
        ],
    },
    "1618.T": {
        "name": "エネルギー",
        "stocks5": [
            ("5020.T", 39.8), ("1605.T", 31.5), ("5019.T", 13.9),
            ("5021.T", 7.5), ("1662.T", 2.9),
        ],
    },
    "1619.T": {
        "name": "建設・資材",
        "stocks5": [
            ("1925.T", 10.8), ("1928.T", 7.0), ("1812.T", 6.0),
            ("1801.T", 5.5), ("1802.T", 5.2),
        ],
    },
    "1620.T": {
        "name": "素材・化学",
        "stocks5": [
            ("4063.T", 19.7), ("4901.T", 8.8), ("4452.T", 7.3),
            ("6988.T", 4.1), ("3402.T", 3.4),
        ],
    },
    "1621.T": {
        "name": "医薬品",
        "stocks5": [
            ("4502.T", 25.4), ("4568.T", 14.2), ("4519.T", 15.0),
            ("4503.T", 10.3), ("4578.T", 5.0),
        ],
    },
    "1622.T": {
        "name": "自動車",
        "stocks5": [
            ("7203.T", 44.8), ("7267.T", 11.2), ("6902.T", 6.5),
            ("5108.T", 5.9), ("7269.T", 4.8),
        ],
    },
    "1623.T": {
        "name": "鉄鋼・非鉄",
        "stocks5": [
            ("5401.T", 21.2), ("5802.T", 16.4), ("5803.T", 12.4),
            ("5411.T", 7.8), ("5713.T", 6.9),
        ],
    },
    "1624.T": {
        "name": "機械",
        "stocks5": [
            ("7011.T", 25.7), ("6301.T", 9.5), ("6367.T", 9.0),
            ("6146.T", 8.4), ("6273.T", 6.0),
        ],
    },
    "1625.T": {
        "name": "電機・精密",
        "stocks5": [
            ("6758.T", 16.0), ("6501.T", 13.4), ("8035.T", 7.3),
            ("6861.T", 7.2), ("6857.T", 4.2),
        ],
    },
    "1626.T": {
        "name": "情報通信",
        "stocks5": [
            ("7974.T", 13.5), ("6098.T", 10.0), ("9984.T", 8.0),
            ("9432.T", 7.5), ("9433.T", 5.5),
        ],
    },
    "1627.T": {
        "name": "電気・ガス",
        "stocks5": [
            ("9531.T", 17.5), ("9503.T", 16.9), ("9532.T", 14.5),
            ("9502.T", 13.3), ("9501.T", 8.2),
        ],
    },
    "1628.T": {
        "name": "運輸・物流",
        "stocks5": [
            ("9020.T", 12.0), ("9022.T", 8.7), ("9101.T", 7.1),
            ("9104.T", 6.4), ("9021.T", 5.7),
        ],
    },
    "1629.T": {
        "name": "商社・卸売",
        "stocks5": [
            ("8058.T", 20.4), ("8001.T", 19.4), ("8031.T", 16.2),
            ("8002.T", 9.2), ("8053.T", 8.6),
        ],
    },
    "1630.T": {
        "name": "小売",
        "stocks5": [
            ("9983.T", 17.8), ("3382.T", 13.7), ("8267.T", 9.6),
            ("7532.T", 5.3), ("9843.T", 5.0),
        ],
    },
    "1631.T": {
        "name": "銀行",
        "stocks5": [
            ("8306.T", 31.3), ("8316.T", 21.3), ("8411.T", 17.0),
            ("7182.T", 5.3), ("8308.T", 3.9),
        ],
    },
    "1632.T": {
        "name": "金融(除銀行)",
        "stocks5": [
            ("8766.T", 26.9), ("8725.T", 10.9), ("8630.T", 9.2),
            ("8750.T", 9.2), ("8591.T", 8.6),
        ],
    },
    "1633.T": {
        "name": "不動産",
        "stocks5": [
            ("8801.T", 25.3), ("8802.T", 20.3), ("8830.T", 11.9),
            ("1878.T", 7.1), ("3003.T", 4.5),
        ],
    },
}

START = "2015-01-01"
END = "2025-12-31"


def fetch_all_data():
    etfs = list(SECTOR_BASKETS.keys())
    stocks = []
    for v in SECTOR_BASKETS.values():
        for ticker, _ in v["stocks5"]:
            stocks.append(ticker)
    all_tickers = list(set(etfs + stocks))

    print(f"Fetching {len(all_tickers)} tickers from {START} to {END}...")
    data = yf.download(all_tickers, start=START, end=END, auto_adjust=True, progress=True)

    close = data["Close"]
    if isinstance(close, pd.Series):
        close = close.to_frame()
    close.index = pd.to_datetime(close.index)

    # Cache to CSV for re-runs
    cache_path = "output/_basket_te_cache.csv"
    os.makedirs("output", exist_ok=True)
    close.to_csv(cache_path)
    print(f"Cached to {cache_path}")
    return close


def load_cached():
    cache_path = "output/_basket_te_cache.csv"
    if os.path.exists(cache_path):
        print(f"Loading cached data from {cache_path}")
        close = pd.read_csv(cache_path, index_col=0, parse_dates=True)
        return close
    return None


def compute_returns(close: pd.DataFrame) -> pd.DataFrame:
    return np.log(close / close.shift(1)).dropna(how="all")


def compute_basket_returns(returns: pd.DataFrame, n_stocks: int, use_capweight: bool) -> pd.DataFrame:
    basket_rets = {}
    for etf, info in SECTOR_BASKETS.items():
        entries = info["stocks5"][:n_stocks]
        tickers = [t for t, _ in entries]
        weights_raw = [w for _, w in entries]

        available = [(t, w) for t, w in zip(tickers, weights_raw) if t in returns.columns]
        if len(available) < 2:
            continue

        avail_tickers = [t for t, _ in available]
        if use_capweight:
            avail_weights = np.array([w for _, w in available])
            avail_weights = avail_weights / avail_weights.sum()
            basket_rets[etf] = (returns[avail_tickers] * avail_weights).sum(axis=1)
        else:
            basket_rets[etf] = returns[avail_tickers].mean(axis=1)

    return pd.DataFrame(basket_rets)


def analyze_sector(etf_ret: pd.Series, basket_ret: pd.Series, name: str) -> dict:
    combined = pd.DataFrame({"etf": etf_ret, "basket": basket_ret}).dropna()
    if len(combined) < 100:
        return {"name": name, "n_days": len(combined), "corr": np.nan,
                "te_annual": np.nan, "max_divergence": np.nan, "mean_diff_bps": np.nan}

    corr = combined["etf"].corr(combined["basket"])
    diff = combined["basket"] - combined["etf"]
    te_daily = diff.std()
    te_annual = te_daily * np.sqrt(252) * 100
    max_div = diff.abs().max() * 100
    mean_diff_bps = diff.mean() * 10000

    return {
        "name": name,
        "n_days": len(combined),
        "corr": corr,
        "te_annual": te_annual,
        "max_divergence": max_div,
        "mean_diff_bps": mean_diff_bps,
    }


def run_variant(returns, label, n_stocks, use_capweight):
    """1つのバスケット構成パターンを分析"""
    basket_returns = compute_basket_returns(returns, n_stocks, use_capweight)
    results = []
    for etf, info in SECTOR_BASKETS.items():
        if etf not in returns.columns or etf not in basket_returns.columns:
            continue
        r = analyze_sector(returns[etf], basket_returns[etf], info["name"])
        r["etf"] = etf
        results.append(r)
    return results


def format_table(results, label):
    lines = []
    lines.append(f"\n{'='*85}")
    lines.append(f"  {label}")
    lines.append(f"{'='*85}")
    lines.append(f"{'ETF':>8} {'Sector':<14} {'Days':>5} {'Corr':>7} {'TE%':>7} {'MaxDiv%':>8} {'DiffBps':>8} {'Result':<6}")
    lines.append("-" * 85)

    pass_count = 0
    warn_count = 0
    corr_sum = 0
    te_sum = 0
    n = 0

    for r in results:
        if np.isnan(r["corr"]):
            verdict = "N/A"
        elif r["corr"] >= 0.95 and r["te_annual"] <= 8.0:
            verdict = "PASS+"
            pass_count += 1
        elif r["corr"] >= 0.90 and r["te_annual"] <= 10.0:
            verdict = "PASS"
            pass_count += 1
        elif r["corr"] >= 0.85:
            verdict = "WARN"
            warn_count += 1
        else:
            verdict = "FAIL"

        lines.append(
            f"{r['etf']:>8} {r['name']:<14} {r['n_days']:>5} "
            f"{r['corr']:>7.4f} {r['te_annual']:>7.2f} {r['max_divergence']:>8.2f} "
            f"{r['mean_diff_bps']:>8.1f} {verdict:<6}"
        )
        if not np.isnan(r["corr"]):
            corr_sum += r["corr"]
            te_sum += r["te_annual"]
            n += 1

    lines.append("-" * 85)
    if n > 0:
        lines.append(f"  Average:  corr={corr_sum/n:.4f}  TE={te_sum/n:.2f}%")
    lines.append(f"  PASS (corr>=0.90 & TE<=10%): {pass_count}/{len(results)}")
    lines.append(f"  WARN (corr>=0.85): {warn_count}/{len(results)}")
    lines.append(f"  PASS+WARN: {pass_count + warn_count}/{len(results)}")
    return "\n".join(lines), pass_count, warn_count


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "output/basket-te-report.txt"

    # Try cache first
    close = load_cached()
    if close is None:
        close = fetch_all_data()

    print(f"Data: {len(close)} rows x {len(close.columns)} tickers")
    print(f"Range: {close.index[0].date()} to {close.index[-1].date()}")

    returns = compute_returns(close)

    # Run 3 variants
    variants = [
        ("EW-3: Equal-weight top 3 stocks", 3, False),
        ("CW-3: Cap-weight top 3 stocks", 3, True),
        ("CW-5: Cap-weight top 5 stocks", 5, True),
    ]

    all_output = []
    all_output.append("=" * 85)
    all_output.append("  Basket TE Analysis: EW-3 vs CW-3 vs CW-5  (2015-2025, CC returns)")
    all_output.append("=" * 85)

    summary = []
    for label, n, cw in variants:
        print(f"\n--- {label} ---")
        results = run_variant(returns, label, n, cw)
        table_str, p_count, w_count = format_table(results, label)
        all_output.append(table_str)
        summary.append((label, p_count, w_count, results))

        # Print to console
        for r in results:
            print(f"  {r['etf']} {r['name']:<10}: corr={r['corr']:.4f}  TE={r['te_annual']:.2f}%")

    # Comparison summary
    all_output.append(f"\n{'='*85}")
    all_output.append("  Variant Comparison")
    all_output.append(f"{'='*85}")
    all_output.append(f"{'Variant':<35} {'PASS':>5} {'WARN':>5} {'P+W':>5} {'Avg Corr':>9} {'Avg TE%':>8}")
    all_output.append("-" * 85)
    for label, p, w, results in summary:
        corrs = [r["corr"] for r in results if not np.isnan(r["corr"])]
        tes = [r["te_annual"] for r in results if not np.isnan(r["te_annual"])]
        avg_corr = np.mean(corrs) if corrs else 0
        avg_te = np.mean(tes) if tes else 0
        all_output.append(f"{label:<35} {p:>5} {w:>5} {p+w:>5} {avg_corr:>9.4f} {avg_te:>8.2f}")

    # Go/No-Go
    best_label, best_pass, best_warn, best_results = max(summary, key=lambda x: x[1])
    all_output.append(f"\n{'='*85}")
    all_output.append("  Go/No-Go Assessment")
    all_output.append(f"{'='*85}")
    all_output.append(f"  Best variant: {best_label}")
    all_output.append(f"  PASS sectors: {best_pass}/17  (threshold: 12)")
    all_output.append(f"  PASS+WARN:    {best_pass + best_warn}/17")
    if best_pass >= 12:
        all_output.append("  --> GO: Proceed to Phase B")
    elif best_pass + best_warn >= 12:
        all_output.append("  --> CONDITIONAL GO: Enough sectors with WARN relaxation (corr>=0.85)")
        all_output.append("     Consider relaxing Go/No-Go criteria or increasing stock count")
    else:
        all_output.append("  --> NO-GO with current basket construction")
        all_output.append("     Individual stock baskets do not track ETFs well enough")
        all_output.append("     Options: (a) more stocks per basket  (b) accept higher TE as cost of PTS access")
        all_output.append("     (c) reframe: test PCA_SUB alpha directly on baskets rather than requiring ETF tracking")

    report = "\n".join(all_output)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"\n\nReport saved to {out_path}")
    print(report)


if __name__ == "__main__":
    main()

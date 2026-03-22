#!/usr/bin/env python3
"""
A-3: バスケットTE検証
ETFリターンと個別株バスケットリターンの相関・トラッキングエラーを計測する。

出力: output/basket-te-report.txt
"""
import yfinance as yf
import pandas as pd
import numpy as np
import sys
import os

# TOPIX-17 ETF → 個別株バスケット（各セクター上位3銘柄、均等加重）
SECTOR_BASKETS = {
    "1617.T": {"name": "食品",         "stocks": ["2914.T", "2802.T", "2502.T"]},
    "1618.T": {"name": "エネルギー",    "stocks": ["5020.T", "1605.T", "5019.T"]},
    "1619.T": {"name": "建設・資材",    "stocks": ["1925.T", "1928.T", "1812.T"]},
    "1620.T": {"name": "素材・化学",    "stocks": ["4063.T", "4901.T", "4452.T"]},
    "1621.T": {"name": "医薬品",       "stocks": ["4502.T", "4568.T", "4519.T"]},
    "1622.T": {"name": "自動車",       "stocks": ["7203.T", "7267.T", "6902.T"]},
    "1623.T": {"name": "鉄鋼・非鉄",   "stocks": ["5401.T", "5802.T", "5803.T"]},
    "1624.T": {"name": "機械",         "stocks": ["7011.T", "6301.T", "6367.T"]},
    "1625.T": {"name": "電機・精密",    "stocks": ["6758.T", "6501.T", "8035.T"]},
    "1626.T": {"name": "情報通信",      "stocks": ["7974.T", "6098.T", "9984.T"]},
    "1627.T": {"name": "電気・ガス",    "stocks": ["9531.T", "9503.T", "9532.T"]},
    "1628.T": {"name": "運輸・物流",    "stocks": ["9020.T", "9022.T", "9101.T"]},
    "1629.T": {"name": "商社・卸売",    "stocks": ["8058.T", "8001.T", "8031.T"]},
    "1630.T": {"name": "小売",         "stocks": ["9983.T", "3382.T", "8267.T"]},
    "1631.T": {"name": "銀行",         "stocks": ["8306.T", "8316.T", "8411.T"]},
    "1632.T": {"name": "金融(除銀行)",  "stocks": ["8766.T", "8725.T", "8630.T"]},
    "1633.T": {"name": "不動産",       "stocks": ["8801.T", "8802.T", "8830.T"]},
}

START = "2015-01-01"
END = "2025-12-31"


def fetch_all_data():
    """全ティッカーの終値をダウンロード"""
    etfs = list(SECTOR_BASKETS.keys())
    stocks = []
    for v in SECTOR_BASKETS.values():
        stocks.extend(v["stocks"])
    all_tickers = list(set(etfs + stocks))

    print(f"Fetching {len(all_tickers)} tickers from {START} to {END}...")
    data = yf.download(all_tickers, start=START, end=END, auto_adjust=True, progress=True)

    close = data["Close"]
    if isinstance(close, pd.Series):
        close = close.to_frame()
    close.index = pd.to_datetime(close.index)
    return close


def compute_returns(close: pd.DataFrame) -> pd.DataFrame:
    """CC日次リターン（対数リターン）"""
    return np.log(close / close.shift(1)).dropna(how="all")


def compute_basket_returns(returns: pd.DataFrame) -> pd.DataFrame:
    """各セクターの均等加重バスケットリターンを計算"""
    basket_rets = {}
    for etf, info in SECTOR_BASKETS.items():
        stocks = info["stocks"]
        available = [s for s in stocks if s in returns.columns]
        if len(available) < 2:
            print(f"  WARNING: {etf} ({info['name']}): only {len(available)} stocks available, skipping")
            continue
        basket_rets[etf] = returns[available].mean(axis=1)
    return pd.DataFrame(basket_rets)


def analyze_sector(etf_ret: pd.Series, basket_ret: pd.Series, name: str) -> dict:
    """1セクターの相関・TEを分析"""
    # 両方にデータがある日のみ
    combined = pd.DataFrame({"etf": etf_ret, "basket": basket_ret}).dropna()
    if len(combined) < 100:
        return {"name": name, "n_days": len(combined), "corr": np.nan,
                "te_annual": np.nan, "max_divergence": np.nan, "mean_diff_bps": np.nan}

    corr = combined["etf"].corr(combined["basket"])
    diff = combined["basket"] - combined["etf"]
    te_daily = diff.std()
    te_annual = te_daily * np.sqrt(252) * 100  # percent
    max_div = diff.abs().max() * 100  # percent
    mean_diff_bps = diff.mean() * 10000  # bps

    return {
        "name": name,
        "n_days": len(combined),
        "corr": corr,
        "te_annual": te_annual,
        "max_divergence": max_div,
        "mean_diff_bps": mean_diff_bps,
    }


def generate_report(results: list[dict], out_path: str):
    """レポート生成"""
    lines = []
    lines.append("=" * 80)
    lines.append("  バスケットTE検証レポート (2015-2025, CC returns, 均等加重3銘柄)")
    lines.append("=" * 80)
    lines.append("")

    # Summary table
    lines.append(f"{'ETF':>8} {'セクター':<12} {'日数':>6} {'相関':>7} {'TE年率%':>8} {'最大乖離%':>9} {'平均差bps':>9} {'判定':<6}")
    lines.append("-" * 80)

    pass_count = 0
    for r in results:
        if np.isnan(r["corr"]):
            verdict = "N/A"
        elif r["corr"] >= 0.90 and r["te_annual"] <= 10.0:
            verdict = "PASS"
            pass_count += 1
        elif r["corr"] >= 0.85:
            verdict = "WARN"
        else:
            verdict = "FAIL"

        lines.append(
            f"{r['etf']:>8} {r['name']:<12} {r['n_days']:>6} "
            f"{r['corr']:>7.4f} {r['te_annual']:>8.2f} {r['max_divergence']:>9.2f} "
            f"{r['mean_diff_bps']:>9.1f} {verdict:<6}"
        )

    lines.append("-" * 80)
    lines.append(f"PASS (corr>=0.90 & TE<=10%): {pass_count}/17 sectors")
    lines.append("")

    # Go/No-Go assessment
    lines.append("=" * 80)
    lines.append("  Go/No-Go 判定")
    lines.append("=" * 80)
    lines.append(f"  PASS セクター数: {pass_count}/17")
    lines.append(f"  基準: 12セクター以上でPASS → Phase B に進む")
    if pass_count >= 12:
        lines.append(f"  → GO: {pass_count}セクターがPASS。Phase B に進む条件を満たす。")
    else:
        lines.append(f"  → CONDITIONAL: {pass_count}セクターのみ。銘柄数増加(5銘柄)や加重方式変更を検討。")
    lines.append("")

    # Sub-period analysis
    lines.append("=" * 80)
    lines.append("  サブ期間別TE安定性")
    lines.append("=" * 80)

    report_text = "\n".join(lines)

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(report_text)

    print(f"\nReport saved to {out_path}")
    print(report_text)


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "output/basket-te-report.txt"

    # 1. Fetch data
    close = fetch_all_data()
    print(f"Got {len(close)} rows x {len(close.columns)} tickers")
    print(f"Date range: {close.index[0].date()} to {close.index[-1].date()}")
    print(f"Available tickers: {sorted(close.columns.tolist())}")
    print()

    # 2. Compute returns
    returns = compute_returns(close)

    # 3. Compute basket returns
    basket_returns = compute_basket_returns(returns)
    print(f"Basket returns computed for {len(basket_returns.columns)} sectors")
    print()

    # 4. Analyze each sector
    results = []
    for etf, info in SECTOR_BASKETS.items():
        if etf not in returns.columns:
            print(f"  SKIP: {etf} ({info['name']}) - ETF data not available")
            continue
        if etf not in basket_returns.columns:
            print(f"  SKIP: {etf} ({info['name']}) - basket data not available")
            continue

        r = analyze_sector(returns[etf], basket_returns[etf], info["name"])
        r["etf"] = etf
        results.append(r)
        print(f"  {etf} {info['name']:<10}: corr={r['corr']:.4f}  TE={r['te_annual']:.2f}%  maxDiv={r['max_divergence']:.2f}%")

    # 5. Generate report
    print()
    generate_report(results, out_path)


if __name__ == "__main__":
    main()

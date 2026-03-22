#!/usr/bin/env python3
"""Fetch individual stock price data for basket backtesting via yfinance."""
import yfinance as yf
import pandas as pd
import sys
import os

BASKET_TICKERS = [
    "2914.T", "2802.T", "2502.T", "5020.T", "1605.T", "5019.T",
    "1925.T", "1928.T", "1812.T", "4063.T", "4901.T", "4452.T",
    "4502.T", "4568.T", "4519.T", "7203.T", "7267.T", "6902.T",
    "5401.T", "5802.T", "5803.T", "7011.T", "6301.T", "6367.T",
    "6758.T", "6501.T", "8035.T", "7974.T", "6098.T", "9984.T",
    "9531.T", "9503.T", "9532.T", "9020.T", "9022.T", "9101.T",
    "8058.T", "8001.T", "8031.T", "9983.T", "3382.T", "8267.T",
    "8306.T", "8316.T", "8411.T", "8766.T", "8725.T", "8630.T",
    "8801.T", "8802.T", "8830.T",
]

def main():
    start = sys.argv[1] if len(sys.argv) > 1 else "2010-01-01"
    end = sys.argv[2] if len(sys.argv) > 2 else "2025-12-31"
    out_dir = sys.argv[3] if len(sys.argv) > 3 else "data"

    os.makedirs(out_dir, exist_ok=True)

    print(f"Fetching {len(BASKET_TICKERS)} basket stocks from {start} to {end}...")
    data = yf.download(BASKET_TICKERS, start=start, end=end, auto_adjust=True, progress=True)

    # Extract Close prices
    close = data["Close"]
    close.index = close.index.strftime("%Y-%m-%d")
    close.index.name = "date"

    csv_path = os.path.join(out_dir, "stocks-closes.csv")
    close.to_csv(csv_path)
    print(f"Saved {len(close)} rows x {len(close.columns)} tickers to {csv_path}")

    # Extract Open prices
    open_prices = data["Open"]
    open_prices.index = open_prices.index.strftime("%Y-%m-%d")
    open_prices.index.name = "date"

    open_csv_path = os.path.join(out_dir, "stocks-opens.csv")
    open_prices.to_csv(open_csv_path)
    print(f"Saved {len(open_prices)} rows x {len(open_prices.columns)} tickers to {open_csv_path}")

    print(f"Date range: {close.index[0]} to {close.index[-1]}")
    print(f"Tickers: {list(close.columns)}")

if __name__ == "__main__":
    main()

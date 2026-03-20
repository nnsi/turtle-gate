#!/usr/bin/env python3
"""Fetch US/JP sector ETF data via yfinance and save as CSV."""
import yfinance as yf
import pandas as pd
import sys
import os

US_TICKERS = ["XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"]
JP_TICKERS = [
    "1617.T", "1618.T", "1619.T", "1620.T", "1621.T", "1622.T", "1623.T", "1624.T",
    "1625.T", "1626.T", "1627.T", "1628.T", "1629.T", "1630.T", "1631.T", "1632.T", "1633.T",
]

def main():
    start = sys.argv[1] if len(sys.argv) > 1 else "2024-06-01"
    end = sys.argv[2] if len(sys.argv) > 2 else "2025-12-31"
    out_dir = sys.argv[3] if len(sys.argv) > 3 else "data"

    os.makedirs(out_dir, exist_ok=True)
    all_tickers = US_TICKERS + JP_TICKERS

    print(f"Fetching {len(all_tickers)} tickers from {start} to {end}...")
    data = yf.download(all_tickers, start=start, end=end, auto_adjust=True, progress=True)

    # Extract Close prices
    close = data["Close"]
    close.index = close.index.strftime("%Y-%m-%d")
    close.index.name = "date"

    csv_path = os.path.join(out_dir, "closes.csv")
    close.to_csv(csv_path)
    print(f"Saved {len(close)} rows x {len(close.columns)} tickers to {csv_path}")

    # Extract Open prices
    open_prices = data["Open"]
    open_prices.index = open_prices.index.strftime("%Y-%m-%d")
    open_prices.index.name = "date"

    open_csv_path = os.path.join(out_dir, "opens.csv")
    open_prices.to_csv(open_csv_path)
    print(f"Saved {len(open_prices)} rows x {len(open_prices.columns)} tickers to {open_csv_path}")

    print(f"Date range: {close.index[0]} to {close.index[-1]}")
    print(f"Tickers: {list(close.columns)}")

if __name__ == "__main__":
    main()

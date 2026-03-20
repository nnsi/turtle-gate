/**
 * System configuration for signal generation.
 * Parameters based on requirements doc section 8.2 / 19.1.
 */

/** US Sector ETFs (Select Sector SPDR, 11 tickers) */
export const US_TICKERS = [
  "XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY",
] as const;

/** Japan TOPIX-17 sector ETFs (1617.T–1633.T) */
export const JP_TICKERS = [
  "1617.T", "1618.T", "1619.T", "1620.T", "1621.T", "1622.T", "1623.T", "1624.T",
  "1625.T", "1626.T", "1627.T", "1628.T", "1629.T", "1630.T", "1631.T", "1632.T",
  "1633.T",
] as const;

/** Human-readable names for JP ETFs */
export const JP_SECTOR_NAMES: Record<string, string> = {
  "1617.T": "食品",
  "1618.T": "エネルギー資源",
  "1619.T": "建設・資材",
  "1620.T": "素材・化学",
  "1621.T": "医薬品",
  "1622.T": "自動車・輸送機",
  "1623.T": "鉄鋼・非鉄",
  "1624.T": "機械",
  "1625.T": "電機・精密",
  "1626.T": "情報通信・サービスその他",
  "1627.T": "電気・ガス",
  "1628.T": "運輸・物流",
  "1629.T": "商社・卸売",
  "1630.T": "小売",
  "1631.T": "銀行",
  "1632.T": "金融(除く銀行)",
  "1633.T": "不動産",
};

/** Cyclical / Defensive classification (section 8.2.1) */
export const US_CYCLICAL = ["XLB", "XLE", "XLF", "XLRE"];
export const US_DEFENSIVE = ["XLK", "XLP", "XLU", "XLV"];
export const JP_CYCLICAL = ["1618.T", "1625.T", "1629.T", "1631.T"];
export const JP_DEFENSIVE = ["1617.T", "1621.T", "1627.T", "1630.T"];

/** PCA_SUB parameters */
export interface SignalParams {
  /** Rolling window length in business days */
  L: number;
  /** Number of principal components */
  K: number;
  /** Regularization parameter */
  lambda: number;
  /** Quantile for long/short selection (top/bottom q) */
  q: number;
  /** Confidence filter percentile (0-100) */
  confidencePercentile: number;
}

export const DEFAULT_PARAMS: SignalParams = {
  L: 60,
  K: 3,
  lambda: 0.9,
  q: 0.3,
  confidencePercentile: 90,
};

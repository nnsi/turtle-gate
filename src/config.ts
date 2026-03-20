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
  /** Confidence filter percentile — high confidence band (0-100) */
  confidencePercentile: number;
  /** Confidence filter percentile — medium confidence lower bound (0-100) */
  confidencePercentileLow: number;
}

export const DEFAULT_PARAMS: SignalParams = {
  L: 60,
  K: 3,
  lambda: 0.9,
  q: 0.3,
  confidencePercentile: 90,
  confidencePercentileLow: 80,
};

/** Cfull estimation period (§8.2.1): 2010-01 to 2014-12 */
export const CFULL_START = "2010-01-01";
export const CFULL_END = "2014-12-31";

/**
 * BBO spread thresholds per JP ETF (one-way, bps) from JPX monthly data (§8.4.2).
 * Source: JPX「ETF気配提示・取引状況」直近12ヶ月平均。
 */
export const BBO_SPREAD_THRESHOLDS: Record<string, number> = {
  "1617.T": 7.1,   // 食品
  "1618.T": 8.7,   // エネルギー資源
  "1619.T": 8.2,   // 建設・資材
  "1620.T": 7.7,   // 素材・化学
  "1621.T": 6.0,   // 医薬品
  "1622.T": 6.9,   // 自動車・輸送機
  "1623.T": 9.3,   // 鉄鋼・非鉄
  "1624.T": 10.8,  // 機械
  "1625.T": 7.9,   // 電機・精密
  "1626.T": 7.0,   // 情報通信・サービスその他
  "1627.T": 6.7,   // 電気・ガス
  "1628.T": 6.1,   // 運輸・物流
  "1629.T": 5.2,   // 商社・卸売
  "1630.T": 7.4,   // 小売
  "1631.T": 5.3,   // 銀行
  "1632.T": 6.9,   // 金融(除く銀行)
  "1633.T": 7.3,   // 不動産
};

/** 17銘柄平均片道スプレッド (bps) */
export const AVG_SPREAD_BPS = 7.36;

/** 緊急スキップ倍率 (§8.7.2: 基準値の3倍超 ≈ 片道22 bps) */
export const SPREAD_EMERGENCY_MULTIPLIER = 3;

/** 機械(1624.T)固有スキップ閾値 (片道bps, §8.4.1: 「当日30 bps超でスキップ」) */
export const MACHINERY_SKIP_BPS = 30;

/** 寄り後確認の基準時刻 (§8.7.1, JST, 設定変更可能) */
export const POST_OPEN_CHECK_TIME = "09:10";

/** 異常値判定の前日比ギャップ閾値 (§8.4.1) */
export const ANOMALY_GAP_THRESHOLD = 0.05;

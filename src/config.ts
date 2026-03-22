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

/** Human-readable names for JP tickers (sector ETFs + basket stocks) */
export const JP_SECTOR_NAMES: Record<string, string> = {
  // TOPIX-17 sector ETFs
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
  // Basket stocks — food
  "2914.T": "JT", "2802.T": "味の素", "2502.T": "アサヒGHD",
  // Basket stocks — energy
  "5020.T": "ENEOS", "1605.T": "INPEX", "5019.T": "出光興産",
  // Basket stocks — construction
  "1925.T": "大和ハウス", "1928.T": "積水ハウス", "1812.T": "鹿島建設",
  // Basket stocks — materials/chemicals
  "4063.T": "信越化学", "4901.T": "富士フイルム", "4452.T": "花王",
  // Basket stocks — pharma
  "4502.T": "武田薬品", "4568.T": "第一三共", "4519.T": "中外製薬",
  // Basket stocks — auto/transport equipment
  "7203.T": "トヨタ", "7267.T": "ホンダ", "6902.T": "デンソー",
  // Basket stocks — steel/nonferrous
  "5401.T": "日本製鉄", "5802.T": "住友電工", "5803.T": "フジクラ",
  // Basket stocks — machinery
  "7011.T": "三菱重工", "6301.T": "コマツ", "6367.T": "ダイキン",
  // Basket stocks — electronics/precision
  "6758.T": "ソニーG", "6501.T": "日立", "8035.T": "東京エレクトロン",
  // Basket stocks — IT/services
  "7974.T": "任天堂", "6098.T": "リクルート", "9984.T": "ソフトバンクG",
  // Basket stocks — electric/gas
  "9531.T": "東京ガス", "9503.T": "関西電力", "9532.T": "大阪ガス",
  // Basket stocks — transport/logistics
  "9020.T": "JR東日本", "9022.T": "JR東海", "9101.T": "日本郵船",
  // Basket stocks — trading
  "8058.T": "三菱商事", "8001.T": "伊藤忠", "8031.T": "三井物産",
  // Basket stocks — retail
  "9983.T": "ファーストリテイリング", "3382.T": "セブン&iHD", "8267.T": "イオン",
  // Basket stocks — banking
  "8306.T": "三菱UFJFG", "8316.T": "三井住友FG", "8411.T": "みずほFG",
  // Basket stocks — finance (ex-bank)
  "8766.T": "東京海上", "8725.T": "MS&AD", "8630.T": "SOMPOHD",
  // Basket stocks — real estate
  "8801.T": "三井不動産", "8802.T": "三菱地所", "8830.T": "住友不動産",
};

/** Cyclical / Defensive classification (section 8.2.1) */
export const US_CYCLICAL = ["XLB", "XLE", "XLF", "XLRE"];
export const US_DEFENSIVE = ["XLK", "XLP", "XLU", "XLV"];
export const JP_CYCLICAL = ["1618.T", "1625.T", "1629.T", "1631.T"];
export const JP_DEFENSIVE = ["1617.T", "1621.T", "1627.T", "1630.T"];

/** PCA_SUB parameters */
export type SignalParams = {
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

/** 流動性チェック: 最良気配の最小株数 (§8.4.1, Level2板情報が必要) */
export const MIN_DEPTH_SHARES = 100;

/** 1ポジションあたりの想定金額 (JPY, §8.8) */
export const POSITION_SIZE_JPY = 1_000_000;

/** 売買総額上限 (JPY, §12.1) */
export const MAX_TOTAL_POSITION_JPY = 10_000_000;

/** ロング/ショート偏り上限 (§12.1: 片側の銘柄数上限) */
export const MAX_SIDE_COUNT = 5;

/** 手仕舞い時刻帯 (JST, §8.9: 14:50–15:00) */
export const UNWIND_START_TIME = "14:50";
export const UNWIND_END_TIME = "15:00";

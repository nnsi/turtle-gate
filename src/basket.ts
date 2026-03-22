/**
 * TOPIX-17 sector ETF -> individual stock basket mapping.
 *
 * PCA_SUB generates signals at sector ETF level (1617.T-1633.T).
 * This module expands those signals into individual stock positions.
 */

export type PtsGroup = "A" | "B" | "C" | "D";

export type BasketStock = {
  ticker: string;
  weight: number;
  ptsGroup: PtsGroup;
};

export type SectorBasket = {
  sector: string;
  stocks: BasketStock[];
};

export type SectorSignalInput = {
  sectorTicker: string;
  direction: "long" | "short";
  sizeJpy: number;
};

export type BasketPosition = {
  stockTicker: string;
  sectorTicker: string;
  direction: "long" | "short";
  sizeJpy: number;
  weight: number;
  ptsGroup: PtsGroup;
};

const W = 1 / 3;

const PTS: Record<string, PtsGroup> = {
  "1617.T": "B", "1618.T": "A", "1619.T": "C", "1620.T": "B",
  "1621.T": "C", "1622.T": "A", "1623.T": "B", "1624.T": "A",
  "1625.T": "B", "1626.T": "A", "1627.T": "D", "1628.T": "C",
  "1629.T": "A", "1630.T": "D", "1631.T": "A", "1632.T": "C",
  "1633.T": "C",
};

function stocks(tickers: [string, string, string], sector: string): SectorBasket {
  const group = PTS[sector];
  return {
    sector,
    stocks: tickers.map((t) => ({ ticker: t, weight: W, ptsGroup: group })),
  };
}

export const SECTOR_BASKETS: Record<string, SectorBasket> = {
  "1617.T": stocks(["2914.T", "2802.T", "2502.T"], "1617.T"),
  "1618.T": stocks(["5020.T", "1605.T", "5019.T"], "1618.T"),
  "1619.T": stocks(["1925.T", "1928.T", "1812.T"], "1619.T"),
  "1620.T": stocks(["4063.T", "4901.T", "4452.T"], "1620.T"),
  "1621.T": stocks(["4502.T", "4568.T", "4519.T"], "1621.T"),
  "1622.T": stocks(["7203.T", "7267.T", "6902.T"], "1622.T"),
  "1623.T": stocks(["5401.T", "5802.T", "5803.T"], "1623.T"),
  "1624.T": stocks(["7011.T", "6301.T", "6367.T"], "1624.T"),
  "1625.T": stocks(["6758.T", "6501.T", "8035.T"], "1625.T"),
  "1626.T": stocks(["7974.T", "6098.T", "9984.T"], "1626.T"),
  "1627.T": stocks(["9531.T", "9503.T", "9532.T"], "1627.T"),
  "1628.T": stocks(["9020.T", "9022.T", "9101.T"], "1628.T"),
  "1629.T": stocks(["8058.T", "8001.T", "8031.T"], "1629.T"),
  "1630.T": stocks(["9983.T", "3382.T", "8267.T"], "1630.T"),
  "1631.T": stocks(["8306.T", "8316.T", "8411.T"], "1631.T"),
  "1632.T": stocks(["8766.T", "8725.T", "8630.T"], "1632.T"),
  "1633.T": stocks(["8801.T", "8802.T", "8830.T"], "1633.T"),
};

export function expandSectorToBasket(inputs: SectorSignalInput[]): BasketPosition[] {
  const positions: BasketPosition[] = [];
  for (const { sectorTicker, direction, sizeJpy } of inputs) {
    const basket = SECTOR_BASKETS[sectorTicker];
    if (!basket) continue;
    for (const stock of basket.stocks) {
      positions.push({
        stockTicker: stock.ticker,
        sectorTicker,
        direction,
        sizeJpy: Math.round(sizeJpy * stock.weight),
        weight: stock.weight,
        ptsGroup: stock.ptsGroup,
      });
    }
  }
  return positions;
}

export function getBasketTickers(sectorTicker: string): string[] {
  const basket = SECTOR_BASKETS[sectorTicker];
  if (!basket) return [];
  return basket.stocks.map((s) => s.ticker);
}

export function getPtsExecutableSectors(): string[] {
  return Object.keys(SECTOR_BASKETS).filter(
    (k) => PTS[k] === "A" || PTS[k] === "B",
  );
}

/** Reverse lookup: stock ticker -> sector ticker (undefined if not a basket stock) */
const _stockToSector = new Map<string, string>();
for (const [sector, basket] of Object.entries(SECTOR_BASKETS)) {
  for (const s of basket.stocks) _stockToSector.set(s.ticker, sector);
}

export function stockToSector(stockTicker: string): string | undefined {
  return _stockToSector.get(stockTicker);
}

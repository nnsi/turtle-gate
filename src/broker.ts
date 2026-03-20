/**
 * Broker port — DI boundary for securities API (§8.4, §8.8, §8.9).
 *
 * Provides Level2 board data, order management, and position tracking.
 * Inject via BROKER_PROVIDER env var: "mock" (default) | "kabu".
 */

export type OrderSide = "long" | "short";

/** Level2 板情報 — real BBO + order book depth from broker */
export type Level2Quote = {
  ticker: string;
  bestBid: number;
  bestAsk: number;
  bestBidSize: number;
  bestAskSize: number;
  /** One-way spread in bps */
  spreadBps: number;
  depth: OrderBookLevel[];
  timestamp: number;
};

export type OrderBookLevel = {
  price: number;
  size: number;
  side: "bid" | "ask";
};

export type OrderRequest = {
  ticker: string;
  side: OrderSide;
  quantity: number;
  orderType: "market" | "limit";
  limitPrice?: number;
};

export type OrderResult = {
  orderId: string;
  ticker: string;
  side: OrderSide;
  quantity: number;
  status: "accepted" | "rejected";
  message?: string;
  acceptedAt: string;
};

export type Position = {
  ticker: string;
  side: OrderSide;
  quantity: number;
  averageEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
};

export type CloseResult = {
  ticker: string;
  orderId: string;
  status: "accepted" | "rejected";
  message?: string;
};

/** Broker port — all securities API operations go through this */
export type BrokerPort = {
  readonly name: string;
  /** Get Level2 quotes with real BBO (§8.4.1) */
  getLevel2Quotes(tickers: readonly string[]): Promise<Map<string, Level2Quote>>;
  /** Place an order (§8.8) */
  placeOrder(order: OrderRequest): Promise<OrderResult>;
  /** Cancel an order */
  cancelOrder(orderId: string): Promise<{ success: boolean; message?: string }>;
  /** Get current positions */
  getPositions(): Promise<Position[]>;
  /** Close a specific position */
  closePosition(ticker: string): Promise<CloseResult>;
  /** Close all positions — 手仕舞い (§8.9) */
  closeAllPositions(): Promise<CloseResult[]>;
};

let cached: BrokerPort | null = null;

/** Get broker instance based on BROKER_PROVIDER env var */
export async function getBroker(): Promise<BrokerPort> {
  if (cached) return cached;
  const provider = process.env.BROKER_PROVIDER ?? "mock";
  switch (provider) {
    case "kabu": {
      const { createKabuBroker } = await import("./broker-kabu.js");
      cached = await createKabuBroker();
      break;
    }
    default: {
      const { createMockBroker } = await import("./broker-mock.js");
      cached = createMockBroker();
      break;
    }
  }
  return cached;
}

/** Manually inject a broker (for testing or custom setup) */
export function setBroker(broker: BrokerPort): void {
  cached = broker;
}

/** Reset cached broker (for testing) */
export function resetBroker(): void {
  cached = null;
}

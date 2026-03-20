/**
 * kabu Station API broker adapter (skeleton).
 *
 * kabu Station REST API: https://kabucom.github.io/kabusapi/reference/
 * Requires kabu Station to be running locally (default: http://localhost:18080).
 *
 * Env vars:
 *   KABU_API_URL      — API base URL (default: http://localhost:18080/kabusapi)
 *   KABU_API_PASSWORD  — API password for token auth
 *
 * NOTE: This is a placeholder. Implement each method when ready to connect.
 */

import type {
  BrokerPort, Level2Quote, OrderRequest, OrderResult,
  Position, CloseResult, OrderSide,
} from "./broker.js";

const DEFAULT_API_URL = "http://localhost:18080/kabusapi";

/** kabu Station exchange codes */
const EXCHANGE_TSE = 1; // 東証

/** Convert Yahoo Finance ticker (e.g. "1617.T") to kabu Station symbol code */
function toKabuSymbol(ticker: string): string {
  return ticker.replace(".T", "");
}

/** kabu Station token auth: POST /token */
async function authenticate(baseUrl: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ APIPassword: password }),
  });
  if (!res.ok) throw new Error(`kabu auth failed: HTTP ${res.status}`);
  const data = (await res.json()) as { Token: string };
  return data.Token;
}

/** Create kabu Station broker adapter */
export async function createKabuBroker(): Promise<BrokerPort> {
  const baseUrl = process.env.KABU_API_URL ?? DEFAULT_API_URL;
  const password = process.env.KABU_API_PASSWORD;
  if (!password) throw new Error("KABU_API_PASSWORD is required for kabu broker");

  const token = await authenticate(baseUrl, password);
  const headers = { "X-API-KEY": token, "Content-Type": "application/json" };

  async function fetchPositions(): Promise<Position[]> {
    const res = await fetch(`${baseUrl}/positions`, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as Record<string, any>[];
    return data.map((p) => ({
      ticker: `${p.Symbol}.T`,
      side: (p.Side === "2" ? "long" : "short") as OrderSide,
      quantity: p.LeavesQty ?? 0,
      averageEntryPrice: p.Price ?? 0,
      currentPrice: p.CurrentPrice ?? 0,
      unrealizedPnl: p.ProfitLoss ?? 0,
    }));
  }

  async function sendOrder(order: OrderRequest): Promise<OrderResult> {
    const side = order.side === "long" ? "2" : "1";
    const body = {
      Symbol: toKabuSymbol(order.ticker),
      Exchange: EXCHANGE_TSE,
      SecurityType: 1,
      Side: side,
      CashMargin: 1,
      DelivType: 2,
      AccountType: 4,
      Qty: order.quantity,
      FrontOrderType: order.orderType === "market" ? 10 : 20,
      Price: order.orderType === "limit" ? order.limitPrice : 0,
      ExpireDay: 0,
    };
    const res = await fetch(`${baseUrl}/sendorder`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { OrderId?: string; Result?: number };
    return {
      orderId: data.OrderId ?? "",
      ticker: order.ticker,
      side: order.side,
      quantity: order.quantity,
      status: res.ok && data.Result === 0 ? "accepted" : "rejected",
      message: res.ok ? undefined : `HTTP ${res.status}`,
      acceptedAt: new Date().toISOString(),
    };
  }

  async function closeOne(ticker: string): Promise<CloseResult> {
    const positions = await fetchPositions();
    const pos = positions.find((p) => p.ticker === ticker);
    if (!pos) return { ticker, orderId: "", status: "rejected", message: "No position" };
    const reverseSide: OrderSide = pos.side === "long" ? "short" : "long";
    const result = await sendOrder({
      ticker, side: reverseSide, quantity: pos.quantity, orderType: "market",
    });
    return { ticker, orderId: result.orderId, status: result.status, message: result.message };
  }

  return {
    name: "kabu",

    async getLevel2Quotes(tickers) {
      // GET /board/{symbol}@{exchange}
      // Response includes: BidPrice, AskPrice, BidQty, AskQty, Sell1-10, Buy1-10
      const results = new Map<string, Level2Quote>();
      for (const ticker of tickers) {
        const symbol = toKabuSymbol(ticker);
        const res = await fetch(`${baseUrl}/board/${symbol}@${EXCHANGE_TSE}`, { headers });
        if (!res.ok) {
          console.warn(`  kabu board ${ticker}: HTTP ${res.status}`);
          continue;
        }
        const board = (await res.json()) as Record<string, any>;
        // TODO: Parse board response into Level2Quote
        // board.BidPrice, board.AskPrice, board.BidQty, board.AskQty
        // board.Sell1 ~ Sell10 (price, qty), board.Buy1 ~ Buy10 (price, qty)
        const bestBid = board.BidPrice ?? 0;
        const bestAsk = board.AskPrice ?? 0;
        const mid = (bestBid + bestAsk) / 2;
        const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 / 2 : 0;

        results.set(ticker, {
          ticker,
          bestBid,
          bestAsk,
          bestBidSize: board.BidQty ?? 0,
          bestAskSize: board.AskQty ?? 0,
          spreadBps,
          depth: [], // TODO: parse Sell1-10, Buy1-10
          timestamp: Date.now(),
        });
        await new Promise((r) => setTimeout(r, 100)); // rate limit
      }
      return results;
    },

    placeOrder: sendOrder,

    async cancelOrder(orderId: string) {
      const res = await fetch(`${baseUrl}/cancelorder`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ OrderId: orderId }),
      });
      return { success: res.ok };
    },

    getPositions: fetchPositions,

    async closePosition(ticker: string) {
      return closeOne(ticker);
    },

    async closeAllPositions() {
      const positions = await fetchPositions();
      const results: CloseResult[] = [];
      for (const pos of positions) {
        results.push(await closeOne(pos.ticker));
      }
      return results;
    },
  };
}

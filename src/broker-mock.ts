/**
 * Mock broker adapter — dry-run / testing implementation.
 *
 * Generates synthetic Level2 data from JPX baseline spreads.
 * Tracks orders and positions in memory.
 * All operations succeed immediately (no rejection simulation).
 */

import type {
  BrokerPort, Level2Quote, OrderBookLevel, OrderRequest,
  OrderResult, Position, CloseResult, OrderSide,
} from "./broker.js";
import { BBO_SPREAD_THRESHOLDS, AVG_SPREAD_BPS } from "./config.js";

type MockPosition = {
  ticker: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
};

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export function createMockBroker(): BrokerPort {
  const positions = new Map<string, MockPosition>();
  let orderSeq = 0;

  return {
    name: "mock",

    async getLevel2Quotes(tickers) {
      const results = new Map<string, Level2Quote>();
      for (const ticker of tickers) {
        const baseline = BBO_SPREAD_THRESHOLDS[ticker] ?? AVG_SPREAD_BPS;
        // Synthetic mid price (deterministic per ticker)
        const mid = 1500 + Math.abs(hashCode(ticker) % 1500);
        const halfSpread = (baseline / 10000) * mid;
        const bestBid = mid - halfSpread;
        const bestAsk = mid + halfSpread;

        // Synthetic 5-level depth
        const depth: OrderBookLevel[] = [];
        for (let i = 0; i < 5; i++) {
          depth.push({ price: bestBid - i * 1, size: 500 - i * 80, side: "bid" });
          depth.push({ price: bestAsk + i * 1, size: 500 - i * 80, side: "ask" });
        }

        results.set(ticker, {
          ticker,
          bestBid,
          bestAsk,
          bestBidSize: 500,
          bestAskSize: 500,
          spreadBps: baseline,
          depth,
          timestamp: Date.now(),
        });
      }
      return results;
    },

    async placeOrder(order: OrderRequest): Promise<OrderResult> {
      const id = `MOCK-${String(++orderSeq).padStart(4, "0")}`;
      const price = order.limitPrice ?? 1500;

      const existing = positions.get(order.ticker);
      if (existing && existing.side === order.side) {
        // Add to existing position
        const totalQty = existing.quantity + order.quantity;
        existing.entryPrice =
          (existing.entryPrice * existing.quantity + price * order.quantity) / totalQty;
        existing.quantity = totalQty;
      } else if (existing) {
        // Opposite side: net off
        if (order.quantity >= existing.quantity) {
          positions.delete(order.ticker);
        } else {
          existing.quantity -= order.quantity;
        }
      } else {
        positions.set(order.ticker, {
          ticker: order.ticker,
          side: order.side,
          quantity: order.quantity,
          entryPrice: price,
        });
      }

      console.log(
        `  [MOCK] 発注 ${id}: ${order.side.toUpperCase()} ${order.quantity}株 ` +
        `${order.ticker} (${order.orderType}${order.limitPrice ? ` @${order.limitPrice}` : ""})`,
      );

      return {
        orderId: id,
        ticker: order.ticker,
        side: order.side,
        quantity: order.quantity,
        status: "accepted",
        acceptedAt: new Date().toISOString(),
      };
    },

    async cancelOrder(orderId: string) {
      console.log(`  [MOCK] 取消 ${orderId}`);
      return { success: true };
    },

    async getPositions(): Promise<Position[]> {
      return [...positions.values()].map((p) => ({
        ticker: p.ticker,
        side: p.side,
        quantity: p.quantity,
        averageEntryPrice: p.entryPrice,
        currentPrice: p.entryPrice, // mock: no price movement
        unrealizedPnl: 0,
      }));
    },

    async closePosition(ticker: string): Promise<CloseResult> {
      const id = `MOCK-CLOSE-${String(++orderSeq).padStart(4, "0")}`;
      const pos = positions.get(ticker);
      if (pos) {
        console.log(`  [MOCK] 手仕舞い ${id}: ${ticker} ${pos.quantity}株 (${pos.side})`);
        positions.delete(ticker);
      } else {
        console.log(`  [MOCK] 手仕舞い ${id}: ${ticker} — ポジションなし`);
      }
      return { ticker, orderId: id, status: "accepted" };
    },

    async closeAllPositions(): Promise<CloseResult[]> {
      const tickers = [...positions.keys()];
      const results: CloseResult[] = [];
      for (const ticker of tickers) {
        results.push(await this.closePosition(ticker));
      }
      return results;
    },
  };
}

import { describe, it, expect } from "vitest";
import { computeMonitorReport, type TradeHistory } from "./monitor.js";

function makeRow(overrides: Partial<TradeHistory> = {}): TradeHistory {
  return {
    date: "2026-03-24",
    band: "low",
    traded: false,
    grossReturn: 0,
    spreadCostBps: 0,
    ...overrides,
  };
}

describe("computeMonitorReport", () => {
  it("counts band pass rate correctly with only signal rows", () => {
    const history: TradeHistory[] = [
      makeRow({ date: "2026-03-17", band: "high" }),
      makeRow({ date: "2026-03-18", band: "medium" }),
      makeRow({ date: "2026-03-19", band: "low" }),
      makeRow({ date: "2026-03-24", band: "low" }),
    ];
    const r = computeMonitorReport(history, 7);
    expect(r.passRate.total).toBe(4);
    expect(r.passRate.high).toBeCloseTo(0.25);
    expect(r.passRate.medium).toBeCloseTo(0.25);
    expect(r.passRate.low).toBeCloseTo(0.5);
  });

  it("returns zero pass rate for empty history", () => {
    const r = computeMonitorReport([], 7);
    expect(r.passRate.total).toBe(0);
    expect(r.passRate.high).toBe(0);
  });

  it("computes cumulative return only from traded days", () => {
    const history: TradeHistory[] = [
      makeRow({ date: "2026-03-17", traded: true, grossReturn: 0.005, spreadCostBps: 5 }),
      makeRow({ date: "2026-03-18", traded: false, grossReturn: 0 }),
      makeRow({ date: "2026-03-19", traded: true, grossReturn: -0.002, spreadCostBps: 5 }),
    ];
    const r = computeMonitorReport(history, 7);
    // gross = 0.005 + (-0.002) = 0.003
    expect(r.cumulativeReturn.gross).toBeCloseTo(0.003);
    // net = (0.005 - 10/10000) + (-0.002 - 10/10000) = 0.003 - 0.002 = 0.001
    expect(r.cumulativeReturn.net).toBeCloseTo(0.001);
  });

  it("recommends continue when no alerts", () => {
    const r = computeMonitorReport([makeRow()], 7);
    expect(r.recommendation).toBe("continue");
    expect(r.alerts).toHaveLength(0);
  });

  it("alerts on spread when 12m avg exceeds limit", () => {
    const r = computeMonitorReport([makeRow()], 12);
    expect(r.spreadMonitor.shouldUpgrade).toBe(true);
    expect(r.alerts.some((a) => a.includes("スプレッド"))).toBe(true);
    expect(r.recommendation).toBe("degrade_to_p90");
  });
});

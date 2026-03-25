import { describe, it, expect } from "vitest";
import { buildReturnMatrix, type ReturnRow } from "./data.js";

describe("buildReturnMatrix", () => {
  const tickers = ["A", "B"];

  it("aligns returns by date for all tickers", () => {
    const returns: ReturnRow[] = [
      { date: "2026-03-23", ticker: "A", ret: 0.01 },
      { date: "2026-03-23", ticker: "B", ret: -0.02 },
      { date: "2026-03-24", ticker: "A", ret: 0.005 },
      { date: "2026-03-24", ticker: "B", ret: 0.003 },
    ];
    const { dates, matrix } = buildReturnMatrix(returns, tickers);
    expect(dates).toEqual(["2026-03-23", "2026-03-24"]);
    expect(matrix[0]).toEqual([0.01, -0.02]);
    expect(matrix[1]).toEqual([0.005, 0.003]);
  });

  it("drops dates where not all tickers have data (non-sparse)", () => {
    const returns: ReturnRow[] = [
      { date: "2026-03-23", ticker: "A", ret: 0.01 },
      { date: "2026-03-23", ticker: "B", ret: -0.02 },
      { date: "2026-03-24", ticker: "A", ret: 0.005 },
      // B missing on 3/24
    ];
    const { dates } = buildReturnMatrix(returns, tickers, false);
    expect(dates).toEqual(["2026-03-23"]);
  });

  it("fills NaN for missing tickers in sparse mode", () => {
    const returns: ReturnRow[] = [
      { date: "2026-03-23", ticker: "A", ret: 0.01 },
      // B missing on 3/23
      { date: "2026-03-24", ticker: "A", ret: 0.005 },
      { date: "2026-03-24", ticker: "B", ret: 0.003 },
    ];
    const { dates, matrix } = buildReturnMatrix(returns, tickers, true);
    expect(dates).toEqual(["2026-03-23", "2026-03-24"]);
    expect(matrix[0][0]).toBe(0.01);
    expect(matrix[0][1]).toBeNaN(); // B missing → NaN
    expect(matrix[1]).toEqual([0.005, 0.003]);
  });

  it("handles duplicate returns for same date+ticker by keeping last", () => {
    const returns: ReturnRow[] = [
      { date: "2026-03-24", ticker: "A", ret: 0.01 },
      { date: "2026-03-24", ticker: "B", ret: -0.02 },
      { date: "2026-03-24", ticker: "A", ret: 0.015 }, // duplicate, should overwrite
    ];
    const { dates, matrix } = buildReturnMatrix(returns, tickers);
    expect(dates).toEqual(["2026-03-24"]);
    expect(matrix[0][0]).toBe(0.015); // last value wins
  });
});

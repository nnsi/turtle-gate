import { describe, it, expect } from "vitest";
import { checkGates, shouldAdvancePhase, type GateHistory, type GateHistoryEntry } from "./gate.js";

function makeEntry(overrides: Partial<GateHistoryEntry> = {}): GateHistoryEntry {
  return {
    date: "2026-03-24",
    jpxAvg12mSpread: 7,
    liveVsJpxRatio: 1.2,
    grossReturn: 0,
    traded: false,
    systemNormal: true,
    ...overrides,
  };
}

function makeHistory(
  entries: GateHistoryEntry[],
  overrides: Partial<Omit<GateHistory, "entries">> = {},
): GateHistory {
  return {
    entries,
    consecutiveMonthsExceeding: 0,
    latestBboRatio: entries.at(-1)?.liveVsJpxRatio ?? null,
    ...overrides,
  };
}

describe("checkGates", () => {
  it("G1 passes when spread <= 10 bps", () => {
    const h = makeHistory([makeEntry({ jpxAvg12mSpread: 7 })]);
    expect(checkGates(h).g1.passed).toBe(true);
  });

  it("G1 fails when spread > 10 bps", () => {
    const h = makeHistory([makeEntry({ jpxAvg12mSpread: 12 })]);
    expect(checkGates(h).g1.passed).toBe(false);
  });

  it("G2 passes when ratio <= 1.5 and consecutive months < 3", () => {
    const h = makeHistory([makeEntry()], { latestBboRatio: 1.3 });
    expect(checkGates(h).g2.passed).toBe(true);
  });

  it("G2 fails when ratio > 1.5", () => {
    const h = makeHistory([makeEntry()], { latestBboRatio: 1.8 });
    expect(checkGates(h).g2.passed).toBe(false);
  });

  it("G3 requires 20 traded days with positive net", () => {
    // 19 traded days -> fail
    const entries19 = Array.from({ length: 19 }, (_, i) =>
      makeEntry({ date: `2026-03-${String(i + 1).padStart(2, "0")}`, traded: true, grossReturn: 0.01 }),
    );
    expect(checkGates(makeHistory(entries19)).g3.passed).toBe(false);

    // 20 traded days with positive gross -> pass (gross 0.01 - cost 0.002 = net positive)
    const entries20 = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ date: `2026-03-${String(i + 1).padStart(2, "0")}`, traded: true, grossReturn: 0.01 }),
    );
    expect(checkGates(makeHistory(entries20)).g3.passed).toBe(true);
  });

  it("G3 ignores non-traded rows", () => {
    const entries = [
      ...Array.from({ length: 20 }, (_, i) =>
        makeEntry({ date: `2026-03-${String(i + 1).padStart(2, "0")}`, traded: true, grossReturn: 0.01 }),
      ),
      // BBO-only rows (not traded) should not affect G3
      makeEntry({ date: "2026-03-25", traded: false, grossReturn: 0 }),
      makeEntry({ date: "2026-03-26", traded: false, grossReturn: 0 }),
    ];
    const g3 = checkGates(makeHistory(entries)).g3;
    expect(g3.tradingDays).toBe(20);
    expect(g3.passed).toBe(true);
  });

  it("G4 counts consecutive normal days from the end", () => {
    const entries = [
      makeEntry({ date: "2026-03-01", systemNormal: false }),
      ...Array.from({ length: 20 }, (_, i) =>
        makeEntry({ date: `2026-03-${String(i + 2).padStart(2, "0")}`, systemNormal: true }),
      ),
    ];
    const g4 = checkGates(makeHistory(entries)).g4;
    expect(g4.consecutiveNormalDays).toBe(20);
    expect(g4.passed).toBe(true);
    expect(g4.lastAnomalyDate).toBe("2026-03-01");
  });

  it("G4 fails when anomaly is recent", () => {
    const entries = [
      makeEntry({ date: "2026-03-01", systemNormal: true }),
      makeEntry({ date: "2026-03-02", systemNormal: false }),
      makeEntry({ date: "2026-03-03", systemNormal: true }),
    ];
    const g4 = checkGates(makeHistory(entries)).g4;
    expect(g4.consecutiveNormalDays).toBe(1);
    expect(g4.passed).toBe(false);
  });
});

describe("shouldAdvancePhase", () => {
  const allPass = {
    g1: { passed: true, avg12mSpread: 7 },
    g2: { passed: true, liveVsJpxRatio: 1.2, consecutiveMonthsExceeding: 0 },
    g3: { passed: true, tradingDays: 20, netReturn: 0.05 },
    g4: { passed: true, consecutiveNormalDays: 20, lastAnomalyDate: null },
  };

  it("paper -> p90_only when all gates pass", () => {
    const r = shouldAdvancePhase("paper", allPass, 20, 1.5);
    expect(r.advance).toBe(true);
    expect(r.nextPhase).toBe("p90_only");
  });

  it("paper stays when any gate fails", () => {
    const gates = { ...allPass, g3: { passed: false, tradingDays: 5, netReturn: -0.01 } };
    const r = shouldAdvancePhase("paper", gates, 5, 0);
    expect(r.advance).toBe(false);
    expect(r.reason).toContain("G3");
  });
});

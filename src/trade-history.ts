/**
 * Trade history persistence layer (SQLite).
 *
 * Stores daily trade records for operational monitoring (§12, §13, §17.2),
 * gate evaluation (§19.2), and phase advancement (§19.3).
 *
 * Each CLI step appends/updates its portion:
 *   generate-signal → band, signalRange, thresholds, llm*, phase
 *   execute         → spreadCostBps, size
 *   unwind          → grossReturn, netReturn
 */

import Database from "better-sqlite3";
import * as path from "node:path";

const DEFAULT_DB_PATH = "output/trade-history.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trade_history (
  date TEXT PRIMARY KEY,
  band TEXT NOT NULL,
  traded INTEGER NOT NULL DEFAULT 0,
  signal_range REAL,
  threshold_high REAL,
  threshold_low REAL,
  gross_return REAL,
  spread_cost_bps REAL,
  net_return REAL,
  llm_judgment TEXT,
  llm_event_dominance INTEGER DEFAULT 0,
  size TEXT,
  size_multiplier REAL,
  long_candidates TEXT,
  short_candidates TEXT,
  phase TEXT,
  anomaly INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type TradeHistoryRow = {
  date: string;
  band: string;
  traded: number;
  signal_range: number | null;
  threshold_high: number | null;
  threshold_low: number | null;
  gross_return: number | null;
  spread_cost_bps: number | null;
  net_return: number | null;
  llm_judgment: string | null;
  llm_event_dominance: number;
  size: string | null;
  size_multiplier: number | null;
  long_candidates: string | null;
  short_candidates: string | null;
  phase: string | null;
  anomaly: number;
};

export function getDb(dbPath = DEFAULT_DB_PATH): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

/** Called after generate-signal.ts — insert signal + band + LLM result */
export function upsertSignal(db: Database.Database, entry: {
  date: string; band: string; signalRange: number;
  thresholdHigh: number; thresholdLow: number;
  llmJudgment?: string; llmEventDominance?: boolean;
  size?: string; sizeMultiplier?: number;
  longCandidates?: string[]; shortCandidates?: string[];
  phase?: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO trade_history (date, band, traded, signal_range, threshold_high, threshold_low,
      llm_judgment, llm_event_dominance, size, size_multiplier,
      long_candidates, short_candidates, phase, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      band=excluded.band, signal_range=excluded.signal_range,
      threshold_high=excluded.threshold_high, threshold_low=excluded.threshold_low,
      llm_judgment=excluded.llm_judgment, llm_event_dominance=excluded.llm_event_dominance,
      size=excluded.size, size_multiplier=excluded.size_multiplier,
      long_candidates=excluded.long_candidates, short_candidates=excluded.short_candidates,
      phase=excluded.phase, updated_at=excluded.updated_at
  `).run(
    entry.date, entry.band, entry.signalRange,
    entry.thresholdHigh, entry.thresholdLow,
    entry.llmJudgment ?? null, entry.llmEventDominance ? 1 : 0,
    entry.size ?? null, entry.sizeMultiplier ?? null,
    entry.longCandidates ? JSON.stringify(entry.longCandidates) : null,
    entry.shortCandidates ? JSON.stringify(entry.shortCandidates) : null,
    entry.phase ?? null, now, now,
  );
}

/** Called after execute.ts — update spread cost and mark as traded */
export function upsertExecution(db: Database.Database, date: string, spreadCostBps: number): void {
  db.prepare(`
    UPDATE trade_history SET traded=1, spread_cost_bps=?, updated_at=? WHERE date=?
  `).run(spreadCostBps, new Date().toISOString(), date);
}

/** Called after unwind.ts — update realized return */
export function upsertUnwind(db: Database.Database, date: string, grossReturn: number): void {
  const row = db.prepare("SELECT spread_cost_bps FROM trade_history WHERE date=?").get(date) as
    { spread_cost_bps: number | null } | undefined;
  const cost = row?.spread_cost_bps ?? 0;
  const netReturn = grossReturn - cost / 10000; // bps to decimal
  db.prepare(`
    UPDATE trade_history SET gross_return=?, net_return=?, updated_at=? WHERE date=?
  `).run(grossReturn, netReturn, new Date().toISOString(), date);
}

/** Get recent history for monitor/gate evaluation */
export function getHistory(db: Database.Database, days?: number): TradeHistoryRow[] {
  const q = days
    ? db.prepare("SELECT * FROM trade_history ORDER BY date DESC LIMIT ?")
    : db.prepare("SELECT * FROM trade_history ORDER BY date ASC");
  const rows = (days ? q.all(days) : q.all()) as TradeHistoryRow[];
  return days ? rows.reverse() : rows;
}

/** Convert SQLite rows to monitor.ts TradeHistory format */
export function toMonitorHistory(rows: TradeHistoryRow[]) {
  return rows.map((r) => ({
    date: r.date,
    band: r.band as "high" | "medium" | "low",
    traded: r.traded === 1,
    grossReturn: r.gross_return ?? 0,
    spreadCostBps: r.spread_cost_bps ?? 0,
    llmJudgment: r.llm_judgment as "tailwind" | "neutral" | "headwind" | "invalid" | null,
    quintileRank: null as number | null,
  }));
}

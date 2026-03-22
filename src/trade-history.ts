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
  llm_raw_prompt TEXT,
  llm_raw_response TEXT,
  size TEXT,
  size_multiplier REAL,
  long_candidates TEXT,
  short_candidates TEXT,
  phase TEXT,
  bbo_spread_bps REAL,
  anomaly INTEGER DEFAULT 0,
  quintile_rank INTEGER,
  counterfactual_return REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_market_data (
  date TEXT NOT NULL,
  ticker TEXT NOT NULL,
  close REAL NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  volume REAL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (date, ticker)
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
  llm_raw_prompt: string | null;
  llm_raw_response: string | null;
  size: string | null;
  size_multiplier: number | null;
  long_candidates: string | null;
  short_candidates: string | null;
  phase: string | null;
  bbo_spread_bps: number | null;
  anomaly: number;
  quintile_rank: number | null;
  counterfactual_return: number | null;
};

/** Columns added after initial schema — ALTER TABLE for existing DBs */
const MIGRATIONS = [
  "ALTER TABLE trade_history ADD COLUMN llm_raw_prompt TEXT",
  "ALTER TABLE trade_history ADD COLUMN llm_raw_response TEXT",
  "ALTER TABLE trade_history ADD COLUMN bbo_spread_bps REAL",
  "ALTER TABLE trade_history ADD COLUMN quintile_rank INTEGER",
  "ALTER TABLE trade_history ADD COLUMN counterfactual_return REAL",
];

export function getDb(dbPath = DEFAULT_DB_PATH): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  // Run migrations for existing DBs (ignore "duplicate column" errors)
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  return db;
}

/** Called after generate-signal.ts — insert signal + band + LLM result */
export function upsertSignal(db: Database.Database, entry: {
  date: string; band: string; signalRange: number;
  thresholdHigh: number; thresholdLow: number;
  llmJudgment?: string; llmEventDominance?: boolean;
  llmRawPrompt?: string; llmRawResponse?: string;
  size?: string; sizeMultiplier?: number;
  longCandidates?: string[]; shortCandidates?: string[];
  phase?: string; quintileRank?: number;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO trade_history (date, band, traded, signal_range, threshold_high, threshold_low,
      llm_judgment, llm_event_dominance, llm_raw_prompt, llm_raw_response,
      size, size_multiplier,
      long_candidates, short_candidates, phase, quintile_rank, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      band=excluded.band, signal_range=excluded.signal_range,
      threshold_high=excluded.threshold_high, threshold_low=excluded.threshold_low,
      llm_judgment=excluded.llm_judgment, llm_event_dominance=excluded.llm_event_dominance,
      llm_raw_prompt=excluded.llm_raw_prompt, llm_raw_response=excluded.llm_raw_response,
      size=excluded.size, size_multiplier=excluded.size_multiplier,
      long_candidates=excluded.long_candidates, short_candidates=excluded.short_candidates,
      phase=excluded.phase, quintile_rank=excluded.quintile_rank, updated_at=excluded.updated_at
  `).run(
    entry.date, entry.band, entry.signalRange,
    entry.thresholdHigh, entry.thresholdLow,
    entry.llmJudgment ?? null, entry.llmEventDominance ? 1 : 0,
    entry.llmRawPrompt ?? null, entry.llmRawResponse ?? null,
    entry.size ?? null, entry.sizeMultiplier ?? null,
    entry.longCandidates ? JSON.stringify(entry.longCandidates) : null,
    entry.shortCandidates ? JSON.stringify(entry.shortCandidates) : null,
    entry.phase ?? null, entry.quintileRank ?? null, now, now,
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
  // L/S turnover = 2: round-trip cost = 2 × one-way spread
  const netReturn = grossReturn - (cost * 2) / 10000;
  db.prepare(`
    UPDATE trade_history SET gross_return=?, net_return=?, updated_at=? WHERE date=?
  `).run(grossReturn, netReturn, new Date().toISOString(), date);
}

/** Save daily BBO spread measurement from check-market (§19.2 G2) */
export function upsertBboSpread(db: Database.Database, date: string, bboSpreadBps: number): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO trade_history (date, band, bbo_spread_bps, created_at, updated_at)
    VALUES (?, 'low', ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET bbo_spread_bps=excluded.bbo_spread_bps, updated_at=excluded.updated_at
  `).run(date, bboSpreadBps, now, now);
}

/** Mark a day as anomalous (for G4 gate evaluation) */
export function upsertAnomaly(db: Database.Database, date: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO trade_history (date, band, anomaly, created_at, updated_at)
    VALUES (?, 'low', 1, ?, ?)
    ON CONFLICT(date) DO UPDATE SET anomaly=1, updated_at=excluded.updated_at
  `).run(date, now, now);
}

/** Record counterfactual OC return for non-traded days (for LLM quality evaluation §13.3) */
export function upsertCounterfactualReturn(db: Database.Database, date: string, ocReturn: number): void {
  db.prepare(`
    UPDATE trade_history SET counterfactual_return=?, updated_at=? WHERE date=?
  `).run(ocReturn, new Date().toISOString(), date);
}

/** Save raw market data to DB */
export function saveRawMarketData(db: Database.Database, rows: {
  date: string; ticker: string; close: number;
  open?: number; high?: number; low?: number; volume?: number;
}[]): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO raw_market_data (date, ticker, close, open, high, low, volume, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, ticker) DO UPDATE SET
      close=excluded.close, open=excluded.open, high=excluded.high,
      low=excluded.low, volume=excluded.volume
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.date, r.ticker, r.close, r.open ?? null, r.high ?? null, r.low ?? null, r.volume ?? null, now);
    }
  });
  tx();
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
    quintileRank: r.quintile_rank ?? null,
    counterfactualReturn: r.counterfactual_return ?? null,
  }));
}

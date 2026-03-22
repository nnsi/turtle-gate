#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";

type DailyRow = {
  date: string;
  signalRange: number;
  grossReturnOCBps: number;
  grossReturnCCBps: number;
};

type ScenarioMetrics = {
  tradeDays: number;
  grossAr: number;
  netAr: number;
  risk: number;
  rr: number;
  mdd: number;
  avgTradeBps: number;
  avgOvernightCaptureBps: number;
  ocCcRatio: number;
};

type RebuiltRow = DailyRow & {
  threshold: number;
  isTradeDay: boolean;
};

type Args = {
  input: string;
  output: string;
  costBps: number;
  annualFactor: number;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let input = "output/backtest-oc/backtest-daily.json";
  let output = "output/proxy-backtest";
  let costBps = 7.36;
  let annualFactor = 250;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--input":
        input = args[++i];
        break;
      case "--output":
        output = args[++i];
        break;
      case "--cost":
        costBps = Number(args[++i]);
        break;
      case "--annual-factor":
        annualFactor = Number(args[++i]);
        break;
    }
  }

  return { input, output, costBps, annualFactor };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1),
  );
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

function maxDrawdown(cumReturns: number[]): number {
  let peak = 0;
  let mdd = 0;
  for (const value of cumReturns) {
    if (value > peak) peak = value;
    const dd = value - peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function bps(value: number): string {
  return `${value.toFixed(1)}bps`;
}

function loadRows(inputPath: string): DailyRow[] {
  const raw = fs.readFileSync(inputPath, "utf8");
  const parsed = JSON.parse(raw) as DailyRow[];
  return parsed.map((row) => ({
    date: row.date,
    signalRange: row.signalRange,
    grossReturnOCBps: row.grossReturnOCBps,
    grossReturnCCBps: row.grossReturnCCBps,
  }));
}

function rebuildTradeDays(rows: DailyRow[], percentileLevel: number): RebuiltRow[] {
  const rebuilt: RebuiltRow[] = [];
  const pastRanges: number[] = [];

  for (const row of rows) {
    if (pastRanges.length < 20) {
      rebuilt.push({ ...row, threshold: Number.POSITIVE_INFINITY, isTradeDay: false });
      pastRanges.push(row.signalRange);
      continue;
    }

    const threshold = percentile(pastRanges, percentileLevel);
    rebuilt.push({
      ...row,
      threshold,
      isTradeDay: row.signalRange >= threshold,
    });
    pastRanges.push(row.signalRange);
  }

  return rebuilt;
}

function scenarioReturn(row: DailyRow, captureRatio: number): number {
  return row.grossReturnOCBps + captureRatio * (row.grossReturnCCBps - row.grossReturnOCBps);
}

function computeMetrics(
  rows: RebuiltRow[],
  captureRatio: number,
  costBps: number,
  annualFactor: number,
): ScenarioMetrics {
  const tradeRows = rows.filter((row) => row.isTradeDay);
  const grossSeries = rows.map((row) => (row.isTradeDay ? scenarioReturn(row, captureRatio) : 0));
  const netSeries = rows.map((row) =>
    row.isTradeDay ? scenarioReturn(row, captureRatio) - 2 * costBps : 0,
  );

  const grossAr = mean(grossSeries) * annualFactor / 10000 * 100;
  const netAr = mean(netSeries) * annualFactor / 10000 * 100;
  const risk = std(netSeries) * Math.sqrt(annualFactor) / 10000 * 100;
  const rr = risk > 0 ? netAr / risk : 0;

  let cumulative = 0;
  const cumReturns = netSeries.map((value) => {
    cumulative += value / 10000;
    return cumulative;
  });

  const tradeGross = tradeRows.map((row) => scenarioReturn(row, captureRatio));
  const tradeOc = tradeRows.map((row) => row.grossReturnOCBps);
  const tradeCc = tradeRows.map((row) => row.grossReturnCCBps);
  const avgTradeBps = mean(tradeGross);
  const avgOvernightCaptureBps = mean(tradeCc) - mean(tradeOc);
  const ocCcRatio = mean(tradeCc) !== 0 ? mean(tradeOc) / mean(tradeCc) : 0;

  return {
    tradeDays: tradeRows.length,
    grossAr,
    netAr,
    risk,
    rr,
    mdd: maxDrawdown(cumReturns) * 100,
    avgTradeBps,
    avgOvernightCaptureBps,
    ocCcRatio,
  };
}

function findRequiredCapture(
  rows: RebuiltRow[],
  costBps: number,
  annualFactor: number,
  targetNetAr: number,
): number | null {
  for (let step = 0; step <= 1000; step++) {
    const captureRatio = step / 1000;
    const metrics = computeMetrics(rows, captureRatio, costBps, annualFactor);
    if (metrics.netAr >= targetNetAr) return captureRatio;
  }
  return null;
}

function buildMarkdown(
  rows: DailyRow[],
  costBps: number,
  annualFactor: number,
): { markdown: string; summary: unknown } {
  const percentiles = [75, 80, 85, 90];
  const captureRatios = [0, 0.25, 0.5, 0.75, 1];
  const targets = [10, 15, 30];

  const lines: string[] = [];
  const summary: {
    inputRows: number;
    costBps: number;
    annualFactor: number;
    percentiles: Record<string, unknown>;
  } = {
    inputRows: rows.length,
    costBps,
    annualFactor,
    percentiles: {},
  };

  lines.push("# Proxy Backtest");
  lines.push("");
  lines.push(`Input: \`${path.normalize("output/backtest-oc/backtest-daily.json")}\``);
  lines.push(`Assumed one-way cost: ${costBps.toFixed(2)} bps`);
  lines.push(`Annualization factor: ${annualFactor}`);
  lines.push("");
  lines.push("Method:");
  lines.push("- Rebuild P75/P80/P85/P90 from `signalRange` with the same expanding-window percentile rule as `applyConfidenceFilter`.");
  lines.push("- Use recorded daily `OC` and `CC` returns from the existing backtest output.");
  lines.push("- Define proxy early-entry return as `OC + x * (CC - OC)`, where `x` is the captured share of overnight alpha.");
  lines.push("- `x=0` means current OC entry. `x=1` means full CC capture.");
  lines.push("");
  lines.push("Caveat:");
  lines.push("- This is still optimistic for live execution because the production flow executes around 09:10, not exactly at the official open.");
  lines.push("");

  for (const percentileLevel of percentiles) {
    const rebuilt = rebuildTradeDays(rows, percentileLevel);
    const pKey = `P${percentileLevel}`;
    const bucket: Record<string, unknown> = {};
    summary.percentiles[pKey] = bucket;

    const base = computeMetrics(rebuilt, 0, costBps, annualFactor);
    const full = computeMetrics(rebuilt, 1, costBps, annualFactor);

    bucket.tradeDays = base.tradeDays;
    bucket.base = base;
    bucket.full = full;

    lines.push(`## ${pKey}`);
    lines.push("");
    lines.push(`Trade days: ${base.tradeDays} / ${rows.length}`);
    lines.push(`Current OC/CC ratio on trade days: ${base.ocCcRatio.toFixed(3)}`);
    lines.push(`Average overnight component on trade days: ${bps(base.avgOvernightCaptureBps)}`);
    lines.push("");
    lines.push("| Capture x | Gross AR | Net AR | Risk | R/R | MDD | Avg trade |");
    lines.push("|-----------|----------|--------|------|-----|-----|-----------|");

    const scenarioTable: Record<string, ScenarioMetrics> = {};
    for (const captureRatio of captureRatios) {
      const metrics = computeMetrics(rebuilt, captureRatio, costBps, annualFactor);
      scenarioTable[captureRatio.toFixed(2)] = metrics;
      lines.push(
        `| ${captureRatio.toFixed(2)} | ${pct(metrics.grossAr)} | ${pct(metrics.netAr)} | ${pct(metrics.risk)} | ${metrics.rr.toFixed(2)} | ${pct(metrics.mdd)} | ${bps(metrics.avgTradeBps)} |`,
      );
    }
    bucket.captureScenarios = scenarioTable;
    lines.push("");

    lines.push("| Target net AR | Required x |");
    lines.push("|---------------|------------|");
    const required: Record<string, number | null> = {};
    for (const target of targets) {
      const captureRatio = findRequiredCapture(rebuilt, costBps, annualFactor, target);
      required[String(target)] = captureRatio;
      lines.push(
        `| ${target.toFixed(0)}% | ${captureRatio === null ? "unreachable" : captureRatio.toFixed(3)} |`,
      );
    }
    bucket.requiredCapture = required;
    lines.push("");
  }

  return { markdown: `${lines.join("\n")}\n`, summary };
}

function main(): void {
  const { input, output, costBps, annualFactor } = parseArgs();
  const rows = loadRows(input);
  const { markdown, summary } = buildMarkdown(rows, costBps, annualFactor);

  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "proxy-backtest-report.md"), markdown, "utf8");
  fs.writeFileSync(
    path.join(output, "proxy-backtest-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );

  console.log(markdown);
  console.log(`Report saved: ${path.join(output, "proxy-backtest-report.md")}`);
  console.log(`Summary saved: ${path.join(output, "proxy-backtest-summary.json")}`);
}

main();

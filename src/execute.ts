#!/usr/bin/env tsx
/**
 * Order execution CLI (§8.8).
 *
 * Reads market-check.json, finds candidates that passed all filters,
 * calculates quantities, and places orders via BrokerPort.
 * With --basket, expands sector ETFs into individual stock baskets.
 *
 * Usage:
 *   npx tsx src/execute.ts [--market-check PATH] [--output DIR] [--size JPY] [--basket] [--no-vix-regime]
 *
 * Env vars:
 *   BROKER_PROVIDER — "mock" (default, dry-run) | "kabu"
 */

import { getBroker } from "./broker.js";
import { POSITION_SIZE_JPY, MAX_TOTAL_POSITION_JPY, MAX_SIDE_COUNT, JP_SECTOR_NAMES } from "./config.js";
import { resolveCandidates, expandToBasket, executeOrders, getVixRegimeMultiplier } from "./execute-helpers.js";
import { getDb, upsertExecution } from "./trade-history.js";
import * as fs from "node:fs";
import * as path from "node:path";

type Args = { marketCheckFile: string; outputDir: string; positionSize: number; basket: boolean; noVixRegime: boolean };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let marketCheckFile = "output/market-check.json";
  let outputDir = "output";
  let positionSize = POSITION_SIZE_JPY;
  let basket = false;
  let noVixRegime = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--market-check") marketCheckFile = args[++i];
    else if (args[i] === "--output") outputDir = args[++i];
    else if (args[i] === "--size") positionSize = Number(args[++i]);
    else if (args[i] === "--basket") basket = true;
    else if (args[i] === "--no-vix-regime") noVixRegime = true;
  }
  return { marketCheckFile, outputDir, positionSize, basket, noVixRegime };
}

async function main() {
  const { marketCheckFile, outputDir, positionSize, basket, noVixRegime } = parseArgs();

  if (!fs.existsSync(marketCheckFile)) {
    console.error(`market-check.json が見つかりません: ${marketCheckFile}`);
    console.error("先に npx tsx src/check-market.ts を実行してください。");
    process.exit(1);
  }

  const checkData = JSON.parse(fs.readFileSync(marketCheckFile, "utf-8"));

  // Block orders when market is closed
  if (checkData.marketState === "CLOSED") {
    console.log("市場は休場中です。発注をスキップします。");
    return;
  }

  const broker = await getBroker();

  console.log(`=== 発注実行 (§8.8) ===`);
  console.log(`Broker: ${broker.name}${basket ? " [BASKET MODE]" : ""}`);
  console.log(`Position size: ¥${positionSize.toLocaleString()}`);
  console.log(`Position limits: ¥${MAX_TOTAL_POSITION_JPY.toLocaleString()} total, ${MAX_SIDE_COUNT} per side`);
  console.log(`Market check: ${marketCheckFile} (${checkData.checkedAt})`);
  console.log("");

  // Check trade decision
  const decision = checkData.tradeDecision;
  if (!decision || decision.size === "skip") {
    const reason = decision?.skipReason ?? "No trade decision";
    console.log(`売買見送り: ${reason}`);
    return;
  }

  console.log(`Band: ${decision.band.toUpperCase()}, Size: ${decision.size} (×${decision.sizeMultiplier})`);

  // VIX regime-based position sizing (F-2)
  const vixResult = noVixRegime
    ? { regime: "unavailable" as const, vixLevel: null, multiplier: 1.0 }
    : getVixRegimeMultiplier(checkData.usIndicators);
  const effectiveMultiplier = decision.sizeMultiplier * vixResult.multiplier;

  if (noVixRegime) {
    console.log("VIX Regime: disabled (--no-vix-regime)");
  } else {
    const levelStr = vixResult.vixLevel !== null ? vixResult.vixLevel.toFixed(1) : "N/A";
    console.log(`VIX Regime: ${vixResult.regime} (VIX=${levelStr}, ×${vixResult.multiplier})`);
  }
  console.log(`Effective size multiplier: ×${effectiveMultiplier}`);
  console.log("");

  // Resolve final candidates (sector level — limits applied here)
  const sectorCandidates = resolveCandidates(checkData, positionSize, effectiveMultiplier);
  if (sectorCandidates.length === 0) {
    console.log("発注対象なし (全銘柄がフィルター不通過)");
    return;
  }

  // Expand to individual stocks when --basket is active
  const quotes: Record<string, any> = checkData.quotes ?? {};
  const candidates = basket ? expandToBasket(sectorCandidates, quotes) : sectorCandidates;
  if (basket && candidates.length === 0) {
    console.log("発注対象なし (バスケット展開後に有効な銘柄なし)");
    return;
  }

  console.log(basket ? "--- 発注候補 (個別株バスケット) ---" : "--- 発注候補 ---");
  for (const c of candidates) {
    const name = JP_SECTOR_NAMES[c.ticker] ?? c.ticker;
    const sector = c.sectorTicker ? ` ← ${JP_SECTOR_NAMES[c.sectorTicker] ?? c.sectorTicker}` : "";
    const notional = c.price * c.quantity;
    console.log(
      `  ${c.side.toUpperCase().padEnd(5)} ${c.ticker} (${name}${sector})  ${c.quantity}株 @${c.price} = ¥${notional.toLocaleString()}`,
    );
  }
  console.log("");

  // Execute
  console.log("--- 発注実行 ---");
  const results = await executeOrders(broker, candidates);

  // Save results
  const output = {
    executedAt: new Date().toISOString(),
    broker: broker.name,
    basket,
    positionSize,
    sizeMultiplier: decision.sizeMultiplier,
    vixRegime: vixResult.regime,
    vixLevel: vixResult.vixLevel,
    vixMultiplier: vixResult.multiplier,
    effectiveMultiplier,
    band: decision.band,
    orders: results,
  };
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, "execution-results.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n結果保存: ${outPath}`);

  const accepted = results.filter((r) => r.status === "accepted").length;
  console.log(`発注結果: ${accepted} / ${results.length} accepted`);

  // Write to trade-history SQLite
  if (results.length > 0) {
    const filterResults: any[] = checkData.filterResults ?? [];
    // In basket mode, map back to sector tickers for spread lookup
    const sectorTickers = basket
      ? new Set(results.map((r: any) => r.sectorTicker).filter(Boolean))
      : new Set(results.map((r: any) => r.ticker));
    const relevantSpreads = filterResults
      .filter((f: any) => sectorTickers.has(f.ticker))
      .map((f: any) => f.estimatedSpreadBps);
    const avgSpread = relevantSpreads.length > 0
      ? relevantSpreads.reduce((a: number, b: number) => a + b, 0) / relevantSpreads.length
      : 7.36;
    const tradeDate = decision.date ?? new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const db = getDb(path.join(outputDir, "trade-history.db"));
    upsertExecution(db, tradeDate, avgSpread);
    db.close();
    console.log(`SQLite更新: traded=1, spread=${avgSpread.toFixed(2)} bps (${tradeDate})`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

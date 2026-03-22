/**
 * Signal provider DI boundary.
 *
 * Abstracts signal generation so that alternative/composite strategies
 * can be plugged in without changing the downstream pipeline
 * (confidence filter, trade decision, execution, monitoring).
 *
 * Pattern mirrors BrokerPort (src/broker.ts).
 *
 * Env var: SIGNAL_PROVIDER — "pca_sub" (default)
 */

import type { SignalResult } from "./signal.js";
import type { SignalParams } from "./config.js";
import type { DailyReturnRecord } from "./cfull-monitor.js";

/** Input context passed to every signal provider */
export type SignalContext = {
  dates: string[];
  matrix: number[][];
  tickers: string[];
  params: SignalParams;
  /** Realized returns from trade history DB (for diagnostics such as Cfull drift) */
  historyReturns?: DailyReturnRecord[];
};

/** Standard output every provider must return */
export type SignalProviderOutput = {
  signals: SignalResult[];
  /** Provider-specific diagnostics (e.g., Cfull drift, model metrics) */
  diagnostics: Record<string, unknown>;
};

/** Signal provider interface — the single contract new strategies must implement */
export type SignalProvider = {
  readonly name: string;
  generate(ctx: SignalContext): Promise<SignalProviderOutput>;
};

// --------------- DI mechanism ---------------

let cached: SignalProvider | null = null;

/** Get signal provider based on SIGNAL_PROVIDER env var */
export async function getSignalProvider(): Promise<SignalProvider> {
  if (cached) return cached;
  const name = process.env.SIGNAL_PROVIDER ?? "pca_sub";
  switch (name) {
    case "pca_sub": {
      const { createPcaSubProvider } = await import("./signal-pca-sub.js");
      cached = createPcaSubProvider();
      break;
    }
    default:
      throw new Error(`Unknown signal provider: ${name}. Available: pca_sub`);
  }
  return cached;
}

/** Inject a custom provider (for testing or composite setups) */
export function setSignalProvider(provider: SignalProvider): void {
  cached = provider;
}

/** Reset cached provider */
export function resetSignalProvider(): void {
  cached = null;
}

// --------------- Composite helper ---------------

/**
 * Create a composite provider that runs multiple providers and combines results.
 *
 * The combiner function receives all provider outputs and must return
 * a single merged SignalProviderOutput. This allows arbitrary combination
 * strategies (weighted average, signal intersection, etc.).
 */
export function createCompositeProvider(
  providers: SignalProvider[],
  combiner: (outputs: SignalProviderOutput[], ctx: SignalContext) => SignalProviderOutput,
): SignalProvider {
  return {
    name: `composite(${providers.map((p) => p.name).join("+")})`,
    async generate(ctx: SignalContext): Promise<SignalProviderOutput> {
      const outputs = await Promise.all(providers.map((p) => p.generate(ctx)));
      return combiner(outputs, ctx);
    },
  };
}

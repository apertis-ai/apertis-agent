/**
 * Cost tracking across the agent loop.
 *
 * Differentiator vs token-only SDKs: maxCost uses MEASURED cost, not an estimate.
 *
 * Two modes, chosen by whether cost is actively gated (maxCost in stopWhen):
 *  - POLL mode (pollEnabled): capture a usage baseline BEFORE the first request,
 *    then after each step read /v1/token/usage and report `priorCost + delta`.
 *    This is the only mode used when maxCost is active, so it never drops the
 *    first step's cost and never mixes sources. If the baseline or any poll fails,
 *    cost becomes unknown and maxCost stops the loop conservatively (fail-closed).
 *  - INLINE mode (no maxCost): no polling; if the response carries usage.cost it
 *    is accumulated for reporting in result.cost, otherwise cost is unknown (null).
 *
 * `priorCost` seeds accumulated spend when resuming a persisted run.
 */

import type { ApertisHttpClient } from "./client.js";

export class CostTracker {
  private baseline: number | null = null;
  private accumulated: number;
  private sawInline = false;

  constructor(
    private readonly client: ApertisHttpClient,
    /** poll /v1/token/usage (true when maxCost is active) */
    private readonly pollEnabled: boolean,
    private readonly signal?: AbortSignal,
    /** measured cost carried over from a resumed run */
    private readonly priorCost = 0,
  ) {
    this.accumulated = priorCost;
  }

  /** Capture the pre-run usage baseline. Call once before the first request. */
  async init(): Promise<void> {
    if (!this.pollEnabled) return;
    const usage = await this.client.getUsage(this.signal);
    // If baseline can't be captured it stays null; record() then reports
    // cost unknown so maxCost fails closed.
    if (usage) this.baseline = usage.used_quota_usd;
  }

  /**
   * Record a step. `inlineCost` is the response's usage.cost if present (used
   * only in INLINE mode). Returns cumulative cost and whether it is known.
   */
  async record(
    inlineCost: number | undefined,
  ): Promise<{ cost: number | null; known: boolean }> {
    if (this.pollEnabled) {
      if (this.baseline === null) return { cost: null, known: false };
      const usage = await this.client.getUsage(this.signal);
      if (!usage) return { cost: this.accumulated, known: false };
      this.accumulated =
        this.priorCost + Math.max(0, usage.used_quota_usd - this.baseline);
      return { cost: this.accumulated, known: true };
    }

    if (typeof inlineCost === "number") {
      this.sawInline = true;
      this.accumulated += inlineCost;
      return { cost: this.accumulated, known: true };
    }
    // no inline cost and not polling: report prior/seen total, mark unknown
    return {
      cost: this.sawInline ? this.accumulated : null,
      known: this.sawInline,
    };
  }
}

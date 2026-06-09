/**
 * Stop conditions. A condition receives a snapshot after each step and returns
 * true to halt the loop. Conditions are combined with OR semantics in
 * `stopWhen` — the loop stops as soon as any returns true.
 */

import type { ParsedToolCall, Usage } from "./types.js";

export interface StopConditionInput {
  /** 1-based number of completed steps */
  stepCount: number;
  /** cumulative usage across the run */
  usage: Usage;
  /** cumulative measured cost (USD); null if not yet known */
  cost: number | null;
  /**
   * false when cost could not be measured this step (inline cost absent AND
   * usage poll failed). maxCost treats this as "stop" to avoid overspend.
   */
  costKnown: boolean;
  /** finish_reason of the latest assistant message */
  finishReason: string | null;
  /** tool calls requested in the latest step */
  toolCalls: ParsedToolCall[];
}

export interface StopCondition {
  (input: StopConditionInput): boolean;
  /** marks conditions that require measured cost, so the loop enables polling */
  __needsCost?: boolean;
}

/** Stop once `stepCount` reaches `n`. */
export function stepCountIs(n: number): StopCondition {
  return (s) => s.stepCount >= n;
}

/** Stop when the model calls a tool named `name`. */
export function hasToolCall(name: string): StopCondition {
  return (s) => s.toolCalls.some((t) => t.name === name);
}

/** Stop when cumulative total tokens reach `n`. */
export function maxTokensUsed(n: number): StopCondition {
  return (s) => s.usage.total_tokens >= n;
}

/**
 * Stop when cumulative measured cost reaches `usd`. If cost cannot be measured
 * (costKnown === false) the loop stops conservatively rather than risk overspend.
 */
export function maxCost(usd: number): StopCondition {
  const fn: StopCondition = (s) => !s.costKnown || (s.cost ?? 0) >= usd;
  fn.__needsCost = true;
  return fn;
}

/** True if any condition needs measured cost (so the loop should poll usage). */
export function needsCost(conditions: StopCondition[]): boolean {
  return conditions.some((c) => c.__needsCost === true);
}

/** Stop when the latest finish_reason equals `reason`. */
export function finishReasonIs(reason: string): StopCondition {
  return (s) => s.finishReason === reason;
}

/** Evaluate all conditions with OR semantics. */
export function shouldStop(
  conditions: StopCondition[],
  input: StopConditionInput,
): boolean {
  return conditions.some((c) => c(input));
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type ConversationState,
  callModel,
  finishReasonIs,
  hasToolCall,
  maxCost,
  maxTokensUsed,
  stepCountIs,
  tool,
} from "../src/index.js";
import { installMockFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());
const KEY = { apiKey: "sk-test-1234567890" };
const u = (p: number, c: number, cost?: number) => ({
  prompt_tokens: p,
  completion_tokens: c,
  total_tokens: p + c,
  ...(cost !== undefined ? { cost } : {}),
});
const noop = tool({
  name: "noop",
  inputSchema: z.object({}),
  execute: async () => "ok",
});

describe("stop conditions", () => {
  it("stepCountIs halts after N steps even if tools still pending", async () => {
    installMockFetch({
      turns: Array.from({ length: 5 }, () => ({
        toolCalls: [{ id: "c", name: "noop", args: {} }],
        usage: u(1, 1),
      })),
    });
    const r = callModel({
      ...KEY,
      model: "m",
      input: "go",
      tools: [noop],
      stopWhen: [stepCountIs(2)],
    });
    const res = await r.getResponse();
    expect(res.steps).toHaveLength(2);
  });

  it("hasToolCall stops when the named tool is called", async () => {
    const done = tool({
      name: "done",
      inputSchema: z.object({}),
      execute: async () => "done",
    });
    installMockFetch({
      turns: [
        { toolCalls: [{ id: "c", name: "done", args: {} }], usage: u(1, 1) },
      ],
    });
    const r = callModel({
      ...KEY,
      model: "m",
      input: "go",
      tools: [done],
      stopWhen: [hasToolCall("done")],
    });
    const res = await r.getResponse();
    expect(res.steps).toHaveLength(1);
    // tool not executed because loop stopped first
    expect(res.messages.some((m) => m.role === "tool")).toBe(false);
  });

  it("maxTokensUsed stops on cumulative tokens", async () => {
    installMockFetch({
      turns: [
        { toolCalls: [{ id: "c", name: "noop", args: {} }], usage: u(50, 50) },
        { content: "should not reach", usage: u(50, 50) },
      ],
    });
    const r = callModel({
      ...KEY,
      model: "m",
      input: "go",
      tools: [noop],
      stopWhen: [maxTokensUsed(80)],
    });
    const res = await r.getResponse();
    expect(res.steps).toHaveLength(1);
  });

  it("finishReasonIs stops on a matching finish reason", async () => {
    installMockFetch({
      turns: [{ content: "hi", finishReason: "length", usage: u(1, 1) }],
    });
    const r = callModel({
      ...KEY,
      model: "m",
      input: "go",
      stopWhen: [finishReasonIs("length")],
    });
    const res = await r.getResponse();
    expect(res.finishReason).toBe("length");
  });
});

describe("maxCost", () => {
  it("does NOT drop the first step's cost (pre-run baseline)", async () => {
    // pre-run baseline poll = 10.0, after step 1 = 10.4 (delta 0.4 >= 0.3)
    installMockFetch({
      turns: [
        { toolCalls: [{ id: "c", name: "noop", args: {} }], usage: u(1, 1) },
        { content: "unreached", usage: u(1, 1) },
      ],
      usagePolls: [10.0, 10.4],
    });
    const r = callModel({
      ...KEY,
      model: "m",
      input: "go",
      tools: [noop],
      stopWhen: [maxCost(0.3)],
    });
    const res = await r.getResponse();
    // first step alone exceeds the limit -> must stop after step 1, not overspend
    expect(res.steps).toHaveLength(1);
    expect(res.cost).toBeCloseTo(0.4);
  });

  it("falls back to polling /token/usage delta when no inline cost", async () => {
    installMockFetch({
      turns: [
        { toolCalls: [{ id: "c", name: "noop", args: {} }], usage: u(1, 1) },
        { content: "unreached", usage: u(1, 1) },
      ],
      usagePolls: [10.0, 10.6], // baseline 10.0, then +0.6
    });
    const r = callModel({
      ...KEY,
      model: "m",
      input: "go",
      tools: [noop],
      stopWhen: [maxCost(0.5)],
    });
    const res = await r.getResponse();
    // measured delta 0.6 >= 0.5 -> stop
    expect(res.cost).toBeCloseTo(0.6);
  });

  it("carries prior measured cost across a resume", async () => {
    const seed: ConversationState = {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "noop", arguments: "{}" },
            },
          ],
        },
      ],
      pendingToolCalls: [
        { id: "c1", name: "noop", argumentsRaw: "{}", arguments: {} },
      ],
      unsentToolResults: [],
      status: "awaiting_approval",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      cost: 0.4,
      stepCount: 1,
    };
    installMockFetch({
      turns: [{ content: "done", usage: u(1, 1) }],
      usagePolls: [100.0, 100.15], // resume baseline 100.0, after step = 100.15
    });
    const r = callModel({
      ...KEY,
      model: "m",
      input: "go",
      tools: [noop],
      state: seed,
      approveToolCalls: ["c1"],
      stopWhen: [maxCost(0.5)],
    });
    const res = await r.getResponse();
    // priorCost 0.4 + measured delta 0.15 = 0.55 >= 0.5
    expect(res.cost).toBeCloseTo(0.55);
  });

  it("stops conservatively when cost cannot be measured (poll fails)", async () => {
    installMockFetch({
      turns: [
        { toolCalls: [{ id: "c", name: "noop", args: {} }], usage: u(1, 1) },
        { content: "unreached", usage: u(1, 1) },
      ],
      usageFails: true,
    });
    const r = callModel({
      ...KEY,
      model: "m",
      input: "go",
      tools: [noop],
      stopWhen: [maxCost(1.0)],
    });
    const res = await r.getResponse();
    // unknown cost -> maxCost returns true -> stop after first step
    expect(res.steps).toHaveLength(1);
  });

  it("does not poll usage when maxCost is not used", async () => {
    const spy = installMockFetch({
      turns: [{ content: "hi", usage: u(1, 1) }],
    });
    const r = callModel({
      ...KEY,
      model: "m",
      input: "go",
      stopWhen: [stepCountIs(5)],
    });
    await r.getResponse();
    expect(spy.urls.some((u) => u.includes("/token/usage"))).toBe(false);
  });
});

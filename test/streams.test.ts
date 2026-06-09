import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callModel, tool } from "../src/index.js";
import { installMockFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());
const KEY = { apiKey: "sk-test-1234567890" };
const u = (p: number, c: number) => ({
  prompt_tokens: p,
  completion_tokens: c,
  total_tokens: p + c,
});

async function collect<T>(it: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("streaming getters", () => {
  it("streams text deltas", async () => {
    installMockFetch({ turns: [{ content: "Hello world", usage: u(1, 1) }] });
    const r = callModel({ ...KEY, model: "m", input: "hi" });
    const deltas = await collect(r.getTextStream());
    expect(deltas.join("")).toBe("Hello world");
  });

  it("streams reasoning deltas separately from text", async () => {
    installMockFetch({
      turns: [{ reasoning: "thinking...", content: "answer", usage: u(1, 1) }],
    });
    const r = callModel({ ...KEY, model: "m", input: "hi" });
    const reasoning = await collect(r.getReasoningStream());
    expect(reasoning.join("")).toBe("thinking...");
    expect(await r.getText()).toBe("answer");
  });

  it("streams tool calls", async () => {
    const t = tool({
      name: "noop",
      inputSchema: z.object({ x: z.number() }),
      execute: async () => "ok",
    });
    installMockFetch({
      turns: [
        {
          toolCalls: [{ id: "c1", name: "noop", args: { x: 1 } }],
          usage: u(1, 1),
        },
        { content: "done", usage: u(1, 1) },
      ],
    });
    const r = callModel({ ...KEY, model: "m", input: "go", tools: [t] });
    const calls = await collect(r.getToolCallsStream());
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("noop");
    expect(calls[0].arguments).toEqual({ x: 1 });
  });

  it("getFullResponsesStream emits the full event sequence ending in finish", async () => {
    const t = tool({
      name: "noop",
      inputSchema: z.object({}),
      execute: async () => "ok",
    });
    installMockFetch({
      turns: [
        { toolCalls: [{ id: "c1", name: "noop", args: {} }], usage: u(1, 1) },
        { content: "done", usage: u(1, 1) },
      ],
    });
    const r = callModel({ ...KEY, model: "m", input: "go", tools: [t] });
    const events = await collect(r.getFullResponsesStream());
    const types = events.map((e) => e.type);
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types).toContain("step");
    expect(types[types.length - 1]).toBe("finish");
  });

  it("multiple consumers each see the whole stream", async () => {
    installMockFetch({ turns: [{ content: "abc", usage: u(1, 1) }] });
    const r = callModel({ ...KEY, model: "m", input: "hi" });
    const [a, b] = await Promise.all([
      collect(r.getTextStream()),
      collect(r.getTextStream()),
    ]);
    expect(a.join("")).toBe("abc");
    expect(b.join("")).toBe("abc");
  });
});

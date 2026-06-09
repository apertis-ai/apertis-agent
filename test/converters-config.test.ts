import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApertisAgentError,
  callModel,
  createCallModel,
  fromClaudeMessages,
  redactSecrets,
  toClaudeMessage,
} from "../src/index.js";
import { installMockFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  // biome-ignore lint/performance/noDelete: real env cleanup; assigning undefined would coerce to the string "undefined"
  delete process.env.APERTIS_API_KEY;
});
const u = (p: number, c: number) => ({
  prompt_tokens: p,
  completion_tokens: c,
  total_tokens: p + c,
});

describe("converters", () => {
  it("fromClaudeMessages maps text + tool_use + tool_result", () => {
    const out = fromClaudeMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "t1", name: "search", input: { q: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "result" },
        ],
      },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "hi" });
    expect(out[1].tool_calls?.[0].function.name).toBe("search");
    expect(out[2]).toMatchObject({
      role: "tool",
      tool_call_id: "t1",
      content: "result",
    });
  });

  it("toClaudeMessage maps an assistant tool call into a tool_use block", () => {
    const claude = toClaudeMessage({
      role: "assistant",
      content: "ok",
      tool_calls: [
        {
          id: "t1",
          type: "function",
          function: { name: "f", arguments: '{"a":1}' },
        },
      ],
    });
    expect(Array.isArray(claude.content)).toBe(true);
    const blocks = claude.content as any[];
    expect(blocks.find((b) => b.type === "tool_use").input).toEqual({ a: 1 });
  });
});

describe("config + key resolution", () => {
  it("prefers explicit apiKey over env", async () => {
    process.env.APERTIS_API_KEY = "sk-env-key-000000";
    const spy = installMockFetch({
      turns: [{ content: "hi", usage: u(1, 1) }],
    });
    await callModel({
      apiKey: "sk-explicit-111111",
      model: "m",
      input: "x",
    }).getResponse();
    expect(spy.authHeaders[0]).toBe("Bearer sk-explicit-111111");
  });

  it("falls back to APERTIS_API_KEY env", async () => {
    process.env.APERTIS_API_KEY = "sk-env-key-222222";
    const spy = installMockFetch({
      turns: [{ content: "hi", usage: u(1, 1) }],
    });
    await callModel({ model: "m", input: "x" }).getResponse();
    expect(spy.authHeaders[0]).toBe("Bearer sk-env-key-222222");
  });

  it("createCallModel binds a base config", async () => {
    const spy = installMockFetch({
      turns: [{ content: "hi", usage: u(1, 1) }],
    });
    const cm = createCallModel({
      apiKey: "sk-bound-333333",
      baseURL: "https://api.example.com/v1",
    });
    await cm({ model: "m", input: "x" }).getResponse();
    expect(spy.authHeaders[0]).toBe("Bearer sk-bound-333333");
    expect(spy.urls[0]).toBe("https://api.example.com/v1/chat/completions");
  });

  it("throws a typed auth error when no key is available", async () => {
    installMockFetch({ turns: [{ content: "x", usage: u(1, 1) }] });
    const r = callModel({ model: "m", input: "x" });
    await expect(r.getResponse()).rejects.toMatchObject({ kind: "auth" });
  });

  it("sends a browser User-Agent (CF 1010 avoidance)", async () => {
    const spy = installMockFetch({
      turns: [{ content: "hi", usage: u(1, 1) }],
    });
    await callModel({
      apiKey: "sk-x-444444",
      model: "m",
      input: "x",
    }).getResponse();
    expect(spy.userAgents[0]).toMatch(/Mozilla\/5\.0/);
  });
});

describe("errors", () => {
  it("redacts api keys from arbitrary strings", () => {
    expect(redactSecrets("oops sk-abcd1234efgh leaked")).toBe(
      "oops sk-••••efgh leaked",
    );
  });

  it("classifies HTTP status into error kinds", async () => {
    installMockFetch({ turns: [{ status: 401, body: "unauthorized" }] });
    const r = callModel({ apiKey: "sk-x-555555", model: "m", input: "x" });
    await expect(r.getResponse()).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    });
  });

  it("classifies 429 as quota", async () => {
    installMockFetch({ turns: [{ status: 429, body: "rate limited" }] });
    const r = callModel({ apiKey: "sk-x-666666", model: "m", input: "x" });
    await expect(r.getResponse()).rejects.toMatchObject({ kind: "quota" });
  });

  it("ApertisAgentError redacts secrets in its message", () => {
    const e = new ApertisAgentError("server", "boom sk-leak12345678 here");
    expect(e.message).not.toContain("sk-leak12345678");
  });
});

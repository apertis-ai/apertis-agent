import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InMemoryStateAccessor, callModel, tool } from "../src/index.js";
import { installMockFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());
const KEY = { apiKey: "sk-test-1234567890" };
const u = (p: number, c: number) => ({
  prompt_tokens: p,
  completion_tokens: c,
  total_tokens: p + c,
});

const deleteFile = tool({
  name: "delete_file",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => `deleted ${path}`,
  requireApproval: true,
});

describe("tool approval + persistence", () => {
  it("pauses awaiting approval and persists state", async () => {
    const state = new InMemoryStateAccessor();
    installMockFetch({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "delete_file", args: { path: "/tmp/x" } },
          ],
          usage: u(1, 1),
        },
      ],
    });
    const r = callModel({
      ...KEY,
      model: "m",
      input: "rm",
      tools: [deleteFile],
      state,
    });
    expect(await r.requiresApproval()).toBe(true);
    const pending = await r.getPendingToolCalls();
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe("delete_file");
    const saved = state.load();
    expect(saved?.status).toBe("awaiting_approval");
    expect(saved?.pendingToolCalls).toHaveLength(1);
  });

  it("resumes and executes an approved call", async () => {
    const state = new InMemoryStateAccessor();
    // first run pauses
    installMockFetch({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "delete_file", args: { path: "/tmp/x" } },
          ],
          usage: u(1, 1),
        },
      ],
    });
    await callModel({
      ...KEY,
      model: "m",
      input: "rm",
      tools: [deleteFile],
      state,
    }).getResponse();
    vi.unstubAllGlobals();
    // resume: model produces a final answer after the tool runs
    const spy = installMockFetch({
      turns: [{ content: "file deleted", usage: u(1, 1) }],
    });
    const r2 = callModel({
      ...KEY,
      model: "m",
      input: "rm",
      tools: [deleteFile],
      state,
      approveToolCalls: ["c1"],
    });
    expect(await r2.getText()).toBe("file deleted");
    // the approved tool's result must be in the resumed request
    const toolMsg = spy.bodies[0].messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toContain("deleted /tmp/x");
  });

  it("resumes and rejects a call, feeding an error to the model", async () => {
    const state = new InMemoryStateAccessor();
    installMockFetch({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "delete_file", args: { path: "/tmp/x" } },
          ],
          usage: u(1, 1),
        },
      ],
    });
    await callModel({
      ...KEY,
      model: "m",
      input: "rm",
      tools: [deleteFile],
      state,
    }).getResponse();
    vi.unstubAllGlobals();
    const spy = installMockFetch({
      turns: [{ content: "ok, skipped", usage: u(1, 1) }],
    });
    const r2 = callModel({
      ...KEY,
      model: "m",
      input: "rm",
      tools: [deleteFile],
      state,
      rejectToolCalls: ["c1"],
    });
    await r2.getText();
    const toolMsg = spy.bodies[0].messages.find((m: any) => m.role === "tool");
    expect(JSON.parse(toolMsg.content).error).toMatch(/rejected/i);
  });

  it("re-pauses (never auto-executes) when a pending call is left unresolved", async () => {
    const state = new InMemoryStateAccessor();
    installMockFetch({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "delete_file", args: { path: "/tmp/x" } },
          ],
          usage: u(1, 1),
        },
      ],
    });
    await callModel({
      ...KEY,
      model: "m",
      input: "rm",
      tools: [deleteFile],
      state,
    }).getResponse();
    vi.unstubAllGlobals();
    // resume with NEITHER approve nor reject — must NOT execute the tool
    const spy = installMockFetch({ turns: [] });
    const r2 = callModel({
      ...KEY,
      model: "m",
      input: "rm",
      tools: [deleteFile],
      state,
    });
    expect(await r2.requiresApproval()).toBe(true);
    expect(await r2.getPendingToolCalls()).toHaveLength(1);
    expect(spy.bodies.length).toBe(0); // no model turn, tool never ran
  });

  it("a freshly emitted manual tool still pauses despite a resume approval list", async () => {
    const state = new InMemoryStateAccessor();
    installMockFetch({
      turns: [
        {
          toolCalls: [{ id: "c1", name: "delete_file", args: { path: "/a" } }],
          usage: u(1, 1),
        },
      ],
    });
    await callModel({
      ...KEY,
      model: "m",
      input: "rm",
      tools: [deleteFile],
      state,
    }).getResponse();
    vi.unstubAllGlobals();
    // resume approves c1; the model then requests a NEW manual call c2
    installMockFetch({
      turns: [
        {
          toolCalls: [{ id: "c2", name: "delete_file", args: { path: "/b" } }],
          usage: u(1, 1),
        },
      ],
    });
    const r2 = callModel({
      ...KEY,
      model: "m",
      input: "rm",
      tools: [deleteFile],
      state,
      approveToolCalls: ["c1"],
    });
    expect(await r2.requiresApproval()).toBe(true);
    const pending = await r2.getPendingToolCalls();
    expect(pending[0].id).toBe("c2"); // c1's approval must NOT bypass the new c2
  });
});

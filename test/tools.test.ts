import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	callModel,
	isAutoResolvableTool,
	isHITLTool,
	isManualTool,
	isTool,
	tool,
} from "../src/index.js";
import { installMockFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());
const KEY = { apiKey: "sk-test-1234567890" };
const u = (p: number, c: number) => ({
	prompt_tokens: p,
	completion_tokens: c,
	total_tokens: p + c,
});

describe("tool definition", () => {
	it("builds a JSON schema from the zod input schema", () => {
		const t = tool({
			name: "search",
			description: "search the web",
			inputSchema: z.object({
				query: z.string().describe("the query"),
				limit: z.number().optional(),
			}),
			execute: async () => "",
		});
		expect(isTool(t)).toBe(true);
		expect(t.jsonSchema.type).toBe("object");
		expect(t.jsonSchema.properties?.query.type).toBe("string");
		expect(t.jsonSchema.properties?.query.description).toBe("the query");
		expect(t.jsonSchema.required).toEqual(["query"]); // limit is optional
	});

	it("classifies approval type guards", () => {
		const auto = tool({
			name: "a",
			inputSchema: z.object({}),
			execute: async () => "",
		});
		const manual = tool({
			name: "b",
			inputSchema: z.object({}),
			execute: async () => "",
			requireApproval: true,
		});
		const cond = tool({
			name: "c",
			inputSchema: z.object({}),
			execute: async () => "",
			requireApproval: () => true,
		});
		expect(isAutoResolvableTool(auto)).toBe(true);
		expect(isHITLTool(auto)).toBe(false);
		expect(isManualTool(manual)).toBe(true);
		expect(isHITLTool(manual)).toBe(true);
		expect(isManualTool(cond)).toBe(false);
		expect(isHITLTool(cond)).toBe(true);
	});
});

describe("tool execution error feedback", () => {
	it("feeds a zod validation error back to the model instead of throwing", async () => {
		const t = tool({
			name: "add",
			inputSchema: z.object({ a: z.number(), b: z.number() }),
			execute: async ({ a, b }) => a + b,
		});
		const spy = installMockFetch({
			turns: [
				// model sends a string where a number is required
				{
					toolCalls: [{ id: "c1", name: "add", args: { a: "x", b: 2 } }],
					usage: u(1, 1),
				},
				{ content: "fixed", usage: u(1, 1) },
			],
		});
		const r = callModel({ ...KEY, model: "m", input: "add", tools: [t] });
		expect(await r.getText()).toBe("fixed");
		const toolMsg = spy.bodies[1].messages.find((m: any) => m.role === "tool");
		expect(JSON.parse(toolMsg.content).error).toMatch(/Invalid arguments/);
	});

	it("captures a thrown execute error as a tool result", async () => {
		const t = tool({
			name: "boom",
			inputSchema: z.object({}),
			execute: async () => {
				throw new Error("kaboom sk-secretkey1234");
			},
		});
		const spy = installMockFetch({
			turns: [
				{ toolCalls: [{ id: "c1", name: "boom", args: {} }], usage: u(1, 1) },
				{ content: "recovered", usage: u(1, 1) },
			],
		});
		const r = callModel({ ...KEY, model: "m", input: "go", tools: [t] });
		await r.getText();
		const toolMsg = spy.bodies[1].messages.find((m: any) => m.role === "tool");
		const err = JSON.parse(toolMsg.content).error;
		expect(err).toMatch(/kaboom/);
		// secret in the error must be redacted
		expect(err).not.toContain("sk-secretkey1234");
	});

	it("reports an unknown tool back to the model with secrets redacted", async () => {
		const spy = installMockFetch({
			turns: [
				// a malicious/odd tool name containing a key-like token
				{
					toolCalls: [{ id: "c1", name: "ghost-sk-secretkey1234", args: {} }],
					usage: u(1, 1),
				},
				{ content: "ok", usage: u(1, 1) },
			],
		});
		const r = callModel({ ...KEY, model: "m", input: "go", tools: [] });
		await r.getText();
		const toolMsg = spy.bodies[1].messages.find((m: any) => m.role === "tool");
		const err = JSON.parse(toolMsg.content).error;
		expect(err).toMatch(/Unknown tool/);
		expect(err).not.toContain("sk-secretkey1234");
	});
});

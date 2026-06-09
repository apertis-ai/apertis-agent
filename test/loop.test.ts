import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callModel, tool } from "../src/index.js";
import { installMockFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const KEY = { apiKey: "sk-test-1234567890" };

describe("agent loop", () => {
	it("converges in one step with no tools", async () => {
		installMockFetch({ turns: [{ content: "Hello world", usage: u(3, 2) }] });
		const result = callModel({ ...KEY, model: "gpt-5.2", input: "hi" });
		expect(await result.getText()).toBe("Hello world");
		const res = await result.getResponse();
		expect(res.status).toBe("complete");
		expect(res.steps).toHaveLength(1);
		expect(res.usage.total_tokens).toBe(5);
	});

	it("runs a tool then produces a final answer (multi-round)", async () => {
		const weather = tool({
			name: "get_weather",
			description: "weather",
			inputSchema: z.object({ city: z.string() }),
			execute: async ({ city }) => ({ city, tempC: 21 }),
		});
		const spy = installMockFetch({
			turns: [
				{
					toolCalls: [
						{ id: "c1", name: "get_weather", args: { city: "Taipei" } },
					],
					usage: u(10, 5),
				},
				{ content: "It is 21C in Taipei.", usage: u(8, 6) },
			],
		});
		const result = callModel({
			...KEY,
			model: "claude-sonnet-4-6",
			input: "weather?",
			tools: [weather],
		});
		expect(await result.getText()).toBe("It is 21C in Taipei.");
		const res = await result.getResponse();
		expect(res.steps).toHaveLength(2);
		// second request body must include the tool result message
		const secondBody = spy.bodies[1];
		const toolMsg = secondBody.messages.find((m: any) => m.role === "tool");
		expect(toolMsg).toBeTruthy();
		expect(JSON.parse(toolMsg.content).tempC).toBe(21);
		// cumulative usage
		expect(res.usage.total_tokens).toBe(15 + 14);
	});

	it("captures web_sources chunk", async () => {
		installMockFetch({
			turns: [
				{
					content: "answer",
					webSources: [{ title: "t", url: "https://x", snippet: "s" }],
					usage: u(1, 1),
				},
			],
		});
		const result = callModel({ ...KEY, model: "gpt-4o-mini:web", input: "q" });
		const res = await result.getResponse();
		expect(res.webSources).toHaveLength(1);
		expect(res.webSources[0].url).toBe("https://x");
	});

	it("enforces an absolute step backstop", async () => {
		// every turn calls a tool forever; default stopWhen guard = stepCountIs(20)
		const loop = tool({
			name: "again",
			inputSchema: z.object({}),
			execute: async () => "ok",
		});
		installMockFetch({
			turns: Array.from({ length: 40 }, () => ({
				toolCalls: [{ id: "c", name: "again", args: {} }],
				usage: u(1, 1),
			})),
		});
		const result = callModel({
			...KEY,
			model: "m",
			input: "go",
			tools: [loop],
		});
		const res = await result.getResponse();
		expect(res.steps.length).toBeLessThanOrEqual(20);
	});
});

function u(p: number, c: number, cost?: number) {
	return {
		prompt_tokens: p,
		completion_tokens: c,
		total_tokens: p + c,
		...(cost !== undefined ? { cost } : {}),
	};
}

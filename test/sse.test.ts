import { afterEach, describe, expect, it, vi } from "vitest";
import { callModel } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());
const KEY = { apiKey: "sk-test-1234567890" };

function rawSseResponse(raw: string): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(raw));
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}

describe("SSE parser robustness", () => {
	it("flushes the final event when the stream ends without [DONE] or a trailing newline", async () => {
		const chunk = JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			choices: [
				{ index: 0, delta: { content: "hello" }, finish_reason: "stop" },
			],
		});
		const usage = JSON.stringify({
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			choices: [],
		});
		// note: no [DONE] sentinel and no trailing newline after the last data line
		const raw = `data: ${chunk}\n\ndata: ${usage}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => rawSseResponse(raw)),
		);
		const r = callModel({ ...KEY, model: "m", input: "hi" });
		const res = await r.getResponse();
		expect(res.text).toBe("hello");
		expect(res.usage.total_tokens).toBe(2); // final usage event was flushed at EOF
	});

	it("yields a non-JSON data line as __raw without crashing the loop", async () => {
		const chunk = JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		});
		// a bare non-JSON data line (e.g. a search prefix) precedes the real chunk
		const raw = `data: 🔍 searching\n\ndata: ${chunk}\n\ndata: [DONE]\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => rawSseResponse(raw)),
		);
		const r = callModel({ ...KEY, model: "m", input: "hi" });
		expect(await r.getText()).toBe("ok");
	});
});

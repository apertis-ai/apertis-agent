import { vi } from "vitest";

export interface MockTurn {
	content?: string;
	reasoning?: string;
	toolCalls?: Array<{ id: string; name: string; args: unknown }>;
	finishReason?: string;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		cost?: number;
	};
	webSources?: Array<{ title?: string; url?: string; snippet?: string }>;
	/** if set >= 400, respond with an HTTP error instead of an SSE stream */
	status?: number;
	body?: string;
}

function chunk(choice: Record<string, unknown>): string {
	const obj = {
		id: "cmpl",
		object: "chat.completion.chunk",
		choices: [{ index: 0, ...choice }],
	};
	return `data: ${JSON.stringify(obj)}\n\n`;
}

export function turnFrames(turn: MockTurn): string[] {
	const frames: string[] = [];
	if (turn.reasoning)
		frames.push(chunk({ delta: { reasoning_content: turn.reasoning } }));
	if (turn.content) frames.push(chunk({ delta: { content: turn.content } }));
	if (turn.toolCalls) {
		turn.toolCalls.forEach((tc, i) =>
			frames.push(
				chunk({
					delta: {
						tool_calls: [
							{
								index: i,
								id: tc.id,
								type: "function",
								function: { name: tc.name, arguments: JSON.stringify(tc.args) },
							},
						],
					},
				}),
			),
		);
	}
	frames.push(
		chunk({
			delta: {},
			finish_reason:
				turn.finishReason ?? (turn.toolCalls ? "tool_calls" : "stop"),
		}),
	);
	if (turn.webSources)
		frames.push(
			`data: ${JSON.stringify({ web_sources: turn.webSources })}\n\n`,
		);
	if (turn.usage)
		frames.push(
			`data: ${JSON.stringify({ usage: turn.usage, choices: [] })}\n\n`,
		);
	return frames;
}

function sseResponse(frames: string[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const enc = new TextEncoder();
			for (const f of frames) controller.enqueue(enc.encode(f));
			controller.enqueue(enc.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

export interface InstallOptions {
	turns: MockTurn[];
	/** sequence of used_quota_usd values returned by GET /token/usage */
	usagePolls?: number[];
	/** make /token/usage fail */
	usageFails?: boolean;
}

export interface FetchSpy {
	fetch: ReturnType<typeof vi.fn>;
	bodies: any[];
	urls: string[];
	authHeaders: string[];
	userAgents: string[];
}

export function installMockFetch(opts: InstallOptions): FetchSpy {
	const turnQueue = [...opts.turns];
	const usageQueue = [...(opts.usagePolls ?? [])];
	const spy: FetchSpy = {
		fetch: vi.fn(),
		bodies: [],
		urls: [],
		authHeaders: [],
		userAgents: [],
	};

	spy.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
		const u = String(url);
		spy.urls.push(u);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		spy.authHeaders.push(headers.Authorization ?? "");
		spy.userAgents.push(headers["User-Agent"] ?? "");
		if (u.includes("/token/usage")) {
			if (opts.usageFails) return new Response("err", { status: 500 });
			const used = usageQueue.shift() ?? 0;
			return new Response(
				JSON.stringify({ success: true, data: { used_quota_usd: used } }),
				{
					status: 200,
				},
			);
		}
		if (init?.body) spy.bodies.push(JSON.parse(init.body as string));
		const turn = turnQueue.shift();
		if (!turn) throw new Error("mock: no more turns queued");
		if (turn.status && turn.status >= 400) {
			return new Response(turn.body ?? "error", { status: turn.status });
		}
		return sseResponse(turnFrames(turn));
	});

	vi.stubGlobal("fetch", spy.fetch);
	return spy;
}

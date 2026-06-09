/**
 * Thin HTTP client over the Apertis OpenAI-compatible API.
 * Native fetch only. Streaming is exposed as an async iterator of SSE data lines.
 */

import { BROWSER_USER_AGENT, type ResolvedConfig } from "./config.js";
import { ApertisAgentError, errorFromStatus } from "./errors.js";

/** SSE stream terminator sentinel. */
const DONE = Symbol("done");

export interface ChatCompletionBody {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  reasoning?: unknown;
  [k: string]: unknown;
}

export class ApertisHttpClient {
  constructor(private readonly cfg: ResolvedConfig) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": BROWSER_USER_AGENT,
      ...this.cfg.headers,
    };
  }

  /** Raw fetch to /chat/completions. */
  async chatCompletionRaw(
    body: ChatCompletionBody,
    signal?: AbortSignal,
  ): Promise<Response> {
    let resp: Response;
    try {
      resp = await fetch(`${this.cfg.baseURL}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted)
        throw new ApertisAgentError("aborted", "Request aborted");
      throw new ApertisAgentError(
        "network",
        `Network error: ${(err as Error).message}`,
      );
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw errorFromStatus(resp.status, text);
    }
    return resp;
  }

  /**
   * Streaming completion → async iterator of parsed `data:` payloads.
   * Yields each JSON object after `data: `; skips `[DONE]`. Non-JSON data
   * (e.g. the web-search prefix) is yielded as `{ __raw: string }`.
   */
  async *chatCompletionStream(
    body: ChatCompletionBody,
    signal?: AbortSignal,
  ): AsyncGenerator<any> {
    const resp = await this.chatCompletionRaw(
      {
        ...body,
        stream: true,
        stream_options: { include_usage: true, ...body.stream_options },
      },
      signal,
    );
    if (!resp.body)
      throw new ApertisAgentError("server", "Empty streaming response body");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    // Process one SSE line; returns a parsed event to yield, the DONE
    // sentinel, or null. `data:` lines accumulate until a blank line dispatches
    // the event (per the SSE spec — events may span multiple data lines).
    const onLine = (line: string): typeof DONE | { value: any } | null => {
      if (line === "") {
        if (dataLines.length === 0) return null;
        const data = dataLines.join("\n");
        dataLines = [];
        if (data === "[DONE]") return DONE;
        try {
          return { value: JSON.parse(data) };
        } catch {
          return { value: { __raw: data } };
        }
      }
      if (line.startsWith("data:"))
        dataLines.push(line.slice(5).replace(/^ /, ""));
      // other SSE fields (event:, id:, : comments) are ignored
      return null;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          const ev = onLine(line);
          if (ev === DONE) return;
          if (ev) yield ev.value;
        }
      }
      // EOF: flush any trailing line + a final event without a blank terminator.
      if (buffer.length > 0) {
        const ev = onLine(buffer.replace(/\r$/, ""));
        if (ev && ev !== DONE) yield ev.value;
      }
      const tail = onLine("");
      if (tail && tail !== DONE) yield tail.value;
    } finally {
      reader.releaseLock();
    }
  }

  /** GET /token/usage → cumulative used_quota_usd for the key. */
  async getUsage(
    signal?: AbortSignal,
  ): Promise<{ used_quota_usd: number } | null> {
    try {
      const resp = await fetch(`${this.cfg.baseURL}/token/usage`, {
        method: "GET",
        headers: this.headers(),
        signal,
      });
      if (!resp.ok) return null;
      const json = (await resp.json()) as {
        data?: { used_quota_usd?: number };
      };
      const used = json?.data?.used_quota_usd;
      return typeof used === "number" ? { used_quota_usd: used } : null;
    } catch {
      return null;
    }
  }
}

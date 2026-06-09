/**
 * Message format converters. The native format here is OpenAI chat-completions
 * messages. These helpers bridge to/from a simplified Claude (Anthropic Messages)
 * shape, mirroring @openrouter/agent's fromClaudeMessages/toClaudeMessage and
 * the OpenAI converters (which are identity for us, since chat-completions IS
 * our native format).
 */

import type { Message } from "./types.js";

/** OpenAI chat messages are our native format — identity, but typed + cloned. */
export function fromChatMessages(messages: Message[]): Message[] {
  return messages.map((m) => ({ ...m }));
}

export function toChatMessage(message: Message): Message {
  return { ...message };
}

interface ClaudeContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

/** Convert Anthropic Messages-format history into chat-completions messages. */
export function fromClaudeMessages(messages: ClaudeMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const textParts: string[] = [];
    const toolCalls: NonNullable<Message["tool_calls"]> = [];
    for (const block of m.content) {
      if (block.type === "text" && block.text) textParts.push(block.text);
      else if (block.type === "tool_use" && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content:
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content),
        });
      }
    }
    if (textParts.length || toolCalls.length) {
      const msg: Message = {
        role: m.role,
        content: textParts.join("\n") || null,
      };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
}

/** Convert a chat-completions message into Anthropic Messages format. */
export function toClaudeMessage(message: Message): ClaudeMessage {
  const role: "user" | "assistant" =
    message.role === "assistant" ? "assistant" : "user";
  if (message.tool_calls?.length) {
    const blocks: ClaudeContentBlock[] = [];
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const tc of message.tool_calls) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        /* keep {} */
      }
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
    return { role, content: blocks };
  }
  if (message.role === "tool" && message.tool_call_id) {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: message.content ?? "",
        },
      ],
    };
  }
  return { role, content: message.content ?? "" };
}

/** Normalize a free-form input (string or messages) into chat messages. */
export function normalizeInput(
  input: string | Message[],
  instructions?: string,
): Message[] {
  const messages: Message[] = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  if (typeof input === "string")
    messages.push({ role: "user", content: input });
  else messages.push(...input.map((m) => ({ ...m })));
  return messages;
}

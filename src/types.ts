/**
 * Core wire types for the Apertis chat-completions API (OpenAI-compatible).
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  content: string | null;
  /** present on tool-role messages */
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** reasoning models stream this in deltas; preserved for multi-turn history */
  reasoning_content?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Apertis additive: measured cost in USD for the request (may be absent). */
  cost?: number;
}

export interface WebSource {
  title?: string;
  url?: string;
  snippet?: string;
}

/** A tool call parsed out of an assistant message, with decoded arguments. */
export interface ParsedToolCall {
  id: string;
  name: string;
  /** raw JSON string as returned by the model */
  argumentsRaw: string;
  /** parsed arguments (may be undefined if JSON was invalid) */
  arguments: unknown;
}

/** One turn of the agent loop. */
export interface Step {
  /** the assistant message produced this step */
  message: Message;
  /** tool calls requested by the assistant this step */
  toolCalls: ParsedToolCall[];
  /** cumulative usage through this step */
  usage: Usage;
  /** cumulative measured cost (USD) through this step; null if unknown */
  cost: number | null;
  finishReason: string | null;
}

export type ConversationStatus =
  | "in_progress"
  | "awaiting_approval"
  | "complete"
  | "error";

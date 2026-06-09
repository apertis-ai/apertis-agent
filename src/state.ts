/**
 * Client-side conversation state for pause/resume (tool approval) and
 * persistence. Apertis stores no state server-side — exactly like @openrouter/agent.
 * Bring your own StateAccessor (Redis, DB, file, in-memory) to survive restarts.
 */

import type {
  ConversationStatus,
  Message,
  ParsedToolCall,
  Usage,
} from "./types.js";

export interface ConversationState {
  messages: Message[];
  /** tool calls awaiting approval/rejection on resume */
  pendingToolCalls: ParsedToolCall[];
  /** executed tool results not yet sent to the model (rare; partial interrupts) */
  unsentToolResults: Message[];
  status: ConversationStatus;
  /** cumulative usage so far */
  usage: Usage;
  /** cumulative measured cost so far (USD); null if unknown */
  cost: number | null;
  /** number of completed steps so far */
  stepCount: number;
}

export interface StateAccessor {
  /** Load the current conversation state, or null if none exists. */
  load(): Promise<ConversationState | null> | ConversationState | null;
  /** Save the conversation state. */
  save(state: ConversationState): Promise<void> | void;
}

/** Simple in-memory StateAccessor. NOT durable — for tests/single-process use. */
export class InMemoryStateAccessor implements StateAccessor {
  private state: ConversationState | null = null;
  load(): ConversationState | null {
    return this.state;
  }
  save(state: ConversationState): void {
    this.state = state;
  }
}

export function emptyState(messages: Message[]): ConversationState {
  return {
    messages,
    pendingToolCalls: [],
    unsentToolResults: [],
    status: "in_progress",
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    cost: null,
    stepCount: 0,
  };
}

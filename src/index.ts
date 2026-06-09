/**
 * @apertis/agent — agent runtime for Apertis.
 *
 * Multi-step tool loops, stop conditions (incl. measured maxCost), streaming,
 * tool approval, and client-side state persistence over the Apertis
 * OpenAI-compatible API. Drop-in shape for @openrouter/agent.
 */

export { callModel, ModelResult } from "./call-model.js";
export type {
  CallModelOptions,
  AgentEvent,
  FinalResult,
} from "./call-model.js";

export { createCallModel } from "./factory.js";

export {
  tool,
  isTool,
  isHITLTool,
  isManualTool,
  isAutoResolvableTool,
} from "./tool.js";
export type { Tool, ToolDefinition, ToolExecuteContext } from "./tool.js";

export {
  stepCountIs,
  hasToolCall,
  maxTokensUsed,
  maxCost,
  finishReasonIs,
} from "./stop-conditions.js";
export type { StopCondition, StopConditionInput } from "./stop-conditions.js";

export {
  fromChatMessages,
  toChatMessage,
  fromClaudeMessages,
  toClaudeMessage,
  normalizeInput,
} from "./converters.js";
export type { ClaudeMessage } from "./converters.js";

export { ToolContextStore, buildToolExecuteContext } from "./context-store.js";
export type { ToolContextMap } from "./context-store.js";

export { InMemoryStateAccessor, emptyState } from "./state.js";
export type { StateAccessor, ConversationState } from "./state.js";

export { ApertisAgentError, redactSecrets } from "./errors.js";
export type { ApertisErrorKind } from "./errors.js";

export { DEFAULT_BASE_URL } from "./config.js";
export type { ApertisConfig } from "./config.js";

export type {
  Message,
  Role,
  ToolCall,
  ParsedToolCall,
  Usage,
  Step,
  WebSource,
  ConversationStatus,
} from "./types.js";

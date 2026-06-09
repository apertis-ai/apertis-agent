/**
 * Per-tool execution context. callModel({ context }) may pass either a single
 * value shared by all tools, or a map keyed by tool name. ToolContextStore
 * resolves the value a given tool sees, and records updates tools push back.
 */

export type ToolContextMap = Record<string, unknown>;

export class ToolContextStore {
  private updates: Array<{ tool: string; value: unknown }> = [];

  constructor(private readonly context?: unknown) {}

  /** Resolve the context value visible to `toolName`. */
  resolve(toolName: string): unknown {
    if (
      this.context &&
      typeof this.context === "object" &&
      !Array.isArray(this.context)
    ) {
      const map = this.context as ToolContextMap;
      if (Object.prototype.hasOwnProperty.call(map, toolName))
        return map[toolName];
    }
    return this.context;
  }

  /** Record a context update emitted during a tool's execution. */
  recordUpdate(toolName: string, value: unknown): void {
    this.updates.push({ tool: toolName, value });
  }

  /** Snapshot of all context updates so far. */
  snapshot(): Array<{ tool: string; value: unknown }> {
    return [...this.updates];
  }
}

/** Build the ToolExecuteContext value passed to a tool's execute(). */
export function buildToolExecuteContext(
  store: ToolContextStore,
  toolName: string,
  toolCallId: string,
  signal?: AbortSignal,
): { toolCallId: string; context: unknown; signal?: AbortSignal } {
  return { toolCallId, context: store.resolve(toolName), signal };
}

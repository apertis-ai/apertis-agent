/**
 * Tool definition factory + type guards.
 *
 * A tool wraps a Zod input schema and an execute function. Tools may require
 * human approval before execution (HITL), either always (`requireApproval: true`)
 * or conditionally (`requireApproval: (input) => boolean`).
 */

import type { ZodTypeAny, infer as zInfer } from "zod";
import { type JsonSchema, zodToJsonSchema } from "./json-schema.js";

export interface ToolExecuteContext {
  /** id of the tool call being executed */
  toolCallId: string;
  /** arbitrary per-call context injected via callModel({ context }) */
  context?: unknown;
  /** abort signal for the overall run */
  signal?: AbortSignal;
}

export interface ToolDefinition<Schema extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description?: string;
  inputSchema: Schema;
  execute: (
    input: zInfer<Schema>,
    ctx: ToolExecuteContext,
  ) => unknown | Promise<unknown>;
  /** true, or a predicate, to pause the loop for approval before executing */
  requireApproval?:
    | boolean
    | ((input: zInfer<Schema>) => boolean | Promise<boolean>);
}

export interface Tool<Schema extends ZodTypeAny = ZodTypeAny>
  extends ToolDefinition<Schema> {
  readonly __apertisTool: true;
  /** JSON schema derived from inputSchema, for the function-calling request */
  readonly jsonSchema: JsonSchema;
}

/**
 * Erased tool type for heterogeneous collections. `Tool<Schema>` is invariant in
 * Schema (it both produces and consumes the inferred input), so a `Tool[]` cannot
 * hold tools with different concrete schemas. AnyTool is a non-generic structural
 * supertype (execute takes `any`), so any concrete `Tool<Schema>` assigns to it.
 */
export interface AnyTool {
  name: string;
  description?: string;
  inputSchema: ZodTypeAny;
  execute: (input: any, ctx: ToolExecuteContext) => unknown | Promise<unknown>;
  requireApproval?: boolean | ((input: any) => boolean | Promise<boolean>);
  readonly __apertisTool: true;
  readonly jsonSchema: JsonSchema;
}

export function tool<Schema extends ZodTypeAny>(
  def: ToolDefinition<Schema>,
): Tool<Schema> {
  if (!def.name) throw new Error("tool() requires a name");
  return {
    ...def,
    __apertisTool: true,
    jsonSchema: zodToJsonSchema(def.inputSchema),
  };
}

export function isTool(value: unknown): value is Tool {
  return (
    Boolean(value) &&
    (value as { __apertisTool?: boolean }).__apertisTool === true
  );
}

/** A tool that may pause the loop for approval (HITL = human in the loop). */
export function isHITLTool(t: AnyTool): boolean {
  return t.requireApproval !== undefined && t.requireApproval !== false;
}

/** A tool whose approval is unconditional (`requireApproval: true`). */
export function isManualTool(t: AnyTool): boolean {
  return t.requireApproval === true;
}

/** A tool that always runs without approval. */
export function isAutoResolvableTool(t: AnyTool): boolean {
  return t.requireApproval === undefined || t.requireApproval === false;
}

/** Build the OpenAI function-calling `tools` array from Apertis tools. */
export function toolsToRequestFormat(tools: AnyTool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.jsonSchema,
    },
  }));
}

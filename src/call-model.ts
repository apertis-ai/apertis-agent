/**
 * callModel — the agentic loop.
 *
 * Streams the completion, accumulates the assistant message (text, reasoning,
 * tool calls), executes tools, feeds results back, and repeats until a stop
 * condition fires or the model stops calling tools. Returns a ModelResult whose
 * getters expose text/streams/steps and approval state.
 */

import { ApertisHttpClient } from "./client.js";
import { type ApertisConfig, resolveConfig } from "./config.js";
import { ToolContextStore, buildToolExecuteContext } from "./context-store.js";
import { normalizeInput } from "./converters.js";
import { CostTracker } from "./cost.js";
import { ApertisAgentError, redactSecrets } from "./errors.js";
import { EventHub } from "./event-hub.js";
import type { ConversationState, StateAccessor } from "./state.js";
import {
  type StopCondition,
  needsCost,
  shouldStop,
  stepCountIs,
} from "./stop-conditions.js";
import {
  type AnyTool,
  isAutoResolvableTool,
  toolsToRequestFormat,
} from "./tool.js";
import type {
  Message,
  ParsedToolCall,
  Step,
  ToolCall,
  Usage,
  WebSource,
} from "./types.js";

/** Absolute backstop so a misconfigured loop can never run forever. */
const MAX_STEPS = 100;

export interface CallModelOptions extends ApertisConfig {
  model: string;
  /** chat messages; alternatively use `input` (+ optional `instructions`) */
  messages?: Message[];
  input?: string | Message[];
  instructions?: string;
  tools?: AnyTool[];
  stopWhen?: StopCondition[];
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  reasoning?: unknown;
  /** per-tool context, single value or keyed by tool name */
  context?: unknown;
  signal?: AbortSignal;
  /** global override: require approval for every tool call */
  requireApproval?: boolean;
  /** on resume: tool-call ids to approve / reject */
  approveToolCalls?: string[];
  rejectToolCalls?: string[];
  /** persistence + resume source (StateAccessor or a ConversationState) */
  state?: StateAccessor | ConversationState;
}

export interface FinalResult {
  text: string;
  messages: Message[];
  steps: Step[];
  usage: Usage;
  cost: number | null;
  finishReason: string | null;
  status: ConversationState["status"];
  pendingToolCalls: ParsedToolCall[];
  webSources: WebSource[];
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool-call"; toolCall: ParsedToolCall }
  | {
      type: "tool-result";
      toolCallId: string;
      name: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "message"; message: Message }
  | { type: "step"; step: Step }
  | { type: "web-sources"; sources: WebSource[] }
  | { type: "approval-required"; pending: ParsedToolCall[] }
  | { type: "finish"; result: FinalResult };

function isStateAccessor(s: unknown): s is StateAccessor {
  return Boolean(s) && typeof (s as StateAccessor).load === "function";
}

function emptyUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function addUsage(into: Usage, add: Partial<Usage> | undefined): void {
  if (!add) return;
  into.prompt_tokens += add.prompt_tokens ?? 0;
  into.completion_tokens += add.completion_tokens ?? 0;
  into.total_tokens += add.total_tokens ?? 0;
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

/** Merge streamed tool_call deltas (keyed by index) into complete tool calls. */
function accumulateToolCallDeltas(
  acc: Map<number, ToolCallAcc>,
  deltas: any[],
): void {
  for (const d of deltas) {
    const idx = d.index ?? 0;
    const cur = acc.get(idx) ?? { id: "", name: "", arguments: "" };
    if (d.id) cur.id = d.id;
    if (d.function?.name) cur.name += d.function.name;
    if (d.function?.arguments) cur.arguments += d.function.arguments;
    acc.set(idx, cur);
  }
}

function finalizeToolCalls(acc: Map<number, ToolCallAcc>): ToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.arguments },
    }));
}

function parseToolCalls(toolCalls: ToolCall[]): ParsedToolCall[] {
  return toolCalls.map((tc) => {
    let parsed: unknown;
    try {
      parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      parsed = undefined;
    }
    return {
      id: tc.id,
      name: tc.function.name,
      argumentsRaw: tc.function.arguments,
      arguments: parsed,
    };
  });
}

async function executeOneTool(
  tool: AnyTool | undefined,
  call: ParsedToolCall,
  store: ToolContextStore,
  signal: AbortSignal | undefined,
): Promise<{ message: Message; result: unknown; isError: boolean }> {
  const toolMessage = (content: string): Message => ({
    role: "tool",
    tool_call_id: call.id,
    name: call.name,
    content,
  });

  if (!tool) {
    const err = redactSecrets(`Unknown tool: ${call.name}`);
    return {
      message: toolMessage(JSON.stringify({ error: err })),
      result: err,
      isError: true,
    };
  }
  // validate arguments via the tool's zod schema; feed errors back to the model
  const validation = tool.inputSchema.safeParse(call.arguments);
  if (!validation.success) {
    const err = `Invalid arguments: ${validation.error.message}`;
    return {
      message: toolMessage(JSON.stringify({ error: redactSecrets(err) })),
      result: err,
      isError: true,
    };
  }
  try {
    const ctx = buildToolExecuteContext(store, call.name, call.id, signal);
    const result = await tool.execute(validation.data, ctx);
    const content =
      typeof result === "string" ? result : JSON.stringify(result ?? null);
    return { message: toolMessage(content), result, isError: false };
  } catch (err) {
    const msg = redactSecrets((err as Error)?.message ?? String(err));
    return {
      message: toolMessage(JSON.stringify({ error: msg })),
      result: msg,
      isError: true,
    };
  }
}

async function runLoop(
  opts: CallModelOptions,
  hub: EventHub<AgentEvent>,
  final: FinalResult,
  store: ToolContextStore,
): Promise<void> {
  const client = new ApertisHttpClient(resolveConfig({}, opts));
  const tools = opts.tools ?? [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const stopWhen = opts.stopWhen?.length ? opts.stopWhen : [stepCountIs(20)];

  const accessor = isStateAccessor(opts.state) ? opts.state : undefined;
  const seedState = accessor
    ? await accessor.load()
    : isStateAccessor(opts.state)
      ? null
      : (opts.state ?? null);

  let messages: Message[];
  let stepCount = 0;
  let priorCost = 0;
  const cumUsage = emptyUsage();

  // Resume path: a prior run paused awaiting approval. Resolve ONLY the calls
  // explicitly approved/rejected; any call left unmentioned stays pending and
  // the run re-pauses (it must never auto-execute a side-effect tool).
  if (seedState && seedState.status === "awaiting_approval") {
    messages = seedState.messages.map((m) => ({ ...m }));
    stepCount = seedState.stepCount;
    addUsage(cumUsage, seedState.usage);
    priorCost = seedState.cost ?? 0;
    final.usage = { ...cumUsage };
    final.cost = seedState.cost;
    const approve = new Set(opts.approveToolCalls ?? []);
    const reject = new Set(opts.rejectToolCalls ?? []);
    const stillPending: ParsedToolCall[] = [];
    for (const call of seedState.pendingToolCalls) {
      if (approve.has(call.id)) {
        const r = await executeOneTool(
          toolMap.get(call.name),
          call,
          store,
          opts.signal,
        );
        messages.push(r.message);
        hub.push({
          type: "tool-result",
          toolCallId: call.id,
          name: call.name,
          result: r.result,
          isError: r.isError,
        });
        hub.push({ type: "message", message: r.message });
      } else if (reject.has(call.id)) {
        const msg: Message = {
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify({ error: "Tool call rejected by approver" }),
        };
        messages.push(msg);
        hub.push({
          type: "tool-result",
          toolCallId: call.id,
          name: call.name,
          result: "rejected",
          isError: true,
        });
        hub.push({ type: "message", message: msg });
      } else {
        stillPending.push(call); // neither approved nor rejected -> stays pending
      }
    }
    final.messages = messages;
    if (stillPending.length > 0) {
      // not all pending calls were resolved — re-pause without calling the model
      final.status = "awaiting_approval";
      final.pendingToolCalls = stillPending;
      hub.push({ type: "approval-required", pending: stillPending });
      if (accessor) {
        await accessor.save({
          messages,
          pendingToolCalls: stillPending,
          unsentToolResults: [],
          status: "awaiting_approval",
          usage: { ...cumUsage },
          cost: priorCost,
          stepCount,
        });
      }
      return;
    }
    // all pending resolved: persist results BEFORE the next model call so a
    // crash/abort cannot re-execute the already-run side-effect tools.
    if (accessor) {
      await accessor.save({
        messages,
        pendingToolCalls: [],
        unsentToolResults: [],
        status: "in_progress",
        usage: { ...cumUsage },
        cost: priorCost,
        stepCount,
      });
    }
  } else {
    messages = normalizeInput(
      opts.input ?? opts.messages ?? [],
      opts.instructions,
    );
  }
  final.messages = messages;

  const costTracker = new CostTracker(
    client,
    needsCost(stopWhen),
    opts.signal,
    priorCost,
  );
  await costTracker.init();

  while (true) {
    if (opts.signal?.aborted)
      throw new ApertisAgentError("aborted", "Run aborted");
    if (stepCount >= MAX_STEPS) {
      final.finishReason = "max_steps";
      break;
    }
    stepCount++;

    const body = {
      model: opts.model,
      messages,
      ...(tools.length ? { tools: toolsToRequestFormat(tools) } : {}),
      ...(opts.toolChoice !== undefined
        ? { tool_choice: opts.toolChoice }
        : {}),
      ...(opts.parallelToolCalls !== undefined
        ? { parallel_tool_calls: opts.parallelToolCalls }
        : {}),
      ...(opts.temperature !== undefined
        ? { temperature: opts.temperature }
        : {}),
      ...(opts.maxOutputTokens !== undefined
        ? { max_tokens: opts.maxOutputTokens }
        : {}),
      ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
      ...(opts.reasoning !== undefined ? { reasoning: opts.reasoning } : {}),
    };

    let content = "";
    let reasoning = "";
    let finishReason: string | null = null;
    let stepUsage: Usage | undefined;
    const toolAcc = new Map<number, ToolCallAcc>();

    for await (const chunk of client.chatCompletionStream(body, opts.signal)) {
      if (chunk.__raw) continue;
      if (Array.isArray(chunk.web_sources)) {
        final.webSources = chunk.web_sources;
        hub.push({ type: "web-sources", sources: chunk.web_sources });
        continue;
      }
      const choice = chunk.choices?.[0];
      if (choice) {
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          hub.push({ type: "text", delta: delta.content });
        }
        if (
          typeof delta.reasoning_content === "string" &&
          delta.reasoning_content
        ) {
          reasoning += delta.reasoning_content;
          hub.push({ type: "reasoning", delta: delta.reasoning_content });
        }
        if (Array.isArray(delta.tool_calls))
          accumulateToolCallDeltas(toolAcc, delta.tool_calls);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (chunk.usage) stepUsage = chunk.usage as Usage;
    }

    const toolCalls = finalizeToolCalls(toolAcc);
    const assistantMsg: Message = {
      role: "assistant",
      content: content || null,
    };
    if (reasoning) assistantMsg.reasoning_content = reasoning;
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    messages.push(assistantMsg);
    hub.push({ type: "message", message: assistantMsg });
    if (content) final.text = content;

    addUsage(cumUsage, stepUsage);
    final.usage = { ...cumUsage };
    const { cost, known } = await costTracker.record(stepUsage?.cost);
    final.cost = cost;

    const parsed = parseToolCalls(toolCalls);
    for (const p of parsed) hub.push({ type: "tool-call", toolCall: p });
    const step: Step = {
      message: assistantMsg,
      toolCalls: parsed,
      usage: { ...cumUsage },
      cost,
      finishReason,
    };
    final.steps.push(step);
    hub.push({ type: "step", step });

    const stop = shouldStop(stopWhen, {
      stepCount,
      usage: cumUsage,
      cost,
      costKnown: known,
      finishReason,
      toolCalls: parsed,
    });
    // Evaluate stop BEFORE executing tools. Include the absolute backstop so a
    // side-effect tool on the final allowed step is never run-and-discarded.
    if (stop || stepCount >= MAX_STEPS) {
      final.finishReason = stop ? finishReason : "max_steps";
      break;
    }
    if (parsed.length === 0) {
      final.finishReason = finishReason ?? "stop";
      break;
    }

    // Approval gate. opts.approveToolCalls applies ONLY to the resume of a
    // prior pending set (handled above) — never to tool calls generated in
    // this turn, so a freshly emitted manual tool always pauses for approval.
    const pending: ParsedToolCall[] = [];
    const toExecute: ParsedToolCall[] = [];
    for (const p of parsed) {
      const t = toolMap.get(p.name);
      const requires =
        opts.requireApproval === true || (t ? !isAutoResolvableTool(t) : false);
      if (requires) pending.push(p);
      else toExecute.push(p);
    }
    if (pending.length) {
      final.status = "awaiting_approval";
      final.pendingToolCalls = pending;
      hub.push({ type: "approval-required", pending });
      if (accessor) {
        await accessor.save({
          messages,
          pendingToolCalls: pending,
          unsentToolResults: [],
          status: "awaiting_approval",
          usage: { ...cumUsage },
          cost,
          stepCount,
        });
      }
      return;
    }

    const results = await Promise.all(
      toExecute.map((p) =>
        executeOneTool(toolMap.get(p.name), p, store, opts.signal),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      messages.push(r.message);
      hub.push({
        type: "tool-result",
        toolCallId: toExecute[i].id,
        name: toExecute[i].name,
        result: r.result,
        isError: r.isError,
      });
      hub.push({ type: "message", message: r.message });
    }
  }

  final.status = "complete";
  if (accessor) {
    await accessor.save({
      messages,
      pendingToolCalls: [],
      unsentToolResults: [],
      status: "complete",
      usage: final.usage,
      cost: final.cost,
      stepCount,
    });
  }
}

export class ModelResult {
  /** populated when the loop finishes (await any terminal getter first) */
  steps: Step[];
  messages: Message[];
  usage: Usage;
  cost: number | null;

  constructor(
    private readonly hub: EventHub<AgentEvent>,
    private readonly final: FinalResult,
    private readonly runPromise: Promise<void>,
    private readonly controller: AbortController,
  ) {
    this.steps = final.steps;
    this.messages = final.messages;
    this.usage = final.usage;
    this.cost = final.cost;
    // keep public fields in sync once the run settles
    void this.runPromise.then(
      () => this.sync(),
      () => this.sync(),
    );
  }

  private sync(): void {
    this.steps = this.final.steps;
    this.messages = this.final.messages;
    this.usage = this.final.usage;
    this.cost = this.final.cost;
  }

  /** Final answer text (last assistant content). */
  async getText(): Promise<string> {
    await this.runPromise;
    return this.final.text;
  }

  /** Full result snapshot. */
  async getResponse(): Promise<FinalResult> {
    await this.runPromise;
    return { ...this.final };
  }

  /** All tool calls across all steps. */
  async getToolCalls(): Promise<ParsedToolCall[]> {
    await this.runPromise;
    return this.final.steps.flatMap((s) => s.toolCalls);
  }

  async *getTextStream(): AsyncGenerator<string> {
    for await (const e of this.hub.stream())
      if (e.type === "text") yield e.delta;
  }

  async *getReasoningStream(): AsyncGenerator<string> {
    for await (const e of this.hub.stream())
      if (e.type === "reasoning") yield e.delta;
  }

  async *getToolCallsStream(): AsyncGenerator<ParsedToolCall> {
    for await (const e of this.hub.stream())
      if (e.type === "tool-call") yield e.toolCall;
  }

  /** tool-call and tool-result events interleaved. */
  async *getToolStream(): AsyncGenerator<
    Extract<AgentEvent, { type: "tool-call" | "tool-result" }>
  > {
    for await (const e of this.hub.stream()) {
      if (e.type === "tool-call" || e.type === "tool-result") yield e;
    }
  }

  /** Cumulative message-history snapshot after each new message. */
  async *getNewMessagesStream(): AsyncGenerator<Message> {
    for await (const e of this.hub.stream())
      if (e.type === "message") yield e.message;
  }

  /** Every event, in order — the firehose. */
  async *getFullResponsesStream(): AsyncGenerator<AgentEvent> {
    yield* this.hub.stream();
  }

  /** Context updates pushed by tools during execution. */
  async getContextUpdates(): Promise<Array<{ tool: string; value: unknown }>> {
    await this.runPromise;
    return (
      (
        this.final as FinalResult & { contextStore?: ToolContextStore }
      ).contextStore?.snapshot?.() ?? []
    );
  }

  /** True if the run paused awaiting tool approval. */
  async requiresApproval(): Promise<boolean> {
    await this.runPromise;
    return this.final.status === "awaiting_approval";
  }

  async getPendingToolCalls(): Promise<ParsedToolCall[]> {
    await this.runPromise;
    return this.final.pendingToolCalls;
  }

  /** Abort the run and any in-flight request. */
  async cancel(): Promise<void> {
    this.controller.abort();
    await this.runPromise.catch(() => undefined);
  }
}

export function callModel(opts: CallModelOptions): ModelResult {
  const hub = new EventHub<AgentEvent>();
  const controller = new AbortController();
  // chain caller's signal into our controller
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else
      opts.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }
  const store = new ToolContextStore(opts.context);
  const final: FinalResult & { contextStore?: ToolContextStore } = {
    text: "",
    messages: [],
    steps: [],
    usage: emptyUsage(),
    cost: null,
    finishReason: null,
    status: "in_progress",
    pendingToolCalls: [],
    webSources: [],
    contextStore: store,
  };

  const runPromise = runLoop(
    { ...opts, signal: controller.signal },
    hub,
    final,
    store,
  )
    .then(() => {
      hub.push({ type: "finish", result: { ...final } });
      hub.finish();
    })
    .catch((err) => {
      final.status = "error";
      hub.fail(err);
      throw err;
    });
  // avoid unhandled rejection if the caller never awaits a getter
  void runPromise.catch(() => undefined);

  return new ModelResult(hub, final, runPromise, controller);
}

# @apertis/agent

[![npm](https://img.shields.io/npm/v/@apertis/agent.svg)](https://www.npmjs.com/package/@apertis/agent)
[![CI](https://github.com/apertis-ai/apertis-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/apertis-ai/apertis-agent/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@apertis/agent.svg)](./LICENSE)

Agent runtime for [Apertis](https://apertis.ai?utm_source=apertis-agent&utm_medium=npm&utm_campaign=ecosystem) — multi-step tool loops, stop conditions, streaming, human-in-the-loop approval, and **measured** cost control. Drop-in shape for `@openrouter/agent`, over the Apertis OpenAI-compatible API.

## Why

`callModel` runs the whole agent loop for you: send messages → the model calls tools → execute them → feed results back → repeat, until a stop condition fires or the model stops calling tools. You write tools; the SDK handles the loop, validation, streaming, and state.

The differentiator: `maxCost` stops on **real measured spend**, not a token estimate.

## Install

```bash
npm install @apertis/agent zod
```

```bash
export APERTIS_API_KEY=sk-your-key
```

## Quickstart

```typescript
import { callModel, tool, stepCountIs, maxCost, hasToolCall } from "@apertis/agent";
import { z } from "zod";

const getWeather = tool({
  name: "get_weather",
  description: "Get the weather for a city",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

const result = callModel({
  model: "claude-sonnet-4-6",
  input: "What's the weather in Taipei? Then say done.",
  tools: [getWeather],
  stopWhen: [stepCountIs(10), maxCost(0.5), hasToolCall("done")], // OR — any one stops the loop
});

console.log(await result.getText());
console.log("steps:", (await result.getResponse()).steps.length);
console.log("cost: $", (await result.getResponse()).cost);
```

## Streaming

```typescript
const result = callModel({ model: "gpt-5.2", input: "Write a haiku." });
for await (const delta of result.getTextStream()) process.stdout.write(delta);
```

Also: `getReasoningStream()`, `getToolCallsStream()`, `getToolStream()`, `getNewMessagesStream()`, `getFullResponsesStream()`.

## Stop conditions

| Condition | Stops when |
|---|---|
| `stepCountIs(n)` | the loop has run `n` steps |
| `maxTokensUsed(n)` | cumulative total tokens reach `n` |
| `maxCost(usd)` | **measured** cumulative cost reaches `usd` |
| `hasToolCall(name)` | the model calls the named tool |
| `finishReasonIs(reason)` | the latest `finish_reason` matches |

`stopWhen` combines conditions with OR. With no `stopWhen`, a `stepCountIs(20)` backstop applies; an absolute 100-step cap always holds.

### How `maxCost` measures cost

1. If the API returns `usage.cost` inline, it is used directly.
2. Otherwise the SDK reads the `used_quota_usd` delta from `/v1/token/usage` after each step (one lightweight GET; enabled only when `maxCost` is set).

If cost can't be measured for a step, `maxCost` stops the loop conservatively rather than risk overspend.

## Tool approval (human-in-the-loop)

```typescript
import { InMemoryStateAccessor } from "@apertis/agent";

const state = new InMemoryStateAccessor(); // bring your own (Redis/DB/file) for production

const deleteFile = tool({
  name: "delete_file",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => `deleted ${path}`,
  requireApproval: true,
});

const run = callModel({ model: "m", input: "clean up /tmp", tools: [deleteFile], state });
if (await run.requiresApproval()) {
  const pending = await run.getPendingToolCalls();
  // ... ask a human ...
  const resumed = callModel({
    model: "m", input: "clean up /tmp", tools: [deleteFile], state,
    approveToolCalls: [pending[0].id], // or rejectToolCalls
  });
  console.log(await resumed.getText());
}
```

State persistence is **client-side**: implement `StateAccessor` (`load`/`save`) over Redis, a database, or files to survive process restarts. Apertis stores no agent state server-side.

## Configuration

```typescript
import { createCallModel } from "@apertis/agent";
const callModel = createCallModel({ apiKey: "sk-...", baseURL: "https://api.apertis.ai/v1" });
```

Key precedence: `opts.apiKey` → `APERTIS_API_KEY` → `createCallModel` config.

## Format converters

`fromChatMessages` / `toChatMessage` (native) and `fromClaudeMessages` / `toClaudeMessage` bridge Anthropic Messages-format history into the chat-completions format the loop uses.

## License

Apache-2.0

/**
 * createCallModel — bind a base config (apiKey / baseURL / headers) once and
 * get a callModel that defaults to it. Per-call options still override the base.
 */

import {
  type CallModelOptions,
  type ModelResult,
  callModel,
} from "./call-model.js";
import type { ApertisConfig } from "./config.js";

export function createCallModel(
  base: ApertisConfig,
): (opts: CallModelOptions) => ModelResult {
  return (opts: CallModelOptions) =>
    callModel({
      ...opts,
      apiKey: opts.apiKey ?? base.apiKey,
      baseURL: opts.baseURL ?? base.baseURL,
      headers: { ...base.headers, ...opts.headers },
    });
}

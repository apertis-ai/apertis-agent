/**
 * Configuration and API-key resolution.
 *
 * Key precedence (mirrors @apertis/cli):
 *   explicit opts.apiKey  >  APERTIS_API_KEY env  >  createCallModel config
 */

import { ApertisAgentError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.apertis.ai/v1";

/**
 * Browser User-Agent. Direct hits to api.apertis.ai with a default
 * Node/undici UA are blocked by Cloudflare (error 1010); a browser UA
 * passes. Same gotcha as @apertis/cli and the skills smoke tests.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface ApertisConfig {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

export interface ResolvedConfig {
  apiKey: string;
  baseURL: string;
  headers: Record<string, string>;
}

function readEnvKey(): string | undefined {
  // guard: globalThis.process may be absent in edge runtimes
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  return env?.APERTIS_API_KEY;
}

/** Resolve the effective config, throwing if no key can be found. */
export function resolveConfig(
  base: ApertisConfig,
  override?: ApertisConfig,
): ResolvedConfig {
  const apiKey = override?.apiKey ?? base.apiKey ?? readEnvKey();
  if (!apiKey) {
    throw new ApertisAgentError(
      "auth",
      "No Apertis API key. Pass { apiKey }, call createCallModel({ apiKey }), or set APERTIS_API_KEY.",
    );
  }
  const baseURL = (
    override?.baseURL ??
    base.baseURL ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  return {
    apiKey,
    baseURL,
    headers: { ...base.headers, ...override?.headers },
  };
}

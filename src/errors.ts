/**
 * Error types and secret redaction.
 *
 * Secret handling mirrors the Codex-reviewed approach in @apertis/cli:
 * never let an API key reach an error message or log line.
 */

/** Redact anything that looks like an Apertis API key from a string. */
export function redactSecrets(input: string): string {
  if (!input) return input;
  // sk-... keys (incl. sk-sub-...). URL-safe key grammar; keep a short hint.
  return input.replace(/sk-[A-Za-z0-9._-]{6,}/g, (m) => {
    const last4 = m.slice(-4);
    return `sk-••••${last4}`;
  });
}

export type ApertisErrorKind =
  | "auth" // 401 / invalid key
  | "quota" // insufficient quota / rate limit
  | "model_not_found" // 404 / unknown model
  | "bad_request" // 400
  | "server" // 5xx
  | "network" // fetch threw
  | "aborted" // AbortSignal
  | "unknown";

export class ApertisAgentError extends Error {
  readonly kind: ApertisErrorKind;
  readonly status?: number;

  constructor(kind: ApertisErrorKind, message: string, status?: number) {
    super(redactSecrets(message));
    this.name = "ApertisAgentError";
    this.kind = kind;
    this.status = status;
  }
}

/** Classify an HTTP status + body into an ApertisAgentError. */
export function errorFromStatus(
  status: number,
  body: string,
): ApertisAgentError {
  const safe = redactSecrets(body).slice(0, 500);
  let kind: ApertisErrorKind = "unknown";
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 429) kind = "quota";
  else if (status === 404) kind = "model_not_found";
  else if (status === 400) {
    // Apertis returns insufficient-quota as 400 in some paths
    kind = /quota|insufficient|balance/i.test(safe) ? "quota" : "bad_request";
  } else if (status >= 500) kind = "server";
  return new ApertisAgentError(kind, `HTTP ${status}: ${safe}`, status);
}

/**
 * tools/connectors/lib/http.ts — polite, rate-limited fetch for connectors.
 *
 * Guardrails baked in, not left to individual connectors:
 * - D-011 whitelist: only the four allowed public API hosts. Any other
 *   host throws before a single byte leaves the machine.
 * - Rate limiting: a minimum interval between requests.
 * - Retries: 3 attempts total on network errors / 429 / 5xx with
 *   exponential backoff (1s, 2s), honoring Retry-After when present.
 * - Polite headers: User-Agent with a mailto contact; the mailto query
 *   param is appended for APIs that ask for it (OpenAlex convention).
 */

import type { PoliteFetch } from "../types";

/** D-011: the only external hosts tools/ scripts may call. */
export const ALLOWED_HOSTS = [
  "api.openalex.org",
  "api.semanticscholar.org",
  "eutils.ncbi.nlm.nih.gov",
  "web.archive.org",
] as const;

/** Hosts whose APIs ask for a `mailto` query param (polite pool etc.). */
const MAILTO_PARAM_HOSTS = new Set<string>(["api.openalex.org"]);

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

export interface PoliteFetchOptions {
  /** Minimum milliseconds between two requests. */
  minIntervalMs: number;
  /** Contact address for polite headers; strongly recommended. */
  mailto?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return BACKOFF_BASE_MS * 2 ** (attempt - 1); // 1s, 2s
}

export function createPoliteFetch(options: PoliteFetchOptions): PoliteFetch {
  const { minIntervalMs, mailto } = options;
  const userAgent = `motivation-engine/0.1 (${mailto ? `mailto:${mailto}` : "no-contact-configured"})`;
  let lastRequestAt = 0;

  return async (input, init) => {
    const url = new URL(input.toString());

    if (!(ALLOWED_HOSTS as readonly string[]).includes(url.hostname)) {
      throw new Error(
        `Host "${url.hostname}" is not in the D-011 whitelist (${ALLOWED_HOSTS.join(", ")}). ` +
          "Any other external endpoint requires a new decisions.json entry first.",
      );
    }

    if (mailto && MAILTO_PARAM_HOSTS.has(url.hostname) && !url.searchParams.has("mailto")) {
      url.searchParams.set("mailto", mailto);
    }

    const headers = new Headers(init?.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
    if (!headers.has("accept")) headers.set("accept", "application/json");

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const wait = lastRequestAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();

      let response: Response | undefined;
      try {
        response = await fetch(url, { ...init, headers });
      } catch (err) {
        lastError = err as Error;
      }

      if (response) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) return response;
        lastError = new Error(`HTTP ${response.status} ${response.statusText} for ${url.hostname}${url.pathname}`);
      }

      if (attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt, response));
      }
    }

    throw new Error(
      `Request failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
    );
  };
}

/**
 * tools/connectors/lib/http.ts — polite, rate-limited fetch for connectors.
 *
 * Guardrails baked in, not left to individual connectors:
 * - D-011 whitelist: only the four allowed public API hosts. Any other
 *   host throws before a single byte leaves the machine.
 * - Rate limiting: a minimum interval between requests per fetch handle,
 *   plus a GLOBAL Semantic Scholar queue (D-027): the issued S2 key allows
 *   1 request/second CUMULATIVE across ALL endpoints, so every S2 request
 *   in the process — search, paper details, references, health probes —
 *   is serialized through the single enqueueS2() queue spaced at ≥1100ms.
 *   Cumulative means one queue per process, not per endpoint: never
 *   parallelize S2 calls, and never add S2 calls to a new tool without
 *   routing them through enqueueS2().
 * - Retries: 3 attempts total on network errors / 429 / 5xx with
 *   exponential backoff (1s, 2s; Semantic Scholar backs off from 2s:
 *   2s, 4s), honoring Retry-After when present.
 * - Run budget: an optional maxApiCalls cap (from the connector's
 *   /corpora/_ops/connectors/{id}.json limits) fails the next request
 *   once the run's request budget is spent.
 * - Polite headers: User-Agent with a mailto contact; the mailto query
 *   param is appended for APIs that ask for it (OpenAlex convention).
 */

import type { PoliteFetch } from "../types";

/**
 * Thrown by the polite fetch when a run's request budget
 * (limits.max_calls_per_run from the _ops config, D-024/D-027) is spent. The
 * runner catches this as a GRACEFUL stop: the run is recorded status "partial"
 * with warnings.capped = true and exits 0, rather than a hard failure.
 */
export class RunBudgetExceededError extends Error {
  readonly maxApiCalls: number;
  constructor(maxApiCalls: number) {
    super(
      `max_calls_per_run limit (${maxApiCalls}) from the _ops connector config reached — ` +
        "the run's request budget is spent (raise limits.max_calls_per_run in /corpora/_ops/connectors/ if intentional).",
    );
    this.name = "RunBudgetExceededError";
    this.maxApiCalls = maxApiCalls;
  }
}

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

// ---------- Global Semantic Scholar queue (D-027) ----------

/** The one host whose rate limit is cumulative per key, not per endpoint. */
export const S2_HOST = "api.semanticscholar.org";

/** ≥1100ms between S2 requests — the key allows 1 rps cumulative; the
 *  100ms margin absorbs clock skew between us and the S2 rate counter. */
const S2_MIN_INTERVAL_MS = 1100;

/** A 429 despite the limiter backs off from 2s (2s, 4s), not 1s (D-027). */
const S2_BACKOFF_BASE_MS = 2000;

let s2Chain: Promise<void> = Promise.resolve();
let s2LastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize a Semantic Scholar request through the per-process queue:
 * tasks run strictly one at a time, spaced at ≥S2_MIN_INTERVAL_MS. ALL S2
 * calls — connector searches, reference lookups, the health probe — must
 * go through here; adding an S2 call anywhere else violates the key's
 * 1 rps cumulative allowance (D-027).
 */
export function enqueueS2<T>(task: () => Promise<T>): Promise<T> {
  const run = s2Chain.then(async () => {
    const wait = s2LastRequestAt + S2_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const previousAt = s2LastRequestAt;
    s2LastRequestAt = Date.now();
    // Emit the measured spacing so licensing compliance (≥1100ms cumulative,
    // D-027) is auditable in connector and workflow logs, not just asserted.
    if (previousAt > 0) {
      console.error(`  [s2 queue] request spaced +${s2LastRequestAt - previousAt}ms`);
    }
    return task();
  });
  // The chain must survive task failures — swallow here, callers get `run`.
  s2Chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------- Polite fetch ----------

export interface PoliteFetchOptions {
  /** Minimum milliseconds between two requests (non-S2 hosts; S2 requests
   *  are spaced by the global queue instead). */
  minIntervalMs: number;
  /** Contact address for polite headers; strongly recommended. */
  mailto?: string;
  /** Run request budget from _ops connector limits (max_calls_per_run,
   *  D-024/D-027): once this many outbound attempts were made, the next
   *  request fails instead of firing. */
  maxApiCalls?: number;
}

/** Live request counter for cost accounting (D-022). */
export interface FetchStats {
  /** Every outbound HTTP attempt, including retries — the honest request
   *  cost the manifest records as cost.api_calls. */
  apiCalls: number;
}

/** A polite fetch paired with its live request counter (D-022). */
export interface PoliteFetchHandle {
  fetch: PoliteFetch;
  stats: FetchStats;
}

function retryDelayMs(attempt: number, baseMs: number, response?: Response): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return baseMs * 2 ** (attempt - 1);
}

export function createPoliteFetch(options: PoliteFetchOptions): PoliteFetchHandle {
  const { minIntervalMs, mailto, maxApiCalls } = options;
  const userAgent = `motivation-engine/0.1 (${mailto ? `mailto:${mailto}` : "no-contact-configured"})`;
  let lastRequestAt = 0;
  const stats: FetchStats = { apiCalls: 0 };

  const fetchImpl: PoliteFetch = async (input, init) => {
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

    const isS2 = url.hostname === S2_HOST;
    const backoffBaseMs = isS2 ? S2_BACKOFF_BASE_MS : BACKOFF_BASE_MS;

    const attemptFetch = (): Promise<Response> => {
      stats.apiCalls++;
      return fetch(url, { ...init, headers });
    };

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (maxApiCalls !== undefined && stats.apiCalls >= maxApiCalls) {
        throw new RunBudgetExceededError(maxApiCalls);
      }

      let response: Response | undefined;
      try {
        if (isS2) {
          // D-027: all S2 requests share the one per-process queue.
          response = await enqueueS2(attemptFetch);
        } else {
          const wait = lastRequestAt + minIntervalMs - Date.now();
          if (wait > 0) await sleep(wait);
          lastRequestAt = Date.now();
          response = await attemptFetch();
        }
      } catch (err) {
        lastError = err as Error;
      }

      if (response) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) return response;
        lastError = new Error(`HTTP ${response.status} ${response.statusText} for ${url.hostname}${url.pathname}`);
      }

      if (attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt, backoffBaseMs, response));
      }
    }

    throw new Error(
      `Request failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
    );
  };

  return { fetch: fetchImpl, stats };
}

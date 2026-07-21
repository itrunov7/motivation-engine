/**
 * tools/connectors/types.ts — the connector framework contract.
 *
 * One contract for all connectors so managing ten costs the same as
 * managing one: every connector implements `Connector`, every run is
 * executed by tools/run-connector.ts, and every run writes
 * /corpora/{source_id}/manifest.json in the exact `Manifest` shape below.
 *
 * Connectors are Phase 2 tools/ scripts (D-011): they may call ONLY the
 * whitelisted public APIs enforced by lib/http.ts.
 */

/** Params parsed from the CLI as `key=value` pairs. */
export type RunParams = Record<string, string>;

/**
 * The evidence category checklist (D-019): corpus completeness is verified
 * structurally — every harvested corpus is expected to cover all five
 * categories. Classification is metadata-only (type, title, abstract, year,
 * citations); the connector never judges scientific content.
 */
export const EVIDENCE_CATEGORIES = [
  "foundational",
  "meta-analysis",
  "replication",
  "dissent",
  "recent",
] as const;

export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

/** Per-category record counts, keyed by EVIDENCE_CATEGORIES entries. */
export type CategoryCounts = Record<EvidenceCategory, number>;

/** A data file the connector produced during this run. */
export interface RunFile {
  /** Path relative to the corpus directory, e.g. "records.json". */
  path: string;
  /** Number of records the file contains. */
  records: number;
  /** Category checklist counts (D-019), for connectors that classify. */
  categories?: CategoryCounts;
}

/**
 * What a connector returns from a run that did not throw.
 * A thrown error is recorded by the runner as status "failed".
 * "partial" means some data was fetched but the run hit a limit
 * (rate cap, page budget, upstream truncation).
 */
export interface RunResult {
  status: "success" | "partial";
  recordsFetched: number;
  files: RunFile[];
  /** Only for "partial": what was left incomplete and why. */
  error?: string;
  /** Degradation flags recorded in the manifest (D-018), e.g.
   *  { s2_throttled: true } when Semantic Scholar ran keyless and 429'd. */
  warnings?: Record<string, boolean>;
}

/** Polite fetch: same signature as global fetch, but rate-limited,
 *  retried, and restricted to the D-011 whitelist. */
export type PoliteFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Everything a connector needs; provided by the runner. */
export interface RunContext {
  /** Absolute path of /corpora/{source_id} (created before run). */
  corpusDir: string;
  /** Rate-limited, whitelisted fetch with polite headers. */
  fetch: PoliteFetch;
  /** Pretty-printing JSON writer; `path` is relative to corpusDir. */
  writeJson: (path: string, data: unknown) => void;
  /** Outbound attempts made in the current process, including retries. */
  apiCalls: () => number;
  log: (message: string) => void;
}

/**
 * A deterministic cost estimate for a run BEFORE it happens (D-025). No
 * network calls — computed from the connector's inputs (for evidence: the
 * record's evidence_terms, pinned_evidence, per-term caps, and the polite
 * fetch interval). Powers the dry-run quote shown on /ops before a real run.
 */
export interface RunQuote {
  /** Estimated outbound HTTP requests, retries excluded (a floor). */
  calls: number;
  /** Estimated records written (an upper-bound before dedupe). */
  records: number;
  /** Estimated wall-clock seconds (≈ calls × the polite min interval). */
  duration_s: number;
  /** Computed dollar estimate; 0 for the free D-011 public APIs. */
  estimated_usd: number;
}

/** The single interface every connector implements. */
export interface Connector {
  /** CLI id, e.g. "evidence". */
  id: string;
  /** Target corpus dir name (the corpus id). "_"-prefixed for internal
   *  connectors (ignored by the app). A connector is not a source: the
   *  sources it harvests are declared in `sourceIds` (D-014). */
  sourceId: string;
  /** The sources/sources.json ids this connector harvests. Empty for
   *  internal connectors. Source connectivity in the showcase is computed
   *  from this field: a source is connected iff ANY corpus manifest lists
   *  it in source_ids with last_run.status "success" (D-014). */
  sourceIds: string[];
  /** Bumped when the connector's output shape or behavior changes. */
  connectorVersion: string;
  description: string;
  run(ctx: RunContext, params: RunParams): Promise<RunResult>;
  /** Optional deterministic cost estimate for the run-with-quote flow
   *  (D-025). No network calls. */
  quote?(params: RunParams): RunQuote;
  /**
   * When true, the scheduler may plan this connector with an EMPTY _ops
   * `targets` list — its harvest scope lives outside the mechanism-centric
   * target machinery (D-028: wayback's scope is wayback-domains.json). The
   * scheduled plan emits a single default-scope entry (params {}, target null)
   * that still passes through cadence, health, and the quote/budget gate.
   * Absent/false → an empty targets list honestly skips ("no targets
   * configured"). D-030.
   */
  schedulableWithoutTargets?: boolean;
}

// ---------- Manifest contract (/corpora/{source_id}/manifest.json) ----------

export type RunStatus = "success" | "partial" | "failed";

/**
 * Cost accounting for one run (D-022). The connector layer fills api_calls
 * and duration_s now; token fields are RESERVED for future LLM jobs (there
 * is no engine yet, rule 5) and are written as null until then. estimated_usd
 * is COMPUTED, not asserted — all four D-011 whitelisted APIs are free, so a
 * pure-fetch run computes to 0; it becomes non-zero the moment a priced job
 * (an LLM call) reports token usage.
 */
export interface ManifestCost {
  /** Outbound HTTP requests made this run, counting retries (the honest
   *  request cost). Filled by the polite-fetch layer (lib/http.ts). */
  api_calls: number;
  /** Wall-clock seconds of the run; mirrors ManifestRun.duration_s. */
  duration_s: number;
  /** Reserved for future LLM jobs — null until an engine exists. */
  tokens_in: number | null;
  /** Reserved for future LLM jobs — null until an engine exists. */
  tokens_out: number | null;
  /** Computed dollar estimate; 0 for the free public APIs (D-011). */
  estimated_usd: number;
}

export interface ManifestRun {
  /** ISO-8601 UTC timestamp of when the run started. */
  timestamp: string;
  status: RunStatus;
  params: RunParams;
  records_fetched: number;
  files_written: number;
  duration_s: number;
  error?: string;
  /** Degradation flags from the connector (D-018), e.g. s2_throttled. */
  warnings?: Record<string, boolean>;
  /** Cost accounting (D-022). REQUIRED on every run a writer constructs: the
   *  runner and the report ingester both fill it from the polite-fetch
   *  counter (api_calls incl. retries) and the wall clock. Making it
   *  mandatory here turns "a run written with no cost block" — which would
   *  contribute a silent 0 to the rollup — into a compile error rather than a
   *  data gap. Persisted history that predates D-022 is typed separately as
   *  StoredManifestRun, where cost is optional. */
  cost: ManifestCost;
}

/**
 * A run as PERSISTED in a manifest on disk (last_run / run_history). Cost is
 * optional here for one honest reason: runs recorded before D-022 carry no
 * cost block and history is never rewritten (rule against dishonest backfill).
 * Every run WRITTEN going forward is a ManifestRun (cost required), so a new
 * rollup zero can only come from genuinely old data, never from a writer that
 * forgot to count.
 */
export interface StoredManifestRun extends Omit<ManifestRun, "cost"> {
  cost?: ManifestCost;
}

export interface ManifestDataFile {
  /** Path relative to the corpus directory. */
  path: string;
  records: number;
  bytes: number;
  /** Category checklist counts (D-019); absent for unclassified files. */
  categories?: CategoryCounts;
}

export interface Manifest {
  /** The corpus id — equals the directory name under /corpora. */
  source_id: string;
  /** The sources/sources.json ids this corpus harvests (D-014). */
  source_ids: string[];
  connector_version: string;
  last_run: StoredManifestRun;
  /** Newest first, capped at 20 entries. */
  run_history: StoredManifestRun[];
  data_files: ManifestDataFile[];
}

/** run_history cap — the manifest keeps the last N runs. */
export const RUN_HISTORY_LIMIT = 20;

// ---------- Ops config contract (/corpora/_ops, D-024) ----------
//
// Writer mirrors of the reader contract in lib/types.ts (lib/ never imports
// tools/, D-020); tools/validate.ts pins writer → reader at compile time.
// The shared validators live in lib/ops.ts.

/** /corpora/_ops/budget.json — monthly ceilings the scheduler respects. */
export interface OpsBudget {
  monthly_caps: {
    usd: number;
    calls: number;
  };
}

/**
 * /corpora/_ops/connectors/{id}.json — one connector's operating config
 * (D-024). The runner reads it before every run and enforces
 * limits.max_calls_per_run at the polite-fetch layer as a hard run budget
 * (D-027) — a connector cannot opt out. For S2-calling connectors the limit
 * is sized so a run stays within minutes even if every call were Semantic
 * Scholar at the 1 rps cumulative key allowance (D-027).
 */
export interface OpsConnectorConfig {
  /** Must equal the connector's CLI id and the filename stem. */
  connector_id: string;
  /** A paused connector is skipped by the scheduled workflow. */
  paused: boolean;
  /** Required (non-empty) when paused is true. */
  paused_reason: string | null;
  /** A due target runs at most this often. */
  cadence: {
    every_days: number;
  };
  limits: {
    /** Run request budget, retries included: enforced pre-run against the
     *  quote (D-025) AND at the fetch layer during the run (D-027). */
    max_calls_per_run: number;
    /** Pre-run ceiling on the estimated records (D-025). */
    max_records_per_run: number;
  };
  /** Evidence-only adaptive harvest policy (D-080). */
  saturation?: {
    window_queries: number;
    novelty_threshold: number;
    minimum_queries: number;
    records_per_query: number;
    retrieval_shares: {
      relevance: number;
      recency: number;
      citation: number;
    };
    citation_graph: {
      backward_references: boolean;
      forward_citations: boolean;
      max_anchors: number;
    };
    checkpoint_every_queries: number;
    soft_time_limit_minutes: number;
  };
  /** Explicit harvest scope (mechanism ids). */
  targets: string[];
}

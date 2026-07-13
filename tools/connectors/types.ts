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
  log: (message: string) => void;
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
}

// ---------- Manifest contract (/corpora/{source_id}/manifest.json) ----------

export type RunStatus = "success" | "partial" | "failed";

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
  last_run: ManifestRun;
  /** Newest first, capped at 20 entries. */
  run_history: ManifestRun[];
  data_files: ManifestDataFile[];
}

/** run_history cap — the manifest keeps the last N runs. */
export const RUN_HISTORY_LIMIT = 20;

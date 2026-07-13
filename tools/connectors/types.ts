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

/** A data file the connector produced during this run. */
export interface RunFile {
  /** Path relative to the corpus directory, e.g. "records.json". */
  path: string;
  /** Number of records the file contains. */
  records: number;
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
  /** CLI id, e.g. "openalex". */
  id: string;
  /** Target corpus dir name. Matches an id in sources/sources.json,
   *  or is "_"-prefixed for internal connectors (ignored by the app). */
  sourceId: string;
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
}

export interface ManifestDataFile {
  /** Path relative to the corpus directory. */
  path: string;
  records: number;
  bytes: number;
}

export interface Manifest {
  source_id: string;
  connector_version: string;
  last_run: ManifestRun;
  /** Newest first, capped at 20 entries. */
  run_history: ManifestRun[];
  data_files: ManifestDataFile[];
}

/** run_history cap — the manifest keeps the last N runs. */
export const RUN_HISTORY_LIMIT = 20;

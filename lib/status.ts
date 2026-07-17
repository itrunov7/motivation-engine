/**
 * lib/status.ts — the status-computation module (SPEC.md §4, D-005).
 *
 * This is the ONLY file in the codebase where block-status literals
 * ("live" / "in_progress" / "planned") may appear. Every status is computed
 * at render time from the file system and the data files; components receive
 * computed values and map presentation via STATUS_META, never via literals.
 *
 * Computation rules (SPEC §4 "Status computation rules"):
 * - Registry: live if ≥1 valid full mechanism record exists (hard rules:
 *   every implementations[].metrics non-empty AND constraints.hard_rules
 *   non-empty). Count shown as full/total.
 * - Schema & validator: live if the schema files AND the CI workflow exist.
 * - Card generator: live if /cards contains a generated {id}.md for a valid
 *   full record (a README alone does not count).
 * - Runtime / corpora / telemetry: planned while their folders hold no data.
 *   README.md, dotfiles, and .gitkeep are never data; a corpus subfolder
 *   only counts if it contains a manifest.json (contract in corpora/README).
 * - Source states (D-013, D-014, D-026): computed per connection_mode from
 *   the corpus manifests. A connector is not a source: each manifest lists
 *   the sources it harvests in source_ids. An api/internal source is
 *   connected iff ANY /corpora/{dir}/manifest.json lists it in source_ids —
 *   connection means "this source's connector is set up and has run",
 *   regardless of how the run went; run quality is its own axis
 *   (computeSourceLastRun: success/partial/failed from last_run), and
 *   health is a third (computeSourceHealth, D-021). A report source is
 *   ingested iff a manifest lists it AND a data file exists on disk;
 *   manual and deferred sources show their mode, never a fake
 *   connectivity status.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DATA_PATHS,
  loadDecisions,
  loadFullMechanisms,
  loadSeedStubs,
  loadSources,
  loadTaxonomy,
} from "./data";
import {
  EVIDENCE_CATEGORIES,
  type ComputedSourceState,
  type ConnectionMode,
  type CorpusManifest,
  type CorpusManifestRun,
  type CorpusRunStatus,
  type EvidenceCategory,
  type HealthStatus,
  type HeartbeatFile,
  type LifecycleStatus,
  type Mechanism,
  type SeedStub,
  type SegmentEvidence,
  type Source,
  type SourceClassId,
  type SufficiencyStatus,
  type TaxonomyNode,
} from "./types";

// ---------- Status vocabulary ----------

export type BlockStatus = "live" | "in_progress" | "planned";

export interface StatusMeta {
  label: string;
  /** Design-token color (SPEC §4): emerald / amber / slate. */
  color: string;
}

export const STATUS_META: Record<BlockStatus, StatusMeta> = {
  live: { label: "live", color: "#34D399" },
  in_progress: { label: "in progress", color: "#E4B54E" },
  planned: { label: "planned", color: "#7C93A8" },
};

/**
 * Alert token (D-019): red for structural gaps and failed runs — the one
 * deliberate addition to the Control Center palette. An empty evidence
 * category or a failed connector run is not "planned"; it is a hole the
 * cockpit must flag loudly.
 */
export const ALERT_COLOR = "#F87171";

// ---------- Source connection modes and computed states (D-013) ----------

/**
 * Presentation metadata for connection modes (/sources page, Overview).
 * Modes come from sources.json; components map presentation through this
 * table, never via literals.
 */
export const CONNECTION_MODE_META: Record<
  ConnectionMode,
  { label: string; description: string }
> = {
  api: { label: "api", description: "automated connector" },
  internal: {
    label: "internal",
    description: "data produced by our own platform",
  },
  report: { label: "report", description: "one-off ingested artifact" },
  manual: {
    label: "manual",
    description: "licensed human curation, never machine-harvested",
  },
  deferred: { label: "deferred", description: "P2, not planned this phase" },
};

/** Connection modes in display order for filters, legends, and counts. */
export const CONNECTION_MODE_ORDER: ConnectionMode[] = [
  "api",
  "internal",
  "report",
  "manual",
  "deferred",
];

/**
 * Presentation metadata for COMPUTED source states (never stored):
 * connected/ingested = emerald, not yet = slate, manual = amber (a mode, not
 * a connectivity claim), deferred = muted slate.
 */
export const SOURCE_STATE_META: Record<ComputedSourceState, StatusMeta> = {
  connected: { label: "connected", color: "#34D399" },
  not_connected: { label: "not connected", color: "#7C93A8" },
  ingested: { label: "ingested", color: "#34D399" },
  not_ingested: { label: "not ingested", color: "#7C93A8" },
  manual: { label: "manual curation", color: "#E4B54E" },
  deferred: { label: "deferred", color: "#8CA495" },
};

/** Computed source states in display order for filter chips and legends. */
export const SOURCE_STATE_ORDER: ComputedSourceState[] = [
  "connected",
  "not_connected",
  "ingested",
  "not_ingested",
  "manual",
  "deferred",
];

/** Parsed /corpora/{dir}/manifest.json, or undefined if absent/broken. */
function readCorpusManifest(dirName: string): CorpusManifest | undefined {
  const file = join(DATA_PATHS.corporaDir, dirName, "manifest.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as CorpusManifest;
  } catch {
    return undefined;
  }
}

/**
 * Every /corpora/{dir}/manifest.json keyed by corpus directory name.
 * "_"-prefixed dirs are internal (framework smoke tests) and excluded.
 */
function readAllCorpusManifests(): Map<string, CorpusManifest> {
  const manifests = new Map<string, CorpusManifest>();
  if (!existsSync(DATA_PATHS.corporaDir)) return manifests;
  for (const entry of readdirSync(DATA_PATHS.corporaDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const manifest = readCorpusManifest(entry.name);
    if (manifest) manifests.set(entry.name, manifest);
  }
  return manifests;
}

/**
 * Manifests whose source_ids list the given source, keyed by corpus dir.
 * A connector is not a source (D-014): one corpus may harvest several
 * sources, and a source may be harvested by any corpus.
 */
function manifestsForSource(
  sourceId: string,
): { dirName: string; manifest: CorpusManifest }[] {
  return Array.from(readAllCorpusManifests().entries())
    .filter(([, manifest]) => (manifest.source_ids ?? []).includes(sourceId))
    .map(([dirName, manifest]) => ({ dirName, manifest }));
}

// ---------- Source health (heartbeat axis, D-021) ----------

/**
 * Presentation metadata for the health axis (D-021): ok = emerald,
 * degraded = amber, down = alert red, unknown = slate (a stale or missing
 * heartbeat never renders as ok), n/a = muted (internal sources have no
 * external endpoint by design — not a problem to flag).
 */
export const HEALTH_META: Record<HealthStatus, StatusMeta> = {
  ok: { label: "ok", color: "#34D399" },
  degraded: { label: "degraded", color: "#E4B54E" },
  down: { label: "down", color: ALERT_COLOR },
  unknown: { label: "unknown", color: "#7C93A8" },
  n_a: { label: "n/a", color: "#8CA495" },
};

/** A heartbeat older than this renders as unknown, never as ok (D-021). */
export const HEARTBEAT_STALE_HOURS = 12;

/** Parsed /corpora/_health/heartbeat.json, or undefined if absent/broken. */
export function loadHeartbeat(): HeartbeatFile | undefined {
  const file = join(DATA_PATHS.corporaDir, "_health", "heartbeat.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as HeartbeatFile;
  } catch {
    return undefined;
  }
}

/** Computed health of one source — everything the UI needs, no literals. */
export interface ComputedSourceHealth {
  /** null for modes with no health axis (report/manual/deferred). */
  status: HealthStatus | null;
  /** ISO timestamp of the probe; null when no probe was recorded. */
  checkedAt: string | null;
  /** Whole hours since the probe; null when no probe was recorded. */
  ageHours: number | null;
  latencyMs: number | null;
  note: string | null;
}

const NO_HEALTH_AXIS: ComputedSourceHealth = {
  status: null,
  checkedAt: null,
  ageHours: null,
  latencyMs: null,
  note: null,
};

/**
 * Computes a source's health from /corpora/_health/heartbeat.json (D-021).
 * The app performs NO live external calls — health is read from the
 * heartbeat file only:
 * - report/manual/deferred: no health axis (null status, UI shows "—")
 * - internal: n_a — no external endpoint by design
 * - no heartbeat file or no entry: unknown
 * - entry older than HEARTBEAT_STALE_HOURS: unknown — stale never renders ok
 * - otherwise: the recorded status, with "checked Nh ago" data
 */
export function computeSourceHealth(
  source: Source,
  now: Date = new Date(),
): ComputedSourceHealth {
  if (source.connection_mode !== "api" && source.connection_mode !== "internal") {
    return NO_HEALTH_AXIS;
  }
  if (source.connection_mode === "internal") {
    return {
      ...NO_HEALTH_AXIS,
      status: "n_a",
      note: "internal source — no external endpoint by design",
    };
  }
  const entry = loadHeartbeat()?.entries.find((e) => e.source_id === source.id);
  if (!entry) {
    return {
      ...NO_HEALTH_AXIS,
      status: "unknown",
      note: "no heartbeat yet — run tools/health-check.ts (npm run health)",
    };
  }
  const ageMs = now.getTime() - Date.parse(entry.checked_at);
  const ageHours = Number.isFinite(ageMs) ? Math.floor(ageMs / 3_600_000) : null;
  if (ageHours === null || ageHours >= HEARTBEAT_STALE_HOURS) {
    return {
      status: "unknown",
      checkedAt: entry.checked_at,
      ageHours,
      latencyMs: entry.latency_ms,
      note:
        ageHours === null
          ? "heartbeat has an unreadable checked_at timestamp"
          : `heartbeat stale (checked ${ageHours}h ago, threshold ${HEARTBEAT_STALE_HOURS}h)`,
    };
  }
  return {
    status: entry.status,
    checkedAt: entry.checked_at,
    ageHours,
    latencyMs: entry.latency_ms,
    note: entry.note,
  };
}

/** "checked 3h ago" line for a computed health; null when never probed. */
export function formatCheckedAgo(health: ComputedSourceHealth): string | null {
  if (health.ageHours === null) return null;
  return health.ageHours === 0
    ? "checked <1h ago"
    : `checked ${health.ageHours}h ago`;
}

// ---------- Corpus cockpit (/connectors, D-019) ----------

/** Presentation metadata for manifest run statuses (never stored in app/). */
export const RUN_STATUS_META: Record<CorpusRunStatus, StatusMeta> = {
  success: { label: "success", color: "#34D399" },
  partial: { label: "partial", color: "#E4B54E" },
  failed: { label: "failed", color: ALERT_COLOR },
};

/** One corpus manifest with its directory name, for the /connectors page. */
export interface CorpusEntry {
  dirName: string;
  manifest: CorpusManifest;
}

/** Every non-internal corpus manifest, sorted by directory name. */
export function loadCorpusManifests(): CorpusEntry[] {
  return Array.from(readAllCorpusManifests().entries())
    .map(([dirName, manifest]) => ({ dirName, manifest }))
    .sort((a, b) => a.dirName.localeCompare(b.dirName));
}

// ---------- Monthly cost rollup (/connectors, D-022) ----------

/**
 * run_history cap, mirrored from tools/connectors/types.ts RUN_HISTORY_LIMIT
 * (lib/ never imports from tools/, D-020). Used only for the honest cockpit
 * caveat that the rollup sees retained runs only.
 */
export const RUN_HISTORY_LIMIT = 20;

/**
 * One connector's aggregate for the current calendar month, plus the total
 * row. All figures are SUMMED from each manifest's run_history — never
 * asserted. Runs with no cost block (recorded before D-022) contribute 0 to
 * api_calls / estimated_usd but still count as a run.
 */
export interface MonthlyRollupRow {
  /** Corpus directory name, or "total" for the aggregate row. */
  label: string;
  runs: number;
  apiCalls: number;
  durationS: number;
  estimatedUsd: number;
}

export interface MonthlyRollup {
  /** Month label, e.g. "2026-07" (UTC). */
  month: string;
  perConnector: MonthlyRollupRow[];
  total: MonthlyRollupRow;
  /** True when no run in any manifest falls in the current month. */
  empty: boolean;
}

/** The "YYYY-MM" a run belongs to (UTC), or null for an unparseable stamp. */
function runMonthKey(run: CorpusManifestRun): string | null {
  const ms = Date.parse(run.timestamp);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * Rolls up run_history across all corpus manifests into per-connector and
 * total figures for the current UTC calendar month (D-022). The rollup only
 * sees runs still retained in run_history (capped at RUN_HISTORY_LIMIT per
 * connector) — the cockpit states this caveat honestly.
 */
export function computeMonthlyRollup(
  manifests: CorpusEntry[],
  now: Date = new Date(),
): MonthlyRollup {
  const month = now.toISOString().slice(0, 7);
  const perConnector: MonthlyRollupRow[] = [];

  for (const { dirName, manifest } of manifests) {
    const monthRuns = (manifest.run_history ?? []).filter(
      (run) => runMonthKey(run) === month,
    );
    if (monthRuns.length === 0) continue;
    perConnector.push(
      monthRuns.reduce<MonthlyRollupRow>(
        (row, run) => ({
          label: dirName,
          runs: row.runs + 1,
          apiCalls: row.apiCalls + (run.cost?.api_calls ?? 0),
          durationS: row.durationS + run.duration_s,
          estimatedUsd: row.estimatedUsd + (run.cost?.estimated_usd ?? 0),
        }),
        { label: dirName, runs: 0, apiCalls: 0, durationS: 0, estimatedUsd: 0 },
      ),
    );
  }

  perConnector.sort((a, b) => a.label.localeCompare(b.label));

  const total = perConnector.reduce<MonthlyRollupRow>(
    (acc, row) => ({
      label: "total",
      runs: acc.runs + row.runs,
      apiCalls: acc.apiCalls + row.apiCalls,
      durationS: acc.durationS + row.durationS,
      estimatedUsd: acc.estimatedUsd + row.estimatedUsd,
    }),
    { label: "total", runs: 0, apiCalls: 0, durationS: 0, estimatedUsd: 0 },
  );

  return { month, perConnector, total, empty: perConnector.length === 0 };
}

/**
 * Category checklist state for one data file (D-019), computed from the
 * manifest — never asserted:
 * - covered: the category has ≥1 record
 * - missing: the category has 0 records — a structural gap (red flag)
 * - unclassified: the file carries no category data (pre-v2 harvest)
 */
export type CategoryFlagState = "covered" | "missing" | "unclassified";

export const CATEGORY_FLAG_META: Record<CategoryFlagState, StatusMeta> = {
  covered: { label: "covered", color: "#34D399" },
  missing: { label: "missing", color: ALERT_COLOR },
  unclassified: { label: "not classified", color: "#E4B54E" },
};

export interface CategoryFlag {
  category: EvidenceCategory;
  /** null when the file is unclassified. */
  count: number | null;
  state: CategoryFlagState;
}

export interface DataFileChecklist {
  path: string;
  records: number;
  bytes: number;
  /** False for pre-v2 files with no category data — re-run the connector. */
  classified: boolean;
  /** One flag per category, in EVIDENCE_CATEGORIES order. */
  flags: CategoryFlag[];
  /** Categories with zero records — the red flags. */
  missing: EvidenceCategory[];
}

/** Computes the per-category checklist for one manifest data file. */
export function computeFileChecklist(
  file: CorpusManifest["data_files"][number],
): DataFileChecklist {
  const counts = file.categories;
  const flags: CategoryFlag[] = EVIDENCE_CATEGORIES.map((category) => {
    if (!counts) return { category, count: null, state: "unclassified" };
    const count = counts[category] ?? 0;
    return { category, count, state: count > 0 ? "covered" : "missing" };
  });
  return {
    path: file.path,
    records: file.records,
    bytes: file.bytes,
    classified: counts !== undefined,
    flags,
    missing: flags
      .filter((flag) => flag.state === "missing")
      .map((flag) => flag.category),
  };
}

/**
 * Computes a source's state from its mode and the file system (SPEC §4,
 * D-014, D-026). Connection answers ONE question — "is this source set up?"
 * — not "did the last run go well" (that is computeSourceLastRun) and not
 * "is the API answering right now" (that is computeSourceHealth, D-021):
 * - api / internal: connected iff ANY /corpora/{dir}/manifest.json lists
 *   the source in source_ids — a manifest only exists after a connector
 *   was built and run at least once, so its presence IS the set-up proof
 *   (internal data arrives via our own export pipeline, but set-up is
 *   proven the same way, D-016)
 * - report: ingested iff a manifest lists the source AND that corpus has
 *   at least one data_files entry existing on disk — the artifact is
 *   either on disk or it is not
 * - manual / deferred: the mode itself — a connectivity status would be fake
 */
export function computeSourceState(source: Source): ComputedSourceState {
  switch (source.connection_mode) {
    case "manual":
      return "manual";
    case "deferred":
      return "deferred";
    case "api":
    case "internal": {
      const connected = manifestsForSource(source.id).length > 0;
      return connected ? "connected" : "not_connected";
    }
    case "report": {
      const ingested = manifestsForSource(source.id).some(
        ({ dirName, manifest }) =>
          (manifest.data_files ?? []).some((file) =>
            existsSync(join(DATA_PATHS.corporaDir, dirName, file.path)),
          ),
      );
      return ingested ? "ingested" : "not_ingested";
    }
  }
}

/** The newest last_run among manifests harvesting a source (D-026). */
export interface ComputedSourceLastRun {
  status: CorpusRunStatus;
  /** ISO timestamp of the run. */
  timestamp: string;
  /** The corpus whose manifest recorded the run (per-corpus granularity,
   *  D-020: all sources one corpus harvests share its run status). */
  corpusDir: string;
}

/**
 * Computes the "is it working well" axis (D-026): the most recent last_run
 * across every manifest listing the source in source_ids, or null when the
 * source was never set up. Presentation maps through RUN_STATUS_META.
 */
export function computeSourceLastRun(
  source: Source,
): ComputedSourceLastRun | null {
  let newest: ComputedSourceLastRun | null = null;
  for (const { dirName, manifest } of manifestsForSource(source.id)) {
    const run = manifest.last_run;
    if (!run) continue;
    if (!newest || Date.parse(run.timestamp) > Date.parse(newest.timestamp)) {
      newest = {
        status: run.status,
        timestamp: run.timestamp,
        corpusDir: dirName,
      };
    }
  }
  return newest;
}

/** Per-mode aggregate: done = connected (api) / ingested (report). */
export interface SourceModeCount {
  mode: ConnectionMode;
  total: number;
  /** null for manual/deferred — those modes have no completion fraction. */
  done: number | null;
}

/** Groups all sources by connection mode with computed completion counts. */
export function computeSourceModeCounts(): SourceModeCount[] {
  const sources = loadSources().classes.flatMap((c) => c.sources);
  return CONNECTION_MODE_ORDER.map((mode) => {
    const ofMode = sources.filter((s) => s.connection_mode === mode);
    const done =
      mode === "api" || mode === "internal"
        ? ofMode.filter((s) => computeSourceState(s) === "connected").length
        : mode === "report"
          ? ofMode.filter((s) => computeSourceState(s) === "ingested").length
          : null;
    return { mode, total: ofMode.length, done };
  });
}

/**
 * One-line summary for a mode count, shown next to the mode label:
 * "0/7 connected", "0/5 ingested", "9 curation", "10". Lives here so state
 * words stay out of app/.
 */
export function formatModeCount(count: SourceModeCount): string {
  switch (count.mode) {
    case "api":
    case "internal":
      return `${count.done}/${count.total} connected`;
    case "report":
      return `${count.done}/${count.total} ingested`;
    case "manual":
      return `${count.total} curation`;
    case "deferred":
      return `${count.total}`;
  }
}

// ---------- Lifecycle vocabulary (SPEC §2, L1 lifecycle) ----------

export interface LifecycleMeta {
  label: string;
  /** Design-token color: core=emerald, incubating=amber, candidate=slate. */
  color: string;
}

/**
 * Presentation metadata for L1 lifecycle statuses, in lifecycle order:
 * candidate → incubating → core (side exits: deprecated, rejected).
 * Components map lifecycle values through this table, never via literals.
 */
export const LIFECYCLE_META: Record<LifecycleStatus, LifecycleMeta> = {
  candidate: { label: "candidate", color: "#7C93A8" },
  incubating: { label: "incubating", color: "#E4B54E" },
  core: { label: "core", color: "#34D399" },
  deprecated: { label: "deprecated", color: "#8CA495" },
  rejected: { label: "rejected", color: "#8CA495" },
};

/**
 * Lifecycle order: the first three form the promotion path
 * (candidate → incubating → core); the last two are side exits.
 */
export const LIFECYCLE_ORDER: LifecycleStatus[] = [
  "candidate",
  "incubating",
  "core",
  "deprecated",
  "rejected",
];

// ---------- Sufficiency matrix vocabulary (/maturation, D-050/D-053) ----------

/**
 * Presentation metadata for the COMPUTED sufficiency status of a
 * [pack × segment] cell (analysis/sufficiency-matrix.json, D-050): green =
 * emerald, amber = amber, red = the alert token (a red cell is a knowledge
 * hole the cockpit flags loudly, not merely "planned"). This is the ONLY
 * place the "red"/"amber"/"green" literals live; the /maturation heatmap maps
 * every cell through this table, never via a literal (honesty rule).
 */
export const CELL_STATUS_META: Record<SufficiencyStatus, StatusMeta> = {
  green: { label: "green", color: "#34D399" },
  amber: { label: "amber", color: "#E4B54E" },
  red: { label: "red", color: ALERT_COLOR },
};

/** Sufficiency statuses in maturity order (worst → best) for legends/counts. */
export const CELL_STATUS_ORDER: SufficiencyStatus[] = ["red", "amber", "green"];

/**
 * A segment present in segments.yaml but absent from the matrix (a new or
 * not-yet-scored segment) renders as this neutral state — honest, never red.
 * Slate, the "planned/unknown" token, so an empty column reads as "no data
 * yet", not as a failing cell.
 */
export const CELL_NOT_ANALYZED_META: StatusMeta = {
  label: "not analyzed",
  color: "#7C93A8",
};

/**
 * Presentation metadata for the segment-evidence axis (D-050): general_only is
 * the signal that segment-specific harvesting is still needed (amber),
 * segment_specific means some segment judgment already touches the cell
 * (emerald). The literals live here, not in app/.
 */
/**
 * True when a cell rests on general evidence only — the signal that
 * segment-specific harvesting is still needed (D-050). Lives here so the
 * "general_only" literal stays out of app/ (honesty grep check).
 */
export function needsSegmentHarvest(evidence: SegmentEvidence): boolean {
  return evidence === "general_only";
}

export const SEGMENT_EVIDENCE_META: Record<
  SegmentEvidence,
  { label: string; color: string; description: string }
> = {
  segment_specific: {
    label: "segment-specific",
    color: "#34D399",
    description: "some segment-specific judgment touches this cell",
  },
  general_only: {
    label: "general-only",
    color: "#E4B54E",
    description:
      "scored on general evidence only — segment-specific harvest needed",
  },
};

// ---------- Block model ----------

export interface EmptyStateNote {
  /** Which file / pipeline will fill this block (rule 15). */
  filledBy: string;
  /** Phase: July / August / September. */
  phase: string;
}

export interface SystemBlock {
  id: string;
  name: string;
  status: BlockStatus;
  /** Computed detail line, derived from data — never asserted. */
  detail: string;
  /** Designed empty state, shown while the block is not live. */
  emptyState?: EmptyStateNote;
}

// ---------- File-system helpers ----------

/**
 * True only if the directory contains actual data: README.md, dotfiles and
 * .gitkeep never count, and empty subfolders never count. This is what keeps
 * a fake empty folder from turning anything green.
 */
function hasDataFiles(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile() && entry.name.toUpperCase() === "README.MD") continue;
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasDataFiles(join(dir, entry.name))) return true;
  }
  return false;
}

/**
 * Corpus subfolders that satisfy the /corpora contract and harvest at least
 * one source from the given classes: membership is computed from the
 * manifest's source_ids (D-014), not from the directory name.
 */
function harvestedCorpora(classIds: SourceClassId[]): string[] {
  const classSourceIds = new Set(
    loadSources()
      .classes.filter((c) => classIds.includes(c.id))
      .flatMap((c) => c.sources.map((s) => s.id)),
  );
  return Array.from(readAllCorpusManifests().entries())
    .filter(([, manifest]) =>
      (manifest.source_ids ?? []).some((id) => classSourceIds.has(id)),
    )
    .map(([dirName]) => dirName)
    .sort();
}

// ---------- Mechanism validity (hard rules, D-003) ----------

function isValidFullRecord(record: Mechanism): boolean {
  const implsOk =
    Array.isArray(record.implementations) &&
    record.implementations.length > 0 &&
    record.implementations.every(
      (impl) => Array.isArray(impl.metrics) && impl.metrics.length > 0,
    );
  const rulesOk =
    Array.isArray(record.constraints?.hard_rules) &&
    record.constraints.hard_rules.length > 0;
  return implsOk && rulesOk;
}

// ---------- Registry tree (SPEC §3.1: coverage is COMPUTED in the app) ----------

export type RegistryChild =
  | { kind: "full"; record: Mechanism; valid: boolean }
  | { kind: "stub"; stub: SeedStub };

export interface RegistryNode {
  node: TaxonomyNode;
  /** L1 children (full records + seed stubs) with parent === node.id, by id. */
  children: RegistryChild[];
  /** Coverage counts by lifecycle status, in lifecycle order. */
  coverage: { status: LifecycleStatus; count: number }[];
}

/**
 * Joins the L0 taxonomy with L1 mechanisms into the /registry tree.
 * Every count is derived from the files on disk — never asserted.
 */
export function computeRegistryTree(): RegistryNode[] {
  const fullRecords = loadFullMechanisms();
  const seedStubs = loadSeedStubs();

  return loadTaxonomy().nodes.map((node) => {
    const children: RegistryChild[] = [
      ...fullRecords
        .filter((record) => record.parent === node.id)
        .map((record): RegistryChild => ({
          kind: "full",
          record,
          valid: isValidFullRecord(record),
        })),
      ...seedStubs
        .filter((stub) => stub.parent === node.id)
        .map((stub): RegistryChild => ({ kind: "stub", stub })),
    ].sort((a, b) => {
      const idOf = (c: RegistryChild) =>
        c.kind === "full" ? c.record.id : c.stub.id;
      return idOf(a).localeCompare(idOf(b));
    });

    const counts = new Map<LifecycleStatus, number>();
    for (const child of children) {
      const status =
        child.kind === "full"
          ? child.record.lifecycle_status
          : child.stub.lifecycle_status;
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }

    return {
      node,
      children,
      coverage: LIFECYCLE_ORDER.filter((s) => counts.has(s)).map((status) => ({
        status,
        count: counts.get(status)!,
      })),
    };
  });
}

// ---------- The seven system blocks ----------

export function computeSystemBlocks(): SystemBlock[] {
  const fullRecords = loadFullMechanisms();
  const seedStubs = loadSeedStubs();
  const validFull = fullRecords.filter(isValidFullRecord);
  const totalMechanisms = fullRecords.length + seedStubs.length;

  // 1. Registry
  const registry: SystemBlock = {
    id: "registry",
    name: "Registry",
    status:
      validFull.length > 0
        ? "live"
        : totalMechanisms > 0
          ? "in_progress"
          : "planned",
    detail: `${validFull.length}/${totalMechanisms} full records (rest are seed stubs)`,
    emptyState:
      validFull.length > 0
        ? undefined
        : {
            filledBy: "/registry/mechanisms/*.json entered by the owner",
            phase: "July",
          },
  };

  // 2. Schema & validator
  const schemaFilesExist =
    existsSync(DATA_PATHS.mechanismSchema) &&
    existsSync(DATA_PATHS.dossierSchema);
  const ciExists = existsSync(DATA_PATHS.ciWorkflow);
  const schemaValidator: SystemBlock = {
    id: "schema-validator",
    name: "Schema & validator",
    status: schemaFilesExist && ciExists ? "live" : "planned",
    detail:
      schemaFilesExist && ciExists
        ? "schemas compile in CI on every push"
        : `schemas: ${schemaFilesExist ? "present" : "missing"} · CI workflow: ${ciExists ? "present" : "missing"}`,
    emptyState:
      schemaFilesExist && ciExists
        ? undefined
        : {
            filledBy:
              "/registry/mechanism.schema.json + /dossiers/dossier.schema.json + .github/workflows/validate.yml",
            phase: "July",
          },
  };

  // 3. Card generator
  const validIds = new Set(validFull.map((r) => r.id));
  const generatedCards = existsSync(DATA_PATHS.cardsDir)
    ? readdirSync(DATA_PATHS.cardsDir).filter(
        (name) => name.endsWith(".md") && validIds.has(name.replace(/\.md$/, "")),
      )
    : [];
  const cardGenerator: SystemBlock = {
    id: "card-generator",
    name: "Card generator",
    status: generatedCards.length > 0 ? "live" : "planned",
    detail:
      generatedCards.length > 0
        ? `${generatedCards.length} card${generatedCards.length === 1 ? "" : "s"} generated (${generatedCards.map((c) => c.replace(/\.md$/, "")).join(", ")})`
        : "no generated cards in /cards yet",
    emptyState:
      generatedCards.length > 0
        ? undefined
        : {
            filledBy: "tools/render-cards.ts (npm run cards) → /cards/{id}.md",
            phase: "July",
          },
  };

  // 4. Runtime selection
  const runtimeHasData = hasDataFiles(DATA_PATHS.runtimeDir);
  const runtime: SystemBlock = {
    id: "runtime",
    name: "Runtime selection",
    status: runtimeHasData ? "live" : "planned",
    detail: runtimeHasData
      ? "runtime artifacts present in /runtime"
      : "no engine at baseline — /runtime is empty",
    emptyState: runtimeHasData
      ? undefined
      : {
          filledBy:
            "the future selection engine (mechanism → artifact matching); out of scope for baseline",
          phase: "September",
        },
  };

  // 5. Corpus: interfaces & science (source classes A + B)
  const abCorpora = harvestedCorpora(["A", "B"]);
  const corpusInterfacesScience: SystemBlock = {
    id: "corpus-interfaces-science",
    name: "Corpus: interfaces & science",
    status: abCorpora.length > 0 ? "live" : "planned",
    detail:
      abCorpora.length > 0
        ? `${abCorpora.length} harvested corpora: ${abCorpora.join(", ")}`
        : "no harvested corpora in /corpora (classes A–B)",
    emptyState:
      abCorpora.length > 0
        ? undefined
        : {
            filledBy:
              "source connectors → /corpora/{source_id}/manifest.json (classes A: interfaces, B: science)",
            phase: "August–September",
          },
  };

  // 6. Corpus: reviews (source classes C + D)
  const cdCorpora = harvestedCorpora(["C", "D"]);
  const corpusReviews: SystemBlock = {
    id: "corpus-reviews",
    name: "Corpus: reviews",
    status: cdCorpora.length > 0 ? "live" : "planned",
    detail:
      cdCorpora.length > 0
        ? `${cdCorpora.length} harvested corpora: ${cdCorpora.join(", ")}`
        : "no harvested corpora in /corpora (classes C–D)",
    emptyState:
      cdCorpora.length > 0
        ? undefined
        : {
            filledBy:
              "source connectors → /corpora/{source_id}/manifest.json (classes C: benchmarks, D: non-obvious)",
            phase: "August–September",
          },
  };

  // 7. Telemetry loop
  const telemetryHasData = hasDataFiles(DATA_PATHS.telemetryDir);
  const observedEffectsCount = fullRecords.reduce(
    (n, record) =>
      n +
      record.implementations.reduce(
        (m, impl) => m + (impl.observed_effects?.length ?? 0),
        0,
      ),
    0,
  );
  const telemetry: SystemBlock = {
    id: "telemetry-loop",
    name: "Telemetry loop",
    status: telemetryHasData || observedEffectsCount > 0 ? "live" : "planned",
    detail:
      telemetryHasData || observedEffectsCount > 0
        ? `${observedEffectsCount} observed effects recorded`
        : "no measured effects yet — observed_effects empty across all records",
    emptyState:
      telemetryHasData || observedEffectsCount > 0
        ? undefined
        : {
            filledBy:
              "product telemetry (me:{id}:{implementation_id} tags) → implementations[].observed_effects",
            phase: "September",
          },
  };

  return [
    registry,
    schemaValidator,
    cardGenerator,
    runtime,
    corpusInterfacesScience,
    corpusReviews,
    telemetry,
  ];
}

// ---------- Live counts ----------

export interface SystemCounts {
  mechanismsByLifecycle: { status: LifecycleStatus; count: number }[];
  mechanismsTotal: number;
  sourcesByMode: SourceModeCount[];
  sourcesTotal: number;
  decisionsCount: number;
}

export function computeCounts(): SystemCounts {
  const fullRecords = loadFullMechanisms();
  const seedStubs = loadSeedStubs();
  const lifecycleCounts = new Map<LifecycleStatus, number>();
  for (const record of [...fullRecords, ...seedStubs]) {
    lifecycleCounts.set(
      record.lifecycle_status,
      (lifecycleCounts.get(record.lifecycle_status) ?? 0) + 1,
    );
  }

  const sources = loadSources().classes.flatMap((c) => c.sources);

  return {
    mechanismsByLifecycle: LIFECYCLE_ORDER.filter((s) =>
      lifecycleCounts.has(s),
    ).map((status) => ({ status, count: lifecycleCounts.get(status)! })),
    mechanismsTotal: fullRecords.length + seedStubs.length,
    sourcesByMode: computeSourceModeCounts(),
    sourcesTotal: sources.length,
    decisionsCount: loadDecisions().decisions.length,
  };
}

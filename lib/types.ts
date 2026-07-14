/**
 * Data types mirroring the JSON schemas (SPEC.md §3).
 * Sources of truth:
 * - /registry/mechanism.schema.json (full L1 record + seed stub sub-schema)
 * - /registry/taxonomy.json shape (SPEC.md §3.1)
 * - /dossiers/dossier.schema.json (SPEC.md §3.3)
 * - /sources/sources.json shape (SPEC.md §3.4)
 * - /decisions/decisions.json shape (SPEC.md §3.5)
 */

// ---------- Shared unions ----------

export type LifecycleStatus =
  | "candidate"
  | "incubating"
  | "core"
  | "deprecated"
  | "rejected";

export type EvidenceGrade = "A" | "B" | "C";

export type RelationType = "enabled_by" | "adjacent" | "hybrid_with";

export type RuleSeverity = "block" | "warn";

export type ProposedBy = "owner" | "derivation-pipeline";

/** L0 taxonomy node id (S1–S6). */
export type TaxonomyNodeId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6";

export type ArtifactType =
  | "paywall"
  | "cancellation_flow"
  | "retention_push"
  | "checkout"
  | "email"
  | "pricing_page"
  | "dashboard_widget"
  | "onboarding"
  | "landing_hero";

// ---------- Taxonomy (§3.1) ----------

export interface TaxonomyAnchors {
  rdoc: string;
  panksepp?: string;
}

export interface TaxonomyNode {
  id: TaxonomyNodeId;
  name: string;
  anchors: TaxonomyAnchors;
  description: string;
}

export interface Taxonomy {
  version: string;
  nodes: TaxonomyNode[];
}

// ---------- Mechanism, full L1 record (§3.2) ----------

export interface Provenance {
  proposed_by: ProposedBy;
  /** ISO date, YYYY-MM-DD */
  date: string;
}

export interface Evidence {
  grade: EvidenceGrade;
  basis: string;
  effect_size_note: string;
  caveats: string[];
}

export interface Precondition {
  predicate: string;
  reason: string;
}

export interface Applicability {
  funnel_stages: string[];
  excluded_stages: string[];
  artifact_types: ArtifactType[];
  preconditions: Precondition[];
  culture_note: string;
}

export interface Implementation {
  id: string;
  artifact_types: ArtifactType[];
  product_requirements: string[];
  generation_directive: string;
  copy_formulas: string[];
  /** Hard rule: must be non-empty, otherwise the record is invalid. */
  metrics: string[];
  observed_effects: string[];
}

export interface HardRule {
  id: string;
  rule: string;
  severity: RuleSeverity;
}

export interface Constraints {
  /** Hard rule: must be non-empty, otherwise the record is invalid. */
  hard_rules: HardRule[];
  compliance_refs: string[];
  boundary_test: string;
}

export interface Relation {
  type: RelationType;
  /** Target mechanism id, e.g. "EN-03". */
  target: string;
  note: string;
}

export interface Telemetry {
  tag_format: string;
  amplitude_event_property: string;
}

export interface ReferenceExample {
  product: string;
  what: string;
}

/** Owner-pinned paper the evidence connector merges by DOI (D-017). */
export interface PinnedEvidence {
  title: string;
  doi: string;
  reason: string;
}

export interface Mechanism {
  $schema?: string;
  /** Pattern: [A-Z]{2}-\d{2} */
  id: string;
  slug: string;
  name: string;
  /** Semver */
  version: string;
  level: "L1";
  parent: TaxonomyNodeId;
  lifecycle_status: LifecycleStatus;
  /** Path to the dossier when it exists; null until then. */
  dossier_ref: string | null;
  provenance: Provenance;
  evidence: Evidence;
  /** Owner-provided search terms for the evidence connector (D-015); must
   *  include disconfirming/boundary terms, not only confirming ones. */
  evidence_terms?: string[];
  /** Owner-pinned works the connector cannot surface (D-017); merged into
   *  the evidence corpus with source_api "pinned". */
  pinned_evidence?: PinnedEvidence[];
  /** 0–1 */
  prior_weight: number;
  mechanism_summary_for_context: string;
  applicability: Applicability;
  implementations: Implementation[];
  constraints: Constraints;
  relations: Relation[];
  telemetry: Telemetry;
  reference_examples?: ReferenceExample[];
}

// ---------- Seed stub, reduced shape (§3.2, _seed/) ----------

export interface SeedStub {
  /** Pattern: [A-Z]{2}-\d{2} */
  id: string;
  name: string;
  /** Free-form draft grade (e.g. "A", "B+", "A-"), not the strict evidence grade. */
  grade_draft: string;
  oneliner: string;
  parent: TaxonomyNodeId;
  lifecycle_status: "candidate";
}

// ---------- Dossier, admission gate (§3.3) ----------

/** Axis score, integer 0–3. */
export type AxisScore = 0 | 1 | 2 | 3;

export interface DossierScores {
  evidence: AxisScore;
  product_applicability: AxisScore;
  measurability: AxisScore;
  orthogonality: AxisScore;
  safety: AxisScore;
}

export type DossierVerdict = "incubating" | "core" | "rejected" | "hold";

/**
 * Thresholds: to enter incubating — total >= 11 AND evidence >= 2 AND
 * safety >= 2; to enter core — additionally at least one measured effect.
 */
export interface Dossier {
  $schema?: string;
  id: string;
  /** Pattern: [A-Z]{2}-\d{2} */
  mechanism_id: string;
  scores: DossierScores;
  /** Sum of the five axis scores, 0–15. */
  total: number;
  evidence_sources: string[];
  verdict: DossierVerdict;
  decided_by: string;
  /** ISO date, YYYY-MM-DD */
  date: string;
  notes: string;
}

// ---------- Data-source registry (§3.4) ----------

export type SourceClassId = "A" | "B" | "C" | "D";

export type SourcePriority = "P0" | "P1" | "P2";

/**
 * How a source gets into the knowledge layer (D-013, D-016):
 * - api — automated connector against a public API
 * - internal — data produced by our own platform, not an external source
 * - report — one-off ingested artifact (published report / dataset)
 * - manual — licensed human curation, never machine-harvested
 * - deferred — P2 / not planned this phase
 */
export type ConnectionMode = "api" | "internal" | "report" | "manual" | "deferred";

/**
 * Computed source state (never stored): api sources are connected iff their
 * corpus manifest reports a successful last run; report sources are ingested
 * iff additionally a data file is present on disk; manual and deferred
 * sources show their mode — a connectivity claim would be a lie.
 */
export type ComputedSourceState =
  | "connected"
  | "not_connected"
  | "ingested"
  | "not_ingested"
  | "manual"
  | "deferred";

export type SourceAccess =
  | "open"
  | "free"
  | "freemium"
  | "registration"
  | "subscription"
  | "mixed"
  | "internal (Amplitude export)"
  | "public archives (failure story collections, Indie Hackers)"
  | "subscription/free galleries"
  | "academic literature via evidence connector + curated reports";

/** What a source feeds: ontology levels or loop artifacts. */
export type SourceFeed =
  | "L0"
  | "L1"
  | "L2"
  | "L3"
  | "dossiers"
  | "effects"
  | "weights"
  | "constraints";

export interface Source {
  id: string;
  name: string;
  what: string;
  access: SourceAccess;
  api: boolean;
  cost: string;
  priority: SourcePriority;
  phase: string;
  connection_mode: ConnectionMode;
  /** Rationale for the mode where it is not obvious (mostly deferred). */
  mode_note?: string;
  feeds: SourceFeed[];
  legal_note?: string;
}

export interface SourceClass {
  id: SourceClassId;
  name: string;
  sources: Source[];
}

export interface SourcesRegistry {
  classes: SourceClass[];
}

// ---------- Corpus manifest (read-only mirror of tools/connectors/types.ts) ----------

/**
 * The evidence category checklist (D-019), mirrored from
 * tools/connectors/types.ts: corpus completeness is verified structurally —
 * every harvested corpus is expected to cover all five categories.
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

export type CorpusRunStatus = "success" | "partial" | "failed";

/**
 * Cost accounting for one run (D-022), mirrored from
 * tools/connectors/types.ts ManifestCost. token fields are reserved for
 * future LLM jobs (null until an engine exists); estimated_usd is computed,
 * 0 for the free D-011 public APIs.
 */
export interface CorpusManifestCost {
  api_calls: number;
  duration_s: number;
  tokens_in: number | null;
  tokens_out: number | null;
  estimated_usd: number;
}

/** One manifest run entry (last_run / run_history). */
export interface CorpusManifestRun {
  timestamp: string;
  status: CorpusRunStatus;
  params: Record<string, string>;
  records_fetched: number;
  files_written: number;
  duration_s: number;
  error?: string;
  warnings?: Record<string, boolean>;
  /** Cost accounting (D-022); absent for runs recorded before D-022. */
  cost?: CorpusManifestCost;
}

/**
 * Manifest shape the showcase needs to compute source states and the
 * /connectors cockpit from /corpora/{corpus}/manifest.json. The full
 * contract (and its writer) lives in tools/connectors/types.ts; lib/ never
 * imports from tools/. A connector is not a source (D-014): `source_ids`
 * lists the sources.json ids the corpus harvests; source states are
 * computed from that field.
 */
export interface CorpusManifest {
  source_id: string;
  source_ids: string[];
  connector_version: string;
  last_run: CorpusManifestRun;
  run_history: CorpusManifestRun[];
  data_files: {
    path: string;
    records: number;
    bytes: number;
    /** Category checklist counts (D-019); absent for unclassified files. */
    categories?: CategoryCounts;
  }[];
}

// ---------- Benchmark corpus (read-only mirror of tools/ingest-report.ts, D-029) ----------

/**
 * One benchmark value extracted from a report source (D-029). Reader mirror
 * of tools/ingest-report.ts BenchmarkMetric (lib/ never imports from tools/);
 * a drift guard in tools/validate.ts pins the writer to this reader. Feeds
 * the future effects-table baseline column.
 */
export interface BenchmarkMetric {
  /** What is measured, e.g. "trial_to_paid_cvr". */
  metric: string;
  /** The segment the value applies to (app category, industry, pattern). */
  category?: string;
  /** The measured number, as reported. */
  value: number;
  /** Unit of `value`, e.g. "%", "count", "usd". */
  unit: string;
  /** Provenance / caveat for the value. */
  notes?: string;
}

/**
 * /corpora/benchmarks/{source_id}.json — one report source's benchmark
 * table, written by tools/ingest-report.ts from an owner-prepared file. The
 * corpus manifest (source_id "benchmarks") declares which report sources it
 * covers in source_ids; a source is ingested iff a manifest lists it AND its
 * data file exists on disk (D-026, computed in lib/status.ts).
 */
export interface BenchmarkFile {
  /** The sources.json id this file was ingested for. */
  source_id: string;
  /** ISO date (YYYY-MM-DD) the numbers were read from the report. */
  retrieved: string;
  metrics: BenchmarkMetric[];
}

// ---------- Source health heartbeat (read-only mirror of tools/health-check.ts, D-021) ----------

/**
 * Health of a source's API right now — a separate axis from connection
 * (D-021). Recorded by tools/health-check.ts, never measured by the app:
 * - ok — the probe got a 2xx
 * - degraded — throttled (HTTP 429/206, the s2_throttled condition)
 * - down — network error, timeout, or 5xx
 * - unknown — no probe exists (host not in the D-011 whitelist), no
 *   heartbeat yet, or the heartbeat is stale (>12h) — stale never renders ok
 * - n_a — internal source, no external endpoint by design
 */
export type HealthStatus = "ok" | "degraded" | "down" | "unknown" | "n_a";

/** One probed source in /corpora/_health/heartbeat.json. */
export interface HeartbeatEntry {
  source_id: string;
  checked_at: string;
  status: HealthStatus;
  /** Round-trip of the probe; null when no request was made. */
  latency_ms: number | null;
  note: string;
}

/**
 * The heartbeat file shape. The writer contract lives in
 * tools/health-check.ts (lib/ never imports from tools/); a drift guard in
 * tools/validate.ts pins the writer to this reader.
 */
export interface HeartbeatFile {
  generated_at: string;
  entries: HeartbeatEntry[];
}

// ---------- Operational config (/corpora/_ops, D-024) ----------

/**
 * /corpora/_ops/budget.json — the monthly ceiling the scheduler respects
 * before starting new runs. Reader mirror of tools/connectors/types.ts
 * OpsBudget; a drift guard in tools/validate.ts pins writer → reader.
 */
export interface OpsBudget {
  monthly_caps: {
    usd: number;
    calls: number;
  };
}

/**
 * /corpora/_ops/connectors/{id}.json — one connector's operating config
 * (D-024). Reader mirror of tools/connectors/types.ts OpsConnectorConfig.
 */
export interface OpsConnectorConfig {
  connector_id: string;
  paused: boolean;
  paused_reason: string | null;
  cadence: {
    every_days: number;
  };
  limits: {
    max_calls_per_run: number;
    max_records_per_run: number;
  };
  targets: string[];
}

/**
 * Deterministic pre-run cost estimate (D-025). Reader mirror of
 * tools/connectors/types.ts RunQuote; drives the /ops budget snapshot and the
 * dry-run quote panel. A drift guard in tools/validate.ts pins writer → reader.
 */
export interface RunQuote {
  calls: number;
  records: number;
  duration_s: number;
  estimated_usd: number;
}

// ---------- Decision log (§3.5) ----------

export type DecisionArea =
  | "architecture"
  | "data"
  | "process"
  | "stack"
  | "operations";

export interface Decision {
  /** Pattern: D-\d{3} */
  id: string;
  /** ISO date, YYYY-MM-DD */
  date: string;
  title: string;
  body: string;
  area: DecisionArea;
}

export interface DecisionsLog {
  decisions: Decision[];
}

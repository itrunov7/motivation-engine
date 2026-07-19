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

export type EvidenceGrade =
  | "A+"
  | "A"
  | "A-"
  | "B+"
  | "B"
  | "B-"
  | "C+"
  | "C"
  | "C-";

export type RelationType =
  | "enabled_by"
  | "enables"
  | "adjacent"
  | "hybrid_with"
  | "orthogonality_note";

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
  /** Optional owner annotation explaining a bundled/managed-overlap L1 (D-042). */
  orthogonality_note?: string;
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
  /** Owner-provided search terms for the evidence connector (D-015),
   *  permitted on a stub so a candidate can be harvested before it is
   *  fleshed out. Mirrors the schema's seedStub sub-schema (D-033). */
  evidence_terms?: string[];
  /** Owner-pinned works the connector cannot surface (D-017), permitted on a
   *  stub; merged into the evidence corpus with source_api "pinned". */
  pinned_evidence?: PinnedEvidence[];
}

// ---------- Dossier, admission gate (§3.3) ----------

/** Axis score, integer 0–3. */
export type AxisScore = 0 | 1 | 2 | 3;

/**
 * One scored axis: the integer score plus its markdown rationale. The prose
 * is part of the scientific record, not decoration (Option A) — JSON is the
 * source of truth, /dossiers renders the markdown.
 */
export interface DossierAxis {
  score: AxisScore;
  /** Markdown justification for the score, entered by the owner. */
  rationale: string;
}

export interface DossierScores {
  evidence: DossierAxis;
  product_applicability: DossierAxis;
  measurability: DossierAxis;
  orthogonality: DossierAxis;
  safety: DossierAxis;
}

/** One cited source backing the dossier; doi is optional (books, preprints). */
export interface DossierEvidenceSource {
  ref: string;
  doi?: string;
}

export type DossierVerdict = "incubating" | "core" | "rejected" | "hold";

/**
 * Thresholds: to enter incubating — total >= 11 AND evidence >= 2 AND
 * safety >= 2; to enter core — additionally at least one measured effect
 * (stated in core_condition).
 */
export interface Dossier {
  $schema?: string;
  id: string;
  /** Pattern: [A-Z]{2}-\d{2} */
  mechanism_id: string;
  scores: DossierScores;
  /** Sum of the five axis scores, 0–15. */
  total: number;
  /** The measured condition under which the mechanism may be promoted to core. */
  core_condition: string;
  /** Documented counter-evidence (markdown) — every dossier addresses dissent. */
  dissent: string;
  evidence_sources: DossierEvidenceSource[];
  verdict: DossierVerdict;
  decided_by: string;
  /** ISO date, YYYY-MM-DD */
  date: string;
  notes: string;
  /** Optional owner flag: lowest-scoring mechanism admitted to incubating (D-042). */
  flag_lowest_admitted?: boolean;
  /** Optional owner flag: the dossier that completes the 12-mechanism core admission (D-045). */
  flag_completes_core?: boolean;
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

// ---------- Product segments (/segments/segments.yaml, D-047) ----------

/** The axis a segment classifies a product along. */
export type SegmentGroup =
  | "business-model"
  | "form"
  | "audience"
  | "usage-rhythm";

/**
 * Lifecycle of a segment. A segment no longer in use is "retired" (kept for
 * history), never deleted from the file.
 */
export type SegmentStatus = "active" | "retired";

/**
 * One product segment — a type of OUTPUT product Ventora builds, NOT a
 * description of Ventora itself. First-class, evolving system data the rest
 * of the layer references. Validated by tools/validate.ts against a schema
 * pinned to this reader (D-047).
 */
export interface Segment {
  /** Slug id, pattern ^[a-z0-9-]+$. */
  id: string;
  group: SegmentGroup;
  /** One-line definition of the segment. */
  definition: string;
  status: SegmentStatus;
  /**
   * Where the segment came from: "seed-YYYY-MM" for the owner seed set,
   * "analyzer" for derived additions, "owner" for later hand-added ones.
   */
  provenance: string;
}

/** /segments/segments.yaml — the product-segment axis. */
export interface SegmentsFile {
  version: string;
  segments: Segment[];
}

/**
 * Review state of a proposed segment in the candidates queue (D-054): a
 * candidate is "proposed" until the owner "approved" it (promoted into
 * segments.yaml with provenance analyzer) or "rejected" it.
 */
export type SegmentCandidateStatus = "proposed" | "approved" | "rejected";

/**
 * One proposed segment awaiting owner approval — the discovery analog of a
 * mechanism seed stub (D-054). Written by tools/segment-suggest.ts (designed,
 * not yet scheduled) from recurring product-context clusters in the harvested
 * corpora that no active segment covers. The owner reviews the queue and, on
 * approval, hand-adds the segment to segments.yaml with provenance "analyzer";
 * it then enters the sufficiency matrix all-red via the analyzer bootstrap
 * path and matures through the loop. Never a scientific claim.
 */
export interface SegmentCandidate {
  /** Proposed slug id, pattern ^[a-z0-9-]+$ (mirrors Segment.id). */
  id: string;
  group: SegmentGroup;
  /** Draft one-line definition for owner review; not authoritative until promoted. */
  definition_draft: string;
  /** Why the analyzer proposed it — the corpus clusters that surfaced it. */
  evidence_note: string;
  /** ISO timestamp the candidate was proposed. */
  proposed_at: string;
  status: SegmentCandidateStatus;
}

/**
 * /segments/candidates.json — the owner-approval queue for analyzer-proposed
 * segments (D-054). Generated output (never hand-authored beyond the seeded
 * empty queue); segment-suggest appends proposals here for owner review.
 */
export interface SegmentCandidateQueue {
  version: string;
  /** ISO timestamp of the last segment-suggest run; null until it first runs. */
  generated_at: string | null;
  candidates: SegmentCandidate[];
}

// ---------- Pack map (/packs/pack-map.yaml, D-048) ----------

/**
 * Funnel stage vocabulary, mirroring the registry applicability stages
 * (registry/mechanisms/*.json applicability.funnel_stages). A pack-map
 * element's stage records evidence relevance, not runtime applicability.
 */
export type FunnelStage =
  | "cold_acquisition"
  | "onboarding"
  | "activation"
  | "conversion"
  | "retention"
  | "reactivation";

/**
 * One Development-Plan element type mapped to the mechanisms whose evidence is
 * relevant to it — the sole hand-authored input to pack generation (D-048).
 * Everything downstream (packs) is a computed projection over this map plus
 * the registry. Validated by tools/validate.ts against a schema pinned to this
 * reader; every `mechanisms` id must resolve to a registry record.
 */
export interface PackMapElement {
  /** Element type slug (unique), e.g. "paywall-conversion". */
  id: string;
  /** Product surfaces this element covers (free-text slugs). */
  applies_to: string[];
  funnel_stage: FunnelStage;
  /** Mechanism ids whose evidence is relevant; each must exist in the registry. */
  mechanisms: string[];
  /** Optional owner annotation, e.g. "guardrail-forward". */
  note?: string;
}

/** /packs/pack-map.yaml — the pack map. */
export interface PackMapFile {
  version: string;
  elements: PackMapElement[];
}

// ---------- Pack datasheet (/packs/pack-{id}.yaml, D-049) ----------
//
// A pack is a COMPUTED projection over the pack map + the registry, generated
// by tools/render-packs.ts (`npm run packs`) and never hand-authored. Its
// structure is pinned to the reference file pack-paywall-conversion.yaml:
// header + LAYER 1 mechanisms + LAYER 2 interactions + LAYER 3 context_weights
// + hard_boundaries + signals + wiring. Knowledge-base tone: facts only, no
// instructions.

/** LAYER 1 — one mechanism atom, projected from a registry record. */
export interface PackMechanism {
  id: string;
  /** Record name, lowercased. */
  name: string;
  /** First sentence of mechanism_summary_for_context. */
  fact: string;
  grade: EvidenceGrade;
  /** evidence.basis plus pinned-evidence DOIs. */
  source: string;
  /** Humanized evidence.caveats plus dossier dissent citation. */
  boundary: string;
  /** Precondition predicates, joined with OR when several. */
  active_when: string;
  /** Implementation ids with the "{ID}-" prefix stripped. */
  realizations: string[];
  /** Hard-rule ids, kebab-cased. */
  forbidden: string[];
}

/**
 * How two co-present mechanisms interact. sequence-amplifying / reinforcing /
 * noted are derived from record relations; suppressing / neutral arrive only
 * from authored interaction records (D-057), which the relation types cannot
 * express.
 */
export type PackInteractionType =
  | "sequence-amplifying"
  | "reinforcing"
  | "suppressing"
  | "neutral"
  | "noted";

/** LAYER 2 — one interaction between two of the pack's mechanisms. */
export interface PackInteraction {
  combination: string[];
  type: PackInteractionType;
  /** The relation note, or the authored interaction fact (D-057). */
  fact: string;
  /** The weaker of the two members' grades, or the authored grade (D-057). */
  grade: EvidenceGrade;
  /** Authored records only (D-057) — the interaction's boundary condition. */
  boundary?: string;
  /** Authored records only (D-057) — the interaction's evidence basis. */
  source?: string;
}

/** LAYER 3 — a context and the mechanisms it makes strong or inactive. */
export interface PackContextWeight {
  context: string;
  strong?: string[];
  inactive?: string[];
}

/** Telemetry block — what the pack's realizations are measured against. */
export interface PackSignals {
  measured: string[];
  tag: string;
  learning: string;
}

/** The one human-facing block; not read at generation time. */
export interface PackWiring {
  where: string;
  how: string;
  selection_now: string;
  selection_later: string;
  provenance: string;
}

/** A full pack datasheet — the generated projection for one element. */
export interface PackDatasheet {
  pack: string;
  applies_to: string[];
  funnel_stage: FunnelStage;
  version: string;
  nature: string;
  source: string;
  mechanisms: PackMechanism[];
  interactions: PackInteraction[];
  context_weights: PackContextWeight[];
  /** Each entry is a single-key map, e.g. { "fake-scarcity": "forbidden — ..." }. */
  hard_boundaries: Record<string, string>[];
  signals: PackSignals;
  wiring: PackWiring;
}

// ---------- Interaction records (/interactions, D-057) ----------
//
// An interaction is a first-class OWNER-AUTHORED record of how two mechanisms
// interact when co-present — the primary structural filler for
// interaction_coverage. Files live at /interactions/{MECH-A}__{MECH-B}.json
// with the pair sorted (id.localeCompare). Content is owner-provided, never
// Cursor-generated (rule 8). The analyzer counts an authored record as a
// covered pair (in addition to registry relations); render-packs projects it
// into LAYER 2, replacing the relation-derived entry for the same pair.

/** How two co-present mechanisms interact, as authored by the owner (D-057). */
export type InteractionType =
  | "sequence-amplifying"
  | "reinforcing"
  | "suppressing"
  | "neutral";

/** /interactions/{A}__{B}.json — one owner-authored pairwise interaction. */
export interface InteractionRecord {
  /** The two mechanism ids, sorted (id.localeCompare); matches the filename. */
  pair: [string, string];
  type: InteractionType;
  /** The interaction fact — knowledge-voice, no instructions. */
  fact: string;
  grade: EvidenceGrade;
  /** When/where the interaction does not hold — the boundary condition. */
  boundary: string;
  /** Evidence basis / citation for the interaction. */
  source: string;
}

// ---------- Sufficiency analyzer (/analysis, D-050) ----------
//
// tools/analyzer.ts (npm run analyze) scores every [pack × active segment]
// cell on 5 computable criteria against the registry + dossiers, driven by
// the ONE hand-authored input analysis/analyzer.config.yaml. The matrix
// (analysis/sufficiency-matrix.json) is a COMPUTED projection, never
// hand-edited.

/** The five sufficiency criteria a cell is scored on (each 0–1). */
export type SufficiencyCriterion =
  | "dissent_completeness"
  | "grade_sufficiency"
  | "interaction_coverage"
  | "context_coverage"
  | "freshness";

/** Criterion scores for one cell, keyed by SufficiencyCriterion. */
export type SufficiencyScores = Record<SufficiencyCriterion, number>;

export type SufficiencyStatus = "red" | "amber" | "green";

/**
 * Whether a cell's scores rest on any segment-specific judgment
 * (a segment_affinity entry touching the pack) or on general evidence only.
 * general_only is the signal that segment-specific harvesting is needed.
 */
export type SegmentEvidence = "segment_specific" | "general_only";

/**
 * How a gap can actually be closed — the fix that stops the wheel spinning
 * (D-055). harvest gaps are closed by fetching more/better evidence through
 * the connector; structural gaps are closed by owner edits in git (registry
 * relations, pack composition, dossier dissent) and NO harvest can touch them.
 * The maturation loop must never dispatch a harvest against a structural gap.
 */
export type GapFixType = "harvest" | "structural";

/**
 * A failing criterion in a cell, typed by its filler (D-055). criterion is a
 * SufficiencyCriterion, or the pseudo-criterion "segment_evidence" — not a
 * scored criterion but a harvest-closable gap (general_only means
 * segment-specific evidence is missing).
 */
export interface TypedGap {
  criterion: SufficiencyCriterion | "segment_evidence";
  /** The cell's score for this criterion (0 for the segment_evidence pseudo-gap). */
  value: number;
  /** The green threshold the value falls short of (1 for segment_evidence). */
  threshold: number;
  fix_type: GapFixType;
  /** Plain-language description of the fix that would close this gap. */
  what_would_close_it: string;
  /**
   * interaction_coverage only — the pack's member-mechanism id pairs NOT yet
   * connected by a registry relation, so the owner sees exactly which links to
   * author. Each pair is sorted (id.localeCompare) and the list is stable.
   */
  missing_interaction_pairs?: [string, string][];
  /**
   * context_coverage only — the segment's typical funnel stages the pack does
   * NOT cover with a grade≥min_context_grade mechanism, so the owner sees which
   * stages need composition.
   */
  uncovered_stages?: FunnelStage[];
}

/** score ≥ green → green, ≥ amber → amber, else red. */
export interface SufficiencyThreshold {
  green: number;
  amber: number;
}

/** Grade letter family; the +/- modifier collapses (A- → A). */
export type GradeLetter = "A" | "B" | "C";

/**
 * /analysis/analyzer.config.yaml — the owner-tunable analyzer input:
 * grade weights, per-criterion thresholds, the segment → typical-funnel-stage
 * map, segment-affinity boosts, and owner replication flags. segment_stages
 * and segment_affinity are product judgment defaults, not science claims.
 */
export interface AnalyzerConfig {
  version: string;
  grade_weights: Record<GradeLetter, number>;
  /** The "grade ≥ B" cutoff for context_coverage. */
  min_context_grade: EvidenceGrade;
  thresholds: { default: SufficiencyThreshold } & Partial<
    Record<SufficiencyCriterion, SufficiencyThreshold>
  >;
  /** Every active segment must have an entry; the analyzer fails loudly otherwise. */
  segment_stages: Record<string, FunnelStage[]>;
  /** Segment → mechanism boost; presence marks segment-specific judgment. */
  segment_affinity: Record<string, Record<string, number>>;
  /** Mechanism ids flagged replication-shaky by the owner (freshness). */
  replication_flags: string[];
}

/** One scored [pack × segment] cell of the sufficiency matrix. */
export interface SufficiencyCell {
  pack: string;
  segment: string;
  scores: SufficiencyScores;
  status: SufficiencyStatus;
  /** Criteria below their green threshold, i.e. what fails this cell. */
  gaps: SufficiencyCriterion[];
  /**
   * The same gaps typed by their filler (D-055) — the richer superset the
   * maturation loop reads. Every failing criterion carries a fix_type
   * (harvest vs structural) plus what_would_close_it; a cell's gaps can be
   * mixed type, and the general_only condition surfaces as a segment_evidence
   * harvest gap. `gaps` above stays for the planner + cockpit that read it.
   */
  typed_gaps: TypedGap[];
  segment_evidence: SegmentEvidence;
}

/** /analysis/sufficiency-matrix.json — the generated sufficiency matrix. */
export interface SufficiencyMatrix {
  version: string;
  generated_at: string;
  /** The analyzer.config.yaml version the matrix was scored with. */
  config_version: string;
  cells: SufficiencyCell[];
}

// ---------- Gap planner (/analysis/research-queue.json, D-051) ----------
//
// tools/gap-planner.ts (npm run gaps) ranks the red/amber cells of the
// sufficiency matrix into a budget-bounded queue of targeted, segment-qualified
// evidence harvests. Its ONE hand-authored input is the gap_planner block of
// analysis/analyzer.config.yaml; analysis/research-queue.json is a COMPUTED
// projection, never hand-edited (same pattern as the sufficiency matrix).

/** gap_planner.budget — how the monthly cap system bounds the queue length. */
export interface GapPlannerBudgetConfig {
  /** Hard ceiling on queued tasks. */
  max_tasks: number;
  /** Estimated evidence-connector calls one task spends (≈ one run). */
  estimated_calls_per_task: number;
  /** Fraction of the remaining monthly calls the queue may claim, in (0, 1]. */
  monthly_budget_share: number;
}

/**
 * The gap_planner block of analysis/analyzer.config.yaml — owner-tunable
 * priority judgment (segment_weights) and segment vocabulary
 * (segment_qualifiers), neither a scientific claim.
 */
export interface GapPlannerConfig {
  version: string;
  /** Segment id → importance weight; omitted segments default to 1.0. */
  segment_weights?: Record<string, number>;
  /** Segment id → qualifier tokens appended to a mechanism's evidence terms. */
  segment_qualifiers: Record<string, string>;
  budget: GapPlannerBudgetConfig;
}

/** The gap cell a research task addresses (a subset of a SufficiencyCell). */
export interface ResearchGapCell {
  pack: string;
  segment: string;
  status: SufficiencyStatus;
  gaps: SufficiencyCriterion[];
  segment_evidence: SegmentEvidence;
}

/** One prioritized, segment-qualified harvest task for the evidence connector. */
export interface ResearchTask {
  gap_cell: ResearchGapCell;
  /** Mechanism id to harvest (resolves in /registry/mechanisms). */
  mechanism: string;
  segment: string;
  /** segment_weight × gap_size; higher = more important. */
  importance: number;
  /** Mechanism evidence terms qualified with the segment's vocabulary. */
  suggested_evidence_terms: string[];
  /** Human-readable, computed from the cell's failed criteria + scores. */
  reason: string;
}

/** How the monthly budget/cap system bounded the queue length (D-051). */
export interface ResearchQueueBudget {
  /** UTC "YYYY-MM" the snapshot was taken in. */
  month: string;
  /** Remaining monthly calls (caps − month-to-date used), from the ops snapshot. */
  monthly_remaining_calls: number;
  monthly_budget_share: number;
  estimated_calls_per_task: number;
  /** floor(monthly_remaining_calls × monthly_budget_share / estimated_calls_per_task). */
  budget_max_tasks: number;
  /** gap_planner.budget.max_tasks. */
  config_max_tasks: number;
  /** min(config_max_tasks, budget_max_tasks) — the applied N. */
  effective_max_tasks: number;
}

/** /analysis/research-queue.json — the generated research queue (D-051). */
export interface ResearchQueue {
  version: string;
  generated_at: string;
  /** The analyzer.config.yaml version the gap_planner block was read from. */
  config_version: string;
  /** generated_at of the sufficiency matrix this queue was ranked from. */
  matrix_generated_at: string;
  budget: ResearchQueueBudget;
  /** Total red/amber (mechanism × segment) candidates before truncation to N. */
  candidate_count: number;
  /**
   * Candidates skipped because the mechanism's last harvest with the SAME terms
   * was low-novelty (D-058) — re-fetching the same canon is not progress, so it
   * never consumes a budget slot. Counted here so the queue never silently
   * shrinks; changing the mechanism's terms or the segment qualifier re-enables it.
   */
  low_novelty_skipped: number;
  tasks: ResearchTask[];
}

// ---------- Authoring queue (/analysis/authoring-queue.json, D-056) ----------
//
// tools/gap-planner.ts routes gaps by fix_type (D-055). Harvest gaps become
// budgeted connector tasks in research-queue.json; STRUCTURAL gaps — the ones
// no API call can close (registry relations, pack composition, dossier
// dissent) — are written here instead, owner-facing, so the loop never burns
// harvest budget against them. A COMPUTED projection, never hand-edited (the
// research-queue precedent, D-051); consumed by the owner in git, not by the
// connector.

/** One [pack × segment] cell's structural gaps, awaiting an owner edit in git. */
export interface AuthoringTask {
  pack: string;
  segment: string;
  status: SufficiencyStatus;
  /** segment_weight × Σ (green_threshold − score) over structural gaps only. */
  importance: number;
  segment_evidence: SegmentEvidence;
  /** The cell's structural typed gaps (interaction/context/dissent), with detail. */
  structural_gaps: TypedGap[];
}

/** /analysis/authoring-queue.json — structural gaps ranked for owner authoring. */
export interface AuthoringQueue {
  version: string;
  generated_at: string;
  /** The analyzer.config.yaml version the gap_planner block was read from. */
  config_version: string;
  /** generated_at of the sufficiency matrix this queue was ranked from. */
  matrix_generated_at: string;
  /** Red/amber cells carrying ≥1 structural gap (the length of tasks). */
  cell_count: number;
  tasks: AuthoringTask[];
}

// ---------- Maturation log (/analysis/maturation-log.json, D-053) ----------
//
// tools/maturation-log.ts appends one entry per weekly maturation run
// (.github/workflows/maturation.yml, D-052) from the artifacts that run
// already produces: the red→green cell diff, the flipped packs, the budget
// snapshot delta, and the deferred-task count. The file is generated output
// (the sufficiency-matrix / research-queue precedent) — never hand-edited —
// and is what the /maturation cockpit reads to show the week-over-week
// history instead of the ephemeral GitHub Actions job summary.

/** One [pack × segment] cell whose status changed in a maturation run. */
export interface MaturationCellChange {
  pack: string;
  segment: string;
  from: SufficiencyStatus;
  to: SufficiencyStatus;
}

/** One weekly maturation run recorded from the workflow's own artifacts. */
export interface MaturationLogEntry {
  /** UTC "YYYY-MM-DD" of the run (the week label). */
  week: string;
  /** ISO timestamp the entry was appended. */
  generated_at: string;
  /** Every cell whose status changed this run (red→green and any other flip). */
  cells_changed: MaturationCellChange[];
  /** Packs regenerated because a cell flipped to green (npm run packs -- packs=…). */
  packs_regenerated: string[];
  /** Budget-snapshot delta for the run (before→after), from ops-gate budget. */
  spend: {
    calls: number;
    usd: number;
  };
  /** Tasks the plan-queue gate deferred to next week over budget (D-052). */
  deferred: number;
  /**
   * Structural gaps routed to analysis/authoring-queue.json this run (D-056) —
   * cells needing an owner edit in git, never a harvest. Optional so entries
   * written before D-056 stay valid.
   */
  structural_queued?: number;
  /**
   * Harvests this run that returned mostly records already in the corpus
   * (low_novelty, D-058) — a re-fetch of the same canon, NOT progress. Optional
   * so entries written before D-058 stay valid.
   */
  low_novelty_harvests?: number;
}

/** /analysis/maturation-log.json — the append-only weekly maturation history. */
export interface MaturationLog {
  version: string;
  generated_at: string;
  /** Newest run last; the reader sorts for display. */
  entries: MaturationLogEntry[];
}

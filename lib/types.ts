/**
 * Data types mirroring the JSON schemas (SPEC.md §3).
 * Sources of truth:
 * - /registry/mechanism.schema.json (full L1 record + seed stub sub-schema)
 * - /registry/taxonomy.json shape (SPEC.md §3.1)
 * - /dossiers/dossier.schema.json (SPEC.md §3.3)
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

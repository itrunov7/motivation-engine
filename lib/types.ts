/**
 * Data types mirroring the JSON schemas (SPEC.md §3).
 * Sources of truth:
 * - /registry/mechanism.schema.json (full L1 record + seed stub sub-schema)
 * - /effects/effect.schema.json (first-class L2 records)
 * - /proposals/proposal.schema.json (universal proposal envelope)
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

/** L0 taxonomy node id (S1–S8). */
export type TaxonomyNodeId =
  | "S1"
  | "S2"
  | "S3"
  | "S4"
  | "S5"
  | "S6"
  | "S7"
  | "S8";

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
  sdt?: string;
}

export interface TaxonomyNode {
  id: TaxonomyNodeId;
  name: string;
  anchors: TaxonomyAnchors;
  description: string;
  /** A cross-cutting node applies to every generated element, not to
   *  specific funnel stages (D-062). Optional; absent === false. */
  cross_cutting?: boolean;
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
  /** Optional first-class L2 effect this L3 realization embodies. */
  effect_id?: string;
  /** Optional descriptive realizations that ground this product-authored directive. */
  realization_ids?: string[];
  artifact_types: ArtifactType[];
  product_requirements: string[];
  generation_directive: string;
  copy_formulas: string[];
  /** Hard rule: must be non-empty, otherwise the record is invalid. */
  metrics: string[];
  /** Measured product outcomes from telemetry; never references to L2 effects. */
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
  /** A record under a cross-cutting L0 node (D-062, e.g. S7) applies to every
   *  generated element, not to specific funnel stages. Optional; absent === false. */
  cross_cutting?: boolean;
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
  /** First-class L2 effect ids under /effects/{id}/; absent until effects are approved. */
  effect_refs?: string[];
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
  /** A stub under a cross-cutting L0 node (D-062) applies to every generated
   *  element, not to specific funnel stages. Optional; absent === false. */
  cross_cutting?: boolean;
  /** Owner-provided search terms for the evidence connector (D-015),
   *  permitted on a stub so a candidate can be harvested before it is
   *  fleshed out. Mirrors the schema's seedStub sub-schema (D-033). */
  evidence_terms?: string[];
  /** Owner-pinned works the connector cannot surface (D-017), permitted on a
   *  stub; merged into the evidence corpus with source_api "pinned". */
  pinned_evidence?: PinnedEvidence[];
}

// ---------- Effects, first-class L2 records (/effects, D-076) ----------

/**
 * Where a quote sits in its source record, and which version of that record it
 * was resolved against (D-110).
 *
 * `start`/`end` are character offsets into the string
 * `lib/proposal-quality.evidenceSourceText` returns, end-exclusive, so
 * `evidenceSourceText(record).slice(start, end)` re-derives the quote. Offsets
 * alone are not enough: a re-harvested or re-normalised record leaves them
 * pointing at different words with nothing to say so, which is why the hash of
 * the exact text they were resolved against travels with them. A mismatch makes
 * the span STALE — a named, surfaced condition — instead of a silent relocation.
 */
export interface ProvenanceSourceSpan {
  start: number;
  end: number;
  /** Hex sha256 of the exact source text the offsets were resolved against. */
  source_text_sha256: string;
}

/**
 * What a span is DOING in the text it was cut from (D-129).
 *
 * A quote can be verbatim and still misrepresent the paper, because a paper is
 * not one voice: it restates what the literature predicts, states what it set
 * out to test, describes what it did, reports what it found, and admits what it
 * cannot show. Only the fourth of those is a finding. Two of the four proposals
 * from the first extraction run quoted a background premise as though the study
 * had found it, and one of those papers went on to report the opposite — a
 * failure no grounding check can catch, because the quote was genuinely there.
 */
export const SPAN_ROLES = [
  "background",
  "hypothesis",
  "method",
  "finding",
  "limitation",
] as const;

export type SpanRole = (typeof SPAN_ROLES)[number];

export function isSpanRole(value: unknown): value is SpanRole {
  return typeof value === "string" && (SPAN_ROLES as readonly string[]).includes(value);
}

/** One literature locus grounding an effect or proposal. */
export interface EvidenceProvenanceItem {
  /** Omitted for backwards compatibility with pre-C2 evidence records. */
  corpus_kind?: "evidence";
  mechanism_id: string;
  corpus_record_id: string;
  /** Null when the source record has no DOI. */
  doi: string | null;
  title: string;
  quote_or_locus: string;
  /**
   * Optional in the schema so hand-authored records written before D-110 stay
   * valid, but REQUIRED of anything the extraction pipeline produces — enforced
   * in code, in the provenance builder and in tools/validate.ts, not by
   * convention. An extraction-authored item without it fails validation.
   */
  source_span?: ProvenanceSourceSpan;
  /**
   * The rhetorical role of this span in its source (D-129). Enforced exactly as
   * `source_span` above: optional in the schema so items written before D-129
   * stay valid, required in code of anything the extraction pipeline produces.
   * Absent means the item predates the decision, which is a different fact from
   * a role nobody could determine.
   */
  span_role?: SpanRole;
}

/** One interface-evidence locus from the realization corpus (D-081). */
export interface RealizationCorpusProvenanceItem {
  corpus_kind: "realization";
  mechanism_id: string;
  corpus_record_id: string;
  source_id: string;
  title: string;
  quote_or_locus: string;
  /** Present only for owner-assisted records from manual sources. */
  contributed_by: string | null;
}

/**
 * The reason a span is absent from an inference provenance item (D-112). One
 * literal, not free text: an explanatory sentence that a writer can reword is a
 * sentence a reader cannot filter on.
 */
export const INFERENCE_SPAN_ABSENT_REASON =
  "no direct span — inferred from effect" as const;

/**
 * The transfer step itself, recorded as provenance (D-112).
 *
 * An inferred realization does not quote a source that observed the pattern —
 * no such source exists, which is the whole point of marking it inferred. What
 * it CAN carry is the effect statement it was transferred from, verbatim, plus
 * the evidence record that effect cites so the trail stays walkable. There is
 * no `source_span` because the quoted text is an L2 record's own sentence, not
 * a slice of a harvested document, and `span_absent_reason` states that rather
 * than leaving the missing field to be read as an oversight.
 */
export interface InferenceProvenanceItem {
  corpus_kind: "inference";
  mechanism_id: string;
  /** The evidence record the EFFECT cites — not a record about this pattern. */
  corpus_record_id: string;
  effect_id: string;
  title: string;
  /** The effect's own statement, copied verbatim. */
  quote_or_locus: string;
  span_absent_reason: typeof INFERENCE_SPAN_ABSENT_REASON;
}

export type KnowledgeProvenanceItem =
  | EvidenceProvenanceItem
  | RealizationCorpusProvenanceItem
  | InferenceProvenanceItem;

/**
 * /effects/{mechanism_id}/{effect_id}.json — a scientific phenomenon between
 * an L1 mechanism and its L3 realizations. This is intentionally distinct from
 * Implementation.observed_effects, which remains telemetry output.
 */
export interface Effect {
  $schema?: string;
  id: string;
  mechanism_id: string;
  name: string;
  fact: string;
  grade: EvidenceGrade;
  /**
   * What corpus evidence the grade rests on, in the owner's words. Optional
   * while grades are still corrected by hand; required once grading is
   * computed from the corpus rather than asserted.
   */
  grade_basis?: string;
  /** Supporting DOIs. */
  source: string[];
  boundary: string;
  realization_ids: string[];
  provenance: KnowledgeProvenanceItem[];
}

/**
 * How a realization came to exist (D-112).
 *
 * `reported` — a source described this embodiment; the record describes what
 * exists. `inferred` — the pattern is a domain transfer from an effect that
 * nobody measured in a product context, so it is a hypothesis a generator may
 * act on, never evidence that it works. The distinction is a field rather than
 * a tone of voice because the generator reads the field.
 */
export type RealizationDerivation = "reported" | "inferred";

/**
 * The domain the evidence was measured in versus the domain the record is
 * applied in (D-112). Equal domains mean no transfer. effect.boundary carries
 * this implicitly for L2; realizations carry it explicitly, because the
 * generator reads the realization and never reads the effect.
 */
export interface RealizationDomainTransfer {
  source_domain: string;
  application_domain: string;
}

/**
 * What a tunable threshold's default rests on (D-115). One literal, following
 * the INFERENCE_SPAN_ABSENT_REASON precedent: a value a reader can filter on,
 * not a sentence a writer can reword until it sounds measured. A second value
 * is added here the day a source actually measures a threshold.
 */
export const PARAMETER_EVIDENCE_BASIS_NONE = "none — default heuristic" as const;

/**
 * One numeric threshold a `pattern` depends on, named rather than stated as
 * prose (D-115).
 *
 * "once the user has completed the core task three times" reads as a measured
 * quantity and is not one. The pattern text carries `{name}`, the default lives
 * here, and `evidence_basis` says the number is a heuristic — so the invented
 * precision is visible in the data instead of hidden in a sentence.
 */
export interface RealizationParameter {
  /** snake_case; referenced from `pattern` as `{name}`. */
  name: string;
  value: number;
  /** What the number counts — the pattern text only shows the placeholder. */
  unit: string;
  evidence_basis: typeof PARAMETER_EVIDENCE_BASIS_NONE;
}

/**
 * /realizations/{mechanism_id}/{id}.json — an interface, copy, or flow
 * embodiment. Distinct from Implementation, which is a product-authored
 * generator directive with metrics and hard rules attached.
 *
 * The two text fields split evidence from inference (D-112):
 * description_as_reported stays in the source's own domain language, and
 * `pattern` — present only for derivation=inferred — is the product-UI
 * directive transferred from it.
 */
export interface Realization {
  $schema?: string;
  id: string;
  mechanism_id: string;
  /** L2 effects this realization embodies; named as in mechanism.effect_refs. */
  effect_refs?: string[];
  derivation?: RealizationDerivation;
  domain_transfer?: RealizationDomainTransfer;
  term: string;
  description_as_reported: string;
  /** Required when derivation is "inferred", forbidden when "reported". */
  pattern?: string;
  /**
   * Every numeric threshold `pattern` depends on (D-115). Required whenever the
   * pattern carries one; forbidden when derivation is "reported".
   */
  parameters?: RealizationParameter[];
  artifact_context: string[];
  provenance: KnowledgeProvenanceItem[];
  confidence: number;
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

// ---------- Transferability (D-160) ----------

/**
 * The four questions asked of a grounded claim before it becomes a proposal.
 * Order is fixed because a verdict is read as a sentence, not a set.
 */
export const TRANSFERABILITY_CHECKS = [
  /** Is this about a person and an artifact, a person in an institution, or neither? */
  "subject",
  /** Does it name something an interface can actually change? */
  "variable",
  /** Does it state a direction, or only describe? */
  "direction",
  /** Does it depend on expertise the general product user does not have? */
  "population",
] as const;

export type TransferabilityCheck = (typeof TRANSFERABILITY_CHECKS)[number];

/**
 * `fail` refuses on its own; `warn` only refuses in company (see
 * lib/transferability.ts). The distinction is the whole point: a classroom
 * finding about layout is a warning, not a refusal.
 */
export type TransferabilityOutcome = "pass" | "warn" | "fail";

export interface TransferabilityCheckResult {
  check: TransferabilityCheck;
  outcome: TransferabilityOutcome;
  /**
   * Why, in words — stated for passes as well as refusals. A verdict that
   * records only its failures cannot be argued with, and the reason strings are
   * what make an offline replay reviewable rather than merely reproducible.
   */
  reason: string;
  /**
   * The interface lever the check identified, when it identified one. Written by
   * the model-backed VARIABLE check in ruleset v2 (D-162): the product surface
   * this claim could act on — "count of other users who did X", "countdown
   * timer", "ask a small request before the larger one". Null when the check
   * found no lever, and absent for the deterministic v1 checks that name their
   * finding inside `reason` instead. This is the field that makes a v2 verdict
   * AUDITABLE offline even though its VARIABLE outcome cannot be RECOMPUTED
   * without the model that produced it.
   */
  identified_lever?: string | null;
}

/**
 * The model-backed VARIABLE judgement (ruleset v2, D-162). Produced by a cheap
 * model reading only the claim (fact, boundary, source title) and answering one
 * question: does this name something a product surface can show, hide, reorder,
 * count, time, or reword? It replaces the v1 word list, which could only match
 * cognitive-load vocabulary and refused most of the persuasion registry.
 *
 * The pipeline stores the judgement inside the check result so the verdict stays
 * auditable and re-derivable offline from the proposal file — the one property a
 * naked model call would have destroyed.
 */
export interface VariableJudgement {
  /** Whether a nameable interface lever exists for this claim. */
  transferable: boolean;
  /** The lever, in a short phrase, or null when none was found. */
  lever: string | null;
  /** The model's one-line reason, carried verbatim into the check. */
  reason: string;
}

export interface TransferabilityVerdict {
  /** Bumped whenever the rules change, so a stored verdict names the rules that produced it. */
  ruleset_version: number;
  transferable: boolean;
  /** All four checks, always, in TRANSFERABILITY_CHECKS order. */
  checks: TransferabilityCheckResult[];
  /**
   * True when no single check refused and the verdict turned on the pair of
   * warnings instead. Recorded separately because that rule is the one part of
   * the scoring the owner did not specify outright.
   */
  escalated_by_warning_pair: boolean;
  /**
   * The non-VARIABLE checks that flagged, under ruleset v3 (D-165). In v3 these
   * are confidence modifiers rather than refusals: SUBJECT, DIRECTION and
   * POPULATION still run and still state their reasons, but only VARIABLE can
   * refuse. Recorded so a flag stays visible on an admitted claim — the reason
   * v3 exists is that these three were refusing claims whose lever VARIABLE had
   * already named, and a modifier that vanished on admission would hide the very
   * signal that motivated the change. Absent on v1 and v2 verdicts, where these
   * checks could refuse and `escalated_by_warning_pair` describes the scoring.
   */
  modifiers_flagged?: TransferabilityCheck[];
}

/**
 * Why ruleset v2 produced no verdict at all.
 *
 * The v2 VARIABLE check fails open — a model outage must never silently bury a
 * grounded claim — but "fails open" was implemented as an absent
 * `transferability` field, which is ALSO what a pre-D-160 proposal and a
 * non-effect proposal look like. Three states, one representation, and no
 * counter on any of them: an unjudged item was indistinguishable from a judged
 * one. That is the defect class that hid 30-of-30 for a month.
 *
 * So the claim is still admitted, and the failure is now named. Order matters
 * only for reading; these are checked in the order the call encounters them.
 */
export const TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS = [
  /** No model_id configured for the strong tier — the check could not be asked. */
  "no_model_id",
  /** The run's own token cap would have been crossed by this call. */
  "per_run_token_cap",
  /** The month's token cap would have been crossed by this call. */
  "monthly_token_cap",
  /** Non-retryable HTTP, three exhausted retries, or a thrown request. */
  "transport_error",
  /** The model answered, and the answer was not a judgement we could parse. */
  "malformed_answer",
] as const;

export type TransferabilityVerdictUnavailableReason =
  (typeof TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS)[number];

/**
 * Stamped on a proposal admitted WITHOUT a verdict, in place of the verdict.
 * Mutually exclusive with `transferability` — a proposal carries one or the
 * other, never both, and `held_non_transferable` can carry only a verdict
 * (you cannot refuse a claim you never judged). Enforced in
 * proposal.schema.json and re-checked by tools/validate.ts.
 */
export interface TransferabilityVerdictUnavailable {
  /** The ruleset that was being applied when it could not produce a verdict. */
  ruleset_version: number;
  reason: TransferabilityVerdictUnavailableReason;
  /**
   * Optional specifics — an HTTP status, the cap that would have been crossed.
   * Never the model's raw output: a malformed answer is not evidence.
   */
  detail?: string;
}

// ---------- Universal proposal store (/proposals, D-076) ----------

export type ProposalType =
  | "effect"
  | "realization"
  | "interaction"
  | "mechanism"
  | "dossier"
  | "dossier_section"
  | "segment";

export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "edited"
  | "held_low_confidence"
  /**
   * Grounded, and refused by the transferability rules at extraction (D-160).
   * A held status rather than a drop: the candidate is written, kept out of the
   * actionable queue, and recoverable by one owner action. Nothing is destroyed
   * and no reader coverage is consumed.
   */
  | "held_non_transferable";

export type ProposalOperation = "create" | "enrich";

export type DossierSectionPayload =
  | { field: "scores"; value: DossierScores }
  | { field: "total"; value: number }
  | { field: "core_condition"; value: string }
  | { field: "dissent"; value: string }
  | { field: "evidence_sources"; value: DossierEvidenceSource[] }
  | { field: "verdict"; value: DossierVerdict }
  | { field: "decided_by"; value: string }
  | { field: "date"; value: string }
  | { field: "notes"; value: string }
  | {
      field: "flag_lowest_admitted" | "flag_completes_core";
      value: boolean;
    };

/**
 * One drafted dossier axis (D-085). Either fully grounded — an integer score
 * with its rationale and at least one literature provenance item — or
 * explicitly UNSCORED (score/rationale null, provenance empty): the pipeline
 * could not ground a rationale, so the axis is flagged for owner judgement
 * rather than guessed. An unscored axis blocks approval until the owner edits
 * a score + rationale in.
 */
export interface DossierDraftAxis {
  score: AxisScore | null;
  rationale: string | null;
  provenance: EvidenceProvenanceItem[];
}

export interface DossierDraftScores {
  evidence: DossierDraftAxis;
  product_applicability: DossierDraftAxis;
  measurability: DossierDraftAxis;
  orthogonality: DossierDraftAxis;
  safety: DossierDraftAxis;
}

/**
 * Payload of a `dossier` proposal (D-085): a full machine-drafted dossier.
 * `total`, `verdict`, `decided_by` and `date` are intentionally ABSENT — they
 * are computed/stamped at owner approval, never proposed. A dossier proposal
 * can never auto-approve; every score stays visibly "proposed" until the
 * owner confirms or edits it in /review.
 */
export interface DossierDraftPayload {
  /** DOS-{mechanism_id}, e.g. DOS-CO-19. */
  id: string;
  mechanism_id: string;
  scores: DossierDraftScores;
  core_condition: string;
  dissent: string;
  evidence_sources: DossierEvidenceSource[];
  notes?: string;
}

export interface ProposalEnvelope<TType extends ProposalType, TPayload> {
  $schema?: string;
  id: string;
  type: TType;
  /** Whether approval creates an artifact or enriches an existing one. */
  operation: ProposalOperation;
  /** Mechanism, pack, or segment id. */
  target: string;
  payload: TPayload;
  /** Must contain at least one item; enforced by proposal.schema.json. */
  provenance: KnowledgeProvenanceItem[];
  /** 0–1 */
  confidence: number;
  /** Pipeline run id. */
  proposed_by: string;
  /** ISO timestamp. */
  proposed_at: string;
  status: ProposalStatus;
  hold_reason:
    | "below_confidence_floor"
    | "no_material_enrichment"
    | "not_transferable"
    | null;
  /**
   * Why the transferability rules admitted or refused this claim (D-160).
   * Absent on everything written before the pass existed, and on anything
   * hand-authored: a verdict invented for a claim no rule ever judged would be
   * the same substitution `span_role` was introduced to prevent.
   */
  transferability?: TransferabilityVerdict;
  /**
   * Present exactly when the transferability pass ran and could not reach a
   * verdict (D-162 fail-open). The claim was still admitted to review; this
   * records that nobody judged it, so an unjudged proposal is never mistaken
   * for one the filter passed. Mutually exclusive with `transferability`.
   *
   * Its absence is NOT a claim that a verdict exists: proposals written before
   * the pass existed, and non-effect proposals the pass does not apply to,
   * carry neither field. Only the presence of one of the two fields is
   * evidence of anything.
   */
  verdict_unavailable?: TransferabilityVerdictUnavailable;
  decided_by: string | null;
  /** ISO timestamp, or null before a decision. */
  decided_at: string | null;
  decision_note: string | null;
}

export type EffectProposal = ProposalEnvelope<"effect", Effect>;
export type RealizationProposal = ProposalEnvelope<"realization", Realization>;
export type InteractionProposal = ProposalEnvelope<
  "interaction",
  InteractionRecord
>;
export type MechanismProposal = ProposalEnvelope<"mechanism", Mechanism>;
export type DossierProposal = ProposalEnvelope<"dossier", DossierDraftPayload>;
export type DossierSectionProposal = ProposalEnvelope<
  "dossier_section",
  DossierSectionPayload
>;
export type SegmentProposal = ProposalEnvelope<"segment", Segment>;

export type Proposal =
  | EffectProposal
  | RealizationProposal
  | InteractionProposal
  | MechanismProposal
  | DossierProposal
  | DossierSectionProposal
  | SegmentProposal;

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

/**
 * "broken" (D-132) is not a degree of "partial". A partial run did less than
 * its scope and says so; a broken run cannot account for what it did — its
 * candidate ledger does not balance, so the numbers it reports are unsound and
 * nothing derived from them may be read as a measurement.
 */
export type CorpusRunStatus = "success" | "partial" | "failed" | "broken";

/**
 * Cost accounting for one run (D-022), mirrored from
 * tools/connectors/types.ts ManifestCost. token fields are reserved for
 * future LLM jobs (null until an engine exists); estimated_usd is computed,
 * 0 for the free D-011 public APIs.
 */
export interface CorpusManifestModelCost {
  tier: "cheap" | "strong";
  model_id: string;
  api_calls: number;
  tokens_in: number;
  tokens_out: number;
  estimated_usd: number;
}

export interface CorpusManifestCost {
  api_calls: number;
  duration_s: number;
  tokens_in: number | null;
  tokens_out: number | null;
  estimated_usd: number;
  /** Exact model-level accounting for paid extraction runs (D-087). */
  models?: CorpusManifestModelCost[];
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
  /**
   * The dispatch correlation id this run was triggered with (D-108).
   *
   * Written by the run itself, so asking "which dispatch produced this spend"
   * after the fact no longer requires inference. It previously did: the only
   * link was `findRunByDispatchId` substring-matching a workflow run NAME, and a
   * run name is a display string — editing `run-name` or dispatching two ids
   * that share a prefix breaks the link silently. Live polling still matches on
   * the name, because it runs before any manifest exists; everything after the
   * run reads this field.
   *
   * Absent for runs predating D-108, and null when a run carried no correlation
   * id at all. Those are different facts and stay distinguishable.
   */
  dispatch_id?: string | null;
  /** The Actions run that wrote this entry (D-108); null outside CI. */
  github_run_id?: number | null;
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

// ---------- Evidence corpus file (read-only mirror of tools/connectors/evidence.ts) ----------

/**
 * The full evidence corpus file written per mechanism at
 * /corpora/evidence/{id}.json. The writer (and its private interfaces) live in
 * tools/connectors/evidence.ts; lib/ never imports from tools/. tools/corpus-
 * digest.ts reads this shape to build the drafting hand-off digest (D-065). Only
 * the fields the digest reads are typed here — the corpus itself is the authority.
 */

/** OpenAlex + Semantic Scholar, plus the two owner/structural provenances. */
export type CorpusSourceApi =
  | "openalex"
  | "semantic-scholar"
  | "pinned"
  | "snowball";

/** Viewpoint an angle query targeted (D-058). */
export type CorpusSearchAngle =
  | "canon"
  | "recent"
  | "application"
  | "critique"
  | "replication"
  | "boundary"
  | "cross-domain";

/** One harvested work in a corpus file. */
export interface EvidenceCorpusRecord {
  /** Stable deterministic id derived from DOI, or normalized title + year. */
  record_id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  citations: number | null;
  abstract: string | null;
  openalex_id: string | null;
  openalex_type: string | null;
  referenced_works_count: number | null;
  /** Category checklist (D-019): non-exclusive, metadata-only classification. */
  categories: EvidenceCategory[];
  source_api: CorpusSourceApi;
  /** Only on owner-pinned records (D-017): why this work is pinned. */
  pin_reason?: string;
  /** Only on a pinned record whose DOI did not resolve on OpenAlex (D-017). */
  pin_unresolved?: boolean;
  /** Only on snowballed records (D-019): review ids that surfaced this work. */
  snowball_from?: string[];
  /** Angles whose queries surfaced this record (D-058). */
  search_angles?: CorpusSearchAngle[];
}

/** One query's metadata line, as recorded in the corpus (D-058). */
export interface CorpusQueryMeta {
  query_id?: string;
  api: "openalex" | "semantic-scholar";
  angle: CorpusSearchAngle;
  term: string;
  bucket?: "relevance" | "recency" | "citation";
  kind?: "search" | "backward-reference" | "forward-citation";
  requested: number;
  returned: number;
  unique_returned?: number;
  records_added?: number;
  novelty_rate?: number;
  rolling_novelty_rate?: number | null;
  /** Total matches reported by the upstream search API; null when unavailable. */
  upstream_total_results?: number | null;
}

/** Per-review snowball outcome (D-019). */
export interface CorpusReviewCoverage {
  title: string;
  doi: string | null;
  openalex_id: string;
  citations: number | null;
  references_total: number;
  references_resolved: number;
  references_in_corpus: number;
  coverage: number | null;
}

/** Review-reference snowball accounting for the harvest (D-019/D-034). */
export interface CorpusCoverageReport {
  review_found: boolean;
  reviews: CorpusReviewCoverage[];
  snowball_added: number;
  note?: string;
}

/** Per-angle query outcome + unique deduped records surfaced (D-058). */
export interface CorpusAngleSpread {
  angle: CorpusSearchAngle;
  queries: number;
  returned: number;
  unique_records: number;
}

/** Per-API query outcome + unique deduped records the API contributed (D-058). */
export interface CorpusSourceSpread {
  api: "openalex" | "semantic-scholar";
  queries: number;
  returned: number;
  unique_records: number;
}

/** Dedup-aware novelty vs the previous corpus (D-058). */
export interface CorpusNoveltyReport {
  previous_corpus_records: number | null;
  unique_records: number;
  already_in_corpus: number;
  new_records: number;
  novelty_rate: number;
  low_novelty: boolean;
  known_share_threshold: number;
}

/** Diversity + novelty accounting for the harvest (D-058). */
export interface CorpusDiversityReport {
  viewpoint_spread: CorpusAngleSpread[];
  source_spread: CorpusSourceSpread[];
  recent_records: number;
  recency_rate: number;
  novelty: CorpusNoveltyReport;
}

export interface CorpusSaturationPoint {
  query_index: number;
  query_id: string;
  bucket: "relevance" | "recency" | "citation";
  kind: "search" | "backward-reference" | "forward-citation";
  returned: number;
  unique_returned: number;
  records_added: number;
  novelty_rate: number;
  rolling_novelty_rate: number | null;
  cumulative_records: number;
}

export interface CorpusSaturationReport {
  queries_issued: number;
  records_added: number;
  novelty_curve: CorpusSaturationPoint[];
  window_queries: number;
  novelty_threshold: number;
  minimum_queries: number;
  retrieval_counts: Record<"relevance" | "recency" | "citation", number>;
  topical_candidates: number;
  topical_confirmed: number;
  topical_rejected: number;
  topical_confirmation_rate: number;
  graph_anchors_expanded: number;
  field_union_estimate?: {
    estimate: number | null;
    method: "sample_overlap_adjusted_union";
    measured_queries: number;
    total_search_queries: number;
    summed_upstream_results: number;
    observed_sample_multiplicity: number | null;
  };
  saturation_reached: boolean;
  stop_reason: "saturation" | "storage_tier_record_cap" | "call_cap" | "time_slice";
  cap: {
    max_calls: number;
    max_unique_records: number;
  };
}

/** The full /corpora/evidence/{id}.json file. */
export interface EvidenceCorpusFile {
  mechanism_id: string;
  fetched_at: string;
  /** Where the search terms came from (D-015). */
  terms_source: "param" | "record" | "name";
  terms: string[];
  queries: CorpusQueryMeta[];
  coverage_report: CorpusCoverageReport;
  category_counts: CategoryCounts;
  /** Diversity + novelty accounting (D-058); absent on pre-D-058 harvests. */
  diversity_report?: CorpusDiversityReport;
  /** Adaptive stopping report (D-080); absent on pre-v3 harvests. */
  saturation_report?: CorpusSaturationReport;
  records: EvidenceCorpusRecord[];
}

// ---------- Realization corpus (interface evidence, D-081) ----------

export type RealizationCorpusOrigin = "harvested" | "owner";

export interface RealizationCorpusRecord {
  record_id: string;
  mechanism_id: string;
  source_id: string;
  origin: RealizationCorpusOrigin;
  title: string;
  source_url: string;
  source_locator: string;
  observed_at: string;
  observation: string;
  artifact_context: string[];
  contributed_by: string | null;
  license_note: string;
}

/** /corpora/realizations/{mechanism_id}/records.json. */
export interface RealizationCorpusFile {
  mechanism_id: string;
  updated_at: string;
  records: RealizationCorpusRecord[];
}

// ---------- Corpus digest (tools/corpus-digest.ts, D-065) ----------

/**
 * The standard harvest -> record-drafting hand-off (D-065): a compact,
 * human-readable projection of one evidence corpus. tools/corpus-digest.ts
 * builds it from EvidenceCorpusFile + the registry stub/record and renders it
 * to markdown; the raw corpus stays on disk as provenance but is no longer
 * read by hand while drafting.
 */

/** One work as it appears in a digest category list. */
export interface CorpusDigestEntry {
  record_id: string;
  title: string;
  /** First author + "et al." when there are more. */
  authors: string;
  year: number | null;
  venue: string | null;
  citations: number | null;
  doi: string | null;
  source_api: CorpusSourceApi;
  /** Every category this work belongs to (so cross-listing is visible). */
  categories: EvidenceCategory[];
  search_angles: CorpusSearchAngle[];
}

/** Pin-resolution accounting: stub/record pins vs what landed in the corpus. */
export interface CorpusDigestPins {
  declared: number;
  resolved: number;
  unresolved: number;
  /** DOIs declared in pinned_evidence but absent from the corpus. */
  missing_dois: string[];
}

/** The computed digest for one mechanism, before markdown rendering. */
export interface CorpusDigest {
  mechanism_id: string;
  name: string;
  fetched_at: string;
  record_count: number;
  terms: string[];
  query_count: number;
  terms_source: string;
  pins: CorpusDigestPins;
  snowball_added: number;
  review_found: boolean;
  coverage_note: string | null;
  category_counts: CategoryCounts;
  /** Diversity is absent on pre-D-058 harvests; the numeric fields are null then. */
  has_diversity: boolean;
  recency_rate: number | null;
  recent_records: number | null;
  novelty_rate: number | null;
  low_novelty: boolean | null;
  viewpoint_spread: CorpusAngleSpread[];
  source_spread: CorpusSourceSpread[];
  saturation_reached: boolean | null;
  saturation_stop_reason: string | null;
  saturation_queries: number | null;
  topical_confirmation_rate: number | null;
  /** top-N per category, keyed by EVIDENCE_CATEGORIES. */
  top_by_category: Record<EvidenceCategory, CorpusDigestEntry[]>;
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
 * Which optional OpenRouter parameters a tier's model actually advertises
 * (D-107).
 *
 * `provider.require_parameters: true` is a fail-closed guard: it tells OpenRouter
 * to route only to a provider that honours every parameter sent. Sending a
 * parameter the model does not advertise therefore leaves NO eligible provider
 * and the request 404s with "no endpoints found" before any model is invoked —
 * which is exactly what killed runs 30102079781 and 30102271340. The guard is
 * correct; sending `temperature` unconditionally was not.
 *
 * Declared per tier rather than probed at runtime, because the app and the tools
 * are file-based (rule 12) and a capability lookup would be a new endpoint.
 * tools/openrouter-preflight.ts verifies the declaration for ~$0.0001.
 */
export interface ExtractionModelTierSupports {
  /** Sampling temperature. Claude models do not advertise it. */
  temperature: boolean;
  /** response_format with a json_schema, required for strict provenance schemas. */
  structured_outputs: boolean;
}

export interface ExtractionModelTierConfig {
  model_id: string | null;
  response_format: "json_schema" | "json_object";
  input_usd_per_token: number | null;
  output_usd_per_token: number | null;
  max_tokens_per_call: number;
  supports: ExtractionModelTierSupports;
}

/** /corpora/_ops/extraction.json — versioned OpenRouter routing and caps. */
export interface ExtractionOpsConfig {
  version: string;
  prices_verified_on: string | null;
  tiers: {
    cheap: ExtractionModelTierConfig;
    strong: ExtractionModelTierConfig;
  };
  limits: {
    per_run_tokens: number;
    monthly_tokens: number;
    records_per_batch: number;
    confidence_floor: number;
    duplicate_similarity: number;
    /**
     * Count ceiling on proposals admitted per mechanism per SLICE, or null for
     * no ceiling (D-146). Slice size is a consequence of the token budget, so a
     * count cap makes yield depend on how the budget happened to be cut rather
     * than on any property of the candidate; null is the honest way to say the
     * ceiling is off, since a large integer is still a ceiling.
     */
    max_proposals_per_mechanism: number | null;
  };
}

export type ReaderCoverageMode =
  | "effects"
  | "realizations"
  | "interactions"
  | "dissent"
  | "mechanism"
  | "dossier";

/** Terminal ids for one reading pass — a mode overall, or one effect within it. */
export interface ReaderCoverageEffectState {
  /** Records that reached the mode's cheap extraction model. */
  processed_record_ids: string[];
  /** Records rejected by the deterministic title + abstract relevance gate. */
  skipped_irrelevant_record_ids: string[];
  processed_at: string;
}

export interface ReaderCoverageModeState extends ReaderCoverageEffectState {
  /**
   * Effect-anchored terminal reads, keyed by effect id (D-140, lifting the
   * D-112 ceiling). Present only on mode="realizations" once at least one
   * scope_kind="effect" run has read against this mechanism's evidence
   * corpus. A record terminal for one effect is NOT terminal for another —
   * that is the entire point of this key — so the planner consults this
   * bucket instead of the mode-level fields above when the current run is
   * effect-anchored. The mode-level `processed_record_ids` /
   * `skipped_irrelevant_record_ids` above remain the UNION across every
   * effect (plus any non-effect-anchored run on this mode) and are
   * unchanged in meaning: they are what extraction_completeness, the
   * analyzer, and tools/validate.ts's existing cross-checks read, so this
   * key is a strict refinement recorded alongside the union, never a
   * replacement for it.
   */
  by_effect?: Record<string, ReaderCoverageEffectState>;
}

export interface ReaderCoverageCorpus {
  /**
   * Aggregate terminal ids retained for analyzer extraction_completeness.
   * This is the union of processed and skipped-irrelevant ids across modes.
   */
  processed_record_ids: string[];
  processed_at: string;
  modes: ReaderCoverageMode[];
  by_mode: Partial<Record<ReaderCoverageMode, ReaderCoverageModeState>>;
}

/** Exact cumulative reader ledger written by successful Actions extraction runs. */
export interface ReaderCoverageFile {
  version: "1.2.0";
  updated_at: string;
  mechanisms: Record<
    string,
    {
      evidence?: ReaderCoverageCorpus;
      realization?: ReaderCoverageCorpus;
    }
  >;
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
  /** Evidence-only adaptive harvest policy (D-080). */
  saturation?: EvidenceSaturationConfig;
  targets: string[];
}

export interface EvidenceSaturationConfig {
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

// ---------- Live operations view (D-086) ----------

/** What a long job is: an evidence/wayback harvest or an LLM extraction. */
export type RunProgressKind = "harvest" | "extraction";

/** Live status a heartbeat reports for its own job. */
export type RunProgressStatus = "running" | "success" | "partial" | "failed";

/**
 * A single progress heartbeat written by a long-running Actions job (D-086).
 * The tool writes it to a gitignored working file after each checkpoint; a
 * publisher force-pushes it to the dedicated `ops-progress` ref every ~2 min,
 * so /ops can show live progress without polluting main. NEVER committed to
 * main — the schema doc lives at corpora/_ops/run-progress.schema.json.
 */
export interface RunProgress {
  schema_version: 1;
  kind: RunProgressKind;
  /** Mechanism id (harvest) or "kind id" scope label (extraction); null when unknown. */
  target: string | null;
  /** Human-readable current phase, e.g. "harvesting", "drafting CL-14". */
  phase: string;
  /** GitHub Actions run id for correlation with the live run list; null locally. */
  github_run_id: number | null;
  github_run_attempt: number | null;
  /** Correlation id echoed into the run name (D-025); null when unset. */
  dispatch_id: string | null;
  started_at: string;
  updated_at: string;
  /** True once the wrapped job finished — the last snapshot before the ref is reused. */
  finished: boolean;
  status: RunProgressStatus;
  /** Progress against the run's own frontier. */
  progress: {
    unit: "queries" | "batches";
    done: number;
    /** Total planned units; null when not yet known. */
    total: number | null;
  };
  /** Records accumulated so far; null for jobs that do not count records. */
  records: number | null;
  spend: {
    api_calls: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    estimated_usd: number | null;
  };
  caps: {
    per_run_calls: number | null;
    per_run_tokens: number | null;
    monthly_calls: number | null;
    monthly_usd: number | null;
  };
  note: string | null;
  /**
   * Final funnel + gate counters for a finished extraction run (D-090). Set
   * only on the terminal heartbeat so /ops can show what a run produced the
   * moment it ends — before the run's own commit lands and the deploy catches
   * up. Absent/null for in-flight heartbeats and for harvest runs.
   */
  summary?: RunProgressSummary | null;
}

/** Quality-gate counters plus the relevance funnel for a finished run. */
export interface RunProgressSummary {
  proposed: number;
  merged: number;
  dropped_ungrounded: number;
  failed_validation: number;
  held_low_confidence: number;
  /**
   * Held by the transferability rules (D-160). Optional so runs recorded before
   * the pass existed read as "not measured" rather than as a measured zero.
   */
  held_non_transferable?: number;
  /**
   * Admitted WITHOUT a verdict because the v2 VARIABLE check could not produce
   * one (D-162 fail-open). Reported alongside the held count on purpose: the
   * two answer different questions — one is "the filter refused N", the other
   * is "the filter never ran on N". A run that fails open on everything looks
   * identical to a clean run without this number. Optional so runs recorded
   * before it existed read as "not measured", not as a measured zero.
   */
  verdict_unavailable?: number;
  dropped_volume_cap: number;
  dropped_volume_cap_high_confidence: number;
  candidates: number;
  /** Funnel: total eligible → passed pre-filter → sent to model → still remaining. */
  records_eligible: number;
  records_relevant: number;
  records_processed: number;
  records_skipped_irrelevant: number;
  records_remaining: number;
  /**
   * What the token cap did to the plan (D-103). `records_selected` is what the
   * planner kept; `records_dropped_truncation` is what it left out to fit
   * per_run_tokens. Optional only so runs recorded before D-103 stay readable
   * as "truncation not reported" rather than as "nothing was truncated" — every
   * run from D-103 on writes both, including at zero.
   */
  records_selected?: number;
  records_dropped_truncation?: number;
  /**
   * Per-reason attribution of dropped_ungrounded (D-098); values sum to that
   * total. Optional: absent on a clean run and on runs recorded before D-098,
   * so /ops must render an honest "not attributed" state rather than zeros.
   */
  dropped_ungrounded_reasons?: Partial<Record<UngroundedDropReason, number>>;
  /**
   * The same figures split by model pass (D-105). Optional for the same reason
   * as above: runs recorded before D-105 gated only the strong pass, so /ops
   * must say "not split" rather than imply the cheap pass dropped nothing.
   */
  candidates_cheap?: number;
  candidates_strong?: number;
  dropped_ungrounded_cheap?: number;
  dropped_ungrounded_strong?: number;
  dropped_ungrounded_reasons_cheap?: Partial<Record<UngroundedDropReason, number>>;
  dropped_ungrounded_reasons_strong?: Partial<Record<UngroundedDropReason, number>>;
}

/**
 * Every grounding check that can refuse an extraction candidate (D-098), in
 * schema order. Declared once here because the extraction pipeline (tools/),
 * the ops reader (lib/ops.ts), and the /ops client all need it and lib/ never
 * imports tools/ (D-020). tools/validate.ts asserts this equals the
 * dropped_ungrounded_reasons properties in run-progress.schema.json.
 */
export const UNGROUNDED_DROP_REASONS = [
  /** The model returned an item with no citations array, or an empty one. */
  "no_citations",
  /** A citation lacked a string record_id or a non-empty quote_or_locus. */
  "malformed_citation",
  /** A cited record_id is not in the corpus slice the model was shown. */
  "unknown_record_id",
  /**
   * The citation names the anchoring EFFECT instead of a corpus record (D-167).
   * Distinct from unknown_record_id on purpose: that one means the model
   * invented or misremembered an id, this one means it treated the claim it was
   * asked to extend as the evidence for extending it. The two have different
   * fixes, so a single counter for both hides which is happening.
   */
  "anchor_cited_as_record",
  /** The quote is not a normalized substring of title + abstract/observation. */
  "quote_not_in_source",
  /** Evidence provenance in a realization corpus, or the reverse. */
  "wrong_corpus_kind",
  /** The cited record carries no DOI, or the provenance DOI disagrees with it. */
  "doi_unresolved",
  /** The provenance title disagrees with the corpus record's title. */
  "title_mismatch",
  /** Provenance mechanism/source/contributor disagrees with the corpus. */
  "provenance_mismatch",
  /** A citation carried no span_role, or one outside the vocabulary (D-129). */
  "span_role_missing",
  /** The span is background/hypothesis/method/limitation, so it grounds no fact (D-129). */
  "span_role_not_finding",
  /** The model called it a finding; the source's own section labels say otherwise (D-129). */
  "span_role_contradicted_by_structure",
  /** A later sentence in the same stored text contradicts the quoted span (D-129). */
  "premise_contradicted_downstream",
  /** The proposal builder rejected the item after provenance was assembled. */
  "proposal_not_built",
] as const;

/** The grounding check that refused a candidate (D-098). */
export type UngroundedDropReason = (typeof UNGROUNDED_DROP_REASONS)[number];

/** Which model pass produced the candidate that was refused (D-104/D-105). */
export type ExtractionPass = "cheap" | "strong";

/**
 * The two strings the grounding gate actually compared, stored UNTRUNCATED
 * (D-104). A refusal is only diagnosable if both sides survive, in raw and
 * normalized form: the raw pair shows the bytes, the normalized pair shows what
 * the comparison saw after NFKC folding.
 */
export interface RejectedCandidateComparison {
  quote_raw: string;
  quote_normalized: string;
  source_raw: string;
  source_normalized: string;
}

/**
 * The corpus record's own values the provenance was checked against (D-104).
 * A doi_unresolved or title_mismatch refusal compares these, not the quote, so
 * they have to survive alongside the quote comparison to be diagnosable.
 */
export interface RejectedCandidateCorpusSide {
  doi: string | null;
  title: string;
}

/**
 * One candidate the extraction pipeline dropped at the grounding gate (D-104).
 *
 * Persisted for EVERY drop, not a sampled few, so any rejection stays
 * re-checkable offline forever through tools/replay-grounding.ts. This is
 * diagnostic output, never an input to any artifact: a rejected candidate has
 * no effect on the registry, dossiers, effects, realizations, interactions or
 * proposals (rule 8).
 */
export interface RejectedCandidateRecord {
  mechanism_id: string;
  mode: string;
  /** The pass whose output was refused. */
  pass: ExtractionPass;
  /** The failing check, one of UNGROUNDED_DROP_REASONS. */
  reason: UngroundedDropReason;
  /** The gate's own message for that refusal. */
  detail: string;
  /** The cited record the candidate was matched against; null when none resolved. */
  corpus_record_id: string | null;
  /** The raw model output for this item, exactly as returned. */
  item: unknown;
  /** Provenance fields as returned, when the gate got far enough to build any. */
  provenance?: unknown;
  /** Both compared strings in full; absent when the refusal never compared any. */
  compared?: RejectedCandidateComparison;
  /** The cited record's own doi/title; absent when no record resolved. */
  corpus_side?: RejectedCandidateCorpusSide;
  /**
   * For a strong-pass drop, the cheap-pass candidate it was synthesized from.
   * Present because the strong pass never sees the source records, so a strong
   * refusal is only interpretable next to the grounded candidate it started as.
   */
  cheap_origin?: unknown;
}

/** Run-scoped file of every candidate one extraction run dropped (D-104). */
export interface RejectedCandidateFile {
  schema_version: 1;
  /** The run's start timestamp, the same key mergeExtractionRunHistory uses. */
  run_id: string;
  dispatch_id: string | null;
  github_run_id: number | null;
  mode: string;
  written_at: string;
  rejected: RejectedCandidateRecord[];
}

// ---------- Candidate conservation ledger (D-132) ----------

/**
 * Every terminal fate a candidate can reach, in funnel order.
 *
 * Closed by design: the conservation invariant is only enforceable if the
 * outcomes partition the population, so a new way to lose a candidate has to be
 * added here — and to the balance equations — before it can be written. That is
 * the whole point. The three prior appearances of the silent-loss defect class
 * (D-104's 30-for-30, D-105's uncounted cheap pass, and the cheap-to-strong
 * 8-to-7 shrink) were each a fate with no name.
 */
export const CANDIDATE_FATES = [
  /** Cheap-pass candidate handed to a synthesis call that returned. */
  "into_synthesis",
  /** Refused at the grounding gate; the full refusal is in corpora/extraction/rejected/. */
  "dropped_ungrounded",
  /** Grounded, handed to synthesis, and the synthesis call itself failed. */
  "synthesis_batch_failed",
  /** Written to the proposal queue as a new proposal. */
  "proposed",
  /** Written to the queue as an enrichment of an approved artifact. */
  "proposed_enrich",
  /** Absorbed into an earlier pending proposal; produces no file of its own. */
  "merged_into_pending",
  /** Written to the queue held below the confidence floor, or adding nothing. */
  "held_low_confidence",
  /**
   * Written to the queue held by the transferability rules (D-160). A held
   * fate, not a dropped one: the proposal file exists, carries the verdict that
   * set it aside, and one owner action puts it back in play.
   */
  "held_non_transferable",
  /** Refused by the proposal schema after provenance was assembled. */
  "failed_validation",
  /** Admissible but beyond max_proposals_per_mechanism. */
  "dropped_volume_cap",
  /** Synthesis output past the first item, which a draft mode discards (D-085). */
  "dropped_draft_cap",
] as const;

export type CandidateFate = (typeof CANDIDATE_FATES)[number];

/**
 * One candidate's fate. No model text is stored: a refused candidate is already
 * persisted in full under corpora/extraction/rejected/ (D-104), and this file
 * answers "what became of each one", not "what did it say".
 */
export interface CandidateLedgerEntry {
  /** Stable within a run: mechanism, pass, ordinal, and a short content hash. */
  candidate_id: string;
  mechanism_id: string;
  pass: ExtractionPass;
  fate: CandidateFate;
  /** The grounding check that refused it; present only for dropped_ungrounded. */
  reason?: UngroundedDropReason;
  /** The proposal this candidate became, or was absorbed into. */
  proposal_id?: string;
  /**
   * Whether `proposal_id` was written by the run or worked out afterwards.
   * A backfilled attribution is a reading of the evidence, not a record of
   * what happened, and the two must never be confused (D-131).
   */
  attribution?: "recorded" | "inferred" | "not_recorded";
}

/** Cheap-pass totals. */
export interface CandidateLedgerCheapStage {
  candidates: number;
  dropped_ungrounded: number;
  synthesis_batch_failed: number;
  into_synthesis: number;
}

/**
 * The cheap-to-strong stage, which is where the loss hid. Synthesis consolidates
 * several cheap candidates into one composed candidate, which is legitimate —
 * but it is a fate, and until D-132 it had no counter, so a consolidation and a
 * dropped candidate looked identical from outside.
 */
export interface CandidateLedgerSynthesisStage {
  into_synthesis: number;
  consolidated: number;
  expanded: number;
  candidates_strong: number;
}

/** Strong-pass totals; the fates here partition candidates_strong. */
export interface CandidateLedgerStrongStage {
  candidates: number;
  proposed: number;
  proposed_enrich: number;
  merged_into_pending: number;
  held_low_confidence: number;
  failed_validation: number;
  dropped_ungrounded: number;
  dropped_volume_cap: number;
  dropped_draft_cap: number;
  /**
   * Optional, because every run before D-160 predates the transferability pass
   * and wrote no such counter. Absent means the run could not produce this
   * fate; writing 0 into those runs would assert a measurement nobody took.
   * Read as 0 by the balance equation, which is sound only because the fate did
   * not exist then.
   */
  held_non_transferable?: number;
}

/**
 * How completely this run's ledger could be established.
 *
 * - recorded: written by the run itself, as it happened.
 * - reconstructed: complete, but worked out afterwards from committed evidence.
 * - partial: some fates could not be established at all.
 * - unreconstructable: the run predates the instrumentation and the evidence
 *   for its accounting no longer exists.
 *
 * A reason is REQUIRED for everything except `recorded`. That requirement is
 * the substance of the rule: a gap is recorded as a gap, and no run passes the
 * invariant by having nothing said about it.
 */
export type CandidateLedgerReconstruction =
  | { status: "recorded" }
  | {
      status: "reconstructed" | "partial" | "unreconstructable";
      reason: string;
    };

/**
 * One extraction run's candidate accounting (D-132).
 *
 * A stage is `null` when its numbers are genuinely unknown, which is not the
 * same as zero and must not be written as zero. Runs before D-105 gated only
 * the strong pass: their cheap pass produced candidates that were never
 * counted, so a cheap stage of 0 would assert something false about them, and
 * asserting it is how this defect class stayed invisible for three rounds.
 */
export interface CandidateLedgerRun {
  /** The run's start timestamp — the key mergeExtractionRunHistory uses. */
  run_id: string;
  dispatch_id: string | null;
  github_run_id: number | null;
  mode: string;
  scope: string;
  candidates: number | null;
  cheap: CandidateLedgerCheapStage | null;
  synthesis: CandidateLedgerSynthesisStage | null;
  strong: CandidateLedgerStrongStage | null;
  /** Computed by checkLedgerBalance, stored so the manifest status is traceable. */
  balanced: boolean;
  reconstruction: CandidateLedgerReconstruction;
  candidates_detail: CandidateLedgerEntry[];
}

/** corpora/extraction/ledger.json — every run's candidate accounting (D-132). */
export interface CandidateLedgerFile {
  schema_version: 1;
  updated_at: string;
  runs: CandidateLedgerRun[];
}

/** The classification of a live/recent run for the /ops live view. */
export type LiveRunKind = "harvest" | "extraction" | "analysis" | "health";

/** One in-flight Actions run, merged with its progress heartbeat when present. */
export interface LiveRun {
  runId: number;
  name: string;
  /** Workflow file basename, e.g. "harvest.yml". */
  workflow: string;
  kind: LiveRunKind;
  /** "queued" | "in_progress" | ... from the Actions API. */
  status: string;
  htmlUrl: string;
  createdAt: string;
  /** Seconds since the run started, computed at snapshot time. */
  elapsedS: number;
  /** Current step name (phase) from the run's jobs, or null. */
  phase: string | null;
  /** Matching heartbeat (github_run_id === runId), or null. */
  progress: RunProgress | null;
}

/** One completed run projected from a corpus manifest run_history entry. */
export interface LiveRecentRun {
  corpus: string;
  timestamp: string;
  status: CorpusRunStatus;
  records: number;
  apiCalls: number | null;
  estimatedUsd: number | null;
  durationS: number;
  params: Record<string, string>;
  error: string | null;
  warnings: string[];
  /** One-line saturation summary for evidence targets; null otherwise. */
  saturation: string | null;
  /**
   * True when this row was reconstructed from the just-finished extraction
   * heartbeat (D-090) — surfaced the moment a run ends, before its own commit
   * lands and the deploy catches up. Committed rows leave this undefined.
   */
  justFinished?: boolean;
  /**
   * Extraction funnel + gate counters (D-090). Present on just-finished rows
   * (from the heartbeat summary); committed rows carry the same numbers in
   * `params` as strings.
   */
  summary?: RunProgressSummary | null;
}

/** One scheduled workflow and its next computed occurrence. */
export interface LiveScheduledRun {
  workflow: string;
  label: string;
  cron: string;
  /** ISO timestamp of the next occurrence, or null when uncomputable. */
  nextRunAt: string | null;
}

/** The four operational queues, counted from committed files. */
export interface LiveQueueCounts {
  harvest: number;
  extraction: number;
  review: number;
  reviewHeld: number;
  authoring: number;
  /** Evidence checkpoints awaiting a continuation dispatch. */
  checkpointResumes: number;
}

/** The full payload the /ops live view renders (D-086). */
export interface LiveOpsSnapshot {
  generatedAt: string;
  /** True when the GitHub read surface is configured (GH_OPS_TOKEN). */
  liveEnabled: boolean;
  /** Non-null when the live layer failed; file-based sections still render. */
  error: string | null;
  running: LiveRun[];
  recent: LiveRecentRun[];
  scheduled: LiveScheduledRun[];
  queues: LiveQueueCounts;
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

// ---------- Pack datasheet (/packs/pack-{id}.yaml, D-049/D-076) ----------
//
// A pack is a COMPUTED projection over the pack map + registry + first-class
// effects, generated by tools/render-packs.ts (`npm run packs`) and never
// hand-authored. The numbered ontology is explicit: L1 mechanisms, L2 effects,
// and L3 realizations. Interactions and context weights are separate,
// unnumbered dimensions rather than ontology levels.

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
  /** Hard-rule ids, kebab-cased. */
  forbidden: string[];
}

/** LAYER 2 — one first-class scientific effect projected from /effects. */
export interface PackEffect {
  id: string;
  mechanism_id: string;
  name: string;
  fact: string;
  grade: EvidenceGrade;
  /** Supporting DOIs. */
  source: string[];
  boundary: string;
  /** Full implementation ids, matching PackRealization.id. */
  realization_ids: string[];
}

/** LAYER 3 — one concrete realization projected from mechanism.implementations. */
/** Source-grounded, descriptive evidence palette entry. */
export interface PackRealization {
  id: string;
  mechanism_id: string;
  effect_id?: string;
  term: string;
  description_as_reported: string;
  artifact_context: string[];
  confidence: number;
  source_record_ids: string[];
}

/** Product-authored directive projected from mechanism.implementations. */
export interface PackImplementation {
  id: string;
  mechanism_id: string;
  /** Optional first-class L2 effect this realization embodies. */
  effect_id?: string;
  realization_ids?: string[];
  artifact_types: ArtifactType[];
  product_requirements: string[];
  generation_directive: string;
  copy_formulas: string[];
  metrics: string[];
  /** Measured telemetry outcomes, not ontology L2 effects. */
  observed_effects: string[];
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

/** One interaction between two of the pack's mechanisms (not ontology L2). */
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

/** A context and the mechanisms it makes strong or inactive (not ontology L3). */
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
  /**
   * Cross-cutting perception & comprehension mechanisms (S7): every mechanism
   * whose L0 parent is cross_cutting, emitted into EVERY pack automatically
   * (Step 5). Same atom shape as LAYER 1 but a distinct top-level section, kept
   * separate from the pack's own motivational mechanisms; pack-map never lists
   * these (D-066). Empty until the S7 seeds are promoted to full records.
   */
  cross_cutting_perception: PackMechanism[];
  effects: PackEffect[];
  realizations: PackRealization[];
  implementations: PackImplementation[];
  interactions: PackInteraction[];
  context_weights: PackContextWeight[];
  /** Each entry is a single-key map, e.g. { "fake-scarcity": "forbidden — ..." }. */
  hard_boundaries: Record<string, string>[];
  signals: PackSignals;
  wiring: PackWiring;
}

/**
 * First document of /packs/export/packs-bundle.yaml (D-068) — the manifest of
 * the committed export artifact. The bundle is a multi-document YAML stream:
 * this manifest followed by every pack datasheet verbatim. It is a pure
 * function of the packs on disk (no timestamps), regenerated by every
 * `npm run packs` run, and consumed by the team directly from git.
 */
export interface PackBundleManifest {
  bundle: "pack-export";
  /** Pack-map file version stamped on every pack. */
  version: string;
  pack_count: number;
  /** Element ids in bundle order (sorted, matches packs/pack-{id}.yaml). */
  packs: string[];
  nature: string;
  source: string;
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

export type SufficiencyGroup = "breadth" | "depth" | "quality";

/** Breadth, depth, and quality criteria scored per cell (each 0–1 or unmeasured). */
export type SufficiencyCriterion =
  | "saturation_reached"
  | "corpus_size_vs_field_estimate"
  | "source_diversity"
  | "recency_balance"
  | "effect_coverage"
  | "realization_density"
  | "dissent_completeness"
  | "grade_sufficiency"
  | "interaction_coverage"
  | "extraction_completeness"
  | "context_coverage"
  | "freshness";

/** Criterion scores for one cell, keyed by SufficiencyCriterion. */
export type SufficiencyScores = Record<SufficiencyCriterion, number | null>;

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
export type GapFixType = "harvest" | "pipeline" | "structural";

/**
 * A failing criterion in a cell, typed by its filler (D-055). criterion is a
 * SufficiencyCriterion, or the pseudo-criterion "segment_evidence" — not a
 * scored criterion but a harvest-closable gap (general_only means
 * segment-specific evidence is missing).
 */
export interface TypedGap {
  criterion: SufficiencyCriterion | "segment_evidence";
  /** The cell's score for this criterion (0 for the segment_evidence pseudo-gap). */
  value: number | null;
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

/**
 * Maturity stage (D-060): the knowledge base's honest stage of growth. Selects
 * which per-criterion thresholds are active — green at `seed` means
 * seed-adequate, not final. Owner-tunable and explicit, never a silent lowering.
 */
export type MaturityStage = "seed" | "growing" | "mature";

/**
 * Per-criterion thresholds for ONE maturity stage: a required `default` plus
 * optional per-criterion overrides. Cell status = worst criterion; a criterion
 * without an override uses `default`.
 */
export type StageThresholds = { default: SufficiencyThreshold } & Partial<
  Record<SufficiencyCriterion, SufficiencyThreshold>
>;

/** Grade letter family; the +/- modifier collapses (A- → A). */
export type GradeLetter = "A" | "B" | "C";

/**
 * Evidence-exhaustion knob (D-059): when a harvest gap has been harvested
 * low_novelty_attempts times across distinct weeks with continued low novelty
 * and is still below threshold, the analyzer marks the cell evidence_exhausted
 * rather than harvesting forever against thin literature.
 */
export interface ExhaustionConfig {
  /**
   * K — the number of consecutive low-novelty harvest weeks (each a distinct
   * week) after which a (mechanism × segment) target is treated as exhausted.
   */
  low_novelty_attempts: number;
}

/**
 * /analysis/analyzer.config.yaml — the owner-tunable analyzer input:
 * grade weights, a maturity stage selecting per-stage per-criterion thresholds
 * (D-060), the segment → typical-funnel-stage map, segment-affinity boosts, and
 * owner replication flags. segment_stages and segment_affinity are product
 * judgment defaults, not science claims.
 */
export interface AnalyzerConfig {
  version: string;
  grade_weights: Record<GradeLetter, number>;
  /** The "grade ≥ B" cutoff for context_coverage. */
  min_context_grade: EvidenceGrade;
  /** Active maturity stage (D-060) selecting which stage_thresholds apply. */
  maturity_stage: MaturityStage;
  /**
   * Per-stage per-criterion thresholds (D-060). Every stage must carry a valid
   * `default`; the analyzer enforces monotonic (non-decreasing) bars across
   * seed → growing → mature so a stage never silently relaxes the bar.
   */
  stage_thresholds: Record<MaturityStage, StageThresholds>;
  /** Every active segment must have an entry; the analyzer fails loudly otherwise. */
  segment_stages: Record<string, FunnelStage[]>;
  /** Segment → mechanism boost; presence marks segment-specific judgment. */
  segment_affinity: Record<string, Record<string, number>>;
  /** Mechanism ids flagged replication-shaky by the owner (freshness). */
  replication_flags: string[];
  depth_targets: {
    effects_per_mechanism: number;
    realizations_per_mechanism: number;
  };
  field_estimate_overrides?: Record<
    string,
    {
      estimate: number;
      rationale: string;
      reviewed_at: string;
    }
  >;
  /** Evidence-exhaustion thresholds (D-059); absent → exhaustion never fires. */
  exhaustion?: ExhaustionConfig;
}

/**
 * Why a cell is evidence_exhausted (D-059): the best-achievable harvest-criterion
 * scores plus the harvest effort that proved the literature thin. Computed from
 * analysis/harvest-history.json; recorded on the cell so the cockpit can show
 * "thin literature — best available" instead of red-forever.
 */
export interface CellExhaustion {
  /** Total low-novelty harvests recorded across the pack's mechanisms for this segment. */
  attempts: number;
  /** Min consecutive low-novelty weeks shared by every pack mechanism (≥ K). */
  weeks: number;
  /** UTC "YYYY-MM-DD" from which every pack mechanism has been continuously low-novelty. */
  since: string;
  /** The cell's current harvest-criterion scores — the best achievable so far. */
  best_scores: Partial<SufficiencyScores>;
}

/**
 * Which matrix row group a cell belongs to (Step 6, D-067):
 * - "pack" — one of the 11 motivational pack-map rows (D-048), scored per
 *   segment against the pack's own mechanisms.
 * - "perception" — the single cross-cutting row (S7, cross_cutting: true),
 *   scored ONCE per segment against the whole cross-cutting roster instead of
 *   being multiplied into every pack. Reported apart from pack coverage so the
 *   overall-green figure is not distorted by counting the same knowledge 11
 *   times. A cell without this field predates the row group (legacy = pack).
 */
export type MatrixRowGroup = "pack" | "perception";

/** An unpromoted pack member that makes the cell fail closed (D-084). */
export interface CandidateMemberTrace {
  id: string;
  source: string;
  reason: string;
}

/** One scored [row × segment] cell of the sufficiency matrix. */
export interface SufficiencyCell {
  /** The row id: a pack id (D-048) or the reserved "perception" row (D-067). */
  pack: string;
  segment: string;
  /** The row group this cell belongs to (D-067); absent = legacy pack cell. */
  row_group?: MatrixRowGroup;
  scores: SufficiencyScores;
  group_statuses: Record<
    SufficiencyGroup,
    SufficiencyStatus | "unmeasured"
  >;
  measurements: Record<
    SufficiencyCriterion,
    {
      measured: boolean;
      sources: string[];
      note?: string;
      estimate_source?: "upstream_union" | "owner_override";
      override_rationale?: string;
    }
  >;
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
  /**
   * Candidate pack members excluded from authoritative scoring/guidance.
   * Their declared dependency forces the cell red until promotion.
   */
  candidate_members?: CandidateMemberTrace[];
  /**
   * True when every one of the pack's mechanisms has been harvested to
   * exhaustion for this segment (D-059) and the cell still has a scored harvest
   * gap below threshold — the literature is thin, so the loop stops harvesting
   * and surfaces the best-available state. Absent/false = still harvestable.
   * Reversible: a future novel harvest clears the streak and the flag drops.
   */
  evidence_exhausted?: boolean;
  /** Present iff evidence_exhausted — the best-achievable scores + harvest effort. */
  exhaustion?: CellExhaustion;
}

/** /analysis/sufficiency-matrix.json — the generated sufficiency matrix. */
export interface SufficiencyMatrix {
  version: string;
  generated_at: string;
  /** The analyzer.config.yaml version the matrix was scored with. */
  config_version: string;
  /** The maturity stage (D-060) the matrix was scored at. */
  maturity_stage: MaturityStage;
  /**
   * The resolved active-stage thresholds the matrix was scored with (D-060) —
   * stamped so the cockpit states the bars plainly without hardcoding them.
   */
  thresholds: StageThresholds;
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

/** gap_planner.pipeline_budget — planner ceiling; quotes enforce the real token/USD caps. */
export interface GapPlannerPipelineBudgetConfig {
  /** Hard ceiling on extraction tasks offered to the weekly Actions run. */
  max_tasks: number;
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
  pipeline_budget: GapPlannerPipelineBudgetConfig;
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
  /**
   * Candidates skipped because their cell is evidence_exhausted (D-059) — every
   * pack mechanism has been harvested to thin-literature exhaustion for the
   * segment, so no further harvest can move the score. Counted here (never
   * silently dropped): a future novel harvest clears the streak and it re-enters.
   * Optional so queues written before D-059 stay valid.
   */
  evidence_exhausted_skipped?: number;
  tasks: ResearchTask[];
}

// ---------- Extraction queue (/analysis/extraction-queue.json, D-083) ----------

export type ExtractionTaskMode = "effects" | "realizations" | "dissent";

export interface ExtractionTaskSourceCell {
  pack: string;
  segment: string;
  status: Exclude<SufficiencyStatus, "green">;
  criteria: SufficiencyCriterion[];
}

/** One deterministic Actions-only reader task, deduped by mechanism × mode. */
export interface ExtractionTask {
  mechanism: string;
  mode: ExtractionTaskMode;
  /** Maximum segment_weight × pipeline gap size among the source cells. */
  importance: number;
  /** Cells whose pipeline gaps this run can move, in deterministic order. */
  source_cells: ExtractionTaskSourceCell[];
  reason: string;
}

/** /analysis/extraction-queue.json — generated pipeline work, never hand-edited. */
export interface ExtractionQueue {
  version: string;
  generated_at: string;
  config_version: string;
  matrix_generated_at: string;
  candidate_count: number;
  config_max_tasks: number;
  tasks: ExtractionTask[];
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

/**
 * The alternative fillers for an evidence-exhausted cell (D-059) — the only
 * remaining closers once the literature is proven thin: owner judgment, a
 * cross-domain analogy, or accepting the gap at lower confidence.
 */
export type AlternativeFillOption =
  | "owner_judgment"
  | "cross_domain_analogy"
  | "accept_lower_confidence";

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
  /**
   * True when this authoring task exists because the cell is evidence_exhausted
   * (D-059) — its scored harvest gaps can no longer be closed by harvesting, so
   * it is routed here for owner judgment. Absent/false = an ordinary structural
   * task.
   */
  alternative_fill?: boolean;
  /** The alternative fillers offered when alternative_fill is true. */
  fill_options?: AlternativeFillOption[];
  /** The cell's exhaustion summary when alternative_fill is true (best-available scores). */
  exhaustion?: CellExhaustion;
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
  /** Actions-only extraction tasks successfully run this week (D-083). */
  extraction_dispatched?: number;
  /** Extraction tasks deferred by quote/configuration/budget gates (D-083). */
  extraction_deferred?: number;
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
  /**
   * Cells marked evidence_exhausted in the re-scored matrix this run (D-059) —
   * gaps the loop stopped harvesting because the literature is thin. Optional
   * so entries written before D-059 stay valid.
   */
  evidence_exhausted?: number;
  /**
   * True when this week's harvest step failed after its retry (D-097). The week
   * was still analyzed, logged, and committed, but extraction was skipped — so
   * a flat matrix means "not attempted", not "attempted and found nothing".
   * Optional so entries written before D-097 stay valid.
   */
  harvest_failed?: boolean;
}

/** /analysis/maturation-log.json — the append-only weekly maturation history. */
export interface MaturationLog {
  version: string;
  generated_at: string;
  /** Newest run last; the reader sorts for display. */
  entries: MaturationLogEntry[];
}

// ---------- Harvest history (/analysis/harvest-history.json, D-059) ----------
//
// tools/harvest-history.ts appends one attempt per harvested (mechanism ×
// segment) target per weekly maturation run, recording whether that harvest
// came back low-novelty (D-058). It is the persistent per-gap memory the
// analyzer reads to detect evidence exhaustion: a target harvested K times
// across distinct weeks with continued low novelty is exhausted. A COMPUTED
// projection, never hand-edited (the maturation-log precedent, D-053).

/** One weekly harvest of a (mechanism × segment) target. */
export interface HarvestAttempt {
  /** UTC "YYYY-MM-DD" of the maturation run (one attempt per distinct week). */
  week: string;
  /** The segment-qualified terms the harvest used (for term-change transparency). */
  terms: string[];
  /** True when the harvest returned mostly already-known records (D-058). */
  low_novelty: boolean;
}

/** The harvest history of one (mechanism × segment) target, keyed "mechanism|segment". */
export interface HarvestHistoryTarget {
  /** Every recorded weekly harvest, oldest first. */
  attempts: HarvestAttempt[];
  /**
   * Trailing consecutive low-novelty attempts (weeks) — the current streak. A
   * novel harvest resets it to 0. ≥ K (config exhaustion.low_novelty_attempts)
   * means the target is exhausted.
   */
  low_novelty_streak: number;
  /**
   * Week the current low-novelty streak began (the first attempt in the trailing
   * low-novelty run); null when the streak is 0.
   */
  streak_since: string | null;
}

/** /analysis/harvest-history.json — per-target harvest memory for exhaustion (D-059). */
export interface HarvestHistory {
  version: string;
  generated_at: string;
  /** "mechanism|segment" → that target's harvest history. */
  entries: Record<string, HarvestHistoryTarget>;
}

/**
 * tools/analyzer.ts — sufficiency scoring per [pack × segment] cell (D-050).
 *
 * For every pack-map element (/packs/pack-map.yaml, D-048) × every ACTIVE
 * segment (/segments/segments.yaml, D-047), computes whether the knowledge is
 * mature: breadth, depth, and quality criteria scored against traceable
 * repository data, plus an
 * overall status (red/amber/green). Output: analysis/sufficiency-matrix.json
 * — a COMPUTED projection, never hand-edited (same pattern as render-cards /
 * render-packs). The ONE hand-authored input is
 * analysis/analyzer.config.yaml: grade weights, thresholds, the segment →
 * typical-funnel-stage map, segment-affinity boosts, and owner replication
 * flags. Re-score with `npm run analyze`.
 *
 * Scoped re-score (D-052, the maturation loop): `npm run analyze -- packs=a,b`
 * re-scores ONLY the listed packs' cells and preserves every other pack's
 * cells from the existing matrix — the loop re-analyzes the cells its
 * harvests touched, not the whole grid. The merged matrix keeps pack-map
 * order, so a scoped run diffs cleanly against a full one. A scoped run
 * requires an existing matrix whose preserved packs cover every active
 * segment; anything else fails loudly and asks for a full `npm run analyze`.
 *
 * The quality criteria include:
 * - dissent_completeness — share of the pack's mechanisms whose dossier
 *   dissent is non-empty (missing dossier or blank dissent = 0). Deliberately
 *   UNWEIGHTED: dissent is a knowledge-hygiene bar, and a stripped dossier is
 *   a failure regardless of how relevant its mechanism is to the segment
 * - grade_sufficiency — weighted mean of grade-letter weights (A=1, B=0.6,
 *   C=0.2 by default; the +/- modifier collapses, A- → A)
 * - interaction_coverage — share of the pack's mechanism pairs connected by
 *   a registry relation OR an owner-authored interaction record
 *   (/interactions, D-057; same pairing logic as render-packs LAYER 2;
 *   orthogonality_note documents separation, not an interaction)
 * - context_coverage — share of the segment's typical funnel stages on which
 *   the pack holds ≥1 grade≥B mechanism whose applicability covers the stage
 * - freshness — 1 minus the weighted share of pack mechanisms the owner has
 *   flagged replication-shaky (config replication_flags; defaults green)
 *
 * Segment relevance: a mechanism's fit to a segment is derived from its
 * applicability (funnel-stage overlap with the segment's typical stages) ×
 * the segment-affinity config, capped at 1 — weights redistribute emphasis
 * inside a cell, they never fabricate evidence. Where no segment-specific
 * judgment touches the pack, the cell scores on general evidence and carries
 * segment_evidence: general_only — the signal that segment-specific
 * harvesting is needed.
 *
 * Segment evolution (D-054): an ACTIVE segment with NO segment_stages entry is
 * a BOOTSTRAP segment — the owner just added it to segments.yaml and hasn't
 * mapped its funnel stages / affinities yet. Rather than fail loudly (which
 * would block adding a segment), the analyzer admits it into the matrix as an
 * honest all-red column: every pack × bootstrap-segment cell scores 0 on all
 * configured criteria, status red, all criteria as gaps, segment_evidence
 * general_only. Nothing is demonstrated FOR this segment yet, so red is the
 * truthful state, and the maximal gap_size pushes it to the top of the gap
 * planner's queue — the segment starts maturing through the loop. The owner
 * graduates it from bootstrap to configured by adding segment_stages (and
 * optionally segment_affinity), at which point it scores on the real criteria.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AnalyzerConfig,
  CorpusManifest,
  Dossier,
  Effect,
  EvidenceCorpusFile,
  EvidenceGrade,
  FunnelStage,
  GapFixType,
  GradeLetter,
  HarvestHistory,
  MaturityStage,
  MatrixRowGroup,
  Mechanism,
  ReaderCoverageFile,
  Realization,
  RealizationCorpusFile,
  SeedStub,
  PackMapFile,
  SegmentsFile,
  StageThresholds,
  SufficiencyCell,
  SufficiencyCriterion,
  SufficiencyGroup,
  SufficiencyMatrix,
  SufficiencyScores,
  SufficiencyStatus,
  SufficiencyThreshold,
  Taxonomy,
  TypedGap,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const MECHANISMS_DIR = join(ROOT, "registry", "mechanisms");
const SEED_DIR = join(MECHANISMS_DIR, "_seed");
const TAXONOMY = join(ROOT, "registry", "taxonomy.json");
const DOSSIERS_DIR = join(ROOT, "dossiers");
const INTERACTIONS_DIR = join(ROOT, "interactions");
const EFFECTS_DIR = join(ROOT, "effects");
const REALIZATIONS_DIR = join(ROOT, "realizations");
const EVIDENCE_DIR = join(ROOT, "corpora", "evidence");
const EVIDENCE_MANIFEST = join(EVIDENCE_DIR, "manifest.json");
const REALIZATION_CORPUS_DIR = join(ROOT, "corpora", "realizations");
const READER_COVERAGE = join(ROOT, "corpora", "extraction", "coverage.json");
const PACK_MAP = join(ROOT, "packs", "pack-map.yaml");
const SEGMENTS = join(ROOT, "segments", "segments.yaml");
const ANALYSIS_DIR = join(ROOT, "analysis");
const CONFIG = join(ANALYSIS_DIR, "analyzer.config.yaml");
const MATRIX = join(ANALYSIS_DIR, "sufficiency-matrix.json");
const HARVEST_HISTORY = join(ANALYSIS_DIR, "harvest-history.json");

const MATRIX_VERSION = "0.5.0";

/**
 * The reserved row id of the cross-cutting perception row group (Step 6, D-067):
 * cross-cutting mechanisms (S7, cross_cutting: true) are scored ONCE per segment
 * as this single row, NOT multiplied into all 11 pack rows. The pack map may not
 * use this id for a motivational element (validate.ts enforces it).
 */
const PERCEPTION_ROW = "perception";

const CRITERIA: SufficiencyCriterion[] = [
  "saturation_reached",
  "corpus_size_vs_field_estimate",
  "source_diversity",
  "recency_balance",
  "effect_coverage",
  "realization_density",
  "interaction_coverage",
  "extraction_completeness",
  "dissent_completeness",
  "grade_sufficiency",
  "context_coverage",
  "freshness",
];

const CRITERION_GROUPS: Record<SufficiencyGroup, SufficiencyCriterion[]> = {
  breadth: [
    "saturation_reached",
    "corpus_size_vs_field_estimate",
    "source_diversity",
    "recency_balance",
  ],
  depth: [
    "effect_coverage",
    "realization_density",
    "interaction_coverage",
    "extraction_completeness",
  ],
  quality: [
    "dissent_completeness",
    "grade_sufficiency",
    "context_coverage",
    "freshness",
  ],
};

/** Maturity stages (D-060) in ascending-bar order — monotonicity is checked over this. */
const MATURITY_STAGES: MaturityStage[] = ["seed", "growing", "mature"];

/**
 * Gap typing (D-055): every failing criterion is labeled by what can actually
 * close it. harvest gaps are closed by fetching more/better evidence through
 * the connector; structural gaps are closed only by owner edits in git —
 * registry relations, pack composition, dossier dissent — and NO harvest can
 * touch them. The maturation loop must never dispatch a harvest against a
 * structural gap. Dissent is pipeline work: the grounded reader can propose
 * dossier dissent from harvested evidence, but owner approval remains required.
 */
const FIX_TYPE: Record<SufficiencyCriterion, GapFixType> = {
  saturation_reached: "harvest",
  corpus_size_vs_field_estimate: "harvest",
  source_diversity: "harvest",
  recency_balance: "harvest",
  effect_coverage: "pipeline",
  realization_density: "pipeline",
  dissent_completeness: "pipeline",
  grade_sufficiency: "harvest",
  interaction_coverage: "structural",
  extraction_completeness: "pipeline",
  context_coverage: "structural",
  freshness: "harvest",
};

/** What would close each criterion's gap — the fix that stops the wheel spinning. */
const WHAT_WOULD_CLOSE_IT: Record<SufficiencyCriterion, string> = {
  saturation_reached:
    "a completed evidence harvest whose saturation report reaches the novelty frontier",
  corpus_size_vs_field_estimate:
    "upstream result totals from a successful harvest, or a reviewed owner override when the automatic estimate is demonstrably inflated",
  source_diversity:
    "records contributed by the evidence connector's configured upstream literature sources",
  recency_balance:
    "a harvest that adds enough recent literature to meet the active-stage bar",
  effect_coverage:
    "grounded effect extraction followed by owner approval into /effects",
  realization_density:
    "realization-corpus reading followed by owner approval into /realizations",
  dissent_completeness:
    "dissent text in the member dossiers (owner-authored, git)",
  grade_sufficiency:
    "higher-grade evidence for the pack's weak mechanisms (harvest, then owner re-grade)",
  interaction_coverage:
    "registry relations between the pack's member mechanisms (owner edit, git)",
  extraction_completeness:
    "a successful Actions-only reader run covering the current eligible corpus records",
  context_coverage:
    "a grade≥B mechanism whose applicability covers the segment's uncovered funnel stages (owner edit / pack composition, git)",
  freshness:
    "replication-supporting evidence so the owner can clear replication_flags (harvest)",
};

/** The general_only harvest pseudo-gap — segment-specific evidence is missing. */
const SEGMENT_EVIDENCE_GAP_CLOSER =
  "segment-qualified evidence plus a segment_affinity entry touching this pack (harvest)";

const FUNNEL_STAGES: FunnelStage[] = [
  "cold_acquisition",
  "onboarding",
  "activation",
  "conversion",
  "retention",
  "reactivation",
];

// Strong → weak, mirroring render-packs; grade ≥ B means index ≤ index("B").
const GRADE_ORDER: EvidenceGrade[] = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];

const STATUS_RANK: Record<SufficiencyStatus, number> = { green: 0, amber: 1, red: 2 };

function rel(path: string): string {
  return relative(ROOT, path);
}

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function listJsonFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listJsonFilesRecursive(join(dir, entry.name))
        : entry.isFile() && entry.name.endsWith(".json")
          ? [join(dir, entry.name)]
          : [],
    )
    .sort();
}

/** Grade letter family: the +/- modifier collapses (A- → A). */
function gradeLetter(grade: EvidenceGrade): GradeLetter {
  return grade.charAt(0) as GradeLetter;
}

function gradeAtLeast(grade: EvidenceGrade, cutoff: EvidenceGrade): boolean {
  return GRADE_ORDER.indexOf(grade) <= GRADE_ORDER.indexOf(cutoff);
}

/** Round to 4 decimals so the matrix diffs stay stable across runs. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// ---------- config loading + loud validation ----------

interface LoadedConfig {
  config: AnalyzerConfig;
  /** Active segments with NO segment_stages entry — enter the matrix all-red. */
  bootstrapSegmentIds: Set<string>;
}

function loadConfig(activeSegmentIds: string[], rosterIds: Set<string>): LoadedConfig {
  if (!existsSync(CONFIG)) {
    console.error(`  ✗ no analyzer config at ${rel(CONFIG)} — nothing to score.`);
    process.exit(1);
  }
  const config = parseYaml(readFileSync(CONFIG, "utf-8")) as AnalyzerConfig;
  const problems: string[] = [];
  const bootstrapSegmentIds = new Set<string>();

  for (const letter of ["A", "B", "C"] as const) {
    const weight = config.grade_weights?.[letter];
    if (typeof weight !== "number" || weight < 0 || weight > 1) {
      problems.push(`grade_weights.${letter} must be a number in [0, 1]`);
    }
  }

  for (const [name, target] of Object.entries(config.depth_targets ?? {})) {
    if (!Number.isInteger(target) || target < 1) {
      problems.push(`depth_targets.${name} must be an integer ≥ 1`);
    }
  }
  if (!config.depth_targets?.effects_per_mechanism) {
    problems.push("depth_targets.effects_per_mechanism is required");
  }
  if (!config.depth_targets?.realizations_per_mechanism) {
    problems.push("depth_targets.realizations_per_mechanism is required");
  }
  for (const [mechanismId, override] of Object.entries(
    config.field_estimate_overrides ?? {},
  )) {
    if (!rosterIds.has(mechanismId)) {
      problems.push(`field_estimate_overrides names unknown mechanism "${mechanismId}"`);
    }
    if (!Number.isInteger(override.estimate) || override.estimate < 1) {
      problems.push(`field_estimate_overrides.${mechanismId}.estimate must be an integer ≥ 1`);
    }
    if (!override.rationale?.trim()) {
      problems.push(`field_estimate_overrides.${mechanismId}.rationale is required`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(override.reviewed_at ?? "")) {
      problems.push(`field_estimate_overrides.${mechanismId}.reviewed_at must be YYYY-MM-DD`);
    }
  }

  if (!GRADE_ORDER.includes(config.min_context_grade)) {
    problems.push(`min_context_grade "${config.min_context_grade}" is not a grade`);
  }

  // Maturity stage + per-stage thresholds (D-060). The active stage must be one
  // of the three; every stage must carry a valid `default` and only real
  // criteria as overrides; and the bars must be MONOTONIC (non-decreasing)
  // across seed → growing → mature so a later stage never silently relaxes an
  // earlier one — the "explicit maturity model, not a lowered bar" guarantee.
  if (!MATURITY_STAGES.includes(config.maturity_stage)) {
    problems.push(
      `maturity_stage "${config.maturity_stage}" must be one of ${MATURITY_STAGES.join(" | ")}`,
    );
  }
  for (const stage of MATURITY_STAGES) {
    const stageThresholds = config.stage_thresholds?.[stage];
    if (!stageThresholds) {
      problems.push(`stage_thresholds.${stage} is required`);
      continue;
    }
    if (!stageThresholds.default) {
      problems.push(`stage_thresholds.${stage}.default is required`);
    }
    for (const [name, threshold] of Object.entries(stageThresholds)) {
      if (name !== "default" && !CRITERIA.includes(name as SufficiencyCriterion)) {
        problems.push(`stage_thresholds.${stage}.${name} is not a sufficiency criterion`);
        continue;
      }
      const { green, amber } = threshold as SufficiencyThreshold;
      if (
        typeof green !== "number" ||
        typeof amber !== "number" ||
        amber > green ||
        amber < 0 ||
        green > 1
      ) {
        problems.push(`stage_thresholds.${stage}.${name} must satisfy 0 ≤ amber ≤ green ≤ 1`);
      }
    }
  }
  // Monotonicity across adjacent stages, per resolved criterion (default +
  // every override key seen at either stage), on both green and amber.
  for (let i = 1; i < MATURITY_STAGES.length; i += 1) {
    const lower = config.stage_thresholds?.[MATURITY_STAGES[i - 1]];
    const higher = config.stage_thresholds?.[MATURITY_STAGES[i]];
    if (!lower?.default || !higher?.default) continue;
    const keys = Array.from(
      new Set<string>(["default", ...Object.keys(lower), ...Object.keys(higher)]),
    );
    for (const key of keys) {
      const lo = (lower as Record<string, SufficiencyThreshold>)[key] ?? lower.default;
      const hi = (higher as Record<string, SufficiencyThreshold>)[key] ?? higher.default;
      if (hi.green < lo.green || hi.amber < lo.amber) {
        problems.push(
          `stage_thresholds ${key} must be non-decreasing ${MATURITY_STAGES[i - 1]} → ${MATURITY_STAGES[i]} ` +
            `(green ${lo.green}→${hi.green}, amber ${lo.amber}→${hi.amber})`,
        );
      }
    }
  }

  // Segment evolution (D-054): an active segment WITHOUT a segment_stages entry
  // is not an error — it is a freshly-added BOOTSTRAP segment that enters the
  // matrix all-red until the owner maps its funnel. A malformed entry (present
  // but with an unknown stage) is still a loud error; the analyzer never
  // guesses a segment's funnel.
  for (const segmentId of activeSegmentIds) {
    const stages = config.segment_stages?.[segmentId];
    if (!Array.isArray(stages) || stages.length === 0) {
      bootstrapSegmentIds.add(segmentId);
      continue;
    }
    for (const stage of stages) {
      if (!FUNNEL_STAGES.includes(stage)) {
        problems.push(`segment_stages.${segmentId} carries unknown stage "${stage}"`);
      }
    }
  }
  for (const segmentId of Object.keys(config.segment_stages ?? {})) {
    if (!activeSegmentIds.includes(segmentId)) {
      problems.push(`segment_stages entry "${segmentId}" is not an active segment`);
    }
  }

  for (const [segmentId, boosts] of Object.entries(config.segment_affinity ?? {})) {
    if (!activeSegmentIds.includes(segmentId)) {
      problems.push(`segment_affinity entry "${segmentId}" is not an active segment`);
    }
    for (const [mechanismId, boost] of Object.entries(boosts)) {
      if (!rosterIds.has(mechanismId)) {
        problems.push(`segment_affinity.${segmentId} boosts unknown mechanism "${mechanismId}"`);
      }
      if (typeof boost !== "number" || boost <= 0) {
        problems.push(`segment_affinity.${segmentId}.${mechanismId} must be a positive number`);
      }
    }
  }

  for (const mechanismId of config.replication_flags ?? []) {
    if (!rosterIds.has(mechanismId)) {
      problems.push(`replication_flags carries unknown mechanism "${mechanismId}"`);
    }
  }

  // Evidence exhaustion (D-059): the block is optional (absent → exhaustion
  // never fires), but a present one must carry a sane K.
  if (config.exhaustion !== undefined) {
    const k = config.exhaustion.low_novelty_attempts;
    if (!Number.isInteger(k) || k < 1) {
      problems.push("exhaustion.low_novelty_attempts must be an integer ≥ 1");
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${rel(CONFIG)}: ${problem}`);
    process.exit(1);
  }
  return { config, bootstrapSegmentIds };
}

/**
 * An honest all-red bootstrap cell for an active segment the owner has added
 * to segments.yaml but not yet configured in segment_stages (D-054): every
 * criterion is unmeasured, so the cell is red and general_only. Nothing
 * is demonstrated for this segment yet, so red is the truthful state and the
 * maximal gap feeds the segment straight into the maturation loop.
 */
function bootstrapCell(
  packId: string,
  segmentId: string,
  config: AnalyzerConfig,
  rowGroup: MatrixRowGroup,
): SufficiencyCell {
  const scores = Object.fromEntries(
    CRITERIA.map((criterion) => [criterion, null]),
  ) as SufficiencyScores;
  const gaps = [...CRITERIA];
  const measurements = Object.fromEntries(
    CRITERIA.map((criterion) => [
      criterion,
      {
        measured: false,
        sources: [rel(CONFIG)],
        note: "segment is not configured for scoring",
      },
    ]),
  ) as SufficiencyCell["measurements"];
  return {
    pack: packId,
    segment: segmentId,
    row_group: rowGroup,
    scores,
    group_statuses: {
      breadth: "unmeasured",
      depth: "unmeasured",
      quality: "unmeasured",
    },
    measurements,
    status: "red",
    gaps,
    typed_gaps: buildTypedGaps(gaps, scores, config, "general_only", "red"),
    segment_evidence: "general_only",
  };
}

/**
 * Candidate members are declared dependencies but not authoritative knowledge.
 * Keep full-record scores visible, force every group/cell red, and trace exactly
 * which promotion gate is pending. This is distinct from evidence exhaustion.
 */
export function applyCandidatePendency(
  cell: SufficiencyCell,
  candidates: SeedStub[],
): SufficiencyCell {
  if (candidates.length === 0) return cell;
  return {
    ...cell,
    group_statuses: {
      breadth: "red",
      depth: "red",
      quality: "red",
    },
    status: "red",
    candidate_members: [...candidates]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((candidate) => ({
        id: candidate.id,
        source: rel(join(SEED_DIR, `${candidate.id}.json`)),
        reason: `member mechanism ${candidate.id} is a candidate — no evidence yet`,
      })),
  };
}

// ---------- scoring ----------

interface MemberContext {
  mechanism: Mechanism;
  /** Segment-relevance weight in (0, 1]. */
  weight: number;
  dissentPresent: boolean;
  replicationFlagged: boolean;
}

/** The active-stage (D-060) threshold map the matrix is scored against. */
function activeThresholds(config: AnalyzerConfig): StageThresholds {
  return config.stage_thresholds[config.maturity_stage];
}

function thresholdFor(config: AnalyzerConfig, criterion: SufficiencyCriterion): SufficiencyThreshold {
  const active = activeThresholds(config);
  return active[criterion] ?? active.default;
}

function statusFor(score: number, threshold: SufficiencyThreshold): SufficiencyStatus {
  if (score >= threshold.green) return "green";
  if (score >= threshold.amber) return "amber";
  return "red";
}

/**
 * Type every gap by its filler (D-055): one TypedGap per failing criterion,
 * plus a segment_evidence harvest pseudo-gap when the cell scored on general
 * evidence only and is not green. value is the cell's score, threshold the
 * green bar it falls short of, fix_type + what_would_close_it the fix. No gap
 * is left untyped — the loop reads this to route harvest vs structural work.
 */
/**
 * Owner-facing detail attached to a structural gap so the authoring queue
 * (D-056) shows exactly what to edit: which member pairs are unlinked
 * (interaction_coverage) or which funnel stages are uncovered (context_coverage).
 */
interface GapDetail {
  missing_interaction_pairs?: [string, string][];
  uncovered_stages?: FunnelStage[];
}

function buildTypedGaps(
  gaps: SufficiencyCriterion[],
  scores: SufficiencyScores,
  config: AnalyzerConfig,
  segmentEvidence: "segment_specific" | "general_only",
  status: SufficiencyStatus,
  detail: Partial<Record<SufficiencyCriterion, GapDetail>> = {},
): TypedGap[] {
  const typed: TypedGap[] = gaps.map((criterion) => ({
    criterion,
    value: scores[criterion],
    threshold: thresholdFor(config, criterion).green,
    fix_type: FIX_TYPE[criterion],
    what_would_close_it: WHAT_WOULD_CLOSE_IT[criterion],
    ...(detail[criterion] ?? {}),
  }));
  if (segmentEvidence === "general_only" && status !== "green") {
    typed.push({
      criterion: "segment_evidence",
      value: 0,
      threshold: 1,
      fix_type: "harvest",
      what_would_close_it: SEGMENT_EVIDENCE_GAP_CLOSER,
    });
  }
  return typed;
}

/** Weighted mean of per-member values; weights only redistribute emphasis. */
function weightedMean(members: MemberContext[], value: (m: MemberContext) => number): number {
  const totalWeight = members.reduce((sum, m) => sum + m.weight, 0);
  const weightedSum = members.reduce((sum, m) => sum + m.weight * value(m), 0);
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/** Order a member-pair id key deterministically (locale-stable, both sites). */
function pairKey(a: string, b: string): string {
  return a.localeCompare(b) <= 0 ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Share of the pack's C(n,2) mechanism pairs connected by a registry relation
 * in either direction OR by an owner-authored interaction record (D-057) — the
 * same pairing logic render-packs projects into LAYER 2. orthogonality_note is
 * excluded: it documents that two mechanisms are separate, not that they
 * interact. An authored record (ANY type, including neutral) counts as covered:
 * it means the owner examined the pair, which is exactly what coverage measures
 * — unlike the cheap orthogonality_note relation, which stays excluded. Also
 * returns the UNLINKED pairs (neither related nor authored) so a structural
 * interaction_coverage gap names exactly which links the owner must author
 * (D-056), and those pairs shrink as records land.
 */
function interactionCoverage(
  members: Mechanism[],
  authoredPairs: Set<string>,
): {
  coverage: number;
  missing: [string, string][];
} {
  if (members.length < 2) return { coverage: 1, missing: [] };
  const memberIds = new Set(members.map((m) => m.id));
  const connected = new Set<string>();
  for (const m of members) {
    for (const relation of m.relations) {
      if (relation.type === "orthogonality_note") continue;
      if (!memberIds.has(relation.target)) continue;
      connected.add(pairKey(m.id, relation.target));
    }
  }
  const ids = members.map((m) => m.id).sort((a, b) => a.localeCompare(b));
  const missing: [string, string][] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = pairKey(ids[i], ids[j]);
      if (authoredPairs.has(key)) connected.add(key);
      if (!connected.has(key)) missing.push([ids[i], ids[j]]);
    }
  }
  const totalPairs = (members.length * (members.length - 1)) / 2;
  return { coverage: connected.size / totalPairs, missing };
}

/**
 * Share of the segment's typical stages on which the pack holds ≥1 mechanism
 * at grade ≥ min_context_grade whose applicability covers the stage (listed
 * in funnel_stages and not excluded). Also returns the UNCOVERED stages so a
 * structural context_coverage gap names exactly which stages the owner must
 * cover by composition (D-056).
 */
function contextCoverage(
  members: Mechanism[],
  segmentStages: FunnelStage[],
  minGrade: EvidenceGrade,
): { coverage: number; uncovered: FunnelStage[] } {
  const uncovered = segmentStages.filter(
    (stage) =>
      !members.some(
        (m) =>
          gradeAtLeast(m.evidence.grade, minGrade) &&
          m.applicability.funnel_stages.includes(stage) &&
          !m.applicability.excluded_stages.includes(stage),
      ),
  );
  const covered = segmentStages.length - uncovered.length;
  return { coverage: covered / segmentStages.length, uncovered };
}

interface ArtifactSummary {
  count: number;
  files: string[];
}

interface AnalyzerKnowledge {
  evidence: Map<string, EvidenceCorpusFile>;
  realizationCorpora: Map<string, RealizationCorpusFile>;
  expectedEvidenceSources: number;
  effects: Map<string, ArtifactSummary>;
  realizations: Map<string, ArtifactSummary>;
  readerCoverage: ReaderCoverageFile | null;
}

function measuredMean(values: (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  let sum = 0;
  for (const value of values) sum += value as number;
  return round(sum / values.length);
}

function groupStatus(
  group: SufficiencyGroup,
  scores: SufficiencyScores,
  config: AnalyzerConfig,
): SufficiencyStatus | "unmeasured" {
  const criteria = CRITERION_GROUPS[group];
  if (criteria.some((criterion) => scores[criterion] === null)) return "unmeasured";
  let result: SufficiencyStatus = "green";
  for (const criterion of criteria) {
    const status = statusFor(
      scores[criterion] as number,
      thresholdFor(config, criterion),
    );
    if (STATUS_RANK[status] > STATUS_RANK[result]) result = status;
  }
  return result;
}

function corpusRecordIds(corpus: EvidenceCorpusFile | undefined): string[] {
  return (corpus?.records ?? [])
    .filter(
      (record) =>
        typeof record.abstract === "string" &&
        record.abstract.trim().length > 0,
    )
    .map((record) => record.record_id);
}

function realizationRecordIds(
  corpus: RealizationCorpusFile | undefined,
): string[] {
  return (corpus?.records ?? [])
    .filter((record) => record.observation.trim().length > 0)
    .map((record) => record.record_id);
}

function scoreCell(
  packId: string,
  segmentId: string,
  members: Mechanism[],
  dossiers: Map<string, Dossier>,
  config: AnalyzerConfig,
  authoredPairs: Set<string>,
  rowGroup: MatrixRowGroup,
  knowledge: AnalyzerKnowledge,
): SufficiencyCell {
  const segmentStages = config.segment_stages[segmentId];
  const affinity = config.segment_affinity[segmentId] ?? {};
  const flagged = new Set(config.replication_flags);

  const contexts: MemberContext[] = members.map((m) => {
    // Base fit from applicability: full weight when the mechanism operates on
    // any of the segment's typical stages, half otherwise. Affinity boosts
    // load-bearing mechanisms; the cap keeps every weight ≤ 1.
    const stageFit = m.applicability.funnel_stages.some((stage) =>
      segmentStages.includes(stage as FunnelStage),
    );
    const base = stageFit ? 1 : 0.5;
    const boost = affinity[m.id] ?? 1;
    const dossier = dossiers.get(m.id);
    return {
      mechanism: m,
      weight: Math.min(1, base * boost),
      dissentPresent: typeof dossier?.dissent === "string" && dossier.dissent.trim().length > 0,
      replicationFlagged: flagged.has(m.id),
    };
  });

  // Unweighted by design (see the header): a stripped dossier fails the
  // hygiene bar for every segment, not only where its mechanism fits best.
  const dissentShare =
    contexts.filter((m) => m.dissentPresent).length / Math.max(contexts.length, 1);

  const interaction = interactionCoverage(members, authoredPairs);
  const context = contextCoverage(members, segmentStages, config.min_context_grade);

  const evidenceSources = members.map((member) =>
    rel(join(EVIDENCE_DIR, `${member.id}.json`)),
  );
  const saturationValues = members.map((member) => {
    const report = knowledge.evidence.get(member.id)?.saturation_report;
    return report ? (report.saturation_reached ? 1 : 0) : null;
  });
  const estimateMeta = members.map((member) => {
    const override = config.field_estimate_overrides?.[member.id];
    const automatic =
      knowledge.evidence.get(member.id)?.saturation_report?.field_union_estimate
        ?.estimate ?? null;
    return {
      member,
      estimate: override?.estimate ?? automatic,
      override,
    };
  });
  const corpusRatioValues = estimateMeta.map(({ member, estimate }) =>
    estimate && estimate > 0
      ? Math.min(1, (knowledge.evidence.get(member.id)?.records.length ?? 0) / estimate)
      : null,
  );
  const diversityValues = members.map((member) => {
    const spread = knowledge.evidence.get(member.id)?.diversity_report?.source_spread;
    if (!spread || knowledge.expectedEvidenceSources < 1) return null;
    const contributing = new Set(
      spread
        .filter((source) => source.unique_records > 0)
        .map((source) => source.api),
    ).size;
    return Math.min(1, contributing / knowledge.expectedEvidenceSources);
  });
  const recencyValues = members.map(
    (member) =>
      knowledge.evidence.get(member.id)?.diversity_report?.recency_rate ?? null,
  );
  const effectValues = members.map(
    (member) =>
      Math.min(
        1,
        (knowledge.effects.get(member.id)?.count ?? 0) /
          config.depth_targets.effects_per_mechanism,
      ),
  );
  const realizationValues = members.map(
    (member) =>
      Math.min(
        1,
        (knowledge.realizations.get(member.id)?.count ?? 0) /
          config.depth_targets.realizations_per_mechanism,
      ),
  );
  const extractionValues = members.map((member) => {
    const evidenceIds = corpusRecordIds(knowledge.evidence.get(member.id));
    const realizationIds = realizationRecordIds(
      knowledge.realizationCorpora.get(member.id),
    );
    const totalIds = [...evidenceIds, ...realizationIds];
    if (totalIds.length === 0) return null;
    const ledger = knowledge.readerCoverage?.mechanisms[member.id];
    if (evidenceIds.length > 0 && !ledger?.evidence) return null;
    if (realizationIds.length > 0 && !ledger?.realization) return null;
    const processed = new Set([
      ...(ledger?.evidence?.processed_record_ids ?? []),
      ...(ledger?.realization?.processed_record_ids ?? []),
    ]);
    return totalIds.filter((id) => processed.has(id)).length / totalIds.length;
  });

  const scores: SufficiencyScores = {
    saturation_reached: measuredMean(saturationValues),
    corpus_size_vs_field_estimate: measuredMean(corpusRatioValues),
    source_diversity: measuredMean(diversityValues),
    recency_balance: measuredMean(recencyValues),
    effect_coverage: measuredMean(effectValues),
    realization_density: measuredMean(realizationValues),
    dissent_completeness: round(dissentShare),
    grade_sufficiency: round(
      weightedMean(contexts, (m) => config.grade_weights[gradeLetter(m.mechanism.evidence.grade)]),
    ),
    interaction_coverage: round(interaction.coverage),
    extraction_completeness: measuredMean(extractionValues),
    context_coverage: round(context.coverage),
    freshness: round(1 - weightedMean(contexts, (m) => (m.replicationFlagged ? 1 : 0))),
  };

  const overrideMembers = estimateMeta.filter((entry) => entry.override);
  const measurements: SufficiencyCell["measurements"] = {
    saturation_reached: {
      measured: scores.saturation_reached !== null,
      sources: evidenceSources,
      ...(scores.saturation_reached === null
        ? { note: "one or more member corpora have no saturation report" }
        : {}),
    },
    corpus_size_vs_field_estimate: {
      measured: scores.corpus_size_vs_field_estimate !== null,
      sources: [
        ...evidenceSources,
        ...(overrideMembers.length > 0 ? [rel(CONFIG)] : []),
      ],
      ...(scores.corpus_size_vs_field_estimate === null
        ? { note: "upstream field-size estimate is unavailable for one or more members" }
        : {}),
      estimate_source:
        overrideMembers.length > 0 ? "owner_override" : "upstream_union",
      ...(overrideMembers.length > 0
        ? {
            override_rationale: overrideMembers
              .map(
                ({ member, override }) =>
                  `${member.id}: ${override?.rationale ?? ""}`,
              )
              .join(" · "),
          }
        : {}),
    },
    source_diversity: {
      measured: scores.source_diversity !== null,
      sources: [...evidenceSources, rel(EVIDENCE_MANIFEST)],
      ...(scores.source_diversity === null
        ? { note: "source-spread or configured-source data is unavailable" }
        : {}),
    },
    recency_balance: {
      measured: scores.recency_balance !== null,
      sources: evidenceSources,
      ...(scores.recency_balance === null
        ? { note: "recency report is unavailable for one or more members" }
        : {}),
    },
    effect_coverage: {
      measured: true,
      sources: [
        "effects/effect.schema.json",
        ...members.flatMap((member) => knowledge.effects.get(member.id)?.files ?? []),
        rel(CONFIG),
      ],
    },
    realization_density: {
      measured: true,
      sources: [
        "realizations/realization.schema.json",
        ...members.flatMap(
          (member) => knowledge.realizations.get(member.id)?.files ?? [],
        ),
        rel(CONFIG),
      ],
    },
    interaction_coverage: {
      measured: true,
      sources: [
        ...members.map((member) =>
          rel(join(MECHANISMS_DIR, `${member.id}.json`)),
        ),
        "interactions/",
      ],
    },
    extraction_completeness: {
      measured: scores.extraction_completeness !== null,
      sources: [rel(READER_COVERAGE), ...evidenceSources],
      ...(scores.extraction_completeness === null
        ? { note: "the reader has no exact coverage ledger for one or more current corpora" }
        : {}),
    },
    dissent_completeness: {
      measured: true,
      sources: members.map((member) =>
        rel(join(DOSSIERS_DIR, `${member.id}.json`)),
      ),
    },
    grade_sufficiency: {
      measured: true,
      sources: members.map((member) =>
        rel(join(MECHANISMS_DIR, `${member.id}.json`)),
      ),
    },
    context_coverage: {
      measured: true,
      sources: [
        ...members.map((member) =>
          rel(join(MECHANISMS_DIR, `${member.id}.json`)),
        ),
        rel(CONFIG),
      ],
    },
    freshness: {
      measured: true,
      sources: [rel(CONFIG)],
    },
  };

  let status: SufficiencyStatus = "green";
  const gaps: SufficiencyCriterion[] = [];
  for (const criterion of CRITERIA) {
    const score = scores[criterion];
    const criterionStatus =
      score === null
        ? "red"
        : statusFor(score, thresholdFor(config, criterion));
    if (criterionStatus !== "green") gaps.push(criterion);
    if (STATUS_RANK[criterionStatus] > STATUS_RANK[status]) status = criterionStatus;
  }
  const groupStatuses: SufficiencyCell["group_statuses"] = {
    breadth: groupStatus("breadth", scores, config),
    depth: groupStatus("depth", scores, config),
    quality: groupStatus("quality", scores, config),
  };

  // Segment-specific judgment exists for this cell iff an affinity entry
  // touches one of the pack's mechanisms; otherwise the cell scored on
  // general evidence only — the flag that segment harvesting is needed.
  const segmentSpecific = members.some((m) => affinity[m.id] !== undefined);

  const segmentEvidence = segmentSpecific ? "segment_specific" : "general_only";

  // Owner-facing detail on the structural gaps (D-056): the exact unlinked
  // member pairs / uncovered stages, so the authoring queue is actionable.
  const detail: Partial<Record<SufficiencyCriterion, GapDetail>> = {};
  if (interaction.missing.length > 0) {
    detail.interaction_coverage = { missing_interaction_pairs: interaction.missing };
  }
  if (context.uncovered.length > 0) {
    detail.context_coverage = { uncovered_stages: context.uncovered };
  }

  return {
    pack: packId,
    segment: segmentId,
    row_group: rowGroup,
    scores,
    group_statuses: groupStatuses,
    measurements,
    status,
    gaps,
    typed_gaps: buildTypedGaps(gaps, scores, config, segmentEvidence, status, detail),
    segment_evidence: segmentEvidence,
  };
}

// ---------- evidence exhaustion (D-059) ----------

/**
 * The per-target harvest ledger (analysis/harvest-history.json, D-059), the
 * persistent memory of how many consecutive weeks each (mechanism × segment)
 * harvest came back low-novelty. Absent (or malformed) → null, so exhaustion
 * simply never fires: a fresh repo harvests normally until the ledger fills.
 */
function loadHarvestHistory(): HarvestHistory | null {
  if (!existsSync(HARVEST_HISTORY)) return null;
  try {
    return JSON.parse(readFileSync(HARVEST_HISTORY, "utf-8")) as HarvestHistory;
  } catch {
    console.log(
      `  · ${rel(HARVEST_HISTORY)} is unreadable — skipping exhaustion detection this run.`,
    );
    return null;
  }
}

/**
 * Mark a cell evidence_exhausted (D-059) when the loop should stop harvesting
 * it: it still has a scored harvest gap below threshold AND every one of its
 * pack's mechanisms has been low-novelty for ≥ K consecutive weeks in the
 * ledger. The cell keeps its computed scores/status — exhaustion is an honest
 * "best available", not a status flip — and records the best-achievable harvest
 * scores plus the effort spent proving the literature thin. Reversible: a novel
 * harvest resets a mechanism's streak, so the next analyze drops the flag.
 * Returns the cell unchanged when the ledger/config say it is still harvestable.
 */
function applyExhaustion(
  cell: SufficiencyCell,
  memberIds: string[],
  history: HarvestHistory | null,
  k: number | undefined,
): SufficiencyCell {
  if (!history || !k || cell.status === "green" || memberIds.length === 0) return cell;
  // Mirror the gap planner: only a SCORED harvest gap makes a cell harvestable,
  // so only such a cell can be "exhausted" of harvesting (the segment_evidence
  // pseudo-gap alone never queues a harvest, D-056).
  const hasScoredHarvestGap = cell.gaps.some(
    (c) => FIX_TYPE[c] === "harvest" && cell.scores[c] !== null,
  );
  if (!hasScoredHarvestGap) return cell;

  let lowNoveltyAttempts = 0;
  let minStreak = Number.POSITIVE_INFINITY;
  let since: string | null = null;
  for (const memberId of memberIds) {
    const target = history.entries[`${memberId}|${cell.segment}`];
    // Not exhausted unless EVERY member has crossed the K-week low-novelty bar.
    if (!target || target.low_novelty_streak < k || !target.streak_since) return cell;
    lowNoveltyAttempts += target.attempts.filter((a) => a.low_novelty).length;
    minStreak = Math.min(minStreak, target.low_novelty_streak);
    // The cell entered continuous low novelty only once its LAST member did.
    if (since === null || target.streak_since > since) since = target.streak_since;
  }
  if (since === null) return cell;

  const bestScores: Partial<SufficiencyScores> = {};
  for (const criterion of CRITERIA) {
    if (FIX_TYPE[criterion] === "harvest") bestScores[criterion] = cell.scores[criterion];
  }

  return {
    ...cell,
    evidence_exhausted: true,
    exhaustion: {
      attempts: lowNoveltyAttempts,
      weeks: minStreak,
      since,
      best_scores: bestScores,
    },
  };
}

// ---------- main ----------

/** `packs=a,b` CLI filter (D-052) — undefined means a full re-score. */
function parsePacksFilter(args: string[]): Set<string> | undefined {
  for (const arg of args) {
    if (!arg.startsWith("packs=")) {
      console.error(`  ✗ unknown argument "${arg}" — usage: npm run analyze [-- packs=a,b]`);
      process.exit(1);
    }
    const ids = arg
      .slice("packs=".length)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (ids.length === 0) {
      console.error("  ✗ packs= filter is empty — usage: npm run analyze [-- packs=a,b]");
      process.exit(1);
    }
    return new Set(ids);
  }
  return undefined;
}

/**
 * The existing matrix's cells keyed "pack|segment", for a scoped re-score to
 * preserve untouched packs from. Fails loudly when the matrix is absent —
 * a scoped run cannot invent the cells it does not re-score.
 */
function loadExistingCells(matrixPath: string): Map<string, SufficiencyCell> {
  if (!existsSync(matrixPath)) {
    console.error(
      `  ✗ scoped re-score needs an existing matrix at ${rel(matrixPath)} — run a full \`npm run analyze\` first.`,
    );
    process.exit(1);
  }
  const matrix = JSON.parse(readFileSync(matrixPath, "utf-8")) as SufficiencyMatrix;
  if (matrix.version !== MATRIX_VERSION) {
    console.error(
      `  ✗ existing matrix ${matrix.version} cannot be mixed with analyzer ${MATRIX_VERSION} — run a full \`npm run analyze\`.`,
    );
    process.exit(1);
  }
  // Gap typing (D-055): a preserved cell without typed_gaps predates the typing
  // and would leave untyped gaps in the merged matrix. Fail loudly so a scoped
  // run can never emit a partially-typed matrix.
  const untyped = matrix.cells.find((cell) => !Array.isArray(cell.typed_gaps));
  if (untyped) {
    console.error(
      `  ✗ existing matrix at ${rel(matrixPath)} predates gap typing (cell ${untyped.pack}×${untyped.segment} has no typed_gaps) — run a full \`npm run analyze\`.`,
    );
    process.exit(1);
  }
  // Row grouping (Step 6, D-067): a preserved cell without row_group predates
  // the perception row group and would leave the merged matrix half-tagged.
  // Fail loudly so a scoped run can never emit a matrix mixing tagged and
  // untagged cells — one full `npm run analyze` upgrades the whole grid.
  const untagged = matrix.cells.find((cell) => cell.row_group === undefined);
  if (untagged) {
    console.error(
      `  ✗ existing matrix at ${rel(matrixPath)} predates the perception row group (cell ${untagged.pack}×${untagged.segment} has no row_group) — run a full \`npm run analyze\`.`,
    );
    process.exit(1);
  }
  const ungrouped = matrix.cells.find(
    (cell) => !cell.group_statuses || !cell.measurements,
  );
  if (ungrouped) {
    console.error(
      `  ✗ existing matrix lacks grouped sufficiency metadata at ${ungrouped.pack}×${ungrouped.segment} — run a full \`npm run analyze\`.`,
    );
    process.exit(1);
  }
  return new Map(matrix.cells.map((cell) => [`${cell.pack}|${cell.segment}`, cell]));
}

export interface AnalyzerOptions {
  /**
   * Where the matrix is written and, for a scoped re-score, read back from.
   *
   * Defaults to the committed analysis/sufficiency-matrix.json. It is a
   * parameter so a TEST can point the analyzer at a temp directory (D-134): a
   * test that writes to a committed path leaves the working tree dirty, makes
   * `git status` an unreliable signal, and can silently commit a regenerated
   * artifact nobody chose to regenerate.
   */
  matrixPath?: string;
}

export function main(options: AnalyzerOptions = {}): void {
  const matrixPath = options.matrixPath ?? MATRIX;
  console.log("Motivation Engine sufficiency analyzer\n");

  if (!existsSync(PACK_MAP)) {
    console.error(`  ✗ no pack map at ${rel(PACK_MAP)} — nothing to score.`);
    process.exit(1);
  }
  if (!existsSync(SEGMENTS)) {
    console.error(`  ✗ no segments file at ${rel(SEGMENTS)} — nothing to score.`);
    process.exit(1);
  }

  const packsFilter = parsePacksFilter(process.argv.slice(2));

  const packMap = parseYaml(readFileSync(PACK_MAP, "utf-8")) as PackMapFile;
  const segmentsFile = parseYaml(readFileSync(SEGMENTS, "utf-8")) as SegmentsFile;
  const activeSegments = segmentsFile.segments.filter((s) => s.status === "active");

  // The perception row id is reserved (Step 6, D-067): a motivational pack may
  // not claim it, or its cells would collide with the cross-cutting row. The
  // validator gates this too, but the analyzer must never silently overwrite.
  if (packMap.elements.some((e) => e.id === PERCEPTION_ROW)) {
    console.error(
      `  ✗ pack map lists an element "${PERCEPTION_ROW}" — that id is reserved for the ` +
        "cross-cutting perception row group (D-067). Rename the pack.",
    );
    process.exit(1);
  }

  if (packsFilter) {
    // The perception row is a filterable pseudo-row alongside the packs, so a
    // scoped run can re-score just the cross-cutting row after an S7 harvest
    // (`npm run analyze -- packs=perception`) without touching the pack grid.
    const known = new Set([...packMap.elements.map((e) => e.id), PERCEPTION_ROW]);
    for (const id of Array.from(packsFilter)) {
      if (!known.has(id)) {
        console.error(`  ✗ packs= filter names unknown pack "${id}" — not in ${rel(PACK_MAP)}.`);
        process.exit(1);
      }
    }
  }
  const existingCells = packsFilter ? loadExistingCells(matrixPath) : undefined;

  const mechanisms = new Map<string, Mechanism>();
  for (const file of listJsonFiles(MECHANISMS_DIR)) {
    const m = JSON.parse(readFileSync(file, "utf-8")) as Mechanism;
    mechanisms.set(m.id, m);
  }
  const seedStubs = new Map<string, SeedStub>();
  if (existsSync(SEED_DIR)) {
    for (const file of listJsonFiles(SEED_DIR)) {
      const stub = JSON.parse(readFileSync(file, "utf-8")) as SeedStub;
      seedStubs.set(stub.id, stub);
    }
  }

  // Cross-cutting perception roster (Step 6, D-067): every full record whose L0
  // parent is flagged cross_cutting in the taxonomy (today only S7) — the SAME
  // collection render-packs emits into every pack (D-066). It is scored ONCE
  // per segment as the perception row, not multiplied into the pack rows.
  // Empty until the S7 seeds are promoted to full records (the analyzer never
  // reads _seed/), so the perception row starts honestly all-red.
  const taxonomy = JSON.parse(readFileSync(TAXONOMY, "utf-8")) as Taxonomy;
  const crossCuttingL0 = new Set(
    taxonomy.nodes.filter((n) => n.cross_cutting).map((n) => n.id),
  );
  const crossCuttingRoster = Array.from(mechanisms.values())
    .filter((m) => crossCuttingL0.has(m.parent))
    .sort((a, b) => a.id.localeCompare(b.id));
  const crossCuttingIds = crossCuttingRoster.map((m) => m.id);

  const dossiers = new Map<string, Dossier>();
  for (const file of listJsonFiles(DOSSIERS_DIR)) {
    if (file.endsWith("dossier.schema.json")) continue;
    const dossier = JSON.parse(readFileSync(file, "utf-8")) as Dossier;
    dossiers.set(dossier.mechanism_id, dossier);
  }

  // Owner-authored interaction records (D-057): each covers one mechanism pair
  // for interaction_coverage, in addition to registry relations. Keyed the same
  // way (pairKey) so a pair counts once regardless of relation/record overlap.
  // Malformed files fail loudly here — the validator is the gate, but the
  // analyzer must never silently score on a broken store.
  const authoredPairs = new Set<string>();
  if (existsSync(INTERACTIONS_DIR)) {
    for (const file of listJsonFiles(INTERACTIONS_DIR)) {
      if (file.endsWith("interaction.schema.json")) continue;
      const record = JSON.parse(readFileSync(file, "utf-8")) as { pair?: [string, string] };
      if (!Array.isArray(record.pair) || record.pair.length !== 2) {
        throw new Error(`interaction record ${rel(file)} has no valid pair`);
      }
      authoredPairs.add(pairKey(record.pair[0], record.pair[1]));
    }
  }

  const evidence = new Map<string, EvidenceCorpusFile>();
  for (const file of listJsonFiles(EVIDENCE_DIR)) {
    if (
      basename(file) === "manifest.json" ||
      file.endsWith(".regression.json")
    ) {
      continue;
    }
    const corpus = JSON.parse(readFileSync(file, "utf-8")) as EvidenceCorpusFile;
    evidence.set(corpus.mechanism_id, corpus);
  }
  const realizationCorpora = new Map<string, RealizationCorpusFile>();
  for (const file of listJsonFilesRecursive(REALIZATION_CORPUS_DIR)) {
    if (basename(file) !== "records.json") continue;
    const corpus = JSON.parse(readFileSync(file, "utf-8")) as RealizationCorpusFile;
    realizationCorpora.set(corpus.mechanism_id, corpus);
  }
  const expectedEvidenceSources = existsSync(EVIDENCE_MANIFEST)
    ? (
        JSON.parse(
          readFileSync(EVIDENCE_MANIFEST, "utf-8"),
        ) as CorpusManifest
      ).source_ids.length
    : 0;

  const effects = new Map<string, ArtifactSummary>();
  for (const file of listJsonFilesRecursive(EFFECTS_DIR)) {
    if (file.endsWith("effect.schema.json")) continue;
    const effect = JSON.parse(readFileSync(file, "utf-8")) as Effect;
    const summary = effects.get(effect.mechanism_id) ?? { count: 0, files: [] };
    summary.count += 1;
    summary.files.push(rel(file));
    effects.set(effect.mechanism_id, summary);
  }
  const realizations = new Map<string, ArtifactSummary>();
  for (const file of listJsonFilesRecursive(REALIZATIONS_DIR)) {
    if (file.endsWith("realization.schema.json")) continue;
    const realization = JSON.parse(readFileSync(file, "utf-8")) as Realization;
    const summary = realizations.get(realization.mechanism_id) ?? {
      count: 0,
      files: [],
    };
    summary.count += 1;
    summary.files.push(rel(file));
    realizations.set(realization.mechanism_id, summary);
  }
  const readerCoverage = existsSync(READER_COVERAGE)
    ? (JSON.parse(readFileSync(READER_COVERAGE, "utf-8")) as ReaderCoverageFile)
    : null;
  const knowledge: AnalyzerKnowledge = {
    evidence,
    realizationCorpora,
    expectedEvidenceSources,
    effects,
    realizations,
    readerCoverage,
  };

  const { config, bootstrapSegmentIds } = loadConfig(
    activeSegments.map((s) => s.id),
    new Set(mechanisms.keys()),
  );
  if (bootstrapSegmentIds.size > 0) {
    for (const segmentId of Array.from(bootstrapSegmentIds)) {
      console.log(
        `  · segment "${segmentId}" unconfigured — enters the matrix all-red; ` +
          "add segment_stages / segment_affinity when ready (D-054).",
      );
    }
  }

  // Evidence exhaustion (D-059): the per-target harvest ledger + the K knob.
  // Absent ledger/config → exhaustion never fires (fresh-repo behavior).
  const harvestHistory = loadHarvestHistory();
  const exhaustionK = config.exhaustion?.low_novelty_attempts;

  const cells: SufficiencyCell[] = [];
  const statusCounts: Record<SufficiencyStatus, number> = { red: 0, amber: 0, green: 0 };
  let generalOnly = 0;
  let exhausted = 0;
  let rescored = 0;
  let candidatePending = 0;

  for (const element of packMap.elements) {
    // Scoped run: an unfiltered pack keeps its existing cells verbatim; only
    // the filtered packs are re-scored. Pack-map order is preserved either way.
    if (packsFilter && !packsFilter.has(element.id)) {
      for (const segment of activeSegments) {
        const existing = existingCells?.get(`${element.id}|${segment.id}`);
        if (!existing) {
          console.error(
            `  ✗ existing matrix has no cell ${element.id}×${segment.id} — the grid changed; run a full \`npm run analyze\`.`,
          );
          process.exit(1);
        }
        cells.push(existing);
        statusCounts[existing.status] += 1;
        if (existing.segment_evidence === "general_only") generalOnly += 1;
        if (existing.evidence_exhausted) exhausted += 1;
        if ((existing.candidate_members?.length ?? 0) > 0) candidatePending += 1;
      }
      continue;
    }
    const members: Mechanism[] = [];
    const candidateMembers: SeedStub[] = [];
    for (const id of element.mechanisms) {
      const mechanism = mechanisms.get(id);
      if (mechanism) {
        members.push(mechanism);
        continue;
      }
      const candidate = seedStubs.get(id);
      if (candidate) {
        candidateMembers.push(candidate);
        continue;
      }
      throw new Error(`pack "${element.id}" references unknown mechanism "${id}"`);
    }
    for (const segment of activeSegments) {
      const base = bootstrapSegmentIds.has(segment.id)
        ? bootstrapCell(element.id, segment.id, config, "pack")
        : scoreCell(
            element.id,
            segment.id,
            members,
            dossiers,
            config,
            authoredPairs,
            "pack",
            knowledge,
          );
      const scored = applyCandidatePendency(base, candidateMembers);
      const cell =
        candidateMembers.length > 0
          ? scored
          : applyExhaustion(scored, element.mechanisms, harvestHistory, exhaustionK);
      cells.push(cell);
      statusCounts[cell.status] += 1;
      if (cell.segment_evidence === "general_only") generalOnly += 1;
      if (cell.evidence_exhausted) exhausted += 1;
      if ((cell.candidate_members?.length ?? 0) > 0) candidatePending += 1;
    }
    rescored += 1;
    console.log(`  ✓ ${element.id} scored across ${activeSegments.length} segments`);
  }

  // ---------- perception row group (Step 6, D-067) ----------
  // Score the cross-cutting roster ONCE per segment as the single perception
  // row, instead of multiplying it into all 11 pack rows. Its gaps are typed by
  // the SAME fix_type logic as the packs (harvest vs structural). When the
  // roster is empty (today: S7 still seed-only) the row is an honest all-red
  // bootstrap row — every criterion unmeasured and typed as a gap — rather than the
  // vacuous greens an empty member list would score (interaction/freshness = 1).
  const perceptionStatusCounts: Record<SufficiencyStatus, number> = { red: 0, amber: 0, green: 0 };
  let perceptionRescored = false;
  if (packsFilter && !packsFilter.has(PERCEPTION_ROW)) {
    // Scoped run not touching perception: preserve its cells verbatim.
    for (const segment of activeSegments) {
      const existing = existingCells?.get(`${PERCEPTION_ROW}|${segment.id}`);
      if (!existing) {
        console.error(
          `  ✗ existing matrix has no cell ${PERCEPTION_ROW}×${segment.id} — the grid changed; run a full \`npm run analyze\`.`,
        );
        process.exit(1);
      }
      cells.push(existing);
      perceptionStatusCounts[existing.status] += 1;
      if (existing.segment_evidence === "general_only") generalOnly += 1;
      if (existing.evidence_exhausted) exhausted += 1;
    }
  } else {
    for (const segment of activeSegments) {
      const scored =
        bootstrapSegmentIds.has(segment.id) || crossCuttingRoster.length === 0
          ? bootstrapCell(PERCEPTION_ROW, segment.id, config, "perception")
          : scoreCell(
              PERCEPTION_ROW,
              segment.id,
              crossCuttingRoster,
              dossiers,
              config,
              authoredPairs,
              "perception",
              knowledge,
            );
      const cell = applyExhaustion(scored, crossCuttingIds, harvestHistory, exhaustionK);
      cells.push(cell);
      perceptionStatusCounts[cell.status] += 1;
      if (cell.segment_evidence === "general_only") generalOnly += 1;
      if (cell.evidence_exhausted) exhausted += 1;
    }
    perceptionRescored = true;
    console.log(
      `  ✓ ${PERCEPTION_ROW} scored across ${activeSegments.length} segments ` +
        `(${crossCuttingRoster.length} cross-cutting mechanism${crossCuttingRoster.length === 1 ? "" : "s"})`,
    );
  }

  const matrix: SufficiencyMatrix = {
    version: MATRIX_VERSION,
    generated_at: new Date().toISOString(),
    config_version: config.version,
    maturity_stage: config.maturity_stage,
    thresholds: activeThresholds(config),
    cells,
  };

  mkdirSync(dirname(matrixPath), { recursive: true });
  writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf-8");

  const scope = packsFilter
    ? `${rescored} of ${packMap.elements.length} packs re-scored (packs= filter), rest preserved`
    : `${packMap.elements.length} packs`;
  // D-102: the matrix holds two legitimate populations and only one of them is
  // the pack figure /maturation reports. Naming both here is what stops the
  // tool and the screen from looking as if they disagree about a shared fact.
  const packCellCount = cells.filter(
    (cell) => (cell.row_group ?? "pack") === "pack",
  ).length;
  const perceptionCellCount = cells.length - packCellCount;
  console.log(
    `\nOK — ${cells.length} cells = ${packCellCount} pack (${scope}) + ${perceptionCellCount} perception ` +
      `(cross-cutting row × ${activeSegments.length} segments, D-067) → ${rel(matrixPath)}.`,
  );
  console.log(
    `     stage: ${config.maturity_stage} (D-060); ` +
      `pack status: ${statusCounts.green} green / ${statusCounts.amber} amber / ${statusCounts.red} red; ` +
      `${generalOnly} cell${generalOnly === 1 ? "" : "s"} on general evidence only; ` +
      `${candidatePending} candidate-pending cell${candidatePending === 1 ? "" : "s"}.`,
  );
  // Perception is reported apart from pack coverage (D-067): the cross-cutting
  // row is scored once per segment, never counted 11 times, so it never
  // inflates or deflates the pack overall-green figure.
  console.log(
    `     perception row (D-067): ${activeSegments.length} cells — ` +
      `${perceptionStatusCounts.green} green / ${perceptionStatusCounts.amber} amber / ${perceptionStatusCounts.red} red ` +
      `(${crossCuttingRoster.length} cross-cutting mechanism${crossCuttingRoster.length === 1 ? "" : "s"}${perceptionRescored ? "" : ", preserved"}); ` +
      "scored as its own row group, cross-cutting knowledge is not counted 11 times.",
  );
  if (exhaustionK) {
    console.log(
      `     ${exhausted} cell${exhausted === 1 ? "" : "s"} evidence-exhausted (thin literature, ` +
        `≥${exhaustionK} low-novelty weeks per mechanism, D-059) — surfaced honestly, dropped from the harvest queue.`,
    );
  }
}

if (require.main === module) main();

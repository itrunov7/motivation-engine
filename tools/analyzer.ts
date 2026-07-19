/**
 * tools/analyzer.ts — sufficiency scoring per [pack × segment] cell (D-050).
 *
 * For every pack-map element (/packs/pack-map.yaml, D-048) × every ACTIVE
 * segment (/segments/segments.yaml, D-047), computes whether the knowledge is
 * mature: 5 criteria scored 0–1 against the registry
 * (/registry/mechanisms/*.json) + dossiers (/dossiers/*.json), plus an
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
 * The five criteria:
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
 * five criteria, status red, all criteria as gaps, segment_evidence
 * general_only. Nothing is demonstrated FOR this segment yet, so red is the
 * truthful state, and the maximal gap_size pushes it to the top of the gap
 * planner's queue — the segment starts maturing through the loop. The owner
 * graduates it from bootstrap to configured by adding segment_stages (and
 * optionally segment_affinity), at which point it scores on the real criteria.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AnalyzerConfig,
  Dossier,
  EvidenceGrade,
  FunnelStage,
  GapFixType,
  GradeLetter,
  Mechanism,
  PackMapFile,
  SegmentsFile,
  SufficiencyCell,
  SufficiencyCriterion,
  SufficiencyMatrix,
  SufficiencyScores,
  SufficiencyStatus,
  SufficiencyThreshold,
  TypedGap,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const MECHANISMS_DIR = join(ROOT, "registry", "mechanisms");
const DOSSIERS_DIR = join(ROOT, "dossiers");
const INTERACTIONS_DIR = join(ROOT, "interactions");
const PACK_MAP = join(ROOT, "packs", "pack-map.yaml");
const SEGMENTS = join(ROOT, "segments", "segments.yaml");
const ANALYSIS_DIR = join(ROOT, "analysis");
const CONFIG = join(ANALYSIS_DIR, "analyzer.config.yaml");
const MATRIX = join(ANALYSIS_DIR, "sufficiency-matrix.json");

const MATRIX_VERSION = "0.2.0";

const CRITERIA: SufficiencyCriterion[] = [
  "dissent_completeness",
  "grade_sufficiency",
  "interaction_coverage",
  "context_coverage",
  "freshness",
];

/**
 * Gap typing (D-055): every failing criterion is labeled by what can actually
 * close it. harvest gaps are closed by fetching more/better evidence through
 * the connector; structural gaps are closed only by owner edits in git —
 * registry relations, pack composition, dossier dissent — and NO harvest can
 * touch them. The maturation loop must never dispatch a harvest against a
 * structural gap. dissent_completeness is structural: dossier dissent is
 * owner-authored (rule 8), so no fetch can fill it.
 */
const FIX_TYPE: Record<SufficiencyCriterion, GapFixType> = {
  dissent_completeness: "structural",
  grade_sufficiency: "harvest",
  interaction_coverage: "structural",
  context_coverage: "structural",
  freshness: "harvest",
};

/** What would close each criterion's gap — the fix that stops the wheel spinning. */
const WHAT_WOULD_CLOSE_IT: Record<SufficiencyCriterion, string> = {
  dissent_completeness:
    "dissent text in the member dossiers (owner-authored, git)",
  grade_sufficiency:
    "higher-grade evidence for the pack's weak mechanisms (harvest, then owner re-grade)",
  interaction_coverage:
    "registry relations between the pack's member mechanisms (owner edit, git)",
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

  if (!GRADE_ORDER.includes(config.min_context_grade)) {
    problems.push(`min_context_grade "${config.min_context_grade}" is not a grade`);
  }

  const thresholdEntries = Object.entries(config.thresholds ?? {});
  if (!config.thresholds?.default) {
    problems.push("thresholds.default is required");
  }
  for (const [name, threshold] of thresholdEntries) {
    if (name !== "default" && !CRITERIA.includes(name as SufficiencyCriterion)) {
      problems.push(`thresholds.${name} is not a sufficiency criterion`);
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
      problems.push(`thresholds.${name} must satisfy 0 ≤ amber ≤ green ≤ 1`);
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

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${rel(CONFIG)}: ${problem}`);
    process.exit(1);
  }
  return { config, bootstrapSegmentIds };
}

/**
 * An honest all-red bootstrap cell for an active segment the owner has added
 * to segments.yaml but not yet configured in segment_stages (D-054): every
 * criterion scores 0, so the cell is red on all five and general_only. Nothing
 * is demonstrated for this segment yet, so red is the truthful state and the
 * maximal gap feeds the segment straight into the maturation loop.
 */
function bootstrapCell(packId: string, segmentId: string, config: AnalyzerConfig): SufficiencyCell {
  const scores = Object.fromEntries(
    CRITERIA.map((criterion) => [criterion, 0]),
  ) as SufficiencyScores;
  const gaps = [...CRITERIA];
  return {
    pack: packId,
    segment: segmentId,
    scores,
    status: "red",
    gaps,
    typed_gaps: buildTypedGaps(gaps, scores, config, "general_only", "red"),
    segment_evidence: "general_only",
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

function thresholdFor(config: AnalyzerConfig, criterion: SufficiencyCriterion): SufficiencyThreshold {
  return config.thresholds[criterion] ?? config.thresholds.default;
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

function scoreCell(
  packId: string,
  segmentId: string,
  members: Mechanism[],
  dossiers: Map<string, Dossier>,
  config: AnalyzerConfig,
  authoredPairs: Set<string>,
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

  const scores: SufficiencyScores = {
    dissent_completeness: round(dissentShare),
    grade_sufficiency: round(
      weightedMean(contexts, (m) => config.grade_weights[gradeLetter(m.mechanism.evidence.grade)]),
    ),
    interaction_coverage: round(interaction.coverage),
    context_coverage: round(context.coverage),
    freshness: round(1 - weightedMean(contexts, (m) => (m.replicationFlagged ? 1 : 0))),
  };

  let status: SufficiencyStatus = "green";
  const gaps: SufficiencyCriterion[] = [];
  for (const criterion of CRITERIA) {
    const criterionStatus = statusFor(scores[criterion], thresholdFor(config, criterion));
    if (criterionStatus !== "green") gaps.push(criterion);
    if (STATUS_RANK[criterionStatus] > STATUS_RANK[status]) status = criterionStatus;
  }

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
    scores,
    status,
    gaps,
    typed_gaps: buildTypedGaps(gaps, scores, config, segmentEvidence, status, detail),
    segment_evidence: segmentEvidence,
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
function loadExistingCells(): Map<string, SufficiencyCell> {
  if (!existsSync(MATRIX)) {
    console.error(
      `  ✗ scoped re-score needs an existing matrix at ${rel(MATRIX)} — run a full \`npm run analyze\` first.`,
    );
    process.exit(1);
  }
  const matrix = JSON.parse(readFileSync(MATRIX, "utf-8")) as SufficiencyMatrix;
  // Gap typing (D-055): a preserved cell without typed_gaps predates the typing
  // and would leave untyped gaps in the merged matrix. Fail loudly so a scoped
  // run can never emit a partially-typed matrix.
  const untyped = matrix.cells.find((cell) => !Array.isArray(cell.typed_gaps));
  if (untyped) {
    console.error(
      `  ✗ existing matrix at ${rel(MATRIX)} predates gap typing (cell ${untyped.pack}×${untyped.segment} has no typed_gaps) — run a full \`npm run analyze\`.`,
    );
    process.exit(1);
  }
  return new Map(matrix.cells.map((cell) => [`${cell.pack}|${cell.segment}`, cell]));
}

function main(): void {
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

  if (packsFilter) {
    const known = new Set(packMap.elements.map((e) => e.id));
    for (const id of Array.from(packsFilter)) {
      if (!known.has(id)) {
        console.error(`  ✗ packs= filter names unknown pack "${id}" — not in ${rel(PACK_MAP)}.`);
        process.exit(1);
      }
    }
  }
  const existingCells = packsFilter ? loadExistingCells() : undefined;

  const mechanisms = new Map<string, Mechanism>();
  for (const file of listJsonFiles(MECHANISMS_DIR)) {
    const m = JSON.parse(readFileSync(file, "utf-8")) as Mechanism;
    mechanisms.set(m.id, m);
  }

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

  const cells: SufficiencyCell[] = [];
  const statusCounts: Record<SufficiencyStatus, number> = { red: 0, amber: 0, green: 0 };
  let generalOnly = 0;
  let rescored = 0;

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
      }
      continue;
    }
    const members = element.mechanisms.map((id) => {
      const m = mechanisms.get(id);
      if (!m) throw new Error(`pack "${element.id}" references unknown mechanism "${id}"`);
      return m;
    });
    for (const segment of activeSegments) {
      const cell = bootstrapSegmentIds.has(segment.id)
        ? bootstrapCell(element.id, segment.id, config)
        : scoreCell(element.id, segment.id, members, dossiers, config, authoredPairs);
      cells.push(cell);
      statusCounts[cell.status] += 1;
      if (cell.segment_evidence === "general_only") generalOnly += 1;
    }
    rescored += 1;
    console.log(`  ✓ ${element.id} scored across ${activeSegments.length} segments`);
  }

  const matrix: SufficiencyMatrix = {
    version: MATRIX_VERSION,
    generated_at: new Date().toISOString(),
    config_version: config.version,
    cells,
  };

  mkdirSync(ANALYSIS_DIR, { recursive: true });
  writeFileSync(MATRIX, `${JSON.stringify(matrix, null, 2)}\n`, "utf-8");

  const scope = packsFilter
    ? `${rescored} of ${packMap.elements.length} packs re-scored (packs= filter), rest preserved`
    : `${packMap.elements.length} packs`;
  console.log(
    `\nOK — ${cells.length} cells (${scope} × ${activeSegments.length} segments) → ${rel(MATRIX)}.`,
  );
  console.log(
    `     status: ${statusCounts.green} green / ${statusCounts.amber} amber / ${statusCounts.red} red; ` +
      `${generalOnly} cell${generalOnly === 1 ? "" : "s"} on general evidence only.`,
  );
}

main();

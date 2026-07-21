/**
 * tools/gap-planner.ts — rank the sufficiency matrix's red/amber cells into a
 * budget-bounded queue of targeted, segment-qualified evidence harvests (D-051).
 *
 * Input:  analysis/sufficiency-matrix.json (npm run analyze, D-050) — the
 *         pack × segment matrix. The ONE hand-authored input is the
 *         gap_planner block of analysis/analyzer.config.yaml (segment weights,
 *         segment qualifiers, budget knobs).
 * Output: analysis/research-queue.json    — harvest tasks (COMPUTED, never hand-edited)
 *         analysis/authoring-queue.json   — structural tasks for the owner (same)
 *
 * The essence: turn red cells into a RANKED, BUDGETED queue of targeted
 * harvests, not "research everything".
 *
 * - ROUTING BY FIX_TYPE (D-055/D-056): a cell's gaps are typed harvest vs
 *   structural. Only HARVEST gaps (grade_sufficiency, freshness, the
 *   segment_evidence flag) can be closed by fetching evidence; STRUCTURAL gaps
 *   (interaction_coverage, context_coverage, dissent_completeness) close only
 *   by owner edits in git. So harvest gaps → research-queue.json (consume
 *   budget, dispatch connectors); structural gaps → authoring-queue.json
 *   (owner-facing, per pack×segment, ranked by importance, NEVER harvested).
 *   A cell whose scored gaps are ALL structural is never harvested — no amount
 *   of segment-qualified evidence flips it, so harvesting it is pure budget
 *   burn. The segment_evidence flag alone does NOT make a cell harvestable.
 * - SATURATION: only red/amber cells are queued; a green cell is saturated and
 *   never appears.
 * - RANKING: importance = segment_weight × gap_size, where
 *     gap_size = Σ over the cell's failed criteria of (green_threshold − score)
 *   so a deep red cell in a high-weight segment rises to the top.
 * - EXPANSION: each cell expands to its pack's mechanisms; a task targets one
 *   (mechanism, segment) pair, deduped across packs (highest-importance wins),
 *   ordered weakest-mechanism-first inside a tie.
 * - TERMS: a task's suggested_evidence_terms are the mechanism's OWN evidence
 *   terms (registry, D-015) qualified with the segment's vocabulary — no
 *   invented science, and they drop straight onto the evidence connector's
 *   `terms=` override (npm run connector -- evidence mechanism=... terms=...).
 * - BUDGET: the queue length N is bounded by the SAME monthly cap system the
 *   /ops gate uses (computeBudgetSnapshot) — this planner never bypasses it and
 *   never triggers a run; each queued task is still gated per-run at harvest.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { computeBudgetSnapshot } from "../lib/ops";
import type {
  AuthoringQueue,
  AuthoringTask,
  EvidenceGrade,
  GapPlannerConfig,
  MaturityStage,
  Mechanism,
  PackMapFile,
  ResearchGapCell,
  ResearchQueue,
  ResearchTask,
  SegmentsFile,
  StageThresholds,
  SufficiencyCell,
  SufficiencyCriterion,
  SufficiencyMatrix,
  SufficiencyStatus,
  Taxonomy,
  TypedGap,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const MECHANISMS_DIR = join(ROOT, "registry", "mechanisms");
const TAXONOMY = join(ROOT, "registry", "taxonomy.json");
const EVIDENCE_DIR = join(ROOT, "corpora", "evidence");
const PACK_MAP = join(ROOT, "packs", "pack-map.yaml");
const SEGMENTS = join(ROOT, "segments", "segments.yaml");

/** Reserved row id of the cross-cutting perception row group (Step 6, D-067). */
const PERCEPTION_ROW = "perception";
const ANALYSIS_DIR = join(ROOT, "analysis");
const CONFIG = join(ANALYSIS_DIR, "analyzer.config.yaml");
const MATRIX = join(ANALYSIS_DIR, "sufficiency-matrix.json");
const QUEUE = join(ANALYSIS_DIR, "research-queue.json");
const AUTHORING_QUEUE = join(ANALYSIS_DIR, "authoring-queue.json");

const QUEUE_VERSION = "0.1.0";
const AUTHORING_QUEUE_VERSION = "0.1.0";

/** Strong → weak; a higher index is a WEAKER grade (mirrors the analyzer). */
const GRADE_ORDER: EvidenceGrade[] = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];

/** A flagged mechanism sorts weakest-first regardless of its grade. */
const REPLICATION_FLAG_BUMP = 100;

/** Cap on qualified terms per task — keeps a harvest targeted, not exhaustive. */
const MAX_TERMS_PER_TASK = 3;

/** Ranking status order: red before amber (green is never queued). */
const QUEUE_STATUS_ORDER: Record<Exclude<SufficiencyStatus, "green">, number> = {
  red: 0,
  amber: 1,
};

/** The shape of analyzer.config.yaml we read: stage thresholds + the gap_planner block. */
interface AnalyzerConfigFile {
  version: string;
  /** Active maturity stage (D-060) selecting which stage_thresholds size gaps. */
  maturity_stage: MaturityStage;
  stage_thresholds: Record<MaturityStage, StageThresholds>;
  /** Segment → funnel stages; a segment absent here is a bootstrap segment (D-054). */
  segment_stages?: Record<string, unknown>;
  replication_flags?: string[];
  gap_planner?: GapPlannerConfig;
}

/**
 * Segment evolution (D-054): a bootstrap segment (owner-added, not yet in
 * segment_stages) gets its harvest qualifier derived mechanically from its own
 * id — hyphens become spaces (e.g. "ai-agent-tools" → "ai agent tools"). This
 * is product vocabulary taken straight from the owner's own slug, never
 * invented science, so a freshly-added segment still produces targeted tasks
 * before the owner hand-tunes gap_planner.segment_qualifiers.
 */
function qualifierFromId(segmentId: string): string {
  return segmentId.split("-").join(" ").trim();
}

function rel(path: string): string {
  return relative(ROOT, path);
}

function fail(message: string): never {
  console.error(`  ✗ ${message}`);
  process.exit(1);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

// ---------- loading + loud validation ----------

function loadMatrix(): SufficiencyMatrix {
  if (!existsSync(MATRIX)) {
    fail(`no sufficiency matrix at ${rel(MATRIX)} — run \`npm run analyze\` first.`);
  }
  const matrix = JSON.parse(readFileSync(MATRIX, "utf-8")) as SufficiencyMatrix;
  if (!Array.isArray(matrix.cells) || matrix.cells.length === 0) {
    fail(`${rel(MATRIX)} has no cells — re-run \`npm run analyze\`.`);
  }
  return matrix;
}

function loadGapPlannerConfig(
  neededSegments: Set<string>,
  activeSegmentIds: Set<string>,
): { file: AnalyzerConfigFile; gp: GapPlannerConfig; qualifiers: Record<string, string> } {
  if (!existsSync(CONFIG)) {
    fail(`no analyzer config at ${rel(CONFIG)} — nothing to plan from.`);
  }
  const file = parseYaml(readFileSync(CONFIG, "utf-8")) as AnalyzerConfigFile;
  const gp = file.gap_planner;
  const problems: string[] = [];

  // Bootstrap segments (D-054): active, but with no segment_stages entry — the
  // same set the analyzer scores all-red. Their missing qualifier is derived
  // from the id, not a loud failure.
  const configuredStages = new Set(Object.keys(file.segment_stages ?? {}));
  const bootstrapSegmentIds = new Set(
    Array.from(activeSegmentIds).filter((id) => !configuredStages.has(id)),
  );

  if (!file.stage_thresholds?.[file.maturity_stage]?.default) {
    problems.push(
      `stage_thresholds.${file.maturity_stage}.default is required to size gaps (D-060)`,
    );
  }
  if (!gp) {
    fail(`${rel(CONFIG)}: gap_planner block is missing — add it (see the file header).`);
  }

  if (typeof gp.version !== "string" || gp.version.length === 0) {
    problems.push("gap_planner.version must be a non-empty string");
  }

  const budget = gp.budget;
  if (!budget || typeof budget !== "object") {
    problems.push("gap_planner.budget is required");
  } else {
    if (!Number.isInteger(budget.max_tasks) || budget.max_tasks < 1) {
      problems.push("gap_planner.budget.max_tasks must be an integer ≥ 1");
    }
    if (!Number.isInteger(budget.estimated_calls_per_task) || budget.estimated_calls_per_task < 1) {
      problems.push("gap_planner.budget.estimated_calls_per_task must be an integer ≥ 1");
    }
    if (
      typeof budget.monthly_budget_share !== "number" ||
      budget.monthly_budget_share <= 0 ||
      budget.monthly_budget_share > 1
    ) {
      problems.push("gap_planner.budget.monthly_budget_share must be a number in (0, 1]");
    }
  }

  // Weights are optional per segment but, when present, must name a real active
  // segment and be a positive number — a typo shouldn't silently vanish.
  for (const [segmentId, weight] of Object.entries(gp.segment_weights ?? {})) {
    if (!activeSegmentIds.has(segmentId)) {
      problems.push(`gap_planner.segment_weights entry "${segmentId}" is not an active segment`);
    }
    if (typeof weight !== "number" || weight <= 0) {
      problems.push(`gap_planner.segment_weights.${segmentId} must be a positive number`);
    }
  }

  // A qualifier is REQUIRED for every segment that actually surfaces a gap. A
  // CONFIGURED segment missing one is still a loud failure (typo guard); a
  // BOOTSTRAP segment falls back to its id-derived qualifier so the just-added
  // segment still gets targeted tasks (D-054). The effective qualifier map is
  // the config's plus those fallbacks.
  const qualifiers: Record<string, string> = { ...(gp.segment_qualifiers ?? {}) };
  for (const [segmentId, qualifier] of Object.entries(qualifiers)) {
    if (!activeSegmentIds.has(segmentId)) {
      problems.push(`gap_planner.segment_qualifiers entry "${segmentId}" is not an active segment`);
    }
    if (typeof qualifier !== "string" || qualifier.trim().length === 0) {
      problems.push(`gap_planner.segment_qualifiers.${segmentId} must be a non-empty string`);
    }
  }
  for (const segmentId of Array.from(neededSegments)) {
    const qualifier = qualifiers[segmentId];
    if (typeof qualifier === "string" && qualifier.trim().length > 0) continue;
    if (bootstrapSegmentIds.has(segmentId)) {
      qualifiers[segmentId] = qualifierFromId(segmentId);
      console.log(
        `  · segment "${segmentId}" unconfigured — qualifier derived from id ` +
          `("${qualifiers[segmentId]}"); add gap_planner.segment_qualifiers when ready (D-054).`,
      );
      continue;
    }
    problems.push(
      `gap_planner.segment_qualifiers has no entry for "${segmentId}", which has red/amber gaps`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${rel(CONFIG)}: ${problem}`);
    process.exit(1);
  }
  return { file, gp, qualifiers };
}

// ---------- ranking ----------

function greenThreshold(file: AnalyzerConfigFile, criterion: SufficiencyCriterion): number {
  const active = file.stage_thresholds[file.maturity_stage];
  return (active[criterion] ?? active.default).green;
}

/** Σ over the given failed criteria of (green_threshold − score), floored at 0. */
function gapSize(
  cell: SufficiencyCell,
  file: AnalyzerConfigFile,
  criteria: SufficiencyCriterion[],
): number {
  return criteria.reduce((sum, criterion) => {
    const score = cell.scores[criterion];
    // Unknown is prioritized for measurement, but remains null in every
    // artifact and explanation — it is never represented as a measured zero.
    const distance =
      score === null
        ? greenThreshold(file, criterion)
        : greenThreshold(file, criterion) - score;
    return sum + Math.max(0, distance);
  }, 0);
}

// ---------- routing by fix_type (D-055/D-056) ----------

/**
 * The cell's SCORED harvest gaps — failed criteria whose typed fix_type is
 * harvest (grade_sufficiency, freshness). The segment_evidence flag is a
 * harvest gap too but is NOT a scored criterion, so it never appears here and
 * cannot, on its own, make a cell harvestable.
 */
function harvestCriteria(cell: SufficiencyCell): SufficiencyCriterion[] {
  const harvestTyped = new Set(
    cell.typed_gaps
      .filter((g) => g.fix_type === "harvest" && g.criterion !== "segment_evidence")
      .map((g) => g.criterion as SufficiencyCriterion),
  );
  return cell.gaps.filter((criterion) => harvestTyped.has(criterion));
}

/** A cell is harvestable iff it has ≥1 scored harvest gap (see harvestCriteria). */
function isHarvestable(cell: SufficiencyCell): boolean {
  return harvestCriteria(cell).length > 0;
}

/** The cell's structural typed gaps (interaction/context/dissent), detail intact. */
function structuralGaps(cell: SufficiencyCell): TypedGap[] {
  return cell.typed_gaps.filter((g) => g.fix_type === "structural");
}

/** Σ over the cell's structural gaps of (threshold − value), floored at 0. */
function structuralGapSize(cell: SufficiencyCell): number {
  return structuralGaps(cell).reduce(
    (sum, g) => sum + Math.max(0, g.threshold - (g.value ?? 0)),
    0,
  );
}

interface Candidate {
  mechanism: string;
  segment: string;
  importance: number;
  /** Higher = weaker mechanism; a tie-break so weak evidence is harvested first. */
  weakness: number;
  status: Exclude<SufficiencyStatus, "green">;
  generalOnly: boolean;
  cell: SufficiencyCell;
}

/**
 * Deterministic queue order: importance desc → red before amber →
 * general_only before segment_specific → weaker mechanism first →
 * stable by (pack, mechanism).
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (b.importance !== a.importance) return b.importance - a.importance;
  if (QUEUE_STATUS_ORDER[a.status] !== QUEUE_STATUS_ORDER[b.status]) {
    return QUEUE_STATUS_ORDER[a.status] - QUEUE_STATUS_ORDER[b.status];
  }
  if (a.generalOnly !== b.generalOnly) return a.generalOnly ? -1 : 1;
  if (b.weakness !== a.weakness) return b.weakness - a.weakness;
  if (a.cell.pack !== b.cell.pack) return a.cell.pack < b.cell.pack ? -1 : 1;
  return a.mechanism < b.mechanism ? -1 : 1;
}

// ---------- task construction ----------

function suggestedTerms(mechanism: Mechanism, qualifier: string): string[] {
  const base =
    mechanism.evidence_terms && mechanism.evidence_terms.length > 0
      ? mechanism.evidence_terms
      : [mechanism.name];
  return base.slice(0, MAX_TERMS_PER_TASK).map((term) => `${term} ${qualifier}`.trim());
}

/**
 * The mechanism's last harvest terms + low-novelty flag (D-058), read from
 * corpora/evidence/{id}.json. A corpus with no diversity_report (pre-D-058) or
 * no file yields null — never skipped, so old corpora still re-harvest.
 */
function readCorpusNovelty(
  mechanismId: string,
): { terms: string[]; lowNovelty: boolean } | null {
  const path = join(EVIDENCE_DIR, `${mechanismId}.json`);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as {
      terms?: unknown;
      diversity_report?: { novelty?: { low_novelty?: unknown } };
    };
    return {
      terms: Array.isArray(data.terms) ? (data.terms as string[]) : [],
      lowNovelty: data.diversity_report?.novelty?.low_novelty === true,
    };
  } catch {
    return null;
  }
}

/** True when two term lists are the same set (order-insensitive, trimmed). */
function sameTerms(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map((t) => t.trim()).sort();
  const sb = b.map((t) => t.trim()).sort();
  return sa.every((t, i) => t === sb[i]);
}

function reasonFor(
  cell: SufficiencyCell,
  file: AnalyzerConfigFile,
  criteria: SufficiencyCriterion[],
): string {
  const failed = criteria
    .map((criterion) => {
      const score = cell.scores[criterion];
      const green = greenThreshold(file, criterion);
      return score === null
        ? `${criterion} unmeasured (needs ≥${green.toFixed(2)})`
        : `${criterion} ${score.toFixed(2)}<${green.toFixed(2)}`;
    })
    .join(", ");
  const evidenceNote =
    cell.segment_evidence === "general_only"
      ? "; segment evidence general_only (segment-specific harvest needed)"
      : "; segment_specific evidence present";
  return `${cell.status} cell ${cell.pack}×${cell.segment}: ${failed}${evidenceNote}`;
}

/**
 * Deterministic authoring-queue order: importance desc → red before amber →
 * stable by (pack, segment). One task per structural cell (not expanded to
 * mechanisms — a structural fix is an owner edit to the pack/registry, not a
 * per-mechanism harvest).
 */
function compareAuthoring(a: AuthoringTask, b: AuthoringTask): number {
  if (b.importance !== a.importance) return b.importance - a.importance;
  const sa = QUEUE_STATUS_ORDER[a.status as Exclude<SufficiencyStatus, "green">];
  const sb = QUEUE_STATUS_ORDER[b.status as Exclude<SufficiencyStatus, "green">];
  if (sa !== sb) return sa - sb;
  if (a.pack !== b.pack) return a.pack < b.pack ? -1 : 1;
  return a.segment < b.segment ? -1 : 1;
}

// ---------- main ----------

function main(): void {
  console.log("Motivation Engine gap planner\n");

  if (!existsSync(PACK_MAP)) fail(`no pack map at ${rel(PACK_MAP)}.`);
  if (!existsSync(SEGMENTS)) fail(`no segments file at ${rel(SEGMENTS)}.`);

  const matrix = loadMatrix();
  const packMap = parseYaml(readFileSync(PACK_MAP, "utf-8")) as PackMapFile;
  const segmentsFile = parseYaml(readFileSync(SEGMENTS, "utf-8")) as SegmentsFile;
  const activeSegmentIds = new Set(
    segmentsFile.segments.filter((s) => s.status === "active").map((s) => s.id),
  );

  const packMechanisms = new Map<string, string[]>();
  for (const element of packMap.elements) packMechanisms.set(element.id, element.mechanisms);

  const mechanisms = new Map<string, Mechanism>();
  for (const path of listJsonFiles(MECHANISMS_DIR)) {
    const m = JSON.parse(readFileSync(path, "utf-8")) as Mechanism;
    mechanisms.set(m.id, m);
  }

  // Perception row (Step 6, D-067): register the cross-cutting roster (full
  // records whose L0 parent is cross_cutting, today only S7 — the same set the
  // analyzer scores and render-packs emits) under the reserved perception row
  // id, so a perception cell with a scored harvest gap expands to the roster's
  // (mechanism × segment) harvest candidates once S7 has full records. Empty
  // today, so the perception row surfaces only structural/authoring gaps.
  const taxonomy = JSON.parse(readFileSync(TAXONOMY, "utf-8")) as Taxonomy;
  const crossCuttingL0 = new Set(
    taxonomy.nodes.filter((n) => n.cross_cutting).map((n) => n.id),
  );
  const crossCuttingIds = Array.from(mechanisms.values())
    .filter((m) => crossCuttingL0.has(m.parent))
    .map((m) => m.id)
    .sort((a, b) => a.localeCompare(b));
  packMechanisms.set(PERCEPTION_ROW, crossCuttingIds);

  // Only red/amber cells feed either queue; green cells are saturated.
  const gapCells = matrix.cells.filter((cell) => cell.status !== "green");

  // ROUTING (D-056): a cell is harvested only if it has a scored harvest gap.
  // A cell whose scored gaps are all structural never enters the harvest path —
  // no evidence fetch can flip it — so it neither consumes budget nor needs a
  // harvest qualifier. Qualifiers are required only for the segments we harvest.
  const harvestableByType = gapCells.filter(isHarvestable);

  // EVIDENCE EXHAUSTION (D-059): a harvestable cell the analyzer has marked
  // evidence_exhausted is dropped from the harvest path — every one of its pack
  // mechanisms has come back low-novelty for ≥K weeks, so more harvesting is
  // pure budget burn against thin literature. It is routed to owner authoring
  // instead (alternative fillers below). Never silently dropped: the removed
  // (mechanism × segment) candidates are counted in evidence_exhausted_skipped,
  // and a future novel harvest clears the streak so the cell re-enters.
  const exhaustedCells = harvestableByType.filter((cell) => cell.evidence_exhausted === true);
  const harvestableCells = harvestableByType.filter((cell) => cell.evidence_exhausted !== true);
  const neededSegments = new Set(harvestableCells.map((cell) => cell.segment));

  // Candidates removed SOLELY by exhaustion — a (mechanism × segment) still
  // reachable through a non-exhausted harvestable cell is not counted.
  const reachableKeys = new Set<string>();
  for (const cell of harvestableCells) {
    for (const m of packMechanisms.get(cell.pack) ?? []) reachableKeys.add(`${m}|${cell.segment}`);
  }
  const exhaustedKeys = new Set<string>();
  for (const cell of exhaustedCells) {
    for (const m of packMechanisms.get(cell.pack) ?? []) {
      const key = `${m}|${cell.segment}`;
      if (!reachableKeys.has(key)) exhaustedKeys.add(key);
    }
  }
  const evidenceExhaustedSkipped = exhaustedKeys.size;

  const { file, gp, qualifiers } = loadGapPlannerConfig(neededSegments, activeSegmentIds);
  const flagged = new Set(file.replication_flags ?? []);

  // HARVEST PATH — expand each harvestable cell to (mechanism, segment)
  // candidates, deduped across packs so the same segment-qualified mechanism
  // harvest is queued once, at its highest importance. Importance is sized over
  // the cell's HARVEST gaps only, so a mixed cell ranks by what a harvest can
  // actually fix.
  const byKey = new Map<string, Candidate>();
  for (const cell of harvestableCells) {
    const status = cell.status as Exclude<SufficiencyStatus, "green">;
    const weight = gp.segment_weights?.[cell.segment] ?? 1;
    const importance = round(weight * gapSize(cell, file, harvestCriteria(cell)));
    const members = packMechanisms.get(cell.pack) ?? [];
    for (const mechanismId of members) {
      const mechanism = mechanisms.get(mechanismId);
      if (!mechanism) continue; // validate.ts guarantees resolution; skip defensively.
      const weakness =
        GRADE_ORDER.indexOf(mechanism.evidence.grade) +
        (flagged.has(mechanismId) ? REPLICATION_FLAG_BUMP : 0);
      const candidate: Candidate = {
        mechanism: mechanismId,
        segment: cell.segment,
        importance,
        weakness,
        status,
        generalOnly: cell.segment_evidence === "general_only",
        cell,
      };
      const key = `${mechanismId}|${cell.segment}`;
      const existing = byKey.get(key);
      if (!existing || compareCandidates(candidate, existing) < 0) byKey.set(key, candidate);
    }
  }

  const ranked = Array.from(byKey.values()).sort(compareCandidates);

  // Budget: bound N by the SAME monthly cap system the /ops gate reads.
  const snapshot = computeBudgetSnapshot();
  const remainingCalls = snapshot.remaining.calls;
  const budgetMaxTasks = Math.floor(
    (remainingCalls * gp.budget.monthly_budget_share) / gp.budget.estimated_calls_per_task,
  );
  const effectiveMaxTasks = Math.max(0, Math.min(gp.budget.max_tasks, budgetMaxTasks));

  // Build the queue in rank order, filling up to effective_max_tasks. A
  // candidate whose mechanism's last harvest used the SAME terms and came back
  // low-novelty (D-058) is skipped BEFORE it consumes a budget slot —
  // re-fetching the same canon is not progress. It is counted, not silently
  // dropped, so the queue's shrink is explainable and reversible (change the
  // terms or the segment qualifier and it re-enters).
  const tasks: ResearchTask[] = [];
  let lowNoveltySkipped = 0;
  for (const candidate of ranked) {
    if (tasks.length >= effectiveMaxTasks) break;
    const mechanism = mechanisms.get(candidate.mechanism) as Mechanism;
    const qualifier = qualifiers[candidate.segment];
    const terms = suggestedTerms(mechanism, qualifier);

    const novelty = readCorpusNovelty(candidate.mechanism);
    if (novelty && novelty.lowNovelty && sameTerms(novelty.terms, terms)) {
      lowNoveltySkipped++;
      continue;
    }

    const gapCell: ResearchGapCell = {
      pack: candidate.cell.pack,
      segment: candidate.cell.segment,
      status: candidate.cell.status,
      gaps: candidate.cell.gaps,
      segment_evidence: candidate.cell.segment_evidence,
    };
    tasks.push({
      gap_cell: gapCell,
      mechanism: candidate.mechanism,
      segment: candidate.segment,
      importance: candidate.importance,
      suggested_evidence_terms: terms,
      reason: reasonFor(candidate.cell, file, harvestCriteria(candidate.cell)),
    });
  }

  const queue: ResearchQueue = {
    version: QUEUE_VERSION,
    generated_at: new Date().toISOString(),
    config_version: file.version,
    matrix_generated_at: matrix.generated_at,
    budget: {
      month: snapshot.month,
      monthly_remaining_calls: remainingCalls,
      monthly_budget_share: gp.budget.monthly_budget_share,
      estimated_calls_per_task: gp.budget.estimated_calls_per_task,
      budget_max_tasks: budgetMaxTasks,
      config_max_tasks: gp.budget.max_tasks,
      effective_max_tasks: effectiveMaxTasks,
    },
    candidate_count: ranked.length,
    low_novelty_skipped: lowNoveltySkipped,
    evidence_exhausted_skipped: evidenceExhaustedSkipped,
    tasks,
  };

  // STRUCTURAL PATH — every cell with ≥1 structural gap becomes an owner-facing
  // authoring task (per pack×segment, ranked by segment_weight × structural
  // gap-size). No budget, no connector: these close only by an owner edit in
  // git. The queue is always written, even empty, as an honest state.
  // An evidence-exhausted cell (D-059) is ALSO owner-facing work even when it
  // has no structural gap: its harvest gaps can no longer be closed by
  // harvesting, so the only remaining fillers are owner judgment, a cross-domain
  // analogy, or accepting it at lower confidence. Such a cell gets an authoring
  // task carrying alternative_fill + fill_options + the exhaustion summary, in
  // ADDITION to any structural gaps it also has.
  const authoringTasks: AuthoringTask[] = gapCells
    .map((cell): AuthoringTask | null => {
      const gaps = structuralGaps(cell);
      const isExhausted = cell.evidence_exhausted === true;
      if (gaps.length === 0 && !isExhausted) return null;
      const weight = gp.segment_weights?.[cell.segment] ?? 1;
      // Rank on the structural gap size; an exhausted cell with no structural
      // gap ranks on its (now unharvestable) harvest gap size instead, so it
      // still surfaces meaningfully rather than at importance 0.
      const importanceBase =
        gaps.length === 0 ? gapSize(cell, file, harvestCriteria(cell)) : structuralGapSize(cell);
      const task: AuthoringTask = {
        pack: cell.pack,
        segment: cell.segment,
        status: cell.status,
        importance: round(weight * importanceBase),
        segment_evidence: cell.segment_evidence,
        structural_gaps: gaps,
      };
      if (isExhausted) {
        task.alternative_fill = true;
        task.fill_options = ["owner_judgment", "cross_domain_analogy", "accept_lower_confidence"];
        if (cell.exhaustion) task.exhaustion = cell.exhaustion;
      }
      return task;
    })
    .filter((task): task is AuthoringTask => task !== null)
    .sort(compareAuthoring);

  const authoringQueue: AuthoringQueue = {
    version: AUTHORING_QUEUE_VERSION,
    generated_at: new Date().toISOString(),
    config_version: file.version,
    matrix_generated_at: matrix.generated_at,
    cell_count: authoringTasks.length,
    tasks: authoringTasks,
  };

  mkdirSync(ANALYSIS_DIR, { recursive: true });
  writeFileSync(QUEUE, `${JSON.stringify(queue, null, 2)}\n`, "utf-8");
  writeFileSync(AUTHORING_QUEUE, `${JSON.stringify(authoringQueue, null, 2)}\n`, "utf-8");

  const top = tasks[0];
  console.log(
    `OK — ${gapCells.length} red/amber cells → routed by fix_type: ` +
      `${harvestableCells.length} harvestable → ${ranked.length} (mechanism × segment) candidates, ` +
      `queued ${tasks.length} harvest task(s) of N=${effectiveMaxTasks} ` +
      `(config ${gp.budget.max_tasks} / budget ${budgetMaxTasks}; ` +
      `${remainingCalls} monthly calls remaining` +
      `${lowNoveltySkipped > 0 ? `; ${lowNoveltySkipped} low-novelty repeat(s) skipped, D-058` : ""}` +
      `${evidenceExhaustedSkipped > 0 ? `; ${evidenceExhaustedSkipped} evidence-exhausted candidate(s) skipped, D-059` : ""}) → ${rel(QUEUE)}.`,
  );
  console.log(
    `     ${authoringTasks.length} cell(s) with structural gaps → ${rel(AUTHORING_QUEUE)} ` +
      "(owner authoring, no harvest, no budget).",
  );
  if (top) {
    console.log(
      `     top harvest: ${top.mechanism} for ${top.segment} (importance ${top.importance}) — ${top.reason}`,
    );
  }
  const topStructural = authoringTasks[0];
  if (topStructural) {
    const gapNames = topStructural.structural_gaps.map((g) => g.criterion).join(", ");
    console.log(
      `     top structural: ${topStructural.pack}×${topStructural.segment} ` +
        `(importance ${topStructural.importance}) — ${gapNames}`,
    );
  }
  // Decision log (D-056): the routing policy this pair of queues encodes.
  console.log(
    "\n     loop routes by fix_type; structural gaps go to an authoring queue, not the API. " +
      "Harvest gaps prioritized by segment-weight × gap-size, budget-bounded; saturated cells excluded.",
  );
  // Decision log (D-059): evidence exhaustion is detected and surfaced honestly;
  // the loop never harvests indefinitely against thin literature.
  if (exhaustedCells.length > 0) {
    console.log(
      `     ${exhaustedCells.length} evidence-exhausted cell(s) routed to authoring for alternative fillers ` +
        "(owner judgment / cross-domain analogy / accept lower confidence). " +
        "Evidence exhaustion is detected and surfaced honestly; the loop never harvests indefinitely against thin literature.",
    );
  }
}

main();

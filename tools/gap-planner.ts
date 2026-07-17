/**
 * tools/gap-planner.ts — rank the sufficiency matrix's red/amber cells into a
 * budget-bounded queue of targeted, segment-qualified evidence harvests (D-051).
 *
 * Input:  analysis/sufficiency-matrix.json (npm run analyze, D-050) — the
 *         pack × segment matrix. The ONE hand-authored input is the
 *         gap_planner block of analysis/analyzer.config.yaml (segment weights,
 *         segment qualifiers, budget knobs).
 * Output: analysis/research-queue.json — a COMPUTED projection, never
 *         hand-edited (same pattern as the sufficiency matrix / render-cards).
 *
 * The essence: turn red cells into a RANKED, BUDGETED queue of targeted
 * harvests, not "research everything".
 *
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
  EvidenceGrade,
  GapPlannerConfig,
  Mechanism,
  PackMapFile,
  ResearchGapCell,
  ResearchQueue,
  ResearchTask,
  SegmentsFile,
  SufficiencyCell,
  SufficiencyCriterion,
  SufficiencyMatrix,
  SufficiencyStatus,
  SufficiencyThreshold,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const MECHANISMS_DIR = join(ROOT, "registry", "mechanisms");
const PACK_MAP = join(ROOT, "packs", "pack-map.yaml");
const SEGMENTS = join(ROOT, "segments", "segments.yaml");
const ANALYSIS_DIR = join(ROOT, "analysis");
const CONFIG = join(ANALYSIS_DIR, "analyzer.config.yaml");
const MATRIX = join(ANALYSIS_DIR, "sufficiency-matrix.json");
const QUEUE = join(ANALYSIS_DIR, "research-queue.json");

const QUEUE_VERSION = "0.1.0";

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

/** The shape of analyzer.config.yaml we read: thresholds + the gap_planner block. */
interface AnalyzerConfigFile {
  version: string;
  thresholds: { default: SufficiencyThreshold } & Partial<
    Record<SufficiencyCriterion, SufficiencyThreshold>
  >;
  replication_flags?: string[];
  gap_planner?: GapPlannerConfig;
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
): { file: AnalyzerConfigFile; gp: GapPlannerConfig } {
  if (!existsSync(CONFIG)) {
    fail(`no analyzer config at ${rel(CONFIG)} — nothing to plan from.`);
  }
  const file = parseYaml(readFileSync(CONFIG, "utf-8")) as AnalyzerConfigFile;
  const gp = file.gap_planner;
  const problems: string[] = [];

  if (!file.thresholds?.default) {
    problems.push("thresholds.default is required to size gaps");
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

  // A qualifier is REQUIRED for every segment that actually surfaces a gap —
  // the planner fails loudly rather than harvesting unqualified terms.
  const qualifiers = gp.segment_qualifiers ?? {};
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
    if (typeof qualifier !== "string" || qualifier.trim().length === 0) {
      problems.push(
        `gap_planner.segment_qualifiers has no entry for "${segmentId}", which has red/amber gaps`,
      );
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${rel(CONFIG)}: ${problem}`);
    process.exit(1);
  }
  return { file, gp };
}

// ---------- ranking ----------

function greenThreshold(file: AnalyzerConfigFile, criterion: SufficiencyCriterion): number {
  return (file.thresholds[criterion] ?? file.thresholds.default).green;
}

/** Σ over the cell's failed criteria of (green_threshold − score), floored at 0. */
function gapSize(cell: SufficiencyCell, file: AnalyzerConfigFile): number {
  return cell.gaps.reduce((sum, criterion) => {
    const distance = greenThreshold(file, criterion) - (cell.scores[criterion] ?? 0);
    return sum + Math.max(0, distance);
  }, 0);
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

function reasonFor(cell: SufficiencyCell, file: AnalyzerConfigFile): string {
  const failed = cell.gaps
    .map((criterion) => {
      const score = cell.scores[criterion] ?? 0;
      const green = greenThreshold(file, criterion);
      return `${criterion} ${score.toFixed(2)}<${green.toFixed(2)}`;
    })
    .join(", ");
  const evidenceNote =
    cell.segment_evidence === "general_only"
      ? "; segment evidence general_only (segment-specific harvest needed)"
      : "; segment_specific evidence present";
  return `${cell.status} cell ${cell.pack}×${cell.segment}: ${failed}${evidenceNote}`;
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

  // Only red/amber cells feed the queue; green cells are saturated (excluded).
  const gapCells = matrix.cells.filter((cell) => cell.status !== "green");
  const neededSegments = new Set(gapCells.map((cell) => cell.segment));

  const { file, gp } = loadGapPlannerConfig(neededSegments, activeSegmentIds);
  const flagged = new Set(file.replication_flags ?? []);

  // Expand every gap cell to (mechanism, segment) candidates, deduped across
  // packs so the same segment-qualified mechanism harvest is queued once, at
  // its highest importance.
  const byKey = new Map<string, Candidate>();
  for (const cell of gapCells) {
    const status = cell.status as Exclude<SufficiencyStatus, "green">;
    const weight = gp.segment_weights?.[cell.segment] ?? 1;
    const importance = round(weight * gapSize(cell, file));
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

  const tasks: ResearchTask[] = ranked.slice(0, effectiveMaxTasks).map((candidate) => {
    const mechanism = mechanisms.get(candidate.mechanism) as Mechanism;
    const qualifier = gp.segment_qualifiers[candidate.segment];
    const gapCell: ResearchGapCell = {
      pack: candidate.cell.pack,
      segment: candidate.cell.segment,
      status: candidate.cell.status,
      gaps: candidate.cell.gaps,
      segment_evidence: candidate.cell.segment_evidence,
    };
    return {
      gap_cell: gapCell,
      mechanism: candidate.mechanism,
      segment: candidate.segment,
      importance: candidate.importance,
      suggested_evidence_terms: suggestedTerms(mechanism, qualifier),
      reason: reasonFor(candidate.cell, file),
    };
  });

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
    tasks,
  };

  mkdirSync(ANALYSIS_DIR, { recursive: true });
  writeFileSync(QUEUE, `${JSON.stringify(queue, null, 2)}\n`, "utf-8");

  const top = tasks[0];
  console.log(
    `OK — ${gapCells.length} red/amber cells → ${ranked.length} (mechanism × segment) candidates; ` +
      `queued ${tasks.length} of N=${effectiveMaxTasks} ` +
      `(config ${gp.budget.max_tasks} / budget ${budgetMaxTasks}; ` +
      `${remainingCalls} monthly calls remaining) → ${rel(QUEUE)}.`,
  );
  if (top) {
    console.log(
      `     top: ${top.mechanism} for ${top.segment} (importance ${top.importance}) — ${top.reason}`,
    );
  }
  // Decision log (D-051): the shape of the policy this queue encodes.
  console.log(
    "\n     gaps prioritized by segment-weight × gap-size, budget-bounded; " +
      "saturated cells excluded; addressing is targeted not exhaustive.",
  );
}

main();

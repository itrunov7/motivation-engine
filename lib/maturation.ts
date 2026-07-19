/**
 * lib/maturation.ts — server-side loaders and computed projections for the
 * /maturation cockpit (D-053).
 *
 * The cockpit visualizes knowledge sufficiency; the growing matrix is the
 * proof the core is alive. Every number it shows is READ from a file and
 * every status is COMPUTED here (honesty rule, .cursorrules #2) — nothing is
 * hardcoded in app/. Sources:
 * - analysis/sufficiency-matrix.json  (generated, D-050) — the heatmap + coverage
 * - analysis/research-queue.json      (generated, D-051) — this week's queue
 * - analysis/maturation-log.json      (generated, D-053) — the weekly log
 * - segments/segments.yaml            (git-only, D-047) — columns + provenance
 * - segments/candidates.json          (generated, D-054) — segment-suggest queue
 * - packs/pack-map.yaml               (git-only, D-048) — row order
 *
 * A missing file returns null so the page renders an honest empty state
 * (same pattern as lib/data.ts loaders), never a fake "no gaps" green.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { COVERAGE_BAND_ORDER, type CoverageBand } from "./status";
import type {
  AuthoringQueue,
  AuthoringTask,
  InteractionRecord,
  InteractionType,
  MaturationLog,
  MaturationLogEntry,
  PackMapFile,
  ResearchQueue,
  Segment,
  SegmentCandidateQueue,
  SegmentGroup,
  SegmentsFile,
  SufficiencyCell,
  SufficiencyMatrix,
  SufficiencyStatus,
} from "./types";

const ROOT = process.cwd();

export const MATURATION_PATHS = {
  matrix: join(ROOT, "analysis", "sufficiency-matrix.json"),
  queue: join(ROOT, "analysis", "research-queue.json"),
  authoringQueue: join(ROOT, "analysis", "authoring-queue.json"),
  log: join(ROOT, "analysis", "maturation-log.json"),
  segments: join(ROOT, "segments", "segments.yaml"),
  segmentCandidates: join(ROOT, "segments", "candidates.json"),
  packMap: join(ROOT, "packs", "pack-map.yaml"),
  interactionsDir: join(ROOT, "interactions"),
} as const;

/** Relative-to-repo path for the "traces to a file" provenance footers. */
export function repoRelative(absPath: string): string {
  return absPath.startsWith(ROOT) ? absPath.slice(ROOT.length + 1) : absPath;
}

function readJsonOrNull<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readYamlOrNull<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return parseYaml(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

// ---------- Loaders ----------

export function loadSufficiencyMatrix(): SufficiencyMatrix | null {
  return readJsonOrNull<SufficiencyMatrix>(MATURATION_PATHS.matrix);
}

export function loadResearchQueue(): ResearchQueue | null {
  return readJsonOrNull<ResearchQueue>(MATURATION_PATHS.queue);
}

export function loadAuthoringQueue(): AuthoringQueue | null {
  return readJsonOrNull<AuthoringQueue>(MATURATION_PATHS.authoringQueue);
}

/** Pair key matching the analyzer / render-packs (locale-stable). */
function pairKeyOf(a: string, b: string): string {
  return a.localeCompare(b) <= 0 ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Owner-authored interaction records on disk (/interactions, D-057), keyed by
 * pairKey. A missing store or a malformed file yields no entry — the validator
 * is the gate, so the cockpit skips a broken file rather than crashing.
 */
export function loadAuthoredInteractions(): Map<string, InteractionRecord> {
  const map = new Map<string, InteractionRecord>();
  const dir = MATURATION_PATHS.interactionsDir;
  if (!existsSync(dir)) return map;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name === "interaction.schema.json") continue;
    try {
      const record = JSON.parse(
        readFileSync(join(dir, name), "utf-8"),
      ) as InteractionRecord;
      if (Array.isArray(record.pair) && record.pair.length === 2) {
        map.set(pairKeyOf(record.pair[0], record.pair[1]), record);
      }
    } catch {
      // Skip a malformed file; validate.ts fails the build on it separately.
    }
  }
  return map;
}

export function loadMaturationLog(): MaturationLog | null {
  return readJsonOrNull<MaturationLog>(MATURATION_PATHS.log);
}

export function loadSegmentsFile(): SegmentsFile | null {
  return readYamlOrNull<SegmentsFile>(MATURATION_PATHS.segments);
}

export function loadSegmentCandidates(): SegmentCandidateQueue | null {
  return readJsonOrNull<SegmentCandidateQueue>(MATURATION_PATHS.segmentCandidates);
}

export function loadPackMap(): PackMapFile | null {
  return readYamlOrNull<PackMapFile>(MATURATION_PATHS.packMap);
}

// ---------- Segment grouping ----------

/** Segment groups in display order (mirrors segments.yaml section order). */
export const SEGMENT_GROUP_ORDER: SegmentGroup[] = [
  "business-model",
  "form",
  "audience",
  "usage-rhythm",
];

export const SEGMENT_GROUP_LABEL: Record<SegmentGroup, string> = {
  "business-model": "business model",
  form: "form",
  audience: "audience",
  "usage-rhythm": "usage rhythm",
};

/** Active segments grouped in SEGMENT_GROUP_ORDER, ids sorted within a group. */
export interface SegmentGroupColumns {
  group: SegmentGroup;
  segments: Segment[];
}

export function groupActiveSegments(
  segmentsFile: SegmentsFile,
): SegmentGroupColumns[] {
  const active = segmentsFile.segments.filter((s) => s.status === "active");
  return SEGMENT_GROUP_ORDER.map((group) => ({
    group,
    segments: active
      .filter((s) => s.group === group)
      .sort((a, b) => a.id.localeCompare(b.id)),
  })).filter((col) => col.segments.length > 0);
}

// ---------- Heatmap projection ----------

export interface HeatmapRow {
  pack: string;
  /** One cell per column in `columns` order; null = segment not scored yet. */
  cells: (SufficiencyCell | null)[];
}

export interface Heatmap {
  /** Flat column order = concatenation of the grouped segment columns. */
  columns: Segment[];
  /** Grouped columns, for the two-tier header. */
  groups: SegmentGroupColumns[];
  rows: HeatmapRow[];
  /** Active segments with no scored cell in the matrix (new/empty segments). */
  unscoredSegments: string[];
}

/**
 * Builds the pack × segment heatmap. Rows follow pack-map order (D-048);
 * columns are the active segments (D-047) grouped by axis. A segment active in
 * segments.yaml but absent from the matrix yields null cells — rendered as the
 * neutral "not analyzed" state, never red. Falls back to matrix-derived rows /
 * columns when the YAML inputs are unavailable, so the heatmap still traces to
 * the matrix alone.
 */
export function buildHeatmap(
  matrix: SufficiencyMatrix,
  packMap: PackMapFile | null,
  segmentsFile: SegmentsFile | null,
): Heatmap {
  const cellIndex = new Map<string, SufficiencyCell>();
  for (const cell of matrix.cells) {
    cellIndex.set(`${cell.pack}\u0000${cell.segment}`, cell);
  }

  // Columns: active segments (grouped) when segments.yaml is present, else the
  // distinct segments observed in the matrix (single ungrouped column).
  let groups: SegmentGroupColumns[];
  if (segmentsFile) {
    groups = groupActiveSegments(segmentsFile);
  } else {
    const seen = Array.from(new Set(matrix.cells.map((c) => c.segment))).sort();
    groups = [
      {
        group: "business-model",
        segments: seen.map((id) => ({
          id,
          group: "business-model",
          definition: "",
          status: "active",
          provenance: "",
        })),
      },
    ];
  }
  const columns = groups.flatMap((g) => g.segments);

  // Rows: pack-map order when present, else distinct packs in the matrix.
  const packOrder = packMap
    ? packMap.elements.map((e) => e.id)
    : Array.from(new Set(matrix.cells.map((c) => c.pack))).sort();

  const rows: HeatmapRow[] = packOrder.map((pack) => ({
    pack,
    cells: columns.map(
      (col) => cellIndex.get(`${pack}\u0000${col.id}`) ?? null,
    ),
  }));

  const scoredSegments = new Set(matrix.cells.map((c) => c.segment));
  const unscoredSegments = columns
    .map((c) => c.id)
    .filter((id) => !scoredSegments.has(id));

  return { columns, groups, rows, unscoredSegments };
}

// ---------- Coverage summary ----------

export interface StatusCounts {
  red: number;
  amber: number;
  green: number;
  /**
   * Cells counted as evidence-exhausted (D-059) instead of red/amber — thin
   * literature the loop stopped harvesting. Kept apart from red so the cockpit
   * never shows a proven-thin gap as an actionable red-forever cell.
   */
  exhausted: number;
  total: number;
  /** Percentage of scored cells that are green (0–100), 0 when total is 0. */
  pctGreen: number;
}

export interface CoverageRow {
  /** Pack id or segment id. */
  key: string;
  counts: StatusCounts;
}

export interface Coverage {
  overall: StatusCounts;
  perPack: CoverageRow[];
  perSegment: CoverageRow[];
}

function emptyCounts(): StatusCounts {
  return { red: 0, amber: 0, green: 0, exhausted: 0, total: 0, pctGreen: 0 };
}

function tally(cells: SufficiencyCell[]): StatusCounts {
  const counts = emptyCounts();
  for (const cell of cells) {
    // An evidence-exhausted cell (D-059) is counted in its own band, NOT in
    // red/amber — the literature is thin, not the work undone. Its status is
    // still genuinely red/amber underneath, but the cockpit shows it as
    // "thin literature — best available" rather than red-forever.
    if (cell.evidence_exhausted) counts.exhausted += 1;
    else counts[cell.status] += 1;
    counts.total += 1;
  }
  counts.pctGreen =
    counts.total === 0 ? 0 : Math.round((counts.green / counts.total) * 100);
  return counts;
}

function groupBy(
  cells: SufficiencyCell[],
  key: (cell: SufficiencyCell) => string,
): CoverageRow[] {
  const buckets = new Map<string, SufficiencyCell[]>();
  for (const cell of cells) {
    const k = key(cell);
    const list = buckets.get(k);
    if (list) list.push(cell);
    else buckets.set(k, [cell]);
  }
  return Array.from(buckets.entries())
    .map(([k, list]) => ({ key: k, counts: tally(list) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Coverage rollup over the matrix cells: % green overall, per pack, and per
 * segment. Pure over matrix.cells — every figure the summary shows is summed
 * from the file, never asserted.
 */
export function computeCoverage(matrix: SufficiencyMatrix): Coverage {
  return {
    overall: tally(matrix.cells),
    perPack: groupBy(matrix.cells, (c) => c.pack),
    perSegment: groupBy(matrix.cells, (c) => c.segment),
  };
}

/** Coverage bands in worst→best order for a compact legend/bar (D-059). */
export function coverageBreakdown(
  counts: StatusCounts,
): { band: CoverageBand; count: number }[] {
  return COVERAGE_BAND_ORDER.map((band) => ({ band, count: counts[band] }));
}

// ---------- "Segments are evolving" provenance note ----------

export interface SegmentProvenance {
  activeCount: number;
  retiredCount: number;
  /** provenance string → count among ACTIVE segments, sorted by count desc. */
  byProvenance: { provenance: string; count: number }[];
}

/**
 * Count of candidates in the segment-suggest queue by review status (D-054).
 * Read from segments/candidates.json — never hardcoded. The "proposed" count
 * is what awaits owner approval; today segment-suggest is designed but not
 * scheduled, so the honest count is 0.
 */
export interface SegmentCandidateSummary {
  proposed: number;
  total: number;
}

export function computeSegmentCandidates(
  queue: SegmentCandidateQueue,
): SegmentCandidateSummary {
  return {
    proposed: queue.candidates.filter((c) => c.status === "proposed").length,
    total: queue.candidates.length,
  };
}

/**
 * Provenance breakdown for the "segments are evolving" note. Counts are read
 * from segments.yaml (D-047): the seed set carries seed-YYYY-MM; segments the
 * analyzer or owner add later carry analyzer/owner. The count is never
 * hardcoded — the axis grows and the note grows with it.
 */
export function computeSegmentProvenance(
  segmentsFile: SegmentsFile,
): SegmentProvenance {
  const active = segmentsFile.segments.filter((s) => s.status === "active");
  const retired = segmentsFile.segments.filter((s) => s.status === "retired");
  const counts = new Map<string, number>();
  for (const s of active) {
    counts.set(s.provenance, (counts.get(s.provenance) ?? 0) + 1);
  }
  return {
    activeCount: active.length,
    retiredCount: retired.length,
    byProvenance: Array.from(counts.entries())
      .map(([provenance, count]) => ({ provenance, count }))
      .sort((a, b) => b.count - a.count || a.provenance.localeCompare(b.provenance)),
  };
}

// ---------- Interaction authoring (D-057) ----------

/** One pack×segment cell whose interaction_coverage gap names a missing pair. */
export interface InteractionPairCell {
  pack: string;
  segment: string;
  status: SufficiencyStatus;
  importance: number;
}

/** One missing interaction pair aggregated across the authoring queue. */
export interface InteractionAuthoringPair {
  /** The two mechanism ids, sorted (id.localeCompare). */
  pair: [string, string];
  /** The store filename the owner authors, {A}__{B}.json. */
  filename: string;
  /** True when a record already exists on disk (transient until re-analyze). */
  authored: boolean;
  /** The authored record's type when on disk, for the status chip. */
  type: InteractionType | null;
  /** Max task importance across the cells that need this pair (rank key). */
  importance: number;
  /** The cells whose interaction_coverage gap names this pair, importance-desc. */
  cells: InteractionPairCell[];
}

export interface InteractionAuthoring {
  pairs: InteractionAuthoringPair[];
  authoredCount: number;
  missingCount: number;
}

/**
 * Aggregates the authoring queue's interaction_coverage gaps into a ranked list
 * of missing mechanism pairs (D-057). A pair is deduped across the cells that
 * need it; importance is the max across those cells; the authored flag/type is
 * read from the /interactions store on disk. Everything here is READ from files
 * and computed — never asserted.
 */
export function computeInteractionAuthoring(
  queue: AuthoringQueue,
  authored: Map<string, InteractionRecord>,
): InteractionAuthoring {
  const byPair = new Map<string, InteractionAuthoringPair>();

  for (const task of queue.tasks) {
    const gap = task.structural_gaps.find(
      (g) => g.criterion === "interaction_coverage",
    );
    for (const rawPair of gap?.missing_interaction_pairs ?? []) {
      const [a, b] = [...rawPair].sort((x, y) => x.localeCompare(y)) as [
        string,
        string,
      ];
      const key = pairKeyOf(a, b);
      const record = authored.get(key) ?? null;
      const entry = byPair.get(key) ?? {
        pair: [a, b] as [string, string],
        filename: `${a}__${b}.json`,
        authored: record !== null,
        type: record ? record.type : null,
        importance: 0,
        cells: [],
      };
      entry.importance = Math.max(entry.importance, task.importance);
      entry.cells.push({
        pack: task.pack,
        segment: task.segment,
        status: task.status,
        importance: task.importance,
      });
      byPair.set(key, entry);
    }
  }

  const pairs = Array.from(byPair.values()).sort(
    (x, y) =>
      y.importance - x.importance ||
      x.pair[0].localeCompare(y.pair[0]) ||
      x.pair[1].localeCompare(y.pair[1]),
  );
  for (const p of pairs) {
    p.cells.sort(
      (c, d) =>
        d.importance - c.importance ||
        c.pack.localeCompare(d.pack) ||
        c.segment.localeCompare(d.segment),
    );
  }

  return {
    pairs,
    authoredCount: pairs.filter((p) => p.authored).length,
    missingCount: pairs.filter((p) => !p.authored).length,
  };
}

// ---------- Thin literature (evidence exhaustion, D-059) ----------

/**
 * The authoring-queue tasks routed here by evidence exhaustion (D-059) — cells
 * whose scored harvest gap can no longer be closed by harvesting because the
 * literature is thin. Filtered from the authoring queue (which already carries
 * each cell's best-achievable scores, harvest effort, and alternative fillers)
 * and kept in the queue's importance order. Everything is READ from the file.
 */
export function computeThinLiterature(queue: AuthoringQueue): AuthoringTask[] {
  return queue.tasks.filter((task) => task.alternative_fill === true);
}

// ---------- Maturation log ----------

/** Log entries newest-first for display; the file stores them append-order. */
export function maturationEntriesNewestFirst(
  log: MaturationLog,
): MaturationLogEntry[] {
  return [...log.entries].sort((a, b) => b.week.localeCompare(a.week));
}

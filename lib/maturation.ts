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
import { parse as parseYaml, parseAllDocuments } from "yaml";
import { loadFullMechanisms, loadTaxonomy } from "./data";
import { COVERAGE_BAND_ORDER, computeCellRoute, type CoverageBand } from "./status";
import type {
  AuthoringQueue,
  AuthoringTask,
  HarvestHistory,
  InteractionRecord,
  InteractionType,
  MaturationLog,
  MaturationLogEntry,
  PackBundleManifest,
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
  harvestHistory: join(ROOT, "analysis", "harvest-history.json"),
  log: join(ROOT, "analysis", "maturation-log.json"),
  segments: join(ROOT, "segments", "segments.yaml"),
  segmentCandidates: join(ROOT, "segments", "candidates.json"),
  packMap: join(ROOT, "packs", "pack-map.yaml"),
  packBundle: join(ROOT, "packs", "export", "packs-bundle.yaml"),
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

/**
 * The per-target harvest ledger (analysis/harvest-history.json, D-059) — the
 * persistent memory of how many consecutive weeks each (mechanism × segment)
 * harvest came back low-novelty. Absent yields null: the loop has not yet run
 * against a filled ledger, so the cockpit shows no low-novelty flag rather than
 * a fabricated one (honest absence, same pattern as the analyzer, D-059).
 */
export function loadHarvestHistory(): HarvestHistory | null {
  return readJsonOrNull<HarvestHistory>(MATURATION_PATHS.harvestHistory);
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

/**
 * Manifest of the committed pack export bundle (D-068) — the first document of
 * the multi-document packs/export/packs-bundle.yaml written by every
 * `npm run packs` run. Absent or malformed yields null so the cockpit renders
 * an honest empty state; validate.ts is the gate on bundle/pack drift.
 */
export function loadPackBundleManifest(): PackBundleManifest | null {
  const file = MATURATION_PATHS.packBundle;
  if (!existsSync(file)) return null;
  try {
    const docs = parseAllDocuments(readFileSync(file, "utf-8"));
    if (docs.length === 0 || docs[0].errors.length > 0) return null;
    const manifest = docs[0].toJS() as PackBundleManifest;
    return manifest?.bundle === "pack-export" ? manifest : null;
  } catch {
    return null;
  }
}

/** The reserved row id of the cross-cutting perception row group (D-067). */
export const PERCEPTION_ROW = "perception";

/**
 * The cross-cutting roster ids (Step 6, D-067): full L1 records whose L0 parent
 * is flagged cross_cutting (today only S7) — the same set the analyzer scores
 * as the perception row and render-packs emits into every pack. Read from the
 * registry + taxonomy; a missing/broken file yields [] (honest absence), so the
 * cockpit fabricates no perception novelty flag.
 */
export function loadCrossCuttingIds(): string[] {
  try {
    const crossCuttingL0 = new Set(
      loadTaxonomy().nodes.filter((n) => n.cross_cutting).map((n) => n.id),
    );
    return loadFullMechanisms()
      .filter((m) => crossCuttingL0.has(m.parent))
      .map((m) => m.id)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
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

/** A banded group of heatmap rows (Step 6, D-067): the packs, then perception. */
export type HeatmapRowGroupId = "packs" | "perception";

export interface HeatmapRowGroup {
  group: HeatmapRowGroupId;
  /** Display label for the group's separator header row. */
  label: string;
  rows: HeatmapRow[];
}

export interface Heatmap {
  /** Flat column order = concatenation of the grouped segment columns. */
  columns: Segment[];
  /** Grouped columns, for the two-tier header. */
  groups: SegmentGroupColumns[];
  /** Flat pack rows in pack-map order (perception excluded); kept for callers. */
  rows: HeatmapRow[];
  /**
   * Rows banded by group (D-067): the motivational pack rows, then the single
   * cross-cutting perception row — so the cockpit renders perception apart from
   * the 11 packs instead of multiplying it into them.
   */
  rowGroups: HeatmapRowGroup[];
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

  const cellsFor = (rowId: string): (SufficiencyCell | null)[] =>
    columns.map((col) => cellIndex.get(`${rowId}\u0000${col.id}`) ?? null);

  // Pack rows: pack-map order when present, else distinct packs in the matrix,
  // ALWAYS excluding the reserved perception row — it is rendered as its own
  // group below (D-067), never as a pack row.
  const packOrder = (
    packMap
      ? packMap.elements.map((e) => e.id)
      : Array.from(new Set(matrix.cells.map((c) => c.pack))).sort()
  ).filter((id) => id !== PERCEPTION_ROW);

  const rows: HeatmapRow[] = packOrder.map((pack) => ({
    pack,
    cells: cellsFor(pack),
  }));

  // The perception group always renders one row (D-067). When the on-disk
  // matrix predates the row group its cells are null → the neutral "not
  // analyzed" state, a designed empty state, never a fabricated red.
  const rowGroups: HeatmapRowGroup[] = [
    { group: "packs", label: "packs", rows },
    {
      group: "perception",
      label: "perception (cross-cutting)",
      rows: [{ pack: PERCEPTION_ROW, cells: cellsFor(PERCEPTION_ROW) }],
    },
  ];

  const scoredSegments = new Set(matrix.cells.map((c) => c.segment));
  const unscoredSegments = columns
    .map((c) => c.id)
    .filter((id) => !scoredSegments.has(id));

  return { columns, groups, rows, rowGroups, unscoredSegments };
}

// ---------- Coverage summary ----------

export interface StatusCounts {
  /** Red cells a harvest can still move (harvest route, D-061). */
  red: number;
  /** Amber cells a harvest can still move (harvest route, D-061). */
  amber: number;
  green: number;
  /**
   * Red/amber cells whose only fillers are owner edits in git (authoring
   * route, D-056/D-061) — no harvest can flip them. Kept apart from red/amber
   * so the coverage summary distinguishes "awaiting authoring" from harvestable
   * gaps, and the owner sees what to author vs what to harvest.
   */
  authoring: number;
  /** Cells waiting on Actions-only extraction and owner review. */
  pipeline: number;
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
  /** Pack-cell rollup only (D-067) — the overall-green figure over 11×15. */
  overall: StatusCounts;
  perPack: CoverageRow[];
  perSegment: CoverageRow[];
  /**
   * The cross-cutting perception row's rollup (D-067), reported APART from pack
   * coverage: the row is scored once per segment, never counted 11 times, so it
   * neither inflates nor deflates the pack overall-green figure. Zero-count when
   * the matrix predates the row group.
   */
  perception: StatusCounts;
}

function emptyCounts(): StatusCounts {
  return {
    red: 0,
    amber: 0,
    green: 0,
    authoring: 0,
    pipeline: 0,
    exhausted: 0,
    total: 0,
    pctGreen: 0,
  };
}

function tally(cells: SufficiencyCell[]): StatusCounts {
  const counts = emptyCounts();
  for (const cell of cells) {
    // Count by filler route (D-061), not raw status, so the coverage summary
    // separates what a harvest can move (red/amber) from what only an owner
    // edit can (authoring) and from proven-thin literature (exhausted):
    // - exhausted: evidence_exhausted (D-059) — thin, not undone; own band
    // - authoring: a red/amber cell with only structural gaps (D-056) — no
    //   harvest flips it, so it is not an actionable red-forever
    // - red/amber: still harvestable at that status
    // - green: saturated
    switch (computeCellRoute(cell)) {
      case "exhausted":
        counts.exhausted += 1;
        break;
      case "authoring":
        counts.authoring += 1;
        break;
      case "pipeline":
        counts.pipeline += 1;
        break;
      case "green":
        counts.green += 1;
        break;
      case "harvest":
        counts[cell.status as "red" | "amber"] += 1;
        break;
    }
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
  // Partition by row group (D-067): a cell without row_group predates the group
  // and is a legacy pack cell. Pack coverage tallies pack cells only, so the
  // overall-green figure stays over the 11×15 pack grid; perception is separate.
  const packCells = matrix.cells.filter((c) => (c.row_group ?? "pack") === "pack");
  const perceptionCells = matrix.cells.filter((c) => c.row_group === "perception");
  return {
    overall: tally(packCells),
    perPack: groupBy(packCells, (c) => c.pack),
    perSegment: groupBy(packCells, (c) => c.segment),
    perception: tally(perceptionCells),
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
  /** Count of authored records on disk in /interactions (D-057), NOT a
   * queue-derived tally — see computeInteractionAuthoring for why. */
  authoredCount: number;
  missingCount: number;
}

/**
 * Aggregates the authoring queue's interaction_coverage gaps into a ranked list
 * of missing mechanism pairs (D-057). A pair is deduped across the cells that
 * need it; importance is the max across those cells; the authored flag/type is
 * read from the /interactions store on disk. Everything here is READ from files
 * and computed — never asserted.
 *
 * IMPORTANT (D-069): `authoredCount` is the number of records in the
 * /interactions store, taken from `authored`, NOT `pairs.filter(p =>
 * p.authored)`. The analyzer DROPS an authored pair from a cell's
 * missing_interaction_pairs the moment its record lands (D-057), so an authored
 * pair never appears in `queue.tasks` again — a queue-derived authored tally is
 * therefore structurally pinned at ~0 (the exact "AUTHORED 0" bug). The store
 * on disk is the source of truth for how many interactions are authored, which
 * is also what the panel hint ("records in /interactions/") promises.
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
    authoredCount: authored.size,
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

// ---------- Low-novelty flag (harvest ledger, D-058/D-059) ----------

/** How many of a cell's pack mechanisms are on a low-novelty harvest streak. */
export interface CellNovelty {
  /** Pack mechanisms currently on a low_novelty_streak ≥ 1 for this segment. */
  streaking: number;
  /** Total pack mechanisms (the denominator). */
  members: number;
}

/**
 * Per pack×segment cell, counts how many of the pack's member mechanisms are
 * currently on a low-novelty harvest streak (D-058) for that segment, read
 * from analysis/harvest-history.json (D-059). Keyed "pack\u0000segment". The
 * cockpit shows this as a hover flag ("low novelty: N/M mechanisms this
 * streak") so the owner sees a gap the loop keeps re-fetching without progress
 * — the early signal that precedes full evidence-exhaustion. Returns an empty
 * map when the ledger is absent, so no flag is fabricated (honest absence).
 */
export function computeCellNovelty(
  history: HarvestHistory | null,
  packMap: PackMapFile | null,
  crossCuttingIds: string[] = [],
): Map<string, CellNovelty> {
  const result = new Map<string, CellNovelty>();
  if (!history || !packMap) return result;
  const segments = new Set<string>();
  for (const key of Object.keys(history.entries)) {
    const idx = key.indexOf("|");
    if (idx >= 0) segments.add(key.slice(idx + 1));
  }
  const segmentIds = Array.from(segments);
  // The pack rows plus the cross-cutting perception row (D-067): the perception
  // row's members are the cross-cutting roster, so its low-novelty flag is
  // computed the same way as any pack's.
  const rows: { id: string; members: string[] }[] = [
    ...packMap.elements.map((e) => ({ id: e.id, members: e.mechanisms })),
    { id: PERCEPTION_ROW, members: crossCuttingIds },
  ];
  for (const { id, members } of rows) {
    if (members.length === 0) continue;
    for (const segment of segmentIds) {
      let streaking = 0;
      for (const mechanismId of members) {
        const target = history.entries[`${mechanismId}|${segment}`];
        if (target && target.low_novelty_streak >= 1) streaking += 1;
      }
      if (streaking > 0) {
        result.set(`${id}\u0000${segment}`, {
          streaking,
          members: members.length,
        });
      }
    }
  }
  return result;
}

// ---------- Maturation log ----------

/** Log entries newest-first for display; the file stores them append-order. */
export function maturationEntriesNewestFirst(
  log: MaturationLog,
): MaturationLogEntry[] {
  return [...log.entries].sort((a, b) => b.week.localeCompare(a.week));
}

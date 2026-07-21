import { Fragment } from "react";
import Link from "next/link";
import {
  ALTERNATIVE_FILL_META,
  CELL_EXHAUSTED_META,
  CELL_NOT_ANALYZED_META,
  CELL_STATUS_META,
  CELL_STATUS_ORDER,
  COVERAGE_BAND_META,
  COVERAGE_BAND_ORDER,
  FIX_TYPE_META,
  INTERACTION_AUTHORING_META,
  SEGMENT_EVIDENCE_META,
  loadMechanismNodeIndex,
  needsSegmentHarvest,
  type MechanismNodeRef,
} from "@/lib/status";
import {
  MATURATION_PATHS,
  SEGMENT_GROUP_LABEL,
  buildHeatmap,
  computeCellNovelty,
  computeCoverage,
  computeInteractionAuthoring,
  computeSegmentCandidates,
  computeSegmentProvenance,
  computeThinLiterature,
  coverageBreakdown,
  loadAuthoredInteractions,
  loadAuthoringQueue,
  loadCrossCuttingIds,
  loadExtractionQueue,
  loadHarvestHistory,
  loadMaturationLog,
  loadPackBundleManifest,
  loadPackMap,
  loadResearchQueue,
  loadSegmentCandidates,
  loadSegmentsFile,
  loadSufficiencyMatrix,
  maturationEntriesNewestFirst,
  repoRelative,
  type CellNovelty,
  type Coverage,
  type Heatmap,
  type InteractionAuthoringPair,
  type StatusCounts,
} from "@/lib/maturation";
import type {
  AuthoringTask,
  ExtractionTask,
  MaturationLogEntry,
  MaturityStage,
  ResearchTask,
  StageThresholds,
  SufficiencyCell,
  SufficiencyCriterion,
  SufficiencyGroup,
  SufficiencyStatus,
  TypedGap,
} from "@/lib/types";

export const metadata = {
  title: "Maturation — Motivation Engine",
};

const CRITERION_GROUPS: {
  key: SufficiencyGroup;
  label: string;
  criteria: { key: SufficiencyCriterion; label: string }[];
}[] = [
  {
    key: "breadth",
    label: "breadth",
    criteria: [
      { key: "saturation_reached", label: "saturation reached" },
      {
        key: "corpus_size_vs_field_estimate",
        label: "corpus size vs field estimate",
      },
      { key: "source_diversity", label: "source diversity" },
      { key: "recency_balance", label: "recency balance" },
    ],
  },
  {
    key: "depth",
    label: "depth",
    criteria: [
      { key: "effect_coverage", label: "effect coverage" },
      { key: "realization_density", label: "realization density" },
      { key: "interaction_coverage", label: "interaction coverage" },
      { key: "extraction_completeness", label: "extraction completeness" },
    ],
  },
  {
    key: "quality",
    label: "quality",
    criteria: [
      { key: "dissent_completeness", label: "dissent completeness" },
      { key: "grade_sufficiency", label: "grade sufficiency" },
      { key: "context_coverage", label: "context coverage" },
      { key: "freshness", label: "freshness" },
    ],
  },
];
const CRITERIA = CRITERION_GROUPS.flatMap((group) => group.criteria);

function fmtScore(value: number | null): string {
  return value === null ? "unmeasured" : value.toFixed(2);
}

function fmtDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// ---------- Shared shells ----------

function Panel({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  footer: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <h2 className="font-display text-base font-medium text-[#E6EFE8]">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-1 text-sm leading-relaxed text-[#8CA495]">{subtitle}</p>
      )}
      <div className="mt-4">{children}</div>
      <p className="mt-4 border-t border-[#243329] pt-3 font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
        {footer}
      </p>
    </section>
  );
}

function EmptyState({ message, command }: { message: string; command: string }) {
  return (
    <div className="rounded-md border border-dashed border-[#243329] bg-[#1A2620] px-4 py-5">
      <p className="text-sm leading-relaxed text-[#8CA495]">{message}</p>
      <p className="mt-2 font-mono text-[11px] text-[#7C93A8]">{command}</p>
    </div>
  );
}

/**
 * The L0 parent node of a bare mechanism id, so a cross-cutting perception
 * mechanism (S7, D-062) is distinguishable from a motivational one (S1–S6)
 * everywhere an id appears alone (D-071). Cross-cutting nodes are amber-tagged.
 */
function NodeBadge({ node }: { node: MechanismNodeRef | undefined }) {
  if (!node) return null;
  return (
    <span
      title={`${node.parent} · ${node.parentName}`}
      className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
      style={{
        color: node.crossCutting ? "#E4B54E" : "#7C93A8",
        borderColor: node.crossCutting ? "#E4B54E55" : "#243329",
      }}
    >
      {node.parent}
      {node.crossCutting && <span>cross-cutting</span>}
    </span>
  );
}

// ---------- Coverage ----------

/** A worst→best stacked bar; widths are shares of scored cells (computed). */
function CoverageBar({ counts }: { counts: StatusCounts }) {
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-[#0E1512]">
      {COVERAGE_BAND_ORDER.map((band) => {
        const share = counts.total === 0 ? 0 : (counts[band] / counts.total) * 100;
        if (share === 0) return null;
        return (
          <div
            key={band}
            style={{ width: `${share}%`, backgroundColor: COVERAGE_BAND_META[band].color }}
            title={`${COVERAGE_BAND_META[band].label}: ${counts[band]}`}
          />
        );
      })}
    </div>
  );
}

function CoverageRowLine({ label, counts }: { label: string; counts: StatusCounts }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-44 shrink-0 truncate font-mono text-xs text-[#8CA495]" title={label}>
        {label}
      </span>
      <div className="flex-1">
        <CoverageBar counts={counts} />
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-xs text-[#E6EFE8]">
        {counts.pctGreen}%
      </span>
    </div>
  );
}

function CoverageSummary({ coverage }: { coverage: Coverage }) {
  const { overall, perception } = coverage;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-mono text-xs uppercase tracking-wider text-[#7C93A8]">
            overall green <span className="text-[#8CA495]">· packs</span>
          </span>
          <span className="font-display text-2xl font-semibold text-[#34D399]">
            {overall.pctGreen}%
          </span>
        </div>
        <div className="mt-2">
          <CoverageBar counts={overall} />
        </div>
        <div className="mt-2 flex flex-wrap gap-4">
          {coverageBreakdown(overall).map(({ band, count }) => (
            <span key={band} className="inline-flex items-center gap-1.5 font-mono text-xs text-[#8CA495]">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: COVERAGE_BAND_META[band].color }}
              />
              {COVERAGE_BAND_META[band].label} {count}
            </span>
          ))}
          <span className="font-mono text-xs text-[#7C93A8]">
            {overall.total} pack cells scored
          </span>
        </div>
      </div>

      {/* Perception coverage (D-067): reported apart from pack coverage — the
          cross-cutting row is scored once per segment, never counted 11 times. */}
      <div className="rounded-md border border-[#243329] bg-[#1A2620] px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-mono text-xs uppercase tracking-wider text-[#7C93A8]">
            perception green <span className="text-[#8CA495]">· cross-cutting (S7)</span>
          </span>
          <span className="font-display text-lg font-semibold text-[#34D399]">
            {perception.pctGreen}%
          </span>
        </div>
        <div className="mt-2">
          <CoverageBar counts={perception} />
        </div>
        <p className="mt-2 font-mono text-[11px] text-[#7C93A8]">
          {perception.total > 0
            ? `${perception.total} perception cells scored — kept out of the pack figure so cross-cutting knowledge is not counted 11 times`
            : "no perception row in the matrix yet — re-run npm run analyze to score the cross-cutting row"}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h3 className="font-mono text-xs uppercase tracking-widest text-[#7C93A8]">
            per pack
          </h3>
          <div className="mt-3 flex flex-col gap-2">
            {coverage.perPack.map((row) => (
              <CoverageRowLine key={row.key} label={row.key} counts={row.counts} />
            ))}
          </div>
        </div>
        <div>
          <h3 className="font-mono text-xs uppercase tracking-widest text-[#7C93A8]">
            per segment
          </h3>
          <div className="mt-3 flex flex-col gap-2">
            {coverage.perSegment.map((row) => (
              <CoverageRowLine key={row.key} label={row.key} counts={row.counts} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Heatmap ----------

/** Human label for a typed gap's criterion (incl. the segment_evidence pseudo-gap). */
const CRITERION_LABEL: Record<SufficiencyCriterion, string> = CRITERIA.reduce(
  (acc, { key, label }) => {
    acc[key] = label;
    return acc;
  },
  {} as Record<SufficiencyCriterion, string>,
);

function typedGapLabel(gap: TypedGap): string {
  return gap.criterion === "segment_evidence"
    ? "segment evidence"
    : CRITERION_LABEL[gap.criterion];
}

/** One typed-gap line: criterion, its score vs threshold, and its filler route chip. */
function GapLine({
  gap,
  measurement,
}: {
  gap: TypedGap;
  measurement?: SufficiencyCell["measurements"][SufficiencyCriterion];
}) {
  const meta = FIX_TYPE_META[gap.fix_type];
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <dt className="font-mono text-[11px] text-[#E6EFE8]">{typedGapLabel(gap)}</dt>
        <dd className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] text-[#8CA495]">
            {gap.value === null ? (
              "unmeasured"
            ) : (
              <>
                {fmtScore(gap.value)}
                <span className="text-[#7C93A8]"> &lt; </span>
                {fmtScore(gap.threshold)}
              </>
            )}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: meta.color }}>
            {meta.label}
          </span>
          {measurement?.estimate_source === "owner_override" && (
            <span
              className="font-mono text-[9px] uppercase tracking-wider text-[#E4B54E]"
              title={measurement.override_rationale}
            >
              owner override
            </span>
          )}
        </dd>
      </div>
      {measurement && (
        <p
          className="mt-0.5 truncate font-mono text-[9px] text-[#7C93A8]"
          title={measurement.sources.join(" + ")}
        >
          source: {measurement.sources.join(" + ")}
        </p>
      )}
    </div>
  );
}

function GapGroup({
  heading,
  gaps,
  cell,
}: {
  heading: string;
  gaps: TypedGap[];
  cell: SufficiencyCell;
}) {
  if (gaps.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
        {heading}
      </p>
      <dl className="mt-1 flex flex-col gap-1">
        {gaps.map((gap) => (
          <GapLine
            key={gap.criterion}
            gap={gap}
            measurement={
              gap.criterion === "segment_evidence"
                ? undefined
                : cell.measurements[gap.criterion]
            }
          />
        ))}
      </dl>
    </div>
  );
}

function CellTooltip({
  pack,
  segment,
  cell,
  stage,
  novelty,
}: {
  pack: string;
  segment: string;
  cell: SufficiencyCell | null;
  stage: MaturityStage | null;
  novelty: CellNovelty | null;
}) {
  const passing = cell ? CRITERIA.filter(({ key }) => !cell.gaps.includes(key)) : [];
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-72 -translate-x-1/2 rounded-md border border-[#243329] bg-[#0E1512] p-3 text-left shadow-lg group-hover:block">
      <p className="font-mono text-[11px] text-[#E6EFE8]">
        {pack} <span className="text-[#7C93A8]">×</span> {segment}
      </p>
      {cell ? (
        <>
          {cell.evidence_exhausted ? (
            <p className="mt-1 font-mono text-[11px]" style={{ color: CELL_EXHAUSTED_META.color }}>
              {CELL_EXHAUSTED_META.label}
            </p>
          ) : (
            <p className="mt-1 font-mono text-[11px]" style={{ color: CELL_STATUS_META[cell.status].color }}>
              {CELL_STATUS_META[cell.status].label}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {CRITERION_GROUPS.map((group) => (
              <span
                key={group.key}
                className="font-mono text-[10px] uppercase tracking-wider text-[#8CA495]"
              >
                {group.label}:{" "}
                <span className="text-[#E6EFE8]">
                  {cell.group_statuses[group.key]}
                </span>
              </span>
            ))}
          </div>
          {CRITERION_GROUPS.map((group) => (
            <GapGroup
              key={group.key}
              heading={`${group.label} gaps`}
              cell={cell}
              gaps={cell.typed_gaps.filter(
                (gap) =>
                  gap.criterion !== "segment_evidence" &&
                  group.criteria.some(({ key }) => key === gap.criterion),
              )}
            />
          ))}
          <GapGroup
            heading="segment evidence"
            cell={cell}
            gaps={cell.typed_gaps.filter(
              (gap) => gap.criterion === "segment_evidence",
            )}
          />
          {passing.length > 0 && (
            <div className="mt-2">
              <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
                passing
              </p>
              <dl className="mt-1 flex flex-col gap-1">
                {passing.map(({ key, label }) => (
                  <div key={key} className="flex items-baseline justify-between gap-2">
                    <dt className="font-mono text-[11px] text-[#8CA495]">{label}</dt>
                    <dd className="font-mono text-[11px] text-[#E6EFE8]">
                      {fmtScore(cell.scores[key])}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {cell.evidence_exhausted && cell.exhaustion && (
            <p
              className="mt-2 border-t border-[#243329] pt-2 font-mono text-[11px]"
              style={{ color: CELL_EXHAUSTED_META.color }}
            >
              thin literature — {cell.exhaustion.attempts} low-novelty harvest
              {cell.exhaustion.attempts === 1 ? "" : "s"} over {cell.exhaustion.weeks} wk; best
              available since {cell.exhaustion.since}
            </p>
          )}
          {novelty && (
            <p className="mt-2 border-t border-[#243329] pt-2 font-mono text-[11px] text-[#E4B54E]">
              low novelty: {novelty.streaking}/{novelty.members} mechanism
              {novelty.members === 1 ? "" : "s"} on a repeat-harvest streak
            </p>
          )}
          <p
            className="mt-2 border-t border-[#243329] pt-2 font-mono text-[11px]"
            style={{ color: SEGMENT_EVIDENCE_META[cell.segment_evidence].color }}
            title={SEGMENT_EVIDENCE_META[cell.segment_evidence].description}
          >
            evidence: {SEGMENT_EVIDENCE_META[cell.segment_evidence].label}
          </p>
          {stage && (
            <p className="mt-2 font-mono text-[11px] text-[#7C93A8]">
              stage: <span className="text-[#34D399]">{stage}</span>
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 font-mono text-[11px] text-[#7C93A8]">
          {CELL_NOT_ANALYZED_META.label} — segment not scored in the matrix yet
        </p>
      )}
    </div>
  );
}

function HeatCell({
  pack,
  segment,
  cell,
  stage,
  novelty,
}: {
  pack: string;
  segment: string;
  cell: SufficiencyCell | null;
  stage: MaturityStage | null;
  novelty: CellNovelty | null;
}) {
  const color = !cell
    ? CELL_NOT_ANALYZED_META.color
    : cell.evidence_exhausted
      ? CELL_EXHAUSTED_META.color
      : CELL_STATUS_META[cell.status].color;
  const generalOnly = cell ? needsSegmentHarvest(cell.segment_evidence) : false;
  return (
    <div className="group relative flex h-6 w-6 items-center justify-center">
      <div
        className="h-5 w-5 rounded-sm"
        style={{
          backgroundColor: cell ? `${color}D9` : "transparent",
          border: cell ? "none" : `1px dashed ${color}66`,
        }}
      >
        {generalOnly && (
          <span className="flex h-full w-full items-center justify-center">
            <span className="h-1.5 w-1.5 rounded-full border border-[#0E1512]" />
          </span>
        )}
      </div>
      <CellTooltip
        pack={pack}
        segment={segment}
        cell={cell}
        stage={stage}
        novelty={novelty}
      />
    </div>
  );
}

function HeatmapTable({
  heatmap,
  stage,
  novelty,
}: {
  heatmap: Heatmap;
  stage: MaturityStage | null;
  novelty: Map<string, CellNovelty>;
}) {
  return (
    <div className="overflow-visible">
      <table className="border-separate border-spacing-1">
        <thead>
          <tr>
            <th className="align-bottom" />
            {heatmap.groups.map((g) => (
              <th
                key={g.group}
                colSpan={g.segments.length}
                className="pb-1 text-left align-bottom font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]"
              >
                {SEGMENT_GROUP_LABEL[g.group]}
              </th>
            ))}
          </tr>
          <tr>
            <th className="align-bottom" />
            {heatmap.columns.map((seg) => (
              <th key={seg.id} className="h-32 align-bottom">
                <div className="flex h-full items-end justify-center">
                  <span
                    className="whitespace-nowrap font-mono text-[11px] text-[#8CA495] [writing-mode:vertical-rl] rotate-180"
                    title={seg.definition || seg.id}
                  >
                    {seg.id}
                  </span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {heatmap.rowGroups.map((rowGroup) => (
            <Fragment key={rowGroup.group}>
              {rowGroup.group !== "packs" && (
                <tr>
                  <th
                    colSpan={heatmap.columns.length + 1}
                    className="pt-3 pb-1 text-left font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]"
                  >
                    {rowGroup.label}
                  </th>
                </tr>
              )}
              {rowGroup.rows.map((row) => (
                <tr key={row.pack}>
                  <th className="pr-2 text-right font-mono text-[11px] font-normal text-[#8CA495]">
                    {row.pack}
                  </th>
                  {row.cells.map((cell, i) => (
                    <td key={heatmap.columns[i].id} className="p-0">
                      <HeatCell
                        pack={row.pack}
                        segment={heatmap.columns[i].id}
                        cell={cell}
                        stage={stage}
                        novelty={
                          novelty.get(
                            `${row.pack}\u0000${heatmap.columns[i].id}`,
                          ) ?? null
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeatmapLegend({ unscored }: { unscored: string[] }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
      {CELL_STATUS_ORDER.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[#8CA495]">
          <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: `${CELL_STATUS_META[status].color}D9` }} />
          {CELL_STATUS_META[status].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[#8CA495]">
        <span className="flex h-3 w-3 items-center justify-center rounded-sm bg-[#7C93A8]/50">
          <span className="h-1 w-1 rounded-full border border-[#0E1512]" />
        </span>
        general-only (segment harvest needed)
      </span>
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[#8CA495]">
        <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: `${CELL_EXHAUSTED_META.color}D9` }} />
        {CELL_EXHAUSTED_META.label}
      </span>
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[#8CA495]">
        <span
          className="h-3 w-3 rounded-sm"
          style={{ border: `1px dashed ${CELL_NOT_ANALYZED_META.color}66` }}
        />
        {CELL_NOT_ANALYZED_META.label}
        {unscored.length > 0 ? ` (${unscored.length})` : ""}
      </span>
    </div>
  );
}

// ---------- Stage + thresholds (D-060) ----------

/** One-line meaning of each maturity stage — read plainly, never hardcoded bars. */
const STAGE_MEANING: Record<MaturityStage, string> = {
  seed: "green means seed-adequate, not final — the bar rises as the knowledge matures",
  growing: "green means growing-adequate — a raised bar over seed, not yet the final one",
  mature: "green means the final, mature bar is met",
};

/**
 * States the active maturity stage and its per-criterion thresholds plainly
 * (D-060). Every number is read from the matrix header (matrix.maturity_stage /
 * matrix.thresholds), which the analyzer stamped from analyzer.config.yaml — no
 * threshold is hardcoded here. Renders nothing when the matrix predates the
 * stage-aware header (honest absence, not a fabricated bar).
 */
function ThresholdStrip({
  stage,
  thresholds,
}: {
  stage: MaturityStage;
  thresholds: StageThresholds;
}) {
  return (
    <div className="mt-4 rounded-md border border-[#243329] bg-[#1A2620] px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
          maturity stage
        </span>
        <span className="rounded-full border border-[#34D399]/30 bg-[#0E1512] px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-[#34D399]">
          {stage}
        </span>
        <span className="text-xs text-[#8CA495]">{STAGE_MEANING[stage]}</span>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {CRITERION_GROUPS.map((group) => (
          <div key={group.key}>
            <p className="font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
              {group.label}
            </p>
            <div className="mt-1 flex flex-col gap-1">
              {group.criteria.map(({ key, label }) => {
                const t = thresholds[key] ?? thresholds.default;
                return (
                  <span key={key} className="inline-flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-[#8CA495]">{label}</span>
                    <span className="text-[#34D399]">≥ {fmtScore(t.green)}</span>
                    <span className="text-[#7C93A8]">/</span>
                    <span className="text-[#E4B54E]">≥ {fmtScore(t.amber)}</span>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 border-t border-[#243329] pt-2 font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
        green ≥ · amber ≥ · below amber = red · thresholds are stage-aware and explicit (D-060)
      </p>
    </div>
  );
}

// ---------- Page ----------

export default function MaturationPage() {
  const matrix = loadSufficiencyMatrix();
  const queue = loadResearchQueue();
  const extractionQueue = loadExtractionQueue();
  const authoringQueue = loadAuthoringQueue();
  const log = loadMaturationLog();
  const segmentsFile = loadSegmentsFile();
  const candidatesQueue = loadSegmentCandidates();
  const packMap = loadPackMap();
  const packBundle = loadPackBundleManifest();

  const harvestHistory = loadHarvestHistory();
  const cellNovelty = computeCellNovelty(harvestHistory, packMap, loadCrossCuttingIds());

  // Resolve bare mechanism ids to their L0 node so the queue and interaction
  // pairs show perception (S7) apart from motivational mechanisms (D-071).
  const nodeIndex = loadMechanismNodeIndex();

  const coverage = matrix ? computeCoverage(matrix) : null;
  const heatmap = matrix ? buildHeatmap(matrix, packMap, segmentsFile) : null;
  const provenance = segmentsFile ? computeSegmentProvenance(segmentsFile) : null;
  const candidates = candidatesQueue ? computeSegmentCandidates(candidatesQueue) : null;
  const interactionAuthoring = authoringQueue
    ? computeInteractionAuthoring(authoringQueue, loadAuthoredInteractions())
    : null;
  const thinLiterature = authoringQueue ? computeThinLiterature(authoringQueue) : null;

  const matrixRel = repoRelative(MATURATION_PATHS.matrix);
  const queueRel = repoRelative(MATURATION_PATHS.queue);
  const extractionQueueRel = repoRelative(MATURATION_PATHS.extractionQueue);
  const authoringQueueRel = repoRelative(MATURATION_PATHS.authoringQueue);
  const interactionsRel = repoRelative(MATURATION_PATHS.interactionsDir);
  const logRel = repoRelative(MATURATION_PATHS.log);
  const segmentsRel = repoRelative(MATURATION_PATHS.segments);
  const candidatesRel = repoRelative(MATURATION_PATHS.segmentCandidates);
  const packBundleRel = repoRelative(MATURATION_PATHS.packBundle);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8] hover:text-[#34D399]"
          >
            ← control center
          </Link>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-[#E6EFE8]">
            Maturation — the knowledge is growing
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[#8CA495]">
            The sufficiency matrix, the gaps being filled, and the weekly turn
            of the loop. The growing matrix is the proof the core is alive.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {matrix && (
            <span className="rounded-full border border-[#34D399]/30 bg-[#1A2620] px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-[#34D399]">
              stage: {matrix.maturity_stage}
            </span>
          )}
          {coverage && (
            <span className="rounded-full border border-[#243329] bg-[#1A2620] px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-[#8CA495]">
              {coverage.overall.pctGreen}% green
            </span>
          )}
        </div>
      </header>

      <div className="mt-6 rounded-lg border border-[#34D399]/25 bg-[#1A2620] px-4 py-3">
        <p className="text-sm leading-relaxed text-[#8CA495]">
          <span className="font-mono text-xs uppercase tracking-wider text-[#34D399]">
            honesty rule ·{" "}
          </span>
          Every cell, count, and log entry on this screen is read from{" "}
          <span className="font-mono text-xs text-[#E6EFE8]">analysis/*.json</span> and{" "}
          <span className="font-mono text-xs text-[#E6EFE8]">segments.yaml</span>{" "}
          and computed at render time — no status is hardcoded. A red or absent
          cell is shown honestly, never dressed up as done.
        </p>
        <p className="mt-2 border-t border-[#243329] pt-2 text-sm leading-relaxed text-[#8CA495]">
          Previous five-criterion green figures are superseded. Cells now must
          pass breadth, depth, and quality together, so the initial green share
          is expected to fall sharply while extraction and realization gaps
          become visible.
        </p>
      </div>

      <div className="mt-8 flex flex-col gap-6">
        {/* Coverage */}
        <Panel
          title="Coverage summary"
          subtitle="Share of scored pack × segment cells that are green — overall, per pack, per segment. The cross-cutting perception row (S7) is reported separately, never folded into the pack figure (D-067)."
          footer={
            matrix
              ? `computed from ${matrixRel} · generated ${fmtDateTime(matrix.generated_at)}`
              : matrixRel
          }
        >
          {coverage ? (
            <CoverageSummary coverage={coverage} />
          ) : (
            <EmptyState
              message="No sufficiency matrix yet — nothing to summarize. It appears once the analyzer has scored the pack × segment grid."
              command={`npm run analyze → ${matrixRel}`}
            />
          )}
        </Panel>

        {/* Heatmap */}
        <Panel
          title="Sufficiency matrix"
          subtitle="Packs (rows) × active segments (columns), plus the cross-cutting perception row (S7) scored once per segment as its own group (D-067). Cell color = computed status; hover for breadth, depth, and quality gaps with their source files and filler routes."
          footer={
            matrix
              ? `computed from ${matrixRel}${segmentsFile ? ` + ${segmentsRel}` : ""} · ${matrix.cells.length} cells · config ${matrix.config_version} · stage ${matrix.maturity_stage}`
              : matrixRel
          }
        >
          {heatmap ? (
            <>
              <HeatmapTable
                heatmap={heatmap}
                stage={matrix?.maturity_stage ?? null}
                novelty={cellNovelty}
              />
              <HeatmapLegend unscored={heatmap.unscoredSegments} />
              {matrix?.maturity_stage && matrix.thresholds && (
                <ThresholdStrip stage={matrix.maturity_stage} thresholds={matrix.thresholds} />
              )}
            </>
          ) : (
            <EmptyState
              message="No sufficiency matrix on disk. Run the analyzer (or the weekly maturation loop) to score every pack against every active segment."
              command={`npm run analyze → ${matrixRel}`}
            />
          )}
        </Panel>

        {/* Three filler routes: harvest, extraction, and owner authoring */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Harvest queue — automated, budget-bounded */}
          <Panel
            title="Harvest queue — automated"
            subtitle="Gaps a segment-qualified evidence fetch can still close — ranked and budget-bounded. The loop dispatches these to the connector; no owner work."
            footer={
              queue
                ? `computed from ${queueRel} · generated ${fmtDateTime(queue.generated_at)} · from matrix ${fmtDateTime(queue.matrix_generated_at)}`
                : queueRel
            }
          >
            {queue ? (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <BudgetStat label="queued" value={`${queue.tasks.length} / ${queue.candidate_count}`} hint="tasks / candidates" />
                  <BudgetStat
                    label="applied N"
                    value={`${queue.budget.effective_max_tasks}`}
                    hint={`config ${queue.budget.config_max_tasks} · budget ${queue.budget.budget_max_tasks}`}
                  />
                  <BudgetStat
                    label="calls left"
                    value={`${queue.budget.monthly_remaining_calls}`}
                    hint={`month ${queue.budget.month}`}
                  />
                  <BudgetStat
                    label="share"
                    value={`${Math.round(queue.budget.monthly_budget_share * 100)}%`}
                    hint={`~${queue.budget.estimated_calls_per_task}/task`}
                  />
                </div>
                {queue.tasks.length === 0 ? (
                  <EmptyState
                    message="The harvest queue is empty — no red or amber cell has a scored harvest gap within budget. A gap only a segment-qualified fetch can move appears here; structural gaps route to authoring instead."
                    command={`npm run gaps → ${queueRel}`}
                  />
                ) : (
                  <ul className="flex flex-col gap-3">
                    {queue.tasks.map((task, i) => (
                      <QueueTask
                        key={`${task.mechanism}-${task.segment}-${i}`}
                        task={task}
                        node={nodeIndex.get(task.mechanism)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <EmptyState
                message="No research queue yet. The gap planner ranks the matrix's harvestable cells into a budget-bounded harvest queue."
                command={`npm run gaps → ${queueRel}`}
              />
            )}
          </Panel>

          {/* Extraction queue — automated in Actions, quote-gated */}
          <Panel
            title="Extraction queue — automated"
            subtitle="Depth and dissent gaps the grounded reader can close through pending proposals. Each task is quoted immediately before its Actions-only run; owner approval still gates authoritative knowledge."
            footer={
              extractionQueue
                ? `computed from ${extractionQueueRel} · generated ${fmtDateTime(extractionQueue.generated_at)} · from matrix ${fmtDateTime(extractionQueue.matrix_generated_at)}`
                : extractionQueueRel
            }
          >
            {extractionQueue ? (
              extractionQueue.tasks.length === 0 ? (
                <EmptyState
                  message="The extraction queue is empty. Pipeline gaps appear here only when the mechanism has eligible evidence or realization corpus records for the reader."
                  command={`npm run gaps → ${extractionQueueRel}`}
                />
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-3">
                    <BudgetStat
                      label="queued"
                      value={`${extractionQueue.tasks.length} / ${extractionQueue.candidate_count}`}
                      hint="tasks / candidates"
                    />
                    <BudgetStat
                      label="weekly max"
                      value={`${extractionQueue.config_max_tasks}`}
                      hint="quotes enforce actual caps"
                    />
                  </div>
                  <ul className="flex flex-col gap-3">
                    {extractionQueue.tasks.slice(0, MAX_AUTHORING_ROWS).map((task) => (
                      <ExtractionQueueRow
                        key={`${task.mechanism}-${task.mode}`}
                        task={task}
                        node={nodeIndex.get(task.mechanism)}
                      />
                    ))}
                  </ul>
                  {extractionQueue.tasks.length > MAX_AUTHORING_ROWS && (
                    <p className="font-mono text-[11px] text-[#7C93A8]">
                      + {extractionQueue.tasks.length - MAX_AUTHORING_ROWS} more in{" "}
                      {extractionQueueRel}
                    </p>
                  )}
                </div>
              )
            ) : (
              <EmptyState
                message="No extraction queue yet. The gap planner routes depth and grounded dissent gaps into Actions-only reader tasks."
                command={`npm run gaps → ${extractionQueueRel}`}
              />
            )}
          </Panel>

          {/* Authoring queue — owner tasks, manual */}
          <Panel
            title="Authoring queue — manual"
            subtitle="Gaps that genuinely require human judgment: registry relations, pack composition/context, and thin-literature alternatives. Each is an owner edit in git — never a connector or reader call."
            footer={
              authoringQueue
                ? `computed from ${authoringQueueRel} · generated ${fmtDateTime(authoringQueue.generated_at)} · from matrix ${fmtDateTime(authoringQueue.matrix_generated_at)}`
                : authoringQueueRel
            }
          >
            {authoringQueue ? (
              authoringQueue.tasks.length === 0 ? (
                <EmptyState
                  message="The authoring queue is empty. Structural interaction/context gaps and evidence-exhausted alternatives appear here when only owner judgment can close them."
                  command={`npm run gaps → ${authoringQueueRel}`}
                />
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-3">
                    <BudgetStat
                      label="cells queued"
                      value={`${authoringQueue.tasks.length}`}
                      hint="owner edits, ranked"
                    />
                    <BudgetStat
                      label="thin-lit"
                      value={`${authoringQueue.tasks.filter((t) => t.alternative_fill === true).length}`}
                      hint="alternative fill"
                    />
                  </div>
                  <ul className="flex flex-col gap-3">
                    {authoringQueue.tasks.slice(0, MAX_AUTHORING_ROWS).map((task) => (
                      <AuthoringQueueRow key={`${task.pack}-${task.segment}`} task={task} />
                    ))}
                  </ul>
                  {authoringQueue.tasks.length > MAX_AUTHORING_ROWS && (
                    <p className="font-mono text-[11px] text-[#7C93A8]">
                      + {authoringQueue.tasks.length - MAX_AUTHORING_ROWS} more in{" "}
                      <span className="text-[#8CA495]">{authoringQueueRel}</span>
                    </p>
                  )}
                </div>
              )
            ) : (
              <EmptyState
                message="No authoring queue yet. The gap planner routes structural and evidence-exhausted gaps — the ones no harvest can close — into this owner-facing queue."
                command={`npm run gaps → ${authoringQueueRel}`}
              />
            )}
          </Panel>
        </div>

        {/* Thin literature — evidence exhaustion (D-059) */}
        <Panel
          title="Thin literature — best available"
          subtitle="Gaps the loop stopped harvesting: every mechanism in the cell came back low-novelty for K+ weeks, so the literature is thin, not the work undone. Shown honestly as best-available and handed to the owner for an alternative filler — never harvested forever."
          footer={
            authoringQueue
              ? `computed from ${authoringQueueRel} (← ${repoRelative(MATURATION_PATHS.matrix)} + analysis/harvest-history.json) · generated ${fmtDateTime(authoringQueue.generated_at)}`
              : `${authoringQueueRel} ← analysis/harvest-history.json`
          }
        >
          {thinLiterature ? (
            thinLiterature.length === 0 ? (
              <EmptyState
                message="No cell is evidence-exhausted. A cell appears here only after every one of its mechanisms survives K low-novelty harvest weeks (analysis/analyzer.config.yaml exhaustion.low_novelty_attempts) — until then thin gaps stay in the research queue."
                command="analysis/harvest-history.json → npm run analyze → npm run gaps"
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {thinLiterature.map((task) => (
                  <ThinLiteratureRow key={`${task.pack}-${task.segment}`} task={task} />
                ))}
              </ul>
            )
          ) : (
            <EmptyState
              message="No authoring queue yet. Evidence-exhausted cells are routed here by the gap planner once the harvest ledger shows a gap can no longer be closed by harvesting."
              command={`npm run gaps → ${authoringQueueRel}`}
            />
          )}
        </Panel>

        {/* Interaction authoring */}
        <Panel
          title="Interaction authoring"
          subtitle="The biggest structural gap: mechanism pairs co-present in a pack but not yet connected. Each is authored by the owner as an interaction record in git — content owner-provided, never generated."
          footer={
            authoringQueue
              ? `computed from ${authoringQueueRel} + ${interactionsRel}/ · generated ${fmtDateTime(authoringQueue.generated_at)}`
              : `${authoringQueueRel} + ${interactionsRel}/`
          }
        >
          {interactionAuthoring ? (
            interactionAuthoring.pairs.length === 0 ? (
              <EmptyState
                message="No missing interaction pairs — every scored pack's member mechanisms are already connected by a relation or an authored interaction. New gaps appear here as packs grow or segments are added."
                command={`npm run gaps → ${authoringQueueRel}`}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-4">
                  <BudgetStat
                    label="missing pairs"
                    value={`${interactionAuthoring.missingCount}`}
                    hint="not yet authored"
                  />
                  <BudgetStat
                    label="authored"
                    value={`${interactionAuthoring.authoredCount}`}
                    hint={`records in ${interactionsRel}/`}
                  />
                </div>
                <ul className="flex flex-col gap-3">
                  {interactionAuthoring.pairs.map((pair) => (
                    <InteractionPairRow
                      key={pair.filename}
                      pair={pair}
                      interactionsRel={interactionsRel}
                      nodeA={nodeIndex.get(pair.pair[0])}
                      nodeB={nodeIndex.get(pair.pair[1])}
                    />
                  ))}
                </ul>
              </div>
            )
          ) : (
            <EmptyState
              message="No authoring queue yet. The gap planner routes structural gaps — the interaction pairs no harvest can close — into an owner-facing authoring queue."
              command={`npm run gaps → ${authoringQueueRel}`}
            />
          )}
        </Panel>

        {/* Maturation log */}
        <Panel
          title="Maturation log"
          subtitle="Each weekly turn of the loop: cells that flipped status, packs regenerated, and the spend — recorded from the workflow's own artifacts."
          footer={
            log
              ? `computed from ${logRel} · ${log.entries.length} week${log.entries.length === 1 ? "" : "s"} recorded`
              : logRel
          }
        >
          {log && log.entries.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {maturationEntriesNewestFirst(log).map((entry) => (
                <LogEntry key={entry.week + entry.generated_at} entry={entry} />
              ))}
            </ul>
          ) : (
            <EmptyState
              message="No maturation weeks recorded yet. The first entry appears after the weekly loop (Monday 07:00 UTC, or a manual dispatch) commits its first run."
              command=".github/workflows/maturation.yml → analysis/maturation-log.json"
            />
          )}
        </Panel>

        {/* Segments evolving */}
        <Panel
          title="Segments are evolving"
          subtitle="The columns of this matrix are not fixed — the product-segment axis grows as the analyzer and owner add segments."
          footer={
            provenance
              ? `computed from ${segmentsRel}${candidates ? ` + ${candidatesRel}` : ""}`
              : segmentsRel
          }
        >
          {provenance ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm leading-relaxed text-[#8CA495]">
                <span className="font-mono text-[#E6EFE8]">{provenance.activeCount}</span>{" "}
                active segment{provenance.activeCount === 1 ? "" : "s"} classify the
                output products Ventora builds
                {provenance.retiredCount > 0
                  ? `, plus ${provenance.retiredCount} retired (kept for history)`
                  : ""}
                . As the matrix teaches us where segment-specific evidence is
                thin, new segments arrive with provenance{" "}
                <span className="font-mono text-[#E6EFE8]">analyzer</span> or{" "}
                <span className="font-mono text-[#E6EFE8]">owner</span> — and this
                grid gains columns.
              </p>
              <div className="flex flex-wrap gap-2">
                {provenance.byProvenance.map((p) => (
                  <span
                    key={p.provenance}
                    className="rounded border border-[#243329] bg-[#1A2620] px-2 py-1 font-mono text-[11px] text-[#8CA495]"
                  >
                    {p.provenance}{" "}
                    <span className="text-[#E6EFE8]">{p.count}</span>
                  </span>
                ))}
              </div>
              <div className="border-t border-[#243329] pt-3">
                <p className="text-sm leading-relaxed text-[#8CA495]">
                  <span className="font-mono text-xs uppercase tracking-wider text-[#7C93A8]">
                    suggestion queue ·{" "}
                  </span>
                  {candidates ? (
                    candidates.proposed > 0 ? (
                      <>
                        <span className="font-mono text-[#E6EFE8]">
                          {candidates.proposed}
                        </span>{" "}
                        segment candidate
                        {candidates.proposed === 1 ? "" : "s"} awaiting owner
                        approval in{" "}
                        <span className="font-mono text-xs text-[#E6EFE8]">
                          {candidatesRel}
                        </span>
                        . On approval a candidate is hand-added to segments.yaml
                        with provenance{" "}
                        <span className="font-mono text-[#E6EFE8]">analyzer</span>{" "}
                        and enters this grid all-red.
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-[#E6EFE8]">0</span>{" "}
                        candidates — segment-suggest is designed but not scheduled
                        yet (D-054). Proposals will appear in{" "}
                        <span className="font-mono text-xs text-[#E6EFE8]">
                          {candidatesRel}
                        </span>{" "}
                        for owner approval. The owner can also add a segment to{" "}
                        <span className="font-mono text-xs text-[#E6EFE8]">
                          {segmentsRel}
                        </span>{" "}
                        directly — it enters this grid all-red on the next
                        analyzer run.
                      </>
                    )
                  ) : (
                    <>
                      No candidates queue on disk yet — segment-suggest is
                      designed but not scheduled (D-054). The owner adds segments
                      to{" "}
                      <span className="font-mono text-xs text-[#E6EFE8]">
                        {segmentsRel}
                      </span>{" "}
                      directly today.
                    </>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <EmptyState
              message="No segments file on disk. The product-segment axis lives in git and defines this matrix's columns."
              command={`${segmentsRel} (edited in git, D-047)`}
            />
          )}
        </Panel>

        {/* Pack export bundle (D-068) — the committed team-testing artifact */}
        <Panel
          title="Pack export — team testing"
          subtitle="The committed export artifact: every pack datasheet bundled into one multi-document YAML file, regenerated by every pack render. The team consumes it directly from git — versioned and diffable alongside the packs it came from (D-068)."
          footer={
            packBundle
              ? `read from ${packBundleRel} · manifest of a generated bundle — regenerated by npm run packs`
              : packBundleRel
          }
        >
          {packBundle ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <BudgetStat
                  label="packs bundled"
                  value={`${packBundle.pack_count}`}
                  hint="datasheets in the bundle"
                />
                <BudgetStat
                  label="pack-map version"
                  value={packBundle.version}
                  hint="stamped on every pack"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {packBundle.packs.map((id) => (
                  <span
                    key={id}
                    className="rounded border border-[#243329] bg-[#1A2620] px-2 py-1 font-mono text-[11px] text-[#8CA495]"
                  >
                    {id}
                  </span>
                ))}
              </div>
              <p className="text-sm leading-relaxed text-[#8CA495]">
                Handoff path:{" "}
                <span className="font-mono text-xs text-[#E6EFE8]">{packBundleRel}</span>{" "}
                in git. The bundle is a pure function of the packs on disk — it
                only changes when a pack changes, so a week-over-week diff of
                this one file shows exactly what the team's guidance gained.
              </p>
            </div>
          ) : (
            <EmptyState
              message="No export bundle on disk yet. It appears after the next pack render and is consumed from git by the team — one multi-document YAML file carrying the manifest plus every pack datasheet."
              command={`npm run packs → ${packBundleRel}`}
            />
          )}
        </Panel>
      </div>
    </main>
  );
}

function BudgetStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-md border border-[#243329] bg-[#1A2620] px-3 py-2">
      <p className="font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
        {label}
      </p>
      <p className="mt-0.5 font-mono text-sm text-[#E6EFE8]">{value}</p>
      <p className="font-mono text-[11px] text-[#8CA495]">{hint}</p>
    </div>
  );
}

/** Cap on authoring rows shown inline; the rest live in the queue file. */
const MAX_AUTHORING_ROWS = 10;

function ExtractionQueueRow({
  task,
  node,
}: {
  task: ExtractionTask;
  node: MechanismNodeRef | undefined;
}) {
  const criteria = Array.from(
    new Set(task.source_cells.flatMap((cell) => cell.criteria)),
  );
  return (
    <li className="rounded-md border border-[#243329] bg-[#1A2620] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-[#34D399]">{task.mechanism}</span>
          <NodeBadge node={node} />
          <span className="font-mono text-[11px] uppercase tracking-wider text-[#E4B54E]">
            {task.mode}
          </span>
        </div>
        <span className="font-mono text-[11px] text-[#7C93A8]">
          importance {task.importance}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">{task.reason}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {criteria.map((criterion) => (
          <span
            key={criterion}
            className="rounded border border-[#243329] bg-[#0E1512] px-1.5 py-0.5 font-mono text-[11px] text-[#8CA495]"
          >
            {criterion.split("_").join(" ")}
          </span>
        ))}
      </div>
    </li>
  );
}

/** One authoring-queue task: pack×segment, its structural gaps typed by route. */
function AuthoringQueueRow({ task }: { task: AuthoringTask }) {
  return (
    <li className="rounded-md border border-[#243329] bg-[#1A2620] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-[#8CA495]">
            {task.pack} <span className="text-[#7C93A8]">×</span> {task.segment}
          </span>
          <span
            className="font-mono text-[11px]"
            style={{ color: CELL_STATUS_META[task.status].color }}
          >
            {CELL_STATUS_META[task.status].label}
          </span>
          {task.alternative_fill && (
            <span className="font-mono text-[11px]" style={{ color: CELL_EXHAUSTED_META.color }}>
              {CELL_EXHAUSTED_META.label}
            </span>
          )}
        </div>
        <span className="font-mono text-[11px] text-[#7C93A8]">
          importance {task.importance}
        </span>
      </div>
      {task.structural_gaps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {task.structural_gaps.map((gap) => (
            <span
              key={gap.criterion}
              className="inline-flex items-center gap-1.5 rounded border border-[#243329] bg-[#0E1512] px-1.5 py-0.5 font-mono text-[11px] text-[#8CA495]"
            >
              {typedGapLabel(gap)}
              <span
                className="text-[10px] uppercase tracking-wider"
                style={{ color: FIX_TYPE_META[gap.fix_type].color }}
              >
                {FIX_TYPE_META[gap.fix_type].label}
              </span>
            </span>
          ))}
        </div>
      )}
      {task.alternative_fill && (task.fill_options ?? []).length > 0 && (
        <p className="mt-2 font-mono text-[11px] text-[#8CA495]">
          alternative fillers:{" "}
          <span className="text-[#E6EFE8]">
            {(task.fill_options ?? [])
              .map((option) => ALTERNATIVE_FILL_META[option].label)
              .join(" · ")}
          </span>
        </p>
      )}
    </li>
  );
}

function QueueTask({
  task,
  node,
}: {
  task: ResearchTask;
  node: MechanismNodeRef | undefined;
}) {
  const cell = task.gap_cell;
  return (
    <li className="rounded-md border border-[#243329] bg-[#1A2620] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-[#34D399]">{task.mechanism}</span>
          <NodeBadge node={node} />
          <span className="font-mono text-xs text-[#8CA495]">
            {cell.pack} <span className="text-[#7C93A8]">×</span> {task.segment}
          </span>
          <span
            className="font-mono text-[11px]"
            style={{ color: CELL_STATUS_META[cell.status].color }}
          >
            {CELL_STATUS_META[cell.status].label}
          </span>
        </div>
        <span className="font-mono text-[11px] text-[#7C93A8]">
          importance {task.importance}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">{task.reason}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {task.suggested_evidence_terms.map((term) => (
          <span
            key={term}
            className="rounded border border-[#243329] bg-[#0E1512] px-1.5 py-0.5 font-mono text-[11px] text-[#8CA495]"
          >
            {term}
          </span>
        ))}
      </div>
    </li>
  );
}

function ThinLiteratureRow({ task }: { task: AuthoringTask }) {
  const ex = task.exhaustion;
  const bestScores = ex
    ? (Object.entries(ex.best_scores) as [SufficiencyCriterion, number][])
    : [];
  return (
    <li className="rounded-md border border-[#243329] bg-[#1A2620] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-[#8CA495]">
            {task.pack} <span className="text-[#7C93A8]">×</span> {task.segment}
          </span>
          <span className="font-mono text-[11px]" style={{ color: CELL_EXHAUSTED_META.color }}>
            {CELL_EXHAUSTED_META.label}
          </span>
        </div>
        {ex && (
          <span className="font-mono text-[11px] text-[#7C93A8]">
            {ex.attempts} low-novelty harvest{ex.attempts === 1 ? "" : "s"} · {ex.weeks} wk · since{" "}
            {ex.since}
          </span>
        )}
      </div>
      {bestScores.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {bestScores.map(([criterion, value]) => (
            <span
              key={criterion}
              className="rounded border border-[#243329] bg-[#0E1512] px-1.5 py-0.5 font-mono text-[11px] text-[#8CA495]"
            >
              {criterion.replace(/_/g, " ")}{" "}
              <span className="text-[#E6EFE8]">{fmtScore(value)}</span>
            </span>
          ))}
        </div>
      )}
      <p className="mt-2 font-mono text-[11px] text-[#8CA495]">
        alternative fillers:{" "}
        <span className="text-[#E6EFE8]">
          {(task.fill_options ?? [])
            .map((option) => ALTERNATIVE_FILL_META[option].label)
            .join(" · ")}
        </span>
      </p>
    </li>
  );
}

function InteractionPairRow({
  pair,
  interactionsRel,
  nodeA,
  nodeB,
}: {
  pair: InteractionAuthoringPair;
  interactionsRel: string;
  nodeA: MechanismNodeRef | undefined;
  nodeB: MechanismNodeRef | undefined;
}) {
  const meta = INTERACTION_AUTHORING_META[pair.authored ? "authored" : "not_authored"];
  return (
    <li className="rounded-md border border-[#243329] bg-[#1A2620] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-[#34D399]">{pair.pair[0]}</span>
          <NodeBadge node={nodeA} />
          <span className="text-[#7C93A8]">×</span>
          <span className="font-mono text-xs text-[#34D399]">{pair.pair[1]}</span>
          <NodeBadge node={nodeB} />
          <span className="font-mono text-[11px]" style={{ color: meta.color }}>
            {meta.label}
            {pair.authored && pair.type ? ` · ${pair.type}` : ""}
          </span>
        </div>
        <span className="font-mono text-[11px] text-[#7C93A8]">
          importance {pair.importance}
        </span>
      </div>
      <p className="mt-2 font-mono text-[11px] text-[#8CA495]">
        author{" "}
        <span className="text-[#E6EFE8]">
          {interactionsRel}/{pair.filename}
        </span>
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {pair.cells.map((cell) => (
          <span
            key={`${cell.pack}-${cell.segment}`}
            className="inline-flex items-center gap-1.5 rounded border border-[#243329] bg-[#0E1512] px-1.5 py-0.5 font-mono text-[11px] text-[#8CA495]"
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: CELL_STATUS_META[cell.status].color }}
            />
            {cell.pack} <span className="text-[#7C93A8]">×</span> {cell.segment}
          </span>
        ))}
      </div>
    </li>
  );
}

function StatusFlip({ status }: { status: SufficiencyStatus }) {
  return (
    <span className="font-mono text-[11px]" style={{ color: CELL_STATUS_META[status].color }}>
      {CELL_STATUS_META[status].label}
    </span>
  );
}

function LogEntry({ entry }: { entry: MaturationLogEntry }) {
  return (
    <li className="rounded-md border border-[#243329] bg-[#1A2620] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-xs text-[#E6EFE8]">week {entry.week}</span>
        <span className="font-mono text-[11px] text-[#7C93A8]">
          {entry.spend.calls} calls · ${entry.spend.usd}
          {entry.deferred > 0 ? ` · ${entry.deferred} deferred` : ""}
          {entry.extraction_dispatched
            ? ` · ${entry.extraction_dispatched} extracted`
            : ""}
          {entry.extraction_deferred
            ? ` · ${entry.extraction_deferred} extraction deferred`
            : ""}
          {entry.low_novelty_harvests && entry.low_novelty_harvests > 0
            ? ` · ${entry.low_novelty_harvests} low-novelty`
            : ""}
          {entry.evidence_exhausted && entry.evidence_exhausted > 0
            ? ` · ${entry.evidence_exhausted} exhausted`
            : ""}
        </span>
      </div>
      {entry.cells_changed.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {entry.cells_changed.map((c) => (
            <li key={`${c.pack}-${c.segment}`} className="font-mono text-[11px] text-[#8CA495]">
              {c.pack} <span className="text-[#7C93A8]">×</span> {c.segment}:{" "}
              <StatusFlip status={c.from} /> <span className="text-[#7C93A8]">→</span>{" "}
              <StatusFlip status={c.to} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 font-mono text-[11px] text-[#7C93A8]">
          no cell changed status this week
        </p>
      )}
      <p className="mt-2 font-mono text-[11px] text-[#8CA495]">
        packs regenerated:{" "}
        <span className="text-[#E6EFE8]">
          {entry.packs_regenerated.length > 0
            ? entry.packs_regenerated.join(", ")
            : "none"}
        </span>
      </p>
    </li>
  );
}

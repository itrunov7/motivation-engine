import Link from "next/link";
import {
  CELL_NOT_ANALYZED_META,
  CELL_STATUS_META,
  CELL_STATUS_ORDER,
  INTERACTION_AUTHORING_META,
  SEGMENT_EVIDENCE_META,
  needsSegmentHarvest,
} from "@/lib/status";
import {
  MATURATION_PATHS,
  SEGMENT_GROUP_LABEL,
  buildHeatmap,
  computeCoverage,
  computeInteractionAuthoring,
  computeSegmentCandidates,
  computeSegmentProvenance,
  loadAuthoredInteractions,
  loadAuthoringQueue,
  loadMaturationLog,
  loadPackMap,
  loadResearchQueue,
  loadSegmentCandidates,
  loadSegmentsFile,
  loadSufficiencyMatrix,
  maturationEntriesNewestFirst,
  repoRelative,
  statusBreakdown,
  type Coverage,
  type Heatmap,
  type InteractionAuthoringPair,
  type StatusCounts,
} from "@/lib/maturation";
import type {
  MaturationLogEntry,
  ResearchTask,
  SufficiencyCell,
  SufficiencyCriterion,
  SufficiencyStatus,
} from "@/lib/types";

export const metadata = {
  title: "Maturation — Motivation Engine",
};

/** Display labels for the 5 sufficiency criteria (order matches the tooltip). */
const CRITERIA: { key: SufficiencyCriterion; label: string }[] = [
  { key: "dissent_completeness", label: "dissent completeness" },
  { key: "grade_sufficiency", label: "grade sufficiency" },
  { key: "interaction_coverage", label: "interaction coverage" },
  { key: "context_coverage", label: "context coverage" },
  { key: "freshness", label: "freshness" },
];

function fmtScore(value: number): string {
  return value.toFixed(2);
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

// ---------- Coverage ----------

/** A worst→best stacked bar; widths are shares of scored cells (computed). */
function CoverageBar({ counts }: { counts: StatusCounts }) {
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-[#0E1512]">
      {CELL_STATUS_ORDER.map((status) => {
        const share = counts.total === 0 ? 0 : (counts[status] / counts.total) * 100;
        if (share === 0) return null;
        return (
          <div
            key={status}
            style={{ width: `${share}%`, backgroundColor: CELL_STATUS_META[status].color }}
            title={`${CELL_STATUS_META[status].label}: ${counts[status]}`}
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
  const { overall } = coverage;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-mono text-xs uppercase tracking-wider text-[#7C93A8]">
            overall green
          </span>
          <span className="font-display text-2xl font-semibold text-[#34D399]">
            {overall.pctGreen}%
          </span>
        </div>
        <div className="mt-2">
          <CoverageBar counts={overall} />
        </div>
        <div className="mt-2 flex flex-wrap gap-4">
          {statusBreakdown(overall).map(({ status, count }) => (
            <span key={status} className="inline-flex items-center gap-1.5 font-mono text-xs text-[#8CA495]">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: CELL_STATUS_META[status].color }}
              />
              {CELL_STATUS_META[status].label} {count}
            </span>
          ))}
          <span className="font-mono text-xs text-[#7C93A8]">
            {overall.total} cells scored
          </span>
        </div>
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

function CellTooltip({
  pack,
  segment,
  cell,
}: {
  pack: string;
  segment: string;
  cell: SufficiencyCell | null;
}) {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-64 -translate-x-1/2 rounded-md border border-[#243329] bg-[#0E1512] p-3 text-left shadow-lg group-hover:block">
      <p className="font-mono text-[11px] text-[#E6EFE8]">
        {pack} <span className="text-[#7C93A8]">×</span> {segment}
      </p>
      {cell ? (
        <>
          <p className="mt-1 font-mono text-[11px]" style={{ color: CELL_STATUS_META[cell.status].color }}>
            {CELL_STATUS_META[cell.status].label}
          </p>
          <dl className="mt-2 flex flex-col gap-1">
            {CRITERIA.map(({ key, label }) => {
              const isGap = cell.gaps.includes(key);
              return (
                <div key={key} className="flex items-baseline justify-between gap-2">
                  <dt
                    className="font-mono text-[11px]"
                    style={{ color: isGap ? CELL_STATUS_META.red.color : "#8CA495" }}
                  >
                    {label}
                    {isGap ? " ·gap" : ""}
                  </dt>
                  <dd className="font-mono text-[11px] text-[#E6EFE8]">
                    {fmtScore(cell.scores[key])}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p
            className="mt-2 border-t border-[#243329] pt-2 font-mono text-[11px]"
            style={{ color: SEGMENT_EVIDENCE_META[cell.segment_evidence].color }}
            title={SEGMENT_EVIDENCE_META[cell.segment_evidence].description}
          >
            evidence: {SEGMENT_EVIDENCE_META[cell.segment_evidence].label}
          </p>
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
}: {
  pack: string;
  segment: string;
  cell: SufficiencyCell | null;
}) {
  const color = cell ? CELL_STATUS_META[cell.status].color : CELL_NOT_ANALYZED_META.color;
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
      <CellTooltip pack={pack} segment={segment} cell={cell} />
    </div>
  );
}

function HeatmapTable({ heatmap }: { heatmap: Heatmap }) {
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
          {heatmap.rows.map((row) => (
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
                  />
                </td>
              ))}
            </tr>
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

// ---------- Page ----------

export default function MaturationPage() {
  const matrix = loadSufficiencyMatrix();
  const queue = loadResearchQueue();
  const authoringQueue = loadAuthoringQueue();
  const log = loadMaturationLog();
  const segmentsFile = loadSegmentsFile();
  const candidatesQueue = loadSegmentCandidates();
  const packMap = loadPackMap();

  const coverage = matrix ? computeCoverage(matrix) : null;
  const heatmap = matrix ? buildHeatmap(matrix, packMap, segmentsFile) : null;
  const provenance = segmentsFile ? computeSegmentProvenance(segmentsFile) : null;
  const candidates = candidatesQueue ? computeSegmentCandidates(candidatesQueue) : null;
  const interactionAuthoring = authoringQueue
    ? computeInteractionAuthoring(authoringQueue, loadAuthoredInteractions())
    : null;

  const matrixRel = repoRelative(MATURATION_PATHS.matrix);
  const queueRel = repoRelative(MATURATION_PATHS.queue);
  const authoringQueueRel = repoRelative(MATURATION_PATHS.authoringQueue);
  const interactionsRel = repoRelative(MATURATION_PATHS.interactionsDir);
  const logRel = repoRelative(MATURATION_PATHS.log);
  const segmentsRel = repoRelative(MATURATION_PATHS.segments);
  const candidatesRel = repoRelative(MATURATION_PATHS.segmentCandidates);

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
        {coverage && (
          <span className="rounded-full border border-[#243329] bg-[#1A2620] px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-[#8CA495]">
            {coverage.overall.pctGreen}% green
          </span>
        )}
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
      </div>

      <div className="mt-8 flex flex-col gap-6">
        {/* Coverage */}
        <Panel
          title="Coverage summary"
          subtitle="Share of scored pack × segment cells that are green — overall, per pack, per segment."
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
          subtitle="Packs (rows) × active segments (columns). Cell color = computed status; hover for the 5 scores, gaps, and the segment-evidence flag."
          footer={
            matrix
              ? `computed from ${matrixRel}${segmentsFile ? ` + ${segmentsRel}` : ""} · ${matrix.cells.length} cells · config ${matrix.config_version}`
              : matrixRel
          }
        >
          {heatmap ? (
            <>
              <HeatmapTable heatmap={heatmap} />
              <HeatmapLegend unscored={heatmap.unscoredSegments} />
            </>
          ) : (
            <EmptyState
              message="No sufficiency matrix on disk. Run the analyzer (or the weekly maturation loop) to score every pack against every active segment."
              command={`npm run analyze → ${matrixRel}`}
            />
          )}
        </Panel>

        {/* Research queue */}
        <Panel
          title="This week's research queue"
          subtitle="The biggest gaps in the segments that matter — ranked and budget-bounded. Each task is a targeted, segment-qualified evidence harvest."
          footer={
            queue
              ? `computed from ${queueRel} · generated ${fmtDateTime(queue.generated_at)} · from matrix ${fmtDateTime(queue.matrix_generated_at)}`
              : queueRel
          }
        >
          {queue ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                  message="The queue is empty — no red or amber cell is currently within budget to harvest. A green (saturated) matrix produces no tasks."
                  command={`npm run gaps → ${queueRel}`}
                />
              ) : (
                <ul className="flex flex-col gap-3">
                  {queue.tasks.map((task, i) => (
                    <QueueTask key={`${task.mechanism}-${task.segment}-${i}`} task={task} />
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <EmptyState
              message="No research queue yet. The gap planner ranks the matrix's red/amber cells into a budget-bounded harvest queue."
              command={`npm run gaps → ${queueRel}`}
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

function QueueTask({ task }: { task: ResearchTask }) {
  const cell = task.gap_cell;
  return (
    <li className="rounded-md border border-[#243329] bg-[#1A2620] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-[#34D399]">{task.mechanism}</span>
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

function InteractionPairRow({
  pair,
  interactionsRel,
}: {
  pair: InteractionAuthoringPair;
  interactionsRel: string;
}) {
  const meta = INTERACTION_AUTHORING_META[pair.authored ? "authored" : "not_authored"];
  return (
    <li className="rounded-md border border-[#243329] bg-[#1A2620] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-[#34D399]">{pair.pair[0]}</span>
          <span className="text-[#7C93A8]">×</span>
          <span className="font-mono text-xs text-[#34D399]">{pair.pair[1]}</span>
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

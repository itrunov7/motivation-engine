import Link from "next/link";
import { loadSources } from "@/lib/data";
import {
  CONNECTION_MODE_META,
  CONNECTION_MODE_ORDER,
  HEALTH_META,
  RUN_STATUS_META,
  SOURCE_STATE_META,
  SOURCE_STATE_ORDER,
  computeSourceHealth,
  computeSourceLastRun,
  computeSourceModeCounts,
  computeSourceState,
  formatCheckedAgo,
  formatModeCount,
  type ComputedSourceHealth,
  type ComputedSourceLastRun,
} from "@/lib/status";
import type {
  ComputedSourceState,
  ConnectionMode,
  Source,
  SourceClassId,
  SourcePriority,
} from "@/lib/types";

export const metadata = {
  title: "Sources — Motivation Engine",
};

// ---------- Filter model (URL searchParams — no client JS) ----------

interface Filters {
  class?: SourceClassId;
  priority?: SourcePriority;
  mode?: ConnectionMode;
  status?: ComputedSourceState;
}

type FilterKey = keyof Filters;

/** Build a /sources href from the current filters with one key changed. */
function filterHref(filters: Filters, key: FilterKey, value?: string): string {
  const next: Record<string, string> = {};
  for (const k of ["class", "priority", "mode", "status"] as const) {
    const v = k === key ? value : filters[k];
    if (v) next[k] = v;
  }
  const query = new URLSearchParams(next).toString();
  return query ? `/sources?${query}` : "/sources";
}

interface FlatSource extends Source {
  classId: SourceClassId;
  className: string;
  /** Connection = "is this source set up" — from corpus manifests (D-026). */
  state: ComputedSourceState;
  /** Last run = "is it working well" — newest last_run (D-026). */
  lastRun: ComputedSourceLastRun | null;
  /** Health = "is the API accessible" — from the heartbeat (D-021). */
  health: ComputedSourceHealth;
}

// ---------- Small presentational pieces ----------

function SourceStatePill({ state }: { state: ComputedSourceState }) {
  const meta = SOURCE_STATE_META[state];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider"
      style={{ color: meta.color, borderColor: `${meta.color}40` }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </span>
  );
}

function HealthPill({ health }: { health: ComputedSourceHealth }) {
  if (!health.status) {
    return <span className="font-mono text-xs text-[#7C93A8]">—</span>;
  }
  const meta = HEALTH_META[health.status];
  const checkedAgo = formatCheckedAgo(health);
  return (
    <div className="flex flex-col gap-1">
      <span
        className="inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider"
        style={{ color: meta.color, borderColor: `${meta.color}40` }}
        title={health.note ?? undefined}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: meta.color }}
        />
        {meta.label}
      </span>
      {checkedAgo && (
        <span className="whitespace-nowrap font-mono text-[10px] text-[#7C93A8]">
          {checkedAgo}
        </span>
      )}
    </div>
  );
}

/** "3h ago" / "2d ago" from an ISO timestamp; null when unparseable. */
function formatRunAgo(iso: string): string | null {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "<1h ago";
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function LastRunPill({ lastRun }: { lastRun: ComputedSourceLastRun | null }) {
  if (!lastRun) {
    return <span className="font-mono text-xs text-[#7C93A8]">—</span>;
  }
  const meta = RUN_STATUS_META[lastRun.status];
  const ago = formatRunAgo(lastRun.timestamp);
  return (
    <div className="flex flex-col gap-1">
      <span
        className="inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider"
        style={{ color: meta.color, borderColor: `${meta.color}40` }}
        title={`corpus: ${lastRun.corpusDir}`}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: meta.color }}
        />
        {meta.label}
      </span>
      {ago && (
        <span className="whitespace-nowrap font-mono text-[10px] text-[#7C93A8]">
          {ago}
        </span>
      )}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-[#243329] bg-[#1A2620] px-1.5 py-0.5 font-mono text-[11px] text-[#8CA495]">
      {children}
    </span>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={
        active
          ? "rounded-full border border-[#34D399]/40 bg-[#1A2620] px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-[#34D399]"
          : "rounded-full border border-[#243329] bg-[#151F1A] px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-[#8CA495] hover:border-[#34D399]/40 hover:text-[#E6EFE8]"
      }
    >
      {children}
    </Link>
  );
}

function FilterGroup({
  label,
  filters,
  filterKey,
  options,
}: {
  label: string;
  filters: Filters;
  filterKey: FilterKey;
  options: { value: string; label: string }[];
}) {
  const current = filters[filterKey];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 font-mono text-[10px] uppercase tracking-widest text-[#7C93A8]">
        {label}
      </span>
      <FilterChip href={filterHref(filters, filterKey, undefined)} active={!current}>
        all
      </FilterChip>
      {options.map((option) => (
        <FilterChip
          key={option.value}
          href={filterHref(
            filters,
            filterKey,
            current === option.value ? undefined : option.value,
          )}
          active={current === option.value}
        >
          {option.label}
        </FilterChip>
      ))}
    </div>
  );
}

// ---------- Table ----------

const TABLE_HEADERS = [
  "source",
  "class",
  "access",
  "cost",
  "priority",
  "phase",
  "feeds",
  "mode",
  "status",
  "last run",
  "health",
];

function SourceRow({ source }: { source: FlatSource }) {
  return (
    <tr className="border-b border-[#243329] align-top last:border-b-0">
      <td className="min-w-[220px] px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-[#7C93A8]">{source.id}</span>
          <span className="font-display text-sm font-medium text-[#E6EFE8]">
            {source.name}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-[#8CA495]">
          {source.what}
        </p>
        {source.mode_note && (
          <p className="mt-1.5 text-xs leading-relaxed text-[#7C93A8]">
            <span className="font-mono text-[10px] uppercase tracking-wider">
              mode ·{" "}
            </span>
            {source.mode_note}
          </p>
        )}
        {source.legal_note && (
          <p className="mt-1.5 text-xs leading-relaxed text-[#E4B54E]">
            <span className="font-mono text-[10px] uppercase tracking-wider">
              legal ·{" "}
            </span>
            {source.legal_note}
          </p>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-[#8CA495]">
        {source.classId} · {source.className}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5">
        <span className="font-mono text-xs text-[#E6EFE8]">
          {source.access}
        </span>
        {source.api && (
          <span className="ml-1.5 rounded border border-[#34D399]/40 px-1 py-px font-mono text-[10px] uppercase tracking-wider text-[#34D399]">
            api
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-[#8CA495]">
        {source.cost}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-[#E6EFE8]">
        {source.priority}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-[#8CA495]">
        {source.phase}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap gap-1">
          {source.feeds.map((feed) => (
            <Tag key={feed}>{feed}</Tag>
          ))}
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-[#E6EFE8]">
        {CONNECTION_MODE_META[source.connection_mode].label}
      </td>
      <td className="px-3 py-2.5">
        <SourceStatePill state={source.state} />
      </td>
      <td className="px-3 py-2.5">
        <LastRunPill lastRun={source.lastRun} />
      </td>
      <td className="px-3 py-2.5">
        <HealthPill health={source.health} />
      </td>
    </tr>
  );
}

// ---------- Page ----------

export default function SourcesPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const registry = loadSources();
  const all: FlatSource[] = registry.classes.flatMap((cls) =>
    cls.sources.map((source) => ({
      ...source,
      classId: cls.id,
      className: cls.name,
      state: computeSourceState(source),
      lastRun: computeSourceLastRun(source),
      health: computeSourceHealth(source),
    })),
  );

  const param = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : undefined;
  };

  // Only accept values that actually exist in the vocabulary — anything else
  // is treated as "no filter".
  const classIds = registry.classes.map((cls) => cls.id);
  const priorities = Array.from(new Set(all.map((s) => s.priority))).sort();
  const filters: Filters = {
    class: classIds.find((id) => id === param("class")),
    priority: priorities.find((p) => p === param("priority")),
    mode: CONNECTION_MODE_ORDER.find((m) => m === param("mode")),
    status: SOURCE_STATE_ORDER.find((s) => s === param("status")),
  };

  const filtered = all.filter(
    (source) =>
      (!filters.class || source.classId === filters.class) &&
      (!filters.priority || source.priority === filters.priority) &&
      (!filters.mode || source.connection_mode === filters.mode) &&
      (!filters.status || source.state === filters.status),
  );

  const modeCounts = computeSourceModeCounts();

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8] hover:text-[#34D399]"
          >
            ← control center
          </Link>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-[#E6EFE8]">
            Sources — the intake registry
          </h1>
          <p className="mt-1 text-sm text-[#8CA495]">
            {all.length} sources across {registry.classes.length} classes, read
            from /sources/sources.json. Three independent axes per source
            (D-026), all computed from files: status = is the source set up
            (a corpus manifest lists it), last run = is it working well
            (success / partial / failed), health = is the API accessible
            right now (/corpora/_health/heartbeat.json, D-021) — the app
            itself never calls an external API.
          </p>
        </div>
        <span className="rounded-full border border-[#243329] bg-[#1A2620] px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-[#8CA495]">
          {modeCounts
            .map(
              (count) =>
                `${CONNECTION_MODE_META[count.mode].label} ${formatModeCount(count)}`,
            )
            .join(" · ")}
        </span>
      </header>

      <section className="mt-6 flex flex-col gap-2.5 rounded-lg border border-[#243329] bg-[#151F1A] p-4">
        <FilterGroup
          label="class"
          filters={filters}
          filterKey="class"
          options={registry.classes.map((cls) => ({
            value: cls.id,
            label: `${cls.id} · ${cls.name}`,
          }))}
        />
        <FilterGroup
          label="priority"
          filters={filters}
          filterKey="priority"
          options={priorities.map((priority) => ({
            value: priority,
            label: priority,
          }))}
        />
        <FilterGroup
          label="mode"
          filters={filters}
          filterKey="mode"
          options={CONNECTION_MODE_ORDER.map((mode) => ({
            value: mode,
            label: CONNECTION_MODE_META[mode].label,
          }))}
        />
        <FilterGroup
          label="status"
          filters={filters}
          filterKey="status"
          options={SOURCE_STATE_ORDER.map((state) => ({
            value: state,
            label: SOURCE_STATE_META[state].label,
          }))}
        />
      </section>

      <section className="mt-6">
        <p className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
          {filtered.length} of {all.length} sources
        </p>
        {filtered.length === 0 ? (
          <div className="mt-3 rounded-md border border-dashed border-[#243329] bg-[#1A2620] px-4 py-5">
            <p className="text-sm leading-relaxed text-[#8CA495]">
              <span className="text-[#E6EFE8]">
                No sources match this filter combination.
              </span>{" "}
              The registry in /sources/sources.json holds {all.length} sources;
              loosen a filter above to see them.
            </p>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-[#243329] bg-[#151F1A]">
            <table className="w-full min-w-[1220px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[#243329] bg-[#1A2620]">
                  {TABLE_HEADERS.map((header) => (
                    <th
                      key={header}
                      className="px-3 py-2 font-mono text-[10px] font-normal uppercase tracking-wider text-[#7C93A8]"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((source) => (
                  <SourceRow key={source.id} source={source} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-6 text-xs leading-relaxed text-[#8CA495]">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
          mode legend ·{" "}
        </span>
        {CONNECTION_MODE_ORDER.map(
          (mode) =>
            `${CONNECTION_MODE_META[mode].label} = ${CONNECTION_MODE_META[mode].description}`,
        ).join(" · ")}
        .
      </p>

      <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
          status legend ·{" "}
        </span>
        {SOURCE_STATE_META.connected.label} = the source&apos;s connector is
        set up — a /corpora manifest lists it (regardless of how the last run
        went, D-026); {SOURCE_STATE_META.not_connected.label} = no connector
        has run for this source yet. The last-run column shows run quality
        separately: {RUN_STATUS_META.success.label} /{" "}
        {RUN_STATUS_META.partial.label} / {RUN_STATUS_META.failed.label} from
        the newest manifest run (per corpus — sources sharing a corpus share
        its run status, D-020).
      </p>

      <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
          health legend ·{" "}
        </span>
        health comes from the 6-hourly heartbeat probe
        (tools/health-check.ts), independent of connection:{" "}
        {HEALTH_META.ok.label} = API answered, {HEALTH_META.degraded.label} =
        throttled (429/206), {HEALTH_META.down.label} = network error /
        timeout / 5xx, {HEALTH_META.unknown.label} = no probe or heartbeat
        older than 12h (stale never renders as ok), {HEALTH_META.n_a.label} =
        internal source with no external endpoint. Sources without an api
        mode have no health axis (—).
      </p>

      <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
          feeds legend ·{" "}
        </span>
        L0–L3 are ontology levels (brain systems → mechanisms → effects →
        implementations); dossiers, effects, weights, and constraints are the
        loop artifacts a source feeds.
      </p>
    </main>
  );
}

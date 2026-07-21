import Link from "next/link";
import {
  CONNECTION_MODE_META,
  computeCounts,
  computeSystemBlocks,
  formatModeCount,
  STATUS_META,
  type SystemBlock,
} from "@/lib/status";

/** Blocks that already have a showcase page. */
const BLOCK_ROUTES: Record<string, string> = {
  registry: "/registry",
  // Harvested corpora live in the /connectors cockpit (manifests, run
  // history, and the D-019 category checklist).
  "corpus-interfaces-science": "/connectors",
  "corpus-reviews": "/connectors",
};

/** Every room of the Control Center, in tour order. */
const ROOMS: { href: string; label: string }[] = [
  { href: "/registry", label: "registry" },
  { href: "/sources", label: "sources" },
  { href: "/connectors", label: "connectors" },
  { href: "/ops", label: "operations" },
  { href: "/review", label: "review" },
  { href: "/maturation", label: "maturation" },
  { href: "/dossiers", label: "dossiers" },
  { href: "/decisions", label: "decisions" },
  { href: "/docs", label: "docs" },
];

function StatusPill({ status }: { status: SystemBlock["status"] }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider"
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

function BlockCard({ block }: { block: SystemBlock }) {
  const route = BLOCK_ROUTES[block.id];
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-display text-base font-medium text-[#E6EFE8]">
          {route ? (
            <Link href={route} className="hover:text-[#34D399]">
              {block.name} <span className="text-[#7C93A8]">→</span>
            </Link>
          ) : (
            block.name
          )}
        </h3>
        <StatusPill status={block.status} />
      </div>
      <p className="font-mono text-xs leading-relaxed text-[#8CA495]">
        {block.detail}
      </p>
      {block.emptyState && (
        <div className="mt-auto rounded-md border border-dashed border-[#243329] bg-[#1A2620] px-3 py-2.5">
          <p className="text-xs leading-relaxed text-[#8CA495]">
            <span className="text-[#E6EFE8]">Filled by:</span>{" "}
            {block.emptyState.filledBy}
          </p>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
            phase · {block.emptyState.phase}
          </p>
        </div>
      )}
    </div>
  );
}

function CountPanel({
  title,
  rows,
  footer,
  href,
}: {
  title: string;
  rows: { label: string; value: string | number }[];
  footer: string;
  href?: string;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <h3 className="font-display text-sm font-medium text-[#E6EFE8]">
        {href ? (
          <Link href={href} className="hover:text-[#34D399]">
            {title} <span className="text-[#7C93A8]">→</span>
          </Link>
        ) : (
          title
        )}
      </h3>
      <dl className="mt-3 flex flex-col gap-1.5">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-4"
          >
            <dt className="font-mono text-xs text-[#8CA495]">{row.label}</dt>
            <dd className="font-mono text-sm text-[#E6EFE8]">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-auto pt-3 font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
        {footer}
      </p>
    </div>
  );
}

export default function Overview() {
  const blocks = computeSystemBlocks();
  const counts = computeCounts();

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#E6EFE8]">
            Motivation Engine — Control Center
          </h1>
          <p className="mt-1 text-sm text-[#8CA495]">
            Ventora&apos;s knowledge layer: science → mechanisms → interface
            implementations.
          </p>
        </div>
        <span className="rounded-full border border-[#243329] bg-[#1A2620] px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-[#8CA495]">
          baseline
        </span>
      </header>

      <nav className="mt-4 flex flex-wrap items-center gap-2">
        {ROOMS.map((room) => (
          <Link
            key={room.href}
            href={room.href}
            className="rounded-full border border-[#243329] bg-[#151F1A] px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-[#8CA495] hover:border-[#34D399]/40 hover:text-[#34D399]"
          >
            {room.label}
          </Link>
        ))}
      </nav>

      <div className="mt-6 rounded-lg border border-[#34D399]/25 bg-[#1A2620] px-4 py-3">
        <p className="text-sm leading-relaxed text-[#8CA495]">
          <span className="font-mono text-xs uppercase tracking-wider text-[#34D399]">
            honesty rule ·{" "}
          </span>
          Every status on this screen is computed at render time from files in
          the repo — the file system and the data files. Nothing is asserted in
          code; the showcase can never look more finished than the shelves
          actually are.
        </p>
      </div>

      <section className="mt-8">
        <h2 className="font-mono text-xs uppercase tracking-widest text-[#7C93A8]">
          system map
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {blocks.map((block) => (
            <BlockCard key={block.id} block={block} />
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-mono text-xs uppercase tracking-widest text-[#7C93A8]">
          live counts — pulled from files
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <CountPanel
            title="Mechanisms by lifecycle"
            rows={counts.mechanismsByLifecycle.map((r) => ({
              label: r.status,
              value: r.count,
            }))}
            footer={`${counts.mechanismsTotal} total · /registry/mechanisms`}
            href="/registry"
          />
          <CountPanel
            title="Sources by mode"
            rows={counts.sourcesByMode.map((count) => ({
              label: CONNECTION_MODE_META[count.mode].label,
              value: formatModeCount(count),
            }))}
            footer={`${counts.sourcesTotal} total · /sources/sources.json`}
            href="/sources"
          />
          <CountPanel
            title="Decisions"
            rows={[{ label: "logged", value: counts.decisionsCount }]}
            footer="/decisions/decisions.json"
            href="/decisions"
          />
          <CountPanel
            title="Proposal review"
            rows={counts.proposalsByStatus.map((row) => ({
              label: row.label,
              value: row.count,
            }))}
            footer={`${counts.proposalsTotal} total · /proposals/{type}`}
            href="/review"
          />
        </div>
      </section>
    </main>
  );
}

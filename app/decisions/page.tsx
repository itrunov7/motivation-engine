import Link from "next/link";
import { loadDecisions } from "@/lib/data";
import type { Decision } from "@/lib/types";

export const metadata = {
  title: "Decisions — Motivation Engine",
};

function DecisionCard({ decision }: { decision: Decision }) {
  return (
    <article className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-[#34D399]">
            {decision.id}
          </span>
          <span className="font-mono text-xs text-[#7C93A8]">
            {decision.date}
          </span>
        </div>
        <span className="rounded border border-[#243329] bg-[#1A2620] px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-[#8CA495]">
          {decision.area}
        </span>
      </div>
      <h2 className="mt-2 font-display text-base font-medium text-[#E6EFE8]">
        {decision.title}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-[#8CA495]">
        {decision.body}
      </p>
    </article>
  );
}

export default function DecisionsPage() {
  const decisions = [...loadDecisions().decisions].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8] hover:text-[#34D399]"
          >
            ← control center
          </Link>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-[#E6EFE8]">
            Decisions — the paper trail
          </h1>
          <p className="mt-1 text-sm text-[#8CA495]">
            Every architectural decision, newest first, read from
            /decisions/decisions.json. Each entry lands in the same PR as the
            change it justifies.
          </p>
        </div>
        <span className="rounded-full border border-[#243329] bg-[#1A2620] px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-[#8CA495]">
          {decisions.length} logged
        </span>
      </header>

      <div className="mt-8 flex flex-col gap-4">
        {decisions.length === 0 ? (
          <div className="rounded-md border border-dashed border-[#243329] bg-[#1A2620] px-4 py-5">
            <p className="text-sm leading-relaxed text-[#8CA495]">
              <span className="text-[#E6EFE8]">No decisions logged yet.</span>{" "}
              Filled by /decisions/decisions.json — one entry per architectural
              decision, in the same PR as the change.
            </p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
              phase · July
            </p>
          </div>
        ) : (
          decisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))
        )}
      </div>
    </main>
  );
}

import Link from "next/link";
import { loadDossiers } from "@/lib/data";
import type { Dossier, DossierScores } from "@/lib/types";

export const metadata = {
  title: "Dossiers — Motivation Engine",
};

/**
 * The five scoring axes, in schema order (/dossiers/dossier.schema.json).
 * Each is an integer 0–3; the gate thresholds below are quoted from the
 * schema description — the page explains the gate, it never scores anything.
 */
const AXES: (keyof DossierScores)[] = [
  "evidence",
  "product_applicability",
  "measurability",
  "orthogonality",
  "safety",
];

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-mono text-xs uppercase tracking-widest text-[#7C93A8]">
      {children}
    </h2>
  );
}

// ---------- Rendered only once real dossiers exist in /dossiers ----------

function DossierCard({ dossier }: { dossier: Dossier }) {
  return (
    <article className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-[#34D399]">{dossier.id}</span>
          <span className="font-mono text-xs text-[#E6EFE8]">
            {dossier.mechanism_id}
          </span>
          <span className="font-mono text-xs text-[#7C93A8]">
            {dossier.date}
          </span>
        </div>
        <span className="rounded border border-[#243329] bg-[#1A2620] px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-[#E6EFE8]">
          {dossier.verdict}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-6">
        {AXES.map((axis) => (
          <div key={axis} className="flex flex-col gap-0.5">
            <dt className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
              {axis.replace(/_/g, " ")}
            </dt>
            <dd className="font-mono text-sm text-[#E6EFE8]">
              {dossier.scores[axis]}/3
            </dd>
          </div>
        ))}
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
            total
          </dt>
          <dd className="font-mono text-sm text-[#34D399]">
            {dossier.total}/15
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-sm leading-relaxed text-[#8CA495]">
        {dossier.notes}
      </p>
      <p className="mt-2 font-mono text-[11px] text-[#7C93A8]">
        decided by {dossier.decided_by} · {dossier.evidence_sources.length}{" "}
        evidence source{dossier.evidence_sources.length === 1 ? "" : "s"}
      </p>
    </article>
  );
}

// ---------- The designed empty state (SPEC §4) ----------

function GateExplainer() {
  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
        <SectionLabel>the 5-axis gate</SectionLabel>
        <p className="mt-3 text-sm leading-relaxed text-[#8CA495]">
          A dossier is the only way a mechanism moves through the lifecycle
          (candidate → incubating → core). The owner scores the mechanism on
          five axes, each an integer 0–3:
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {AXES.map((axis) => (
            <span
              key={axis}
              className="rounded border border-[#243329] bg-[#1A2620] px-2.5 py-1 font-mono text-xs text-[#E6EFE8]"
            >
              {axis.replace(/_/g, " ")}{" "}
              <span className="text-[#7C93A8]">0–3</span>
            </span>
          ))}
        </div>
        <p className="mt-3 text-sm leading-relaxed text-[#8CA495]">
          The record also carries evidence sources, a verdict (incubating,
          core, rejected, or hold), who decided, the date, and notes — the full
          shape is /dossiers/dossier.schema.json.
        </p>
      </section>

      <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
        <SectionLabel>thresholds</SectionLabel>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-[#E4B54E]/30 bg-[#1A2620] px-4 py-3">
            <p className="font-mono text-[11px] uppercase tracking-wider text-[#E4B54E]">
              to enter incubating
            </p>
            <p className="mt-1.5 font-mono text-xs leading-relaxed text-[#E6EFE8]">
              total ≥ 11 AND evidence ≥ 2 AND safety ≥ 2
            </p>
          </div>
          <div className="rounded-md border border-[#34D399]/30 bg-[#1A2620] px-4 py-3">
            <p className="font-mono text-[11px] uppercase tracking-wider text-[#34D399]">
              to enter core
            </p>
            <p className="mt-1.5 font-mono text-xs leading-relaxed text-[#E6EFE8]">
              incubating thresholds + at least one measured effect
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[#8CA495]">
          Measured effects come from our telemetry loop or public corpora. The
          validator enforces the schema and that total equals the sum of the
          five axis scores; the thresholds are enforced by the validator and
          the owner at decision time.
        </p>
      </section>

      <div className="rounded-lg border border-dashed border-[#243329] bg-[#1A2620] px-5 py-4">
        <p className="text-sm leading-relaxed text-[#8CA495]">
          <span className="text-[#E6EFE8]">No dossiers exist yet</span> — the
          folder ships with the schema only, and this page will list scored
          records as they land.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-[#8CA495]">
          <span className="text-[#E6EFE8]">Next milestone:</span> the first
          dossier — LA-01 (Loss aversion), the one mechanism that already has a
          full registry record. Its dossier decides whether it stays
          incubating or earns core.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-[#8CA495]">
          <span className="text-[#E6EFE8]">Filled by:</span> owner decisions
          entered in git as /dossiers/*.json — never generated by code.
        </p>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
          phase · schema: July (baseline) · first dossier: next milestone after
          baseline
        </p>
      </div>
    </div>
  );
}

// ---------- Page ----------

export default function DossiersPage() {
  const dossiers = loadDossiers();

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
            Dossiers — the admission gate
          </h1>
          <p className="mt-1 text-sm text-[#8CA495]">
            Scored records that move mechanisms through lifecycle gates, read
            from /dossiers. The showcase displays verdicts; it never makes
            them.
          </p>
        </div>
        <span className="rounded-full border border-[#243329] bg-[#1A2620] px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-[#8CA495]">
          {dossiers.length} on file
        </span>
      </header>

      <div className="mt-8">
        {dossiers.length === 0 ? (
          <GateExplainer />
        ) : (
          <div className="flex flex-col gap-4">
            {dossiers.map((dossier) => (
              <DossierCard key={dossier.id} dossier={dossier} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

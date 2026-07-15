import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { loadDossiers } from "@/lib/data";
import type { Dossier, DossierScores } from "@/lib/types";

export const metadata = {
  title: "Dossiers — Motivation Engine",
};

/**
 * The five scoring axes, in schema order (/dossiers/dossier.schema.json).
 * Each is an integer 0–3 with a markdown rationale; the gate thresholds
 * below are quoted from the schema description — the page explains the gate,
 * it never scores anything.
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

/**
 * Owner prose rendered from the dossier's markdown strings (rationales,
 * dissent). Reuses the /docs markdown pipeline (react-markdown + remark-gfm)
 * so the JSON stays the single source of truth and the page renders it —
 * Option A, no separate markdown pipeline.
 */
function Prose({ children }: { children: string }) {
  return (
    <div
      className="
        text-sm leading-relaxed text-[#8CA495]
        [&_p]:mt-2 first:[&_p]:mt-0
        [&_strong]:text-[#E6EFE8]
        [&_em]:text-[#E6EFE8]
        [&_a]:text-[#34D399] [&_a]:underline [&_a]:underline-offset-2
        [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:marker:text-[#7C93A8]
        [&_ol]:mt-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:marker:text-[#7C93A8]
        [&_li]:mt-1
        [&_code]:rounded [&_code]:bg-[#1A2620] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-[#E6EFE8]
      "
    >
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
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
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm text-[#34D399]">
            {dossier.total}/15
          </span>
          <span className="rounded border border-[#243329] bg-[#1A2620] px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-[#E6EFE8]">
            {dossier.verdict}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-col divide-y divide-[#243329]/60">
        {AXES.map((axis) => {
          const entry = dossier.scores[axis];
          return (
            <div key={axis} className="py-3 first:pt-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
                  {axis.replace(/_/g, " ")}
                </span>
                <span className="font-mono text-sm text-[#E6EFE8]">
                  {entry.score}/3
                </span>
              </div>
              <div className="mt-1.5">
                <Prose>{entry.rationale}</Prose>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-md border border-[#34D399]/30 bg-[#1A2620] px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wider text-[#34D399]">
          core condition
        </p>
        <div className="mt-1.5">
          <Prose>{dossier.core_condition}</Prose>
        </div>
      </div>

      <div className="mt-4 rounded-md border border-[#E4B54E]/30 bg-[#1A2620] px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wider text-[#E4B54E]">
          dissent
        </p>
        <div className="mt-1.5">
          <Prose>{dossier.dissent}</Prose>
        </div>
      </div>

      {dossier.evidence_sources.length > 0 && (
        <div className="mt-4">
          <p className="font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
            evidence sources · {dossier.evidence_sources.length}
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {dossier.evidence_sources.map((source) => (
              <li
                key={source.ref}
                className="text-xs leading-relaxed text-[#8CA495]"
              >
                <span>{source.ref}</span>
                {source.doi && (
                  <>
                    {" "}
                    <a
                      href={`https://doi.org/${source.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[#34D399] underline underline-offset-2"
                    >
                      {source.doi}
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {dossier.notes && (
        <p className="mt-4 text-sm leading-relaxed text-[#8CA495]">
          {dossier.notes}
        </p>
      )}

      <p className="mt-3 font-mono text-[11px] text-[#7C93A8]">
        decided by {dossier.decided_by}
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
          Each axis carries a markdown rationale, and the record also carries a
          dissent statement, a core-promotion condition, evidence sources, a
          verdict (incubating, core, rejected, or hold), who decided, the date,
          and notes — the full shape is /dossiers/dossier.schema.json.
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
          folder ships with the schema only, and this page lists scored records
          as they land.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-[#8CA495]">
          <span className="text-[#E6EFE8]">Filled by:</span> owner decisions
          entered in git as /dossiers/*.json — never generated by code.
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

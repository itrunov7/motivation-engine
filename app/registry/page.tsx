import Link from "next/link";
import {
  computeRegistryTree,
  LIFECYCLE_META,
  LIFECYCLE_ORDER,
  type RegistryChild,
  type RegistryNode,
} from "@/lib/status";
import type {
  LifecycleStatus,
  Mechanism,
  SeedStub,
  TaxonomyNode,
} from "@/lib/types";

export const metadata = {
  title: "Registry — Motivation Engine",
};

// ---------- Small presentational pieces ----------

function LifecyclePill({ status }: { status: LifecycleStatus }) {
  const meta = LIFECYCLE_META[status];
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
      {children}
    </h4>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-[#243329] bg-[#1A2620] px-1.5 py-0.5 font-mono text-[11px] text-[#8CA495]">
      {children}
    </span>
  );
}

// ---------- Lifecycle legend ----------

function LifecycleLegend() {
  const path = LIFECYCLE_ORDER.slice(0, 3);
  const exits = LIFECYCLE_ORDER.slice(3);
  return (
    <div className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <h2 className="font-mono text-xs uppercase tracking-widest text-[#7C93A8]">
        lifecycle legend
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {path.map((status, i) => (
          <span key={status} className="flex items-center gap-2">
            {i > 0 && <span className="text-[#8CA495]">→</span>}
            <LifecyclePill status={status} />
          </span>
        ))}
        <span className="mx-1 text-[#243329]">|</span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-[#8CA495]">
          side exits:
        </span>
        {exits.map((status) => (
          <LifecyclePill key={status} status={status} />
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-[#8CA495]">
        Transitions happen only via dossiers (the 5-axis admission gate) — this
        page displays statuses read from the record files, it never changes
        them.
      </p>
    </div>
  );
}

// ---------- Seed stub row (gray, not expandable) ----------

function StubRow({ stub }: { stub: SeedStub }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-[#243329] bg-[#1A2620]/60 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-[#7C93A8]">{stub.id}</span>
          <span className="font-display text-sm text-[#8CA495]">
            {stub.name}
          </span>
          <span className="font-mono text-[11px] text-[#7C93A8]">
            draft grade {stub.grade_draft}
          </span>
        </div>
        <LifecyclePill status={stub.lifecycle_status} />
      </div>
      <p className="text-xs leading-relaxed text-[#7C93A8]">{stub.oneliner}</p>
      <p className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]/70">
        seed stub — full record arrives via its dossier
      </p>
    </div>
  );
}

// ---------- Full record view ----------

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
        {label}
      </dt>
      <dd className="font-mono text-xs text-[#E6EFE8]">{value}</dd>
    </div>
  );
}

function FullRecordView({
  record,
  nameById,
}: {
  record: Mechanism;
  nameById: Map<string, string>;
}) {
  return (
    <div className="flex flex-col gap-6 border-t border-[#243329] px-4 py-5">
      {/* Summary */}
      <section className="flex flex-col gap-3">
        <SectionLabel>summary</SectionLabel>
        <p className="text-sm leading-relaxed text-[#E6EFE8]">
          {record.mechanism_summary_for_context}
        </p>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KeyValue
            label="proposed by"
            value={`${record.provenance.proposed_by} · ${record.provenance.date}`}
          />
          <KeyValue label="version" value={record.version} />
          <KeyValue label="prior weight" value={String(record.prior_weight)} />
          <KeyValue
            label="dossier"
            value={record.dossier_ref ?? "no dossier yet"}
          />
        </dl>
      </section>

      {/* Evidence */}
      <section className="flex flex-col gap-3">
        <SectionLabel>evidence</SectionLabel>
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-[#34D399]/40 font-mono text-sm text-[#34D399]">
            {record.evidence.grade}
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-xs leading-relaxed text-[#E6EFE8]">
              {record.evidence.basis}
            </p>
            <p className="text-xs leading-relaxed text-[#8CA495]">
              {record.evidence.effect_size_note}
            </p>
          </div>
        </div>
        {record.evidence.caveats.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
              caveats:
            </span>
            {record.evidence.caveats.map((caveat) => (
              <Tag key={caveat}>{caveat}</Tag>
            ))}
          </div>
        )}
      </section>

      {/* Applicability */}
      <section className="flex flex-col gap-3">
        <SectionLabel>applicability</SectionLabel>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
              funnel stages:
            </span>
            {record.applicability.funnel_stages.map((stage) => (
              <Tag key={stage}>{stage}</Tag>
            ))}
          </div>
          {record.applicability.excluded_stages.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
                excluded stages:
              </span>
              {record.applicability.excluded_stages.map((stage) => (
                <Tag key={stage}>{stage}</Tag>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
              artifact types:
            </span>
            {record.applicability.artifact_types.map((type) => (
              <Tag key={type}>{type}</Tag>
            ))}
          </div>
        </div>
        {record.applicability.preconditions.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
              preconditions
            </span>
            {record.applicability.preconditions.map((pre) => (
              <div
                key={pre.predicate}
                className="rounded-md border border-[#243329] bg-[#1A2620] px-3 py-2"
              >
                <code className="font-mono text-xs text-[#E6EFE8]">
                  {pre.predicate}
                </code>
                <p className="mt-1 text-xs leading-relaxed text-[#8CA495]">
                  {pre.reason}
                </p>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs leading-relaxed text-[#8CA495]">
          <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
            culture note ·{" "}
          </span>
          {record.applicability.culture_note}
        </p>
      </section>

      {/* Implementations (L3) */}
      <section className="flex flex-col gap-3">
        <SectionLabel>
          implementations (L3) · {record.implementations.length}
        </SectionLabel>
        <div className="overflow-x-auto rounded-md border border-[#243329]">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-[#243329] bg-[#1A2620]">
                {[
                  "id",
                  "artifact types",
                  "generation directive",
                  "copy formulas",
                  "metrics",
                  "observed effects",
                ].map((header) => (
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
              {record.implementations.map((impl) => (
                <tr
                  key={impl.id}
                  className="border-b border-[#243329] last:border-b-0 align-top"
                >
                  <td className="px-3 py-2.5 font-mono text-xs text-[#E6EFE8] whitespace-nowrap">
                    {impl.id}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {impl.artifact_types.map((type) => (
                        <Tag key={type}>{type}</Tag>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs leading-relaxed text-[#8CA495] min-w-[200px]">
                    {impl.generation_directive}
                  </td>
                  <td className="px-3 py-2.5">
                    <ul className="flex flex-col gap-1">
                      {impl.copy_formulas.map((formula) => (
                        <li
                          key={formula}
                          className="font-mono text-[11px] leading-relaxed text-[#E6EFE8]"
                        >
                          &ldquo;{formula}&rdquo;
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-3 py-2.5">
                    <ul className="flex flex-col gap-1">
                      {impl.metrics.map((metric) => (
                        <li
                          key={metric}
                          className="font-mono text-[11px] text-[#8CA495]"
                        >
                          {metric}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-3 py-2.5">
                    {impl.observed_effects.length > 0 ? (
                      <ul className="flex flex-col gap-1">
                        {impl.observed_effects.map((effect) => (
                          <li
                            key={effect}
                            className="font-mono text-[11px] text-[#E6EFE8]"
                          >
                            {effect}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="font-mono text-[11px] text-[#7C93A8]">
                        none measured yet
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Constraints */}
      <section className="flex flex-col gap-3">
        <SectionLabel>hard rules</SectionLabel>
        <div className="flex flex-col gap-2">
          {record.constraints.hard_rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-start justify-between gap-3 rounded-md border border-[#243329] bg-[#1A2620] px-3 py-2"
            >
              <div>
                <span className="font-mono text-xs text-[#E6EFE8]">
                  {rule.id}
                </span>
                <p className="mt-0.5 text-xs leading-relaxed text-[#8CA495]">
                  {rule.rule}
                </p>
              </div>
              <span className="shrink-0 rounded border border-[#E4B54E]/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[#E4B54E]">
                {rule.severity}
              </span>
            </div>
          ))}
        </div>
        {record.constraints.compliance_refs.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
              compliance refs:
            </span>
            {record.constraints.compliance_refs.map((ref) => (
              <Tag key={ref}>{ref}</Tag>
            ))}
          </div>
        )}
        <div className="rounded-md border border-dashed border-[#34D399]/30 bg-[#1A2620] px-3 py-2.5">
          <p className="text-xs leading-relaxed text-[#E6EFE8]">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[#34D399]">
              boundary test ·{" "}
            </span>
            {record.constraints.boundary_test}
          </p>
        </div>
      </section>

      {/* Relations */}
      {record.relations.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionLabel>relations</SectionLabel>
          <div className="flex flex-col gap-2">
            {record.relations.map((relation) => (
              <div
                key={`${relation.type}-${relation.target}`}
                className="flex flex-wrap items-baseline gap-2 rounded-md border border-[#243329] bg-[#1A2620] px-3 py-2"
              >
                <span className="font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
                  {relation.type}
                </span>
                <span className="font-mono text-xs text-[#E6EFE8]">
                  {relation.target}
                  {nameById.has(relation.target) &&
                    ` · ${nameById.get(relation.target)}`}
                </span>
                <span className="text-xs leading-relaxed text-[#8CA495]">
                  {relation.note}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Reference examples (optional field) */}
      {record.reference_examples && record.reference_examples.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionLabel>reference examples</SectionLabel>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {record.reference_examples.map((example) => (
              <div
                key={example.product}
                className="rounded-md border border-[#243329] bg-[#1A2620] px-3 py-2"
              >
                <p className="font-display text-xs font-medium text-[#E6EFE8]">
                  {example.product}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[#8CA495]">
                  {example.what}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Telemetry */}
      <section className="flex flex-col gap-2">
        <SectionLabel>telemetry</SectionLabel>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <KeyValue label="tag format" value={record.telemetry.tag_format} />
          <KeyValue
            label="amplitude event property"
            value={record.telemetry.amplitude_event_property}
          />
        </dl>
      </section>
    </div>
  );
}

function FullRecordRow({
  record,
  valid,
  nameById,
}: {
  record: Mechanism;
  valid: boolean;
  nameById: Map<string, string>;
}) {
  return (
    <details className="group rounded-md border border-[#243329] bg-[#151F1A]">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex items-baseline gap-3">
          <span className="text-[10px] text-[#7C93A8] transition-transform group-open:rotate-90">
            ▶
          </span>
          <span className="font-mono text-xs text-[#34D399]">{record.id}</span>
          <span className="font-display text-sm font-medium text-[#E6EFE8]">
            {record.name}
          </span>
          <span className="font-mono text-[11px] text-[#7C93A8]">
            grade {record.evidence.grade} · full record
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!valid && (
            <span className="rounded border border-[#E4B54E]/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[#E4B54E]">
              invalid — fails hard rules
            </span>
          )}
          <LifecyclePill status={record.lifecycle_status} />
        </div>
      </summary>
      <FullRecordView record={record} nameById={nameById} />
    </details>
  );
}

// ---------- L0 node section ----------

function CoverageLine({ entry }: { entry: RegistryNode }) {
  const total = entry.children.length;
  if (total === 0) return null;
  return (
    <p className="font-mono text-[11px] text-[#8CA495]">
      {total} mechanism{total === 1 ? "" : "s"}
      {entry.coverage.map(({ status, count }) => (
        <span key={status}>
          {" · "}
          <span style={{ color: LIFECYCLE_META[status].color }}>
            {count} {LIFECYCLE_META[status].label}
          </span>
        </span>
      ))}
    </p>
  );
}

function NodeAnchors({ node }: { node: TaxonomyNode }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Tag>RDoC · {node.anchors.rdoc}</Tag>
      {node.anchors.panksepp && <Tag>Panksepp · {node.anchors.panksepp}</Tag>}
    </div>
  );
}

function NodeSection({
  entry,
  nameById,
}: {
  entry: RegistryNode;
  nameById: Map<string, string>;
}) {
  return (
    <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-sm text-[#34D399]">
              {entry.node.id}
            </span>
            <h3 className="font-display text-base font-medium text-[#E6EFE8]">
              {entry.node.name}
            </h3>
            {entry.node.cross_cutting && <Tag>cross-cutting</Tag>}
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-[#8CA495]">
            {entry.node.description}
          </p>
          <NodeAnchors node={entry.node} />
        </div>
        <CoverageLine entry={entry} />
      </div>

      <div className="mt-4 flex flex-col gap-2 border-l border-[#243329] pl-4">
        {entry.children.length === 0 ? (
          <div className="rounded-md border border-dashed border-[#243329] bg-[#1A2620] px-3 py-2.5">
            <p className="text-xs leading-relaxed text-[#8CA495]">
              <span className="text-[#E6EFE8]">No mechanisms yet.</span> Filled
              by /registry/mechanisms/*.json entered by the owner.
            </p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-[#7C93A8]">
              phase · July
            </p>
          </div>
        ) : (
          entry.children.map((child: RegistryChild) =>
            child.kind === "full" ? (
              <FullRecordRow
                key={child.record.id}
                record={child.record}
                valid={child.valid}
                nameById={nameById}
              />
            ) : (
              <StubRow key={child.stub.id} stub={child.stub} />
            ),
          )
        )}
      </div>
    </section>
  );
}

// ---------- Page ----------

export default function RegistryPage() {
  const tree = computeRegistryTree();

  const nameById = new Map<string, string>();
  for (const entry of tree) {
    for (const child of entry.children) {
      if (child.kind === "full") nameById.set(child.record.id, child.record.name);
      else nameById.set(child.stub.id, child.stub.name);
    }
  }

  const totalMechanisms = tree.reduce(
    (n, entry) => n + entry.children.length,
    0,
  );
  const fullCount = tree.reduce(
    (n, entry) =>
      n + entry.children.filter((child) => child.kind === "full").length,
    0,
  );

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
            Registry — the ontology
          </h1>
          <p className="mt-1 text-sm text-[#8CA495]">
            L0 brain systems → L1 mechanisms, read from /registry. Coverage is
            computed from the record files — {fullCount} full record
            {fullCount === 1 ? "" : "s"}, {totalMechanisms - fullCount} seed
            stub{totalMechanisms - fullCount === 1 ? "" : "s"}.
          </p>
        </div>
        <span className="rounded-full border border-[#243329] bg-[#1A2620] px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-[#8CA495]">
          {totalMechanisms} L1 total
        </span>
      </header>

      <div className="mt-6">
        <LifecycleLegend />
      </div>

      <div className="mt-8 flex flex-col gap-4">
        {tree.map((entry) => (
          <NodeSection key={entry.node.id} entry={entry} nameById={nameById} />
        ))}
      </div>
    </main>
  );
}

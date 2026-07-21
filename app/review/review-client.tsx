"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isActionableProposal, PROPOSAL_STATUS_META } from "@/lib/proposal-meta";
import type { Proposal } from "@/lib/types";
import {
  approveProposalAction,
  batchProposalAction,
  editThenApproveProposalAction,
  rejectProposalAction,
  submitOwnerObservationAction,
  type ReviewActionResult,
} from "./actions";

interface ReviewOption {
  id: string;
  name: string;
}

interface ManualSourceOption extends ReviewOption {
  legalNote: string;
}

export interface ReviewProposal {
  path: string;
  proposal: Proposal;
  preview: { path: string; before: string | null; after: string | null }[];
  previewError?: string;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "not decided";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function ReadableValue({ value }: { value: unknown }) {
  if (value === null) return <span className="text-[#7C93A8]">None</span>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <span className="whitespace-pre-wrap">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-[#7C93A8]">None</span>;
    return (
      <ul className="space-y-1">
        {value.map((item, index) => (
          <li key={index} className="border-l border-[#243329] pl-3">
            <ReadableValue value={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="space-y-2">
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <div key={key}>
            <dt className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
              {label(key)}
            </dt>
            <dd className="mt-0.5 text-sm leading-relaxed text-[#E6EFE8]">
              <ReadableValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}

function structured(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function Diff({ item }: { item: ReviewProposal["preview"][number] }) {
  const before = structured(item.before);
  const after = structured(item.after);
  const keys =
    before || after
      ? Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])).filter(
          (key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]),
        )
      : [];
  return (
    <div className="rounded-md border border-[#243329] bg-[#1A2620] p-3">
      <p className="font-mono text-[10px] uppercase tracking-wider text-[#34D399]">
        {item.path}
      </p>
      {keys.length > 0 ? (
        <div className="mt-3 space-y-3">
          {keys.map((key) => (
            <div key={key}>
              <p className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
                {label(key)}
              </p>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                <div className="rounded border border-[#F87171]/20 bg-[#0E1512] p-2">
                  <p className="mb-1 font-mono text-[9px] uppercase text-[#F87171]">Before</p>
                  <ReadableValue value={before?.[key] ?? null} />
                </div>
                <div className="rounded border border-[#34D399]/20 bg-[#0E1512] p-2">
                  <p className="mb-1 font-mono text-[9px] uppercase text-[#34D399]">After</p>
                  <ReadableValue value={after?.[key] ?? null} />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-[#8CA495]">
            {item.before ?? "New file"}
          </pre>
          <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-[#E6EFE8]">
            {item.after ?? "File removed"}
          </pre>
        </div>
      )}
    </div>
  );
}

function ProposalCard({
  item,
  writeEnabled,
  selected,
  onSelected,
}: {
  item: ReviewProposal;
  writeEnabled: boolean;
  selected: boolean;
  onSelected: (selected: boolean) => void;
}) {
  const { proposal, path } = item;
  const [note, setNote] = useState("");
  const [payload, setPayload] = useState(() =>
    JSON.stringify(proposal.payload, null, 2),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const actionable = isActionableProposal(proposal);
  const readyToApprove =
    actionable && proposal.provenance.length > 0 && !item.previewError;

  function run(action: () => Promise<ReviewActionResult>): void {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      setMessage(
        result.ok ? `Committed with decision ${result.decisionId}.` : result.error,
      );
      if (result.ok) router.refresh();
    });
  }

  return (
    <article className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            {actionable && (
              <input
                type="checkbox"
                checked={selected}
                disabled={!writeEnabled || !actionable || isPending}
                onChange={(event) => onSelected(event.target.checked)}
                aria-label={`Select proposal ${proposal.id}`}
                className="accent-[#34D399]"
              />
            )}
            <p className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
              {label(proposal.type)} · {proposal.id}
            </p>
          </div>
          <h2 className="mt-1 font-display text-lg font-medium text-[#E6EFE8]">
            {proposal.operation === "enrich" ? "Enrich" : "Create"} · Target {proposal.target}
          </h2>
        </div>
        <span className="rounded-full border border-[#243329] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-[#34D399]">
          {PROPOSAL_STATUS_META[proposal.status].label}
        </span>
      </div>

      <dl className="mt-4 grid gap-2 text-xs text-[#8CA495] sm:grid-cols-3">
        <div>
          <dt className="font-mono uppercase tracking-wider text-[#7C93A8]">confidence</dt>
          <dd>{Math.round(proposal.confidence * 100)}%</dd>
        </div>
        <div>
          <dt className="font-mono uppercase tracking-wider text-[#7C93A8]">pipeline run</dt>
          <dd className="break-all">{proposal.proposed_by}</dd>
        </div>
        <div>
          <dt className="font-mono uppercase tracking-wider text-[#7C93A8]">proposed</dt>
          <dd>{formatTimestamp(proposal.proposed_at)}</dd>
        </div>
      </dl>

      <div className="mt-4">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
          Check the sources
        </h3>
        <ul className="mt-2 space-y-2">
          {proposal.provenance.map((source) => (
            <li
              key={`${source.corpus_record_id}:${source.quote_or_locus}`}
              className="rounded-md border border-[#243329] bg-[#1A2620] p-3 text-xs leading-relaxed text-[#8CA495]"
            >
              <Link
                href={`/corpus/${source.mechanism_id}/${source.corpus_record_id}`}
                className="text-[#E6EFE8] hover:text-[#34D399]"
              >
                {source.title} →
              </Link>
              {"doi" in source && source.doi && (
                <a
                  href={`https://doi.org/${source.doi}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 text-[#34D399] hover:underline"
                >
                  DOI ↗
                </a>
              )}
              <br />
              <span className="font-mono text-[11px] text-[#7C93A8]">
                {source.mechanism_id} · {source.corpus_record_id}
                {"corpus_kind" in source && source.corpus_kind === "realization"
                  ? ` · interface · ${source.source_id}${
                      source.contributed_by ? ` · ${source.contributed_by}` : ""
                    }`
                  : " · literature"}
              </span>
              <p className="mt-1">{source.quote_or_locus}</p>
            </li>
          ))}
        </ul>
      </div>

      <section className="mt-4 rounded-md border border-[#243329] bg-[#1A2620] p-4">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
          {proposal.type === "realization"
            ? "Source-grounded realization"
            : "Proposed content"}
        </h3>
        {proposal.type === "realization" ? (
          <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">
            Descriptive evidence about an embodiment reported in sources; this is not a
            product-authored generator directive.
          </p>
        ) : null}
        <div className="mt-3"><ReadableValue value={proposal.payload} /></div>
      </section>

      {item.preview.length > 0 && (
        <section className="mt-4">
          <h3 className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
            What will change
          </h3>
          <div className="mt-2 space-y-2">
            {item.preview.map((preview) => <Diff key={preview.path} item={preview} />)}
          </div>
        </section>
      )}

      {item.previewError && (
        <p role="alert" className="mt-4 rounded-md border border-[#F87171]/30 bg-[#1A2620] p-3 text-xs text-[#F87171]">
          Approval is blocked: {item.previewError}
        </p>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
          Edit the full proposal
        </summary>
        <textarea
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
          disabled={!actionable || isPending || !writeEnabled}
          rows={14}
          spellCheck={false}
          aria-label={`Edit payload for ${proposal.id}`}
          className="mt-2 w-full rounded-md border border-[#243329] bg-[#0E1512] p-3 font-mono text-xs leading-relaxed text-[#E6EFE8] outline-none focus:border-[#34D399]/60 disabled:opacity-60"
        />
      </details>

      {actionable ? (
        <>
          <label className="mt-3 block">
            <span className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
              decision note / rejection reason
            </span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={isPending || !writeEnabled}
              className="mt-2 w-full rounded-md border border-[#243329] bg-[#0E1512] px-3 py-2 text-sm text-[#E6EFE8] outline-none focus:border-[#34D399]/60"
            />
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isPending || !writeEnabled || !readyToApprove}
              onClick={() => run(() => approveProposalAction(path, note))}
              className="rounded-md bg-[#34D399] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#0E1512] disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={isPending || !writeEnabled || !readyToApprove}
              onClick={() => run(() => editThenApproveProposalAction(path, payload, note))}
              className="rounded-md border border-[#E4B54E]/50 px-3 py-2 font-mono text-xs uppercase tracking-wider text-[#E4B54E] disabled:opacity-50"
            >
              Approve edited version
            </button>
            <button
              type="button"
              disabled={isPending || !writeEnabled || note.trim().length === 0}
              onClick={() => run(() => rejectProposalAction(path, note))}
              className="rounded-md border border-[#F87171]/50 px-3 py-2 font-mono text-xs uppercase tracking-wider text-[#F87171] disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </>
      ) : proposal.status === "held_low_confidence" ? (
        <p className="mt-4 text-xs text-[#E4B54E]">
          {proposal.hold_reason === "no_material_enrichment"
            ? "Held because the enrichment adds no new source or material field change."
            : "Held below the configured confidence floor."}{" "}
          It remains visible for inspection but cannot be approved unless a later
          grounded run strengthens and merges it.
        </p>
      ) : (
        <p className="mt-4 text-xs text-[#7C93A8]">
          Decided by {proposal.decided_by ?? "unknown"} at{" "}
          {formatTimestamp(proposal.decided_at)}
          {proposal.decision_note ? ` — ${proposal.decision_note}` : ""}
        </p>
      )}

      {message && (
        <p role="alert" className="mt-3 rounded-md border border-[#243329] bg-[#1A2620] px-3 py-2 text-xs text-[#E6EFE8]">
          {message}
        </p>
      )}
    </article>
  );
}

function OwnerObservationForm({
  writeEnabled,
  mechanisms,
  manualSources,
}: {
  writeEnabled: boolean;
  mechanisms: ReviewOption[];
  manualSources: ManualSourceOption[];
}) {
  const [mechanismId, setMechanismId] = useState(mechanisms[0]?.id ?? "");
  const [sourceId, setSourceId] = useState(manualSources[0]?.id ?? "");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceLocator, setSourceLocator] = useState("");
  const [observation, setObservation] = useState("");
  const [artifactContext, setArtifactContext] = useState("");
  const [observedAt, setObservedAt] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [attested, setAttested] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const selectedSource = manualSources.find((source) => source.id === sourceId);

  const canSubmit =
    writeEnabled &&
    mechanismId.length > 0 &&
    sourceId.length > 0 &&
    sourceUrl.trim().length > 0 &&
    sourceLocator.trim().length > 0 &&
    observation.trim().length > 0 &&
    artifactContext.trim().length > 0 &&
    attested &&
    !isPending;

  return (
    <section className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <h2 className="font-display text-lg text-[#E6EFE8]">
        Add a licensed-source observation
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-[#8CA495]">
        Enter your own short observation and item locator. The app never opens or
        harvests the named source; Actions only structures this note into a pending
        realization proposal.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-xs text-[#8CA495]">
          Mechanism
          <select
            value={mechanismId}
            onChange={(event) => setMechanismId(event.target.value)}
            disabled={!writeEnabled || isPending}
            className="mt-1 w-full rounded border border-[#243329] bg-[#0E1512] px-3 py-2 text-[#E6EFE8]"
          >
            {mechanisms.map((mechanism) => (
              <option key={mechanism.id} value={mechanism.id}>
                {mechanism.id} · {mechanism.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[#8CA495]">
          Manual source
          <select
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
            disabled={!writeEnabled || isPending}
            className="mt-1 w-full rounded border border-[#243329] bg-[#0E1512] px-3 py-2 text-[#E6EFE8]"
          >
            {manualSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[#8CA495]">
          Item URL
          <input
            type="url"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            disabled={!writeEnabled || isPending}
            className="mt-1 w-full rounded border border-[#243329] bg-[#0E1512] px-3 py-2 text-[#E6EFE8]"
          />
        </label>
        <label className="text-xs text-[#8CA495]">
          Item locator / screen name
          <input
            value={sourceLocator}
            onChange={(event) => setSourceLocator(event.target.value)}
            disabled={!writeEnabled || isPending}
            className="mt-1 w-full rounded border border-[#243329] bg-[#0E1512] px-3 py-2 text-[#E6EFE8]"
          />
        </label>
        <label className="text-xs text-[#8CA495]">
          Artifact contexts (comma-separated)
          <input
            value={artifactContext}
            onChange={(event) => setArtifactContext(event.target.value)}
            disabled={!writeEnabled || isPending}
            placeholder="paywall, onboarding"
            className="mt-1 w-full rounded border border-[#243329] bg-[#0E1512] px-3 py-2 text-[#E6EFE8]"
          />
        </label>
        <label className="text-xs text-[#8CA495]">
          Observed date
          <input
            type="date"
            value={observedAt}
            onChange={(event) => setObservedAt(event.target.value)}
            disabled={!writeEnabled || isPending}
            className="mt-1 w-full rounded border border-[#243329] bg-[#0E1512] px-3 py-2 text-[#E6EFE8]"
          />
        </label>
      </div>
      <label className="mt-4 block text-xs text-[#8CA495]">
        Descriptive observation
        <textarea
          value={observation}
          onChange={(event) => setObservation(event.target.value)}
          disabled={!writeEnabled || isPending}
          rows={5}
          className="mt-1 w-full rounded border border-[#243329] bg-[#0E1512] p-3 text-sm text-[#E6EFE8]"
        />
      </label>
      <p className="mt-3 text-xs text-[#E4B54E]">
        Licence boundary: {selectedSource?.legalNote ?? "Select a manual source."}
      </p>
      <label className="mt-3 flex items-start gap-2 text-xs text-[#8CA495]">
        <input
          type="checkbox"
          checked={attested}
          onChange={(event) => setAttested(event.target.checked)}
          disabled={!writeEnabled || isPending}
          className="mt-0.5 accent-[#34D399]"
        />
        I authored this observation from permitted human use. No screenshot or
        licensed source content is being uploaded.
      </label>
      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            const result = await submitOwnerObservationAction({
              mechanismId,
              sourceId,
              sourceUrl,
              sourceLocator,
              observation,
              artifactContext: artifactContext
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
              observedAt,
              attested,
            });
            setMessage(
              result.ok
                ? result.warning ??
                    `Observation ${result.recordId} committed and extraction dispatched.`
                : result.error,
            );
            if (result.ok) {
              setObservation("");
              setSourceLocator("");
              setSourceUrl("");
              setAttested(false);
            }
          });
        }}
        className="mt-4 rounded-md bg-[#34D399] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#0E1512] disabled:opacity-50"
      >
        Submit observation
      </button>
      {message && (
        <p role="status" className="mt-3 text-xs text-[#E6EFE8]">
          {message}
        </p>
      )}
    </section>
  );
}

export default function ReviewClient({
  proposals,
  writeEnabled,
  mechanisms,
  manualSources,
}: {
  proposals: ReviewProposal[];
  writeEnabled: boolean;
  mechanisms: ReviewOption[];
  manualSources: ManualSourceOption[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchReason, setBatchReason] = useState("");
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const held = proposals.filter(
    (item) => item.proposal.status === "held_low_confidence",
  );
  const primary = proposals.filter(
    (item) => item.proposal.status !== "held_low_confidence",
  );
  const groups = new Map<string, ReviewProposal[]>();
  for (const item of primary) {
    const key = `${item.proposal.type}::${item.proposal.target}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  function runBatch(action: "approve" | "reject"): void {
    setBatchMessage(null);
    startTransition(async () => {
      const result = await batchProposalAction(
        Array.from(selected),
        action,
        action === "reject" ? batchReason : undefined,
      );
      if (result.ok) {
        setSelected(new Set());
        setBatchReason("");
        setBatchMessage(
          `Committed ${result.proposalIds?.length ?? 0} proposals with decision ${result.decisionId}.`,
        );
        router.refresh();
      } else {
        const details = result.reports
          ?.filter((report) => report.error)
          .map((report) => `${report.proposalId ?? report.proposalPath}: ${report.error}`)
          .join(" · ");
        setBatchMessage(details ? `${result.error}. ${details}` : result.error);
      }
    });
  }

  return (
    <div className="mt-6 space-y-8">
      <OwnerObservationForm
        writeEnabled={writeEnabled}
        mechanisms={mechanisms}
        manualSources={manualSources}
      />
      {Array.from(groups.entries()).map(([key, items]) => (
        <section key={key}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#243329] pb-2">
            <h2 className="font-display text-lg text-[#E6EFE8]">
              {label(items[0].proposal.type)} · {items[0].proposal.target}
            </h2>
            <button
              type="button"
              disabled={!writeEnabled}
              onClick={() => {
                const next = new Set(selected);
                const selectable = items.filter(
                  (item) => isActionableProposal(item.proposal),
                );
                const allSelected = selectable.every((item) => next.has(item.path));
                for (const item of selectable) {
                  if (allSelected) next.delete(item.path);
                  else next.add(item.path);
                }
                setSelected(next);
              }}
              className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8] hover:text-[#34D399] disabled:opacity-50"
            >
              Select group
            </button>
          </div>
          <div className="space-y-4">
            {items.map((item) => (
              <ProposalCard
                key={item.path}
                item={item}
                writeEnabled={writeEnabled}
                selected={selected.has(item.path)}
                onSelected={(checked) => {
                  const next = new Set(selected);
                  if (checked) next.add(item.path);
                  else next.delete(item.path);
                  setSelected(next);
                }}
              />
            ))}
          </div>
        </section>
      ))}

      {held.length > 0 && (
        <details className="rounded-lg border border-[#E4B54E]/30 bg-[#151F1A] p-4">
          <summary className="cursor-pointer font-display text-lg text-[#E4B54E]">
            Low-confidence bucket · {held.length}
          </summary>
          <p className="mt-2 text-xs text-[#8CA495]">
            Collapsed by default. These grounded items did not clear the configured
            confidence floor or added no material enrichment.
          </p>
          <div className="mt-4 space-y-4">
            {held.map((item) => (
              <ProposalCard
                key={item.path}
                item={item}
                writeEnabled={writeEnabled}
                selected={false}
                onSelected={() => undefined}
              />
            ))}
          </div>
        </details>
      )}

      {selected.size > 0 && (
        <section className="sticky bottom-4 rounded-lg border border-[#34D399]/40 bg-[#151F1A] p-4 shadow-2xl">
          <div className="flex flex-wrap items-center gap-3">
            <p className="mr-auto text-sm text-[#E6EFE8]">{selected.size} selected</p>
            <input
              value={batchReason}
              onChange={(event) => setBatchReason(event.target.value)}
              placeholder="Reason for batch rejection"
              aria-label="Reason for batch rejection"
              className="min-w-64 flex-1 rounded-md border border-[#243329] bg-[#0E1512] px-3 py-2 text-sm text-[#E6EFE8] outline-none focus:border-[#34D399]/60"
            />
            <button
              type="button"
              disabled={isPending || !writeEnabled}
              onClick={() => runBatch("approve")}
              className="rounded-md bg-[#34D399] px-3 py-2 font-mono text-xs font-semibold uppercase text-[#0E1512] disabled:opacity-50"
            >
              Approve selected
            </button>
            <button
              type="button"
              disabled={isPending || !writeEnabled || batchReason.trim().length === 0}
              onClick={() => runBatch("reject")}
              className="rounded-md border border-[#F87171]/50 px-3 py-2 font-mono text-xs uppercase text-[#F87171] disabled:opacity-50"
            >
              Reject selected
            </button>
          </div>
        </section>
      )}
      {batchMessage && (
        <p role="alert" className="rounded-md border border-[#243329] bg-[#1A2620] px-3 py-2 text-xs text-[#E6EFE8]">
          {batchMessage}
        </p>
      )}
    </div>
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactElement,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isActionableProposal, PROPOSAL_STATUS_META } from "@/lib/proposal-meta";
import type { ProposalFlag } from "@/lib/review-flags";
import type { SourceContext } from "@/lib/source-context";
import type { DossierDraftAxis, Proposal } from "@/lib/types";
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
  flags: ProposalFlag[];
  /** Parallel to proposal.provenance — null when the item has no source_span. */
  sourceContexts: (SourceContext | null)[];
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

const SPAN_FAILURE_STATUSES = new Set([
  "span_stale",
  "span_out_of_range",
  "span_does_not_reslice",
  "record_missing",
]);

function SourceContextView({ context }: { context: SourceContext }) {
  if (SPAN_FAILURE_STATUSES.has(context.status)) {
    return (
      <div
        role="alert"
        className="mt-2 rounded border border-[#F87171]/50 bg-[#0E1512] p-3"
      >
        <p className="font-mono text-[11px] uppercase tracking-wider text-[#F87171]">
          {context.label}
        </p>
        {context.detail && (
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-[#F87171]/80">
            {context.detail}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 rounded border border-[#243329] bg-[#0E1512] p-3">
      <p className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
        {context.label}
      </p>
      <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[#8CA495]">
        {context.before}
        <mark className="rounded-sm bg-[#34D399]/25 px-0.5 text-[#E6EFE8]">
          {context.span}
        </mark>
        {context.after}
      </p>
    </div>
  );
}

function FlagBanner({
  flag,
  pattern,
}: {
  flag: ProposalFlag;
  pattern?: string;
}) {
  return (
    <div
      role="status"
      className="rounded-md border border-[#E4B54E]/40 bg-[#1A2620] p-3"
    >
      <p className="font-mono text-[11px] uppercase tracking-widest text-[#E4B54E]">
        Warning · {flag.kind.replaceAll("_", " ")}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-[#E6EFE8]">{flag.summary}</p>
      {flag.highlight && (
        <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">
          Unsupported clause:{" "}
          <mark className="rounded-sm bg-[#E4B54E]/25 px-0.5 text-[#E6EFE8]">
            {flag.highlight}
          </mark>
        </p>
      )}
      {flag.compareRecord && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded border border-[#243329] bg-[#0E1512] p-2">
            <p className="mb-1 font-mono text-[9px] uppercase text-[#7C93A8]">
              Existing · {flag.compareRecord.id}
            </p>
            <p className="text-xs font-medium text-[#E6EFE8]">{flag.compareRecord.term}</p>
            <p className="mt-1 text-xs leading-relaxed text-[#8CA495]">
              {flag.compareRecord.pattern ?? flag.compareRecord.description_as_reported}
            </p>
            <p className="mt-1 font-mono text-[10px] text-[#E4B54E]">
              similarity {Math.round(flag.compareRecord.score * 100)}%
            </p>
          </div>
          <div className="rounded border border-[#E4B54E]/30 bg-[#0E1512] p-2">
            <p className="mb-1 font-mono text-[9px] uppercase text-[#E4B54E]">
              This proposal
            </p>
            <p className="text-xs leading-relaxed text-[#8CA495]">
              {pattern ?? flag.detail}
            </p>
          </div>
        </div>
      )}
      {flag.anchorEffect && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded border border-[#243329] bg-[#0E1512] p-2">
            <p className="mb-1 font-mono text-[9px] uppercase text-[#7C93A8]">
              Anchor effect · {flag.anchorEffect.id}
            </p>
            <p className="text-xs leading-relaxed text-[#8CA495]">{flag.anchorEffect.fact}</p>
          </div>
          <div className="rounded border border-[#E4B54E]/30 bg-[#0E1512] p-2">
            <p className="mb-1 font-mono text-[9px] uppercase text-[#E4B54E]">
              Pattern claiming derivation
            </p>
            <p className="text-xs leading-relaxed text-[#8CA495]">
              {pattern ?? flag.detail}
            </p>
          </div>
        </div>
      )}
      {!flag.highlight && !flag.compareRecord && !flag.anchorEffect && (
        <p className="mt-1 text-xs leading-relaxed text-[#8CA495]">{flag.detail}</p>
      )}
    </div>
  );
}

function DossierAxis({ name, axis }: { name: string; axis: DossierDraftAxis }) {
  const scored = axis.score !== null && axis.rationale !== null;
  return (
    <div
      className={`rounded-md border p-3 ${
        scored ? "border-[#243329] bg-[#0E1512]" : "border-[#E4B54E]/40 bg-[#0E1512]"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[11px] uppercase tracking-widest text-[#E6EFE8]">
          {label(name)}
        </p>
        {scored ? (
          <span className="rounded-full border border-[#E4B54E]/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[#E4B54E]">
            proposed · {axis.score} / 3
          </span>
        ) : (
          <span className="rounded-full border border-[#E4B54E] bg-[#E4B54E]/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[#E4B54E]">
            unscored · needs owner judgement
          </span>
        )}
      </div>
      {scored ? (
        <p className="mt-2 text-sm leading-relaxed text-[#E6EFE8]">{axis.rationale}</p>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">
          The pipeline could not ground a rationale for this axis, so no score was
          guessed. Enter a score and rationale via “Edit the full proposal”, then use
          “Approve edited version”.
        </p>
      )}
      {axis.provenance.length > 0 && (
        <ul className="mt-2 space-y-1">
          {axis.provenance.map((source) => (
            <li
              key={`${source.corpus_record_id}:${source.quote_or_locus}`}
              className="border-l border-[#243329] pl-3 text-xs leading-relaxed text-[#8CA495]"
            >
              <span className="font-mono text-[10px] text-[#7C93A8]">
                {source.corpus_record_id}
                {source.doi ? ` · ${source.doi}` : ""}
              </span>
              <p className="mt-0.5">“{source.quote_or_locus}”</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DossierDraftView({
  proposal,
}: {
  proposal: Extract<Proposal, { type: "dossier" }>;
}) {
  const payload = proposal.payload;
  return (
    <div className="mt-3 space-y-3">
      <p className="text-xs leading-relaxed text-[#8CA495]">
        Machine-drafted dossier for {payload.mechanism_id}. Every score below is a
        proposal until you confirm or edit it; total and verdict are computed at
        approval, never proposed. Unscored axes block approval.
      </p>
      {Object.entries(payload.scores).map(([name, axis]) => (
        <DossierAxis key={name} name={name} axis={axis} />
      ))}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
          core condition
        </p>
        <p className="mt-0.5 text-sm leading-relaxed text-[#E6EFE8]">
          {payload.core_condition}
        </p>
      </div>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
          dissent
        </p>
        <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-[#E6EFE8]">
          {payload.dissent}
        </p>
      </div>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
          evidence sources
        </p>
        <ul className="mt-1 space-y-1">
          {payload.evidence_sources.map((source) => (
            <li key={source.ref} className="text-xs text-[#8CA495]">
              {source.ref}
              {source.doi ? (
                <a
                  href={`https://doi.org/${source.doi}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 text-[#34D399] hover:underline"
                >
                  DOI ↗
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ProposalCard({
  item,
  writeEnabled,
  selected,
  onSelected,
  focused,
  onFocusCard,
  cardRef,
}: {
  item: ReviewProposal;
  writeEnabled: boolean;
  selected: boolean;
  onSelected: (selected: boolean) => void;
  focused: boolean;
  onFocusCard: () => void;
  cardRef: (node: HTMLElement | null) => void;
}) {
  const { proposal, path } = item;
  const originalPayload = JSON.stringify(proposal.payload, null, 2);
  const [note, setNote] = useState("");
  const [payload, setPayload] = useState(() => originalPayload);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const noteRef = useRef<HTMLInputElement>(null);
  const editDetailsRef = useRef<HTMLDetailsElement>(null);
  const actionable = isActionableProposal(proposal);
  const unscoredAxes =
    proposal.type === "dossier"
      ? Object.entries(proposal.payload.scores)
          .filter(([, axis]) => axis.score === null || axis.rationale === null)
          .map(([name]) => name)
      : [];
  const readyToApprove =
    actionable &&
    proposal.provenance.length > 0 &&
    !item.previewError &&
    unscoredAxes.length === 0;
  const payloadChanged = payload.trim() !== originalPayload.trim();
  const readyToNarrow =
    readyToApprove && payloadChanged && note.trim().length > 0;
  const readyToReject = actionable && writeEnabled && note.trim().length > 0;
  const patternText =
    proposal.type === "realization" ? proposal.payload.pattern : undefined;

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

  function accept(): void {
    if (!readyToApprove || !writeEnabled || isPending) return;
    run(() => approveProposalAction(path, note));
  }

  function narrow(): void {
    if (!readyToNarrow || !writeEnabled || isPending) {
      if (editDetailsRef.current) editDetailsRef.current.open = true;
      noteRef.current?.focus();
      return;
    }
    run(() => editThenApproveProposalAction(path, payload, note));
  }

  function reject(): void {
    if (!readyToReject || isPending) {
      noteRef.current?.focus();
      return;
    }
    run(() => rejectProposalAction(path, note));
  }

  return (
    <article
      ref={cardRef}
      tabIndex={0}
      data-review-path={path}
      onFocus={onFocusCard}
      onClick={onFocusCard}
      className={`rounded-lg border bg-[#151F1A] p-5 outline-none ${
        focused
          ? "border-[#34D399]/60 ring-1 ring-[#34D399]/30"
          : "border-[#243329]"
      }`}
    >
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
        <div className="flex flex-wrap items-center gap-2">
          {item.flags.length > 0 && (
            <span className="rounded-full border border-[#E4B54E]/50 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-[#E4B54E]">
              {item.flags.length} flag{item.flags.length === 1 ? "" : "s"}
            </span>
          )}
          <span className="rounded-full border border-[#243329] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-[#34D399]">
            {PROPOSAL_STATUS_META[proposal.status].label}
          </span>
        </div>
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
          {proposal.provenance.map((source, index) => {
            const context = item.sourceContexts[index] ?? null;
            return (
              <li
                key={`${source.corpus_record_id}:${source.quote_or_locus}:${index}`}
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
                    : "corpus_kind" in source && source.corpus_kind === "inference"
                      ? ` · inferred from effect ${source.effect_id}`
                      : " · literature"}
                </span>
                {"corpus_kind" in source && source.corpus_kind === "inference" ? (
                  <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-[#E4B54E]">
                    {source.span_absent_reason}
                  </p>
                ) : null}
                {context ? (
                  <SourceContextView context={context} />
                ) : (
                  <p className="mt-1">{source.quote_or_locus}</p>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {item.flags.length > 0 && (
        <section className="mt-4 space-y-2">
          <h3 className="font-mono text-[11px] uppercase tracking-widest text-[#E4B54E]">
            Triage flags — warnings only, verdict stays yours
          </h3>
          {item.flags.map((flag) => (
            <FlagBanner
              key={`${flag.kind}:${flag.summary}`}
              flag={flag}
              pattern={patternText}
            />
          ))}
        </section>
      )}

      <section className="mt-4 rounded-md border border-[#243329] bg-[#1A2620] p-4">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
          {proposal.type === "realization"
            ? proposal.payload.derivation === "inferred"
              ? "Inferred realization — a transfer, not a finding"
              : "Source-grounded realization"
            : proposal.type === "dossier"
              ? "Drafted dossier — every score is proposed"
              : proposal.type === "mechanism"
                ? "Drafted mechanism record"
                : "Proposed content"}
        </h3>
        {proposal.type === "realization" ? (
          proposal.payload.derivation === "inferred" ? (
            <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">
              <span className="text-[#E4B54E]">
                No source measured this pattern in a product interface.
              </span>{" "}
              <code className="font-mono text-[11px] text-[#E6EFE8]">
                description_as_reported
              </code>{" "}
              is what the cited evidence states, in{" "}
              {proposal.payload.domain_transfer?.source_domain ?? "its own domain"};{" "}
              <code className="font-mono text-[11px] text-[#E6EFE8]">pattern</code> is the
              directive transferred into{" "}
              {proposal.payload.domain_transfer?.application_domain ?? "product UI"}, and
              that half is inference. Check the transfer, not only the quote.
            </p>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">
              Descriptive evidence about an embodiment reported in sources; this is not a
              product-authored generator directive.
            </p>
          )
        ) : null}
        {proposal.type === "mechanism" ? (
          <p className="mt-2 text-xs leading-relaxed text-[#8CA495]">
            Full L1 record drafted from the evidence corpus. Seed content (name,
            oneliner terms, pinned evidence) is preserved verbatim; ids, versioning
            and telemetry are code-filled; summary, evidence, implementations and
            hard rules are grounded claims — check them against the sources above.
          </p>
        ) : null}
        {proposal.type === "dossier" ? (
          <DossierDraftView proposal={proposal} />
        ) : (
          <div className="mt-3"><ReadableValue value={proposal.payload} /></div>
        )}
      </section>

      {unscoredAxes.length > 0 && (
        <p role="alert" className="mt-4 rounded-md border border-[#E4B54E]/40 bg-[#1A2620] p-3 text-xs text-[#E4B54E]">
          Approval is blocked: {unscoredAxes.map(label).join(", ")}{" "}
          {unscoredAxes.length === 1 ? "axis needs" : "axes need"} owner judgement.
          Edit a score and rationale, then use “Approve edited version”.
        </p>
      )}

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

      <details ref={editDetailsRef} className="mt-4">
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
              reason — required for narrow and reject
            </span>
            <input
              ref={noteRef}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={isPending || !writeEnabled}
              data-review-reason={path}
              className="mt-2 w-full rounded-md border border-[#243329] bg-[#0E1512] px-3 py-2 text-sm text-[#E6EFE8] outline-none focus:border-[#34D399]/60"
            />
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              data-review-accept={path}
              disabled={isPending || !writeEnabled || !readyToApprove}
              onClick={accept}
              className="rounded-md bg-[#34D399] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#0E1512] disabled:opacity-50"
            >
              Accept <span className="opacity-60">A</span>
            </button>
            <button
              type="button"
              data-review-narrow={path}
              disabled={isPending || !writeEnabled || !readyToNarrow}
              onClick={narrow}
              className="rounded-md border border-[#E4B54E]/50 px-3 py-2 font-mono text-xs uppercase tracking-wider text-[#E4B54E] disabled:opacity-50"
            >
              Narrow <span className="opacity-60">N</span>
            </button>
            <button
              type="button"
              data-review-reject={path}
              disabled={isPending || !writeEnabled || !readyToReject}
              onClick={reject}
              className="rounded-md border border-[#F87171]/50 px-3 py-2 font-mono text-xs uppercase tracking-wider text-[#F87171] disabled:opacity-50"
            >
              Reject <span className="opacity-60">R</span>
            </button>
          </div>
          <p className="mt-2 font-mono text-[10px] text-[#7C93A8]">
            Narrow needs an edited payload and a reason. Reject needs a reason.
            Flags never block Accept.
          </p>
        </>
      ) : proposal.status === "held_low_confidence" ? (
        <p className="mt-4 text-xs text-[#E4B54E]">
          {proposal.hold_reason === "no_material_enrichment"
            ? "Held because the enrichment adds no new source or material field change."
            : "Held below the configured confidence floor."}{" "}
          It remains visible for inspection but cannot be approved unless a later
          grounded run strengthens and merges it.
        </p>
      ) : proposal.status === "held_non_transferable" ? (
        <div className="mt-4 text-xs text-[#E4B54E]">
          <p>
            Held by the transferability rules: grounded, but nothing here names
            something a product surface could act on. Nothing was discarded — the
            record and the reasoning below both stay, and no source record was
            marked as read because of this.
          </p>
          {proposal.transferability && (
            <dl className="mt-3 space-y-1 font-mono text-[10px] text-[#8CA495]">
              {proposal.transferability.checks.map((check) => (
                <div key={check.check} className="flex gap-2">
                  <dt
                    className={
                      check.outcome === "fail"
                        ? "w-24 shrink-0 uppercase text-[#F87171]"
                        : check.outcome === "warn"
                          ? "w-24 shrink-0 uppercase text-[#E4B54E]"
                          : "w-24 shrink-0 uppercase text-[#34D399]"
                    }
                  >
                    {check.check}
                  </dt>
                  <dd>{check.reason}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
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
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [focusedPath, setFocusedPath] = useState<string | null>(
    () => proposals[0]?.path ?? null,
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const cardNodes = useRef(new Map<string, HTMLElement>());

  // Both held statuses drop out of the primary queue: neither can be acted on,
  // and the point of the transferability pass is that its holds cost the
  // reader nothing. They stay listed below, in full, with their reasons.
  const isHeld = (status: string): boolean =>
    status === "held_low_confidence" || status === "held_non_transferable";
  const held = useMemo(
    () => proposals.filter((item) => isHeld(item.proposal.status)),
    [proposals],
  );
  const primary = useMemo(
    () => proposals.filter((item) => !isHeld(item.proposal.status)),
    [proposals],
  );
  const navigable = useMemo(() => [...primary, ...held], [primary, held]);
  const navigablePaths = useMemo(
    () => navigable.map((item) => item.path).join("\0"),
    [navigable],
  );
  const groups = new Map<string, ReviewProposal[]>();
  for (const item of primary) {
    const key = `${item.proposal.type}::${item.proposal.target}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const focusPath = useCallback((path: string) => {
    setFocusedPath(path);
    const node = cardNodes.current.get(path);
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    node?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const paths = navigablePaths.split("\0").filter(Boolean);
    if (focusedPath && paths.includes(focusedPath)) return;
    setFocusedPath(paths[0] ?? null);
  }, [focusedPath, navigablePaths]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) return;
      const key = event.key;
      if (key === "?" || (event.shiftKey && key === "/")) {
        event.preventDefault();
        setShowShortcuts((value) => !value);
        return;
      }
      if (navigable.length === 0) return;
      const index = Math.max(
        0,
        navigable.findIndex((item) => item.path === focusedPath),
      );
      if (key === "j" || key === "J" || key === "ArrowDown") {
        event.preventDefault();
        focusPath(navigable[Math.min(navigable.length - 1, index + 1)].path);
        return;
      }
      if (key === "k" || key === "K" || key === "ArrowUp") {
        event.preventDefault();
        focusPath(navigable[Math.max(0, index - 1)].path);
        return;
      }
      const path = focusedPath ?? navigable[0].path;
      if (key === "a" || key === "A") {
        event.preventDefault();
        document
          .querySelector<HTMLButtonElement>(`[data-review-accept="${path}"]`)
          ?.click();
        return;
      }
      if (key === "n" || key === "N") {
        event.preventDefault();
        const narrow = document.querySelector<HTMLButtonElement>(
          `[data-review-narrow="${path}"]`,
        );
        if (narrow && !narrow.disabled) {
          narrow.click();
        } else {
          const details = document
            .querySelector(`[data-review-path="${path}"]`)
            ?.querySelector("details");
          if (details) details.open = true;
          document
            .querySelector<HTMLInputElement>(`[data-review-reason="${path}"]`)
            ?.focus();
        }
        return;
      }
      if (key === "r" || key === "R") {
        event.preventDefault();
        const reject = document.querySelector<HTMLButtonElement>(
          `[data-review-reject="${path}"]`,
        );
        if (reject && !reject.disabled) {
          reject.click();
        } else {
          document
            .querySelector<HTMLInputElement>(`[data-review-reason="${path}"]`)
            ?.focus();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusedPath, focusPath, navigable]);

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

  function renderCard(item: ReviewProposal): ReactElement {
    return (
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
        focused={focusedPath === item.path}
        onFocusCard={() => setFocusedPath(item.path)}
        cardRef={(node) => {
          if (node) cardNodes.current.set(item.path, node);
          else cardNodes.current.delete(item.path);
        }}
      />
    );
  }

  return (
    <div className="mt-6 space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-wider text-[#7C93A8]">
          Shortcuts: J/K navigate · A accept · N narrow · R reject · ? legend
        </p>
        <button
          type="button"
          onClick={() => setShowShortcuts((value) => !value)}
          className="font-mono text-[10px] uppercase tracking-wider text-[#34D399] hover:underline"
        >
          {showShortcuts ? "Hide legend" : "Show legend"}
        </button>
      </div>
      {showShortcuts && (
        <div className="rounded-lg border border-[#243329] bg-[#151F1A] p-4 font-mono text-xs text-[#8CA495]">
          <ul className="space-y-1">
            <li>
              <span className="text-[#E6EFE8]">J / ↓</span> — next proposal
            </li>
            <li>
              <span className="text-[#E6EFE8]">K / ↑</span> — previous proposal
            </li>
            <li>
              <span className="text-[#E6EFE8]">A</span> — accept focused proposal
            </li>
            <li>
              <span className="text-[#E6EFE8]">N</span> — narrow (edit + reason required)
            </li>
            <li>
              <span className="text-[#E6EFE8]">R</span> — reject (reason required)
            </li>
            <li>
              <span className="text-[#E6EFE8]">?</span> — toggle this legend
            </li>
          </ul>
        </div>
      )}

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
          <div className="space-y-4">{items.map(renderCard)}</div>
        </section>
      ))}

      {held.length > 0 && (
        <details className="rounded-lg border border-[#E4B54E]/30 bg-[#151F1A] p-4">
          <summary className="cursor-pointer font-display text-lg text-[#E4B54E]">
            Held bucket · {held.length}
          </summary>
          <p className="mt-2 text-xs text-[#8CA495]">
            Collapsed by default. These grounded items did not clear the
            configured confidence floor, added no material enrichment, or were
            held by the transferability rules. Nothing here was discarded: each
            card carries the reason it was set aside.
          </p>
          <div className="mt-4 space-y-4">{held.map(renderCard)}</div>
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
              Accept selected
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

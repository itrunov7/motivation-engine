"use client";

import { useState, useTransition } from "react";
import type { Proposal } from "@/lib/types";
import {
  approveProposalAction,
  editProposalAction,
  rejectProposalAction,
} from "./actions";

export interface ReviewProposal {
  path: string;
  proposal: Proposal;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "not decided";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function ProposalCard({ item }: { item: ReviewProposal }) {
  const { proposal, path } = item;
  const [note, setNote] = useState("");
  const [payload, setPayload] = useState(() =>
    JSON.stringify(proposal.payload, null, 2),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const actionable = proposal.status === "pending" || proposal.status === "edited";

  function run(
    action: () => Promise<{ ok: true; decisionId: string } | { ok: false; error: string }>,
  ): void {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      setMessage(
        result.ok ? `Committed with decision ${result.decisionId}.` : result.error,
      );
    });
  }

  return (
    <article className="rounded-lg border border-[#243329] bg-[#151F1A] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
            {proposal.type} · {proposal.id}
          </p>
          <h2 className="mt-1 font-display text-lg font-medium text-[#E6EFE8]">
            Target {proposal.target}
          </h2>
        </div>
        <span className="rounded-full border border-[#243329] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-[#34D399]">
          {proposal.status}
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
          provenance
        </h3>
        <ul className="mt-2 space-y-2">
          {proposal.provenance.map((source) => (
            <li
              key={`${source.corpus_record_id}:${source.quote_or_locus}`}
              className="rounded-md border border-[#243329] bg-[#1A2620] p-3 text-xs leading-relaxed text-[#8CA495]"
            >
              <span className="text-[#E6EFE8]">{source.title}</span>
              {source.doi ? ` · DOI ${source.doi}` : ""}
              <br />
              <span className="font-mono text-[11px] text-[#7C93A8]">
                {source.corpus_record_id}
              </span>
              <p className="mt-1">{source.quote_or_locus}</p>
            </li>
          ))}
        </ul>
      </div>

      <label className="mt-4 block">
        <span className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
          payload
        </span>
        <textarea
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
          disabled={!actionable || isPending}
          rows={14}
          spellCheck={false}
          className="mt-2 w-full rounded-md border border-[#243329] bg-[#0E1512] p-3 font-mono text-xs leading-relaxed text-[#E6EFE8] outline-none focus:border-[#34D399]/60 disabled:opacity-60"
        />
      </label>

      {actionable ? (
        <>
          <label className="mt-3 block">
            <span className="font-mono text-[11px] uppercase tracking-widest text-[#7C93A8]">
              decision note / rejection reason
            </span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={isPending}
              className="mt-2 w-full rounded-md border border-[#243329] bg-[#0E1512] px-3 py-2 text-sm text-[#E6EFE8] outline-none focus:border-[#34D399]/60"
            />
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => approveProposalAction(path, note))}
              className="rounded-md bg-[#34D399] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#0E1512] disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => editProposalAction(path, payload))}
              className="rounded-md border border-[#E4B54E]/50 px-3 py-2 font-mono text-xs uppercase tracking-wider text-[#E4B54E] disabled:opacity-50"
            >
              Save edit
            </button>
            <button
              type="button"
              disabled={isPending || note.trim().length === 0}
              onClick={() => run(() => rejectProposalAction(path, note))}
              className="rounded-md border border-[#F87171]/50 px-3 py-2 font-mono text-xs uppercase tracking-wider text-[#F87171] disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </>
      ) : (
        <p className="mt-4 text-xs text-[#7C93A8]">
          Decided by {proposal.decided_by ?? "unknown"} at{" "}
          {formatTimestamp(proposal.decided_at)}
          {proposal.decision_note ? ` — ${proposal.decision_note}` : ""}
        </p>
      )}

      {message && (
        <p className="mt-3 rounded-md border border-[#243329] bg-[#1A2620] px-3 py-2 text-xs text-[#E6EFE8]">
          {message}
        </p>
      )}
    </article>
  );
}

export default function ReviewClient({
  proposals,
}: {
  proposals: ReviewProposal[];
}) {
  return (
    <div className="mt-6 space-y-4">
      {proposals.map((item) => (
        <ProposalCard key={item.path} item={item} />
      ))}
    </div>
  );
}

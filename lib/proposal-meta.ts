import type { Proposal, ProposalStatus } from "./types";

export const PROPOSAL_STATUS_META: Record<
  ProposalStatus,
  { label: string; actionable: boolean }
> = {
  pending: { label: "awaiting review", actionable: true },
  edited: { label: "edited, awaiting review", actionable: true },
  approved: { label: "approved", actionable: false },
  rejected: { label: "rejected", actionable: false },
  held_low_confidence: { label: "held — low confidence", actionable: false },
  held_non_transferable: {
    label: "held — not transferable",
    actionable: false,
  },
};

export function isActionableProposal(proposal: Proposal): boolean {
  return PROPOSAL_STATUS_META[proposal.status].actionable;
}

/**
 * The prefix every extraction-pipeline run id carries (D-110).
 *
 * `proposed_by` is otherwise a free string, so "was this produced by the
 * extraction pipeline?" was a question no reader could answer structurally —
 * and amendment 2.2 requires the validator to answer it in code rather than by
 * convention, because that is what makes `source_span` required for new items
 * while staying optional for the hand-authored ones. Declared here, in lib, so
 * the writer (tools/extract.ts) and the checker (tools/validate.ts) cannot hold
 * two different ideas of what the marker is.
 */
export const EXTRACTION_RUN_ID_PREFIX = "extraction:";

/**
 * True when a proposal was produced by the extraction pipeline, and therefore
 * MUST carry a re-sliceable span on every evidence provenance item. False for
 * hand-authored and owner-assisted records, which predate D-110 and stay valid
 * without one.
 */
export function isExtractionAuthored(proposedBy: string): boolean {
  return proposedBy.startsWith(EXTRACTION_RUN_ID_PREFIX);
}

/**
 * The instant span_role became required of extraction output (D-129).
 *
 * D-110 needed no such line: no extraction-authored proposal existed before it,
 * so "required of the pipeline" and "required of everything the pipeline has
 * ever written" were the same rule. span_role arrives after a run has already
 * landed eight items, and the decision is explicit that there is NO BACKFILL —
 * a role invented now for a span some model read last week would be my judgement
 * wearing the pipeline's authority, which is the exact substitution the field
 * exists to prevent.
 *
 * So the cutoff is the run's own timestamp, not the file's mtime and not the
 * commit date: `proposed_at` is when the model actually read the record, it is
 * inside the artifact, and it cannot be changed by rewriting history.
 *
 * The hour matters, uncomfortably: the two runs being grandfathered
 * (extraction:github-actions-30618907548 at 09:10Z and -30622558771 at 10:09Z)
 * happened the same DAY the defect they exposed was fixed, so a date-only cutoff
 * would either sweep them in — demanding a backfill the decision forbids — or
 * exempt the next run too.
 */
export const SPAN_ROLE_REQUIRED_FROM = "2026-07-31T12:00:00.000Z";

/**
 * True when an evidence provenance item must carry a span_role (D-129):
 * extraction-authored, and proposed at or after the cutoff. Everything else —
 * hand-authored records, owner-assisted observations, and the first run's output
 * — stays valid without one, and the validator counts how many those are every
 * run so the remainder cannot quietly become permanent.
 */
export function requiresSpanRole(proposal: {
  proposed_by?: string | null;
  proposed_at?: string | null;
}): boolean {
  if (!isExtractionAuthored(proposal.proposed_by ?? "")) return false;
  const proposedAt = proposal.proposed_at ?? "";
  // An unparseable or absent timestamp cannot be shown to be after the cutoff,
  // and inventing a verdict for it would make the rule depend on a bad date.
  return (
    Number.isFinite(Date.parse(proposedAt)) &&
    Date.parse(proposedAt) >= Date.parse(SPAN_ROLE_REQUIRED_FROM)
  );
}

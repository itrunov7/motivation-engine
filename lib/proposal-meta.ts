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

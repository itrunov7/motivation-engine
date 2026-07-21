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

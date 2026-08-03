/**
 * lib/review-flags.ts — advisory triage flags for /review (task: "make
 * /review self-sufficient"). Every flag here is a WARNING, never a block:
 * the owner's Accept/Narrow/Reject verdict is never gated on this module's
 * output, and nothing here changes extraction or gating logic — it reads
 * already-authoritative /effects and /realizations records and the
 * proposal's own provenance, purely to surface a second opinion next to the
 * evidence the owner is already looking at.
 *
 * Three checks:
 * - OVERREACH (effects): a clause of `fact` with no lexical support in any
 *   cited span.
 * - DUPLICATE (realizations): trigger+action similarity against an already
 *   approved realization for the same mechanism (reuses the same
 *   `proposalSimilarity` metric extraction uses to merge candidates, D-079 —
 *   same question, asked again post-hoc, against authoritative records this
 *   time rather than other pending proposals).
 * - WEAK ANCHOR (inferred realizations): the effect clause the `pattern`
 *   claims to derive from is not identifiable in the referenced effect's
 *   `fact` — measured as low token containment AND no shared concept-group
 *   topic, because pure lexical overlap alone would also flag every
 *   well-formed inferred realization (a domain transfer is expected to use
 *   different words from the effect it transfers from).
 */
import { resolveEffectBasis } from "./effect-basis";
import { listApprovedRealizations } from "./realization-basis";
import { normalizeQualityText, proposalSimilarity } from "./proposal-quality";
import type {
  EffectProposal,
  EvidenceProvenanceItem,
  Proposal,
  Realization,
  RealizationProposal,
} from "./types";

export type FlagKind = "overreach" | "duplicate" | "weak_anchor";

export interface ProposalFlag {
  kind: FlagKind;
  /** Always "warning" — flags advise, they never block Accept (task rule). */
  severity: "warning";
  summary: string;
  detail: string;
  /** OVERREACH: the exact unsupported clause, for inline highlighting. */
  highlight?: string;
  /** DUPLICATE: the closest existing realization, for a side-by-side view. */
  compareRecord?: {
    id: string;
    term: string;
    description_as_reported: string;
    pattern?: string;
    score: number;
  };
  /** WEAK ANCHOR: the referenced effect, for a side-by-side view. */
  anchorEffect?: { id: string; fact: string };
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeQualityText(text)
      .split(" ")
      .filter((token) => token.length > 1),
  );
}

/** Fraction of `needle`'s tokens that occur in `haystack`. */
function containment(needle: Set<string>, haystack: Set<string>): number {
  if (needle.size === 0) return 1;
  let hit = 0;
  for (const token of Array.from(needle)) if (haystack.has(token)) hit += 1;
  return hit / needle.size;
}

/** Rough clause split — sentence boundaries plus ", but/and/yet" and ";". */
function clausesOf(text: string): string[] {
  return text
    .split(/(?:,\s*(?:but|and|yet)\s+|;\s*|(?<=[.!?])\s+)/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function isEvidenceItem(
  item: EffectProposal["provenance"][number],
): item is EvidenceProvenanceItem {
  return !("corpus_kind" in item) || item.corpus_kind === "evidence";
}

// --- OVERREACH -------------------------------------------------------------

/**
 * A clause counts as supported once at least this fraction of its content
 * words occur in the union of cited span quotes. Calibrated against the
 * three approved CL-14 effects (cueing, split-attention post-edit, expertise
 * reversal), whose fact clauses all restate their own citations closely
 * enough to clear it, and reported rather than tuned further if a future
 * case sits right at the edge.
 */
export const OVERREACH_SUPPORT_THRESHOLD = 0.5;

function overreachFlags(proposal: EffectProposal): ProposalFlag[] {
  const evidenceSpans = proposal.payload.provenance.filter(isEvidenceItem);
  if (evidenceSpans.length === 0) return [];
  const supportTokens = new Set<string>();
  for (const item of evidenceSpans) {
    for (const token of Array.from(tokenSet(item.quote_or_locus))) {
      supportTokens.add(token);
    }
  }
  const flags: ProposalFlag[] = [];
  for (const clause of clausesOf(proposal.payload.fact)) {
    const clauseTokens = tokenSet(clause);
    if (clauseTokens.size === 0) continue;
    const score = containment(clauseTokens, supportTokens);
    if (score < OVERREACH_SUPPORT_THRESHOLD) {
      flags.push({
        kind: "overreach",
        severity: "warning",
        summary:
          `OVERREACH — a clause of the fact has no lexical support in the ` +
          `cited span(s) (${Math.round(score * 100)}% of its content words ` +
          `are covered).`,
        detail: `Clause not supported by any cited quote: "${clause}"`,
        highlight: clause,
      });
    }
  }
  return flags;
}

// --- DUPLICATE ---------------------------------------------------------

/**
 * Same metric and same shape of question as extraction's duplicate_similarity
 * gate (D-079), asked again here against AUTHORITATIVE realizations rather
 * than other pending proposals — the two questions are related but not
 * identical, so this threshold is calibrated independently against the
 * context-aware-tool-simplification / expertise-based-guidance-toggle pair
 * (D-120) rather than borrowed from corpora/_ops/extraction.json.
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.3;

function duplicateFlags(
  proposal: RealizationProposal,
  root: string,
): ProposalFlag[] {
  const approved = listApprovedRealizations(proposal.target, root);
  let best: { record: Realization; score: number } | null = null;
  for (const record of approved) {
    if (record.id === proposal.payload.id) continue;
    // proposalSimilarity only reads .type/.target/.payload — an approved
    // Realization record is wrapped in the minimum shape it needs rather
    // than a full synthetic envelope.
    const wrapped = {
      type: "realization",
      target: proposal.target,
      payload: record,
    } as unknown as Proposal;
    const score = proposalSimilarity(proposal, wrapped);
    if (!best || score > best.score) best = { record, score };
  }
  if (!best || best.score < DUPLICATE_SIMILARITY_THRESHOLD) return [];
  return [
    {
      kind: "duplicate",
      severity: "warning",
      summary:
        `DUPLICATE — ${Math.round(best.score * 100)}% trigger+action ` +
        `similarity to the already-approved "${best.record.term}" for ${proposal.target}.`,
      detail:
        `Closest existing record: ${best.record.id} — "${best.record.term}". ` +
        `${best.record.pattern ? `Pattern: ${best.record.pattern}` : `Description: ${best.record.description_as_reported}`}`,
      compareRecord: {
        id: best.record.id,
        term: best.record.term,
        description_as_reported: best.record.description_as_reported,
        pattern: best.record.pattern,
        score: best.score,
      },
    },
  ];
}

// --- WEAK ANCHOR ---------------------------------------------------------

/**
 * Coarse concept groups used only to tell "different words, same idea" apart
 * from "different words, different idea" when a pattern's raw lexical
 * overlap with its anchor effect's fact is near zero — which is expected for
 * every well-formed inferred realization, since a domain transfer is
 * SUPPOSED to restate the finding in product-UI language. Intentionally
 * small and hand-maintained; extend it as new mechanisms' inferred
 * realizations are reviewed, rather than treating it as exhaustive.
 */
const CONCEPT_GROUPS: Record<string, string[]> = {
  instructional_support: [
    "guidance", "guided", "guide", "walkthrough", "walkthroughs", "wizard",
    "tutorial", "tutorials", "overlay", "scaffold", "scaffolding",
    "instruction", "instructions", "instructional", "technique", "techniques",
    "coach", "hint", "hints", "tip", "tips", "facilitate", "support", "help",
    "steps", "sequence", "exploration",
  ],
  complexity_surface: [
    "feature", "features", "configuration", "config", "option", "options",
    "toolbar", "toolbars", "tool", "tools", "capability", "capabilities",
    "functionality", "setting", "settings", "panel", "panels", "menu", "menus",
  ],
};

function conceptGroupsOf(text: string): Set<string> {
  const words = tokenSet(text);
  const groups = new Set<string>();
  for (const [group, vocabulary] of Object.entries(CONCEPT_GROUPS)) {
    if (vocabulary.some((term) => words.has(term))) groups.add(group);
  }
  return groups;
}

/** Below this raw token-containment score, the pattern is treated as having
 * no direct lexical echo of the clause — expected for a domain transfer. */
export const WEAK_ANCHOR_TOKEN_THRESHOLD = 0.12;

function weakAnchorFlags(
  proposal: RealizationProposal,
  root: string,
): ProposalFlag[] {
  if (proposal.payload.derivation !== "inferred") return [];
  const pattern = proposal.payload.pattern;
  if (!pattern) return [];
  const effectRefs = proposal.payload.effect_refs ?? [];
  const patternTokens = tokenSet(pattern);
  const patternGroups = conceptGroupsOf(pattern);
  const flags: ProposalFlag[] = [];
  for (const effectId of effectRefs) {
    const basis = resolveEffectBasis(effectId, root);
    if (!basis) continue;
    const fact = basis.effect.fact;
    let bestClause = "";
    let bestScore = 0;
    for (const clause of clausesOf(fact)) {
      const score = containment(patternTokens, tokenSet(clause));
      if (score > bestScore) {
        bestScore = score;
        bestClause = clause;
      }
    }
    const factGroups = conceptGroupsOf(fact);
    const sharesTopic = Array.from(patternGroups).some((group) =>
      factGroups.has(group),
    );
    if (
      bestScore < WEAK_ANCHOR_TOKEN_THRESHOLD &&
      !sharesTopic &&
      patternGroups.size > 0
    ) {
      flags.push({
        kind: "weak_anchor",
        severity: "warning",
        summary:
          `WEAK ANCHOR — no clause of ${effectId}'s fact is identifiable in ` +
          `this pattern's directive (closest clause covers ${Math.round(bestScore * 100)}% ` +
          `of the pattern's content words; no shared topic either).`,
        detail:
          `Effect ${effectId} fact: "${fact}". Pattern: "${pattern}". ` +
          `Closest clause: "${bestClause || "none"}".`,
        anchorEffect: { id: effectId, fact },
      });
    }
  }
  return flags;
}

// --- entry point -----------------------------------------------------------

export function computeProposalFlags(
  proposal: Proposal,
  root: string = process.cwd(),
): ProposalFlag[] {
  if (proposal.type === "effect") return overreachFlags(proposal);
  if (proposal.type === "realization") {
    return [
      ...duplicateFlags(proposal, root),
      ...weakAnchorFlags(proposal, root),
    ];
  }
  return [];
}

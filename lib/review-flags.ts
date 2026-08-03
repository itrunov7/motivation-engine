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
 * - DUPLICATE (realizations): the directive's TRIGGER (the condition) and
 *   ACTION (the imperative change) are extracted as separate fields and each
 *   scored against the same field of an already-approved realization for the
 *   same mechanism (D-139) — not whole-record lexical overlap. Two records
 *   can describe the same rule in different words ("wizard" vs "guided
 *   walkthrough"; "power-user interface" vs "exploration mode"), and
 *   whole-text Jaccard scores synonyms low by construction; comparing the two
 *   structural halves, bridged by CONCEPT_GROUPS, is what the owner's own
 *   rejection note actually judged ("same trigger and same action").
 * - WEAK ANCHOR (inferred realizations): the effect clause the `pattern`
 *   claims to derive from is not identifiable in the referenced effect's
 *   `fact` — measured as low token containment AND no shared concept-group
 *   topic, because pure lexical overlap alone would also flag every
 *   well-formed inferred realization (a domain transfer is expected to use
 *   different words from the effect it transfers from).
 */
import { resolveEffectBasis } from "./effect-basis";
import { listApprovedRealizations } from "./realization-basis";
import { normalizeQualityText } from "./proposal-quality";
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
 * words occur in the union of cited span quotes. Fixed at this value and
 * never tuned against the owner's Accept/Reject history (D-139): flag
 * accuracy is measured against the cited source text, not against what an
 * owner has approved in the past. The approved cueing effect fires this flag
 * at ~47% clause coverage — that is not a false positive to calibrate away.
 * Its fact was owner-edited to a weaker claim than the model first drafted,
 * and the edited wording genuinely restates the cited span more loosely than
 * this bar requires; agreeing with a past Accept is not the same question as
 * whether today's words are supported by today's citation.
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
 * Same threshold as before the metric changed (D-139). Whole-record lexical
 * overlap (proposalSimilarity, D-079's merge metric reused post-hoc) scored
 * context-aware-tool-simplification against expertise-based-guidance-toggle
 * at 0.294 — just under this bar — because the two records restate the same
 * rule in different words and whole-text Jaccard scores synonyms low by
 * construction. The metric below is structural instead: it is not
 * recalibrated to make that pair cross the line, because lowering the number
 * would also flag genuinely unrelated realizations that happen to share
 * incidental vocabulary.
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.3;

/**
 * Coarse concept groups bridging synonyms that pure token overlap treats as
 * unrelated — used by DUPLICATE's trigger/action fields below and by WEAK
 * ANCHOR's pattern/fact comparison further down. Intentionally small and
 * hand-maintained; extend it as new mechanisms' inferred realizations are
 * reviewed, rather than treating it as exhaustive.
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
  // The "replace it with an unguided/expert-level surface" half of a guidance
  // removal — distinct from instructional_support, which names the thing
  // being REMOVED, not what replaces it.
  unguided_interface: ["exploration", "power", "density", "unguided"],
};

/** Concept groups a token set touches, via CONCEPT_GROUPS membership. */
function groupsOfTokens(tokens: Set<string>): Set<string> {
  const groups = new Set<string>();
  for (const [group, vocabulary] of Object.entries(CONCEPT_GROUPS)) {
    if (vocabulary.some((term) => tokens.has(term))) groups.add(group);
  }
  return groups;
}

/**
 * Condition markers that separate a pattern's ACTION from its TRIGGER, tried
 * longest-first so "only after" is not swallowed by the shorter "after".
 * Intentionally small: these are the markers actually seen in CL-14's
 * inferred realizations, extended as new phrasing is reviewed rather than
 * treated as an exhaustive grammar.
 */
const TRIGGER_MARKERS = ["only after", "once", "after", "when", "if"] as const;
const TRIGGER_MARKER_RE = new RegExp(`\\b(?:${TRIGGER_MARKERS.join("|")})\\b`, "i");

const PATTERN_PLACEHOLDER_RE = /\{[a-z0-9_]*\}/gi;
const PATTERN_NUMBER_WORD_RE =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi;

/**
 * Split a realization directive into its condition (trigger) and its
 * imperative change (action). `{param}` placeholders and spelled-out number
 * words are stripped first (mirrors patternParameterErrors' BARE_NUMBER
 * check, D-115) so a declared tunable ("{core_task_completions_before_exploration}
 * times") and an un-parameterized prose number ("three times") compare as the
 * same trigger shape instead of differing only by that literal.
 *
 * No marker found means the text has no explicit condition — expected for
 * `description_as_reported` on a `reported` realization, which describes an
 * observed embodiment rather than an if/then rule. It is returned as
 * action-only rather than forced into a trigger it doesn't have.
 */
function extractTriggerAction(text: string): { trigger: string; action: string } {
  const cleaned = text
    .replace(PATTERN_PLACEHOLDER_RE, " ")
    .replace(PATTERN_NUMBER_WORD_RE, " ");
  const match = TRIGGER_MARKER_RE.exec(cleaned);
  if (!match) return { trigger: "", action: cleaned };
  return { action: cleaned.slice(0, match.index), trigger: cleaned.slice(match.index) };
}

/**
 * The field DUPLICATE compares: `pattern` when present, since an inferred
 * directive genuinely has trigger/action shape; `description_as_reported`
 * otherwise, for a `reported` record with no directive to split.
 */
function directiveTextOf(record: {
  pattern?: string;
  description_as_reported: string;
}): string {
  return record.pattern ?? record.description_as_reported;
}

function jaccardContainment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of Array.from(a)) if (b.has(token)) intersection += 1;
  const union = new Set([...Array.from(a), ...Array.from(b)]).size;
  const jaccard = intersection / union;
  const raw = intersection / Math.min(a.size, b.size);
  return Math.max(jaccard, raw * 0.9);
}

/**
 * Field-level similarity used by both trigger and action comparison: raw
 * token overlap, or — when neither field shares raw words — a synonym
 * bridge through CONCEPT_GROUPS, weighted down slightly (0.8) since a shared
 * coarse topic is a softer signal than an actual shared word. This is what
 * lets "wizard" match "guided walkthrough" and "power-user interface" match
 * "exploration mode" without matching text that shares no concept at all.
 */
function fieldSimilarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  const raw = jaccardContainment(leftTokens, rightTokens);
  const leftGroups = groupsOfTokens(leftTokens);
  const rightGroups = groupsOfTokens(rightTokens);
  const groupOverlap =
    leftGroups.size === 0 || rightGroups.size === 0
      ? 0
      : Array.from(leftGroups).filter((group) => rightGroups.has(group)).length /
        Math.min(leftGroups.size, rightGroups.size);
  return Math.max(raw, groupOverlap * 0.8);
}

/**
 * Structural similarity: trigger scored against trigger, action against
 * action, aggregated as the MINIMUM of the two — a realization that shares
 * an action but fires on a different condition is not the duplicate the
 * owner's rejection note described ("same trigger AND same action"), and
 * neither is one that shares a condition but changes something else.
 *
 * When BOTH sides have no extractable trigger (two action-only fields, e.g.
 * comparing two `reported` descriptions), the trigger dimension has nothing
 * to disagree on and must not zero out a real action match — it falls back
 * to the action score instead of scoring an empty-vs-empty comparison as 0.
 */
function structuralSimilarity(
  left: string,
  right: string,
): { score: number; trigger: number; action: number } {
  const leftParts = extractTriggerAction(left);
  const rightParts = extractTriggerAction(right);
  const action = fieldSimilarity(leftParts.action, rightParts.action);
  const trigger =
    leftParts.trigger === "" && rightParts.trigger === ""
      ? action
      : fieldSimilarity(leftParts.trigger, rightParts.trigger);
  return { score: Math.min(trigger, action), trigger, action };
}

function duplicateFlags(
  proposal: RealizationProposal,
  root: string,
): ProposalFlag[] {
  const approved = listApprovedRealizations(proposal.target, root);
  const candidateText = directiveTextOf(proposal.payload);
  let best: { record: Realization; score: number; trigger: number; action: number } | null = null;
  for (const record of approved) {
    if (record.id === proposal.payload.id) continue;
    const { score, trigger, action } = structuralSimilarity(
      candidateText,
      directiveTextOf(record),
    );
    if (!best || score > best.score) best = { record, score, trigger, action };
  }
  if (!best || best.score < DUPLICATE_SIMILARITY_THRESHOLD) return [];
  return [
    {
      kind: "duplicate",
      severity: "warning",
      summary:
        `DUPLICATE — ${Math.round(best.score * 100)}% trigger+action ` +
        `similarity to the already-approved "${best.record.term}" for ${proposal.target} ` +
        `(trigger ${Math.round(best.trigger * 100)}%, action ${Math.round(best.action * 100)}%).`,
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
 * `groupsOfTokens` (defined above, shared with DUPLICATE) tells "different
 * words, same idea" apart from "different words, different idea" when a
 * pattern's raw lexical overlap with its anchor effect's fact is near zero —
 * expected for every well-formed inferred realization, since a domain
 * transfer is SUPPOSED to restate the finding in product-UI language.
 */
function conceptGroupsOf(text: string): Set<string> {
  return groupsOfTokens(tokenSet(text));
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

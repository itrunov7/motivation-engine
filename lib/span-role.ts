/**
 * lib/span-role.ts — check what a quoted span is DOING in the text it came from
 * (D-129).
 *
 * THE FAILURE THIS ADDRESSES. The grounding gate proves a quote is verbatim. It
 * cannot prove the quote means what the candidate says it means, because a paper
 * is not one voice: it restates what the literature predicts, states what it set
 * out to test, describes what it did, reports what it found, and admits what it
 * cannot show. Only the fourth is a finding.
 *
 * Two of the three effect proposals from the first extraction run quoted a
 * BACKGROUND premise as though the study had found it. One of those papers went
 * on to report the OPPOSITE of the sentence quoted from it — a structured
 * abstract whose own CONCLUSIONS section names "a reverse modality effect",
 * grounding a proposal that asserted the effect. Every span was verbatim. Every
 * hash matched. The gate had nothing to say, because the defect was not in the
 * text but in the text's role.
 *
 * WHAT THIS MODULE DOES. The extraction model — the only pass that reads a
 * record — asserts a role per citation. Then this module argues with it, using
 * the source text alone:
 *
 *   1. STRUCTURE. Many abstracts label their own sections ("BACKGROUND:",
 *      "RESULTS:"). When a span falls inside a labelled section, the label
 *      constrains what the span can be. A sentence in the BACKGROUND section is
 *      not this paper's finding, whatever the model asserts.
 *   2. DOWNSTREAM CONTRADICTION. When a span asserted as a finding is followed,
 *      in the same stored text, by a sentence that reverses it AND talks about
 *      the same things, the span is a premise the paper went on to overturn.
 *
 * Both checks are deliberately silent when they cannot tell: an unlabelled
 * abstract gets no structural verdict, and an unlocatable quote gets neither.
 * Refusing on a guess would trade a false positive in the registry for a false
 * negative in the funnel, and the funnel at least is visible.
 *
 * Every refusal carries what triggered it — the section label, or the matched
 * reversal marker with the shared words and the contradicting sentence — so a
 * wrong refusal is diagnosable rather than merely annoying.
 */

import { locateSpan } from "./span-locate";
import { SPAN_ROLES, isSpanRole, type SpanRole } from "./types";

export type SpanRoleRefusalReason =
  | "span_role_missing"
  | "span_role_contradicted_by_structure"
  | "premise_contradicted_downstream";

export interface SpanRoleAccepted {
  ok: true;
  role: SpanRole;
}

export interface SpanRoleRefused {
  ok: false;
  reason: SpanRoleRefusalReason;
  detail: string;
}

export type SpanRoleVerdict = SpanRoleAccepted | SpanRoleRefused;

/**
 * Section labels, mapped to the roles a span inside them may claim.
 *
 * The asymmetry is the point. `finding` appears only under sections that report
 * results, so a span in a BACKGROUND or METHOD section cannot be asserted as
 * this paper's finding. The reverse laxity is intentional: a results section may
 * well restate prior work or admit a limitation, so those roles stay admissible
 * there — and `background` is refused downstream by the finding requirement
 * anyway, so tolerating it here costs nothing.
 *
 * Labels are matched against a closed vocabulary rather than "any capitalised
 * word before a colon". An unknown label leaves its region UNLABELLED and the
 * structural check silent, which is the safe direction: a "Note:" or a
 * "Trial registration:" heading must not silently redefine what the sentences
 * under it are allowed to be.
 */
const SECTION_ROLES: readonly (readonly [readonly string[], readonly SpanRole[]])[] = [
  [
    [
      "background",
      "introduction",
      "context",
      "rationale",
      "importance",
      "prior work",
      // Compound headings are common enough to matter and unambiguous when both
      // halves map to the same admissible set.
      "background & aims",
      "background and aims",
      "introduction & aims",
      "introduction and aims",
    ],
    ["background", "hypothesis"],
  ],
  [
    [
      "aim",
      "aims",
      "objective",
      "objectives",
      "purpose",
      "goal",
      "goals",
      "hypothesis",
      "hypotheses",
      "research question",
      "research questions",
      "question",
      "aims & objectives",
      "aims and objectives",
    ],
    ["hypothesis", "background"],
  ],
  [
    [
      "method",
      "methods",
      "methodology",
      "materials and methods",
      "design",
      "study design",
      "sample",
      "participants",
      "subjects",
      "setting",
      "procedure",
      "procedures",
      "measures",
      "intervention",
      "interventions",
      "data",
      "data sources",
      "data collection",
      "analysis",
      "statistical analysis",
      "study selection",
      "eligibility criteria",
      "selection criteria",
      "study characteristics",
      "main outcome measures",
      "outcome measures",
    ],
    ["method", "background", "hypothesis"],
  ],
  [
    [
      "result",
      "results",
      "main results",
      "key results",
      "finding",
      "findings",
      "outcome",
      "outcomes",
      "conclusion",
      "conclusions",
      "discussion",
      "implications",
      "significance",
      "interpretation",
    ],
    ["finding", "limitation", "background"],
  ],
  [["limitation", "limitations"], ["limitation", "finding"]],
];

/**
 * Sentences that overturn what came before them.
 *
 * Scoped to REVERSAL, not to negation in general: "did not" on its own appears
 * throughout ordinary academic prose, so the verbs it may negate are enumerated.
 * "as opposed to" is deliberately absent — it introduces a contrast between two
 * conditions, which is how findings are normally stated, not a retraction of one.
 */
const REVERSAL_MARKERS: readonly RegExp[] = [
  // "reverse-engineering" is a method, not a retraction. Measured: it was the
  // one spurious match across 391 CL-14 abstracts probed at their opening
  // sentence, so the exclusion is a fix for an observed false positive rather
  // than an imagined one.
  /\breverse[ds]?\b(?![-\s]?engineer)/i,
  /\breversal\b/i,
  /\bopposite\b/i,
  /\bcontrary to\b/i,
  /\bonly a weak\b/i,
  /\bfail(?:ed|s|ure)? to (?:replicate|find|generalise|generalize|show|emerge|hold)\b/i,
  /\b(?:did|does|do) not (?:replicate|generalise|generalize|hold|extend|transfer|appear|emerge|support|survive)\b/i,
  /\b(?:was|were) not (?:replicated|supported|confirmed|observed|found|significant)\b/i,
  /\bno (?:statistically )?(?:significant|reliable|detectable|measurable) (?:effect|difference|benefit|advantage|improvement|gain|change)\b/i,
  /\bno evidence (?:of|for|that)\b/i,
];

/**
 * Words too common to establish that two sentences are about the same thing.
 * Short tokens are dropped by length, so this only needs the frequent long ones.
 */
const OVERLAP_STOPWORDS = new Set([
  "also",
  "been",
  "both",
  "each",
  "even",
  "from",
  "have",
  "here",
  "however",
  "into",
  "less",
  "more",
  "much",
  "only",
  "other",
  "over",
  "same",
  "some",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "thus",
  "very",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "study",
  "studies",
  "paper",
  "article",
  "research",
  "used",
  "using",
  "found",
  "shown",
  "show",
  // Long but empty: these carry no topic, and letting them count toward the
  // overlap threshold was observed to push borderline sentences over it.
  "previous",
  "possible",
  "important",
  "different",
  "between",
  "because",
  "during",
  "within",
  "further",
  "additional",
  "particular",
  "general",
]);

/**
 * How many distinctive words a contradicting sentence must share with the span
 * before the two count as being about the same thing. Three, because two is
 * reachable by any pair of sentences in one abstract ("effect", "learning"),
 * and because a wrongly dropped candidate is recoverable while a wrongly filed
 * fact is not.
 */
const OVERLAP_THRESHOLD = 3;

interface Section {
  label: string;
  /** Offset of the label's first character in the raw source. */
  at: number;
  allowed: readonly SpanRole[];
}

function rolesForLabel(label: string): readonly SpanRole[] | null {
  const normalized = label.trim().toLowerCase().replace(/\s+/g, " ");
  for (const [labels, roles] of SECTION_ROLES) {
    if (labels.includes(normalized)) return roles;
  }
  return null;
}

/**
 * The labelled sections of a source text, in order.
 *
 * A label counts only when it is in the vocabulary AND the text carries at least
 * two of them: one heading does not make a structured abstract, and treating it
 * as one would let a single "Conclusion:" silently license every sentence after
 * it as a finding.
 */
export function sectionsOf(source: string): Section[] {
  const found: Section[] = [];
  // exec in a loop rather than matchAll: the repo targets a lib without
  // downlevelIteration, so iterating the match iterator does not compile.
  const pattern = /(?:^|[.\s])([A-Za-z][A-Za-z &/-]{2,34}?):\s/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const label = match[1];
    const allowed = rolesForLabel(label);
    if (allowed) {
      found.push({
        label: label.trim(),
        at: match.index + match[0].indexOf(label),
        allowed,
      });
    }
    match = pattern.exec(source);
  }
  return found.length >= 2 ? found : [];
}

/** The labelled section an offset falls in, or null if the text is unlabelled. */
export function sectionAt(source: string, offset: number): Section | null {
  let current: Section | null = null;
  for (const section of sectionsOf(source)) {
    if (section.at <= offset) current = section;
    else break;
  }
  return current;
}

function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z\u00C0-\u024F]+/)) {
    if (raw.length < 4) continue;
    // Crude singularisation only: "effects" and "effect" must count as the same
    // word, and anything cleverer would need a stemmer this check does not earn.
    const word = raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (word.length < 4 || OVERLAP_STOPWORDS.has(word) || OVERLAP_STOPWORDS.has(raw)) {
      continue;
    }
    words.add(word);
  }
  return words;
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function reversalMarkerIn(text: string): string | null {
  for (const marker of REVERSAL_MARKERS) {
    const match = marker.exec(text);
    if (match) return match[0];
  }
  return null;
}

export interface DownstreamContradiction {
  marker: string;
  sentence: string;
  shared: string[];
}

/**
 * A sentence AFTER the span that reverses it and is about the same things.
 *
 * Null when the span itself already carries a reversal marker: a span that
 * states the qualification cannot be undone by the qualification. Without this,
 * the honest quote — "Only a weak cueing effect and even a reverse modality
 * effect have been found" — would be refused for being followed by the sentence
 * that explains it.
 */
export function downstreamContradiction(
  source: string,
  spanEnd: number,
  quote: string,
): DownstreamContradiction | null {
  if (reversalMarkerIn(quote)) return null;
  const quoteWords = contentWords(quote);
  for (const sentence of sentencesOf(source.slice(spanEnd))) {
    const marker = reversalMarkerIn(sentence);
    if (!marker) continue;
    const shared = Array.from(contentWords(sentence)).filter((word) =>
      quoteWords.has(word),
    );
    if (shared.length >= OVERLAP_THRESHOLD) {
      return { marker, sentence, shared: shared.sort() };
    }
  }
  return null;
}

export interface SpanRoleInput {
  /** The role as the extraction model asserted it, unvalidated. */
  asserted: unknown;
  /** The record's stored source text, exactly as the span was resolved against. */
  source: string;
  /** The quote, for locating the span when offsets are not yet anchored. */
  quote: string;
  /** Offsets, when the citation has already been anchored (D-110). */
  start?: number;
  end?: number;
}

/**
 * Check one citation's asserted role against the source text.
 *
 * Ordered so that the most specific evidence speaks first: a missing role is a
 * malformed citation, a role the paper's own headings contradict is a structural
 * fact, and a downstream reversal is a textual inference. The finding
 * requirement itself is NOT here — it is a property of the item, not of one
 * citation, because an item may legitimately cite the premise its finding
 * confirms alongside the finding.
 */
export function checkSpanRole(input: SpanRoleInput): SpanRoleVerdict {
  if (!isSpanRole(input.asserted)) {
    return {
      ok: false,
      reason: "span_role_missing",
      detail:
        `citation carried no usable span_role (got ${JSON.stringify(input.asserted)}); ` +
        `one of ${SPAN_ROLES.join("|")} is required of every extraction-authored ` +
        "citation (D-129)",
    };
  }
  const role = input.asserted;
  const located =
    Number.isInteger(input.start) && Number.isInteger(input.end)
      ? { start: input.start as number, end: input.end as number }
      : locateSpan(input.source, input.quote);
  // An unlocatable quote is the grounding gate's business, not this check's; it
  // has already refused, or is about to. Saying nothing here avoids a second
  // reason for one defect.
  if (!located) return { ok: true, role };

  const section = sectionAt(input.source, located.start);
  if (section && !section.allowed.includes(role)) {
    return {
      ok: false,
      reason: "span_role_contradicted_by_structure",
      detail:
        `span_role=${role} asserted for a span inside the source's own ` +
        `"${section.label}" section, which admits only ${section.allowed.join("|")} ` +
        `(offsets ${located.start}-${located.end}, D-129)`,
    };
  }

  if (role === "finding") {
    const quote = input.source.slice(located.start, located.end);
    const contradiction = downstreamContradiction(input.source, located.end, quote);
    if (contradiction) {
      return {
        ok: false,
        reason: "premise_contradicted_downstream",
        detail:
          `span_role=finding asserted for a span the same source later reverses: ` +
          `matched "${contradiction.marker}" in "${contradiction.sentence}", ` +
          `sharing ${contradiction.shared.join(", ")} with the quote (D-129)`,
      };
    }
  }

  return { ok: true, role };
}

/**
 * lib/source-context.ts — render an evidence provenance span in place, without
 * leaving /review (task: "make /review self-sufficient").
 *
 * The stored `quote_or_locus` is a snapshot from whenever the span was
 * resolved (lib/span-locate.ts). Trusting it directly would let /review show
 * text that no longer matches the corpus record it claims to come from. This
 * module instead RE-SLICES the record's current source text at the stored
 * offsets — exactly the check lib/proposal-quality's `spanErrors` already
 * performs for validation — and only ever returns text that passed that
 * check. A hash mismatch (`span_stale`) or an offset that no longer fits
 * returns a status instead of any text, so the caller shows the failure
 * prominently rather than a quote that might not be there anymore.
 *
 * Every evidence corpus record in this repo carries title + abstract only —
 * the whitelisted source APIs (rule 12) never return full text — so the
 * "abstract-only" branch below is not a rare case, it is the only case this
 * corpus ever produces. The windowed 600-before/600-after branch is kept for
 * a hypothetical future record type that stores more than an abstract; today
 * it is unreachable, which is expected rather than a bug.
 */
import { findCorpusRecord } from "./corpus";
import { evidenceSourceText, spanErrors } from "./proposal-quality";
import type { EvidenceProvenanceItem, KnowledgeProvenanceItem } from "./types";

export const SOURCE_CONTEXT_WINDOW_CHARS = 600;

export type SourceContextStatus =
  | "full_abstract"
  | "excerpt"
  | "span_stale"
  | "span_out_of_range"
  | "span_does_not_reslice"
  | "record_missing";

export interface SourceContext {
  status: SourceContextStatus;
  /** Human-facing label for the block header. */
  label: string;
  /** Present only on a failure status — the raw spanErrors() message. */
  detail?: string;
  /** Text immediately before the marked span, within the rendered window. */
  before?: string;
  /** The span itself, derived by re-slicing — never the stored quote_or_locus. */
  span?: string;
  /** Text immediately after the marked span, within the rendered window. */
  after?: string;
  /** True when the whole abstract is shown rather than a windowed excerpt. */
  isFullText?: boolean;
}

/** True for the only provenance kind that ever carries a source_span. */
function isEvidenceItem(
  item: KnowledgeProvenanceItem,
): item is EvidenceProvenanceItem {
  return !("corpus_kind" in item) || item.corpus_kind === "evidence";
}

const SPAN_CONDITION_LABELS: Record<string, string> = {
  span_stale:
    "span_stale — the source record has changed since this span was resolved",
  span_out_of_range:
    "span_out_of_range — the stored offsets no longer fit the source text",
  span_does_not_reslice:
    "span_does_not_reslice — re-slicing no longer reproduces the stored quote",
};

function matchSpanCondition(errors: string[]): SourceContextStatus | null {
  for (const condition of Object.keys(
    SPAN_CONDITION_LABELS,
  ) as (keyof typeof SPAN_CONDITION_LABELS)[]) {
    if (errors.some((error) => error.startsWith(condition))) {
      return condition as SourceContextStatus;
    }
  }
  return null;
}

/**
 * Build the inline source-context block for one provenance item, or null if
 * the item carries no `source_span` (realization-corpus and inference items
 * never do — the existing /review rendering for those is unchanged).
 */
export function buildSourceContext(
  item: KnowledgeProvenanceItem,
  windowChars: number = SOURCE_CONTEXT_WINDOW_CHARS,
): SourceContext | null {
  if (!isEvidenceItem(item) || !item.source_span) return null;

  const record = findCorpusRecord(item.mechanism_id, item.corpus_record_id);
  if (!record || !("abstract" in record)) {
    return {
      status: "record_missing",
      label: "Source record not found",
      detail: `Corpus record ${item.corpus_record_id} for ${item.mechanism_id} could not be loaded from corpora/evidence.`,
    };
  }

  const rawText = evidenceSourceText(record);
  const errors = spanErrors(item, rawText);
  const failure = matchSpanCondition(errors);
  if (failure) {
    return {
      status: failure,
      label: SPAN_CONDITION_LABELS[failure],
      detail: errors.find((error) => error.startsWith(failure)),
    };
  }

  const { start, end } = item.source_span;

  // Feature-detected rather than inferred from `abstract`'s value: every
  // record this corpus produces today is abstract-only (rule 12 — the
  // whitelisted APIs return no full text), so this is always true in
  // practice. It is written as a duck-typed check on a hypothetical
  // `full_text` field, not as `abstract === null`, so a future record type
  // that DOES carry more than an abstract takes the windowed branch below
  // instead of silently staying on this one.
  const hasFullText =
    typeof (record as { full_text?: unknown }).full_text === "string";

  if (!hasFullText) {
    return {
      status: "full_abstract",
      isFullText: true,
      before: rawText.slice(0, start),
      span: rawText.slice(start, end),
      after: rawText.slice(end),
      label:
        record.abstract === null
          ? "Title only — no abstract was returned by the source API"
          : "Abstract (full — the only source text on file)",
    };
  }

  const windowStart = Math.max(0, start - windowChars);
  const windowEnd = Math.min(rawText.length, end + windowChars);
  return {
    status: "excerpt",
    isFullText: false,
    before: rawText.slice(windowStart, start),
    span: rawText.slice(start, end),
    after: rawText.slice(end, windowEnd),
    label: `Excerpt (${windowChars} characters before/after the span)`,
  };
}

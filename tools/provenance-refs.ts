/**
 * tools/provenance-refs.ts — structural provenance for the extraction pipeline
 * (D-104).
 *
 * THE FAILURE THIS REPLACES. Provenance used to be a string the SYNTHESIS model
 * emitted, and the grounding gate checked only the synthesis output. But the
 * synthesis prompt carries candidates, never records — a model that has not seen
 * an abstract cannot reproduce a verbatim span of it. "Copy the citations
 * verbatim" was a prompt instruction with nothing enforcing it, so every
 * synthesized item failed the gate. Four runs, 30 candidates, 100% dropped. The
 * gate was right; the authorship was wrong.
 *
 * THE INVARIANT. Only the pass that reads a record may establish provenance for
 * it, and it does so mechanically:
 *
 *   1. The extraction pass quotes a record. `anchorCitations` locates that quote
 *      in the stored text and keeps the OFFSETS, discarding the model's string.
 *   2. The span is registered in a ledger under an opaque ref ("p1", "p2", ...).
 *   3. The synthesis pass is shown the claim plus its refs — no quote text, no
 *      record ids, no offsets. It can judge, merge, and refine the claim.
 *   4. `resolveRefs` turns the refs it returns back into citations, with each
 *      quote DERIVED by slicing the record at the stored offsets.
 *
 * So the worst a synthesis model can do is name a span that was already
 * verified, or name nothing. It cannot invent, paraphrase, or mangle one. That
 * is enforced here and in the response schema, not by prompt wording.
 *
 * The grounding gate is untouched (rule 8). Every item still passes through it;
 * this module only changes who wrote the string it inspects.
 */

import { normalizeQualityText } from "../lib/proposal-quality";
import { deriveQuote, locateSpan } from "../lib/span-locate";
import type {
  RejectedCandidateComparison,
  UngroundedDropReason,
} from "../lib/types";

/** A span of a corpus record, resolved once and immutable thereafter. */
export interface ProvenanceSpan {
  /** The opaque handle shown to the synthesis pass. */
  ref: string;
  corpus_record_id: string;
  /** Raw character offsets into the record's source text, end-exclusive. */
  start: number;
  end: number;
}

/**
 * A refusal from anchoring or ref resolution, in the vocabulary the gate already
 * uses. No new reasons: anchoring refuses exactly what the gate refuses, so the
 * nine causes stay nine.
 */
export interface ProvenanceRefusal {
  ok: false;
  reason: UngroundedDropReason;
  detail: string;
  corpus_record_id: string | null;
  /** Both compared strings, when the refusal got far enough to compare any. */
  compared?: RejectedCandidateComparison;
}

/**
 * A citation with the offsets its quote was sliced at. The offsets travel with
 * the citation rather than staying in the ledger because the ledger dies with
 * the run, and a quote whose offsets were discarded can only be re-checked by
 * searching for it again — which is the trust the offsets exist to replace
 * (D-110).
 */
export interface AnchoredCitation {
  record_id: string;
  quote_or_locus: string;
  start: number;
  end: number;
}

export interface AnchoredCitations {
  ok: true;
  /** Citations whose quotes are source-derived slices, not model text. */
  citations: AnchoredCitation[];
  /** The refs to show the synthesis pass, in citation order. */
  refs: string[];
}

export interface ResolvedRefs {
  ok: true;
  citations: AnchoredCitation[];
}

/**
 * The per-mechanism registry of resolved spans. Scoped to one mechanism's
 * extract → synthesize round trip: refs are only meaningful against the ledger
 * that issued them, so a stale ref from another mechanism cannot resolve.
 */
export class SpanLedger {
  private readonly byRef = new Map<string, ProvenanceSpan>();
  /** Identical spans collapse to one ref, so the synthesis pass sees no duplicates. */
  private readonly byKey = new Map<string, string>();
  private next = 1;

  /** Register a span, returning its ref. Idempotent for an identical span. */
  register(corpusRecordId: string, start: number, end: number): string {
    const key = `${corpusRecordId}:${start}:${end}`;
    const seen = this.byKey.get(key);
    if (seen) return seen;
    const ref = `p${this.next}`;
    this.next += 1;
    this.byKey.set(key, ref);
    this.byRef.set(ref, { ref, corpus_record_id: corpusRecordId, start, end });
    return ref;
  }

  get(ref: string): ProvenanceSpan | undefined {
    return this.byRef.get(ref);
  }

  get size(): number {
    return this.byRef.size;
  }

  /** Every ref issued so far, for reporting and for subset validation. */
  refs(): string[] {
    return Array.from(this.byRef.keys());
  }
}

/**
 * Turn an extraction-pass item's citations into offsets.
 *
 * `sourceTextFor` returns the exact text the grounding gate compares against for
 * a record id, or null when the id is unknown — the caller owns corpus shape, so
 * this module stays agnostic about evidence vs realization corpora.
 *
 * The quote the model emitted is used ONLY to find the span. What survives is
 * `source.slice(start, end)`.
 */
export function anchorCitations(
  citations: { record_id?: unknown; quote_or_locus?: unknown }[] | undefined,
  sourceTextFor: (recordId: string) => string | null,
  ledger: SpanLedger,
): AnchoredCitations | ProvenanceRefusal {
  if (!Array.isArray(citations) || citations.length === 0) {
    return {
      ok: false,
      reason: "no_citations",
      detail: "extraction item carried no citations to anchor",
      corpus_record_id: null,
    };
  }
  const anchored: AnchoredCitation[] = [];
  const refs: string[] = [];
  for (const citation of citations) {
    const recordId = citation?.record_id;
    const quote = citation?.quote_or_locus;
    if (typeof recordId !== "string" || typeof quote !== "string" || !quote.trim()) {
      return {
        ok: false,
        reason: "malformed_citation",
        detail: "citation lacked a string record_id or a non-empty quote_or_locus",
        corpus_record_id: typeof recordId === "string" ? recordId : null,
      };
    }
    const source = sourceTextFor(recordId);
    if (source === null) {
      return {
        ok: false,
        reason: "unknown_record_id",
        detail: `cited record ${recordId} is not in the corpus slice shown to the model`,
        corpus_record_id: recordId,
      };
    }
    const span = locateSpan(source, quote);
    if (!span) {
      // Unreachable while the gate runs first: locateSpan uses the gate's own
      // normalization, so anything the gate admitted is locatable. Kept as a
      // fail-closed branch, and it carries both strings because if the two
      // normalizations ever drift this is the only evidence of it.
      return {
        ok: false,
        reason: "quote_not_in_source",
        detail: `quote does not occur in record ${recordId}, so no span could be anchored`,
        corpus_record_id: recordId,
        compared: {
          quote_raw: quote,
          quote_normalized: normalizeQualityText(quote),
          source_raw: source,
          source_normalized: normalizeQualityText(source),
        },
      };
    }
    refs.push(ledger.register(recordId, span.start, span.end));
    anchored.push({
      record_id: recordId,
      quote_or_locus: span.quote,
      start: span.start,
      end: span.end,
    });
  }
  return { ok: true, citations: anchored, refs };
}

/**
 * Rebuild citations from the refs a synthesis item returned.
 *
 * `allowed` is the exact ref set that item's input carried. Validating against
 * it — not merely against the ledger — is what stops the synthesis pass from
 * attaching one candidate's evidence to another's claim.
 */
export function resolveRefs(
  refs: unknown,
  allowed: ReadonlySet<string>,
  sourceTextFor: (recordId: string) => string | null,
  ledger: SpanLedger,
): ResolvedRefs | ProvenanceRefusal {
  if (!Array.isArray(refs) || refs.length === 0) {
    return {
      ok: false,
      reason: "no_citations",
      detail: "synthesis item named no provenance refs",
      corpus_record_id: null,
    };
  }
  const citations: AnchoredCitation[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== "string" || !ref.trim()) {
      return {
        ok: false,
        reason: "malformed_citation",
        detail: "provenance_refs contained a non-string or empty ref",
        corpus_record_id: null,
      };
    }
    if (!allowed.has(ref)) {
      return {
        ok: false,
        reason: "unknown_record_id",
        detail: `ref ${ref} was not among the provenance supplied to this item (${Array.from(allowed).join(", ") || "none"})`,
        corpus_record_id: null,
      };
    }
    const span = ledger.get(ref);
    if (!span) {
      return {
        ok: false,
        reason: "unknown_record_id",
        detail: `ref ${ref} resolves to no registered span`,
        corpus_record_id: null,
      };
    }
    // A ref repeated within one item is a duplicate citation, not a second one.
    if (seen.has(ref)) continue;
    seen.add(ref);
    const source = sourceTextFor(span.corpus_record_id);
    if (source === null) {
      return {
        ok: false,
        reason: "unknown_record_id",
        detail: `span ${ref} points at record ${span.corpus_record_id}, which is no longer in the corpus`,
        corpus_record_id: span.corpus_record_id,
      };
    }
    const quote = deriveQuote(source, span);
    if (quote === null) {
      // The record changed under the span. Refusing is the honest outcome:
      // slicing whatever now sits at those offsets would quote text no pass
      // ever read.
      return {
        ok: false,
        reason: "provenance_mismatch",
        detail: `span ${ref} [${span.start},${span.end}) no longer fits record ${span.corpus_record_id}`,
        corpus_record_id: span.corpus_record_id,
      };
    }
    citations.push({
      record_id: span.corpus_record_id,
      quote_or_locus: quote,
      start: span.start,
      end: span.end,
    });
  }
  return { ok: true, citations };
}

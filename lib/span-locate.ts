/**
 * lib/span-locate.ts — resolve a quoted span to character offsets in the source
 * text it came from (D-104).
 *
 * WHY THIS EXISTS. Provenance used to be a string a model emitted. The cheap
 * pass reads the source records and can quote them; the strong synthesis pass
 * never sees a record, yet it was the pass whose output the grounding gate
 * checked. A model that never saw the abstract cannot reproduce a verbatim span
 * of it, so every candidate died at the gate and the prompt instruction "copy
 * citations verbatim" had nothing enforcing it.
 *
 * The fix is to stop treating provenance as text. The pass that reads the source
 * resolves its quote to `[start, end)` offsets ONCE, mechanically, and from then
 * on the quote is DERIVED by slicing the stored record at those offsets. No
 * later pass can author, alter, or re-emit it — the worst a downstream model can
 * do is name a span that was already verified.
 *
 * Offsets are never asked of a model. Models are unreliable at character
 * arithmetic, so the model still emits a quote string and this module locates
 * it. The located span is what survives; the model's string is discarded.
 *
 * Matching mirrors the grounding gate exactly (lib/proposal-quality
 * normalizeQualityText: NFKC, lowercase, non-alphanumerics to single spaces), so
 * a span this module resolves is a span the gate admits. Anything the gate
 * tolerates — curly quotes, hyphen variants, ligatures, non-breaking spaces,
 * doubled whitespace, edge punctuation — resolves here too.
 */

/**
 * A resolved span. `start`/`end` index the RAW source string, so
 * `source.slice(start, end)` is the authoritative quote.
 */
export interface ResolvedSpan {
  start: number;
  end: number;
  /** The derived quote: source.slice(start, end). Never model-authored. */
  quote: string;
}

/**
 * The normalized projection of a source string, plus the map back to raw offsets.
 *
 * `normalized[i]` came from the source characters spanning
 * `[rawStart[i], rawEnd[i])`. Both ends are recorded rather than derived, because
 * a normalized character can come from a source character of any width (astral
 * code points) and a raw span's end is not `start + 1`.
 */
interface NormalizedIndex {
  normalized: string;
  rawStart: number[];
  rawEnd: number[];
}

/**
 * Build the same normalized form the gate compares against, recording which raw
 * character each normalized character came from.
 *
 * NFKC is applied PER CHARACTER rather than to the whole string, because a
 * whole-string normalize collapses or expands characters without telling us
 * which input position each output position came from. Per-character keeps the
 * mapping exact; NFKC has no cross-character compositions that matter here (it
 * expands ligatures and folds compatibility forms, both single-character).
 */
function buildNormalizedIndex(source: string): NormalizedIndex {
  let normalized = "";
  const rawStart: number[] = [];
  const rawEnd: number[] = [];
  let pendingSpace = false;

  // Iterate by code point so astral characters map to their true raw offsets.
  let raw = 0;
  for (const char of source) {
    const next = raw + char.length;
    const folded = char.normalize("NFKC").toLowerCase();
    for (const outChar of folded) {
      if (outChar >= "a" && outChar <= "z") {
        // fall through to the emit below
      } else if (!(outChar >= "0" && outChar <= "9")) {
        pendingSpace = true;
        continue;
      }
      // A run of non-alphanumerics collapses to one space, emitted lazily so a
      // leading or trailing run is dropped rather than left dangling — which is
      // what the gate's .trim() does.
      if (pendingSpace && normalized.length > 0) {
        normalized += " ";
        rawStart.push(raw);
        rawEnd.push(raw);
      }
      pendingSpace = false;
      normalized += outChar;
      rawStart.push(raw);
      rawEnd.push(next);
    }
    raw = next;
  }
  return { normalized, rawStart, rawEnd };
}

/**
 * The gate's normalization, for comparing a quote. Identical in result to
 * lib/proposal-quality normalizeQualityText; duplicated through the index
 * builder so the two can never disagree about what "normalized" means.
 */
export function normalizedProjection(source: string): string {
  return buildNormalizedIndex(source).normalized;
}

/**
 * Locate `quote` inside `source` and return raw offsets plus the derived quote.
 * Null when the quote does not occur — the caller drops the candidate.
 *
 * `occurrence` picks among repeats; the first is used by default. Repeats are
 * genuinely ambiguous, so the choice is explicit rather than silent.
 */
export function locateSpan(
  source: string,
  quote: string,
  occurrence = 0,
): ResolvedSpan | null {
  const { normalized, rawStart, rawEnd } = buildNormalizedIndex(source);
  const needle = normalizedProjection(quote);
  // An empty normalized needle would match everywhere and ground nothing; the
  // gate refuses it too (`!locus` in groundingErrors).
  if (needle.length === 0) return null;

  let at = normalized.indexOf(needle);
  for (let skipped = 0; skipped < occurrence && at >= 0; skipped += 1) {
    at = normalized.indexOf(needle, at + 1);
  }
  if (at < 0) return null;

  // The span runs from where the first matched character began to where the last
  // one ended. Taking the end from the map rather than from the needle's length
  // is what keeps the derived quote free of trailing punctuation or whitespace
  // that normalized away.
  const start = rawStart[at];
  const end = rawEnd[at + needle.length - 1];
  return { start, end, quote: source.slice(start, end) };
}

/**
 * Re-derive a quote from stored offsets. This is the ONLY way a quote reaches a
 * proposal after the reading pass: the text is a function of the record and the
 * span, so it cannot drift from the source.
 *
 * Null when the span no longer fits the record — a corpus rewrite must
 * invalidate the provenance rather than silently quote different text.
 */
export function deriveQuote(
  source: string,
  span: { start: number; end: number },
): string | null {
  if (
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end <= span.start ||
    span.end > source.length
  ) {
    return null;
  }
  const quote = source.slice(span.start, span.end);
  return quote.trim().length > 0 ? quote : null;
}

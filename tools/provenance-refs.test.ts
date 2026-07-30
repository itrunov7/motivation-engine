import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQualityText } from "../lib/proposal-quality";
import { anchorCitations, resolveRefs, SpanLedger } from "./provenance-refs";

const ABSTRACT =
  "Working memory holds about four chunks, and chunking increases the effective capacity of short-term memory without changing that limit.";
const OTHER = "Intrinsic motivation declines when a salient extrinsic reward is added.";

const SOURCES: Record<string, string> = {
  "cr_aaaaaaaaaaaaaaaaaaaaaaaa": `A title about memory\n${ABSTRACT}`,
  "cr_bbbbbbbbbbbbbbbbbbbbbbbb": `A title about rewards\n${OTHER}`,
};

function sourceTextFor(recordId: string): string | null {
  return SOURCES[recordId] ?? null;
}

function anchorOne(quote: string, recordId = "cr_aaaaaaaaaaaaaaaaaaaaaaaa") {
  const ledger = new SpanLedger();
  const anchored = anchorCitations(
    [{ record_id: recordId, quote_or_locus: quote }],
    sourceTextFor,
    ledger,
  );
  return { ledger, anchored };
}

test("anchoring replaces the model's quote with the source's own text", () => {
  // The model's rendering is mangled; what must survive is the abstract's text.
  const mangled = "\u201CTHE\u00A0EFFECTIVE\u00A0CAPACITY\u00A0OF\u00A0SHORT\u2013TERM\u00A0MEMORY,\u201D";
  const { anchored } = anchorOne(mangled);
  assert(anchored.ok);
  assert.equal(
    anchored.citations[0].quote_or_locus,
    "the effective capacity of short-term memory",
  );
  assert(ABSTRACT.includes(anchored.citations[0].quote_or_locus));
  assert.equal(anchored.refs.length, 1);
  assert.equal(anchored.refs[0], "p1");
});

test("identical spans collapse to one ref across candidates", () => {
  const ledger = new SpanLedger();
  const quote = "chunking increases the effective capacity";
  const first = anchorCitations(
    [{ record_id: "cr_aaaaaaaaaaaaaaaaaaaaaaaa", quote_or_locus: quote }],
    sourceTextFor,
    ledger,
  );
  // A different rendering of the SAME span must not mint a second handle.
  const second = anchorCitations(
    [
      {
        record_id: "cr_aaaaaaaaaaaaaaaaaaaaaaaa",
        quote_or_locus: quote.toUpperCase(),
      },
    ],
    sourceTextFor,
    ledger,
  );
  assert(first.ok);
  assert(second.ok);
  assert.deepEqual(first.refs, second.refs);
  assert.equal(ledger.size, 1);
});

test("anchoring refuses within the nine existing reasons", () => {
  const ledger = new SpanLedger();
  const cases: [unknown[] | undefined, string][] = [
    [undefined, "no_citations"],
    [[], "no_citations"],
    [[{ record_id: 7, quote_or_locus: "x" }], "malformed_citation"],
    [[{ record_id: "cr_aaaaaaaaaaaaaaaaaaaaaaaa", quote_or_locus: "  " }], "malformed_citation"],
    [[{ record_id: "cr_zzzzzzzzzzzzzzzzzzzzzzzz", quote_or_locus: "x" }], "unknown_record_id"],
    [
      [
        {
          record_id: "cr_aaaaaaaaaaaaaaaaaaaaaaaa",
          quote_or_locus: "a span nobody ever wrote",
        },
      ],
      "quote_not_in_source",
    ],
  ];
  for (const [citations, expected] of cases) {
    const outcome = anchorCitations(
      citations as { record_id?: unknown; quote_or_locus?: unknown }[] | undefined,
      sourceTextFor,
      ledger,
    );
    assert.equal(outcome.ok, false, `expected refusal for ${JSON.stringify(citations)}`);
    assert.equal(outcome.ok === false && outcome.reason, expected);
  }
});

test("an unlocatable quote is refused with both strings intact", () => {
  const { anchored } = anchorOne("a span nobody ever wrote");
  assert.equal(anchored.ok, false);
  if (anchored.ok) return;
  assert(anchored.compared);
  assert.equal(anchored.compared.quote_raw, "a span nobody ever wrote");
  assert.equal(
    anchored.compared.source_normalized,
    normalizeQualityText(SOURCES["cr_aaaaaaaaaaaaaaaaaaaaaaaa"]),
  );
});

test("resolving a ref rebuilds the citation from the record, not from a model", () => {
  const { ledger, anchored } = anchorOne("about four chunks");
  assert(anchored.ok);
  const resolved = resolveRefs(
    anchored.refs,
    new Set(anchored.refs),
    sourceTextFor,
    ledger,
  );
  assert(resolved.ok);
  assert.equal(resolved.citations[0].record_id, "cr_aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(resolved.citations[0].quote_or_locus, "about four chunks");
});

test("a synthesis pass cannot invent provenance it was not given", () => {
  const ledger = new SpanLedger();
  const first = anchorCitations(
    [{ record_id: "cr_aaaaaaaaaaaaaaaaaaaaaaaa", quote_or_locus: "about four chunks" }],
    sourceTextFor,
    ledger,
  );
  const second = anchorCitations(
    [
      {
        record_id: "cr_bbbbbbbbbbbbbbbbbbbbbbbb",
        quote_or_locus: "a salient extrinsic reward",
      },
    ],
    sourceTextFor,
    ledger,
  );
  assert(first.ok);
  assert(second.ok);

  // This is the core guarantee. A ref that exists in the ledger but was NOT
  // supplied to this item is refused, so the synthesis pass cannot attach one
  // candidate's evidence to another candidate's claim.
  const supplied = new Set(first.refs);
  const stolen = resolveRefs(second.refs, supplied, sourceTextFor, ledger);
  assert.equal(stolen.ok, false);
  assert.equal(stolen.ok === false && stolen.reason, "unknown_record_id");

  // An entirely fabricated ref is refused for the same reason.
  const invented = resolveRefs(["p99"], supplied, sourceTextFor, ledger);
  assert.equal(invented.ok, false);
  assert.equal(invented.ok === false && invented.reason, "unknown_record_id");

  // …and it is not refused merely for being absent from the ledger: even a
  // well-formed ledger entry outside the supplied set is rejected.
  assert.equal(ledger.get(second.refs[0]) !== undefined, true);
});

test("resolving refuses malformed and empty ref lists", () => {
  const ledger = new SpanLedger();
  const empty = new Set<string>();
  assert.equal(resolveRefs(undefined, empty, sourceTextFor, ledger).ok, false);
  assert.equal(resolveRefs([], empty, sourceTextFor, ledger).ok, false);
  const nonString = resolveRefs([7], new Set(["p1"]), sourceTextFor, ledger);
  assert.equal(nonString.ok === false && nonString.reason, "malformed_citation");
  const blank = resolveRefs(["  "], new Set(["p1"]), sourceTextFor, ledger);
  assert.equal(blank.ok === false && blank.reason, "malformed_citation");
  const notAnArray = resolveRefs("p1", new Set(["p1"]), sourceTextFor, ledger);
  assert.equal(notAnArray.ok === false && notAnArray.reason, "no_citations");
});

test("a repeated ref yields one citation, not two", () => {
  const { ledger, anchored } = anchorOne("about four chunks");
  assert(anchored.ok);
  const ref = anchored.refs[0];
  const resolved = resolveRefs([ref, ref, ref], new Set([ref]), sourceTextFor, ledger);
  assert(resolved.ok);
  assert.equal(resolved.citations.length, 1);
});

test("a corpus rewrite invalidates the span instead of quoting new text", () => {
  const { ledger, anchored } = anchorOne(
    "chunking increases the effective capacity of short-term memory",
  );
  assert(anchored.ok);
  const ref = anchored.refs[0];

  // The record was shortened after the span was resolved.
  const shortened = (recordId: string): string | null =>
    recordId === "cr_aaaaaaaaaaaaaaaaaaaaaaaa" ? "A title about memory\nShort." : null;
  const stale = resolveRefs(anchored.refs, new Set([ref]), shortened, ledger);
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.reason, "provenance_mismatch");

  // A record that disappeared entirely is a different failure, named as such.
  const gone = resolveRefs(anchored.refs, new Set([ref]), () => null, ledger);
  assert.equal(gone.ok === false && gone.reason, "unknown_record_id");
});

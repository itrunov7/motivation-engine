import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { normalizeQualityText } from "./proposal-quality";
import { deriveQuote, locateSpan, normalizedProjection } from "./span-locate";
import type { EvidenceCorpusFile } from "./types";

const ROOT = join(__dirname, "..");

function corpus(): EvidenceCorpusFile {
  return JSON.parse(
    readFileSync(join(ROOT, "corpora/evidence/CL-14.json"), "utf8"),
  ) as EvidenceCorpusFile;
}

test("the projection agrees with the gate's normalization, character for character", () => {
  // The whole design rests on this: a span this module resolves must be a span
  // the grounding gate admits. If the two normalizations ever diverge, the
  // pipeline would derive quotes the gate then refuses.
  const samples = [
    "Simple words here",
    "MiXeD CaSe WORDS",
    "hyphen-separated words",
    "curly \u2019quotes\u2019 and \u201Cdoubles\u201D",
    "non\u00A0breaking\u00A0spaces",
    "doubled   spaces    everywhere",
    "ligature \uFB01nd and \uFB02ow",
    "\u201C... leading and trailing ...\u201D,",
    "trailing ellipsis\u2026",
    "digits 1234 and 56",
    "en\u2013dash and em\u2014dash",
    "  padded  ",
    "punctuation!!! only??? words...",
    "tabs\tand\nnewlines",
    "accented \u00E9\u00E8\u00EA caf\u00E9",
    "\u2153 vulgar fraction",
  ];
  for (const sample of samples) {
    assert.equal(
      normalizedProjection(sample),
      normalizeQualityText(sample),
      `projection diverged for ${JSON.stringify(sample)}`,
    );
  }
});

test("the projection agrees with the gate on every real CL-14 abstract", () => {
  // Synthetic samples can miss what the corpus actually contains.
  const records = corpus().records.filter((record) => record.abstract);
  assert(records.length > 100);
  for (const record of records.slice(0, 120)) {
    const source = `${record.title}\n${record.abstract}`;
    assert.equal(
      normalizedProjection(source),
      normalizeQualityText(source),
      `projection diverged for ${record.record_id}`,
    );
  }
});

test("a located span slices back to the text that was quoted", () => {
  const source = "The span of absolute judgment is limited by information.";
  const span = locateSpan(source, "absolute judgment is limited");
  assert(span);
  assert.equal(source.slice(span.start, span.end), "absolute judgment is limited");
  assert.equal(span.quote, "absolute judgment is limited");
});

test("offsets survive every mutation the gate tolerates", () => {
  const source =
    "Chunking increases the effective capacity of short-term memory by \uFB01tting more items per slot.";
  const truth = "effective capacity of short-term memory";
  // Each variant is a different rendering of the same span; all must resolve to
  // the SAME raw offsets, because the offsets belong to the source, not to the
  // model's spelling of the quote.
  const variants = [
    truth,
    truth.replace(/-/g, "\u2010"),
    truth.replace(/-/g, "\u2013"),
    truth.replace(/ /g, "  "),
    truth.replace(/ /g, "\u00A0"),
    truth.toUpperCase(),
    `\u201C... ${truth} ...\u201D,`,
    `${truth}\u2026`,
  ];
  const first = locateSpan(source, truth);
  assert(first);
  for (const variant of variants) {
    const span = locateSpan(source, variant);
    assert(span, `failed to locate ${JSON.stringify(variant)}`);
    assert.equal(span.start, first.start, `start moved for ${JSON.stringify(variant)}`);
    assert.equal(span.end, first.end, `end moved for ${JSON.stringify(variant)}`);
  }
});

test("a span located in a real abstract derives the source text, not the model's", () => {
  const record = corpus().records.find(
    (candidate) => candidate.abstract && candidate.abstract.length > 300,
  );
  assert(record?.abstract);
  const source = `${record.title}\n${record.abstract}`;
  const exact = record.abstract.slice(120, 240);

  // The model's rendering is mangled on every axis at once.
  const mangled = `\u201C...${exact
    .replace(/-/g, "\u2013")
    .replace(/ /g, "\u00A0")
    .toUpperCase()}...\u201D`;
  const span = locateSpan(source, mangled);
  assert(span);
  // What survives is the SOURCE's own text, byte for byte — the mangling is
  // discarded rather than propagated into provenance.
  assert.equal(span.quote, source.slice(span.start, span.end));
  assert.equal(normalizeQualityText(span.quote), normalizeQualityText(exact));
  assert.notEqual(span.quote, mangled);
});

test("an invented or empty quote resolves to nothing", () => {
  const source = "A short abstract about memory.";
  assert.equal(locateSpan(source, "this was never written anywhere"), null);
  // Normalizes to empty, which would otherwise match at every position.
  assert.equal(locateSpan(source, "--- ... ---"), null);
  assert.equal(locateSpan(source, ""), null);
});

test("repeated spans are addressable by occurrence rather than silently merged", () => {
  const source = "memory limits and more memory limits again";
  const first = locateSpan(source, "memory limits");
  const second = locateSpan(source, "memory limits", 1);
  assert(first);
  assert(second);
  assert.notEqual(first.start, second.start);
  assert.equal(source.slice(second.start, second.end), "memory limits");
  assert.equal(locateSpan(source, "memory limits", 2), null);
});

test("deriving refuses a span the record can no longer support", () => {
  const source = "Seven plus or minus two.";
  assert.equal(deriveQuote(source, { start: 0, end: 5 }), "Seven");
  // A corpus rewrite that shortens the abstract must invalidate provenance
  // rather than quote whatever now sits at those offsets.
  assert.equal(deriveQuote(source, { start: 0, end: 999 }), null);
  assert.equal(deriveQuote(source, { start: 5, end: 5 }), null);
  assert.equal(deriveQuote(source, { start: -1, end: 4 }), null);
  assert.equal(deriveQuote(source, { start: 1.5, end: 4 }), null);
  // Whitespace-only is not a quote.
  assert.equal(deriveQuote("a   b", { start: 1, end: 4 }), null);
});

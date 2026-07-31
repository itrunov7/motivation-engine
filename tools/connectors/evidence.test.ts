import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_EVIDENCE_SATURATION } from "../../lib/ops";
import type {
  EvidenceCorpusFile,
  EvidenceCorpusRecord,
  EvidenceSaturationConfig,
} from "../../lib/types";
import {
  buildQueryTasks,
  checkpointIsCompatible,
  checkpointMechanismId,
  checkpointPath,
  classifyRecord,
  dissentMarkersIn,
  enabledGraphDirections,
  estimateFieldUnion,
  isFoundationalByCitations,
  isReviewLike,
  isTopicalGraphAnchor,
  readCheckpoint,
  rollingNoveltyRate,
  runFingerprint,
  saturationReached,
  type SaturationPoint,
} from "./evidence";

function config(): EvidenceSaturationConfig {
  return {
    ...DEFAULT_EVIDENCE_SATURATION,
    retrieval_shares: { ...DEFAULT_EVIDENCE_SATURATION.retrieval_shares },
    citation_graph: { ...DEFAULT_EVIDENCE_SATURATION.citation_graph },
  };
}

test("query frontier balances first-page retrieval buckets", () => {
  const tasks = buildQueryTasks(["alpha", "beta"], config());
  const firstPage = tasks.filter((task) => task.page === 1);
  assert.equal(firstPage.length, 2 * 7 * 3);
  for (const bucket of ["relevance", "recency", "citation"] as const) {
    assert.equal(
      firstPage.filter((task) => task.bucket === bucket).length,
      14,
    );
  }
  const relevance = firstPage.filter((task) => task.bucket === "relevance");
  assert.equal(relevance.filter((task) => task.api === "openalex").length, 7);
  assert.equal(
    relevance.filter((task) => task.api === "semantic-scholar").length,
    7,
  );
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
});

test("rolling novelty reaches saturation only after minimum queries", () => {
  const previous = Array.from({ length: 9 }, (_, index) => ({
    novelty_rate: index === 0 ? 0.04 : 0.01,
  }));
  const rolling = rollingNoveltyRate(previous, 0.01, 10);
  assert.equal(rolling, 0.013);
  assert.equal(
    saturationReached(29, rolling, {
      minimum_queries: 30,
      novelty_threshold: 0.05,
    }),
    false,
  );
  assert.equal(
    saturationReached(30, rolling, {
      minimum_queries: 30,
      novelty_threshold: 0.05,
    }),
    true,
  );
});

test("checkpoint resume preserves novelty and never repeats completed queries", () => {
  const rates = [1, 0.8, 0.4, 0.1, 0.02, 0.01];
  const uninterrupted: Pick<SaturationPoint, "novelty_rate">[] = [];
  let uninterruptedRolling: number | null = null;
  for (const rate of rates) {
    uninterruptedRolling = rollingNoveltyRate(uninterrupted, rate, 3);
    uninterrupted.push({ novelty_rate: rate });
  }

  const resumed: Pick<SaturationPoint, "novelty_rate">[] = rates
    .slice(0, 3)
    .map((novelty_rate) => ({ novelty_rate }));
  let resumedRolling: number | null = null;
  for (const rate of rates.slice(3)) {
    resumedRolling = rollingNoveltyRate(resumed, rate, 3);
    resumed.push({ novelty_rate: rate });
  }
  assert.equal(resumedRolling, uninterruptedRolling);

  const tasks = buildQueryTasks(["alpha"], config());
  const cursor = 17;
  const completed = new Set(tasks.slice(0, cursor).map((task) => task.id));
  const remaining = tasks.slice(cursor).map((task) => task.id);
  assert.equal(remaining.some((id) => completed.has(id)), false);
});

test("bidirectional graph expansion and topical gate are deterministic", () => {
  assert.deepEqual(enabledGraphDirections(config().citation_graph), [
    "backward-reference",
    "forward-citation",
  ]);
  assert.equal(
    isTopicalGraphAnchor(
      {
        title: "Loss aversion in consumer choice",
        authors: [],
        year: 2025,
        venue: null,
        doi: null,
        citations: 0,
        abstract: "Loss aversion predicts consumer decisions under uncertainty.",
        openalex_id: "W123",
        openalex_type: "article",
        referenced_works_count: 10,
        categories: [],
        source_api: "openalex",
      },
      ["loss", "aversion"],
    ),
    true,
  );
});

test("stale checkpoints are rejected", () => {
  const checkpoint = {
    version: 1 as const,
    mechanism_id: "CL-14",
    fingerprint: "abc",
  };
  assert.equal(checkpointIsCompatible(checkpoint, "CL-14", "abc"), true);
  assert.equal(checkpointIsCompatible(checkpoint, "CL-14", "changed"), false);
  assert.equal(checkpointIsCompatible(checkpoint, "LA-01", "abc"), false);
});

test("two segments of one mechanism get independent checkpoints", () => {
  // The maturation queue harvests one mechanism once per segment, so the same
  // mechanism arrives twice in a run with segment-qualified terms (D-096).
  const b2b = ["default effect decision making b2b enterprise"];
  const retention = ["default effect decision making subscription retention"];
  const b2bPrint = runFingerprint("DE-23", b2b, config(), null);
  const retentionPrint = runFingerprint("DE-23", retention, config(), null);
  assert.notEqual(b2bPrint, retentionPrint);

  const b2bPath = checkpointPath("DE-23", b2bPrint);
  const retentionPath = checkpointPath("DE-23", retentionPrint);
  assert.notEqual(b2bPath, retentionPath);
  assert.equal(dirname(b2bPath), dirname(retentionPath));

  // Each filename still resolves back to the mechanism the defer step needs.
  assert.equal(checkpointMechanismId(basename(b2bPath)), "DE-23");
  assert.equal(checkpointMechanismId(basename(retentionPath)), "DE-23");

  // A checkpoint is only ever compared against its own address, so one
  // segment's slice can never be judged stale by the other's.
  const slice = { version: 1 as const, mechanism_id: "DE-23", fingerprint: b2bPrint };
  assert.equal(checkpointIsCompatible(slice, "DE-23", b2bPrint), true);
  assert.equal(checkpointIsCompatible(slice, "DE-23", retentionPrint), false);

  // An address with no file is a fresh slice, never a thrown error.
  assert.equal(readCheckpoint("DE-23", retentionPrint), null);
});

test("a changed base corpus reprints the fingerprint without colliding", () => {
  const terms = ["default effect decision making b2b enterprise"];
  const record = {
    record_id: "openalex:W1",
    title: "Defaults and choice",
    authors: [],
    year: 2025,
    venue: null,
    doi: "10.1/defaults",
    citations: 3,
    abstract: "Defaults shape choice.",
    openalex_id: "W1",
    openalex_type: "article",
    referenced_works_count: 12,
    categories: [],
    source_api: "openalex" as const,
  };
  const empty = runFingerprint("DE-23", terms, config(), null);
  const grown = runFingerprint("DE-23", terms, config(), [record]);
  assert.notEqual(empty, grown);
  assert.notEqual(checkpointPath("DE-23", empty), checkpointPath("DE-23", grown));
  assert.equal(readCheckpoint("DE-23", grown), null);
});

test("field union estimate uses upstream totals adjusted by sampled overlap", () => {
  const tasks = buildQueryTasks(["alpha", "beta"], config()).filter(
    (task) =>
      task.bucket === "relevance" &&
      task.angle === "canon" &&
      task.page === 1,
  );
  assert.equal(tasks.length, 2);
  const record = (title: string, id: string) => ({
    title,
    authors: [],
    year: 2025,
    venue: null,
    doi: null,
    citations: 1,
    abstract: title,
    openalex_id: id,
    openalex_type: "article",
    referenced_works_count: 0,
    categories: [],
    source_api: "openalex" as const,
  });
  tasks[0].meta.upstream_total_results = 100;
  tasks[0].records = [record("A", "W1"), record("B", "W2")];
  tasks[1].meta.upstream_total_results = 200;
  tasks[1].records = [record("B", "W2"), record("C", "W3")];
  assert.deepEqual(estimateFieldUnion(tasks, 3), {
    estimate: 225,
    method: "sample_overlap_adjusted_union",
    measured_queries: 2,
    total_search_queries: 2,
    summed_upstream_results: 300,
    observed_sample_multiplicity: 1.3333,
  });
});

// ---------- Category checklist (D-019 rules, D-130 repair) ----------

/**
 * The classifier's regression cases are the three REAL records cited by the
 * CL-14 proposals, read out of the committed corpus rather than retyped as
 * fixtures. A hand-written fixture would only prove the regex matches the string
 * I chose to write; these three are the records whose empty `categories` arrays
 * are what exposed the bug, and reading them from disk means the test keeps
 * checking the actual evidence the grade rests on.
 *
 * Assertions are on classifyRecord's OUTPUT, never on the stored `categories`,
 * so the tests stay meaningful whether or not the corpora have been retagged.
 */
const CL14_YEAR = 2026;

function citedRecord(recordId: string): EvidenceCorpusRecord {
  const corpus = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "corpora", "evidence", "CL-14.json"), "utf-8"),
  ) as EvidenceCorpusFile;
  const record = corpus.records.find((candidate) => candidate.record_id === recordId);
  assert.ok(record, `${recordId} is missing from corpora/evidence/CL-14.json`);
  return record;
}

test("Tabbers 2004, the one dissenting record CL-14 cites, is tagged dissent", () => {
  const record = citedRecord("cr_09815b8bafeb7050b14d4cd8");
  assert.match(record.title, /Effects of modality and cueing/i);
  // "do not easily generalise", "reverse modality effect", "only a weak cueing
  // effect" — three independent markers, none of which the old singular-only
  // `does not` and bare `question` alternation could see.
  const markers = dissentMarkersIn(`${record.title} ${record.abstract ?? ""}`);
  assert.ok(markers.includes("does-not-generalise"), markers.join(","));
  assert.ok(markers.includes("reverse-effect"), markers.join(","));
  assert.ok(markers.includes("only-a-weak"), markers.join(","));
  assert.deepEqual(classifyRecord(record, CL14_YEAR), ["foundational", "dissent"]);
});

test("Mousavi 1995 is foundational on citation rate, below the raw floor", () => {
  const record = citedRecord("cr_16d3d5c5c3244176195fe4a7");
  assert.equal(record.citations, 958);
  assert.equal(record.year, 1995);
  // Under the raw 1000-citation floor, and 958/31y = 30.9/y over 31 years.
  assert.ok(isFoundationalByCitations(record, CL14_YEAR));
  assert.deepEqual(classifyRecord(record, CL14_YEAR), ["foundational"]);
});

test("Ayres & Sweller 2005 is review-like: a handbook chapter, not a study", () => {
  const record = citedRecord("cr_835cf506c0e8ed0e0fe38ed1");
  assert.equal(record.openalex_type, "book-chapter");
  assert.ok(isReviewLike(record));
  // meta-analysis is the closest slot `categories` has for a narrative review;
  // the vocabulary has no study-design axis, which is why the grading rubric
  // carries study_design per cited record instead (D-130).
  assert.deepEqual(classifyRecord(record, CL14_YEAR), ["foundational", "meta-analysis"]);
});

test("a citation rate needs both a long run and a real total", () => {
  const base = {
    title: "Anything",
    abstract: null,
    openalex_type: "article",
    citations: 400,
  };
  // 400 citations in 2 years is a hot paper, not a foundation.
  assert.equal(isFoundationalByCitations({ ...base, year: 2024 }, CL14_YEAR), false);
  // 240 citations over 20 years clears 20/y in one direction only: the absolute
  // floor keeps a thin total out however long it has been accumulating.
  assert.equal(
    isFoundationalByCitations({ ...base, citations: 240, year: 2006 }, CL14_YEAR),
    false,
  );
  assert.equal(isFoundationalByCitations({ ...base, year: 2006 }, CL14_YEAR), true);
  // The raw floor still applies with no year at all.
  assert.equal(
    isFoundationalByCitations({ ...base, citations: 1200, year: null }, CL14_YEAR),
    true,
  );
});

test("ordinary academic prose is no longer read as dissent", () => {
  // Every one of these was tagged dissent by the old markers: 539 records hit on
  // the bare word "question" and 382 on a bare "does not".
  for (const prose of [
    "We question participants about their prior knowledge.",
    "The research question concerns learner expertise.",
    "The task does not require prior domain training.",
    "Participants did not receive feedback between trials.",
    // The negation has to be a negation: an optional `not` would have read the
    // affirmative as dissent.
    "The effect does replicate in both samples.",
    "These results support the modality principle.",
  ]) {
    assert.deepEqual(dissentMarkersIn(prose), [], prose);
  }
  // While the forms a refutation is actually reported in still fire.
  for (const [prose, marker] of [
    ["The effect did not replicate across four samples.", "not-replicate"],
    ["We found no evidence for a modality benefit.", "no-evidence"],
    ["There was no significant difference between conditions.", "no-significant"],
    ["Contrary to cognitive load theory, performance improved.", "contrary-to"],
    ["Loss aversion (simply) does not materialize for smaller losses.", "neg+claim-verb"],
    ["Cueing did not improve retention.", "neg+outcome-verb"],
    ["These findings call into question the redundancy principle.", "call-into-question"],
  ] as const) {
    assert.ok(dissentMarkersIn(prose).includes(marker), `${marker} · ${prose}`);
  }
});

test("questions in the disconfirming sense are kept, the bare word is not", () => {
  assert.deepEqual(dissentMarkersIn("This questions the prevailing account."), []);
  assert.ok(
    dissentMarkersIn("The results called into question the modality effect.").includes(
      "call-into-question",
    ),
  );
});

test("a review-shaped title only counts as review-like in a chapter", () => {
  const article = {
    title: "The Split-Attention Principle in Multimedia Learning",
    abstract: null,
    citations: 10,
    year: 2020,
    openalex_type: "article",
  };
  // Identical title, different container: "principle" is a genre word in a
  // handbook chapter's title and a claim in a journal article's.
  assert.equal(isReviewLike(article), false);
  assert.equal(isReviewLike({ ...article, openalex_type: "book-chapter" }), true);
  // An actual meta-analysis is review-like whatever OpenAlex calls it.
  assert.equal(
    isReviewLike({ ...article, title: "A meta-analysis of the modality effect" }),
    true,
  );
});

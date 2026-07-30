import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
import test from "node:test";
import { DEFAULT_EVIDENCE_SATURATION } from "../../lib/ops";
import type { EvidenceSaturationConfig } from "../../lib/types";
import {
  buildQueryTasks,
  checkpointIsCompatible,
  checkpointMechanismId,
  checkpointPath,
  enabledGraphDirections,
  estimateFieldUnion,
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

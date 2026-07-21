import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_EVIDENCE_SATURATION } from "../../lib/ops";
import type { EvidenceSaturationConfig } from "../../lib/types";
import {
  buildQueryTasks,
  checkpointIsCompatible,
  enabledGraphDirections,
  estimateFieldUnion,
  isTopicalGraphAnchor,
  rollingNoveltyRate,
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

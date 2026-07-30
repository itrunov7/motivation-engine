import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type {
  SufficiencyCriterion,
  SufficiencyMatrix,
} from "../lib/types";
import { main } from "./analyzer";

const ROOT = join(__dirname, "..");

test("grouped sufficiency is fail-closed, traced, and exposes core-ux depth", () => {
  main();
  const matrix = JSON.parse(
    readFileSync(join(ROOT, "analysis", "sufficiency-matrix.json"), "utf8"),
  ) as SufficiencyMatrix;
  const packCells = matrix.cells.filter(
    (cell) => (cell.row_group ?? "pack") === "pack",
  );
  const green = packCells.filter((cell) => cell.status === "green").length;
  const pctGreen = Math.round((green / packCells.length) * 100);
  assert(pctGreen < 87, `expected D1 green share below 87%, got ${pctGreen}%`);

  for (const cell of matrix.cells) {
    assert.deepEqual(Object.keys(cell.group_statuses).sort(), [
      "breadth",
      "depth",
      "quality",
    ]);
    for (const [criterion, measurement] of Object.entries(
      cell.measurements,
    ) as [
      SufficiencyCriterion,
      SufficiencyMatrix["cells"][number]["measurements"][SufficiencyCriterion],
    ][]) {
      assert(
        measurement.sources.length > 0,
        `${cell.pack}×${cell.segment} ${criterion} has no source trace`,
      );
      if (cell.scores[criterion] === null) {
        assert.equal(measurement.measured, false);
        assert(cell.gaps.includes(criterion));
      }
    }
  }

  const coreUx = packCells.filter((cell) => cell.pack === "core-ux");
  assert.equal(coreUx.length, 15);
  for (const cell of coreUx) {
    // Asserted as a threshold, not as zero: an approved realization moves this
    // score off 0 without closing the gap, and the test must track the
    // behaviour (depth stays an open pipeline gap) rather than today's count.
    const density = cell.scores.realization_density;
    assert(density !== null, `${cell.segment} realization_density unmeasured`);
    assert(
      density < 0.17,
      `${cell.segment} realization_density ${density} should still be below the seed amber bar`,
    );
    assert(cell.gaps.includes("realization_density"));
    const gap = cell.typed_gaps.find(
      (candidate) => candidate.criterion === "realization_density",
    );
    assert.equal(gap?.fix_type, "pipeline");
    assert(
      cell.measurements.realization_density.sources.some((source) =>
        source.startsWith("realizations/"),
      ),
    );
  }

  const candidatePending = packCells.filter(
    (cell) => (cell.candidate_members?.length ?? 0) > 0,
  );
  assert.equal(candidatePending.length, 75);
  assert(candidatePending.every((cell) => cell.status === "red"));
  assert(
    candidatePending.every((cell) =>
      Object.values(cell.group_statuses).every((status) => status === "red"),
    ),
  );
  assert.deepEqual(
    coreUx[0].candidate_members?.map((candidate) => candidate.id),
    ["AE-26", "AU-20", "CO-19", "DE-23", "ER-22", "FB-21", "FL-24", "RR-25"],
  );
  assert(
    candidatePending.every((cell) =>
      cell.candidate_members?.every(
        (candidate) =>
          candidate.reason ===
            `member mechanism ${candidate.id} is a candidate — no evidence yet` &&
          candidate.source ===
            `registry/mechanisms/_seed/${candidate.id}.json`,
      ),
    ),
  );
});

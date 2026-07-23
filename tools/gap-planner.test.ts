import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type {
  AuthoringQueue,
  ExtractionQueue,
  ResearchQueue,
  SufficiencyCell,
  SufficiencyMatrix,
} from "../lib/types";
import {
  harvestCriteria,
  pipelineCriteria,
  pipelineModesForCriteria,
} from "./gap-planner";

const ROOT = join(__dirname, "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), "utf-8")) as T;
}

test("routes scored criteria to their actual automated filler", () => {
  const cell = {
    gaps: ["source_diversity", "effect_coverage", "dissent_completeness"],
    typed_gaps: [
      {
        criterion: "source_diversity",
        value: 0,
        threshold: 0.75,
        fix_type: "harvest",
        what_would_close_it: "harvest",
      },
      {
        criterion: "effect_coverage",
        value: 0,
        threshold: 0.5,
        fix_type: "pipeline",
        what_would_close_it: "extract",
      },
      {
        criterion: "dissent_completeness",
        value: 0,
        threshold: 0.5,
        fix_type: "pipeline",
        what_would_close_it: "extract",
      },
    ],
  } as unknown as SufficiencyCell;

  assert.deepEqual(harvestCriteria(cell), ["source_diversity"]);
  assert.deepEqual(pipelineCriteria(cell), [
    "effect_coverage",
    "dissent_completeness",
  ]);
});

test("maps extraction completeness by available corpus kind", () => {
  assert.deepEqual(
    pipelineModesForCriteria(["extraction_completeness"], true, false),
    ["effects"],
  );
  assert.deepEqual(
    pipelineModesForCriteria(["extraction_completeness"], false, true),
    ["realizations"],
  );
  assert.deepEqual(
    pipelineModesForCriteria(
      ["effect_coverage", "realization_density", "dissent_completeness"],
      true,
      true,
    ),
    ["effects", "realizations", "dissent"],
  );
  assert.deepEqual(
    pipelineModesForCriteria(["realization_density"], true, false),
    [],
    "a realization task without realization records would be a no-op",
  );
});

test("generated queues are deduplicated and authoring stays structural", () => {
  const extraction = readJson<ExtractionQueue>("analysis/extraction-queue.json");
  const research = readJson<ResearchQueue>("analysis/research-queue.json");
  const authoring = readJson<AuthoringQueue>("analysis/authoring-queue.json");
  const matrix = readJson<SufficiencyMatrix>("analysis/sufficiency-matrix.json");
  const keys = extraction.tasks.map((task) => `${task.mechanism}|${task.mode}`);

  assert.equal(new Set(keys).size, keys.length);
  assert.ok(extraction.tasks.length > 0);
  assert.ok(
    matrix.cells.some(
      (cell) =>
        harvestCriteria(cell).length > 0 && pipelineCriteria(cell).length > 0,
    ),
    "the current matrix exercises mixed automated routing",
  );
  assert.ok(
    matrix.cells
      .flatMap((cell) => cell.typed_gaps)
      .filter((gap) => gap.criterion === "dissent_completeness")
      .every((gap) => gap.fix_type === "pipeline"),
  );
  assert.ok(
    authoring.tasks.every((task) =>
      task.structural_gaps.every((gap) => gap.fix_type === "structural"),
    ),
  );
  assert.ok(authoring.cell_count < 37);
  const s8Ids = new Set([
    "AE-26",
    "AU-20",
    "CO-19",
    "DE-23",
    "ER-22",
    "FB-21",
    "FL-24",
    "RR-25",
  ]);
  assert.deepEqual(
    Array.from(
      new Set(
        research.tasks
          .map((task) => task.mechanism)
          .filter((id) => s8Ids.has(id)),
      ),
    ).sort(),
    Array.from(s8Ids).sort(),
  );
  assert(
    research.tasks
      .filter((task) => s8Ids.has(task.mechanism))
      .every(
        (task) =>
          task.reason.includes(
            `member mechanism ${task.mechanism} is a candidate — no evidence yet`,
          ) && task.suggested_evidence_terms.length > 0,
      ),
  );
});

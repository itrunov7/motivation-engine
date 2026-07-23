import assert from "node:assert/strict";
import test from "node:test";
import { extractLogErrorTail } from "./github";

/**
 * getRunFailureSummary surfaces the real thrown error to /ops (D-088). The log
 * parsing is the part with no network dependency, so it is unit-tested here.
 */

const TS = "2026-07-23T13:42:29.4609644Z";

test("extractLogErrorTail returns the thrown error line, skipping noise", () => {
  const log = [
    `${TS} ##[group]Run npm run extract -- quote mode=effects mechanism=SC-06`,
    `${TS} npm run extract -- quote mode=effects mechanism=SC-06`,
    `${TS} shell: /usr/bin/bash -e {0}`,
    `${TS} ##[endgroup]`,
    `${TS} `,
    `${TS} > motivation-engine@0.1.0 extract`,
    `${TS} > tsx tools/extract.ts quote mode=effects mechanism=SC-06`,
    `${TS} `,
    `${TS} corpora/_ops/extraction.json is invalid: limits.per_run_tokens must be an integer ≥ 1`,
    `${TS} ##[error]Process completed with exit code 1.`,
  ].join("\n");
  assert.equal(
    extractLogErrorTail(log),
    "corpora/_ops/extraction.json is invalid: limits.per_run_tokens must be an integer ≥ 1",
  );
});

test("extractLogErrorTail prefers a meaningful ##[error] over the exit-code line", () => {
  const log = [
    `${TS} ##[error]Missing harvested corpus corpora/evidence/SC-06.json`,
    `${TS} ##[error]Process completed with exit code 1.`,
  ].join("\n");
  assert.equal(
    extractLogErrorTail(log),
    "Missing harvested corpus corpora/evidence/SC-06.json",
  );
});

test("extractLogErrorTail caps a runaway line and returns null on noise-only logs", () => {
  const long = "x".repeat(500);
  const capped = extractLogErrorTail(`${TS} ${long}`);
  assert(capped !== null && capped.length <= 300 && capped.endsWith("…"));
  assert.equal(
    extractLogErrorTail(`${TS} ##[group]Run something\n${TS} ##[endgroup]`),
    null,
  );
});

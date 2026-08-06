import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REJECTED_DIR, createRejectionLog, rejectionRecord } from "./rejected-candidates";

/**
 * The module had no test of its own until D-169 — extract.test.ts imported only
 * the pure `rejectionRecord` builder — which is how a 20-file cap came to sit 40
 * lines below a comment promising "Replay any file offline, forever", and
 * destroyed 6 refusal records before anyone read the two together.
 */

const probeRecord = () =>
  rejectionRecord({
    mechanismId: "CL-14",
    mode: "realizations",
    pass: "cheap",
    reason: "anchor_cited_as_record",
    detail: "probe record written by the retention test",
    corpusRecordId: "chromatic-asymmetry-in-visual-attention",
    item: { citations: [] },
  });

const jsonFiles = (): string[] =>
  readdirSync(REJECTED_DIR).filter((name) => name.endsWith(".json"));

test("flushing a rejection log never removes an existing file (D-169)", () => {
  // The committed corpus is already at or past the old cap of 20, so a flush
  // under the old code was guaranteed to delete something. Asserted rather than
  // assumed: if this directory ever shrinks below 20, something is deleting
  // again and this test should be the thing that notices.
  const before = jsonFiles();
  assert(
    before.length >= 20,
    `expected the rejected corpus to be at or past the old 20-file cap, found ${before.length}`,
  );

  const runId = "2026-08-06T00:00:00.000Z-d169-probe";
  const log = createRejectionLog({
    runId,
    mode: "realizations",
    dispatchId: null,
    githubRunId: null,
  });
  log.add(probeRecord());
  const written = join(REJECTED_DIR, `${runId.replace(/[^A-Za-z0-9._-]/g, "-")}.json`);

  try {
    log.flush();
    const after = jsonFiles();
    for (const name of before) {
      assert(
        after.includes(name),
        `${name} was removed by a flush — refusal files are append-only (D-169)`,
      );
    }
    assert.equal(after.length, before.length + 1);

    // Flushed repeatedly, because persistAccounting calls flush() after every
    // batch. That cadence is what made the old prune destructive mid-run.
    log.flush();
    log.flush();
    assert.equal(jsonFiles().length, before.length + 1);
  } finally {
    // This test's own litter, removed by the test — not by any code path in the
    // module under test.
    rmSync(written, { force: true });
  }
});

test("a clean run writes no file, so a file always means a refusal (D-104)", () => {
  const log = createRejectionLog({
    runId: "2026-08-06T00:00:00.000Z-d169-empty",
    mode: "effects",
    dispatchId: null,
    githubRunId: null,
  });
  const before = jsonFiles().length;
  log.flush();
  assert.equal(log.count(), 0);
  assert.equal(jsonFiles().length, before);
});

test("a rejection record carries the reason and the id it refused", () => {
  const record = probeRecord();
  assert.equal(record.reason, "anchor_cited_as_record");
  assert.equal(record.corpus_record_id, "chromatic-asymmetry-in-visual-attention");
  assert(record.detail.length > 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import { checkLedgerBalance } from "../lib/candidate-ledger";
import { ledgerRunFromReceipt, manifestRunFromReceipt } from "./reconcile-spend";
import type { SpendRecordFile } from "./spend-record";

/**
 * The reconciler exists because a conflict-free receipt is cap-INVISIBLE until
 * it is folded into manifest run_history (D-342). These tests pin the two
 * properties that make the fold legal rather than merely convenient:
 * validate.ts requires the manifest and ledger to agree in both directions
 * (D-132), and it recomputes `balanced` rather than trusting the stored value.
 */

const receipt = (over: Partial<SpendRecordFile> = {}): SpendRecordFile => ({
  schema_version: 1,
  run_id: "2026-08-11T10:08:13.201Z",
  dispatch_id: "probe",
  github_run_id: 1,
  mode: "realizations",
  scope_kind: "effect",
  scope_id: "la-01-04",
  written_at: "2026-08-11T10:09:11.451Z",
  cost: {
    api_calls: 6,
    duration_s: 58.25,
    tokens_in: 56432,
    tokens_out: 6878,
    estimated_usd: 0.070004,
  },
  balanced: false,
  stages_known: false,
  records_fetched: 119,
  files_written: 0,
  ...over,
});

test("an unbalanced receipt becomes a manifest run recorded as broken (D-132)", () => {
  // validate.ts fails an unbalanced run recorded as "partial", because partial
  // means "incomplete but trustworthy" and an unbalanced run is neither. So
  // this mapping is an invariant, not a preference.
  assert.equal(manifestRunFromReceipt(receipt()).status, "broken");
  assert.equal(manifestRunFromReceipt(receipt({ balanced: true })).status, "partial");
});

test("the manifest entry carries the measured cost unchanged", () => {
  // D-131 permits writing back a measurement and forbids writing back an
  // estimate. The reconciler must not recompute, round, or apportion anything.
  const run = manifestRunFromReceipt(receipt());
  assert.deepEqual(run.cost, receipt().cost);
  assert.equal(run.timestamp, receipt().run_id);
  assert.equal(run.github_run_id, 1);
});

test("stages are null rather than zero, and `balanced` agrees with the recompute", () => {
  const run = ledgerRunFromReceipt(receipt());
  // Zero would assert that the run produced no candidates. It produced some and
  // then contradicted itself about their fates; the gap is the finding (D-132).
  assert.equal(run.candidates, null);
  assert.equal(run.cheap, null);
  assert.equal(run.synthesis, null);
  assert.equal(run.strong, null);

  // validate.ts recomputes `balanced` and fails on any disagreement, so a
  // hand-written value cannot buy a pass. The reconciler must therefore store
  // exactly what the checker will derive.
  assert.equal(run.balanced, checkLedgerBalance(run).length === 0);
});

test("a reconstructed receipt says so in the ledger reason (D-132)", () => {
  const plain = ledgerRunFromReceipt(receipt());
  const rebuilt = ledgerRunFromReceipt(
    receipt({ reconstructed_from: "the Actions log of GitHub run 31480702995" }),
  );
  assert.equal(plain.reconstruction.status, "partial");
  assert.equal(rebuilt.reconstruction.status, "partial");
  // Anything short of "recorded" REQUIRES a written reason — that requirement
  // is the substance of the rule, so assert the reason names its source.
  assert.match(
    "reason" in rebuilt.reconstruction ? rebuilt.reconstruction.reason : "",
    /Actions log of GitHub run 31480702995/,
  );
  assert.doesNotMatch(
    "reason" in plain.reconstruction ? plain.reconstruction.reason : "",
    /Actions log/,
  );
});

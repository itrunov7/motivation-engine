import assert from "node:assert/strict";
import test from "node:test";

import { isSuperseded, markerFor } from "./report-superseded";

/**
 * The distinction this module turns on is easy to get wrong and impossible to
 * see in the Actions UI: a run cancelled BY A HUMAN mid-flight and a run
 * evicted from the concurrency queue both read `conclusion: cancelled`. Only
 * the second one is a silent loss, and only the second one never started a job.
 * These tests pin that predicate so a future change cannot quietly start
 * reporting deliberate cancellations as lost dispatches — which would train the
 * reader to ignore the warning.
 */

test("a queued eviction is superseded: cancelled with no job ever started", () => {
  assert.equal(isSuperseded({ conclusion: "cancelled" }, 0), true);
});

test("a human cancelling a running job is NOT superseded", () => {
  // It has started jobs. That was a decision, not an eviction.
  assert.equal(isSuperseded({ conclusion: "cancelled" }, 1), false);
});

test("a failed or successful run is never superseded, whatever its job count", () => {
  assert.equal(isSuperseded({ conclusion: "failure" }, 0), false);
  assert.equal(isSuperseded({ conclusion: "success" }, 3), false);
  assert.equal(isSuperseded({ conclusion: null }, 0), false);
});

test("the marker records who detected it, since the run itself could not", () => {
  const marker = markerFor(
    {
      id: 31480696849,
      run_number: 49,
      status: "completed",
      conclusion: "cancelled",
      created_at: "2026-08-11T10:06:02Z",
      display_title: "extract realizations — effect=sc-06-02 [realizations-probe-sc-06-02]",
    },
    999,
    "2026-08-11T11:00:00.000Z",
  );
  assert.equal(marker.github_run_id, 31480696849);
  assert.equal(marker.detected_by_run_id, 999);
  assert.match(marker.reason, /cancelled while queued/);
});

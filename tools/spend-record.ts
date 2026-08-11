/**
 * The conflict-free per-run spend record (D-342).
 *
 * WHY THIS EXISTS. Extraction accounting lives in three whole-file JSON
 * documents that every run rewrites end to end — coverage.json, ledger.json and
 * manifest.json. Two runs on one branch are therefore *structurally guaranteed*
 * to conflict, and the workflow's accounting step ended in
 * `git pull --rebase` under `set -e`. D-099 established that spend is recorded
 * even when a run fails; D-168 moved that record ahead of validation so a
 * broken run still lands its accounting. Neither anticipated that the commit
 * itself could fail to land. On 2026-08-11 it did: three concurrent
 * realizations runs raced, the rebase hit content conflicts in all three files,
 * and $0.070004 of measured spend reached no committed artifact at all.
 *
 * A rebase resolves a fast-forward race. It cannot resolve a content conflict,
 * which is what concurrent whole-file rewrites always produce.
 *
 * THE SHAPE, borrowed wholesale from tools/rejected-candidates.ts (D-104): one
 * file per run, named for the run's own start timestamp. Two runs can never
 * touch the same path, so this file rebases cleanly no matter how many runs
 * race. It is written BEFORE the aggregates, so the durable record exists even
 * if every later write is lost.
 *
 * WHAT IT IS NOT. This file is invisible to the monthly cap, which reads
 * manifest run_history and only run_history (lib/status.ts computeMonthlyRollup).
 * A spend file is a *durable receipt*, not an accounting entry — it exists so
 * tools/reconcile-spend.ts can fold it into run_history later. Writing one
 * without reconciling it would move the loss rather than close it.
 *
 * RETENTION: none, for the same reason rejected/ has none (D-169). A receipt
 * deleted is a receipt that cannot be reconciled.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CorpusManifestCost } from "../lib/types";

const ROOT = join(__dirname, "..");
export const SPEND_DIR = join(ROOT, "corpora", "extraction", "spend");

/**
 * One run's measured spend, plus just enough identity to reconcile it into the
 * manifest and to pair it with a ledger entry.
 *
 * `balanced` and `stages_known` are carried because validate.ts requires every
 * manifest run to have a ledger entry, and an unbalanced run must be recorded
 * as `broken` rather than `partial` (D-132). A reconciler that did not know
 * those two facts could not write a compliant pair.
 */
export interface SpendRecordFile {
  schema_version: 1;
  run_id: string;
  dispatch_id: string | null;
  github_run_id: number | null;
  mode: string;
  scope_kind: string;
  scope_id: string;
  written_at: string;
  cost: CorpusManifestCost;
  /** False when this run's candidate ledger did not balance (D-132). */
  balanced: boolean;
  /**
   * Whether the run's own stage counters can be trusted. False for an
   * unbalanced run, whose numbers are unsound by definition — the reconciler
   * writes nulls rather than propagating them as fact.
   */
  stages_known: boolean;
  records_fetched: number;
  files_written: number;
  /**
   * Present ONLY on a receipt rebuilt by hand from a run's Actions log, after
   * that run lost its accounting commit entirely and left no receipt of its own
   * (the case D-342 was written for, before this module existed). Names where
   * the numbers came from, so a reader can tell a reconstructed receipt from
   * one the run wrote for itself — the same instinct as
   * CandidateLedgerRun.reconstruction (D-132) and span_absent_reason (D-112):
   * declare the gap rather than let the artifact imply a provenance it lacks.
   */
  reconstructed_from?: string;
}

/** A run's start timestamp is the manifest's run key; reuse it for the file. */
export function spendFileNameFor(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/g, "-")}.json`;
}

export function spendRecordPath(runId: string): string {
  return join("corpora", "extraction", "spend", spendFileNameFor(runId));
}

/**
 * Write (or overwrite) this run's receipt. Idempotent per run: later calls
 * supersede earlier ones, exactly like the manifest entry keyed by the same
 * timestamp, so calling this after every batch costs nothing and bounds the
 * unrecorded window to a single batch.
 */
export function writeSpendRecord(file: SpendRecordFile): void {
  mkdirSync(SPEND_DIR, { recursive: true });
  writeFileSync(
    join(SPEND_DIR, spendFileNameFor(file.run_id)),
    `${JSON.stringify(file, null, 2)}\n`,
  );
}

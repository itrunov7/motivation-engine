/**
 * Fold orphaned per-run spend receipts back into the manifest (D-342).
 *
 * WHY THIS IS THE LOAD-BEARING HALF. tools/spend-record.ts makes a run's spend
 * survive a lost commit race, but a receipt on disk is invisible to the monthly
 * cap: lib/status.ts computeMonthlyRollup sums manifest run_history and nothing
 * else. A receipt that is never folded back moves the loss instead of closing
 * it — the same "spend the cap can never see" failure D-099, D-164 and D-166
 * each named in turn.
 *
 * WHAT IT WRITES, and why it must write both. tools/validate.ts checks the
 * manifest against the ledger in BOTH directions (D-132): a manifest run with
 * no ledger entry fails as "a run with no accounting is not a run that
 * balanced", and an unbalanced ledger entry recorded as anything other than
 * `broken` fails too. So reconciling one receipt means writing a matched PAIR —
 * a manifest run entry and a ledger run entry keyed by the same run_id — or
 * nothing at all.
 *
 * HONESTY. A receipt carries measured cost, which D-131 permits writing back
 * (it is a measurement, not an estimate — the same reasoning D-166 used to
 * recover a probe's lost spend). It does NOT carry trustworthy stage counters
 * when the run did not balance, so this tool writes ledger stages as null and
 * marks reconstruction `partial` with a reason, rather than propagating numbers
 * the run itself contradicted. A gap is recorded as a gap.
 *
 *   npx tsx tools/reconcile-spend.ts          # report only, writes nothing
 *   npx tsx tools/reconcile-spend.ts --apply  # write the pairs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readCandidateLedger, writeCandidateLedger, LEDGER_FILE } from "./candidate-ledger";
import { checkLedgerBalance } from "../lib/candidate-ledger";
import { SPEND_DIR, type SpendRecordFile } from "./spend-record";
import type {
  CandidateLedgerRun,
  CorpusManifest,
  CorpusManifestRun,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const MANIFEST_FILE = join(ROOT, "corpora", "extraction", "manifest.json");

function readManifest(): CorpusManifest | null {
  if (!existsSync(MANIFEST_FILE)) return null;
  return JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as CorpusManifest;
}

function readReceipts(): SpendRecordFile[] {
  if (!existsSync(SPEND_DIR)) return [];
  return readdirSync(SPEND_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(SPEND_DIR, file), "utf8")) as SpendRecordFile)
    .sort((a, b) => a.run_id.localeCompare(b.run_id));
}

/**
 * The manifest entry a receipt implies.
 *
 * status is `broken` whenever the receipt says the ledger did not balance —
 * mandatory, not stylistic: validate.ts fails an unbalanced run recorded as
 * "partial", because partial means "incomplete but trustworthy" and an
 * unbalanced run is neither (D-132).
 */
export function manifestRunFromReceipt(receipt: SpendRecordFile): CorpusManifestRun {
  return {
    timestamp: receipt.run_id,
    status: receipt.balanced ? "partial" : "broken",
    params: {
      mode: receipt.mode,
      scope_kind: receipt.scope_kind,
      scope_id: receipt.scope_id,
      reconciled_from_receipt: "true",
    },
    records_fetched: receipt.records_fetched,
    files_written: receipt.files_written,
    duration_s: receipt.cost.duration_s,
    dispatch_id: receipt.dispatch_id,
    github_run_id: receipt.github_run_id,
    cost: receipt.cost,
  } as CorpusManifestRun;
}

/**
 * The ledger entry a receipt implies.
 *
 * Stages are null unless the run balanced. `partial` is exempt from
 * checkLedgerDetail's completeness gate by design (lib/candidate-ledger.ts), so
 * an honestly-incomplete entry validates while an invented one would not.
 */
export function ledgerRunFromReceipt(receipt: SpendRecordFile): CandidateLedgerRun {
  const run = {
    run_id: receipt.run_id,
    dispatch_id: receipt.dispatch_id,
    github_run_id: receipt.github_run_id,
    mode: receipt.mode,
    scope: receipt.scope_id,
    // Null, not zero. The run's own stage counters are either absent or — for
    // the run this was written for — self-contradicting, and D-132 is explicit
    // that writing a zero where a number was never established asserts
    // something false. The gap is the finding.
    candidates: null,
    cheap: null,
    synthesis: null,
    strong: null,
    // Placeholder; recomputed below.
    balanced: false,
    reconstruction: {
      status: "partial",
      reason: receipt.reconstructed_from
        ? `spend rebuilt from ${receipt.reconstructed_from} after this run lost its ` +
          "accounting commit to a rebase conflict and left no receipt of its own " +
          "(D-342); candidate fates could not be established because the run's own " +
          "ledger did not balance, and its rejected-candidates file was lost with " +
          "the same commit"
        : "spend reconciled from this run's committed per-run receipt after its " +
          "accounting commit failed to land (D-342); candidate fates could not be " +
          "established because the run's own ledger did not balance",
    },
    candidates_detail: [],
  } as CandidateLedgerRun;
  // `balanced` is a DERIVED field: tools/validate.ts recomputes it and fails on
  // any disagreement, precisely so a hand-written value cannot buy a pass. So
  // it is computed here from the same function rather than asserted — with
  // every stage null there is no arithmetic to contradict, which is what the
  // check reports. The claim that this run was unsound is carried where it
  // belongs: the manifest status (`broken`) and the reconstruction reason.
  run.balanced = checkLedgerBalance(run).length === 0;
  return run;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const manifest = readManifest();
  const receipts = readReceipts();

  const known = new Set<string>([
    ...(manifest?.last_run ? [manifest.last_run.timestamp] : []),
    ...(manifest?.run_history ?? []).map((run) => run.timestamp),
  ]);
  const orphans = receipts.filter((receipt) => !known.has(receipt.run_id));

  console.log(
    `${receipts.length} spend receipt(s) on disk; ${known.size} run(s) in the manifest; ` +
      `${orphans.length} orphaned.`,
  );
  if (orphans.length === 0) {
    console.log("Nothing to reconcile — every receipt is already in run_history.");
    return;
  }

  let usd = 0;
  for (const receipt of orphans) {
    usd += receipt.cost.estimated_usd;
    console.log(
      `  ${receipt.run_id}  ${receipt.mode}/${receipt.scope_id}  ` +
        `${receipt.cost.api_calls} calls, ${receipt.cost.tokens_in} in / ` +
        `${receipt.cost.tokens_out} out, $${receipt.cost.estimated_usd.toFixed(6)}  ` +
        `-> manifest status ${receipt.balanced ? "partial" : "broken"}`,
    );
  }
  console.log(`  total unreconciled spend: $${usd.toFixed(6)}`);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to write the manifest+ledger pairs.");
    return;
  }

  const ledgerPrevious = readCandidateLedger(LEDGER_FILE);
  const ledgerIds = new Set(ledgerPrevious.runs.map((run) => run.run_id));

  for (const receipt of orphans) {
    // Both halves or neither: validate.ts fails a manifest run with no ledger
    // entry, so a partial application would break the build it exists to keep
    // honest.
    if (!ledgerIds.has(receipt.run_id)) {
      writeCandidateLedger(ledgerRunFromReceipt(receipt), LEDGER_FILE);
    }
    appendManifestRun(manifestRunFromReceipt(receipt));
    console.log(`  reconciled ${receipt.run_id}`);
  }
  console.log(
    `\nWrote ${orphans.length} manifest+ledger pair(s). Run npm run validate before committing.`,
  );
}

/**
 * Append one run to run_history, replacing any entry with the same timestamp.
 * Mirrors mergeExtractionRunHistory in tools/extract.ts, which is private —
 * the two must stay in step, and both are append-only (D-166).
 */
function appendManifestRun(run: CorpusManifestRun): void {
  const manifest = readManifest();
  if (!manifest) throw new Error("Missing corpora/extraction/manifest.json");
  const history = [
    run,
    ...(manifest.run_history ?? []).filter((entry) => entry.timestamp !== run.timestamp),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const next: CorpusManifest = { ...manifest, run_history: history };
  require("node:fs").writeFileSync(
    MANIFEST_FILE,
    `${JSON.stringify(next, null, 2)}\n`,
  );
}

if (require.main === module) main();

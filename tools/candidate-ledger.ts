/**
 * tools/candidate-ledger.ts — persistence for the conservation ledger (D-132).
 *
 * Companion to tools/rejected-candidates.ts. That file answers "why was this
 * candidate refused" for the ones that were; this one answers "what became of
 * every candidate", including the ones nothing bad happened to. The difference
 * matters because the loss this fixes was never a refusal — refusals were
 * already counted and persisted. It was candidates that simply stopped being
 * mentioned between one stage's total and the next.
 *
 * Written mid-flight alongside the manifest (D-099), so a run that dies still
 * leaves its accounting behind, and the accounting says it died.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLedgerBalance } from "../lib/candidate-ledger";
import type {
  CandidateFate,
  CandidateLedgerEntry,
  CandidateLedgerFile,
  CandidateLedgerRun,
  ExtractionPass,
  UngroundedDropReason,
} from "../lib/types";

const ROOT = join(__dirname, "..");
export const LEDGER_FILE = join(ROOT, "corpora", "extraction", "ledger.json");

/** Matched to the manifest's run_history window so the two stay in step. */
const LEDGER_RUN_LIMIT = 20;

export function readCandidateLedger(
  path: string = LEDGER_FILE,
): CandidateLedgerFile {
  if (!existsSync(path)) {
    return { schema_version: 1, updated_at: new Date().toISOString(), runs: [] };
  }
  return JSON.parse(readFileSync(path, "utf8")) as CandidateLedgerFile;
}

/**
 * Put `run` at the head, replacing any earlier entry for the same run.
 * Same idempotency contract as mergeExtractionRunHistory (D-099): accounting is
 * written repeatedly while a run is in flight and each write supersedes the
 * last rather than stacking a second entry for the same run.
 */
export function mergeLedgerRuns(
  previous: readonly CandidateLedgerRun[],
  run: CandidateLedgerRun,
): CandidateLedgerRun[] {
  return [
    run,
    ...previous.filter((entry) => entry.run_id !== run.run_id),
  ].slice(0, LEDGER_RUN_LIMIT);
}

export function writeCandidateLedger(
  run: CandidateLedgerRun,
  path: string = LEDGER_FILE,
): void {
  const previous = readCandidateLedger(path);
  const file: CandidateLedgerFile = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    runs: mergeLedgerRuns(previous.runs, run),
  };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Accumulates one run's candidate fates.
 *
 * Deliberately dumb: it counts what it is told and derives nothing. Every
 * increment happens at the point in tools/extract.ts where the fate is decided,
 * so a new branch that forgets to call this fails the balance check rather than
 * quietly rounding a total down — which is the failure mode this whole entry
 * exists to end.
 */
export class CandidateLedger {
  private readonly entries: CandidateLedgerEntry[] = [];
  private readonly ordinals = new Map<string, number>();
  private consolidated = 0;
  private expanded = 0;

  /**
   * Identify a candidate without storing what it said. Ordinal within its
   * mechanism and pass is enough to line a row up with the run log, and the
   * refusal detail already lives in corpora/extraction/rejected/.
   */
  id(mechanismId: string, pass: ExtractionPass): string {
    const key = `${mechanismId}:${pass}`;
    const next = (this.ordinals.get(key) ?? 0) + 1;
    this.ordinals.set(key, next);
    return `${key}:${String(next).padStart(2, "0")}`;
  }

  record(entry: CandidateLedgerEntry): void {
    this.entries.push(entry);
  }

  /**
   * Rewrite a cheap candidate's fate once synthesis has resolved. A candidate
   * enters synthesis before anyone knows whether the call will return, so the
   * optimistic fate is written first and corrected here.
   */
  refate(candidateId: string, fate: CandidateFate): void {
    const entry = this.entries.find(
      (candidate) => candidate.candidate_id === candidateId,
    );
    if (entry) entry.fate = fate;
  }

  /** One mechanism's cheap-to-strong fold, accumulated as it happens. */
  recordSynthesisFold(cheapIn: number, strongOut: number): void {
    if (cheapIn > strongOut) this.consolidated += cheapIn - strongOut;
    else this.expanded += strongOut - cheapIn;
  }

  private count(
    pass: ExtractionPass,
    fate: CandidateFate,
    reason?: UngroundedDropReason,
  ): number {
    return this.entries.filter(
      (entry) =>
        entry.pass === pass &&
        entry.fate === fate &&
        (reason === undefined || entry.reason === reason),
    ).length;
  }

  private passTotal(pass: ExtractionPass): number {
    return this.entries.filter((entry) => entry.pass === pass).length;
  }

  build(meta: {
    runId: string;
    dispatchId: string | null;
    githubRunId: number | null;
    mode: string;
    scope: string;
  }): CandidateLedgerRun {
    const cheap = {
      candidates: this.passTotal("cheap"),
      dropped_ungrounded: this.count("cheap", "dropped_ungrounded"),
      synthesis_batch_failed: this.count("cheap", "synthesis_batch_failed"),
      into_synthesis: this.count("cheap", "into_synthesis"),
    };
    const strong = {
      candidates: this.passTotal("strong"),
      proposed: this.count("strong", "proposed"),
      proposed_enrich: this.count("strong", "proposed_enrich"),
      merged_into_pending: this.count("strong", "merged_into_pending"),
      held_low_confidence: this.count("strong", "held_low_confidence"),
      failed_validation: this.count("strong", "failed_validation"),
      dropped_ungrounded: this.count("strong", "dropped_ungrounded"),
      dropped_volume_cap: this.count("strong", "dropped_volume_cap"),
      dropped_draft_cap: this.count("strong", "dropped_draft_cap"),
    };
    const run: CandidateLedgerRun = {
      run_id: meta.runId,
      dispatch_id: meta.dispatchId,
      github_run_id: meta.githubRunId,
      mode: meta.mode,
      scope: meta.scope,
      candidates: cheap.candidates + strong.candidates,
      cheap,
      synthesis: {
        into_synthesis: cheap.into_synthesis,
        consolidated: this.consolidated,
        expanded: this.expanded,
        candidates_strong: strong.candidates,
      },
      strong,
      balanced: true,
      reconstruction: { status: "recorded" },
      candidates_detail: this.entries,
    };
    return { ...run, balanced: checkLedgerBalance(run).length === 0 };
  }
}

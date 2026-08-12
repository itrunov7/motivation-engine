/**
 * tools/rejected-candidates.ts — run-scoped persistence for every candidate the
 * grounding gate refused (D-104).
 *
 * Four runs dropped 100% of their candidates and left nothing behind but a
 * counter. Five sampled console lines per mechanism were the only detail, and
 * console output is not committed, so the evidence for a fix evaporated with the
 * Actions log. This writes the full refusal — raw model output, provenance as
 * returned, the corpus record it was matched against, the failing check, and
 * both compared strings untruncated — into the extraction corpus, which
 * extract.yml already commits (including on failure, D-099).
 *
 * This is diagnostic output only. A rejected candidate has NO effect on any
 * artifact: not the registry, dossiers, effects, realizations, interactions, or
 * the proposal queue (rule 8). Nothing here admits or refuses anything; the
 * gate has already decided by the time a record reaches this module.
 *
 * Replay any file offline, forever:
 *   npm run replay-grounding -- replay corpora/extraction/rejected/<run>.json
 *
 * "Forever" was not true between D-104 and D-169: a 20-file cap below this
 * comment deleted the oldest files on every flush, reintroducing exactly the
 * evaporation described above. It is true now — see the retention note on
 * REJECTED_DIR.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtractionPass,
  RejectedCandidateFile,
  RejectedCandidateRecord,
} from "../lib/types";

const ROOT = join(__dirname, "..");
export const REJECTED_DIR = join(ROOT, "corpora", "extraction", "rejected");

/**
 * RETENTION: none. This directory is append-only (D-169).
 *
 * It used to carry REJECTED_FILE_LIMIT = 20 and delete past it, justified as
 * "keep the committed history bounded the same way run_history is (20 runs)".
 * D-166 made that sentence false — run_history is append-only now — and the cap
 * was never authorised by any decision in the first place. It destroyed 6
 * refusal records across 2 runs before it was removed.
 *
 * It also could not do what it claimed. It sorted by mtime, which git checkout
 * resets, so in CI it deleted an arbitrary file rather than the oldest; and it
 * ran from flush(), which persistAccounting calls after every batch, so one
 * wide run could churn the whole window unaided.
 *
 * If repo size ever becomes the real problem the comment above imagined, the
 * answer is compression or a documented archive — not a silent rmSync of the
 * evidence this module exists to preserve.
 */

/** A run's start timestamp is the manifest's run key; reuse it for the file. */
function fileNameFor(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/g, "-")}.json`;
}

export interface RejectionLog {
  /** Record one refusal. Order is the order the gate refused them. */
  add(entry: RejectedCandidateRecord): void;
  /** Write the file. Safe to call repeatedly; later calls supersede earlier. */
  flush(): void;
  count(): number;
  /** Repo-relative path this log writes to, for run reporting. */
  path(): string;
}

export function createRejectionLog(args: {
  runId: string;
  mode: string;
  dispatchId?: string | null;
  githubRunId?: number | null;
}): RejectionLog {
  const rejected: RejectedCandidateRecord[] = [];
  const fileName = fileNameFor(args.runId);
  const target = join(REJECTED_DIR, fileName);

  return {
    add(entry: RejectedCandidateRecord): void {
      rejected.push(entry);
    },
    count(): number {
      return rejected.length;
    },
    path(): string {
      return join("corpora", "extraction", "rejected", fileName);
    },
    flush(): void {
      // A clean run writes no file rather than an empty one, so the presence of
      // a file always means "this run dropped something".
      if (rejected.length === 0) return;
      const file: RejectedCandidateFile = {
        schema_version: 1,
        run_id: args.runId,
        dispatch_id: args.dispatchId ?? null,
        github_run_id: args.githubRunId ?? null,
        mode: args.mode,
        written_at: new Date().toISOString(),
        rejected,
      };
      mkdirSync(REJECTED_DIR, { recursive: true });
      writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`);
      // Nothing is removed here. flush() is called after every batch, so a
      // prune in this position deleted evidence mid-run (D-169).
    },
  };
}

/**
 * Build one rejection record. Kept separate from the gate so the gate's return
 * shape stays about the decision and this stays about the bookkeeping.
 */
export function rejectionRecord(args: {
  mechanismId: string;
  mode: string;
  pass: ExtractionPass;
  reason: RejectedCandidateRecord["reason"];
  detail: string;
  corpusRecordId: string | null;
  item: unknown;
  provenance?: unknown;
  compared?: RejectedCandidateRecord["compared"];
  corpusSide?: RejectedCandidateRecord["corpus_side"];
  cheapOrigin?: unknown;
}): RejectedCandidateRecord {
  return {
    mechanism_id: args.mechanismId,
    mode: args.mode,
    pass: args.pass,
    reason: args.reason,
    detail: args.detail,
    corpus_record_id: args.corpusRecordId,
    item: args.item,
    ...(args.provenance === undefined ? {} : { provenance: args.provenance }),
    ...(args.compared === undefined ? {} : { compared: args.compared }),
    ...(args.corpusSide === undefined ? {} : { corpus_side: args.corpusSide }),
    ...(args.cheapOrigin === undefined ? {} : { cheap_origin: args.cheapOrigin }),
  };
}

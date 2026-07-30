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
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtractionPass,
  RejectedCandidateFile,
  RejectedCandidateRecord,
} from "../lib/types";

const ROOT = join(__dirname, "..");
export const REJECTED_DIR = join(ROOT, "corpora", "extraction", "rejected");

/**
 * Keep the committed history bounded the same way run_history is (20 runs).
 * A rejection file is large by design — it stores full abstracts — so an
 * unbounded directory would grow the repo without bound.
 */
const REJECTED_FILE_LIMIT = 20;

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

/**
 * Drop the oldest rejection files beyond the retention limit. Newest-first by
 * filename is not reliable across run-id shapes, so sort by mtime.
 */
function pruneOldFiles(keep: string): void {
  const entries = readdirSync(REJECTED_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
  if (entries.length <= REJECTED_FILE_LIMIT) return;
  const sorted = entries
    .map((name) => ({
      name,
      // Files are written repeatedly during a run, so mtime tracks the run.
      mtime: statSync(join(REJECTED_DIR, name)).mtimeMs,
    }))
    .sort((left, right) => right.mtime - left.mtime);
  for (const entry of sorted.slice(REJECTED_FILE_LIMIT)) {
    if (entry.name === keep) continue;
    rmSync(join(REJECTED_DIR, entry.name), { force: true });
  }
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
      pruneOldFiles(fileName);
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

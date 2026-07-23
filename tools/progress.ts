/**
 * tools/progress.ts — the live run-progress heartbeat writer (D-086).
 *
 * Long-running jobs (evidence harvest, extraction) call writeRunProgress after
 * each checkpoint. The heartbeat is written to a gitignored working file
 * (.ops-progress/run-progress.json by default); tools/progress-publisher.ts
 * force-pushes it to the dedicated `ops-progress` git ref every ~2 minutes so
 * /ops can show live progress WITHOUT committing heartbeats to main.
 *
 * This is best-effort telemetry: a failed write never breaks a harvest or an
 * extraction. Run identity (GitHub Actions run id/attempt, dispatch id) is
 * read from the environment so the app can correlate a heartbeat with the
 * in-flight Actions run. Mirrors lib/types.ts RunProgress and the schema at
 * corpora/_ops/run-progress.schema.json.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunProgress } from "../lib/types";

const ROOT = join(__dirname, "..");

/** The gitignored working file the tool writes and the publisher reads. */
export const RUN_PROGRESS_FILE =
  process.env.OPS_PROGRESS_FILE ??
  join(ROOT, ".ops-progress", "run-progress.json");

/** The caller supplies the run-specific fields; identity/timestamps are filled in. */
export type RunProgressInput = Omit<
  RunProgress,
  | "schema_version"
  | "github_run_id"
  | "github_run_attempt"
  | "dispatch_id"
  | "started_at"
  | "updated_at"
>;

// The first heartbeat of a process stamps started_at; later ones preserve it.
let processStartedAt: string | null = null;

function intEnv(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Write one progress heartbeat. Never throws — progress is telemetry, not a
 * gate. The publisher (if running) picks the file up on its next interval.
 */
export function writeRunProgress(input: RunProgressInput): void {
  const now = new Date().toISOString();
  if (processStartedAt === null) processStartedAt = now;
  const progress: RunProgress = {
    schema_version: 1,
    github_run_id: intEnv(process.env.GITHUB_RUN_ID),
    github_run_attempt: intEnv(process.env.GITHUB_RUN_ATTEMPT),
    dispatch_id: process.env.OPS_DISPATCH_ID ?? null,
    started_at: processStartedAt,
    updated_at: now,
    ...input,
  };
  try {
    mkdirSync(dirname(RUN_PROGRESS_FILE), { recursive: true });
    const temp = `${RUN_PROGRESS_FILE}.tmp`;
    writeFileSync(temp, `${JSON.stringify(progress, null, 2)}\n`, "utf-8");
    renameSync(temp, RUN_PROGRESS_FILE);
  } catch {
    // Best-effort: a telemetry write must never break the harvest/extraction.
  }
}

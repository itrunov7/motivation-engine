/**
 * Name the dispatches the concurrency group threw away (D-343).
 *
 * WHY AN OBSERVER AND NOT A SELF-REPORT. extract.yml serialises on
 * `concurrency: {group: extraction, cancel-in-progress: false}`. That protects
 * the running job, but GitHub holds only ONE pending entry per group: dispatch
 * a third run while a second is queued and the second is cancelled outright. A
 * run cancelled while queued never starts a job, so no step inside it — not
 * `if: always()`, not `if: cancelled()` — can ever execute. It cannot report on
 * itself. Any design that claims otherwise is wrong about how GitHub schedules.
 *
 * So the NEXT run reports it. On 2026-08-11 a sc-06-02 dispatch vanished this
 * way and was noticed only because someone was reading `gh run list` at the
 * time; nothing in the repo would ever have recorded it.
 *
 * WHAT COUNTS AS SUPERSEDED: conclusion `cancelled` AND zero jobs that ever
 * started. A run cancelled by a human mid-flight has started jobs and is
 * excluded — it was a decision, not a silent eviction.
 *
 * Writes a durable marker per superseded run so the record outlives the Actions
 * UI's retention, on the same one-file-per-run pattern D-342 established for
 * spend receipts: unique path, so it can never lose a rebase.
 *
 *   npx tsx tools/report-superseded.ts          # print only
 *   npx tsx tools/report-superseded.ts --write  # also write markers
 *
 * Needs GITHUB_TOKEN and GITHUB_REPOSITORY. Best-effort by construction: this
 * is a reporting aid, and it must never be the reason a run fails.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
export const SUPERSEDED_DIR = join(ROOT, "corpora", "extraction", "superseded");

export interface SupersededMarker {
  schema_version: 1;
  github_run_id: number;
  run_number: number;
  display_title: string;
  created_at: string;
  detected_at: string;
  detected_by_run_id: number | null;
  reason: "cancelled while queued — superseded by a later dispatch in the extraction concurrency group";
}

interface WorkflowRun {
  id: number;
  run_number: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  display_title: string;
}

/**
 * A run is superseded if it was cancelled without any job ever starting.
 * Exported so the decision this encodes is testable without a network call.
 */
export function isSuperseded(
  run: Pick<WorkflowRun, "conclusion">,
  startedJobCount: number,
): boolean {
  return run.conclusion === "cancelled" && startedJobCount === 0;
}

export function markerFor(
  run: WorkflowRun,
  detectedByRunId: number | null,
  detectedAt: string,
): SupersededMarker {
  return {
    schema_version: 1,
    github_run_id: run.id,
    run_number: run.run_number,
    display_title: run.display_title,
    created_at: run.created_at,
    detected_at: detectedAt,
    detected_by_run_id: detectedByRunId,
    reason:
      "cancelled while queued — superseded by a later dispatch in the extraction concurrency group",
  };
}

function existingMarkerIds(): Set<number> {
  if (!existsSync(SUPERSEDED_DIR)) return new Set();
  return new Set(
    readdirSync(SUPERSEDED_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => Number(file.replace(/\.json$/, "")))
      .filter((id) => Number.isFinite(id)),
  );
}

async function api<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log("No GITHUB_TOKEN/GITHUB_REPOSITORY — skipping supersession check.");
    return;
  }

  const runs = await api<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${repo}/actions/workflows/extract.yml/runs?status=cancelled&per_page=30`,
    token,
  );
  const already = existingMarkerIds();
  const detectedAt = new Date().toISOString();
  const detectedBy = process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null;

  const found: SupersededMarker[] = [];
  for (const run of runs.workflow_runs ?? []) {
    if (already.has(run.id)) continue;
    const jobs = await api<{ jobs: { started_at: string | null }[] }>(
      `/repos/${repo}/actions/runs/${run.id}/jobs`,
      token,
    );
    const started = (jobs.jobs ?? []).filter((job) => job.started_at !== null).length;
    if (!isSuperseded(run, started)) continue;
    found.push(markerFor(run, detectedBy, detectedAt));
  }

  if (found.length === 0) {
    console.log("No superseded dispatches to report.");
    return;
  }

  for (const marker of found) {
    // ::warning:: puts it on the job's annotation list, where a reader looking
    // at a green run will still see it.
    console.log(
      `::warning::a dispatch was superseded and never ran: "${marker.display_title}" ` +
        `(run ${marker.github_run_id}, queued ${marker.created_at}). It was cancelled ` +
        `while queued by a later dispatch in the extraction concurrency group. Re-dispatch it.`,
    );
    if (write) {
      mkdirSync(SUPERSEDED_DIR, { recursive: true });
      writeFileSync(
        join(SUPERSEDED_DIR, `${marker.github_run_id}.json`),
        `${JSON.stringify(marker, null, 2)}\n`,
      );
    }
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = found
      .map((m) => `| ${m.github_run_id} | ${m.display_title} | ${m.created_at} |`)
      .join("\n");
    writeFileSync(
      summary,
      `\n### Superseded dispatches (D-343)\n\n` +
        `These never ran. The extraction concurrency group evicted them while queued.\n\n` +
        `| run | dispatch | queued |\n|---|---|---|\n${rows}\n`,
      { flag: "a" },
    );
  }
  console.log(`${found.length} superseded dispatch(es) reported.`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Never fail a run over a reporting aid.
    console.log(
      `::warning::supersession check did not complete: ${(error as Error).message}`,
    );
  });
}

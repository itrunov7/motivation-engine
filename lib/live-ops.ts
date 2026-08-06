/**
 * lib/live-ops.ts — the file-based half of the live operations view (D-086).
 *
 * Everything here is COMPUTED from committed artifacts, never asserted:
 * - recent runs from every corpus manifest's run_history (+ the evidence
 *   saturation summary), sorted newest-first;
 * - the four operational queues from analysis/*-queue.json, the proposal
 *   store, and the pending evidence checkpoints;
 * - the next scheduled runs from the workflow cron table.
 *
 * The live half (in-flight Actions runs + the progress heartbeat) is assembled
 * in the /ops server action, since it calls api.github.com. Server-only (fs);
 * no Next-specific imports.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_PATHS } from "./data";
import { isActionableProposal } from "./proposal-meta";
import { loadCorpusManifests } from "./status";
import type {
  EvidenceCorpusFile,
  LiveQueueCounts,
  LiveRecentRun,
  LiveScheduledRun,
  Proposal,
} from "./types";

const ROOT = process.cwd();
const ANALYSIS_DIR = join(ROOT, "analysis");
const PROPOSALS_DIR = join(ROOT, "proposals");
const EVIDENCE_CHECKPOINT_DIR = join(
  DATA_PATHS.corporaDir,
  "_ops",
  "checkpoints",
  "evidence",
);

function readJsonSafe<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function countTasks(fileName: string): number {
  const queue = readJsonSafe<{ tasks?: unknown[] }>(join(ANALYSIS_DIR, fileName));
  return Array.isArray(queue?.tasks) ? queue!.tasks!.length : 0;
}

function warningLabels(warnings: Record<string, boolean> | undefined): string[] {
  if (!warnings) return [];
  return Object.entries(warnings)
    .filter(([, on]) => on)
    .map(([key]) => key.replaceAll("_", " "));
}

/**
 * A one-line saturation summary for an evidence run, read from the current
 * corpus file for the run's target. Best-effort: null for non-evidence corpora
 * or when the target/report is absent.
 */
function saturationSummary(
  corpus: string,
  params: Record<string, string>,
): string | null {
  if (corpus !== "evidence") return null;
  const mechanism = params.mechanism;
  if (!mechanism) return null;
  const file = readJsonSafe<EvidenceCorpusFile>(
    join(DATA_PATHS.corporaDir, "evidence", `${mechanism}.json`),
  );
  const report = file?.saturation_report;
  if (!report) return null;
  const verdict = report.saturation_reached
    ? "saturation reached"
    : `stopped: ${report.stop_reason.replaceAll("_", " ")}`;
  return `${verdict} · ${report.queries_issued} queries · +${report.records_added} records`;
}

/**
 * Recent runs across every corpus manifest, newest first. Most manifests keep
 * only their last 20 runs (RUN_HISTORY_LIMIT); the extraction manifest is
 * append-only (D-166) and can carry more. Either way we merge everything
 * available and take the newest `limit` — a display cut, not a storage one.
 */
export function readRecentRuns(limit = 12): LiveRecentRun[] {
  const runs: LiveRecentRun[] = [];
  for (const { dirName, manifest } of loadCorpusManifests()) {
    for (const run of manifest.run_history ?? []) {
      runs.push({
        corpus: dirName,
        timestamp: run.timestamp,
        status: run.status,
        records: run.records_fetched,
        apiCalls: run.cost?.api_calls ?? null,
        estimatedUsd: run.cost?.estimated_usd ?? null,
        durationS: run.duration_s,
        params: run.params ?? {},
        error: run.error ?? null,
        warnings: warningLabels(run.warnings),
        saturation: saturationSummary(dirName, run.params ?? {}),
      });
    }
  }
  return runs
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}

function readAllProposals(): Proposal[] {
  if (!existsSync(PROPOSALS_DIR)) return [];
  return readdirSync(PROPOSALS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = join(PROPOSALS_DIR, entry.name);
      return readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => {
          const parsed = readJsonSafe<Proposal>(join(directory, name));
          return parsed ? [parsed] : [];
        });
    });
}

/**
 * Mechanisms with a resumable evidence slice. Checkpoints are addressed by
 * mechanism AND run fingerprint (D-096), so one mechanism can hold several
 * files — one per segment-qualified term set. The tile reports mechanisms
 * waiting to resume, not files on disk, so a multi-segment mechanism is not
 * counted several times.
 */
function countCheckpointResumes(): number {
  if (!existsSync(EVIDENCE_CHECKPOINT_DIR)) return 0;
  const mechanisms = new Set(
    readdirSync(EVIDENCE_CHECKPOINT_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, "").split(".")[0]),
  );
  return mechanisms.size;
}

/** The four operational queues, counted from committed files (D-086). */
export function readQueueCounts(): LiveQueueCounts {
  const proposals = readAllProposals();
  return {
    harvest: countTasks("research-queue.json"),
    extraction: countTasks("extraction-queue.json"),
    review: proposals.filter((proposal) => isActionableProposal(proposal)).length,
    reviewHeld: proposals.filter(
      (proposal) => proposal.status === "held_low_confidence",
    ).length,
    authoring: countTasks("authoring-queue.json"),
    checkpointResumes: countCheckpointResumes(),
  };
}

// ---------- Scheduled runs (mirror of the workflow cron table, D-086) ----------

/**
 * The scheduled connector/maturation jobs, mirroring the cron lines in
 * .github/workflows/{connectors,maturation}.yml (the source of truth). The
 * cron expression is static config; the NEXT occurrence is computed below —
 * never a hardcoded date. Kept as a table so the app need not read .github at
 * runtime (not bundled into the serverless function).
 */
const SCHEDULE_TABLE: { workflow: string; label: string; cron: string }[] = [
  { workflow: "connectors.yml", label: "Source health heartbeat", cron: "0 */6 * * *" },
  { workflow: "connectors.yml", label: "Evidence harvest (weekly)", cron: "0 5 * * 1" },
  { workflow: "connectors.yml", label: "Wayback harvest (monthly)", cron: "0 6 1 * *" },
  { workflow: "maturation.yml", label: "Maturation loop (weekly)", cron: "0 7 * * 1" },
];

type CronField = { any: boolean; step: number | null; values: Set<number> };

function parseField(token: string): CronField {
  if (token === "*") return { any: true, step: null, values: new Set() };
  const stepMatch = /^\*\/(\d+)$/.exec(token);
  if (stepMatch) {
    return { any: false, step: Number(stepMatch[1]), values: new Set() };
  }
  const values = new Set(
    token.split(",").map((part) => Number(part)).filter((n) => Number.isFinite(n)),
  );
  return { any: false, step: null, values };
}

function fieldMatches(field: CronField, value: number): boolean {
  if (field.any) return true;
  if (field.step !== null) return value % field.step === 0;
  return field.values.has(value);
}

/**
 * Next UTC occurrence of a 5-field cron (minute hour dom month dow), searching
 * minute-by-minute up to ~400 days out. Supports the field forms our workflows
 * use: "*", exact numbers, comma lists, and "*\/n". Returns null if none found.
 */
export function nextCronOccurrence(cron: string, now: Date = new Date()): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts.map(parseField);
  const cursor = new Date(now.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const horizon = 400 * 24 * 60;
  for (let i = 0; i < horizon; i += 1) {
    if (
      fieldMatches(minute, cursor.getUTCMinutes()) &&
      fieldMatches(hour, cursor.getUTCHours()) &&
      fieldMatches(dom, cursor.getUTCDate()) &&
      fieldMatches(month, cursor.getUTCMonth() + 1) &&
      fieldMatches(dow, cursor.getUTCDay())
    ) {
      return cursor.toISOString();
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/** The next scheduled run for each cron entry, soonest first (D-086). */
export function computeNextScheduled(now: Date = new Date()): LiveScheduledRun[] {
  return SCHEDULE_TABLE.map((entry) => ({
    workflow: entry.workflow,
    label: entry.label,
    cron: entry.cron,
    nextRunAt: nextCronOccurrence(entry.cron, now),
  })).sort((a, b) => {
    if (a.nextRunAt === null) return 1;
    if (b.nextRunAt === null) return -1;
    return a.nextRunAt.localeCompare(b.nextRunAt);
  });
}

/** The file-based half of the live ops snapshot, shared by page + action. */
export function readLiveOpsFiles(now: Date = new Date()): {
  recent: LiveRecentRun[];
  queues: LiveQueueCounts;
  scheduled: LiveScheduledRun[];
} {
  return {
    recent: readRecentRuns(),
    queues: readQueueCounts(),
    scheduled: computeNextScheduled(now),
  };
}

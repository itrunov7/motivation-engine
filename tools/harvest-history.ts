/**
 * tools/harvest-history.ts — append this week's harvest attempts to the
 * per-target harvest history (analysis/harvest-history.json, D-059), the
 * persistent memory the analyzer reads to detect evidence exhaustion.
 *
 * The D-058 low-novelty skip stops re-fetching the SAME canon with the SAME
 * terms, but a thin-literature gap can still churn forever: term variations,
 * segment qualifiers, and the per-mechanism diversity_report being overwritten
 * by other segments' harvests all erase the "we already tried this" signal
 * between weeks. This ledger is that missing memory — one attempt row per
 * harvested (mechanism × segment) target per week, each carrying whether the
 * harvest came back low-novelty. A target that comes back low-novelty for K
 * consecutive weeks (config exhaustion.low_novelty_attempts) is exhausted, and
 * the analyzer marks its cell evidence_exhausted (D-059) rather than harvesting
 * against thin literature indefinitely.
 *
 * It NEVER re-computes novelty: it reads only what the loop already produced:
 *   - queue-plan.json          — the gated plan (mechanism, segment, terms, action)
 *   - corpora/evidence/{id}.json → diversity_report.novelty.low_novelty (D-058)
 * Only entries the plan actually RAN (action "run") are recorded — a deferred
 * or skipped task was not harvested, so it adds no attempt.
 *
 * Usage (defaults match the workflow's filenames, run from repo root):
 *   npm run harvest-history -- [--queue-plan queue-plan.json] [--week YYYY-MM-DD]
 *
 * Re-running for the same week REPLACES that week's attempt for each target
 * (idempotent for repeated manual dispatches on the same day), then recomputes
 * every target's trailing low-novelty streak.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  HarvestAttempt,
  HarvestHistory,
  HarvestHistoryTarget,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const ANALYSIS_DIR = join(ROOT, "analysis");
const EVIDENCE_DIR = join(ROOT, "corpora", "evidence");
const HISTORY_FILE = join(ANALYSIS_DIR, "harvest-history.json");

const HISTORY_VERSION = "0.1.0";

/** Minimal shape of an ops-gate queue plan (see tools/ops-gate.ts planQueue). */
interface QueuePlan {
  entries?: {
    mechanism?: string;
    segment?: string;
    terms?: string;
    action?: string;
  }[];
}

function rel(p: string): string {
  return relative(ROOT, p) || p;
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

function readJsonOrNull<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    console.warn(`WARN — could not parse ${rel(file)}; treating as absent.`);
    return null;
  }
}

/** A mechanism's last-harvest low-novelty flag (D-058), read from its corpus. */
function readLowNovelty(mechanismId: string): boolean {
  const path = join(EVIDENCE_DIR, `${mechanismId}.json`);
  const data = readJsonOrNull<{
    diversity_report?: { novelty?: { low_novelty?: unknown } };
  }>(path);
  return data?.diversity_report?.novelty?.low_novelty === true;
}

/** Split the ops-gate ";"-joined terms string back into an array. */
function splitTerms(terms: string | undefined): string[] {
  if (!terms) return [];
  return terms
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Recompute a target's trailing low-novelty streak + its start week from the
 * attempts (oldest first). The streak is the count of consecutive low-novelty
 * attempts at the END of the list; a novel harvest anywhere breaks it. Because
 * one attempt is recorded per distinct harvest week, the streak length is also
 * the number of distinct low-novelty weeks — exactly what exhaustion measures.
 */
function computeStreak(attempts: HarvestAttempt[]): {
  streak: number;
  since: string | null;
} {
  let streak = 0;
  let since: string | null = null;
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    if (!attempts[i].low_novelty) break;
    streak += 1;
    since = attempts[i].week;
  }
  return { streak, since };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const queuePlanFile = join(ROOT, args["queue-plan"] ?? "queue-plan.json");
  const week = args["week"] ?? new Date().toISOString().slice(0, 10);

  const plan = readJsonOrNull<QueuePlan>(queuePlanFile);
  const ran = (plan?.entries ?? []).filter(
    (e) => e.action === "run" && typeof e.mechanism === "string" && typeof e.segment === "string",
  );

  const existing = readJsonOrNull<HarvestHistory>(HISTORY_FILE);
  const entries: Record<string, HarvestHistoryTarget> = existing?.entries
    ? { ...existing.entries }
    : {};

  let recorded = 0;
  let lowNovelty = 0;
  for (const entry of ran) {
    const mechanism = entry.mechanism as string;
    const segment = entry.segment as string;
    const key = `${mechanism}|${segment}`;
    const low = readLowNovelty(mechanism);
    if (low) lowNovelty += 1;
    recorded += 1;

    const attempt: HarvestAttempt = {
      week,
      terms: splitTerms(entry.terms),
      low_novelty: low,
    };

    const prior = entries[key]?.attempts ?? [];
    // Re-running the same week REPLACES that week's attempt (idempotent).
    const attempts = prior.filter((a) => a.week !== week);
    attempts.push(attempt);
    attempts.sort((a, b) => a.week.localeCompare(b.week));

    const { streak, since } = computeStreak(attempts);
    entries[key] = { attempts, low_novelty_streak: streak, streak_since: since };
  }

  const history: HarvestHistory = {
    version: HISTORY_VERSION,
    generated_at: new Date().toISOString(),
    entries,
  };

  mkdirSync(ANALYSIS_DIR, { recursive: true });
  writeFileSync(HISTORY_FILE, `${JSON.stringify(history, null, 2)}\n`, "utf-8");

  const targets = Object.keys(entries).length;
  console.log(
    `OK — recorded harvest week ${week} → ${rel(HISTORY_FILE)}: ` +
      `${recorded} harvested target(s) this week (${lowNovelty} low-novelty), ` +
      `${targets} target(s) tracked in the ledger.`,
  );
}

main();

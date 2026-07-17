/**
 * tools/maturation-log.ts — append one weekly entry to the maturation log
 * (analysis/maturation-log.json, D-053), from the artifacts the weekly
 * maturation loop already produces (.github/workflows/maturation.yml, D-052).
 *
 * The loop's week-over-week story used to live only in the ephemeral GitHub
 * Actions job summary. This tool persists it as generated output the
 * /maturation cockpit reads — the same "computed projection, never
 * hand-edited" pattern as the sufficiency matrix / research queue
 * (D-050/D-051). It NEVER re-computes the diff or the spend; it only records
 * what the workflow steps already computed:
 *   - cell-diff.json     — [{ pack, segment, from, to }] (baseline vs re-scored matrix)
 *   - budget-before.json / budget-after.json — ops-gate budget snapshots
 *   - queue-plan.json    — the gated plan (for the deferred-task count)
 *
 * packs_regenerated is derived from cell-diff exactly as the workflow derives
 * flipped_packs (packs with a cell that flipped to green) — the packs the loop
 * regenerated. A zero-flip week is a truthful, common outcome (D-052) and is
 * recorded as such.
 *
 * Usage (defaults match the workflow's filenames, run from repo root):
 *   npm run maturation-log -- \
 *     [--cell-diff cell-diff.json] \
 *     [--budget-before budget-before.json] [--budget-after budget-after.json] \
 *     [--queue-plan queue-plan.json] [--week YYYY-MM-DD]
 *
 * Re-running for the same week REPLACES that week's entry (idempotent for
 * repeated manual dispatches on the same day).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  MaturationCellChange,
  MaturationLog,
  MaturationLogEntry,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const ANALYSIS_DIR = join(ROOT, "analysis");
const LOG_FILE = join(ANALYSIS_DIR, "maturation-log.json");

const LOG_VERSION = "0.1.0";

/** Minimal shape of an ops-gate budget snapshot (see lib/ops.computeBudgetSnapshot). */
interface BudgetSnapshot {
  month: string;
  caps: { usd: number; calls: number };
  used: { usd: number; calls: number };
  remaining: { usd: number; calls: number };
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const cellDiffFile = join(ROOT, args["cell-diff"] ?? "cell-diff.json");
  const budgetBeforeFile = join(ROOT, args["budget-before"] ?? "budget-before.json");
  const budgetAfterFile = join(ROOT, args["budget-after"] ?? "budget-after.json");
  const queuePlanFile = join(ROOT, args["queue-plan"] ?? "queue-plan.json");
  const week = args["week"] ?? new Date().toISOString().slice(0, 10);

  // Cell status changes (a missing/empty diff = a truthful zero-flip week).
  const cellsChanged = readJsonOrNull<MaturationCellChange[]>(cellDiffFile) ?? [];

  // Packs regenerated = packs with a cell that flipped to green (the workflow's
  // flipped_packs definition), unique and sorted.
  const packsRegenerated = Array.from(
    new Set(cellsChanged.filter((c) => c.to === "green").map((c) => c.pack)),
  ).sort();

  // Spend = the budget snapshot delta (before → after); 0 when snapshots absent.
  const before = readJsonOrNull<BudgetSnapshot>(budgetBeforeFile);
  const after = readJsonOrNull<BudgetSnapshot>(budgetAfterFile);
  const spend = {
    calls:
      before && after ? Math.max(0, after.used.calls - before.used.calls) : 0,
    usd:
      before && after ? round2(Math.max(0, after.used.usd - before.used.usd)) : 0,
  };

  // Deferred tasks (over budget, D-052) from the gated plan.
  const queuePlan = readJsonOrNull<{
    entries?: { action?: string }[];
  }>(queuePlanFile);
  const deferred = (queuePlan?.entries ?? []).filter(
    (e) => e.action === "defer",
  ).length;

  const entry: MaturationLogEntry = {
    week,
    generated_at: new Date().toISOString(),
    cells_changed: cellsChanged,
    packs_regenerated: packsRegenerated,
    spend,
    deferred,
  };

  const existing = readJsonOrNull<MaturationLog>(LOG_FILE);
  const entries = (existing?.entries ?? []).filter((e) => e.week !== week);
  entries.push(entry);
  entries.sort((a, b) => a.week.localeCompare(b.week));

  const log: MaturationLog = {
    version: LOG_VERSION,
    generated_at: new Date().toISOString(),
    entries,
  };

  mkdirSync(ANALYSIS_DIR, { recursive: true });
  writeFileSync(LOG_FILE, `${JSON.stringify(log, null, 2)}\n`, "utf-8");

  const flips = cellsChanged.filter((c) => c.to === "green").length;
  console.log(
    `OK — recorded maturation week ${week} → ${rel(LOG_FILE)}: ` +
      `${cellsChanged.length} status change(s) (${flips} → green), ` +
      `${packsRegenerated.length} pack(s) regenerated, ` +
      `${spend.calls} calls / $${spend.usd}, ${deferred} deferred ` +
      `(${entries.length} week(s) in the log).`,
  );
}

main();

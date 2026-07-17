/**
 * tools/ops-gate.ts — the scheduler gate for the connector fleet (D-024/D-025).
 *
 * The app never harvests; the GitHub workflow does. Before any real run this
 * gate answers, from the _ops config + the manifests + git, whether a run is
 * allowed and — for the weekly schedule — WHICH targets are due. Every skip
 * carries a plain-language reason the workflow writes to the job summary.
 *
 * Modes (npm run ops-gate -- <mode>):
 *   budget                         print the month-to-date budget snapshot
 *   check <id> [key=value ...]     gate ONE run (limits + budget); exit 1 if
 *                                  blocked. raise_cap=1 overrides the budget
 *                                  (never the per-run limits).
 *   plan [connectorId]             the schedule: per (connector,target)
 *                                  run/skip decision (paused, cadence-due,
 *                                  health-down, freshness, budget) as JSON +
 *                                  a summary. An id restricts the plan to one
 *                                  connector (each schedule plans its own).
 *   plan-queue [maxTasks]          the maturation loop (D-052): gate the top-N
 *                                  tasks of analysis/research-queue.json
 *                                  through the SAME guards — paused,
 *                                  health-down, per-run limits, monthly
 *                                  budget — with the batch's own pending
 *                                  spend projected cumulatively, so the loop
 *                                  can never exhaust the budget. A task that
 *                                  no longer fits is "defer"red to next week
 *                                  with a logged reason. Cadence and registry
 *                                  freshness deliberately do NOT apply: the
 *                                  queue is gap-driven (which knowledge is
 *                                  thin), not change-driven (what the owner
 *                                  touched).
 *
 * A quote is DETERMINISTIC and makes zero network calls (connector.quote),
 * so the gate is safe to run in CI and before a dispatch.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTORS } from "./connectors";
import type { Connector, RunParams, RunQuote } from "./connectors/types";
import {
  computeBudgetSnapshot,
  evaluateRunAgainstOps,
  loadOpsConnectorConfigFromDisk,
  loadOpsConnectorConfigsFromDisk,
  type BudgetSnapshot,
  type OpsConnectorConfig,
} from "../lib/ops";
import { HEARTBEAT_STALE_HOURS, loadHeartbeat } from "../lib/status";
import type { ResearchQueue } from "../lib/types";

const ROOT = join(__dirname, "..");
const CORPORA_DIR = join(ROOT, "corpora");
const MECHANISMS_DIR = join(ROOT, "registry", "mechanisms");
const RESEARCH_QUEUE = join(ROOT, "analysis", "research-queue.json");

/** A target's registry record must have changed within this window to be
 *  harvested on the schedule (D-024) — the machine re-harvests what the owner
 *  recently touched, not the whole registry every week. */
const FRESHNESS_DAYS = 7;

function parseParams(args: string[]): RunParams {
  const params: RunParams = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq > 0) params[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return params;
}

function connectorOrExit(id: string): Connector {
  const connector = CONNECTORS[id];
  if (!connector) {
    console.error(`Unknown connector "${id}". Registered: ${Object.keys(CONNECTORS).sort().join(", ")}`);
    process.exit(1);
  }
  return connector;
}

function quoteOrExit(connector: Connector, params: RunParams): RunQuote {
  if (!connector.quote) {
    console.error(`Connector "${connector.id}" has no quote() — cannot gate it (D-025).`);
    process.exit(1);
  }
  return connector.quote(params);
}

/** ISO date of the last commit that touched a mechanism record, or null when
 *  the file has no git history (a brand-new record) or git is unavailable. */
function recordLastCommitISO(mechanismId: string): string | null {
  const rel = existsSync(join(MECHANISMS_DIR, `${mechanismId}.json`))
    ? `registry/mechanisms/${mechanismId}.json`
    : `registry/mechanisms/_seed/${mechanismId}.json`;
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", rel], {
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** A target is fresh if its record changed within FRESHNESS_DAYS. A record
 *  with no git history (never committed) is treated as fresh — a new record
 *  should be harvested. */
function isTargetFresh(mechanismId: string, now: Date): { fresh: boolean; reason: string } {
  const iso = recordLastCommitISO(mechanismId);
  if (iso === null) {
    return { fresh: true, reason: "record has no git history yet (new) — harvest it" };
  }
  const ageDays = (now.getTime() - Date.parse(iso)) / 86_400_000;
  if (Number.isFinite(ageDays) && ageDays <= FRESHNESS_DAYS) {
    return { fresh: true, reason: `record changed ${Math.floor(ageDays)}d ago (≤ ${FRESHNESS_DAYS}d)` };
  }
  return {
    fresh: false,
    reason: `record unchanged for ${Math.floor(ageDays)}d (> ${FRESHNESS_DAYS}d freshness window)`,
  };
}

/** Whole days since the connector's corpus last recorded a run, or null when
 *  it has never run (a manifest is written after the first run). */
function daysSinceLastRun(connector: Connector, now: Date): number | null {
  const file = join(CORPORA_DIR, connector.sourceId, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    const manifest = JSON.parse(readFileSync(file, "utf-8")) as {
      last_run?: { timestamp?: string };
    };
    const ts = manifest.last_run?.timestamp;
    if (!ts) return null;
    return (now.getTime() - Date.parse(ts)) / 86_400_000;
  } catch {
    return null;
  }
}

/** UTC HH:MM of an ISO timestamp, for the "source down at HH:MM" reason. */
function hhmmUTC(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??:??";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Health-aware skip (D-030): if the latest heartbeat marks any source this
 * connector harvests as "down", the scheduled run skips with a plain reason
 * instead of hammering a dead API and producing a red run. A missing or STALE
 * heartbeat (> HEARTBEAT_STALE_HOURS, matching lib/status.ts) never claims
 * "down" — the run proceeds and its own retry/issue automation handles a real
 * outage. "degraded" (e.g. an S2 429) does not skip: connectors degrade
 * gracefully. Returns a reason when the connector should skip, else null.
 */
function healthSkipReason(sourceIds: string[], now: Date): string | null {
  if (sourceIds.length === 0) return null;
  const heartbeat = loadHeartbeat();
  if (!heartbeat) return null;
  for (const sourceId of sourceIds) {
    const entry = heartbeat.entries.find((e) => e.source_id === sourceId);
    if (!entry || entry.status !== "down") continue;
    const ageHours = (now.getTime() - Date.parse(entry.checked_at)) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours >= HEARTBEAT_STALE_HOURS) continue;
    return `source ${sourceId} down at ${hhmmUTC(entry.checked_at)}`;
  }
  return null;
}

interface PlanEntry {
  connector: string;
  target: string | null;
  action: "run" | "skip";
  reason: string;
  quote?: RunQuote;
}

/**
 * Quote one (connector, target) pair and gate it against the _ops limits +
 * monthly budget (D-025). raiseCap is never passed on the schedule — the
 * scheduled fleet respects the budget and skips over it. Shared by the
 * per-target map and the default-scope (wayback) path (D-030).
 */
function gateEntry(
  connector: Connector,
  config: OpsConnectorConfig,
  target: string | null,
  params: RunParams,
  runReason: string,
  now: Date,
): PlanEntry {
  const quote = connector.quote ? connector.quote(params) : undefined;
  if (quote) {
    const decision = evaluateRunAgainstOps({ config, quote, now });
    if (!decision.allowed) {
      return {
        connector: config.connector_id,
        target,
        action: "skip",
        reason: `gate blocked — ${decision.reasons.join("; ")}`,
        quote,
      };
    }
  }
  return { connector: config.connector_id, target, action: "run", reason: runReason, quote };
}

function planForConnector(config: OpsConnectorConfig, now: Date): PlanEntry[] {
  const connector = CONNECTORS[config.connector_id];
  if (!connector) {
    return [{ connector: config.connector_id, target: null, action: "skip", reason: "not a registered connector" }];
  }

  if (config.paused) {
    return [
      {
        connector: config.connector_id,
        target: null,
        action: "skip",
        reason: `paused — ${config.paused_reason ?? "no reason given"}`,
      },
    ];
  }

  const sinceDays = daysSinceLastRun(connector, now);
  if (sinceDays !== null && sinceDays < config.cadence.every_days) {
    return [
      {
        connector: config.connector_id,
        target: null,
        action: "skip",
        reason: `not due — last run ${Math.floor(sinceDays)}d ago, cadence every ${config.cadence.every_days}d`,
      },
    ];
  }

  const downReason = healthSkipReason(connector.sourceIds, now);
  if (downReason !== null) {
    return [{ connector: config.connector_id, target: null, action: "skip", reason: downReason }];
  }

  // A connector whose scope lives outside the mechanism-centric target
  // machinery (D-028: wayback → wayback-domains.json) is planned as a single
  // default-scope entry on an empty targets list (D-030); every other
  // connector honestly skips when it has nothing configured.
  if (config.targets.length === 0) {
    if (connector.schedulableWithoutTargets) {
      return [gateEntry(connector, config, null, {}, "default scope (no _ops targets — D-028)", now)];
    }
    return [
      {
        connector: config.connector_id,
        target: null,
        action: "skip",
        reason: "no targets configured — nothing to harvest on the schedule",
      },
    ];
  }

  return config.targets.map((target): PlanEntry => {
    const freshness = isTargetFresh(target, now);
    if (!freshness.fresh) {
      return { connector: config.connector_id, target, action: "skip", reason: freshness.reason };
    }
    const params: RunParams = connector.id === "evidence" ? { mechanism: target } : {};
    return gateEntry(connector, config, target, params, freshness.reason, now);
  });
}

// ---------- plan-queue (D-052): gate the research queue for the maturation loop ----------

/** One gated research-queue task. "defer" means the task itself is fine but
 *  this week's batch ran out of budget — it stays in the queue for next week. */
interface QueuePlanEntry {
  connector: "evidence";
  mechanism: string;
  segment: string;
  pack: string;
  terms: string;
  action: "run" | "skip" | "defer";
  reason: string;
  quote?: RunQuote;
}

/**
 * Gate the top-N tasks of analysis/research-queue.json (npm run gaps, D-051)
 * for the weekly maturation loop. Reuses the SAME guards as the scheduled
 * fleet — paused, health-down (D-030), per-run limits and the monthly budget
 * via evaluateRunAgainstOps (D-025) — never re-implements them. The batch's
 * own accepted spend is projected cumulatively (pendingSpend), so accepting
 * task k already accounts for tasks 1..k-1: the loop is self-limiting and can
 * never exhaust the budget. Tasks that exceed the remaining batch budget are
 * DEFERRED (not dropped): they stay in the queue and surface again next week,
 * with the deferral reason logged in the plan output / job summary.
 */
function planQueue(maxTasks: number | undefined, now: Date): {
  budget: BudgetSnapshot;
  entries: QueuePlanEntry[];
} {
  if (!existsSync(RESEARCH_QUEUE)) {
    console.error(`No research queue at analysis/research-queue.json — run \`npm run gaps\` first.`);
    process.exit(1);
  }
  const queue = JSON.parse(readFileSync(RESEARCH_QUEUE, "utf-8")) as ResearchQueue;
  const connector = connectorOrExit("evidence");
  const config = loadOpsConnectorConfigFromDisk("evidence");
  if (!config) {
    console.error(`No _ops config for "evidence" (corpora/_ops/connectors/evidence.json) — cannot gate.`);
    process.exit(1);
  }

  const tasks = queue.tasks.slice(0, maxTasks ?? queue.tasks.length);
  const budget = computeBudgetSnapshot(now);

  const base = (task: ResearchQueue["tasks"][number]) => ({
    connector: "evidence" as const,
    mechanism: task.mechanism,
    segment: task.segment,
    pack: task.gap_cell.pack,
    terms: task.suggested_evidence_terms.join(";"),
  });

  // Connector-level guards block the whole batch with one honest reason each.
  if (config.paused) {
    const reason = `paused — ${config.paused_reason ?? "no reason given"}`;
    return { budget, entries: tasks.map((t) => ({ ...base(t), action: "skip" as const, reason })) };
  }
  const downReason = healthSkipReason(connector.sourceIds, now);
  if (downReason !== null) {
    return {
      budget,
      entries: tasks.map((t) => ({ ...base(t), action: "skip" as const, reason: downReason })),
    };
  }

  // Per-task gate with cumulative pending spend: once a task is accepted its
  // estimated calls/usd count against every later task in this batch.
  const pending = { calls: 0, usd: 0 };
  const entries = tasks.map((task): QueuePlanEntry => {
    const entry = base(task);
    const quote = quoteOrExit(connector, { mechanism: task.mechanism, terms: entry.terms });
    const decision = evaluateRunAgainstOps({ config, quote, now, pendingSpend: pending });
    if (!decision.allowed) {
      const overBatchBudget = decision.overBudget;
      return {
        ...entry,
        action: overBatchBudget ? "defer" : "skip",
        reason: overBatchBudget
          ? `deferred to next week — ${decision.reasons.join("; ")}`
          : `gate blocked — ${decision.reasons.join("; ")}`,
        quote,
      };
    }
    pending.calls += quote.calls;
    pending.usd += quote.estimated_usd;
    return { ...entry, action: "run", reason: task.reason, quote };
  });

  return { budget, entries };
}

function printQueueSummary(budget: BudgetSnapshot, entries: QueuePlanEntry[]): void {
  const line = (s: string): void => console.error(s);
  line(`## Maturation harvest plan (${budget.month})`);
  line("");
  line(
    `Budget: ${budget.used.calls}/${budget.caps.calls} calls, $${budget.used.usd}/$${budget.caps.usd} used this month.`,
  );
  line("");
  const groups: [QueuePlanEntry["action"], string][] = [
    ["run", "Harvesting"],
    ["defer", "Deferred to next week"],
    ["skip", "Skipped"],
  ];
  for (const [action, label] of groups) {
    const group = entries.filter((e) => e.action === action);
    line(`${label} ${group.length}:`);
    for (const e of group) line(`  - ${e.mechanism} × ${e.segment} (pack ${e.pack}) — ${e.reason}`);
  }
}

function printSummary(budget: BudgetSnapshot, entries: PlanEntry[]): void {
  const line = (s: string): void => console.error(s);
  line(`## Scheduled run plan (${budget.month})`);
  line("");
  line(
    `Budget: ${budget.used.calls}/${budget.caps.calls} calls, $${budget.used.usd}/$${budget.caps.usd} used this month.`,
  );
  line("");
  const runs = entries.filter((e) => e.action === "run");
  const skips = entries.filter((e) => e.action === "skip");
  line(`Running ${runs.length} target(s):`);
  for (const e of runs) line(`  - ${e.connector} ${e.target ?? ""} — ${e.reason}`);
  line(`Skipping ${skips.length}:`);
  for (const e of skips) line(`  - ${e.connector} ${e.target ?? ""} — ${e.reason}`);
}

function main(): void {
  const [mode, ...rest] = process.argv.slice(2);
  const now = new Date();

  if (mode === "budget") {
    console.log(JSON.stringify(computeBudgetSnapshot(now), null, 2));
    return;
  }

  if (mode === "check") {
    const [id, ...paramArgs] = rest;
    if (!id) {
      console.error("Usage: npm run ops-gate -- check <connectorId> [key=value ...]");
      process.exit(1);
    }
    const connector = connectorOrExit(id);
    const config = loadOpsConnectorConfigFromDisk(id);
    if (!config) {
      console.error(`No _ops config for "${id}" (corpora/_ops/connectors/${id}.json) — cannot gate.`);
      process.exit(1);
    }
    const params = parseParams(paramArgs);
    const raiseCap = params.raise_cap === "1" || params.raise_cap === "true";
    const quote = quoteOrExit(connector, params);
    const decision = evaluateRunAgainstOps({ config, quote, raiseCap, now });
    console.log(
      JSON.stringify(
        { connector: id, target: params.mechanism ?? null, raiseCap, quote, ...decision },
        null,
        2,
      ),
    );
    if (!decision.allowed) {
      console.error(`\nBLOCKED — ${decision.reasons.join("; ")}`);
      process.exit(1);
    }
    console.error("\nALLOWED");
    return;
  }

  if (mode === "plan") {
    // Optional connector id restricts the plan to that connector, so each
    // schedule (connectors.yml) plans only its own connector (D-030). No arg
    // = every connector (the /ops fleet view).
    const [only] = rest;
    let configs = loadOpsConnectorConfigsFromDisk();
    if (only) {
      connectorOrExit(only);
      configs = configs.filter((config) => config.connector_id === only);
      if (configs.length === 0) {
        console.error(`No _ops config for "${only}" (corpora/_ops/connectors/${only}.json) — nothing to plan.`);
        process.exit(1);
      }
    }
    const entries = configs.flatMap((config) => planForConnector(config, now));
    const budget = computeBudgetSnapshot(now);
    console.log(JSON.stringify({ month: budget.month, budget, entries }, null, 2));
    printSummary(budget, entries);
    return;
  }

  if (mode === "plan-queue") {
    const [rawMax] = rest;
    let maxTasks: number | undefined;
    if (rawMax !== undefined && rawMax !== "") {
      maxTasks = Number(rawMax);
      if (!Number.isInteger(maxTasks) || maxTasks < 1) {
        console.error("Usage: npm run ops-gate -- plan-queue [maxTasks ≥ 1]");
        process.exit(1);
      }
    }
    const { budget, entries } = planQueue(maxTasks, now);
    console.log(JSON.stringify({ month: budget.month, budget, entries }, null, 2));
    printQueueSummary(budget, entries);
    return;
  }

  console.error("Usage: npm run ops-gate -- <budget|check|plan|plan-queue> [...]");
  process.exit(1);
}

main();

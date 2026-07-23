"use server";

/**
 * app/ops/actions.ts — the NARROW git-backed write + run surface (D-023).
 *
 * These are the ONLY server actions permitted to call api.github.com (rule 12
 * amendment). Every write funnels through commitOpsFile, which enforces the
 * hard allowlist (isAllowedOpsWritePath): the budget file or a registered
 * connector's config — nothing else. decisions.json is touched only by the
 * append-only appendOverrideDecision path when a cap is raised. Payloads are
 * validated with the SAME validators CI uses (lib/ops), so the UI can never
 * commit a config that would redden the build.
 */

import { randomUUID } from "node:crypto";
import { loadDecisions, loadFullMechanisms, loadSeedStubs } from "@/lib/data";
import {
  DECISIONS_REPO_PATH,
  KNOWN_CONNECTOR_IDS,
  OPS_BUDGET_REPO_PATH,
  isAllowedOpsWritePath,
  isKnownConnectorId,
  opsConnectorRepoPath,
  validateOpsBudget,
  validateOpsConnectorConfig,
  type OpsBudget,
  type OpsConnectorConfig,
  type QuoteArtifact,
} from "@/lib/ops";
import {
  dispatchExtraction,
  dispatchHarvest,
  downloadArtifactJson,
  EXTRACTION_WORKFLOW_FILE,
  findRunByDispatchId,
  getRepoFile,
  getRepoFileFromRef,
  getRunCurrentPhase,
  getRunFailureSummary,
  listActiveWorkflowRuns,
  putRepoFile,
  readGithubOpsEnv,
  type ActiveWorkflowRun,
  type GithubOpsEnv,
} from "@/lib/github";
import { readLiveOpsFiles } from "@/lib/live-ops";
import type {
  LiveOpsSnapshot,
  LiveRun,
  LiveRunKind,
  RunProgress,
} from "@/lib/types";
import type { ExtractionMode, ExtractionQuote, ScopeKind } from "@/tools/extract";

// ---------- Shared result types ----------

export type ActionResult =
  | { ok: true }
  | { ok: false; error: string };

export type DispatchResult =
  | { ok: true; dispatchId: string }
  | { ok: false; error: string };

export type PollState = "pending" | "running" | "ready" | "no_quote" | "failed";

export type PollResult =
  | { ok: true; state: PollState; runUrl?: string; quote?: QuoteArtifact; error?: string }
  | { ok: false; error: string };

// ---------- Guards ----------

function requireEnv(): GithubOpsEnv {
  const env = readGithubOpsEnv();
  if (!env) {
    throw new Error(
      "Operations write surface is disabled — set GH_OPS_TOKEN and GH_OPS_REPO to enable it.",
    );
  }
  return env;
}

function knownMechanismIds(): string[] {
  return [
    ...loadFullMechanisms().map((m) => m.id),
    ...loadSeedStubs().map((s) => s.id),
  ];
}

/** The single funnel for every _ops write: allowlist first, then commit. */
async function commitOpsFile(path: string, message: string, text: string): Promise<void> {
  if (!isAllowedOpsWritePath(path)) {
    throw new Error(`Refusing to write "${path}" — not in the _ops allowlist (D-023).`);
  }
  const env = requireEnv();
  const existing = await getRepoFile(env, path);
  await putRepoFile(env, { path, message, text, sha: existing?.sha });
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- Write path: budget ----------

export async function saveBudgetAction(input: {
  usd: number;
  calls: number;
}): Promise<ActionResult> {
  const budget: OpsBudget = { monthly_caps: { usd: input.usd, calls: input.calls } };
  const errors = validateOpsBudget(budget);
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };

  try {
    await commitOpsFile(
      OPS_BUDGET_REPO_PATH,
      `ops: set monthly caps to $${input.usd} / ${input.calls} calls`,
      toJson(budget),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ---------- Write path: connector config ----------

export async function saveConnectorConfigAction(
  config: OpsConnectorConfig,
): Promise<ActionResult> {
  if (!isKnownConnectorId(config.connector_id)) {
    return { ok: false, error: `"${config.connector_id}" is not a registered connector.` };
  }
  const errors = validateOpsConnectorConfig(config, {
    expectedId: config.connector_id,
    knownConnectorIds: [config.connector_id],
    knownMechanismIds: knownMechanismIds(),
  });
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };

  try {
    await commitOpsFile(
      opsConnectorRepoPath(config.connector_id),
      `ops: update ${config.connector_id} config` +
        (config.paused ? " (paused)" : "") +
        ` — max ${config.limits.max_calls_per_run} calls/run, ${config.targets.length} target(s)`,
      toJson(config),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ---------- Read path: LIVE connector config (D-040) ----------

export type LiveConfigsResult =
  | { ok: true; configs: Record<string, OpsConnectorConfig> }
  | { ok: false; error: string };

/**
 * Reads every registered connector's _ops config LIVE from GitHub — the same
 * source the write path commits to (D-023) — so the console reflects committed
 * targets/limits immediately, not the deploy-time filesystem snapshot the page
 * loads with (D-040). Without this, a just-saved target list stays invisible
 * until the next redeploy, and the Run selector dispatches a stale target.
 *
 * Read is confined to the SAME _ops allowlist as the write path
 * (isAllowedOpsWritePath); a broken or foreign payload is skipped, never
 * thrown — a bad file must not blank the whole console.
 */
export async function loadLiveConnectorConfigsAction(): Promise<LiveConfigsResult> {
  try {
    const env = requireEnv();
    const configs: Record<string, OpsConnectorConfig> = {};
    for (const id of KNOWN_CONNECTOR_IDS) {
      const path = opsConnectorRepoPath(id);
      if (!isAllowedOpsWritePath(path)) continue;
      const file = await getRepoFile(env, path);
      if (!file) continue;
      try {
        const config = JSON.parse(file.text) as OpsConnectorConfig;
        if (config.connector_id === id) configs[id] = config;
      } catch {
        // skip an unparseable config — the disk snapshot stays in effect
      }
    }
    return { ok: true, configs };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ---------- Override log (append-only decisions.json) ----------

function nextDecisionId(ids: string[]): string {
  const max = ids.reduce((m, id) => {
    const n = Number.parseInt(id.replace(/\D/g, ""), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `D-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Appends ONE operations decision recording a budget-cap override, then
 * commits. This is the only write to a knowledge file the app performs, and it
 * is strictly additive — "a cap was raised is a decision, not a silent flag".
 */
async function appendOverrideDecision(
  env: GithubOpsEnv,
  args: { connector: string; target: string | null; quote: QuoteArtifact["quote"]; budget: QuoteArtifact["budget"] },
): Promise<void> {
  const file = await getRepoFile(env, DECISIONS_REPO_PATH);
  if (!file) throw new Error("decisions.json not found — cannot log the override.");
  const parsed = JSON.parse(file.text) as { decisions: { id: string }[] };
  const id = nextDecisionId(parsed.decisions.map((d) => d.id));
  const targetLabel = args.target ? ` for ${args.target}` : "";

  parsed.decisions.push({
    id,
    date: new Date().toISOString().slice(0, 10),
    title: `Budget-cap override: one ${args.connector} run${targetLabel} above the monthly cap`,
    body:
      `Operator override logged from /ops (D-025). The dry-run quote estimated ${args.quote.calls} calls / ` +
      `$${args.quote.estimated_usd} for this ${args.connector} run${targetLabel}, which exceeds the remaining ` +
      `monthly budget (used ${args.budget.used.calls}/${args.budget.caps.calls} calls, ` +
      `$${args.budget.used.usd}/$${args.budget.caps.usd} of the ${args.budget.month} caps). The operator ticked ` +
      `"raise cap for this run", so the real dispatch bypasses ONLY the monthly budget gate — the per-run limits ` +
      `(max_calls_per_run / max_records_per_run) still apply and are enforced at the fetch layer (D-027). This ` +
      `entry keeps the decision log the single source of truth for deviations.`,
    area: "operations",
  } as (typeof parsed.decisions)[number]);

  await putRepoFile(env, {
    path: DECISIONS_REPO_PATH,
    message: `ops: log cap override for ${args.connector}${targetLabel} run (${id})`,
    text: toJson(parsed),
    sha: file.sha,
  });
}

// ---------- Run path: dry-run dispatch ----------

function newDispatchId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function startDryRunAction(
  connectorId: string,
  target: string | null,
): Promise<DispatchResult> {
  if (!isKnownConnectorId(connectorId)) {
    return { ok: false, error: `"${connectorId}" is not a registered connector.` };
  }
  try {
    const env = requireEnv();
    const dispatchId = newDispatchId("ops-dry");
    await dispatchHarvest(env, {
      connector: connectorId,
      target: target ?? "",
      dry_run: "true",
      dispatch_id: dispatchId,
      raise_cap: "false",
    });
    return { ok: true, dispatchId };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function pollDryRunAction(dispatchId: string): Promise<PollResult> {
  try {
    const env = requireEnv();
    const run = await findRunByDispatchId(env, dispatchId);
    if (!run) return { ok: true, state: "pending" };
    if (run.status !== "completed") {
      return { ok: true, state: "running", runUrl: run.html_url };
    }
    // A completed run that did not SUCCEED produces no artifact — surface the
    // real failure (which step broke) instead of the generic "no estimate"
    // message, so the operator sees why (D-025).
    if (run.conclusion !== "success") {
      const error = await getRunFailureSummary(env, run.id, run.conclusion);
      return { ok: true, state: "failed", runUrl: run.html_url, error };
    }
    const quote = await downloadArtifactJson<QuoteArtifact>(env, run.id, "quote", "quote.json");
    if (!quote) return { ok: true, state: "no_quote", runUrl: run.html_url };
    return { ok: true, state: "ready", runUrl: run.html_url, quote };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ---------- Run path: confirmed real dispatch ----------

export async function confirmRealRunAction(args: {
  connectorId: string;
  target: string | null;
  raiseCap: boolean;
  quote?: QuoteArtifact;
}): Promise<DispatchResult> {
  const { connectorId, target, raiseCap, quote } = args;
  if (!isKnownConnectorId(connectorId)) {
    return { ok: false, error: `"${connectorId}" is not a registered connector.` };
  }
  try {
    const env = requireEnv();
    // Log the override BEFORE dispatching, so the decision exists even if the
    // dispatch then fails — the audit trail never lags the action (D-025).
    if (raiseCap && quote) {
      await appendOverrideDecision(env, {
        connector: connectorId,
        target,
        quote: quote.quote,
        budget: quote.budget,
      });
    }
    const dispatchId = newDispatchId("ops-real");
    await dispatchHarvest(env, {
      connector: connectorId,
      target: target ?? "",
      dry_run: "false",
      dispatch_id: dispatchId,
      raise_cap: raiseCap ? "true" : "false",
    });
    return { ok: true, dispatchId };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ---------- Run path: extraction quote → confirm → dispatch (D-085) ----------

const EXTRACTION_MODES: readonly ExtractionMode[] = [
  "effects",
  "realizations",
  "interactions",
  "dissent",
  "mechanism",
  "dossier",
];
const SCOPE_KINDS: readonly ScopeKind[] = ["mechanism", "pack", "segment"];

export type ExtractionPollResult =
  | {
      ok: true;
      state: PollState;
      runUrl?: string;
      quote?: ExtractionQuote;
      error?: string;
    }
  | { ok: false; error: string };

function validateExtractionScope(args: {
  mode: string;
  scopeKind: string;
  scopeId: string;
}): string | null {
  if (!EXTRACTION_MODES.includes(args.mode as ExtractionMode)) {
    return `"${args.mode}" is not an extraction mode.`;
  }
  if (!SCOPE_KINDS.includes(args.scopeKind as ScopeKind)) {
    return `"${args.scopeKind}" is not a scope kind.`;
  }
  if (!args.scopeId.trim()) return "A scope id is required.";
  if (
    args.scopeKind === "mechanism" &&
    !knownMechanismIds().includes(args.scopeId)
  ) {
    return `"${args.scopeId}" is not a known mechanism or seed candidate.`;
  }
  return null;
}

export async function startExtractionQuoteAction(args: {
  mode: string;
  scopeKind: string;
  scopeId: string;
}): Promise<DispatchResult> {
  const invalid = validateExtractionScope(args);
  if (invalid) return { ok: false, error: invalid };
  try {
    const env = requireEnv();
    const dispatchId = newDispatchId("ops-extract-dry");
    await dispatchExtraction(env, {
      mode: args.mode,
      scope_kind: args.scopeKind,
      scope_id: args.scopeId,
      dry_run: "true",
      dispatch_id: dispatchId,
    });
    return { ok: true, dispatchId };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function pollExtractionQuoteAction(
  dispatchId: string,
): Promise<ExtractionPollResult> {
  try {
    const env = requireEnv();
    const run = await findRunByDispatchId(env, dispatchId, EXTRACTION_WORKFLOW_FILE);
    if (!run) return { ok: true, state: "pending" };
    if (run.status !== "completed") {
      return { ok: true, state: "running", runUrl: run.html_url };
    }
    if (run.conclusion !== "success") {
      const error = await getRunFailureSummary(env, run.id, run.conclusion);
      return { ok: true, state: "failed", runUrl: run.html_url, error };
    }
    const quote = await downloadArtifactJson<ExtractionQuote>(
      env,
      run.id,
      "extraction-quote",
      "quote.json",
    );
    if (!quote) return { ok: true, state: "no_quote", runUrl: run.html_url };
    return { ok: true, state: "ready", runUrl: run.html_url, quote };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Dispatch the REAL extraction run for a quote the operator confirmed. There
 * is no raise-cap path here: the workflow re-runs the deterministic quote gate
 * itself and fails closed if budget or per-run caps are exceeded.
 */
export async function confirmExtractionRunAction(args: {
  mode: string;
  scopeKind: string;
  scopeId: string;
}): Promise<DispatchResult> {
  const invalid = validateExtractionScope(args);
  if (invalid) return { ok: false, error: invalid };
  try {
    const env = requireEnv();
    const dispatchId = newDispatchId("ops-extract-real");
    await dispatchExtraction(env, {
      mode: args.mode,
      scope_kind: args.scopeKind,
      scope_id: args.scopeId,
      dry_run: "false",
      dispatch_id: dispatchId,
    });
    return { ok: true, dispatchId };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ---------- Live operations view (D-086) ----------

/** Workflow files the live view surfaces, mapped to their run kind. */
const LIVE_WORKFLOWS: Record<string, LiveRunKind> = {
  "harvest.yml": "harvest",
  "connectors.yml": "harvest",
  "extract.yml": "extraction",
  "maturation.yml": "analysis",
};

/** The heartbeat lives at run-progress.json on the ops-progress ref (D-086). */
const OPS_PROGRESS_REF = "ops-progress";
const OPS_PROGRESS_ENTRY = "run-progress.json";

function workflowBasename(path: string): string {
  return path.split("/").pop() ?? path;
}

function classifyRun(basename: string, runName: string): LiveRunKind {
  // A connectors run is a health heartbeat or a harvest depending on the
  // schedule that fired; the run-name distinguishes them honestly.
  if (basename === "connectors.yml" && /heartbeat/i.test(runName)) {
    return "health";
  }
  return LIVE_WORKFLOWS[basename] ?? "analysis";
}

function elapsedSeconds(run: ActiveWorkflowRun, now: number): number {
  const start = Date.parse(run.run_started_at ?? run.created_at);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.round((now - start) / 1000));
}

/**
 * The live operations snapshot (D-086): in-flight Actions runs merged with the
 * progress heartbeat, plus the file-based recent runs, queues, and schedule.
 * Read-only across the Actions API + the ops-progress ref; when the GitHub
 * read surface is unconfigured the live section degrades to empty while every
 * file-based section still renders.
 */
export async function getLiveOpsSnapshotAction(): Promise<LiveOpsSnapshot> {
  const now = new Date();
  const files = readLiveOpsFiles(now);
  const base: LiveOpsSnapshot = {
    generatedAt: now.toISOString(),
    liveEnabled: false,
    error: null,
    running: [],
    ...files,
  };

  const env = readGithubOpsEnv();
  if (!env) return base;

  try {
    const active = (await listActiveWorkflowRuns(env)).filter(
      (run) => workflowBasename(run.path) in LIVE_WORKFLOWS,
    );

    let progress: RunProgress | null = null;
    try {
      const heartbeat = await getRepoFileFromRef(env, OPS_PROGRESS_ENTRY, OPS_PROGRESS_REF);
      if (heartbeat?.text) progress = JSON.parse(heartbeat.text) as RunProgress;
    } catch {
      // A missing/unreadable heartbeat is fine — phase/elapsed still come from
      // the Actions API; only the rich counters are absent.
      progress = null;
    }

    const nowMs = now.getTime();
    const running: LiveRun[] = await Promise.all(
      active.map(async (run): Promise<LiveRun> => {
        const basename = workflowBasename(run.path);
        const phase = await getRunCurrentPhase(env, run.id);
        const matched =
          progress && progress.github_run_id === run.id ? progress : null;
        return {
          runId: run.id,
          name: run.name,
          workflow: basename,
          kind: classifyRun(basename, run.name),
          status: run.status,
          htmlUrl: run.html_url,
          createdAt: run.created_at,
          elapsedS: elapsedSeconds(run, nowMs),
          phase,
          progress: matched,
        };
      }),
    );
    running.sort((a, b) => b.elapsedS - a.elapsedS);

    return { ...base, liveEnabled: true, running };
  } catch (err) {
    return { ...base, liveEnabled: true, error: errorMessage(err) };
  }
}

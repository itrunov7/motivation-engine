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
  dispatchHarvest,
  downloadArtifactJson,
  findRunByDispatchId,
  getRepoFile,
  putRepoFile,
  readGithubOpsEnv,
  type GithubOpsEnv,
} from "@/lib/github";

// ---------- Shared result types ----------

export type ActionResult =
  | { ok: true }
  | { ok: false; error: string };

export type DispatchResult =
  | { ok: true; dispatchId: string }
  | { ok: false; error: string };

export type PollState = "pending" | "running" | "ready" | "no_quote";

export type PollResult =
  | { ok: true; state: PollState; runUrl?: string; quote?: QuoteArtifact }
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

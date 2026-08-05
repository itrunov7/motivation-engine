/**
 * tools/transferability-probe.ts — run the ruleset v2 VARIABLE judgement over
 * proposals that already exist, and print what it decided. Nothing else.
 *
 * WHY THIS EXISTS. The v2 check (D-162) lives inside runExtraction, which is
 * Actions-only and re-reads the corpus. So the only way to see what the filter
 * would say about the queue was to run a full extraction — a pass that consumes
 * reader coverage, spends the cheap tier on records already read, and writes
 * proposals. The question "what does the filter say about these ten proposals?"
 * did not need any of that, and could not be asked without all of it. Every
 * number D-162 quotes was produced outside this repository for exactly that
 * reason, and none of them can be reproduced from it.
 *
 * WHAT IT DOES NOT DO. It writes nothing. It does not tag, hold, approve,
 * reject, or edit any proposal; it produces no manifest entry, no ledger entry,
 * no checkpoint, no reader coverage. Its output is stdout. A verdict it prints
 * is a MEASUREMENT of the filter, not a decision about a claim — under D-131
 * that distinction is the whole reason to keep it read-only: the numbers are
 * for a human to read before anything is committed against them.
 *
 * SPEND. Real, small, and reported. This follows the contract
 * tools/openrouter-preflight.ts already set (D-107): the cost is printed rather
 * than silently absorbed, and it is NOT written to the ledger, because a probe
 * produces no proposals and a spend record with no candidate behind it would
 * corrupt the very accounting it is trying to respect. The per-run and monthly
 * token caps still bind — they are enforced inside judgeVariableViaModel, which
 * this calls unmodified, so the probe cannot spend past a limit the pipeline
 * would have stopped at.
 *
 * MODEL. Whatever corpora/_ops/extraction.json configures as the STRONG tier —
 * the model the pipeline would actually call. It is not pinned here and must not
 * be: a probe that measured a different model from the one production uses would
 * produce numbers that read as evidence and are not.
 *
 * Usage (from repo root):
 *   npm run transferability-probe -- target=LA-01 status=pending dry-run
 *   OPENROUTER_API_KEY=... npm run transferability-probe -- target=LA-01 status=pending
 *
 *   target=   mechanism id (proposal.target). Omit for every mechanism.
 *   status=   proposal status, default pending.
 *   id=       a single proposal id.
 *   limit=    stop after N proposals — a bound on spend, stated in the output.
 *   dry-run   print the prompts and the cost estimate, make no calls at all.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtractionOpsConfig, Proposal } from "../lib/types";
import { TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS } from "../lib/types";
import type { TransferabilityVerdictUnavailableReason } from "../lib/types";
import {
  buildVariablePrompt,
  describeTransferability,
  judgeTransferabilityV2,
  transferabilityClaimOfProposal,
  TRANSFERABILITY_RULESET_VERSION_V2,
} from "../lib/transferability";
import { PROPOSAL_TYPES } from "../lib/proposals";
import { loadExtractionOpsConfigFromDisk, validateExtractionOpsConfig } from "../lib/ops";
import {
  configuredTier,
  estimateTokens,
  judgeVariableViaModel,
  type Usage,
} from "./extract";

const ROOT = join(__dirname, "..");
/** Mirrors the cap judgeVariableViaModel applies to its own answer. */
const MAX_ANSWER_TOKENS = 200;

function option(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string): boolean {
  return process.argv.includes(name) || process.argv.includes(`--${name}`);
}

interface LoadedProposal {
  path: string;
  proposal: Proposal;
}

function loadProposals(): LoadedProposal[] {
  const loaded: LoadedProposal[] = [];
  for (const type of PROPOSAL_TYPES) {
    const directory = join(ROOT, "proposals", type);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith(".json")) continue;
      const path = `proposals/${type}/${name}`;
      loaded.push({
        path,
        proposal: JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Proposal,
      });
    }
  }
  return loaded;
}

function oneLine(value: string, limit = 400): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    calls: 0,
    byTier: {
      cheap: { input: 0, output: 0, calls: 0 },
      strong: { input: 0, output: 0, calls: 0 },
    },
  };
}

function loadConfig(): ExtractionOpsConfig {
  const config = loadExtractionOpsConfigFromDisk();
  if (!config) throw new Error("Missing corpora/_ops/extraction.json");
  // The same validator the quote, CI and the /ops write path use. A probe that
  // accepted a config the rest of the fleet would reject would measure a model
  // no run could ever call.
  const errors = validateExtractionOpsConfig(config);
  if (errors.length > 0) {
    throw new Error(`corpora/_ops/extraction.json is invalid: ${errors.join("; ")}`);
  }
  return config;
}

function select(): LoadedProposal[] {
  const target = option("target");
  const status = option("status") ?? "pending";
  const id = option("id");
  const limit = option("limit") ? Number(option("limit")) : undefined;

  const matched = loadProposals().filter(({ proposal }) => {
    if (target && proposal.target !== target) return false;
    if (status !== "any" && proposal.status !== status) return false;
    if (id && proposal.id !== id) return false;
    return transferabilityClaimOfProposal(proposal) !== null;
  });

  if (limit !== undefined && Number.isFinite(limit) && matched.length > limit) {
    // Stated, never silent. A bound that shrinks the population without saying
    // so turns a partial pass into an apparently complete one.
    console.log(
      `NOTE: limit=${limit} — ${matched.length - limit} of ${matched.length} matching ` +
        "proposals were NOT judged and are absent from every count below.\n",
    );
    return matched.slice(0, limit);
  }
  return matched;
}

async function probe(): Promise<void> {
  const config = loadConfig();
  const tier = configuredTier(config, "strong");
  const selected = select();
  const dryRun = flag("dry-run");

  console.log(
    `Transferability probe — ruleset v${TRANSFERABILITY_RULESET_VERSION_V2}, ` +
      `${selected.length} judgeable proposal(s)` +
      `${option("target") ? ` in ${option("target")}` : ""}` +
      ` with status ${option("status") ?? "pending"}.`,
  );
  console.log(`Model: ${tier.model_id} (strong tier, from corpora/_ops/extraction.json)`);
  console.log(
    `Caps in force: per_run_tokens ${config.limits.per_run_tokens.toLocaleString()}, ` +
      `monthly_tokens ${config.limits.monthly_tokens.toLocaleString()}.`,
  );

  const prompts = selected.map(({ proposal }) => {
    const claim = transferabilityClaimOfProposal(proposal)!;
    return buildVariablePrompt(claim);
  });
  const estimatedInput = prompts.reduce((sum, prompt) => sum + estimateTokens(prompt), 0);
  const estimatedOutput = selected.length * MAX_ANSWER_TOKENS;
  const estimatedUsd =
    estimatedInput * tier.input_usd_per_token + estimatedOutput * tier.output_usd_per_token;

  if (dryRun) {
    console.log("\nDRY RUN — no request was sent, no token was spent.\n");
    selected.forEach(({ proposal }, index) => {
      console.log(`${proposal.id}  [${proposal.status}]`);
      console.log(`  prompt tokens (upper bound): ${estimateTokens(prompts[index])}`);
      console.log(`  prompt:\n${prompts[index].replace(/^/gm, "    ")}\n`);
    });
    console.log(
      `ESTIMATE (not a measurement, D-131): ${selected.length} call(s), ` +
        `≤${estimatedInput.toLocaleString()} input + ≤${estimatedOutput.toLocaleString()} output tokens, ` +
        `≤$${estimatedUsd.toFixed(4)} at the configured ${tier.model_id} prices.`,
    );
    console.log("Read-only: nothing was written, held, or decided.");
    return;
  }

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Export it for this command, or use dry-run to " +
        "see the prompts and the cost estimate without calling anything.",
    );
  }

  console.log(
    `Estimated cost before starting (D-131 — an ESTIMATE): ≤$${estimatedUsd.toFixed(4)}.\n`,
  );

  const usage = emptyUsage();
  const context = { config, usage, fetcher: fetch };
  let transferable = 0;
  let refused = 0;
  let escalated = 0;
  const unavailable: Record<string, number> = {};

  for (const { path, proposal } of selected) {
    const claim = transferabilityClaimOfProposal(proposal)!;
    const outcome = await judgeVariableViaModel(context, claim);

    console.log(`${proposal.id}  [${proposal.status}]`);
    if (!outcome.ok) {
      unavailable[outcome.reason] = (unavailable[outcome.reason] ?? 0) + 1;
      console.log(`  verdict : VERDICT UNAVAILABLE (${outcome.reason})`);
      if (outcome.detail) console.log(`  detail  : ${oneLine(outcome.detail, 200)}`);
      console.log("  lever   : —  (nothing judged this claim)");
      console.log(`  fact    : ${oneLine(claim.fact)}`);
      console.log(`  file    : ${path}\n`);
      continue;
    }

    const verdict = judgeTransferabilityV2(claim, outcome.judgement);
    if (verdict.transferable) transferable += 1;
    else refused += 1;
    if (verdict.escalated_by_warning_pair) escalated += 1;

    const variable = verdict.checks.find((check) => check.check === "variable");
    console.log(`  verdict : ${describeTransferability(verdict)}`);
    console.log(`  lever   : ${outcome.judgement.lever ?? "none identified"}`);
    console.log(`  reason  : ${oneLine(variable?.reason ?? outcome.judgement.reason, 300)}`);
    console.log(`  fact    : ${oneLine(claim.fact)}`);
    // The three deterministic checks are printed too: without them a refusal by
    // SUBJECT or POPULATION reads as a VARIABLE refusal, and the whole point of
    // v2 was to find out which check was doing the refusing.
    console.log(
      `  checks  : ${verdict.checks.map((check) => `${check.check}=${check.outcome}`).join(" ")}`,
    );
    for (const check of verdict.checks) {
      if (check.outcome === "pass") continue;
      const marker = check.outcome === "fail" ? "✗" : "!";
      console.log(`  ${marker} ${check.check.padEnd(10)} ${check.reason}`);
    }
    console.log(`  file    : ${path}\n`);
  }

  const unavailableTotal = Object.values(unavailable).reduce((a, b) => a + b, 0);
  const judged = transferable + refused;
  const measuredUsd =
    usage.byTier.strong.input * tier.input_usd_per_token +
    usage.byTier.strong.output * tier.output_usd_per_token;

  console.log("—".repeat(72));
  console.log(
    `${transferable} of ${judged} judged claim(s) transferable; ${refused} refused, ` +
      `of which ${escalated} turned on the subject+population warning pair.`,
  );
  // Printed even at zero. A probe that reported nothing when nothing failed
  // would leave "the filter judged everything" and "the filter judged nothing"
  // looking the same, which is the defect this counter was added to end.
  console.log(
    `${unavailableTotal} of ${selected.length} admitted with NO verdict` +
      (unavailableTotal > 0
        ? `  (${TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS.filter(
            (reason) => (unavailable[reason] ?? 0) > 0,
          )
            .map(
              (reason: TransferabilityVerdictUnavailableReason) =>
                `${reason} ${unavailable[reason]}`,
            )
            .join(", ")})`
        : ""),
  );
  console.log(
    `Cost, MEASURED from the responses: ${usage.byTier.strong.calls} call(s), ` +
      `${usage.byTier.strong.input.toLocaleString()} in / ` +
      `${usage.byTier.strong.output.toLocaleString()} out, $${measuredUsd.toFixed(4)} ` +
      `on ${tier.model_id}.`,
  );
  console.log(
    "Not written to corpora/extraction/ledger.json or the manifest: a probe produces " +
      "no proposals, so it has no candidate to attribute spend to (D-107 precedent).",
  );
  console.log("Read-only: nothing above was written, tagged, held, or decided.");
}

if (require.main === module) {
  probe().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

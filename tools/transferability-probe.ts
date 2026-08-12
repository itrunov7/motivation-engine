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
 * WHAT IT DOES NOT DO. It does not tag, hold, approve, reject, or edit any
 * proposal; it produces no ledger entry, no checkpoint, no reader coverage. Its
 * output is stdout. A verdict it prints is a MEASUREMENT of the filter, not a
 * decision about a claim — under D-131 that distinction is the whole reason to
 * keep it read-only: the numbers are for a human to read before anything is
 * committed against them.
 *
 * The one exception, added by D-164 and off by default, is `record-spend`: it
 * appends this run's MEASURED cost to corpora/extraction/manifest.json and
 * writes nothing else. It never touches last_run — a probe is not the last
 * extraction, and the showcase reads last_run to say what extraction did.
 *
 * SPEND. Real, small, reported, and — with record-spend — recorded. The cost is
 * never silently absorbed. It is NOT written to the candidate ledger, because a
 * probe produces no proposals and a ledger entry with no candidate behind it
 * would corrupt the very accounting it is trying to respect (D-107). It IS
 * written to the extraction manifest when record-spend is passed (D-164): the
 * monthly cap is derived from committed manifests and reads nothing else, so a
 * probe whose spend never lands there is spend the cap cannot see. The per-run
 * and monthly token caps still bind — they are enforced inside
 * judgeVariableViaModel, which this calls unmodified, so the probe cannot spend
 * past a limit the pipeline would have stopped at.
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
 *   ruleset=  2 (default) or 3. The scoring applied to the SAME model answer:
 *             under v3 only VARIABLE can refuse and the other three checks are
 *             recorded as modifiers (D-165). One model call either way — the
 *             rulesets differ in how the answer is scored, not in what is asked.
 *   dry-run   print the prompts and the cost estimate, make no calls at all.
 *   record-spend  append this run's measured cost to the extraction manifest
 *                 (D-164). Ignored under dry-run, which spends nothing.
 *
 * RE-SCORING, offline and free:
 *   npm run transferability-probe -- rescore ruleset=3 [target=LA-01] [answers=<path>]
 *
 * Every probe run writes the model's answers to transferability-answers.json (a
 * gitignored run artifact, uploaded by the workflow). `rescore` applies a
 * ruleset to those STORED answers — no model call, no network, no spend — and
 * prints the per-mechanism share, the refusals by check, and the lever behind
 * every refusal VARIABLE itself made.
 *
 * This is the comparison D-165 designed for: it made v3's SUBJECT/DIRECTION/
 * POPULATION computation byte-identical to v2's so the rulesets differ in
 * scoring alone, which means scoring the same answers both ways separates the
 * rule change from the model's run-to-run variance. Re-probing measures both at
 * once; re-scoring measures only the rule.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CorpusManifest,
  CorpusManifestRun,
  CorpusRunStatus,
  ExtractionOpsConfig,
  Proposal,
} from "../lib/types";
import { TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS } from "../lib/types";
import type { TransferabilityVerdictUnavailableReason } from "../lib/types";
import {
  buildVariablePrompt,
  describeTransferability,
  judgeTransferabilityV2,
  judgeTransferabilityV3,
  transferabilityClaimOfProposal,
  TRANSFERABILITY_RULESET_VERSION_V2,
  TRANSFERABILITY_RULESET_VERSION_V3,
} from "../lib/transferability";
import { PROPOSAL_TYPES } from "../lib/proposals";
import { loadExtractionOpsConfigFromDisk, validateExtractionOpsConfig } from "../lib/ops";
import {
  buildExtractionManifestCost,
  configuredTier,
  estimateTokens,
  judgeVariableViaModel,
  mergeExtractionRunHistory,
  type Usage,
} from "./extract";
import { PROBE_RUN_MODE } from "./connectors/types";

const ROOT = join(__dirname, "..");
/** Mirrors the cap judgeVariableViaModel applies to its own answer. */
const MAX_ANSWER_TOKENS = 200;
/** The manifest whose run_history the monthly cap is computed from. */
const MANIFEST_FILE = join(ROOT, "corpora", "extraction", "manifest.json");

function option(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string): boolean {
  return process.argv.includes(name) || process.argv.includes(`--${name}`);
}

/**
 * Which scoring to apply. Unknown values throw rather than falling back: a probe
 * that silently measured v2 when asked for v3 would report numbers under a name
 * they do not belong to, which is the one thing a measurement must never do.
 */
function selectedRuleset(): number {
  const raw = option("ruleset");
  if (raw === undefined) return TRANSFERABILITY_RULESET_VERSION_V2;
  const normalised = raw.trim().toLowerCase().replace(/^v/, "");
  if (normalised === String(TRANSFERABILITY_RULESET_VERSION_V2)) {
    return TRANSFERABILITY_RULESET_VERSION_V2;
  }
  if (normalised === String(TRANSFERABILITY_RULESET_VERSION_V3)) {
    return TRANSFERABILITY_RULESET_VERSION_V3;
  }
  throw new Error(
    `ruleset=${raw} is not a ruleset this probe can apply. ` +
      `Use ${TRANSFERABILITY_RULESET_VERSION_V2} or ${TRANSFERABILITY_RULESET_VERSION_V3}. ` +
      "v1 is the offline word list and is run by transferability-report, not by a probe.",
  );
}

/**
 * Where the probe writes the model's own answers.
 *
 * A run artifact, gitignored like quote.json (D-025): it is the output of one
 * run against one queue at one moment, not a corpus record, and committing it
 * would make a snapshot look like a source. The workflow uploads it instead.
 *
 * It exists because the probe's answers were previously reachable only by
 * reading an Actions log, which meant a scoring comparison had to be
 * hand-parsed out of stdout — and a number nobody can re-derive by running a
 * committed script is exactly the kind of number this project refuses. With the
 * answers stored, `rescore` applies any ruleset to the SAME model answers, for
 * free, as many times as anyone wants to check.
 */
const ANSWERS_FILE = join(ROOT, "transferability-answers.json");

/** One claim's model answer, plus everything needed to re-score it offline. */
interface StoredAnswer {
  proposal_id: string;
  path: string;
  target: string;
  status: string;
  /** The model's VARIABLE judgement, or null when the call produced no verdict. */
  judgement: { transferable: boolean; lever: string | null; reason: string } | null;
  /** Set exactly when judgement is null. */
  unavailable_reason?: string;
  /**
   * The four checks as this run computed them. Kept so a re-score is a pure
   * function of this file: the three deterministic ones ARE recomputable from
   * the claim, but recomputing them during a re-score would silently mix
   * today's lexicons into a measurement of an older run.
   */
  checks: { check: string; outcome: string; reason: string; identified_lever?: string | null }[];
}

interface AnswersFile {
  schema_version: 1;
  generated_at: string;
  ruleset_version_at_capture: number;
  model_id: string;
  target: string;
  status_filter: string;
  answers: StoredAnswer[];
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

function select(): { selected: LoadedProposal[]; truncatedBy: number } {
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
    return { selected: matched.slice(0, limit), truncatedBy: matched.length - limit };
  }
  return { selected: matched, truncatedBy: 0 };
}

/** Everything the manifest entry reports about what this probe measured. */
interface ProbeOutcome {
  status: CorpusRunStatus;
  /** The scoring this run applied — stamped so spend names the rules it bought. */
  rulesetVersion: number;
  target: string;
  statusFilter: string;
  selected: number;
  judged: number;
  transferable: number;
  refused: number;
  escalated: number;
  unavailable: Record<string, number>;
  truncatedBy: number;
  error?: string;
}

/**
 * Append this run's MEASURED cost to corpora/extraction/manifest.json (D-164).
 *
 * Writes exactly one run_history entry and nothing else. `last_run` is
 * deliberately left as it was: lib/ops.ts reads last_run to describe what
 * extraction last did, and a probe that overwrote it would make the showcase
 * report a measurement as a production pass — a hardcoded-progress defect
 * arrived at by a different route.
 *
 * Idempotent per run, on the same identity extraction uses (D-099): the entry
 * is keyed by startedAt, so re-writing replaces this run's entry rather than
 * double-counting its spend.
 */
function recordProbeSpend(args: {
  startedAt: Date;
  config: ExtractionOpsConfig;
  usage: Usage;
  outcome: ProbeOutcome;
}): boolean {
  if (!existsSync(MANIFEST_FILE)) {
    // A probe must never author the extraction manifest — that file is the
    // record of what extraction did, and a probe has done none of it.
    console.log(
      "\nSPEND NOT RECORDED: corpora/extraction/manifest.json does not exist, and a " +
        "probe does not create it. The cost above is in this log only.",
    );
    return false;
  }
  const { outcome } = args;
  const durationS =
    Math.round(((Date.now() - args.startedAt.getTime()) / 1000) * 100) / 100;
  const unavailableTotal = Object.values(outcome.unavailable).reduce((a, b) => a + b, 0);
  const run: CorpusManifestRun = {
    timestamp: args.startedAt.toISOString(),
    status: outcome.status,
    // Every value a string: the manifest schema types params that way, and the
    // counts are the same ones printed above, not a second derivation of them.
    params: {
      mode: PROBE_RUN_MODE,
      ruleset_version: String(outcome.rulesetVersion),
      target: outcome.target,
      proposal_status: outcome.statusFilter,
      selected: String(outcome.selected),
      judged: String(outcome.judged),
      transferable: String(outcome.transferable),
      refused: String(outcome.refused),
      escalated_by_warning_pair: String(outcome.escalated),
      verdict_unavailable: String(unavailableTotal),
      ...(unavailableTotal > 0
        ? {
            verdict_unavailable_reasons: TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS.filter(
              (reason) => (outcome.unavailable[reason] ?? 0) > 0,
            )
              .map((reason) => `${reason}=${outcome.unavailable[reason]}`)
              .join(" "),
          }
        : {}),
      ...(outcome.truncatedBy > 0 ? { not_judged_by_limit: String(outcome.truncatedBy) } : {}),
    },
    // A probe reads proposals, not corpus records, and writes no file. Both
    // zeros are facts about a probe, not placeholders for uncounted work.
    records_fetched: 0,
    files_written: 0,
    duration_s: durationS,
    ...(outcome.error ? { error: oneLine(outcome.error, 200) } : {}),
    ...(unavailableTotal > 0 || outcome.truncatedBy > 0
      ? {
          warnings: {
            ...(unavailableTotal > 0 ? { verdict_unavailable: true } : {}),
            ...(outcome.truncatedBy > 0 ? { capped: true } : {}),
          },
        }
      : {}),
    dispatch_id: process.env.OPS_DISPATCH_ID ?? null,
    github_run_id: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null,
    cost: buildExtractionManifestCost(args.config, args.usage, durationS),
  };

  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as CorpusManifest;
  const previous = manifest.run_history ?? [];
  const history = mergeExtractionRunHistory(previous, run);
  writeFileSync(
    MANIFEST_FILE,
    `${JSON.stringify({ ...manifest, run_history: history }, null, 2)}\n`,
  );

  console.log(
    `\nSpend recorded in corpora/extraction/manifest.json (D-164): run ${run.timestamp}, ` +
      `dispatch_id ${run.dispatch_id ?? "none"}, $${run.cost?.estimated_usd.toFixed(6)}. ` +
      "It counts against the monthly cap like any other run. last_run is untouched.",
  );

  // The history is capped, so writing an entry can push an older one out — and
  // the monthly rollup sums nothing but this array, so an evicted run's spend
  // silently leaves the cap's view. Stated, never absorbed: silent loss is the
  // defect this project has hit four times.
  const kept = new Set(history.map((entry) => entry.timestamp));
  for (const evicted of previous.filter((entry) => !kept.has(entry.timestamp))) {
    console.log(
      `EVICTED by the ${history.length}-entry history cap: run ${evicted.timestamp} ` +
        `($${(evicted.cost?.estimated_usd ?? 0).toFixed(6)}, ` +
        `${((evicted.cost?.tokens_in ?? 0) + (evicted.cost?.tokens_out ?? 0)).toLocaleString()} tokens). ` +
        "Its spend is no longer visible to the monthly cap. Owner decision, not a probe decision.",
    );
  }
  return true;
}

async function probe(): Promise<void> {
  const startedAt = new Date();
  const config = loadConfig();
  const tier = configuredTier(config, "strong");
  const { selected, truncatedBy } = select();
  const dryRun = flag("dry-run");
  const recordSpend = flag("record-spend");
  const rulesetVersion = selectedRuleset();

  console.log(
    `Transferability probe — ruleset v${rulesetVersion}, ` +
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
    if (recordSpend) {
      // Nothing was spent, so there is nothing to record. Said out loud, because
      // a silent skip here would leave "recorded nothing" and "spent nothing"
      // looking the same in the workflow log.
      console.log("record-spend ignored: a dry run spends nothing, so it records nothing.");
    }
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
  const modifierCounts: Record<string, number> = {};
  const answers: StoredAnswer[] = [];

  // A pass that dies half way has still spent what it spent, and the monthly
  // cap only ever sees what a manifest records (D-099). The failure is captured
  // here so the summary prints and the spend lands, then rethrown below — the
  // run still fails, it just fails with its accounting written.
  let failure: Error | undefined;
  try {
    for (const { path, proposal } of selected) {
      const claim = transferabilityClaimOfProposal(proposal)!;
      // Snapshot before and after so the cost printed under a proposal is that
      // proposal's own, measured from its response — not the run total divided
      // by the number of calls, which would be an average wearing a fact's face.
      const before = { ...usage.byTier.strong };
      const outcome = await judgeVariableViaModel(context, claim);
      const callInput = usage.byTier.strong.input - before.input;
      const callOutput = usage.byTier.strong.output - before.output;
      const callUsd =
        callInput * tier.input_usd_per_token + callOutput * tier.output_usd_per_token;
      const callCost =
        `$${callUsd.toFixed(6)} (${callInput.toLocaleString()} in / ` +
        `${callOutput.toLocaleString()} out)`;

      console.log(`${proposal.id}  [${proposal.status}]`);
      if (!outcome.ok) {
        unavailable[outcome.reason] = (unavailable[outcome.reason] ?? 0) + 1;
        answers.push({
          proposal_id: proposal.id,
          path,
          target: proposal.target,
          status: proposal.status,
          judgement: null,
          unavailable_reason: outcome.reason,
          checks: [],
        });
        console.log(`  verdict : VERDICT UNAVAILABLE (${outcome.reason})`);
        if (outcome.detail) console.log(`  detail  : ${oneLine(outcome.detail, 200)}`);
        console.log("  lever   : —  (nothing judged this claim)");
        console.log(`  fact    : ${oneLine(claim.fact)}`);
        console.log(`  cost    : ${callCost}`);
        console.log(`  file    : ${path}\n`);
        continue;
      }

      const verdict =
        rulesetVersion === TRANSFERABILITY_RULESET_VERSION_V3
          ? judgeTransferabilityV3(claim, outcome.judgement)
          : judgeTransferabilityV2(claim, outcome.judgement);
      if (verdict.transferable) transferable += 1;
      else refused += 1;
      if (verdict.escalated_by_warning_pair) escalated += 1;
      for (const modifier of verdict.modifiers_flagged ?? []) {
        modifierCounts[modifier] = (modifierCounts[modifier] ?? 0) + 1;
      }

      answers.push({
        proposal_id: proposal.id,
        path,
        target: proposal.target,
        status: proposal.status,
        judgement: {
          transferable: outcome.judgement.transferable,
          lever: outcome.judgement.lever,
          reason: outcome.judgement.reason,
        },
        checks: verdict.checks.map((check) => ({
          check: check.check,
          outcome: check.outcome,
          reason: check.reason,
          ...(check.identified_lever === undefined
            ? {}
            : { identified_lever: check.identified_lever }),
        })),
      });

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
      if (rulesetVersion === TRANSFERABILITY_RULESET_VERSION_V3) {
        const modifiers = verdict.modifiers_flagged ?? [];
        console.log(`  modifiers: ${modifiers.length > 0 ? modifiers.join(", ") : "none"}`);
      }
      for (const check of verdict.checks) {
        if (check.outcome === "pass") continue;
        // Under v3 only VARIABLE can refuse, so only VARIABLE earns the refusal
        // marker. A ✗ next to SUBJECT would contradict the verdict printed two
        // lines above it.
        const refuses =
          check.outcome === "fail" &&
          (rulesetVersion !== TRANSFERABILITY_RULESET_VERSION_V3 || check.check === "variable");
        console.log(`  ${refuses ? "✗" : "!"} ${check.check.padEnd(10)} ${check.reason}`);
      }
      console.log(`  cost    : ${callCost}`);
      console.log(`  file    : ${path}\n`);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    console.log(
      `\nPROBE FAILED after ${usage.byTier.strong.calls} call(s): ${failure.message}`,
    );
    console.log("Everything below is a PARTIAL pass, not a measurement of the queue.\n");
  }

  // Written on the failure path too, and for the same reason the spend is: a
  // pass that died half way still asked the model everything it asked, and
  // throwing those answers away would mean paying for them twice.
  if (answers.length > 0) {
    const file: AnswersFile = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      ruleset_version_at_capture: rulesetVersion,
      model_id: tier.model_id,
      target: option("target") ?? "all",
      status_filter: option("status") ?? "pending",
      answers,
    };
    writeFileSync(ANSWERS_FILE, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    console.log(
      `\n${answers.length} model answer(s) written to transferability-answers.json — ` +
        "re-score them under any ruleset with `npm run transferability-probe -- rescore`, " +
        "no model call and no spend.",
    );
  }

  const unavailableTotal = Object.values(unavailable).reduce((a, b) => a + b, 0);
  const judged = transferable + refused;
  const measuredUsd =
    usage.byTier.strong.input * tier.input_usd_per_token +
    usage.byTier.strong.output * tier.output_usd_per_token;

  console.log("—".repeat(72));
  console.log(
    rulesetVersion === TRANSFERABILITY_RULESET_VERSION_V3
      ? `${transferable} of ${judged} judged claim(s) transferable; ${refused} refused, ` +
          "every one of them by VARIABLE naming no lever — the only refusal v3 has."
      : `${transferable} of ${judged} judged claim(s) transferable; ${refused} refused, ` +
          `of which ${escalated} turned on the subject+population warning pair.`,
  );
  if (rulesetVersion === TRANSFERABILITY_RULESET_VERSION_V3) {
    // The modifiers are the point of v3: they are what SUBJECT, DIRECTION and
    // POPULATION now do instead of refusing, so a run that never printed their
    // total would hide whether they still flag anything at all.
    const flaggedTotal = Object.values(modifierCounts).reduce((a, b) => a + b, 0);
    console.log(
      `${flaggedTotal} modifier flag(s) recorded across ${judged} verdict(s)` +
        (flaggedTotal > 0
          ? `  (${Object.entries(modifierCounts)
              .map(([check, count]) => `${check} ${count}`)
              .join(", ")})` +
            " — recorded on the verdict, never a refusal."
          : "."),
    );
  }
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
    "Not written to corpora/extraction/ledger.json: a probe produces no proposals, so " +
      "it has no candidate to attribute spend to (D-107 precedent).",
  );
  console.log(
    "Read-only where it matters: nothing above was tagged, held, approved, rejected, " +
      "or written to any proposal, and no reader coverage was consumed.",
  );

  if (recordSpend) {
    const recorded = recordProbeSpend({
      startedAt,
      config,
      usage,
      outcome: {
        // A pass that threw is "failed" whatever its counters say; a pass that
        // admitted a claim with no verdict, or judged less than it selected, did
        // less than it was asked to and is "partial". Only a complete pass is a
        // success, because only a complete pass measures the queue.
        status: failure
          ? "failed"
          : unavailableTotal > 0 || truncatedBy > 0 || judged < selected.length
            ? "partial"
            : "success",
        rulesetVersion,
        target: option("target") ?? "all",
        statusFilter: option("status") ?? "pending",
        selected: selected.length,
        judged,
        transferable,
        refused,
        escalated,
        unavailable,
        truncatedBy,
        error: failure?.message,
      },
    });
    if (!recorded) process.exitCode = 1;
  } else {
    console.log(
      "Spend NOT recorded in the manifest: record-spend was not passed, so the monthly " +
        "cap cannot see the cost above (D-164).",
    );
  }

  if (failure) throw failure;
}

/**
 * Re-score stored model answers under a ruleset, offline.
 *
 * No model call, no network, no spend, nothing written. This is the like-for-
 * like comparison D-165 designed for when it made v3's SUBJECT/DIRECTION/
 * POPULATION computation byte-identical to v2's: the two rulesets differ in
 * scoring alone, so applying both to the SAME answers isolates the scoring
 * change from the model's own variance between runs.
 *
 * It re-scores from the STORED checks rather than recomputing them, so what it
 * reports is what that run would have decided — not what today's lexicons would
 * decide about that run's claims.
 */
function rescore(): void {
  const path = option("answers") ?? ANSWERS_FILE;
  if (!existsSync(path)) {
    throw new Error(
      `no stored answers at ${path}. Run the probe first — it writes them — or pass answers=<path>.`,
    );
  }
  const file = JSON.parse(readFileSync(path, "utf8")) as AnswersFile;
  const rulesetVersion = selectedRuleset();
  const target = option("target");

  const selected = file.answers.filter((a) => !target || a.target === target);
  console.log(
    `Re-score — ruleset v${rulesetVersion} applied to ${selected.length} stored answer(s) ` +
      `captured under v${file.ruleset_version_at_capture} from ${file.model_id} at ${file.generated_at}.`,
  );
  console.log("Offline: no model call, no spend, nothing written.\n");

  const byMech: Record<
    string,
    { judged: number; ok: number; refusedBy: Record<string, number>; unavailable: number }
  > = {};
  const leversOnRefusal: { id: string; target: string; lever: string | null; reason: string }[] = [];

  for (const answer of selected) {
    const m = (byMech[answer.target] ||= { judged: 0, ok: 0, refusedBy: {}, unavailable: 0 });
    if (!answer.judgement) {
      m.unavailable += 1;
      continue;
    }
    m.judged += 1;
    const variable = answer.checks.find((c) => c.check === "variable");
    // v3: the lever alone decides. v2: any failing check refuses.
    const transferable =
      rulesetVersion === TRANSFERABILITY_RULESET_VERSION_V3
        ? variable?.outcome === "pass"
        : !answer.checks.some((c) => c.outcome === "fail");
    if (transferable) {
      m.ok += 1;
      continue;
    }
    for (const check of answer.checks) {
      if (check.outcome !== "fail") continue;
      if (rulesetVersion === TRANSFERABILITY_RULESET_VERSION_V3 && check.check !== "variable") {
        continue;
      }
      m.refusedBy[check.check] = (m.refusedBy[check.check] ?? 0) + 1;
    }
    if (variable?.outcome === "fail") {
      leversOnRefusal.push({
        id: answer.proposal_id,
        target: answer.target,
        lever: answer.judgement.lever,
        reason: variable.reason,
      });
    }
  }

  const pad = (value: unknown, width: number): string => String(value).padEnd(width);
  const share = (a: number, b: number): string =>
    b === 0 ? "-" : `${a}/${b} (${Math.round((a / b) * 100)}%)`;
  console.log(`${pad("mech", 7)}${pad("judged", 8)}${pad("transferable", 15)}${pad("unjudged", 10)}refused by`);
  let judged = 0;
  let ok = 0;
  let unavailable = 0;
  const refusedByAll: Record<string, number> = {};
  for (const mech of Object.keys(byMech).sort()) {
    const m = byMech[mech];
    judged += m.judged;
    ok += m.ok;
    unavailable += m.unavailable;
    for (const [k, v] of Object.entries(m.refusedBy)) {
      refusedByAll[k] = (refusedByAll[k] ?? 0) + v;
    }
    const by =
      Object.entries(m.refusedBy)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "-";
    console.log(
      `${pad(mech, 7)}${pad(m.judged, 8)}${pad(share(m.ok, m.judged), 15)}${pad(m.unavailable, 10)}${by}`,
    );
  }
  console.log("-".repeat(78));
  const byAll =
    Object.entries(refusedByAll)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "-";
  console.log(
    `${pad("ALL", 7)}${pad(judged, 8)}${pad(share(ok, judged), 15)}${pad(unavailable, 10)}${byAll}`,
  );

  // Under v3 this is the entire refusal set, and it is the one the owner asked
  // to see: what VARIABLE itself threw out, and what it said about it.
  console.log(
    `\nREFUSALS MADE BY VARIABLE ITSELF (${leversOnRefusal.length}) — the only refusal v3 has`,
  );
  if (leversOnRefusal.length === 0) {
    console.log("  none — VARIABLE named a lever on every judged claim");
  }
  for (const entry of leversOnRefusal) {
    console.log(`  ${entry.target}  ${entry.id}`);
    console.log(`    lever : ${entry.lever ?? "none identified"}`);
    console.log(`    reason: ${oneLine(entry.reason, 200)}`);
  }
}

if (require.main === module) {
  const command = process.argv[2];
  if (command === "rescore") {
    try {
      rescore();
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else {
    probe().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  }
}

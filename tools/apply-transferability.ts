/**
 * tools/apply-transferability.ts — project ruleset v3 verdicts onto the
 * existing pending/held queue, offline.
 *
 * D-176 adopted v3 as the ruleset extract.ts applies, but extraction judges
 * CANDIDATES and the effects slice is exhausted for every mechanism — no
 * extraction run will ever reach the 196 proposals already in the queue. This
 * tool is the persistence path designed (not run) alongside D-176: it applies
 * the SAME model judgements already spent on, scored under v3 instead of
 * whatever ruleset judged them last, and writes the result onto the proposal
 * files. It makes no model call and spends nothing — a judgement is a fact
 * about a claim, not about a ruleset, and re-scoring it under a new rule is a
 * pure function of data already paid for (D-165: v3's deterministic checks are
 * byte-identical to v2's).
 *
 * TWO SOURCES OF A JUDGEMENT, because the queue and the answers file don't
 * overlap:
 *   (a) A proposal already `held_non_transferable` carries its own stored
 *       verdict (v1 or v2) — the model's VARIABLE judgement lives in that
 *       verdict's `variable` check (identified_lever, reason). No answers file
 *       needed; the judgement was already paid for and is already on disk.
 *   (b) A `pending` proposal carries no verdict — its judgement, if any, comes
 *       from a captured probe answers file (see transferability-probe.ts).
 *
 * TRANSITIONS (D-176 Step 4's table):
 *   held_non_transferable, v3 admits    -> pending, hold_reason null
 *   held_non_transferable, v3 refuses   -> unchanged (still held; verdict updated)
 *   pending,                v3 admits    -> unchanged (still pending)
 *   pending,                v3 refuses   -> unchanged status — verdict attached,
 *                                           NOT held. Creating a hold on a
 *                                           probe's authority is exactly the
 *                                           capability this tool must not have;
 *                                           releasing one restores an owner's
 *                                           choice, which is asymmetric on
 *                                           purpose.
 *   approved/rejected/edited            -> untouched, always
 *   no judgement available (11 unjudged, or a pending proposal the answers
 *   file never covered)                 -> untouched, always
 *
 * Every written verdict is produced by judgeTransferabilityV3 — the exact
 * function replayTransferability expects — so a written proposal replays clean
 * by construction; `npm run validate` is still the check that proves it.
 *
 * Usage:
 *   npm run apply-transferability -- dry-run [answers=<path>]
 *   npm run apply-transferability -- apply   [answers=<path>]
 *
 * answers= defaults to transferability-answers.json at the repo root (the
 * probe's own capture location). dry-run prints every transition and writes
 * nothing; apply writes proposal files and nothing else — no effects/, no
 * registry, no ledger, no manifest.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Proposal, TransferabilityCheck, VariableJudgement } from "../lib/types";
import { judgeTransferabilityV3, transferabilityClaimOfProposal } from "../lib/transferability";

const ROOT = join(__dirname, "..");
const DEFAULT_ANSWERS_FILE = join(ROOT, "transferability-answers.json");
const PROPOSAL_TYPES = ["effect", "realization"] as const;

function option(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
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
      const path = join("proposals", type, name);
      loaded.push({ path, proposal: JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Proposal });
    }
  }
  return loaded;
}

interface StoredAnswer {
  proposal_id: string;
  judgement: { transferable: boolean; lever: string | null; reason: string } | null;
  checks: { check: string; outcome: string; reason: string; identified_lever?: string | null }[];
}

function loadAnswers(path: string): Map<string, VariableJudgement> {
  if (!existsSync(path)) {
    throw new Error(`no answers file at ${path} — pass answers=<path> or run the probe first`);
  }
  const file = JSON.parse(readFileSync(path, "utf8")) as { answers: StoredAnswer[] };
  const map = new Map<string, VariableJudgement>();
  for (const answer of file.answers) {
    if (!answer.judgement) continue; // the unjudged stay unjudged
    map.set(answer.proposal_id, answer.judgement);
  }
  return map;
}

/**
 * The VARIABLE judgement a proposal's OWN stored verdict already carries.
 * Only v2+ verdicts store `identified_lever`; a v1 verdict cannot be re-scored
 * this way and is reported as such rather than silently skipped.
 */
function judgementFromStoredVerdict(proposal: Proposal): VariableJudgement | "v1_no_lever" | null {
  const verdict = proposal.transferability;
  if (!verdict) return null;
  const variable = verdict.checks.find((c) => c.check === "variable");
  if (!variable) return null;
  if (verdict.ruleset_version === 1) return "v1_no_lever";
  return {
    transferable: variable.outcome === "pass",
    lever: variable.identified_lever ?? null,
    reason: variable.reason,
  };
}

interface Transition {
  path: string;
  id: string;
  target: string;
  source: "stored_verdict" | "answers_file";
  beforeStatus: string;
  afterStatus: string;
  transferable: boolean;
  modifiers: TransferabilityCheck[];
}

function computeTransitions(
  loaded: LoadedProposal[],
  answers: Map<string, VariableJudgement>,
): { transitions: Transition[]; skippedNoJudgement: number; skippedV1: number; skippedOther: number } {
  const transitions: Transition[] = [];
  let skippedNoJudgement = 0;
  let skippedV1 = 0;
  let skippedOther = 0;

  for (const { path, proposal } of loaded) {
    if (proposal.type !== "effect") continue;
    if (proposal.status !== "pending" && proposal.status !== "held_non_transferable") {
      continue; // approved/rejected/edited/held_low_confidence: untouched, always
    }

    let judgement: VariableJudgement | null = null;
    let source: Transition["source"] = "answers_file";
    if (proposal.status === "held_non_transferable") {
      const fromStored = judgementFromStoredVerdict(proposal);
      if (fromStored === "v1_no_lever") {
        skippedV1 += 1;
        continue;
      }
      judgement = fromStored;
      source = "stored_verdict";
    } else {
      judgement = answers.get(proposal.id) ?? null;
    }

    if (!judgement) {
      skippedNoJudgement += 1;
      continue;
    }

    const claim = transferabilityClaimOfProposal(proposal);
    if (!claim) {
      skippedOther += 1;
      continue;
    }
    const verdict = judgeTransferabilityV3(claim, judgement);

    const afterStatus =
      proposal.status === "held_non_transferable" && verdict.transferable ? "pending" : proposal.status;

    transitions.push({
      path,
      id: proposal.id,
      target: proposal.target,
      source,
      beforeStatus: proposal.status,
      afterStatus,
      transferable: verdict.transferable,
      modifiers: verdict.modifiers_flagged ?? [],
    });
  }

  return { transitions, skippedNoJudgement, skippedV1, skippedOther };
}

function applyTransitions(
  loaded: LoadedProposal[],
  transitions: Transition[],
  answers: Map<string, VariableJudgement>,
): void {
  const byPath = new Map(loaded.map((entry) => [entry.path, entry.proposal]));
  for (const transition of transitions) {
    const proposal = byPath.get(transition.path);
    if (!proposal) continue;
    const claim = transferabilityClaimOfProposal(proposal)!;
    // The judgement is re-fetched from its ORIGINAL source rather than carried
    // on the transition record, so the verdict written here is produced by the
    // exact same judgeTransferabilityV3 call computeTransitions already made —
    // no second hand-assembly step that could drift from what was reported.
    const judgement =
      transition.source === "stored_verdict"
        ? (judgementFromStoredVerdict(proposal) as VariableJudgement)
        : (answers.get(proposal.id) as VariableJudgement);
    const verdict = judgeTransferabilityV3(claim, judgement);
    (proposal as unknown as { transferability: typeof verdict }).transferability = verdict;
    delete (proposal as { verdict_unavailable?: unknown }).verdict_unavailable;
    if (transition.beforeStatus === "held_non_transferable" && transition.afterStatus === "pending") {
      (proposal as { status: string }).status = "pending";
      (proposal as { hold_reason: string | null }).hold_reason = null;
    }
    writeFileSync(join(ROOT, transition.path), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  }
}

function main(): void {
  const command = process.argv[2];
  if (command !== "dry-run" && command !== "apply") {
    throw new Error("usage: npm run apply-transferability -- dry-run|apply [answers=<path>]");
  }
  const answersPath = option("answers") ?? DEFAULT_ANSWERS_FILE;
  const answers = loadAnswers(answersPath);
  const loaded = loadProposals();
  const { transitions, skippedNoJudgement, skippedV1, skippedOther } = computeTransitions(loaded, answers);

  const pad = (v: unknown, n: number): string => String(v).padEnd(n);
  console.log(`${command === "dry-run" ? "DRY RUN — nothing will be written" : "APPLYING"}`);
  console.log(`answers file: ${answersPath}\n`);
  console.log(
    `${pad("mechanism", 10)}${pad("id", 58)}${pad("source", 16)}${pad("before", 20)}${pad("after", 10)}${pad("v3", 8)}modifiers`,
  );
  const heldToPending = transitions.filter(
    (t) => t.beforeStatus === "held_non_transferable" && t.afterStatus === "pending",
  );
  const heldStaysHeld = transitions.filter(
    (t) => t.beforeStatus === "held_non_transferable" && t.afterStatus === "held_non_transferable",
  );
  const pendingAdmitted = transitions.filter((t) => t.beforeStatus === "pending" && t.transferable);
  const pendingRefused = transitions.filter((t) => t.beforeStatus === "pending" && !t.transferable);
  for (const t of transitions) {
    console.log(
      pad(t.target, 10) +
        pad(t.id, 58) +
        pad(t.source, 16) +
        pad(t.beforeStatus, 20) +
        pad(t.afterStatus, 10) +
        pad(t.transferable, 8) +
        (t.modifiers.join(",") || "-"),
    );
  }
  console.log("-".repeat(120));
  console.log(`held_non_transferable -> pending (v3 admits):        ${heldToPending.length}`);
  console.log(`held_non_transferable stays held (v3 still refuses): ${heldStaysHeld.length}`);
  console.log(`pending, verdict attached, transferable:             ${pendingAdmitted.length}`);
  console.log(`pending, verdict attached, NOT held (v3 refuses):    ${pendingRefused.length}`);
  console.log(`skipped — no judgement available:                    ${skippedNoJudgement}`);
  console.log(`skipped — held under v1, carries no lever to rescore: ${skippedV1}`);
  console.log(`skipped — not a judgeable claim:                     ${skippedOther}`);
  console.log(`TOTAL transitions:                                   ${transitions.length}`);

  if (command === "apply") {
    applyTransitions(loaded, transitions, answers);
    console.log(`\n${transitions.length} proposal file(s) written.`);
  }
}

main();

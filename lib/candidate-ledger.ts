/**
 * lib/candidate-ledger.ts — the candidate conservation invariant (D-132).
 *
 * Every candidate an extraction run produces must end somewhere the ledger can
 * name. Stated as one line:
 *
 *   candidates_in == proposals_out + merged + dropped_by_named_reason
 *
 * and stated as code in four staged equations, because the pipeline is a funnel
 * and a single line over `candidates` would be summing two different
 * populations. The cheap pass reads the corpus and emits candidates; synthesis
 * consolidates those into composed candidates; the strong pass turns each of
 * those into a proposal or a named refusal.
 *
 * A run that fails any equation is BROKEN, not partial. The distinction is the
 * point of the entry: a partial run did less than its scope and reports that
 * honestly, while a run whose ledger does not balance cannot say what it did,
 * so every number it reports is unsound.
 *
 * Pure by construction — no fs, no side effects — so tools/validate.ts,
 * tools/extract.ts and the /ops reader all check the same arithmetic.
 */

import type {
  CandidateFate,
  CandidateLedgerEntry,
  CandidateLedgerRun,
} from "./types";

/**
 * Which stage's totals a fate is counted against. "either" is the grounding
 * gate, which both passes run, so its stage comes from the candidate's pass.
 */
const FATE_STAGE: Record<CandidateFate, "cheap" | "strong" | "either"> = {
  into_synthesis: "cheap",
  synthesis_batch_failed: "cheap",
  dropped_ungrounded: "either",
  proposed: "strong",
  proposed_enrich: "strong",
  merged_into_pending: "strong",
  held_low_confidence: "strong",
  failed_validation: "strong",
  dropped_volume_cap: "strong",
  dropped_draft_cap: "strong",
};

export function stageOfFate(entry: CandidateLedgerEntry): "cheap" | "strong" {
  const stage = FATE_STAGE[entry.fate];
  return stage === "either" ? entry.pass : stage;
}

/**
 * Every way this run's accounting fails to close, as human-readable lines.
 * Empty means the ledger balances.
 *
 * A `null` stage is a stage whose numbers are unknown, and an equation reading
 * one is skipped rather than defaulted to zero. Defaulting is what a checker
 * does when it would rather pass than say it does not know, and it would let
 * every pre-D-105 run report a balanced cheap pass it never counted.
 */
export function checkLedgerBalance(run: CandidateLedgerRun): string[] {
  const violations: string[] = [];
  const { cheap, synthesis, strong } = run;
  const equal = (
    label: string,
    left: number,
    leftExpr: string,
    right: number,
    rightExpr: string,
  ): void => {
    if (left !== right) {
      violations.push(
        `${label}: ${leftExpr} = ${left} but ${rightExpr} = ${right} (off by ${left - right})`,
      );
    }
  };

  // A run that recorded its own ledger knows all of it, by construction. An
  // unknown stage there is a bug in the recording, not a fact about the past.
  if (
    run.reconstruction.status === "recorded" &&
    (cheap === null || synthesis === null || strong === null || run.candidates === null)
  ) {
    violations.push(
      "a run that recorded its own ledger cannot leave a stage unknown",
    );
  }

  // E1 — the reported total is the two passes summed. `candidates` has always
  // been a sum of stages rather than a population (D-105 split it but left the
  // total in place), so this equation says only that the split is consistent.
  if (run.candidates !== null && cheap && strong) {
    equal(
      "total",
      run.candidates,
      "candidates",
      cheap.candidates + strong.candidates,
      "candidates_cheap + candidates_strong",
    );
  }

  // E2 — the cheap pass. Every candidate the extractor produced was either
  // refused at the gate, lost with the synthesis call that failed, or handed to
  // a synthesis call that returned.
  if (cheap) {
    equal(
      "cheap stage",
      cheap.candidates,
      "candidates_cheap",
      cheap.dropped_ungrounded +
        cheap.synthesis_batch_failed +
        cheap.into_synthesis,
      "dropped_ungrounded_cheap + synthesis_batch_failed + into_synthesis",
    );
  }

  // E3 — the cheap-to-strong stage, and the one that had no counter at all.
  // Synthesis may legitimately fold several candidates into one; the fold is
  // recorded as `consolidated` rather than evaporating between two totals.
  if (synthesis) {
    equal(
      "synthesis stage",
      synthesis.into_synthesis + synthesis.expanded,
      "into_synthesis + expanded",
      synthesis.consolidated + synthesis.candidates_strong,
      "consolidated + candidates_strong",
    );
    if (cheap && synthesis.into_synthesis !== cheap.into_synthesis) {
      violations.push(
        `synthesis stage: into_synthesis disagrees between the cheap stage (${cheap.into_synthesis}) and the synthesis stage (${synthesis.into_synthesis})`,
      );
    }
    if (strong && synthesis.candidates_strong !== strong.candidates) {
      violations.push(
        `synthesis stage: candidates_strong disagrees between the synthesis stage (${synthesis.candidates_strong}) and the strong stage (${strong.candidates})`,
      );
    }
    if (synthesis.consolidated > 0 && synthesis.expanded > 0) {
      violations.push(
        "synthesis stage: consolidated and expanded are both non-zero for the same run — one of the two is absorbing the other's error",
      );
    }
  }

  // E4 — the strong pass. These fates partition it: each composed candidate is
  // written, absorbed, held, or refused for a named reason.
  if (strong) {
    equal(
      "strong stage",
      strong.candidates,
      "candidates_strong",
      strong.proposed +
        strong.proposed_enrich +
        strong.merged_into_pending +
        strong.held_low_confidence +
        strong.failed_validation +
        strong.dropped_ungrounded +
        strong.dropped_volume_cap +
        strong.dropped_draft_cap,
      "proposed + proposed_enrich + merged_into_pending + held_low_confidence + failed_validation + dropped_ungrounded_strong + dropped_volume_cap + dropped_draft_cap",
    );
  }

  for (const value of [
    run.candidates,
    ...(cheap
      ? [
          cheap.candidates,
          cheap.dropped_ungrounded,
          cheap.synthesis_batch_failed,
          cheap.into_synthesis,
        ]
      : []),
    ...(synthesis ? [synthesis.consolidated, synthesis.expanded] : []),
    ...(strong
      ? [
          strong.candidates,
          strong.proposed,
          strong.proposed_enrich,
          strong.merged_into_pending,
          strong.held_low_confidence,
          strong.failed_validation,
          strong.dropped_ungrounded,
          strong.dropped_volume_cap,
          strong.dropped_draft_cap,
        ]
      : []),
  ]) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      violations.push(`counter ${value} is not a non-negative integer`);
      break;
    }
  }

  for (const entry of run.candidates_detail) {
    const stage = FATE_STAGE[entry.fate];
    if (stage !== "either" && stage !== entry.pass) {
      violations.push(
        `${entry.candidate_id}: fate ${entry.fate} is reachable only by the ${stage} pass`,
      );
    }
    if (entry.fate === "dropped_ungrounded" && !entry.reason) {
      violations.push(
        `${entry.candidate_id}: dropped_ungrounded with no named reason`,
      );
    }
    if (
      (entry.fate === "merged_into_pending" ||
        entry.fate === "proposed_enrich") &&
      !entry.attribution
    ) {
      violations.push(
        `${entry.candidate_id}: ${entry.fate} without an attribution for its merge target`,
      );
    }
  }

  return violations;
}

/**
 * Per-candidate detail must agree with the totals it claims to detail.
 *
 * Enforced for `recorded` and `reconstructed`, both of which claim a complete
 * account. Split from the balance check because a `partial` reconstruction has
 * fewer detail rows than candidates ON PURPOSE — the lineage is gone and the
 * entry says so — and inventing rows to make the count work would be the
 * dishonesty this whole invariant exists to prevent.
 */
export function checkLedgerDetail(run: CandidateLedgerRun): string[] {
  const complete =
    run.reconstruction.status === "recorded" ||
    run.reconstruction.status === "reconstructed";
  if (!complete) return [];
  const violations: string[] = [];
  const counted = { cheap: 0, strong: 0 };
  for (const entry of run.candidates_detail) counted[stageOfFate(entry)] += 1;
  if (run.cheap && counted.cheap !== run.cheap.candidates) {
    violations.push(
      `cheap detail rows (${counted.cheap}) do not match candidates_cheap (${run.cheap.candidates})`,
    );
  }
  if (run.strong && counted.strong !== run.strong.candidates) {
    violations.push(
      `strong detail rows (${counted.strong}) do not match candidates_strong (${run.strong.candidates})`,
    );
  }
  return violations;
}

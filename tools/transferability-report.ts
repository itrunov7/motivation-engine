/**
 * tools/transferability-report.ts — read the transferability rules' verdicts,
 * and replay the stored ones (D-160).
 *
 * No LLM, no network, no writes. The rules read only the claim — fact,
 * boundary, source title — all of which a proposal file already carries, so
 * every verdict this pipeline has ever reached stays re-derivable offline from
 * the repository alone, with no corpus and no API key.
 *
 * Two subcommands, one purpose each:
 *
 *   report — what would the rules say about these proposals, and WHY. Prints
 *            the reason strings, not counts: an agreement rate cannot show a
 *            verdict reached for the right answer by the wrong route.
 *   replay — do the stored verdicts still hold under today's rules? A stored
 *            verdict that no longer replays is drift, and drift that nobody
 *            names is how a filter quietly becomes a different filter.
 *
 * Usage (from repo root):
 *   npm run transferability-report -- target=CL-14
 *   npm run transferability-report -- target=CL-14 status=pending
 *   npm run transferability-report -- id=effect-cl-14-memory-drift-7e627a94664c
 *   npm run replay-transferability
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Proposal } from "../lib/types";
import {
  describeTransferability,
  judgeTransferability,
  transferabilityClaimOfProposal,
  transferabilityDrift,
  TRANSFERABILITY_RULESET_VERSION,
} from "../lib/transferability";
import { PROPOSAL_TYPES } from "../lib/proposals";

const ROOT = join(__dirname, "..");

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

function report(): void {
  const target = option("target");
  const status = option("status");
  const id = option("id");

  const selected = loadProposals().filter(({ proposal }) => {
    if (target && proposal.target !== target) return false;
    if (status && proposal.status !== status) return false;
    if (id && proposal.id !== id) return false;
    return transferabilityClaimOfProposal(proposal) !== null;
  });

  console.log(
    `Transferability report — ruleset v${TRANSFERABILITY_RULESET_VERSION}, ` +
      `${selected.length} judgeable proposal(s)` +
      `${target ? ` in ${target}` : ""}${status ? ` with status ${status}` : ""}.`,
  );
  console.log("Read-only: nothing below was written, held, or decided.\n");

  let transferable = 0;
  let escalated = 0;
  for (const { path, proposal } of selected) {
    const claim = transferabilityClaimOfProposal(proposal);
    if (!claim) continue;
    const verdict = judgeTransferability(claim);
    if (verdict.transferable) transferable += 1;
    if (verdict.escalated_by_warning_pair) escalated += 1;

    console.log(`${proposal.id}  [${proposal.status}]`);
    console.log(`  verdict : ${describeTransferability(verdict)}`);
    console.log(`  fact    : ${oneLine(claim.fact)}`);
    console.log(`  source  : ${oneLine(claim.source_title, 160)}`);
    for (const check of verdict.checks) {
      const marker = check.outcome === "fail" ? "✗" : check.outcome === "warn" ? "!" : "·";
      console.log(`  ${marker} ${check.check.padEnd(10)} ${check.reason}`);
    }
    console.log(`  file    : ${path}\n`);
  }

  console.log(
    `${transferable} of ${selected.length} transferable; ` +
      `${selected.length - transferable} not, of which ${escalated} turned on the ` +
      "subject+population warning pair rather than an outright refusal.",
  );
}

function replay(): void {
  const stored = loadProposals().filter(({ proposal }) => proposal.transferability);
  console.log(
    `Replaying ${stored.length} stored verdict(s) against ruleset v${TRANSFERABILITY_RULESET_VERSION}.`,
  );
  let drifted = 0;
  for (const { path, proposal } of stored) {
    const claim = transferabilityClaimOfProposal(proposal);
    if (!claim) {
      console.log(`  ✗ ${path}: carries a verdict but is not a judgeable claim`);
      drifted += 1;
      continue;
    }
    const drift = transferabilityDrift(
      proposal.transferability!,
      judgeTransferability(claim),
    );
    if (drift) {
      console.log(`  ✗ ${path}: ${drift}`);
      drifted += 1;
    }
  }
  if (stored.length === 0) {
    console.log(
      "  No stored verdicts yet — the pass writes them from the next extraction run on.",
    );
  } else if (drifted === 0) {
    console.log("  OK — every stored verdict still replays to itself.");
  }
  if (drifted > 0) process.exitCode = 1;
}

const command = process.argv[2];
if (command === "replay") replay();
else if (command === "report" || command === undefined) report();
else {
  console.error(
    "Usage:\n" +
      "  npm run transferability-report -- [target=CL-14] [status=pending] [id=...]\n" +
      "  npm run replay-transferability",
  );
  process.exitCode = 1;
}

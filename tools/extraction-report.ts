/**
 * tools/extraction-report.ts — read-only reader of a batch of extraction runs.
 *
 * Prints and writes nothing. Every number comes from an already-committed
 * artifact, so the report is a reading of the record rather than a second,
 * differently-derived account of it:
 *
 * - corpora/extraction/manifest.json  the per-run funnel and spend
 * - corpora/extraction/ledger.json    per-candidate fates (D-132)
 * - corpora/extraction/rejected/*.json  the full refusal per dropped candidate (D-104)
 * - proposals/{type}/*.json           what reached the queue
 *
 * A batch is selected by dispatch_id prefix, which is how a sweep identifies
 * itself: `npm run extraction-report -- effects-wide-` reads exactly the runs
 * dispatched with that prefix and nothing else.
 *
 * Two distributions are reported that no single-mechanism run could establish:
 * span_role outcomes across every candidate, and triage flags across every
 * resulting proposal. The second is bounded by what the flags can see —
 * computeProposalFlags raises OVERREACH for effect proposals, while DUPLICATE
 * and WEAK ANCHOR are realization-only checks (D-147), so an effects-only batch
 * reports those two as zero BY CONSTRUCTION and the report says so rather than
 * presenting three measured zeros.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLedgerBalance, checkLedgerDetail } from "../lib/candidate-ledger";
import { computeProposalFlags, type FlagKind } from "../lib/review-flags";
import type {
  CandidateLedgerFile,
  CandidateLedgerRun,
  CorpusManifest,
  CorpusManifestRun,
  Proposal,
  RejectedCandidateFile,
  UngroundedDropReason,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const MANIFEST = join(ROOT, "corpora", "extraction", "manifest.json");
const LEDGER = join(ROOT, "corpora", "extraction", "ledger.json");
const REJECTED_DIR = join(ROOT, "corpora", "extraction", "rejected");
const PROPOSALS_DIR = join(ROOT, "proposals");

/** The role checks, separated from the grounding checks they sit beside (D-129). */
const SPAN_ROLE_REASONS: UngroundedDropReason[] = [
  "span_role_missing",
  "span_role_not_finding",
  "span_role_contradicted_by_structure",
  "premise_contradicted_downstream",
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function num(params: Record<string, string>, key: string): number {
  const raw = params[key];
  return raw === undefined ? 0 : Number(raw);
}

/** "quote_not_in_source=2 doi_unresolved=1" as written into the manifest. */
function parseReasonField(value: string | undefined): Record<string, number> {
  if (!value) return {};
  const out: Record<string, number> = {};
  for (const pair of value.trim().split(/\s+/)) {
    const at = pair.lastIndexOf("=");
    if (at <= 0) continue;
    out[pair.slice(0, at)] = Number(pair.slice(at + 1));
  }
  return out;
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function bump(counter: Record<string, number>, key: string, by = 1): void {
  counter[key] = (counter[key] ?? 0) + by;
}

function listProposals(): { path: string; proposal: Proposal }[] {
  if (!existsSync(PROPOSALS_DIR)) return [];
  const out: { path: string; proposal: Proposal }[] = [];
  for (const type of readdirSync(PROPOSALS_DIR, { withFileTypes: true })) {
    if (!type.isDirectory()) continue;
    const dir = join(PROPOSALS_DIR, type.name);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      out.push({
        path: join(dir, file),
        proposal: readJson<Proposal>(join(dir, file)),
      });
    }
  }
  return out;
}

function main(): void {
  const prefix = process.argv[2] ?? "effects-wide-";
  const manifest = readJson<CorpusManifest>(MANIFEST);
  const ledger = existsSync(LEDGER)
    ? readJson<CandidateLedgerFile>(LEDGER)
    : { schema_version: 1 as const, updated_at: "", runs: [] };

  const runs = (manifest.run_history ?? []).filter((run) =>
    (run.dispatch_id ?? "").startsWith(prefix),
  );
  if (runs.length === 0) {
    console.log(`No runs found with dispatch_id prefix "${prefix}".`);
    return;
  }
  runs.sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  const ledgerByRun = new Map<string, CandidateLedgerRun>(
    ledger.runs.map((run) => [run.run_id, run]),
  );
  const rejectedByRun = new Map<string, RejectedCandidateFile>();
  if (existsSync(REJECTED_DIR)) {
    for (const file of readdirSync(REJECTED_DIR)) {
      if (!file.endsWith(".json")) continue;
      const parsed = readJson<RejectedCandidateFile>(join(REJECTED_DIR, file));
      rejectedByRun.set(parsed.run_id, parsed);
    }
  }

  console.log(`\nEXTRACTION BATCH — dispatch_id prefix "${prefix}"`);
  console.log(`${runs.length} runs, ${runs[0].timestamp} to ${runs[runs.length - 1].timestamp}\n`);

  // ---------- per mechanism ----------
  console.log("PER MECHANISM");
  console.log(
    [
      pad("mech", 7),
      pad("status", 8),
      pad("elig", 6),
      pad("sel", 6),
      pad("trunc", 6),
      pad("unread", 7),
      pad("cand", 6),
      pad("prop", 6),
      pad("enrich", 7),
      pad("merged", 7),
      pad("held", 5),
      pad("ungr", 5),
      pad("vcap", 5),
      pad("ledger", 10),
      pad("usd", 9),
    ].join(""),
  );

  const totals: Record<string, number> = {};
  const dropReasons: Record<string, number> = {};
  const unbalanced: string[] = [];
  const missingLedger: string[] = [];
  let usd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let calls = 0;

  for (const run of runs as CorpusManifestRun[]) {
    const params = run.params ?? {};
    const mech = params.mechanism ?? params.scope ?? "?";
    const entry = ledgerByRun.get(run.timestamp);
    let ledgerCell = "absent";
    if (!entry) {
      missingLedger.push(mech);
    } else {
      const violations = [
        ...checkLedgerBalance(entry),
        ...checkLedgerDetail(entry),
      ];
      ledgerCell = violations.length === 0 ? "balanced" : "BROKEN";
      if (violations.length > 0) {
        unbalanced.push(`${mech}: ${violations.join("; ")}`);
      }
      for (const detail of entry.candidates_detail) {
        if (detail.reason) bump(dropReasons, `${detail.pass}:${detail.reason}`);
      }
    }

    const cells = {
      elig: num(params, "records_eligible"),
      sel: num(params, "records_selected"),
      trunc: num(params, "records_dropped_truncation"),
      unread: num(params, "records_remaining"),
      cand: num(params, "candidates"),
      prop: num(params, "proposed"),
      enrich: num(params, "proposed_enrich"),
      merged: num(params, "merged_into_pending"),
      held: num(params, "held_low_confidence"),
      ungr: num(params, "dropped_ungrounded"),
      vcap: num(params, "dropped_volume_cap"),
      // Carried for the aggregate equations below, not for the table.
      cand_cheap: num(params, "candidates_cheap"),
      cand_strong: num(params, "candidates_strong"),
      ungr_cheap: num(params, "dropped_ungrounded_cheap"),
      ungr_strong: num(params, "dropped_ungrounded_strong"),
      synth_failed: num(params, "cheap_synthesis_failed"),
      into_synth: num(params, "into_synthesis"),
      consolidated: num(params, "consolidated_by_synthesis"),
      expanded: num(params, "expanded_by_synthesis"),
      failed_validation: num(params, "failed_validation"),
      draft_cap: num(params, "dropped_draft_cap"),
    };
    for (const [key, value] of Object.entries(cells)) bump(totals, key, value);
    usd += run.cost?.estimated_usd ?? 0;
    tokensIn += run.cost?.tokens_in ?? 0;
    tokensOut += run.cost?.tokens_out ?? 0;
    calls += run.cost?.api_calls ?? 0;

    console.log(
      [
        pad(mech, 7),
        pad(run.status, 8),
        pad(cells.elig, 6),
        pad(cells.sel, 6),
        pad(cells.trunc, 6),
        pad(cells.unread, 7),
        pad(cells.cand, 6),
        pad(cells.prop, 6),
        pad(cells.enrich, 7),
        pad(cells.merged, 7),
        pad(cells.held, 5),
        pad(cells.ungr, 5),
        pad(cells.vcap, 5),
        pad(ledgerCell, 10),
        pad(`$${(run.cost?.estimated_usd ?? 0).toFixed(4)}`, 9),
      ].join(""),
    );
  }

  console.log("-".repeat(96));
  console.log(
    [
      pad("TOTAL", 16),
      pad(totals.elig ?? 0, 6),
      pad(totals.sel ?? 0, 6),
      pad(totals.trunc ?? 0, 6),
      pad(totals.unread ?? 0, 7),
      pad(totals.cand ?? 0, 6),
      pad(totals.prop ?? 0, 6),
      pad(totals.enrich ?? 0, 7),
      pad(totals.merged ?? 0, 7),
      pad(totals.held ?? 0, 5),
      pad(totals.ungr ?? 0, 5),
      pad(totals.vcap ?? 0, 5),
      pad("", 10),
      pad(`$${usd.toFixed(4)}`, 9),
    ].join(""),
  );
  console.log(
    `spend: ${calls} API calls, ${tokensIn.toLocaleString()} tokens in + ` +
      `${tokensOut.toLocaleString()} out, $${usd.toFixed(4)}`,
  );

  // ---------- candidate conservation (D-132) ----------
  // The same four staged equations lib/candidate-ledger.ts checks per run,
  // summed over the batch, and summed from the LEDGER rather than from the
  // manifest's summary params. The ledger is the authoritative record of
  // candidate fates; the manifest params are a display summary, and at least one
  // of them (failed_validation) counts a population the equations do not — see
  // the divergence line below.
  console.log("\nCANDIDATE CONSERVATION (D-132)");
  const ledgerTotals: Record<string, number> = {};
  for (const run of runs) {
    const entry = ledgerByRun.get(run.timestamp);
    if (!entry) continue;
    bump(ledgerTotals, "candidates", entry.candidates ?? 0);
    if (entry.cheap) {
      bump(ledgerTotals, "cand_cheap", entry.cheap.candidates);
      bump(ledgerTotals, "ungr_cheap", entry.cheap.dropped_ungrounded);
      bump(ledgerTotals, "synth_failed", entry.cheap.synthesis_batch_failed);
      bump(ledgerTotals, "into_synth", entry.cheap.into_synthesis);
    }
    if (entry.synthesis) {
      bump(ledgerTotals, "consolidated", entry.synthesis.consolidated);
      bump(ledgerTotals, "expanded", entry.synthesis.expanded);
    }
    if (entry.strong) {
      bump(ledgerTotals, "cand_strong", entry.strong.candidates);
      bump(ledgerTotals, "prop", entry.strong.proposed);
      bump(ledgerTotals, "enrich", entry.strong.proposed_enrich);
      bump(ledgerTotals, "merged", entry.strong.merged_into_pending);
      bump(ledgerTotals, "held", entry.strong.held_low_confidence);
      bump(ledgerTotals, "failed_validation", entry.strong.failed_validation);
      bump(ledgerTotals, "ungr_strong", entry.strong.dropped_ungrounded);
      bump(ledgerTotals, "vcap", entry.strong.dropped_volume_cap);
      bump(ledgerTotals, "draft_cap", entry.strong.dropped_draft_cap);
    }
  }
  const get = (key: string): number => ledgerTotals[key] ?? 0;
  const equations: [string, number, string, number, string][] = [
    [
      "E1 total",
      get("candidates"),
      "candidates",
      get("cand_cheap") + get("cand_strong"),
      "candidates_cheap + candidates_strong",
    ],
    [
      "E2 cheap",
      get("cand_cheap"),
      "candidates_cheap",
      get("ungr_cheap") + get("synth_failed") + get("into_synth"),
      "dropped_ungrounded_cheap + synthesis_batch_failed + into_synthesis",
    ],
    [
      "E3 synthesis",
      get("into_synth") + get("expanded"),
      "into_synthesis + expanded",
      get("consolidated") + get("cand_strong"),
      "consolidated + candidates_strong",
    ],
    [
      "E4 strong",
      get("cand_strong"),
      "candidates_strong",
      get("prop") +
        get("enrich") +
        get("merged") +
        get("held") +
        get("failed_validation") +
        get("ungr_strong") +
        get("vcap") +
        get("draft_cap"),
      "proposed + proposed_enrich + merged_into_pending + held_low_confidence + failed_validation + dropped_ungrounded_strong + dropped_volume_cap + dropped_draft_cap",
    ],
  ];
  for (const [label, left, leftExpr, right, rightExpr] of equations) {
    const verdict = left === right ? "OK      " : `OFF BY ${left - right}`;
    console.log(`  ${pad(label, 14)}${verdict}  ${leftExpr} = ${left} == ${right} = ${rightExpr}`);
  }
  console.log(
    `  ledgers: ${runs.length - unbalanced.length - missingLedger.length} balanced, ` +
      `${unbalanced.length} broken, ${missingLedger.length} absent`,
  );
  // A manifest counter that disagrees with the ledger is reported, never
  // reconciled silently: stats.failed_validation is incremented BOTH by a
  // malformed model response (recordFailedBatch — a batch of records, no
  // candidate exists) and by a proposal-schema refusal of a composed candidate
  // (the only one that is a candidate fate). The ledger counts only the second.
  const manifestFailed = totals.failed_validation ?? 0;
  const ledgerFailed = get("failed_validation");
  if (manifestFailed !== ledgerFailed) {
    console.log(
      `  NOTE: manifest failed_validation ${manifestFailed} vs ledger ` +
        `${ledgerFailed} — the difference (${manifestFailed - ledgerFailed}) is ` +
        `malformed model RESPONSES, which fail a batch without producing a\n` +
        `  candidate, so they are correctly absent from the equations. Their cost ` +
        `is the unread column: those records return to the pool for a later run.`,
    );
  }
  for (const line of unbalanced) console.log(`  BROKEN ${line}`);
  if (missingLedger.length > 0) {
    console.log(`  absent for: ${missingLedger.join(", ")}`);
  }

  // ---------- span_role distribution ----------
  console.log("\nSPAN_ROLE OUTCOMES ACROSS ALL CANDIDATES (D-129)");
  const rejectedRoleTotals: Record<string, number> = {};
  let rejectedRows = 0;
  for (const run of runs) {
    const rejected = rejectedByRun.get(run.timestamp);
    if (!rejected) continue;
    for (const record of rejected.rejected) {
      rejectedRows += 1;
      bump(rejectedRoleTotals, `${record.pass}:${record.reason}`);
    }
  }
  const source =
    rejectedRows >= Object.values(dropReasons).reduce((a, b) => a + b, 0)
      ? rejectedRoleTotals
      : dropReasons;
  const sourceName = source === rejectedRoleTotals ? "rejected/*.json" : "ledger";
  const roleTotal = SPAN_ROLE_REASONS.reduce(
    (sum, reason) =>
      sum +
      (source[`cheap:${reason}`] ?? 0) +
      (source[`strong:${reason}`] ?? 0),
    0,
  );
  const allDrops = Object.values(source).reduce((a, b) => a + b, 0);
  console.log(`  read from ${sourceName}: ${allDrops} refused candidates in total`);
  console.log(`  ${pad("reason", 42)}${pad("cheap", 7)}${pad("strong", 7)}total`);
  for (const reason of SPAN_ROLE_REASONS) {
    const cheap = source[`cheap:${reason}`] ?? 0;
    const strong = source[`strong:${reason}`] ?? 0;
    console.log(
      `  ${pad(reason, 42)}${pad(cheap, 7)}${pad(strong, 7)}${cheap + strong}`,
    );
  }
  console.log(
    `  span_role refusals ${roleTotal} of ${allDrops} refusals ` +
      `(${allDrops === 0 ? 0 : Math.round((roleTotal / allDrops) * 100)}%)`,
  );
  const otherReasons = Object.entries(source)
    .filter(([key]) => !SPAN_ROLE_REASONS.includes(key.split(":")[1] as UngroundedDropReason))
    .sort((left, right) => right[1] - left[1]);
  if (otherReasons.length > 0) {
    console.log("  other grounding refusals, for context:");
    for (const [key, count] of otherReasons) {
      console.log(`  ${pad(key, 42)}${count}`);
    }
  }

  // ---------- triage flags ----------
  console.log("\nTRIAGE FLAGS ACROSS RESULTING PROPOSALS (D-138/D-139)");
  const runIds = new Set(
    runs
      .map((run) => run.github_run_id)
      .filter((id): id is number => typeof id === "number")
      .map((id) => `extraction:github-actions-${id}`),
  );
  const batchProposals = listProposals().filter(({ proposal }) =>
    runIds.has(proposal.proposed_by ?? ""),
  );
  const flagCounts: Record<FlagKind, number> = {
    overreach: 0,
    duplicate: 0,
    weak_anchor: 0,
  };
  const flaggedProposals: Record<FlagKind, number> = {
    overreach: 0,
    duplicate: 0,
    weak_anchor: 0,
  };
  const byType: Record<string, number> = {};
  let clean = 0;
  for (const { proposal } of batchProposals) {
    bump(byType, proposal.type);
    const flags = computeProposalFlags(proposal, ROOT);
    if (flags.length === 0) {
      clean += 1;
      continue;
    }
    const kinds = new Set<FlagKind>();
    for (const flag of flags) {
      flagCounts[flag.kind] += 1;
      kinds.add(flag.kind);
    }
    for (const kind of Array.from(kinds)) flaggedProposals[kind] += 1;
  }
  console.log(
    `  ${batchProposals.length} proposals attributed to this batch ` +
      `(${Object.entries(byType)
        .map(([type, count]) => `${count} ${type}`)
        .join(", ") || "none"})`,
  );
  console.log(`  ${pad("flag", 14)}${pad("proposals", 11)}occurrences`);
  console.log(
    `  ${pad("OVERREACH", 14)}${pad(flaggedProposals.overreach, 11)}${flagCounts.overreach}`,
  );
  console.log(
    `  ${pad("DUPLICATE", 14)}${pad(flaggedProposals.duplicate, 11)}${flagCounts.duplicate}`,
  );
  console.log(
    `  ${pad("WEAK ANCHOR", 14)}${pad(flaggedProposals.weak_anchor, 11)}${flagCounts.weak_anchor}`,
  );
  console.log(`  ${pad("clean", 14)}${pad(clean, 11)}-`);
  const effectsOnly = Object.keys(byType).every((type) => type === "effect");
  if (effectsOnly && byType.effect) {
    console.log(
      "  NOTE: computeProposalFlags raises OVERREACH for effect proposals only;\n" +
        "  DUPLICATE and WEAK ANCHOR are realization-only checks, so their zeros\n" +
        "  above are structural, not measured (D-147).",
    );
  }
  console.log("");
}

main();

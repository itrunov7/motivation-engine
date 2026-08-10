/**
 * tools/render-review-packet.ts — a markdown review packet for the owner:
 * one section per PENDING effect proposal currently carrying a transferable
 * verdict, grouped by mechanism.
 *
 * Every field is read from an already-committed proposal file or re-derived
 * from a committed evidence corpus record by lib/source-context.ts — nothing
 * here is a new judgement. It exists so a batch of verdicts can be reviewed
 * offline, in one file, without opening 160 proposal JSON files by hand.
 *
 * Not corpus data and not a decision artifact: an ephemeral snapshot of
 * "pending, right now" that goes stale the moment a proposal is decided.
 * Gitignored for that reason (like quote.json, D-025).
 *
 * Usage:
 *   npm run render-review-packet -- [out=<path>]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Effect, KnowledgeProvenanceItem, Proposal } from "../lib/types";
import { computeProposalFlags } from "../lib/review-flags";
import { buildSourceContext, SOURCE_CONTEXT_WINDOW_CHARS } from "../lib/source-context";

const ROOT = join(__dirname, "..");
const DEFAULT_OUT = join(ROOT, "review-packet-v3.md");

const PRIORITY_ORDER = [
  "LA-01",
  "EN-03",
  "SC-06",
  "FR-11",
  "SP-08",
  "ST-09",
  "ID-12",
  "RE-10",
  "CG-05",
  "ZE-07",
  "HA-04",
  "VR-02",
];

function option(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function loadEffectProposals(): Proposal[] {
  const dir = join(ROOT, "proposals", "effect");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Proposal);
}

function mechanismOrder(present: string[]): string[] {
  const remainder = present.filter((m) => !PRIORITY_ORDER.includes(m)).sort();
  return [...PRIORITY_ORDER.filter((m) => present.includes(m)), ...remainder];
}

function renderSpan(item: KnowledgeProvenanceItem): string {
  const ctx = buildSourceContext(item, SOURCE_CONTEXT_WINDOW_CHARS);
  if (!ctx) {
    return "  _(no source_span on this item — nothing to re-slice)_\n";
  }
  if (!ctx.isFullText && ctx.status !== "excerpt") {
    // record_missing / span_stale / span_out_of_range / span_does_not_reslice —
    // surfaced prominently rather than silently falling back to the stored
    // quote_or_locus, exactly as lib/source-context.ts intends.
    return `  **SOURCE CONTEXT UNAVAILABLE (${ctx.status})** — ${ctx.detail ?? ctx.label}\n`;
  }
  const note = ctx.isFullText
    ? "the corpus record is abstract-only (rule 12: whitelisted source APIs never " +
      "return full text), so this is the FULL abstract, not a windowed excerpt — " +
      `there is nothing more to show than what is here`
    : `${SOURCE_CONTEXT_WINDOW_CHARS} characters before/after the span`;
  return (
    `  _${ctx.label} — ${note}_\n\n` +
    "  > " +
    `${ctx.before ?? ""}**[${ctx.span ?? ""}]**${ctx.after ?? ""}`.replace(/\n/g, "\n  > ") +
    "\n"
  );
}

function renderProposal(proposal: Proposal): string {
  const payload = proposal.payload as Effect;
  const verdict = proposal.transferability!;
  const variable = verdict.checks.find((c) => c.check === "variable");
  const flags = computeProposalFlags(proposal, ROOT);

  const lines: string[] = [];
  lines.push(`### ${proposal.id}`);
  lines.push("");
  lines.push(`**Fact:** ${payload.fact}`);
  lines.push("");
  lines.push(`**Grade:** ${payload.grade}`);
  lines.push("");
  lines.push(`**Identified lever (VARIABLE, v${verdict.ruleset_version}):** ${variable?.identified_lever ?? "—"}`);
  if ((verdict.modifiers_flagged ?? []).length > 0) {
    lines.push(
      `**Modifiers flagged (recorded, not refusals):** ${(verdict.modifiers_flagged ?? []).join(", ")}`,
    );
  }
  lines.push("");
  lines.push(
    `**Triage flags:** ${flags.length === 0 ? "clean" : flags.map((f) => `${f.kind.toUpperCase()} — ${f.summary}`).join("; ")}`,
  );
  lines.push("");
  const items = proposal.provenance;
  lines.push(`**Sources (${items.length}):**`);
  lines.push("");
  items.forEach((item, index) => {
    const evidenceItem = item as { doi?: string | null; title?: string; corpus_record_id?: string };
    lines.push(
      `${items.length > 1 ? `${index + 1}. ` : ""}**${evidenceItem.title ?? "(untitled)"}**` +
        (evidenceItem.doi ? ` — DOI: ${evidenceItem.doi}` : " — DOI: none on file"),
    );
    lines.push("");
    lines.push(`  Cited span (verbatim, as stored): "${(item as { quote_or_locus?: string }).quote_or_locus ?? ""}"`);
    lines.push("");
    lines.push(renderSpan(item));
  });
  return lines.join("\n");
}

function main(): void {
  const proposals = loadEffectProposals().filter(
    (p) => p.status === "pending" && p.transferability?.transferable === true,
  );

  const byMechanism = new Map<string, Proposal[]>();
  for (const p of proposals) {
    const list = byMechanism.get(p.target) ?? [];
    list.push(p);
    byMechanism.set(p.target, list);
  }
  const order = mechanismOrder(Array.from(byMechanism.keys()));

  const out: string[] = [];
  out.push("# Transferability review packet — ruleset v3 (D-176)");
  out.push("");
  out.push(
    `${proposals.length} pending effect proposals currently carry a transferable verdict. ` +
      "Grouped by mechanism, priority order first (the conversion and motivational " +
      "mechanisms with zero effects today), remainder alphabetical.",
  );
  out.push("");
  out.push(
    "Every field below is read from the proposal file or re-sliced from its evidence " +
      "corpus record by lib/source-context.ts — nothing here is asserted by this script. " +
      "Grade and fact are the model's own; lever and modifiers are the stored v3 verdict; " +
      "the cited span is RE-SLICED at the stored offsets, not the possibly-stale stored " +
      "quote, exactly as `/review` renders it.",
  );
  out.push("");
  out.push("---");
  out.push("");

  for (const mech of order) {
    const list = (byMechanism.get(mech) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    out.push(`## ${mech} (${list.length})`);
    out.push("");
    for (const proposal of list) {
      out.push(renderProposal(proposal));
      out.push("");
      out.push("---");
      out.push("");
    }
  }

  const outPath = option("out") ?? DEFAULT_OUT;
  writeFileSync(outPath, `${out.join("\n")}\n`, "utf8");
  console.log(`${proposals.length} proposals across ${order.length} mechanisms written to ${outPath}`);
}

main();

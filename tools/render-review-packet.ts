/**
 * tools/render-review-packet.ts — a markdown review packet for the owner:
 * one section per PENDING effect proposal currently carrying a transferable
 * verdict, grouped by mechanism.
 *
 * Every field is read from an already-committed proposal file or re-derived
 * from a committed evidence corpus record by lib/source-context.ts — nothing
 * here is a new judgement. It exists so a batch of verdicts can be reviewed
 * offline, in one file, without opening dozens of proposal JSON files by hand.
 *
 * Not corpus data and not a decision artifact: an ephemeral snapshot of
 * "pending, right now" that goes stale the moment a proposal is decided.
 * Gitignored for that reason (like quote.json, D-025).
 *
 * TWO COMPUTED FIELDS, both read-only previews of a rule that has already been
 * applied once (the 2026-08-10 owner batch), not a new judgement:
 *
 * - MECHANICAL GRADE CAP. There is no computed grading rubric yet (rule 12 /
 *   effects/effect.schema.json's grade_basis description says so explicitly).
 *   Until there is, this is the interim mechanical floor the owner specified:
 *   1 independent source -> C+ max, 2 -> B- max, 3+ -> B max, A band only with
 *   a meta-analysis or replication in the cited set. "Independent source" is
 *   operationalised as the count of DISTINCT DOIs in payload.source (not raw
 *   citation count — a proposal citing one paper twice is still one source).
 *   "Meta-analysis or replication in the cited set" is operationalised as a
 *   case-insensitive match for /meta-analysis|meta analysis|systematic
 *   review|replicat/ against the cited sources' titles — a keyword heuristic,
 *   named as one rather than presented as a judgement.
 *
 * - DOI SIBLINGS. Duplicate detection (lib/review-flags.ts CONCEPT_GROUPS)
 *   runs on realizations only (D-147) — effects have no such check at all.
 *   This lists, for each proposal, every OTHER pending+transferable proposal
 *   targeting the SAME mechanism that cites at least one of the same DOIs, so
 *   the overlap is visible while judging rather than discovered afterwards.
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

const GRADE_ORDER = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];
const META_RE = /meta-analysis|meta analysis|systematic review|replicat/i;

/** The mechanical cap the owner applied in the 2026-08-10 batch. Null = no cap (A band allowed). */
function mechanicalCap(payload: Effect): string | null {
  const sourceCount = new Set(payload.source ?? []).size;
  if (sourceCount <= 1) return "C+";
  if (sourceCount === 2) return "B-";
  const titles = (payload.provenance ?? []).map((item) => ("title" in item ? (item.title ?? "") : "")).join(" | ");
  const hasMeta = META_RE.test(titles) || META_RE.test(payload.fact) || META_RE.test(payload.boundary ?? "");
  return hasMeta ? null : "B";
}

function capLine(payload: Effect): string {
  const cap = mechanicalCap(payload);
  const sourceCount = new Set(payload.source ?? []).size;
  if (!cap) {
    return `**Mechanical cap:** none — ${sourceCount} independent sources with a meta-analysis/replication in the cited set (A band allowed)`;
  }
  // GRADE_ORDER runs best-to-worst (A+ = index 0), so the cap MOVES the grade
  // only when the model's own grade is BETTER (a lower index) than the cap —
  // i.e. the cap would pull it down. Inverted here once already (indexOf(cap)
  // < indexOf(grade)), which silently reported almost every capped A/A-/B+/B
  // proposal as "already at or below the cap" in the packet actually sent —
  // the opposite of the one thing this field exists to expose.
  const moves = GRADE_ORDER.indexOf(payload.grade) < GRADE_ORDER.indexOf(cap);
  return (
    `**Mechanical cap:** ${cap} (${sourceCount} independent source${sourceCount === 1 ? "" : "s"}) — ` +
    `model asserted ${payload.grade}${moves ? `, cap would LOWER it to ${cap}` : ", already at or below the cap"}`
  );
}

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

function renderProposal(proposal: Proposal, siblings: string[]): string {
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
  lines.push(capLine(payload));
  lines.push("");
  if (siblings.length > 0) {
    lines.push(
      `**DOI siblings (same mechanism, shares a source):** ${siblings.join(", ")}`,
    );
    lines.push("");
  }
  lines.push(`**Identified lever (VARIABLE, v${verdict.ruleset_version}):** ${variable?.identified_lever ?? "—"}`);
  if ((verdict.modifiers_flagged ?? []).length > 0) {
    lines.push(
      `**Modifiers flagged (recorded, not refusals):** ${(verdict.modifiers_flagged ?? []).join(", ")}`,
    );
  }
  lines.push("");
  lines.push(
    // f.summary already carries its own "KIND — " prefix (lib/review-flags.ts);
    // prepending f.kind again would print it twice.
    `**Triage flags:** ${flags.length === 0 ? "clean" : flags.map((f) => f.summary).join("; ")}`,
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

/**
 * DOI siblings within one mechanism's proposal list: for each proposal, every
 * OTHER proposal in the same list that shares at least one source DOI.
 */
function siblingsWithinMechanism(list: Proposal[]): Map<string, string[]> {
  const doiToIds = new Map<string, string[]>();
  for (const p of list) {
    const payload = p.payload as Effect;
    for (const doi of Array.from(new Set(payload.source ?? []))) {
      const ids = doiToIds.get(doi) ?? [];
      ids.push(p.id);
      doiToIds.set(doi, ids);
    }
  }
  const siblings = new Map<string, Set<string>>();
  for (const ids of Array.from(doiToIds.values())) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      const set = siblings.get(id) ?? new Set<string>();
      for (const other of ids) if (other !== id) set.add(other);
      siblings.set(id, set);
    }
  }
  const result = new Map<string, string[]>();
  for (const entry of Array.from(siblings.entries())) {
    result.set(entry[0], Array.from(entry[1]).sort());
  }
  return result;
}

/**
 * Singletons (no sibling) first, sorted by id; then grouped proposals,
 * clustered together and sorted by id within a cluster. A cluster is a
 * CONNECTED COMPONENT of the "shares a DOI" graph, not exact sibling-set
 * equality — a proposal can share one DOI with A and a DIFFERENT DOI with B
 * (MM-15's redundancy-effect does exactly this, bridging coherence-effect and
 * content-redundancy without those two sharing anything directly), and it must
 * still cluster with both rather than sit alone because its own direct sibling
 * list differs from either one's. The per-proposal "DOI siblings" line stays
 * direct-pairwise (only who it actually shares a DOI with); only the
 * clustering for document order uses the transitive closure.
 * Clusters are ordered by their alphabetically-lowest member.
 */
function sortForReview(list: Proposal[], siblings: Map<string, string[]>): Proposal[] {
  const singletons = list
    .filter((p) => !siblings.has(p.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const byId = new Map(list.map((p) => [p.id, p]));
  const visited = new Set<string>();
  const clusters: Proposal[][] = [];
  for (const p of list) {
    if (!siblings.has(p.id) || visited.has(p.id)) continue;
    const componentIds: string[] = [];
    const queue = [p.id];
    visited.add(p.id);
    while (queue.length > 0) {
      const id = queue.shift()!;
      componentIds.push(id);
      for (const neighbour of siblings.get(id) ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        queue.push(neighbour);
      }
    }
    clusters.push(
      componentIds
        .map((id) => byId.get(id))
        .filter((x): x is Proposal => x !== undefined)
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }
  clusters.sort((a, b) => a[0].id.localeCompare(b[0].id));

  return [...singletons, ...clusters.flat()];
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
      "mechanisms with zero effects today), remainder alphabetical. Within each mechanism: " +
      "proposals with no DOI sibling first (alphabetical), then DOI-sharing groups " +
      "clustered together.",
  );
  out.push("");
  out.push(
    "Every field below is read from the proposal file or re-sliced from its evidence " +
      "corpus record by lib/source-context.ts — nothing here is asserted by this script. " +
      "Grade and fact are the model's own; lever and modifiers are the stored v3 verdict; " +
      "the cited span is RE-SLICED at the stored offsets, not the possibly-stale stored " +
      "quote, exactly as `/review` renders it. The mechanical cap and DOI siblings are this " +
      "script's own computation — read their doc comment at the top of this file for exactly " +
      "how each is operationalised.",
  );
  out.push("");
  out.push("---");
  out.push("");

  for (const mech of order) {
    const rawList = byMechanism.get(mech) ?? [];
    const siblings = siblingsWithinMechanism(rawList);
    const list = sortForReview(rawList, siblings);
    const groupCount = new Set(Array.from(siblings.keys())).size;
    out.push(
      `## ${mech} (${list.length}${groupCount > 0 ? `, ${groupCount} in a DOI-sharing group` : ""})`,
    );
    out.push("");
    for (const proposal of list) {
      out.push(renderProposal(proposal, siblings.get(proposal.id) ?? []));
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

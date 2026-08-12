/**
 * tools/realization-report.ts — the review surface for realization proposals.
 *
 * One section per realization proposal, printing the six things an owner needs
 * in order to judge a pattern without opening the JSON by hand:
 *
 *   1. PATTERN, verbatim. Copied byte-for-byte out of payload.pattern, inside a
 *      fence. This report never rewrites, trims, or prettifies a directive —
 *      the thing being judged is the exact string a generator would read.
 *   2. PARAMETERS with units. Every declared tunable with its value, unit and
 *      evidence_basis, plus a mechanical cross-check that the placeholders in
 *      the pattern and the declared parameters are the same set. A bare number
 *      in prose is the invented-precision failure the constitution refuses; a
 *      placeholder with no parameter, or a parameter no placeholder uses, is
 *      how that failure shows up in structured data.
 *   3. DERIVATION — reported or inferred. Several checks below only apply to
 *      inferred records, and this report says "not applicable" where that is
 *      the case rather than printing a clean verdict nobody computed.
 *   4. DOMAIN TRANSFER — source_domain -> application_domain, and whether the
 *      two are equal (equal domains mean no transfer happened).
 *   5. ANCHOR DOMAIN verdict, with leaked terms, from lib/review-flags.ts.
 *   6. HARD-RULE COLLISION warnings, from lib/transferability.ts, pack-scoped
 *      per D-364: rule id, severity, score, matched terms, and the pattern's
 *      own densest clause.
 *
 * NOT A DECISION SURFACE. Nothing here approves, rejects, edits or writes a
 * proposal; the two computed verdicts are advisory checks that already exist
 * and are re-read here, never re-judged. Both are warning-only by their own
 * documentation, and a clean verdict from either is not evidence that a
 * pattern is sound — it is evidence that two lexical checks did not fire.
 * D-366 is explicit that manual review is permanent, not a backstop.
 *
 * HONEST ABSENCE. Where a check cannot run — a reported record has no pattern,
 * an effect_ref resolves to no basis on disk, a proposal carries no
 * domain_transfer — the section says so and names the reason. It never prints
 * "clean" for a check that did not execute.
 *
 * Reads only committed proposal files plus the registry the two checks resolve
 * against. Makes no API calls and writes nothing unless out= is given.
 *
 * Usage:
 *   npm run realization-report
 *   npm run realization-report -- status=pending mechanism=MM-15
 *   npm run realization-report -- effect=mm15-redundancy-effect
 *   npm run realization-report -- run=<proposed_by> out=<path>
 *   npm run realization-report -- status=any since=2026-08-12T00:00:00Z
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeProposalFlags } from "../lib/review-flags";
import { judgeHardRuleCollisions, type HardRuleCollisionFlag } from "../lib/transferability";
import type { Proposal, RealizationProposal, RealizationParameter } from "../lib/types";

const ROOT = join(__dirname, "..");
const PROPOSAL_DIR = join(ROOT, "proposals", "realization");

/** `{name}` as it appears inside a pattern. Mirrors the parameter contract (D-115). */
const PLACEHOLDER_RE = /\{([a-z0-9_]*)\}/gi;

interface Filters {
  status: string;
  mechanism: string | null;
  effect: string | null;
  run: string | null;
  since: string | null;
  out: string | null;
}

function parseParams(argv: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const arg of argv) {
    const at = arg.indexOf("=");
    if (at < 0) throw new Error(`Unrecognised argument "${arg}" — expected key=value`);
    params[arg.slice(0, at)] = arg.slice(at + 1);
  }
  const allowed = new Set(["status", "mechanism", "effect", "run", "since", "out"]);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Unrecognised parameter "${key}" — allowed: ${Array.from(allowed).join(", ")}`,
      );
    }
  }
  return params;
}

function readProposals(): RealizationProposal[] {
  if (!existsSync(PROPOSAL_DIR)) return [];
  const files = readdirSync(PROPOSAL_DIR).filter((name) => name.endsWith(".json"));
  const proposals: RealizationProposal[] = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(PROPOSAL_DIR, file), "utf8")) as Proposal;
    if (parsed.type !== "realization") continue;
    proposals.push(parsed);
  }
  return proposals;
}

function selectProposals(all: RealizationProposal[], filters: Filters): RealizationProposal[] {
  return all
    .filter((proposal) => filters.status === "any" || proposal.status === filters.status)
    .filter((proposal) => !filters.mechanism || proposal.payload.mechanism_id === filters.mechanism)
    .filter(
      (proposal) =>
        !filters.effect || (proposal.payload.effect_refs ?? []).includes(filters.effect),
    )
    .filter((proposal) => !filters.run || proposal.proposed_by === filters.run)
    .filter((proposal) => !filters.since || proposal.proposed_at >= filters.since)
    .sort(
      (a, b) =>
        a.payload.mechanism_id.localeCompare(b.payload.mechanism_id) ||
        a.proposed_at.localeCompare(b.proposed_at) ||
        a.id.localeCompare(b.id),
    );
}

function placeholdersOf(pattern: string): string[] {
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
  while ((match = re.exec(pattern)) !== null) names.add(match[1]);
  return Array.from(names).sort();
}

/** Placeholders and declared parameters must be the same set (D-115). */
function parameterCrossCheck(pattern: string | undefined, parameters: RealizationParameter[]): string[] {
  if (!pattern) return [];
  const used = new Set(placeholdersOf(pattern));
  const declared = new Set(parameters.map((parameter) => parameter.name));
  const problems: string[] = [];
  for (const name of Array.from(used).sort()) {
    if (!declared.has(name)) {
      problems.push(`pattern uses {${name}} but declares no parameter for it`);
    }
  }
  for (const name of Array.from(declared).sort()) {
    if (!used.has(name)) {
      problems.push(`parameter "${name}" is declared but never referenced as {${name}}`);
    }
  }
  return problems;
}

function renderParameters(proposal: RealizationProposal): string[] {
  const { pattern, parameters = [], derivation } = proposal.payload;
  const lines: string[] = ["**Parameters**", ""];
  if (parameters.length === 0) {
    lines.push(
      derivation === "reported"
        ? "- none — forbidden on a `reported` record."
        : "- none declared.",
    );
  } else {
    for (const parameter of parameters) {
      lines.push(
        `- \`${parameter.name}\` = **${parameter.value}** ${parameter.unit} ` +
          `— evidence_basis: ${parameter.evidence_basis}`,
      );
    }
  }
  const problems = parameterCrossCheck(pattern, parameters);
  if (problems.length > 0) {
    lines.push("", "Placeholder/parameter mismatch:");
    for (const problem of problems) lines.push(`- ${problem}`);
  } else if (pattern && (parameters.length > 0 || placeholdersOf(pattern).length > 0)) {
    lines.push("", "Placeholders and declared parameters agree.");
  }
  return lines;
}

function renderDomainTransfer(proposal: RealizationProposal): string[] {
  const transfer = proposal.payload.domain_transfer;
  const lines: string[] = ["**Domain transfer**", ""];
  if (!transfer) {
    lines.push("- absent on this proposal — no source/application domain was recorded.");
    return lines;
  }
  lines.push(`- source_domain: ${transfer.source_domain}`);
  lines.push(`- application_domain: ${transfer.application_domain}`);
  if (transfer.source_domain.trim().toLowerCase() === transfer.application_domain.trim().toLowerCase()) {
    lines.push("- the two domains are equal: no transfer.");
  }
  return lines;
}

function renderAnchorDomain(proposal: RealizationProposal): string[] {
  const lines: string[] = ["**ANCHOR DOMAIN**", ""];
  const refs = proposal.payload.effect_refs ?? [];
  if (proposal.payload.derivation !== "inferred") {
    lines.push("- not applicable: the check runs on inferred realizations only.");
    return lines;
  }
  if (!proposal.payload.pattern) {
    lines.push("- not applicable: the proposal carries no pattern to check.");
    return lines;
  }
  if (refs.length === 0) {
    lines.push("- did not run: the proposal names no effect_refs, so there is no anchor to compare against.");
    return lines;
  }
  const flags = computeProposalFlags(proposal, ROOT).filter(
    (flag) => flag.kind === "pattern_carries_anchor_domain",
  );
  if (flags.length === 0) {
    lines.push(`- clean against ${refs.length} anchor${refs.length === 1 ? "" : "s"}: ${refs.join(", ")}.`);
    return lines;
  }
  for (const flag of flags) {
    const leaked = flag.detail.split("Shared non-generic terms: ").pop() ?? "";
    lines.push(`- FLAGGED against ${flag.anchorEffect?.id ?? "anchor"} — leaked terms: ${leaked.replace(/\.$/, "")}`);
    lines.push(`  - ${flag.summary}`);
  }
  return lines;
}

function renderCollisions(proposal: RealizationProposal): string[] {
  const lines: string[] = ["**Hard-rule collisions**", ""];
  if (proposal.payload.derivation !== "inferred" || !proposal.payload.pattern) {
    lines.push("- not applicable: the check runs on inferred realizations carrying a pattern.");
    return lines;
  }
  const flags: HardRuleCollisionFlag[] = judgeHardRuleCollisions(proposal.payload, ROOT);
  if (flags.length === 0) {
    lines.push("- none fired.");
    return lines;
  }
  for (const flag of flags) {
    lines.push(
      `- ${flag.severity.toUpperCase()} ${flag.mechanism_id} \`${flag.rule_id}\` ` +
        `(score ${flag.score.toFixed(2)}) — matched: ${flag.matched_terms.join(", ")}`,
    );
    lines.push(`  - rule: "${flag.rule}"`);
    if (flag.pattern_clause) lines.push(`  - pattern clause: "${flag.pattern_clause}"`);
  }
  return lines;
}

function renderProposal(proposal: RealizationProposal, index: number): string[] {
  const { payload } = proposal;
  const lines: string[] = [];
  lines.push(`### ${index}. ${payload.term} — \`${payload.id}\``);
  lines.push("");
  lines.push(`- proposal: \`${proposal.id}\``);
  lines.push(`- mechanism: ${payload.mechanism_id} | operation: ${proposal.operation} | status: ${proposal.status}`);
  lines.push(`- effect_refs: ${(payload.effect_refs ?? []).join(", ") || "none"}`);
  if ((payload.boundary_refs ?? []).length > 0) {
    lines.push(`- boundary_refs: ${(payload.boundary_refs ?? []).join(", ")}`);
  }
  lines.push(`- confidence: ${proposal.confidence} | proposed_by: \`${proposal.proposed_by}\` | proposed_at: ${proposal.proposed_at}`);
  lines.push("");
  lines.push(`**Derivation**: ${payload.derivation ?? "unset"}`);
  lines.push("");
  lines.push("**As reported**");
  lines.push("");
  lines.push(`> ${payload.description_as_reported}`);
  lines.push("");
  lines.push("**Pattern (verbatim)**");
  lines.push("");
  if (payload.pattern) {
    lines.push("```text");
    lines.push(payload.pattern);
    lines.push("```");
  } else {
    lines.push(
      payload.derivation === "reported"
        ? "- none — forbidden on a `reported` record."
        : "- none present.",
    );
  }
  lines.push("");
  lines.push(...renderParameters(proposal));
  lines.push("");
  lines.push(...renderDomainTransfer(proposal));
  lines.push("");
  lines.push(...renderAnchorDomain(proposal));
  lines.push("");
  lines.push(...renderCollisions(proposal));
  lines.push("");
  return lines;
}

function renderSummary(proposals: RealizationProposal[]): string[] {
  const byMechanism = new Map<string, RealizationProposal[]>();
  for (const proposal of proposals) {
    const list = byMechanism.get(proposal.payload.mechanism_id) ?? [];
    list.push(proposal);
    byMechanism.set(proposal.payload.mechanism_id, list);
  }
  const lines: string[] = ["## Summary", "", "| mechanism | proposals | inferred | anchor-domain flagged | collisions |", "|---|---|---|---|---|"];
  for (const mechanism of Array.from(byMechanism.keys()).sort()) {
    const list = byMechanism.get(mechanism) ?? [];
    const inferred = list.filter((proposal) => proposal.payload.derivation === "inferred");
    const flagged = inferred.filter(
      (proposal) =>
        computeProposalFlags(proposal, ROOT).some(
          (flag) => flag.kind === "pattern_carries_anchor_domain",
        ),
    );
    const collided = inferred.filter(
      (proposal) => judgeHardRuleCollisions(proposal.payload, ROOT).length > 0,
    );
    lines.push(
      `| ${mechanism} | ${list.length} | ${inferred.length} | ${flagged.length} | ${collided.length} |`,
    );
  }
  lines.push(`| **total** | **${proposals.length}** | | | |`);
  return lines;
}

function main(): void {
  const params = parseParams(process.argv.slice(2));
  const filters: Filters = {
    status: params.status ?? "pending",
    mechanism: params.mechanism ?? null,
    effect: params.effect ?? null,
    run: params.run ?? null,
    since: params.since ?? null,
    out: params.out ?? null,
  };
  const all = readProposals();
  const selected = selectProposals(all, filters);
  const scope = [
    `status=${filters.status}`,
    filters.mechanism ? `mechanism=${filters.mechanism}` : null,
    filters.effect ? `effect=${filters.effect}` : null,
    filters.run ? `run=${filters.run}` : null,
    filters.since ? `since=${filters.since}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const lines: string[] = [];
  lines.push("# Realization proposals — review report");
  lines.push("");
  lines.push(`Scope: ${scope}. ${selected.length} of ${all.length} realization proposals on disk.`);
  lines.push("");
  lines.push(
    "Advisory only. ANCHOR DOMAIN and hard-rule collision are warning-only lexical checks; " +
      "a clean verdict from both is not a judgement that a pattern is sound (D-366).",
  );
  lines.push("");
  if (selected.length === 0) {
    lines.push("No proposals match this scope.");
  } else {
    lines.push(...renderSummary(selected));
    lines.push("");
    lines.push("## Proposals");
    lines.push("");
    selected.forEach((proposal, index) => lines.push(...renderProposal(proposal, index + 1)));
  }

  const report = `${lines.join("\n")}\n`;
  if (filters.out) {
    writeFileSync(filters.out, report);
    console.log(`Wrote ${filters.out} — ${selected.length} proposal(s).`);
  } else {
    process.stdout.write(report);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

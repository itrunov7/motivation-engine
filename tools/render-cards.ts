/**
 * tools/render-cards.ts — renders each full L1 mechanism record from
 * /registry/mechanisms into a human-readable card at /cards/{id}.md
 * (SPEC.md §6). Cards are generated projections (D-002): never edit them
 * by hand — change the registry record and re-render with `npm run cards`.
 *
 * Stale cards whose source record no longer exists are removed.
 * /cards/README.md is left untouched.
 */

import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Mechanism, Implementation, Relation } from "../lib/types";

const ROOT = join(__dirname, "..");
const MECHANISMS_DIR = join(ROOT, "registry", "mechanisms");
const CARDS_DIR = join(ROOT, "cards");

function rel(path: string): string {
  return relative(ROOT, path);
}

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function bulletList(items: string[], emptyNote: string): string {
  if (items.length === 0) return `_${emptyNote}_`;
  return items.map((item) => `- ${item}`).join("\n");
}

function codeList(items: string[]): string {
  return items.map((item) => `\`${item}\``).join(", ");
}

function relationLabel(type: Relation["type"]): string {
  switch (type) {
    case "enabled_by":
      return "enabled by";
    case "adjacent":
      return "adjacent to";
    case "hybrid_with":
      return "hybrid with";
  }
}

function renderImplementation(impl: Implementation): string {
  const requirements =
    impl.product_requirements.length > 0 ? codeList(impl.product_requirements) : "none";
  const observed =
    impl.observed_effects.length > 0
      ? impl.observed_effects.map((e) => `- ${e}`).join("\n")
      : "_none measured yet — will come from the telemetry loop_";
  return [
    `### \`${impl.id}\``,
    "",
    `**Artifacts:** ${codeList(impl.artifact_types)} · **Requires:** ${requirements}`,
    "",
    impl.generation_directive,
    "",
    `**Copy formulas:**`,
    "",
    bulletList(
      impl.copy_formulas.map((f) => `\`${f}\``),
      "none",
    ),
    "",
    `**Metrics:** ${codeList(impl.metrics)}`,
    "",
    `**Observed effects:**`,
    "",
    observed,
  ].join("\n");
}

function renderCard(m: Mechanism): string {
  const lines: string[] = [];

  lines.push(
    "<!-- GENERATED FILE — do not edit by hand. -->",
    `<!-- Source: registry/mechanisms/${m.id}.json · regenerate with \`npm run cards\` (D-002). -->`,
    "",
    `# ${m.name} · \`${m.id}\``,
    "",
    `| | |`,
    `|---|---|`,
    `| Lifecycle | \`${m.lifecycle_status}\` |`,
    `| Evidence grade | **${m.evidence.grade}** |`,
    `| Parent system | \`${m.parent}\` |`,
    `| Version | ${m.version} |`,
    `| Prior weight | ${m.prior_weight} |`,
    `| Proposed by | ${m.provenance.proposed_by} (${m.provenance.date}) |`,
    `| Dossier | ${m.dossier_ref ? `\`${m.dossier_ref}\`` : "none yet"} |`,
    "",
    "## Summary",
    "",
    m.mechanism_summary_for_context,
    "",
    "## Evidence",
    "",
    m.evidence.basis,
    "",
    `**Effect size:** ${m.evidence.effect_size_note}`,
    "",
    `**Caveats:** ${m.evidence.caveats.length > 0 ? codeList(m.evidence.caveats) : "none recorded"}`,
    "",
    "## Applicability",
    "",
    `**Funnel stages:** ${codeList(m.applicability.funnel_stages)}`,
    "",
    `**Excluded stages:** ${m.applicability.excluded_stages.length > 0 ? codeList(m.applicability.excluded_stages) : "none"}`,
    "",
    `**Artifact types:** ${codeList(m.applicability.artifact_types)}`,
    "",
    "**Preconditions:**",
    "",
    bulletList(
      m.applicability.preconditions.map((p) => `\`${p.predicate}\` — ${p.reason}`),
      "none",
    ),
    "",
    `**Culture note:** ${m.applicability.culture_note}`,
    "",
    `## Implementations (${m.implementations.length})`,
    "",
    "| id | artifacts | metrics |",
    "|---|---|---|",
    ...m.implementations.map(
      (impl) =>
        `| \`${impl.id}\` | ${mdEscape(impl.artifact_types.join(", "))} | ${mdEscape(impl.metrics.join(", "))} |`,
    ),
    "",
    ...m.implementations.flatMap((impl) => [renderImplementation(impl), ""]),
    "## Constraints",
    "",
    "**Hard rules:**",
    "",
    ...m.constraints.hard_rules.map(
      (rule) => `- \`${rule.id}\` (${rule.severity}) — ${rule.rule}`,
    ),
    "",
    `**Compliance refs:** ${m.constraints.compliance_refs.length > 0 ? codeList(m.constraints.compliance_refs) : "none"}`,
    "",
    `**Boundary test:** ${m.constraints.boundary_test}`,
    "",
    "## Relations",
    "",
    bulletList(
      m.relations.map((r) => `${relationLabel(r.type)} \`${r.target}\` — ${r.note}`),
      "none",
    ),
    "",
    "## Telemetry",
    "",
    `Tag format \`${m.telemetry.tag_format}\` · event property \`${m.telemetry.amplitude_event_property}\``,
  );

  if (m.reference_examples && m.reference_examples.length > 0) {
    lines.push(
      "",
      "## Reference examples",
      "",
      ...m.reference_examples.map((ex) => `- **${ex.product}** — ${ex.what}`),
    );
  }

  lines.push("");
  return lines.join("\n");
}

function main(): void {
  console.log("Motivation Engine card generator\n");

  const files = listJsonFiles(MECHANISMS_DIR);
  const renderedIds = new Set<string>();

  for (const file of files) {
    const mechanism = JSON.parse(readFileSync(file, "utf-8")) as Mechanism;
    const target = join(CARDS_DIR, `${mechanism.id}.md`);
    writeFileSync(target, renderCard(mechanism), "utf-8");
    renderedIds.add(mechanism.id);
    console.log(`  ✓ ${rel(file)} → ${rel(target)}`);
  }

  // Remove stale generated cards (records that no longer exist).
  if (existsSync(CARDS_DIR)) {
    for (const entry of readdirSync(CARDS_DIR)) {
      if (!entry.endsWith(".md") || entry === "README.md") continue;
      const id = entry.replace(/\.md$/, "");
      if (!renderedIds.has(id)) {
        unlinkSync(join(CARDS_DIR, entry));
        console.log(`  ✗ removed stale card cards/${entry}`);
      }
    }
  }

  console.log(`\nOK — ${renderedIds.size} card${renderedIds.size === 1 ? "" : "s"} rendered.`);
}

main();

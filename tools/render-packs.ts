/**
 * tools/render-packs.ts — projects the pack map (/packs/pack-map.yaml) + the
 * registry (/registry/mechanisms/*.json, /dossiers/*.json) into one YAML
 * datasheet per Development-Plan element at /packs/pack-{id}.yaml (D-049).
 *
 * Packs are GENERATED projections, never hand-authored (same pattern as
 * render-cards, D-002): the only hand-written input is the pack map (D-048).
 * Change a registry record and re-render with `npm run packs`.
 *
 * The output structure is pinned to the reference file
 * packs/pack-paywall-conversion.yaml: header + LAYER 1 mechanisms +
 * cross_cutting_perception + LAYER 2 interactions + LAYER 3 context_weights +
 * hard_boundaries + signals + wiring. Knowledge-base tone: facts only, no
 * instructions.
 *
 * Cross-cutting perception (Step 5, D-066): every full record whose L0 parent
 * is flagged cross_cutting in registry/taxonomy.json (today only S7) is emitted
 * into EVERY pack as the distinct top-level section cross_cutting_perception,
 * separate from the pack's own motivational LAYER 1. The pack map never lists
 * these — inclusion is automatic. Empty until the S7 seeds become full records.
 *
 * LAYER 2 draws from TWO sources (D-057): owner-authored interaction records
 * (/interactions/{A}__{B}.json) and registry relations. An authored record is
 * richer (type incl. suppressing/neutral, boundary, source) and REPLACES the
 * relation-derived entry for the same pair; relations still fill pairs with no
 * authored record.
 *
 * Two self-checks run before writing: every emitted file must parse back as
 * YAML, and no emitted prose (outside comments) may carry instruction-voice
 * tokens (you / your / should / prefer).
 *
 * Stale pack-*.yaml files whose element no longer exists are removed;
 * pack-map.yaml and README.md are never touched.
 *
 * Scoped regenerate (D-052, the maturation loop): `npm run packs -- packs=a,b`
 * renders ONLY the listed elements — the loop regenerates the packs whose
 * cells changed, not the whole set. A scoped run never removes stale packs
 * (it cannot know which of the unrendered files are stale).
 */

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml, parseAllDocuments, stringify as stringifyYaml } from "yaml";
import type {
  Dossier,
  EvidenceGrade,
  InteractionRecord,
  Mechanism,
  PackContextWeight,
  PackDatasheet,
  PackInteraction,
  PackInteractionType,
  PackMapElement,
  PackMapFile,
  PackMechanism,
  Relation,
  Taxonomy,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const MECHANISMS_DIR = join(ROOT, "registry", "mechanisms");
const TAXONOMY = join(ROOT, "registry", "taxonomy.json");
const DOSSIERS_DIR = join(ROOT, "dossiers");
const INTERACTIONS_DIR = join(ROOT, "interactions");
const PACKS_DIR = join(ROOT, "packs");
const PACK_MAP = join(PACKS_DIR, "pack-map.yaml");
const EXPORT_DIR = join(PACKS_DIR, "export");
const EXPORT_BUNDLE = join(EXPORT_DIR, "packs-bundle.yaml");

// Constant knowledge-voice blocks, verbatim from the reference datasheet.
const NATURE = "knowledge base. facts with evidence strength. no instructions.";
const SIGNAL_TAG = "each generated element carries its mechanism id";
const SIGNAL_LEARNING =
  "weak/negative signal demotes a realization; strong signal spreads it — the palette evolves from outcomes";
const WIRING = {
  where: "planning stage of the Development Plan, when the planned element matches applies_to",
  how: "pack is provided to the generator as knowledge to reason from; nothing here instructs how to build",
  selection_now: "by element type",
  selection_later:
    "planning agent pre-filters mechanisms via active_when against the product spec, narrowing the evidence in context",
  provenance:
    "downstream of registry records; regenerate when a record's grade/boundary/guardrail changes; never edit independently",
} as const;

const BANNER = "# ─────────────────────────────────────────────";

// Strong → weak. Weaker of a pair is the one later in this list.
const GRADE_ORDER: EvidenceGrade[] = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];

// Set from the pack map at startup; the file-level version stamps every pack.
let PACK_MAP_VERSION = "0.0.0";

// Instruction-voice tokens the knowledge base must never carry.
const VOICE_TOKENS = /\b(?:you|your|should|prefer)\b/i;

function rel(path: string): string {
  return relative(ROOT, path);
}

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

/** A single YAML scalar (quoted only when required), no trailing newline. */
function scalar(value: string): string {
  return stringifyYaml(value, { lineWidth: 0 }).replace(/\n+$/, "");
}

/** A flow sequence of identifier-like tokens (no quoting needed for our data). */
function flow(items: string[]): string {
  return `[${items.join(", ")}]`;
}

function weakerGrade(a: EvidenceGrade, b: EvidenceGrade): EvidenceGrade {
  return GRADE_ORDER.indexOf(a) >= GRADE_ORDER.indexOf(b) ? a : b;
}

/** Order a member-pair id key deterministically (locale-stable, matches the analyzer). */
function pairKey(a: string, b: string): string {
  return a.localeCompare(b) <= 0 ? `${a}|${b}` : `${b}|${a}`;
}

/** First sentence of a summary, so instruction-voice tails are dropped. */
function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : text).trim();
}

function humanize(token: string): string {
  return token.replace(/_/g, " ");
}

/** Strip the "== true" tail so predicates read as conditions. */
function stripPredicate(predicate: string): string {
  return predicate.replace(/\s*==\s*true\b/g, "").trim();
}

/** Implementation id with its "{MECH}-" prefix removed. */
function realization(mechanismId: string, implementationId: string): string {
  const prefix = `${mechanismId}-`;
  return implementationId.startsWith(prefix)
    ? implementationId.slice(prefix.length)
    : implementationId;
}

/**
 * A short dissent citation for the boundary line, taken from the text before
 * the dossier dissent's first ": ". Only used when that lead segment is a
 * single citation-shaped clause (carries a year, one clause, short) — prose
 * dossiers that do not open with a citation contribute no "contested by".
 */
function dissentCitation(dissent: string): string | null {
  const segment = dissent.split(/:\s/)[0].trim();
  if (!/\b(?:19|20)\d{2}\b/.test(segment)) return null;
  if (segment.includes(". ")) return null;
  if (segment.length > 160) return null;
  return segment;
}

function loadDossier(mechanismId: string): Dossier | null {
  const file = join(DOSSIERS_DIR, `${mechanismId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8")) as Dossier;
}

// ---------- LAYER 1 ----------

function buildMechanism(m: Mechanism, dossier: Dossier | null): PackMechanism {
  const dois = (m.pinned_evidence ?? []).map((p) => `doi:${p.doi}`);
  const caveats = m.evidence.caveats.map(humanize).join("; ");
  const citation = dossier ? dissentCitation(dossier.dissent) : null;
  const boundary = citation ? `${caveats}; contested by ${citation}` : caveats;
  const activeWhen = m.applicability.preconditions
    .map((p) => stripPredicate(p.predicate))
    .join(" OR ");
  return {
    id: m.id,
    name: m.name.toLowerCase(),
    fact: firstSentence(m.mechanism_summary_for_context),
    grade: m.evidence.grade,
    source: [m.evidence.basis, ...dois].join("; "),
    boundary,
    active_when: activeWhen,
    realizations: m.implementations.map((impl) => realization(m.id, impl.id)),
    forbidden: m.constraints.hard_rules.map((r) => r.id.replace(/_/g, "-")),
  };
}

// ---------- LAYER 2 ----------

function interactionFor(
  type: Relation["type"],
): { kind: PackInteractionType; ordered: (source: string, target: string) => [string, string] } | null {
  switch (type) {
    case "enables":
      return { kind: "sequence-amplifying", ordered: (s, t) => [s, t] };
    case "enabled_by":
      return { kind: "sequence-amplifying", ordered: (s, t) => [t, s] };
    case "hybrid_with":
      return { kind: "reinforcing", ordered: (s, t) => [s, t] };
    case "adjacent":
      return { kind: "noted", ordered: (s, t) => [s, t] };
    case "orthogonality_note":
      return null;
  }
}

function buildInteractions(
  members: Mechanism[],
  crossCutting: Mechanism[],
  gradeOf: Map<string, EvidenceGrade>,
  authored: Map<string, InteractionRecord>,
): PackInteraction[] {
  const memberIds = new Set(members.map((m) => m.id));
  const interactions: PackInteraction[] = [];
  const authoredPairKeys = new Set<string>();

  // Authored records first (D-057): richer and owner-curated. Pairs are drawn
  // from the pack's own mechanisms UNION the cross-cutting perception
  // mechanisms (Step 5), so an authored interaction between a perception
  // mechanism and a pack mechanism surfaces in LAYER 2. One per pair, ordered
  // locale-stable, carrying the full type/fact/grade/boundary/source — and it
  // REPLACES any relation-derived entry for the same pair.
  const ids = [...members, ...crossCutting]
    .map((m) => m.id)
    .sort((a, b) => a.localeCompare(b));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = pairKey(ids[i], ids[j]);
      const record = authored.get(key);
      if (!record) continue;
      authoredPairKeys.add(key);
      interactions.push({
        combination: [record.pair[0], record.pair[1]],
        type: record.type,
        fact: record.fact,
        grade: record.grade,
        boundary: record.boundary,
        source: record.source,
      });
    }
  }

  // Relation-derived entries for the pairs WITHOUT an authored record.
  const seen = new Set<string>();
  for (const m of members) {
    for (const relation of m.relations) {
      if (!memberIds.has(relation.target)) continue;
      const mapped = interactionFor(relation.type);
      if (!mapped) continue;
      if (authoredPairKeys.has(pairKey(m.id, relation.target))) continue;
      const combination = mapped.ordered(m.id, relation.target);
      const key = `${mapped.kind}:${combination.slice().sort().join("|")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const gradeA = gradeOf.get(combination[0]);
      const gradeB = gradeOf.get(combination[1]);
      if (!gradeA || !gradeB) continue;
      interactions.push({
        combination,
        type: mapped.kind,
        fact: relation.note,
        grade: weakerGrade(gradeA, gradeB),
      });
    }
  }
  return interactions;
}

// ---------- LAYER 3 ----------

function buildContextWeights(members: Mechanism[]): PackContextWeight[] {
  const byPredicate = new Map<string, string[]>();
  for (const m of members) {
    for (const precondition of m.applicability.preconditions) {
      const predicate = stripPredicate(precondition.predicate);
      const ids = byPredicate.get(predicate) ?? [];
      if (!ids.includes(m.id)) ids.push(m.id);
      byPredicate.set(predicate, ids);
    }
  }
  const weights: PackContextWeight[] = [];
  byPredicate.forEach((ids, predicate) => {
    weights.push({ context: predicate, strong: ids });
    weights.push({ context: `not (${predicate})`, inactive: ids });
  });
  return weights;
}

// ---------- hard boundaries ----------

/**
 * A hard rule as a status-fact: leading imperatives are dropped (the
 * "forbidden — " prefix already carries the prohibition), and any rule still
 * carrying second-person instruction voice (you / your / should / prefer)
 * collapses to a bare "forbidden" rather than leaking an instruction.
 */
function boundaryReason(rule: string): string {
  const text = rule.trim().replace(/^(?:do not|don't|never)\s+/i, "");
  if (VOICE_TOKENS.test(text)) return "forbidden";
  return `forbidden — ${text}`;
}

function buildHardBoundaries(members: Mechanism[]): Record<string, string>[] {
  const boundaries: Record<string, string>[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    for (const rule of m.constraints.hard_rules) {
      const key = rule.id.replace(/_/g, "-");
      if (seen.has(key)) continue;
      seen.add(key);
      boundaries.push({ [key]: boundaryReason(rule.rule) });
    }
  }
  for (const m of members) {
    boundaries.push({ boundary_test: m.constraints.boundary_test });
  }
  return boundaries;
}

// ---------- signals ----------

function buildMeasured(members: Mechanism[]): string[] {
  const metrics = new Set<string>();
  for (const m of members) {
    for (const impl of m.implementations) {
      for (const metric of impl.metrics) metrics.add(metric);
    }
  }
  return Array.from(metrics).sort();
}

// ---------- datasheet ----------

function buildDatasheet(
  element: PackMapElement,
  members: Mechanism[],
  crossCutting: Mechanism[],
  authored: Map<string, InteractionRecord>,
): PackDatasheet {
  const gradeOf = new Map(members.map((m) => [m.id, m.evidence.grade] as const));
  return {
    pack: element.id,
    applies_to: element.applies_to,
    funnel_stage: element.funnel_stage,
    version: PACK_MAP_VERSION,
    nature: NATURE,
    source: `projection of registry records ${members.map((m) => m.id).join(" ")}`,
    mechanisms: members.map((m) => buildMechanism(m, loadDossier(m.id))),
    cross_cutting_perception: crossCutting.map((m) => buildMechanism(m, loadDossier(m.id))),
    interactions: buildInteractions(members, crossCutting, gradeOf, authored),
    context_weights: buildContextWeights(members),
    hard_boundaries: buildHardBoundaries(members),
    signals: { measured: buildMeasured(members), tag: SIGNAL_TAG, learning: SIGNAL_LEARNING },
    wiring: { ...WIRING },
  };
}

// ---------- rendering (hand-written to keep the section banners) ----------

function renderMechanism(pm: PackMechanism): string[] {
  return [
    `  - id: ${pm.id}`,
    `    name: ${scalar(pm.name)}`,
    `    fact: ${scalar(pm.fact)}`,
    `    grade: ${pm.grade}`,
    `    source: ${scalar(pm.source)}`,
    `    boundary: ${scalar(pm.boundary)}`,
    `    active_when: ${scalar(pm.active_when)}`,
    `    realizations: ${flow(pm.realizations)}`,
    `    forbidden: ${flow(pm.forbidden)}`,
    "",
  ];
}

function renderInteraction(pi: PackInteraction): string[] {
  const lines = [
    `  - combination: ${flow(pi.combination)}`,
    `    type: ${pi.type}`,
    `    fact: ${scalar(pi.fact)}`,
    `    grade: ${pi.grade}`,
  ];
  // Authored records (D-057) carry a boundary and source; relation-derived
  // entries do not.
  if (pi.boundary !== undefined) lines.push(`    boundary: ${scalar(pi.boundary)}`);
  if (pi.source !== undefined) lines.push(`    source: ${scalar(pi.source)}`);
  lines.push("");
  return lines;
}

function renderContextWeight(cw: PackContextWeight): string[] {
  const lines = [`  - context: ${scalar(cw.context)}`];
  if (cw.strong) lines.push(`    strong: ${flow(cw.strong)}`);
  if (cw.inactive) lines.push(`    inactive: ${flow(cw.inactive)}`);
  return lines;
}

function renderDatasheet(sheet: PackDatasheet): string {
  const lines: string[] = [];

  lines.push(
    "# GENERATED FILE — do not edit by hand.",
    "# Source: packs/pack-map.yaml + registry/mechanisms/*.json · regenerate with `npm run packs` (D-049).",
    "",
    `pack: ${scalar(sheet.pack)}`,
    `applies_to: ${flow(sheet.applies_to)}`,
    `funnel_stage: ${sheet.funnel_stage}`,
    `version: ${sheet.version}`,
    `nature: ${scalar(sheet.nature)}`,
    `source: ${scalar(sheet.source)}`,
    "",
    BANNER,
    "# LAYER 1 — MECHANISMS (atoms of evidence)",
    BANNER,
    "mechanisms:",
    "",
  );
  for (const pm of sheet.mechanisms) lines.push(...renderMechanism(pm));

  lines.push(
    BANNER,
    "# CROSS-CUTTING — PERCEPTION & COMPREHENSION (S7 · applies to every element)",
    BANNER,
    "cross_cutting_perception:",
    "",
  );
  if (sheet.cross_cutting_perception.length === 0) {
    lines.push(
      "  [] # fills automatically when S7 seeds are promoted to full records (docs/s7-drafting-brief.md); pack-map needs no change (D-066)",
      "",
    );
  } else {
    for (const pm of sheet.cross_cutting_perception) lines.push(...renderMechanism(pm));
  }

  lines.push(
    BANNER,
    "# LAYER 2 — INTERACTIONS (often stronger than any single mechanism)",
    BANNER,
    "interactions:",
    "",
  );
  if (sheet.interactions.length === 0) {
    lines.push(
      "  [] # no relations or authored interactions among this element's mechanisms",
      "",
    );
  } else {
    for (const pi of sheet.interactions) lines.push(...renderInteraction(pi));
  }

  lines.push(
    BANNER,
    "# LAYER 3 — CONTEXT WEIGHTS (what fits what)",
    BANNER,
    "context_weights:",
  );
  for (const cw of sheet.context_weights) lines.push(...renderContextWeight(cw));
  lines.push("");

  lines.push(
    BANNER,
    "# HARD BOUNDARIES (absolute — legal/policy status, not preference)",
    BANNER,
    "hard_boundaries:",
  );
  for (const boundary of sheet.hard_boundaries) {
    const [key, value] = Object.entries(boundary)[0];
    lines.push(`  - ${key}: ${scalar(value)}`);
  }
  lines.push("");

  lines.push(
    BANNER,
    "# telemetry",
    BANNER,
    "signals:",
    `  measured: ${flow(sheet.signals.measured)}`,
    `  tag: ${scalar(sheet.signals.tag)}`,
    `  learning: ${scalar(sheet.signals.learning)}`,
    "",
    BANNER,
    "# wiring (only human-facing section; not read at generation time)",
    BANNER,
    "wiring:",
    `  where: ${scalar(sheet.wiring.where)}`,
    `  how: ${scalar(sheet.wiring.how)}`,
    `  selection_now: ${scalar(sheet.wiring.selection_now)}`,
    `  selection_later: ${scalar(sheet.wiring.selection_later)}`,
    `  provenance: ${scalar(sheet.wiring.provenance)}`,
    "",
  );

  return lines.join("\n");
}

// ---------- self-checks ----------

function voiceViolations(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#") && VOICE_TOKENS.test(line))
    .map((line) => line.trim());
}

// ---------- export bundle (D-068) ----------

/**
 * Bundles every pack datasheet on disk into the committed export artifact
 * packs/export/packs-bundle.yaml — a multi-document YAML stream: a manifest
 * document followed by each pack file verbatim. It always reads the packs
 * directory (not just the packs rendered this run), so a scoped run (D-052)
 * still emits a complete, current bundle. The bundle is a pure function of the
 * packs — no timestamps — so it only diffs when a pack diffs.
 */
function writeExportBundle(): number {
  const packFiles = readdirSync(PACKS_DIR)
    .filter((entry) => entry.startsWith("pack-") && entry.endsWith(".yaml"))
    .filter((entry) => entry !== "pack-map.yaml")
    .sort();
  const packIds = packFiles.map((file) => file.slice("pack-".length, -".yaml".length));

  const documents: string[] = [];
  documents.push(
    [
      "# GENERATED FILE — export bundle of all pack datasheets, for team testing (D-068).",
      "# Never edit by hand; regenerate with `npm run packs`. First document is the",
      "# manifest; every following document is one packs/pack-{id}.yaml verbatim.",
      "",
      "bundle: pack-export",
      `version: ${scalar(PACK_MAP_VERSION)}`,
      `pack_count: ${packFiles.length}`,
      `packs: ${flow(packIds)}`,
      `nature: ${scalar(NATURE)}`,
      `source: ${scalar("verbatim concatenation of packs/pack-{id}.yaml — downstream of the registry, regenerated by every pack render")}`,
      "",
    ].join("\n"),
  );
  for (const file of packFiles) {
    documents.push(readFileSync(join(PACKS_DIR, file), "utf-8"));
  }

  const text = documents.join("---\n");

  // Self-check: the bundle must parse back as exactly (packs + manifest) docs.
  const parsed = parseAllDocuments(text);
  for (const doc of parsed) {
    if (doc.errors.length > 0) {
      throw new Error(`export bundle is not valid YAML — ${doc.errors[0].message}`);
    }
  }
  if (parsed.length !== packFiles.length + 1) {
    throw new Error(
      `export bundle self-check failed — expected ${packFiles.length + 1} YAML documents, parsed ${parsed.length}`,
    );
  }

  mkdirSync(EXPORT_DIR, { recursive: true });
  writeFileSync(EXPORT_BUNDLE, text, "utf-8");
  return packFiles.length;
}

// ---------- main ----------

/** `packs=a,b` CLI filter (D-052) — undefined means render every element. */
function parsePacksFilter(args: string[]): Set<string> | undefined {
  for (const arg of args) {
    if (!arg.startsWith("packs=")) {
      console.error(`  ✗ unknown argument "${arg}" — usage: npm run packs [-- packs=a,b]`);
      process.exit(1);
    }
    const ids = arg
      .slice("packs=".length)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (ids.length === 0) {
      console.error("  ✗ packs= filter is empty — usage: npm run packs [-- packs=a,b]");
      process.exit(1);
    }
    return new Set(ids);
  }
  return undefined;
}

function main(): void {
  console.log("Motivation Engine pack generator\n");

  if (!existsSync(PACK_MAP)) {
    console.error(`  ✗ no pack map at ${rel(PACK_MAP)} — nothing to generate.`);
    process.exit(1);
  }

  const packsFilter = parsePacksFilter(process.argv.slice(2));

  const packMap = parseYaml(readFileSync(PACK_MAP, "utf-8")) as PackMapFile;
  PACK_MAP_VERSION = packMap.version;

  if (packsFilter) {
    const known = new Set(packMap.elements.map((e) => e.id));
    for (const id of Array.from(packsFilter)) {
      if (!known.has(id)) {
        console.error(`  ✗ packs= filter names unknown pack "${id}" — not in ${rel(PACK_MAP)}.`);
        process.exit(1);
      }
    }
  }

  const mechanisms = new Map<string, Mechanism>();
  for (const file of listJsonFiles(MECHANISMS_DIR)) {
    const m = JSON.parse(readFileSync(file, "utf-8")) as Mechanism;
    mechanisms.set(m.id, m);
  }

  // Cross-cutting perception (Step 5, D-066): every full record whose L0 parent
  // is flagged cross_cutting (today only S7) is emitted into EVERY pack as a
  // distinct top-level section — no pack-map entry, no per-element listing.
  // Empty until the S7 seeds are promoted to full records (the renderer never
  // reads _seed/).
  const taxonomy = JSON.parse(readFileSync(TAXONOMY, "utf-8")) as Taxonomy;
  const crossCuttingL0 = new Set(
    taxonomy.nodes.filter((n) => n.cross_cutting).map((n) => n.id),
  );
  const crossCuttingMechanisms = Array.from(mechanisms.values())
    .filter((m) => crossCuttingL0.has(m.parent))
    .sort((a, b) => a.id.localeCompare(b.id));
  const crossCuttingIds = new Set(crossCuttingMechanisms.map((m) => m.id));

  // Owner-authored interaction records (D-057) — the richer LAYER 2 source,
  // keyed by pairKey. Missing store = empty map = relations-only LAYER 2.
  const authoredInteractions = new Map<string, InteractionRecord>();
  if (existsSync(INTERACTIONS_DIR)) {
    for (const file of listJsonFiles(INTERACTIONS_DIR)) {
      if (file.endsWith("interaction.schema.json")) continue;
      const record = JSON.parse(readFileSync(file, "utf-8")) as InteractionRecord;
      authoredInteractions.set(pairKey(record.pair[0], record.pair[1]), record);
    }
  }

  const generated = new Set<string>();
  let voiceWarnings = 0;

  for (const element of packMap.elements) {
    if (packsFilter && !packsFilter.has(element.id)) continue;
    // Cross-cutting mechanisms are emitted automatically, never via the map, so
    // any that slip into an element's list are dropped from LAYER 1 (the
    // validator makes listing one an error; this keeps the projection honest
    // even if that guard is bypassed).
    const members = element.mechanisms
      .filter((id) => !crossCuttingIds.has(id))
      .map((id) => {
        const m = mechanisms.get(id);
        if (!m) throw new Error(`pack "${element.id}" references unknown mechanism "${id}"`);
        return m;
      });

    const sheet = buildDatasheet(element, members, crossCuttingMechanisms, authoredInteractions);
    const text = renderDatasheet(sheet);

    // Self-check 1: the emitted file must parse back as YAML.
    try {
      parseYaml(text);
    } catch (err) {
      throw new Error(`generated pack "${element.id}" is not valid YAML — ${(err as Error).message}`);
    }

    // Self-check 2: no instruction-voice tokens outside comments.
    const violations = voiceViolations(text);
    for (const line of violations) {
      voiceWarnings += 1;
      console.warn(`  ! pack-${element.id}.yaml instruction-voice token: ${line}`);
    }

    const target = join(PACKS_DIR, `pack-${element.id}.yaml`);
    writeFileSync(target, text, "utf-8");
    generated.add(`pack-${element.id}.yaml`);
    console.log(`  ✓ ${element.id} → ${rel(target)}`);
  }

  // Remove stale generated packs; never touch the hand-authored map or README.
  // Skipped on a scoped run — it cannot tell stale from simply-not-rendered.
  if (!packsFilter) {
    for (const entry of readdirSync(PACKS_DIR)) {
      if (!entry.startsWith("pack-") || !entry.endsWith(".yaml")) continue;
      if (entry === "pack-map.yaml") continue;
      if (!generated.has(entry)) {
        unlinkSync(join(PACKS_DIR, entry));
        console.log(`  ✗ removed stale pack packs/${entry}`);
      }
    }
  }

  // Export bundle (D-068): always rebuilt from the packs on disk, so scoped
  // runs keep the committed artifact complete and current.
  const bundled = writeExportBundle();
  console.log(`  ✓ bundle (${bundled} packs) → ${rel(EXPORT_BUNDLE)}`);

  console.log(
    `\nOK — ${generated.size} pack${generated.size === 1 ? "" : "s"} rendered` +
      (voiceWarnings > 0 ? ` (${voiceWarnings} instruction-voice warning(s))` : "") +
      ".",
  );
}

main();

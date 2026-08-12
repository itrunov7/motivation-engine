/**
 * tools/render-packs.ts — projects the pack map (/packs/pack-map.yaml), registry
 * (/registry/mechanisms/*.json, /dossiers/*.json), and first-class effects
 * (/effects/{mechanism}/{effect}.json) into one YAML datasheet per
 * Development-Plan element at /packs/pack-{id}.yaml (D-049, D-076).
 *
 * Packs are GENERATED projections, never hand-authored (same pattern as
 * render-cards, D-002): the only hand-written input is the pack map (D-048).
 * Change a registry record and re-render with `npm run packs`.
 *
 * The numbered ontology is explicit in the output: LAYER 1 mechanisms,
 * LAYER 2 first-class effects, and LAYER 3 realizations. Interactions and
 * context_weights remain separate unnumbered sections; neither is an ontology
 * level. hard_boundaries + signals + wiring follow.
 *
 * Cross-cutting perception (Step 5, D-066): every full record whose L0 parent
 * is flagged cross_cutting in registry/taxonomy.json (today only S7) is emitted
 * into EVERY pack as the distinct top-level section cross_cutting_perception,
 * separate from the pack's own motivational LAYER 1. The pack map never lists
 * these — inclusion is automatic. Empty until the S7 seeds become full records.
 * Non-cross-cutting candidate members may be declared in pack-map, but are
 * omitted from generated guidance until promotion (D-084).
 *
 * Interactions draw from TWO sources (D-057): owner-authored records
 * (/interactions/{A}__{B}.json) and registry relations. An authored record is
 * richer (type incl. suppressing/neutral, boundary, source) and REPLACES the
 * relation-derived entry for the same pair; relations still fill pairs with no
 * authored record.
 *
 * Two self-checks run before writing: every emitted file must parse back as
 * YAML, and knowledge prose (outside comments) may not carry instruction-voice
 * tokens (you / your / should / prefer). The directive sections — LAYER 3
 * realizations and the implementations that follow them — are exempt: a
 * realization `pattern` and an authored `generation_directive` are both
 * imperative by construction (D-175).
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
  Effect,
  EvidenceGrade,
  Implementation,
  InteractionRecord,
  Mechanism,
  PackContextWeight,
  PackDatasheet,
  PackEffect,
  PackInteraction,
  PackInteractionType,
  PackImplementation,
  PackMapElement,
  PackMapFile,
  PackMechanism,
  PackRealization,
  Realization,
  Relation,
  SeedStub,
  Taxonomy,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const MECHANISMS_DIR = join(ROOT, "registry", "mechanisms");
const SEED_DIR = join(MECHANISMS_DIR, "_seed");
const TAXONOMY = join(ROOT, "registry", "taxonomy.json");
const DOSSIERS_DIR = join(ROOT, "dossiers");
const EFFECTS_DIR = join(ROOT, "effects");
const REALIZATIONS_DIR = join(ROOT, "realizations");
const INTERACTIONS_DIR = join(ROOT, "interactions");
const PACKS_DIR = join(ROOT, "packs");
const PACK_MAP = join(PACKS_DIR, "pack-map.yaml");
const EXPORT_DIR = join(PACKS_DIR, "export");
const EXPORT_BUNDLE = join(EXPORT_DIR, "packs-bundle.yaml");

// Constant metadata blocks shared by every generated datasheet.
const NATURE =
  "knowledge base. L1/L2 facts with evidence strength; L3 preserves authored realization directives.";
const SIGNAL_TAG = "each generated element carries its mechanism id";
const SIGNAL_LEARNING =
  "weak/negative signal demotes a realization; strong signal spreads it — the palette evolves from outcomes";
const WIRING = {
  where: "planning stage of the Development Plan, when the planned element matches applies_to",
  how: "pack provides L1/L2 knowledge plus owner-authored L3 realization directives to the generator",
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

function listJsonFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsonFilesRecursive(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files.sort();
}

/** A single YAML scalar (quoted only when required), no trailing newline. */
function scalar(value: string): string {
  return stringifyYaml(value, { lineWidth: 0 }).replace(/\n+$/, "");
}

/** A flow sequence of identifier-like tokens (no quoting needed for our data). */
function flow(items: string[]): string {
  return `[${items.join(", ")}]`;
}

/** A flow sequence whose values may contain spaces or YAML punctuation. */
function scalarFlow(items: string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;
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
    forbidden: m.constraints.hard_rules.map((r) => r.id.replace(/_/g, "-")),
  };
}

// ---------- LAYER 2 — effects ----------

function buildEffect(effect: Effect): PackEffect {
  return {
    id: effect.id,
    mechanism_id: effect.mechanism_id,
    name: effect.name,
    fact: effect.fact,
    grade: effect.grade,
    source: effect.source,
    boundary: effect.boundary,
    realization_ids: effect.realization_ids,
  };
}

function effectsFor(
  mechanisms: Mechanism[],
  effectsByMechanism: Map<string, Map<string, Effect>>,
): PackEffect[] {
  const effects: PackEffect[] = [];
  for (const mechanism of mechanisms) {
    const indexed = effectsByMechanism.get(mechanism.id);
    for (const effectId of mechanism.effect_refs ?? []) {
      const effect = indexed?.get(effectId);
      if (!effect) {
        throw new Error(
          `mechanism "${mechanism.id}" references missing effect "${effectId}"`,
        );
      }
      effects.push(buildEffect(effect));
    }
  }
  return effects;
}

// ---------- LAYER 3 — descriptive realizations + authored implementations ----------

function buildImplementation(
  mechanismId: string,
  implementation: Implementation,
): PackImplementation {
  // copy_formulas is not spread through (rule 1, D-346): packs are evidence
  // with minimal assertion, and a pre-written string handed to every generator
  // verbatim is the copyable example the constitution forbids. It remains on
  // the registry record as owner reference — this function is the only seam
  // between that record and what a generator reads, so omitting it here is
  // where the rule is actually enforced.
  return {
    id: implementation.id,
    mechanism_id: mechanismId,
    ...(implementation.effect_id === undefined
      ? {}
      : { effect_id: implementation.effect_id }),
    ...(implementation.realization_ids === undefined
      ? {}
      : { realization_ids: implementation.realization_ids }),
    artifact_types: implementation.artifact_types,
    product_requirements: implementation.product_requirements,
    generation_directive: implementation.generation_directive,
    metrics: implementation.metrics,
    observed_effects: implementation.observed_effects,
  };
}

function implementationsFor(mechanisms: Mechanism[]): PackImplementation[] {
  return mechanisms.flatMap((mechanism) =>
    mechanism.implementations.map((implementation) =>
      buildImplementation(mechanism.id, implementation),
    ),
  );
}

export function realizationsFor(
  mechanisms: Mechanism[],
  realizationsByMechanism: Map<string, Realization[]>,
): PackRealization[] {
  return mechanisms.flatMap((mechanism) =>
    (realizationsByMechanism.get(mechanism.id) ?? []).map((realization) => ({
      id: realization.id,
      mechanism_id: realization.mechanism_id,
      // The pack datasheet carries one effect per realization; effect_refs is a
      // list, so the first ref is projected and the rest stay in the record
      // (D-112). No current realization declares more than one.
      ...(realization.effect_refs?.[0] === undefined
        ? {}
        : { effect_id: realization.effect_refs[0] }),
      // Carried through in full, not truncated to one like effect_id above: a
      // boundary reference is a caution list a generator should see all of,
      // not a claim needing exactly one citation (D-348).
      ...(realization.boundary_refs === undefined || realization.boundary_refs.length === 0
        ? {}
        : { boundary_refs: realization.boundary_refs }),
      term: realization.term,
      description_as_reported: realization.description_as_reported,
      // The transfer itself (D-175). Each is spread conditionally, using the
      // same idiom as effect_id above, because all four are optional on the
      // record: a "reported" realization transfers nothing and declares none of
      // them. Emitting `derivation: undefined` would be worse than omitting it —
      // parseYaml reads that back as the STRING "undefined", so the pack's
      // re-parse self-check would not catch it.
      ...(realization.derivation === undefined
        ? {}
        : { derivation: realization.derivation }),
      ...(realization.domain_transfer === undefined
        ? {}
        : { domain_transfer: realization.domain_transfer }),
      ...(realization.pattern === undefined ? {} : { pattern: realization.pattern }),
      ...(realization.parameters === undefined
        ? {}
        : { parameters: realization.parameters }),
      artifact_context: realization.artifact_context,
      confidence: realization.confidence,
      source_record_ids: realization.provenance.map((item) => item.corpus_record_id),
    })),
  );
}

// ---------- interactions (separate from ontology levels) ----------

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

// ---------- context weights (separate from ontology levels) ----------

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
 *
 * Quoted spans are stripped before that check. EN-03's real_ownership_only
 * reads "...do not fabricate 'your' where nothing was invested" — third-person
 * policy prose that MENTIONS the word 'your' as the quoted example of the
 * fabricated copy it forbids, not an instruction addressed to a reader. Without
 * this, the sole occurrence of any voice token in the whole registry (verified
 * by grep) collapsed a real rule to a bare "forbidden" with no text at all.
 */
function boundaryReason(rule: string): string {
  const text = rule.trim().replace(/^(?:do not|don't|never)\s+/i, "");
  const withoutQuotes = text.replace(/'[^']*'|"[^"]*"/g, "");
  if (VOICE_TOKENS.test(withoutQuotes)) return "forbidden";
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
  effectsByMechanism: Map<string, Map<string, Effect>>,
  realizationsByMechanism: Map<string, Realization[]>,
): PackDatasheet {
  const gradeOf = new Map(members.map((m) => [m.id, m.evidence.grade] as const));
  const ontologyMechanisms = [...members, ...crossCutting];
  return {
    pack: element.id,
    applies_to: element.applies_to,
    funnel_stage: element.funnel_stage,
    version: PACK_MAP_VERSION,
    nature: NATURE,
    source: `projection of registry records, first-class effects, and source-grounded realizations for ${ontologyMechanisms.map((m) => m.id).join(" ")}`,
    mechanisms: members.map((m) => buildMechanism(m, loadDossier(m.id))),
    cross_cutting_perception: crossCutting.map((m) => buildMechanism(m, loadDossier(m.id))),
    effects: effectsFor(ontologyMechanisms, effectsByMechanism),
    realizations: realizationsFor(ontologyMechanisms, realizationsByMechanism),
    implementations: implementationsFor(ontologyMechanisms),
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
    `    forbidden: ${flow(pm.forbidden)}`,
    "",
  ];
}

function renderEffect(effect: PackEffect): string[] {
  return [
    `  - id: ${effect.id}`,
    `    mechanism_id: ${effect.mechanism_id}`,
    `    name: ${scalar(effect.name)}`,
    `    fact: ${scalar(effect.fact)}`,
    `    grade: ${effect.grade}`,
    `    source: ${scalarFlow(effect.source)}`,
    `    boundary: ${scalar(effect.boundary)}`,
    `    realization_ids: ${flow(effect.realization_ids)}`,
    "",
  ];
}

export function renderRealization(realization: PackRealization): string[] {
  const lines = [
    `  - id: ${realization.id}`,
    `    mechanism_id: ${realization.mechanism_id}`,
  ];
  if (realization.effect_id !== undefined) {
    lines.push(`    effect_id: ${realization.effect_id}`);
  }
  lines.push(
    `    term: ${scalar(realization.term)}`,
    `    description_as_reported: ${scalar(realization.description_as_reported)}`,
  );
  // The transferred half (D-175), each guarded because a "reported" realization
  // declares none of them. Order mirrors the record: what the source said, then
  // the transfer, then where it applies.
  if (realization.derivation !== undefined) {
    lines.push(`    derivation: ${realization.derivation}`);
  }
  if (realization.domain_transfer !== undefined) {
    // A flow map: the pair reads as the one transfer it describes, and both
    // values go through scalar() so a domain naming a colon or a brace cannot
    // break the document.
    lines.push(
      `    domain_transfer: { source_domain: ${scalar(realization.domain_transfer.source_domain)}, ` +
        `application_domain: ${scalar(realization.domain_transfer.application_domain)} }`,
    );
  }
  if (realization.pattern !== undefined) {
    // scalar() quotes only when YAML requires it, which matters here: a pattern
    // may open with a {placeholder}, and a bare leading brace would parse as a
    // flow mapping rather than as text.
    lines.push(`    pattern: ${scalar(realization.pattern)}`);
  }
  if (realization.parameters !== undefined && realization.parameters.length > 0) {
    // A block sequence, because each parameter is a record. The declared default
    // and its unit travel with the placeholder they explain — the pattern text
    // shows only `{name}`, so without these the number is unreadable (D-115).
    lines.push("    parameters:");
    for (const parameter of realization.parameters) {
      lines.push(
        `      - name: ${parameter.name}`,
        `        value: ${parameter.value}`,
        `        unit: ${scalar(parameter.unit)}`,
        `        evidence_basis: ${scalar(parameter.evidence_basis)}`,
      );
    }
  }
  if (realization.boundary_refs !== undefined && realization.boundary_refs.length > 0) {
    // Effects to read the pattern AGAINST, not effects it embodies (D-348) —
    // e.g. an opposing or harm effect on the same mechanism. Rendered next to
    // pattern/parameters, the block it qualifies, rather than buried after
    // artifact_context.
    lines.push(`    boundary_refs: ${flow(realization.boundary_refs)}`);
  }
  lines.push(
    `    artifact_context: ${scalarFlow(realization.artifact_context)}`,
    `    confidence: ${realization.confidence}`,
    `    source_record_ids: ${flow(realization.source_record_ids)}`,
    "",
  );
  return lines;
}

function renderImplementation(implementation: PackImplementation): string[] {
  const lines = [
    `  - id: ${implementation.id}`,
    `    mechanism_id: ${implementation.mechanism_id}`,
  ];
  if (implementation.effect_id !== undefined) {
    lines.push(`    effect_id: ${implementation.effect_id}`);
  }
  if (implementation.realization_ids !== undefined) {
    lines.push(`    realization_ids: ${flow(implementation.realization_ids)}`);
  }
  lines.push(
    `    artifact_types: ${flow(implementation.artifact_types)}`,
    `    product_requirements: ${scalarFlow(implementation.product_requirements)}`,
    `    generation_directive: ${scalar(implementation.generation_directive)}`,
    `    metrics: ${flow(implementation.metrics)}`,
    `    observed_effects: ${scalarFlow(implementation.observed_effects)}`,
    "",
  );
  return lines;
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
    "# Source: packs/pack-map.yaml + registry/mechanisms/*.json + effects/*/*.json",
    "#         + dossiers/*.json + interactions/*.json · regenerate with `npm run packs` (D-049, D-076).",
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
    "# LAYER 2 — EFFECTS (first-class scientific phenomena)",
    BANNER,
    "effects:",
    "",
  );
  if (sheet.effects.length === 0) {
    lines.push(
      "  [] # no approved first-class effects referenced by this pack's mechanisms",
      "",
    );
  } else {
    for (const effect of sheet.effects) lines.push(...renderEffect(effect));
  }

  lines.push(
    BANNER,
    "# LAYER 3 — REALIZATIONS (source-grounded evidence palette)",
    BANNER,
    "realizations:",
    "",
  );
  if (sheet.realizations.length === 0) {
    lines.push(
      "  [] # no approved source-grounded realizations exist for this pack",
      "",
    );
  } else {
    for (const realization of sheet.realizations) {
      lines.push(...renderRealization(realization));
    }
  }

  lines.push(
    BANNER,
    "# IMPLEMENTATIONS (product-authored generator directives)",
    BANNER,
    "implementations:",
    "",
  );
  if (sheet.implementations.length === 0) {
    lines.push("  [] # no product-authored implementation directives", "");
  } else {
    for (const implementation of sheet.implementations) {
      lines.push(...renderImplementation(implementation));
    }
  }

  lines.push(
    BANNER,
    "# INTERACTIONS (separate relationship records; not ontology L2)",
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
    "# CONTEXT WEIGHTS (separate contextual dimension; not ontology L3)",
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

/**
 * Instruction voice is forbidden in KNOWLEDGE prose and expected in directives.
 *
 * The exempt window opens at `realizations:` and closes at `interactions:`,
 * covering LAYER 3 and the implementations section between them. It used to open
 * at `implementations:`, which left realizations scanned — harmless while L3 was
 * description-only, and wrong the moment it began carrying `pattern` (D-175). A
 * pattern is a directive by construction: it names the element, the trigger and
 * what changes. Warning on it would fire on correct output, and a check that
 * cries wolf is a check nobody reads.
 *
 * Mechanisms, effects, boundaries and the wiring notes stay scanned, which is
 * the part that matters — those are the claims, and a claim written in the
 * second person has stopped being evidence.
 */
function voiceViolations(text: string): string[] {
  const violations: string[] = [];
  let inDirectiveSection = false;
  for (const line of text.split("\n")) {
    if (line === "realizations:") inDirectiveSection = true;
    if (line === "interactions:") inDirectiveSection = false;
    if (
      !inDirectiveSection &&
      !line.trimStart().startsWith("#") &&
      VOICE_TOKENS.test(line)
    ) {
      violations.push(line.trim());
    }
  }
  return violations;
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
  const candidateIds = new Set<string>();
  if (existsSync(SEED_DIR)) {
    for (const file of listJsonFiles(SEED_DIR)) {
      const stub = JSON.parse(readFileSync(file, "utf-8")) as SeedStub;
      candidateIds.add(stub.id);
    }
  }

  // First-class L2 effects (D-076), indexed under their owning L1 mechanism.
  // The renderer follows mechanism.effect_refs; tools/validate.ts enforces the
  // reciprocal mechanism/effect/realization links before data enters the repo.
  const effectsByMechanism = new Map<string, Map<string, Effect>>();
  for (const file of listJsonFilesRecursive(EFFECTS_DIR)) {
    if (file.endsWith("effect.schema.json")) continue;
    const effect = JSON.parse(readFileSync(file, "utf-8")) as Effect;
    const indexed =
      effectsByMechanism.get(effect.mechanism_id) ?? new Map<string, Effect>();
    indexed.set(effect.id, effect);
    effectsByMechanism.set(effect.mechanism_id, indexed);
  }

  const realizationsByMechanism = new Map<string, Realization[]>();
  for (const file of listJsonFilesRecursive(REALIZATIONS_DIR)) {
    if (file.endsWith("realization.schema.json")) continue;
    const realization = JSON.parse(readFileSync(file, "utf-8")) as Realization;
    const indexed = realizationsByMechanism.get(realization.mechanism_id) ?? [];
    indexed.push(realization);
    indexed.sort((a, b) => a.id.localeCompare(b.id));
    realizationsByMechanism.set(realization.mechanism_id, indexed);
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

  // Owner-authored interaction records (D-057) — the richer interaction source,
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
      .flatMap((id) => {
        const m = mechanisms.get(id);
        if (m) return [m];
        if (candidateIds.has(id)) return [];
        throw new Error(`pack "${element.id}" references unknown mechanism "${id}"`);
      });

    const sheet = buildDatasheet(
      element,
      members,
      crossCuttingMechanisms,
      authoredInteractions,
      effectsByMechanism,
      realizationsByMechanism,
    );
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

// Guarded so the projection can be imported and unit-tested without running the
// renderer (D-175). Importing this module used to render and WRITE every pack,
// which is why realizationsFor had no test — and why the dropped fields went
// unnoticed. Matches tools/extract.ts.
if (require.main === module) {
  main();
}

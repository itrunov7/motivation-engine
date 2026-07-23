/**
 * Actions-only corpus extraction pipeline (D-075/D-078).
 *
 * Usage:
 *   npm run extract -- quote mode=effects mechanism=CL-14
 *   npm run extract -- run mode=realizations pack=entry
 *   npm run extract -- run mode=dissent segment=mobile-app
 *
 * A run reads harvested evidence, asks OpenRouter for one grounded task type,
 * rejects every item whose citations cannot be verified against the supplied
 * title/abstract, deduplicates it, and writes pending proposals only.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import {
  computeBudgetSnapshot,
  extractionPriceState,
  loadExtractionOpsConfigFromDisk,
  validateExtractionOpsConfig,
} from "../lib/ops";
import {
  groundingErrors,
  hasNovelEnrichment,
  mergeProposals,
  normalizeQualityText,
  proposalSimilarity,
  realizationGroundingErrors,
} from "../lib/proposal-quality";
import { writeRunProgress } from "./progress";
import type {
  ArtifactType,
  AxisScore,
  CorpusManifest,
  CorpusManifestCost,
  CorpusManifestRun,
  DossierDraftAxis,
  DossierDraftPayload,
  DossierEvidenceSource,
  EvidenceCorpusFile,
  EvidenceCorpusRecord,
  EvidenceGrade,
  EvidenceProvenanceItem,
  ExtractionModelTierConfig,
  ExtractionOpsConfig,
  HardRule,
  Implementation,
  KnowledgeProvenanceItem,
  Mechanism,
  PackMapFile,
  Proposal,
  ReaderCoverageFile,
  Realization,
  RealizationCorpusFile,
  RealizationCorpusRecord,
  RealizationCorpusProvenanceItem,
  Relation,
  Segment,
  SeedStub,
  SegmentsFile,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const CORPUS_DIR = join(ROOT, "corpora", "evidence");
const REALIZATION_CORPUS_DIR = join(ROOT, "corpora", "realizations");
const PROPOSALS_DIR = join(ROOT, "proposals");
const EXTRACTION_DIR = join(ROOT, "corpora", "extraction");
const MANIFEST_FILE = join(EXTRACTION_DIR, "manifest.json");
const READER_COVERAGE_FILE = join(EXTRACTION_DIR, "coverage.json");
const QUOTE_FILE = join(ROOT, "quote.json");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ABSTRACT_LIMIT = 6000;
const CHEAP_OUTPUT_RESERVE = 6000;
const STRONG_OUTPUT_RESERVE = 10000;

export const EXTRACTION_MODES = [
  "effects",
  "realizations",
  "interactions",
  "dissent",
  "mechanism",
  "dossier",
] as const;
export type ExtractionMode = (typeof EXTRACTION_MODES)[number];
export type ScopeKind = "mechanism" | "pack" | "segment";

/** Modes that draft a whole first-time artifact for a seed candidate (D-085). */
export function isDraftMode(mode: ExtractionMode): mode is "mechanism" | "dossier" {
  return mode === "mechanism" || mode === "dossier";
}

export interface ExtractionScope {
  kind: ScopeKind;
  id: string;
  mechanismIds: string[];
}

export interface ExtractionQuote {
  mode: ExtractionMode;
  scope: { kind: ScopeKind; id: string; mechanism_ids: string[] };
  calls: { cheap: number; strong: number; total: number };
  tokens: { input_upper_bound: number; output_reserved: number; total_upper_bound: number };
  estimated_usd: number;
  caps: { per_run_tokens: number; monthly_tokens: number };
  allowed: boolean;
  reasons: string[];
  prices_verified_on: string | null;
  price_state: "unconfigured" | "current" | "stale";
  generated_at: string;
}

interface CitationDraft {
  record_id: string;
  quote_or_locus: string;
}

interface ImplementationDraft {
  id_suffix?: string;
  artifact_types?: string[];
  product_requirements?: string[];
  generation_directive?: string;
  copy_formulas?: string[];
  metrics?: string[];
}

interface HardRuleDraft {
  id?: string;
  rule?: string;
  severity?: string;
}

interface PreconditionDraft {
  predicate?: string;
  reason?: string;
}

interface RelationDraft {
  type?: string;
  target?: string;
  note?: string;
}

interface ReferenceExampleDraft {
  product?: string;
  what?: string;
}

interface DossierAxisDraft {
  score?: number | null;
  rationale?: string | null;
  citations?: CitationDraft[];
}

interface DraftItem {
  id?: string;
  name?: string;
  fact?: string;
  boundary?: string;
  grade?: string;
  term?: string;
  description_as_reported?: string;
  artifact_context?: string[];
  effect_id?: string;
  pair?: string[];
  type?: string;
  source?: string;
  value?: string;
  confidence?: number;
  citations?: CitationDraft[];
  /** mode=mechanism (D-085): full-record draft fields. */
  section?: string;
  summary?: string;
  evidence_basis?: string;
  effect_size_note?: string;
  caveats?: string[];
  funnel_stages?: string[];
  excluded_stages?: string[];
  applicability_artifact_types?: string[];
  preconditions?: PreconditionDraft[];
  culture_note?: string;
  implementations?: ImplementationDraft[];
  hard_rules?: HardRuleDraft[];
  compliance_refs?: string[];
  boundary_test?: string;
  relations?: RelationDraft[];
  reference_examples?: ReferenceExampleDraft[];
  /** mode=dossier (D-085): full dossier draft fields. */
  scores?: Record<string, DossierAxisDraft>;
  core_condition?: string;
  dissent?: string;
}

interface DraftResponse {
  items: DraftItem[];
}

export interface ExtractionStats {
  candidates: number;
  dropped_ungrounded: number;
  proposed: number;
  merged: number;
  held_low_confidence: number;
  dropped_volume_cap: number;
  dropped_volume_cap_high_confidence: number;
}

export function mergeReaderCoverage(
  previous: ReaderCoverageFile | null,
  mode: ExtractionMode,
  processed: ReadonlyMap<string, readonly string[]>,
  processedAt: string,
): ReaderCoverageFile {
  const kind = mode === "realizations" ? "realization" : "evidence";
  const mechanisms = structuredClone(previous?.mechanisms ?? {});
  for (const [mechanismId, recordIds] of Array.from(processed.entries())) {
    const mechanism = mechanisms[mechanismId] ?? {};
    const prior = mechanism[kind];
    mechanism[kind] = {
      processed_record_ids: Array.from(
        new Set([...(prior?.processed_record_ids ?? []), ...recordIds]),
      ).sort(),
      processed_at: processedAt,
      modes: Array.from(new Set([...(prior?.modes ?? []), mode])).sort(),
    };
    mechanisms[mechanismId] = mechanism;
  }
  return {
    version: "1.0.0",
    updated_at: processedAt,
    mechanisms,
  };
}

function writeReaderCoverage(
  mode: ExtractionMode,
  processed: ReadonlyMap<string, readonly string[]>,
  processedAt: string,
): void {
  mkdirSync(EXTRACTION_DIR, { recursive: true });
  const previous = existsSync(READER_COVERAGE_FILE)
    ? readJson<ReaderCoverageFile>(READER_COVERAGE_FILE)
    : null;
  writeFileSync(
    READER_COVERAGE_FILE,
    json(mergeReaderCoverage(previous, mode, processed, processedAt)),
  );
}

export function extractionSummaryParams(
  stats: ExtractionStats,
): Record<string, string> {
  return {
    candidates: String(stats.candidates),
    proposed: String(stats.proposed),
    merged: String(stats.merged),
    dropped_ungrounded: String(stats.dropped_ungrounded),
    held_low_confidence: String(stats.held_low_confidence),
    dropped_volume_cap: String(stats.dropped_volume_cap),
    dropped_volume_cap_high_confidence: String(
      stats.dropped_volume_cap_high_confidence,
    ),
  };
}

export interface Usage {
  input: number;
  output: number;
  calls: number;
  byTier: Record<"cheap" | "strong", { input: number; output: number; calls: number }>;
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface RunContext {
  config: ExtractionOpsConfig;
  usage: Usage;
  fetcher: typeof fetch;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function listJsonRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? listJsonRecursive(path)
      : entry.isFile() && entry.name.endsWith(".json")
        ? [path]
        : [];
  });
}

function parseParams(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of args) {
    const at = arg.indexOf("=");
    if (at < 1 || at === arg.length - 1) {
      throw new Error(`Invalid argument "${arg}"; expected key=value`);
    }
    result[arg.slice(0, at)] = arg.slice(at + 1);
  }
  return result;
}

function isMode(value: string | undefined): value is ExtractionMode {
  return EXTRACTION_MODES.includes(value as ExtractionMode);
}

function fullMechanisms(): Map<string, Mechanism> {
  const result = new Map<string, Mechanism>();
  for (const file of listJson(join(ROOT, "registry", "mechanisms"))) {
    const mechanism = readJson<Mechanism>(file);
    result.set(mechanism.id, mechanism);
  }
  return result;
}

function seedStubs(): Map<string, SeedStub> {
  const result = new Map<string, SeedStub>();
  for (const file of listJson(join(ROOT, "registry", "mechanisms", "_seed"))) {
    const stub = readJson<SeedStub>(file);
    result.set(stub.id, stub);
  }
  return result;
}

/**
 * Whether this mode can produce work for the mechanism (D-085): draft modes
 * target first-time artifacts only — a mechanism that already has a full
 * record (mode=mechanism) or a dossier (mode=dossier) is skipped, never
 * overwritten. Non-draft modes are always eligible.
 */
function modeEligible(mode: ExtractionMode, mechanismId: string): boolean {
  if (mode === "mechanism") {
    return !existsSync(join(ROOT, "registry", "mechanisms", `${mechanismId}.json`));
  }
  if (mode === "dossier") {
    return !existsSync(join(ROOT, "dossiers", `${mechanismId}.json`));
  }
  return true;
}

export function resolveScope(
  params: Record<string, string>,
  options: { includeSeeds?: boolean } = {},
): ExtractionScope {
  const supplied = (["mechanism", "pack", "segment"] as const).filter(
    (key) => params[key],
  );
  if (supplied.length !== 1) {
    throw new Error("Provide exactly one scope: mechanism=, pack=, or segment=");
  }
  const kind = supplied[0];
  const id = params[kind];
  const mechanisms = fullMechanisms();
  const crossCutting = Array.from(mechanisms.values())
    .filter((mechanism) => mechanism.cross_cutting === true)
    .map((mechanism) => mechanism.id);
  // Draft modes (mechanism/dossier) target seed candidates too: a first-time
  // record or dossier is exactly what a stub is missing (D-085).
  const known = new Set(mechanisms.keys());
  if (options.includeSeeds) {
    for (const seedId of Array.from(seedStubs().keys())) known.add(seedId);
  }

  let mechanismIds: string[];
  if (kind === "mechanism") {
    if (!known.has(id)) {
      throw new Error(
        options.includeSeeds
          ? `Unknown mechanism or seed candidate "${id}"`
          : `Unknown full mechanism "${id}"`,
      );
    }
    mechanismIds = [id];
  } else {
    const packMap = parseYaml(
      readFileSync(join(ROOT, "packs", "pack-map.yaml"), "utf8"),
    ) as PackMapFile;
    if (kind === "pack") {
      const pack = packMap.elements.find((item) => item.id === id);
      if (!pack) throw new Error(`Unknown pack "${id}"`);
      mechanismIds = [...pack.mechanisms, ...crossCutting];
    } else {
      const segments = parseYaml(
        readFileSync(join(ROOT, "segments", "segments.yaml"), "utf8"),
      ) as SegmentsFile;
      const segment = segments.segments.find(
        (item: Segment) => item.id === id && item.status === "active",
      );
      if (!segment) throw new Error(`Unknown active segment "${id}"`);
      mechanismIds = [
        ...packMap.elements.flatMap((element) => element.mechanisms),
        ...crossCutting,
      ];
    }
  }
  mechanismIds = Array.from(new Set(mechanismIds))
    .filter((mechanismId) => known.has(mechanismId))
    .sort();
  return { kind, id, mechanismIds };
}

type ExtractionCorpus = EvidenceCorpusFile | RealizationCorpusFile;
type ExtractionRecord = EvidenceCorpusRecord | RealizationCorpusRecord;

function isRealizationCorpus(corpus: ExtractionCorpus): corpus is RealizationCorpusFile {
  return "updated_at" in corpus;
}

function isRealizationRecord(
  record: ExtractionRecord,
): record is RealizationCorpusRecord {
  return "observation" in record;
}

function corpusFor(mode: ExtractionMode, mechanismId: string): ExtractionCorpus {
  const path =
    mode === "realizations"
      ? join(REALIZATION_CORPUS_DIR, mechanismId, "records.json")
      : join(CORPUS_DIR, `${mechanismId}.json`);
  if (!existsSync(path) && mode === "realizations") {
    return {
      mechanism_id: mechanismId,
      updated_at: "1970-01-01T00:00:00.000Z",
      records: [],
    };
  }
  if (!existsSync(path)) throw new Error(`Missing harvested corpus ${path}`);
  return readJson<ExtractionCorpus>(path);
}

function eligibleRecords(corpus: ExtractionCorpus): ExtractionRecord[] {
  return corpus.records
    .filter(
      (record) =>
        typeof record.record_id === "string" &&
        record.record_id.length > 0 &&
        (isRealizationRecord(record)
          ? record.observation.trim().length > 0
          : typeof record.abstract === "string" && record.abstract.trim().length > 0),
    )
    .sort((a, b) => a.record_id.localeCompare(b.record_id));
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function compactRecord(record: ExtractionRecord): object {
  if (isRealizationRecord(record)) {
    return {
      record_id: record.record_id,
      title: record.title,
      observation: record.observation.slice(0, ABSTRACT_LIMIT),
      source_id: record.source_id,
      source_url: record.source_url,
      source_locator: record.source_locator,
      observed_at: record.observed_at,
      artifact_context: record.artifact_context,
      origin: record.origin,
      contributed_by: record.contributed_by,
    };
  }
  return {
    record_id: record.record_id,
    title: record.title,
    abstract: record.abstract?.slice(0, ABSTRACT_LIMIT),
    authors: record.authors,
    year: record.year,
    venue: record.venue,
    doi: record.doi,
    citations: record.citations,
    categories: record.categories,
    search_angles: record.search_angles ?? [],
  };
}

const FUNNEL_STAGES = [
  "cold_acquisition",
  "onboarding",
  "activation",
  "conversion",
  "retention",
  "reactivation",
] as const;

const ARTIFACT_TYPES: readonly ArtifactType[] = [
  "paywall",
  "cancellation_flow",
  "retention_push",
  "checkout",
  "email",
  "pricing_page",
  "dashboard_widget",
  "onboarding",
  "landing_hero",
];

const DOSSIER_AXES = [
  "evidence",
  "product_applicability",
  "measurability",
  "orthogonality",
  "safety",
] as const;

function taskInstruction(mode: ExtractionMode, mechanismId: string): string {
  const locus =
    mode === "realizations"
      ? "a supplied title or observation"
      : "a supplied title or abstract";
  const shared = `Return JSON {"items":[]}. Every item must include citations [{record_id,quote_or_locus}] using only supplied records. quote_or_locus must be an exact span from ${locus}. If an item cannot be grounded, omit it.`;
  switch (mode) {
    case "effects":
      return `${shared} Extract distinct named phenomena produced by ${mechanismId}. Fields: id, name, fact, boundary, grade (A+..C-), confidence, citations.`;
    case "realizations":
      return `${shared} Extract concrete interface, copy, or flow embodiments reported in sources for ${mechanismId}. Use neutral descriptive language. Fields: id, term, description_as_reported, artifact_context (strings), optional effect_id, confidence, citations.`;
    case "interactions":
      return `${shared} Extract only pairs of known mechanism ids explicitly treated together. Fields: pair (two sorted mechanism ids), type (sequence-amplifying|reinforcing|suppressing|neutral), fact, grade, boundary, source, confidence, citations.`;
    case "dissent":
      return `${shared} Extract critiques, failed replications, null findings, and boundary findings for ${mechanismId}. Fields: value (concise markdown), confidence, citations.`;
    case "mechanism":
      return `${shared} Extract record-drafting claims about the motivation mechanism ${mechanismId}: what it is and predicts (section=summary), the strength and basis of the evidence including effect sizes (section=evidence), caveats, boundary conditions and failed replications (section=caveat), where and how interfaces embody it (section=implementation), what outcomes are measured (section=measurement), and misuse, harm or dark-pattern boundaries (section=risk). Fields: section, fact, confidence, citations.`;
    case "dossier":
      return `${shared} Extract evaluative observations for scoring the mechanism ${mechanismId}: strength and breadth of evidence (section=evidence), applicability to product interfaces (section=product_applicability), how measurable its predicted outcomes are (section=measurability), how distinct it is from neighbouring constructs (section=orthogonality), harms, ethics and misuse boundaries (section=safety), counter-evidence, critiques and null findings (section=dissent), and measured-outcome conditions (section=core_condition). Fields: section, fact, confidence, citations.`;
  }
}

function synthesisInstruction(mode: ExtractionMode, mechanismId: string): string {
  const noInvention =
    "Do not add a claim or citation that is not supported by the candidates.";
  switch (mode) {
    case "mechanism":
      return [
        `Return JSON {"items":[]} with EXACTLY ONE item composing a full mechanism record draft for ${mechanismId} from the candidate claims. ${noInvention} Every citation must be copied verbatim from a candidate.`,
        "Item fields:",
        `summary (2-4 sentences of generation-facing prose stating what the mechanism does to behaviour and what that implies for interfaces); grade (A+..C-, conservative); evidence_basis (what kinds of studies establish it); effect_size_note; caveats (snake_case strings); funnel_stages (subset of ${FUNNEL_STAGES.join("|")}); excluded_stages (same vocabulary); applicability_artifact_types (subset of ${ARTIFACT_TYPES.join("|")}); preconditions [{predicate,reason}] (predicate as a machine-readable condition, e.g. "artifact.has_choice == true"); culture_note; implementations (1-3 of {id_suffix (kebab-case), artifact_types (subset of the same vocabulary), product_requirements (strings), generation_directive (imperative prose for a generator), copy_formulas (strings), metrics (non-empty measurable product metrics)}); hard_rules (1+ of {id (snake_case), rule, severity block|warn}) covering misuse and dark-pattern boundaries reported in the sources; compliance_refs (strings); boundary_test (one question separating legitimate use from manipulation); relations (only mechanism ids explicitly treated together in the records: {type enabled_by|enables|adjacent|hybrid_with, target, note}); reference_examples [{product, what}] only if reported in sources; confidence; citations (the grounded union backing summary, evidence and caveats).`,
      ].join("\n");
    case "dossier":
      return [
        `Return JSON {"items":[]} with EXACTLY ONE item composing a full dossier draft for ${mechanismId} from the candidate observations. ${noInvention} Every citation must be copied verbatim from a candidate.`,
        `Item fields: scores — an object with keys ${DOSSIER_AXES.join(", ")}, each {score (integer 0-3), rationale (markdown justification arguing from the cited evidence), citations}; core_condition (the measured condition under which the mechanism could be promoted, grounded in what the sources measure); dissent (markdown documenting counter-evidence, critiques, failed replications and boundary findings — a dossier that can only confirm is broken); confidence; citations (the grounded union backing dissent and core_condition).`,
        "HARD RULE: if the candidates do not ground a rationale for an axis, emit that axis as {score:null, rationale:null, citations:[]} — never guess a score. Score conservatively from the cited evidence only.",
      ].join("\n");
    default:
      return [
        taskInstruction(mode, mechanismId),
        "Synthesize the candidate list: merge true duplicates, preserve all valid citations, remove contradictions that the cited text does not establish, and grade conservatively. Do not add a claim or citation.",
      ].join("\n\n");
  }
}

function cheapPrompt(
  mode: ExtractionMode,
  mechanismId: string,
  records: ExtractionRecord[],
): string {
  return `${taskInstruction(mode, mechanismId)}\n\nRECORDS:\n${JSON.stringify(
    records.map(compactRecord),
  )}`;
}

function strongPrompt(
  mode: ExtractionMode,
  mechanismId: string,
  candidates: DraftItem[],
): string {
  return [
    synthesisInstruction(mode, mechanismId),
    `CANDIDATES:\n${JSON.stringify(candidates)}`,
  ].join("\n\n");
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function configuredTier(
  config: ExtractionOpsConfig,
  tierName: "cheap" | "strong",
): ExtractionModelTierConfig & {
  model_id: string;
  input_usd_per_token: number;
  output_usd_per_token: number;
} {
  const tier = config.tiers[tierName];
  if (
    tier.model_id === null ||
    tier.input_usd_per_token === null ||
    tier.output_usd_per_token === null
  ) {
    throw new Error(
      `Extraction tier "${tierName}" is unconfigured in corpora/_ops/extraction.json`,
    );
  }
  return {
    ...tier,
    model_id: tier.model_id,
    input_usd_per_token: tier.input_usd_per_token,
    output_usd_per_token: tier.output_usd_per_token,
  };
}

function monthTokenUsage(now: Date = new Date()): number {
  if (!existsSync(MANIFEST_FILE)) return 0;
  const manifest = readJson<CorpusManifest>(MANIFEST_FILE);
  const month = now.toISOString().slice(0, 7);
  return (manifest.run_history ?? [])
    .filter((run) => run.timestamp.slice(0, 7) === month)
    .reduce(
      (sum, run) =>
        sum + (run.cost?.tokens_in ?? 0) + (run.cost?.tokens_out ?? 0),
      0,
    );
}

export function buildQuote(
  mode: ExtractionMode,
  scope: ExtractionScope,
  config: ExtractionOpsConfig,
  now: Date = new Date(),
): ExtractionQuote {
  const cheap = configuredTier(config, "cheap");
  const strong = configuredTier(config, "strong");
  const reasons: string[] = [];
  const priceState = extractionPriceState(config, now);
  if (priceState === "unconfigured") reasons.push("model pricing verification date is missing");
  let cheapCalls = 0;
  let inputUpper = 0;
  let mechanismsWithRecords = 0;
  for (const mechanismId of scope.mechanismIds) {
    if (!modeEligible(mode, mechanismId)) continue;
    const records = eligibleRecords(corpusFor(mode, mechanismId));
    if (records.length === 0) continue;
    mechanismsWithRecords += 1;
    for (const batch of batches(records, config.limits.records_per_batch)) {
      cheapCalls += 1;
      inputUpper += bytes(cheapPrompt(mode, mechanismId, batch));
    }
    // Strong synthesis receives at most the cheap calls' reserved output.
    inputUpper += Math.min(
      cheapCalls * CHEAP_OUTPUT_RESERVE * 4,
      strong.max_tokens_per_call * 4,
    );
  }
  const strongCalls = mechanismsWithRecords;
  const outputReserved =
    cheapCalls * Math.min(CHEAP_OUTPUT_RESERVE, cheap.max_tokens_per_call) +
    strongCalls * Math.min(STRONG_OUTPUT_RESERVE, strong.max_tokens_per_call);
  const totalUpper = inputUpper + outputReserved;
  const estimatedUsd =
    inputUpper * Math.max(cheap.input_usd_per_token, strong.input_usd_per_token) +
    cheapCalls *
      Math.min(CHEAP_OUTPUT_RESERVE, cheap.max_tokens_per_call) *
      cheap.output_usd_per_token +
    strongCalls *
      Math.min(STRONG_OUTPUT_RESERVE, strong.max_tokens_per_call) *
      strong.output_usd_per_token;
  const budget = computeBudgetSnapshot(now);
  if (totalUpper > config.limits.per_run_tokens) {
    reasons.push(
      `upper-bound ${totalUpper} tokens exceeds per-run cap ${config.limits.per_run_tokens}`,
    );
  }
  const monthlyUsed = monthTokenUsage(now);
  if (monthlyUsed + totalUpper > config.limits.monthly_tokens) {
    reasons.push(
      `upper-bound run would exceed monthly token cap (${monthlyUsed}+${totalUpper} > ${config.limits.monthly_tokens})`,
    );
  }
  if (budget.used.usd + estimatedUsd > budget.caps.usd) {
    reasons.push(
      `estimated $${estimatedUsd.toFixed(6)} would exceed monthly USD cap ($${budget.used.usd} used of $${budget.caps.usd})`,
    );
  }
  if (budget.used.calls + cheapCalls + strongCalls > budget.caps.calls) {
    reasons.push(
      `estimated ${cheapCalls + strongCalls} calls would exceed monthly calls cap (${budget.used.calls} used of ${budget.caps.calls})`,
    );
  }
  return {
    mode,
    scope: {
      kind: scope.kind,
      id: scope.id,
      mechanism_ids: scope.mechanismIds,
    },
    calls: {
      cheap: cheapCalls,
      strong: strongCalls,
      total: cheapCalls + strongCalls,
    },
    tokens: {
      input_upper_bound: inputUpper,
      output_reserved: outputReserved,
      total_upper_bound: totalUpper,
    },
    estimated_usd: Math.round(estimatedUsd * 1e8) / 1e8,
    caps: {
      per_run_tokens: config.limits.per_run_tokens,
      monthly_tokens: config.limits.monthly_tokens,
    },
    allowed: reasons.length === 0,
    reasons,
    prices_verified_on: config.prices_verified_on,
    price_state: priceState,
    generated_at: now.toISOString(),
  };
}

async function callOpenRouter(
  context: RunContext,
  tierName: "cheap" | "strong",
  prompt: string,
  outputReserve: number,
): Promise<DraftItem[]> {
  const tier = configuredTier(context.config, tierName);
  const inputUpper = bytes(prompt);
  const maxTokens = Math.min(outputReserve, tier.max_tokens_per_call);
  const projected = context.usage.input + context.usage.output + inputUpper + maxTokens;
  if (projected > context.config.limits.per_run_tokens) {
    throw new Error(`Per-run token cap would be exceeded before ${tierName} call`);
  }
  if (
    monthTokenUsage() + projected >
    context.config.limits.monthly_tokens
  ) {
    throw new Error(`Monthly token cap would be exceeded before ${tierName} call`);
  }

  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await context.fetcher(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/ventora/motivation-engine",
        "X-Title": "Motivation Engine extraction",
      },
      body: JSON.stringify({
        model: tier.model_id,
        messages: [
          {
            role: "system",
            content:
              "You are a fail-closed scientific extraction function. Output JSON only. Never use knowledge outside supplied records.",
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: maxTokens,
      }),
    });
    if (response.ok) break;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
      throw new Error(
        `OpenRouter ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  if (!response?.ok) throw new Error("OpenRouter request failed");
  const body = (await response.json()) as OpenRouterResponse;
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenRouter returned no content");
  const usageInput = body.usage?.prompt_tokens;
  const usageOutput = body.usage?.completion_tokens;
  if (
    !Number.isInteger(usageInput) ||
    !Number.isInteger(usageOutput) ||
    usageInput! < 0 ||
    usageOutput! < 0
  ) {
    throw new Error("OpenRouter response omitted token usage");
  }
  context.usage.input += usageInput!;
  context.usage.output += usageOutput!;
  context.usage.calls += 1;
  context.usage.byTier[tierName].input += usageInput!;
  context.usage.byTier[tierName].output += usageOutput!;
  context.usage.byTier[tierName].calls += 1;
  const parsed = JSON.parse(content) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as DraftResponse).items)
  ) {
    throw new Error("OpenRouter output must be {items: []}");
  }
  return (parsed as DraftResponse).items.filter(
    (item): item is DraftItem => typeof item === "object" && item !== null,
  );
}

const normalizeText = normalizeQualityText;

export function groundedProvenance(
  item: DraftItem,
  corpus: ExtractionCorpus,
): KnowledgeProvenanceItem[] | null {
  if (!Array.isArray(item.citations) || item.citations.length === 0) return null;
  const records = new Map(corpus.records.map((record) => [record.record_id, record]));
  const provenance: KnowledgeProvenanceItem[] = [];
  for (const citation of item.citations) {
    if (
      typeof citation?.record_id !== "string" ||
      typeof citation.quote_or_locus !== "string" ||
      !citation.quote_or_locus.trim()
    ) {
      return null;
    }
    const record = records.get(citation.record_id);
    if (!record) return null;
    const locus = normalizeText(citation.quote_or_locus);
    const sourceText = normalizeText(
      `${record.title}\n${isRealizationRecord(record) ? record.observation : record.abstract ?? ""}`,
    );
    if (!sourceText.includes(locus)) return null;
    provenance.push(
      isRealizationRecord(record)
        ? {
            corpus_kind: "realization",
            mechanism_id: corpus.mechanism_id,
            corpus_record_id: record.record_id,
            source_id: record.source_id,
            title: record.title,
            quote_or_locus: citation.quote_or_locus.trim(),
            contributed_by: record.contributed_by,
          }
        : {
            mechanism_id: corpus.mechanism_id,
            corpus_record_id: record.record_id,
            doi: record.doi,
            title: record.title,
            quote_or_locus: citation.quote_or_locus.trim(),
          },
    );
  }
  const unique = new Map(
    provenance.map((item) => [
      `${item.corpus_record_id}\u0000${item.quote_or_locus}`,
      item,
    ]),
  );
  const result = Array.from(unique.values());
  if (isRealizationCorpus(corpus)) {
    const realizationProvenance = result.filter(
      (entry): entry is RealizationCorpusProvenanceItem =>
        entry.corpus_kind === "realization",
    );
    return realizationProvenance.length === result.length &&
      realizationGroundingErrors(realizationProvenance, corpus).length === 0
      ? result
      : null;
  }
  return groundingErrors(result, corpus).length === 0 ? result : null;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
}

function snake(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function evidenceGrade(value: unknown): value is EvidenceGrade {
  return (
    typeof value === "string" &&
    ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"].includes(value)
  );
}

function confidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function proposalId(type: Proposal["type"], target: string, identity: string): string {
  const hash = createHash("sha256")
    .update(`${type}\u0000${target}\u0000${normalizeText(identity)}`)
    .digest("hex")
    .slice(0, 12);
  return `${type}-${slug(target)}-${slug(identity).slice(0, 36) || "item"}-${hash}`;
}

function envelope<T extends Proposal>(
  proposal: Omit<
    T,
    | "operation"
    | "proposed_by"
    | "proposed_at"
    | "status"
    | "hold_reason"
    | "decided_by"
    | "decided_at"
    | "decision_note"
  >,
  runId: string,
  proposedAt: string,
  operation: T["operation"] = "create",
): T {
  return {
    ...proposal,
    operation,
    proposed_by: runId,
    proposed_at: proposedAt,
    status: "pending",
    hold_reason: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
  } as T;
}

/** Corpus and registry context needed by the draft modes (D-085). */
export interface DraftContext {
  corpus: ExtractionCorpus;
  /** The seed stub whose content is preserved verbatim (mode=mechanism). */
  seed?: SeedStub;
  /** Full + seed ids; relations to anything else are dropped as ungrounded. */
  knownMechanismIds: ReadonlySet<string>;
}

/**
 * Conservative prior from the drafted evidence grade, matching the range the
 * owner used across the hand-authored registry (A 0.85–0.9 … B 0.65).
 */
const PRIOR_WEIGHT_BY_GRADE: Record<EvidenceGrade, number> = {
  "A+": 0.9,
  A: 0.85,
  "A-": 0.8,
  "B+": 0.7,
  B: 0.65,
  "B-": 0.55,
  "C+": 0.45,
  C: 0.35,
  "C-": 0.25,
};

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(
        new Set(value.filter(nonEmpty).map((entry) => entry.trim())),
      )
    : [];
}

function vocabularySubset(value: unknown, allowed: readonly string[]): string[] {
  return stringList(value).filter((entry) => allowed.includes(entry));
}

function draftMechanismPayload(
  mechanismId: string,
  item: DraftItem,
  context: DraftContext,
  proposedAt: string,
): Mechanism | null {
  const seed = context.seed;
  if (!seed) return null;
  if (
    !evidenceGrade(item.grade) ||
    !nonEmpty(item.summary) ||
    !nonEmpty(item.evidence_basis) ||
    !nonEmpty(item.effect_size_note) ||
    !nonEmpty(item.boundary_test)
  ) {
    return null;
  }
  const funnelStages = vocabularySubset(item.funnel_stages, FUNNEL_STAGES);
  const artifactTypes = vocabularySubset(
    item.applicability_artifact_types,
    ARTIFACT_TYPES,
  ) as ArtifactType[];
  if (funnelStages.length === 0 || artifactTypes.length === 0) return null;
  const excludedStages = vocabularySubset(item.excluded_stages, FUNNEL_STAGES).filter(
    (stage) => !funnelStages.includes(stage),
  );

  const preconditions = (Array.isArray(item.preconditions) ? item.preconditions : [])
    .filter(
      (entry): entry is { predicate: string; reason: string } =>
        typeof entry === "object" &&
        entry !== null &&
        nonEmpty(entry.predicate) &&
        nonEmpty(entry.reason),
    )
    .map((entry) => ({
      predicate: entry.predicate.trim(),
      reason: entry.reason.trim(),
    }));

  const implementations: Implementation[] = [];
  for (const draft of Array.isArray(item.implementations) ? item.implementations : []) {
    if (typeof draft !== "object" || draft === null) continue;
    const suffix = nonEmpty(draft.id_suffix) ? slug(draft.id_suffix) : "";
    const implementationTypes = vocabularySubset(
      draft.artifact_types,
      ARTIFACT_TYPES,
    ) as ArtifactType[];
    const metrics = stringList(draft.metrics).map(snake).filter(Boolean);
    if (!suffix || implementationTypes.length === 0 || metrics.length === 0) continue;
    if (!nonEmpty(draft.generation_directive)) continue;
    const id = `${mechanismId}-${suffix}`;
    if (implementations.some((existing) => existing.id === id)) continue;
    implementations.push({
      id,
      artifact_types: implementationTypes,
      product_requirements: stringList(draft.product_requirements),
      generation_directive: draft.generation_directive.trim(),
      copy_formulas: stringList(draft.copy_formulas),
      metrics,
      observed_effects: [],
    });
  }
  if (implementations.length === 0) return null;

  const hardRules: HardRule[] = [];
  for (const draft of Array.isArray(item.hard_rules) ? item.hard_rules : []) {
    if (typeof draft !== "object" || draft === null) continue;
    if (!nonEmpty(draft.id) || !nonEmpty(draft.rule)) continue;
    if (draft.severity !== "block" && draft.severity !== "warn") continue;
    const id = snake(draft.id);
    if (!id || hardRules.some((existing) => existing.id === id)) continue;
    hardRules.push({ id, rule: draft.rule.trim(), severity: draft.severity });
  }
  if (hardRules.length === 0) return null;

  const relations: Relation[] = (Array.isArray(item.relations) ? item.relations : [])
    .filter(
      (entry): entry is { type: string; target: string; note: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.type === "string" &&
        ["enabled_by", "enables", "adjacent", "hybrid_with"].includes(entry.type) &&
        nonEmpty(entry.target) &&
        entry.target !== mechanismId &&
        context.knownMechanismIds.has(entry.target) &&
        nonEmpty(entry.note),
    )
    .map((entry) => ({
      type: entry.type as Relation["type"],
      target: entry.target,
      note: entry.note.trim(),
    }));

  const referenceExamples = (Array.isArray(item.reference_examples)
    ? item.reference_examples
    : []
  )
    .filter(
      (entry): entry is { product: string; what: string } =>
        typeof entry === "object" &&
        entry !== null &&
        nonEmpty(entry.product) &&
        nonEmpty(entry.what),
    )
    .map((entry) => ({ product: entry.product.trim(), what: entry.what.trim() }));

  return {
    id: mechanismId,
    slug: snake(seed.name),
    name: seed.name,
    version: "1.0.0",
    level: "L1",
    parent: seed.parent,
    ...(seed.cross_cutting === true ? { cross_cutting: true } : {}),
    // Honest at proposal time; projectMechanism derives the final lifecycle
    // from the approved dossier verdict when the dossier exists (D-085).
    lifecycle_status: "candidate",
    dossier_ref: `dossiers/${mechanismId}.json`,
    provenance: {
      proposed_by: "derivation-pipeline",
      date: proposedAt.slice(0, 10),
    },
    ...(seed.evidence_terms ? { evidence_terms: seed.evidence_terms } : {}),
    ...(seed.pinned_evidence ? { pinned_evidence: seed.pinned_evidence } : {}),
    evidence: {
      grade: item.grade,
      basis: item.evidence_basis.trim(),
      effect_size_note: item.effect_size_note.trim(),
      caveats: stringList(item.caveats).map(snake).filter(Boolean),
    },
    prior_weight: PRIOR_WEIGHT_BY_GRADE[item.grade],
    mechanism_summary_for_context: item.summary.trim(),
    applicability: {
      funnel_stages: funnelStages,
      excluded_stages: excludedStages,
      artifact_types: artifactTypes,
      preconditions,
      culture_note: nonEmpty(item.culture_note) ? item.culture_note.trim() : "",
    },
    implementations,
    constraints: {
      hard_rules: hardRules,
      compliance_refs: stringList(item.compliance_refs).map(snake).filter(Boolean),
      boundary_test: item.boundary_test.trim(),
    },
    relations,
    telemetry: {
      tag_format: `me:${mechanismId}:{implementation_id}`,
      amplitude_event_property: "mechanism_tags",
    },
    ...(referenceExamples.length > 0 ? { reference_examples: referenceExamples } : {}),
  };
}

function isEvidenceProvenance(
  item: KnowledgeProvenanceItem,
): item is EvidenceProvenanceItem {
  return !("corpus_kind" in item && item.corpus_kind === "realization");
}

function draftDossierAxis(
  raw: DossierAxisDraft | undefined,
  corpus: ExtractionCorpus,
): DossierDraftAxis {
  const unscored: DossierDraftAxis = { score: null, rationale: null, provenance: [] };
  if (
    !raw ||
    typeof raw !== "object" ||
    !Number.isInteger(raw.score) ||
    (raw.score as number) < 0 ||
    (raw.score as number) > 3 ||
    !nonEmpty(raw.rationale)
  ) {
    return unscored;
  }
  const grounded = groundedProvenance({ citations: raw.citations }, corpus);
  if (!grounded || !grounded.every(isEvidenceProvenance)) return unscored;
  return {
    score: raw.score as AxisScore,
    rationale: raw.rationale.trim(),
    provenance: grounded as EvidenceProvenanceItem[],
  };
}

function draftDossierPayload(
  mechanismId: string,
  item: DraftItem,
  context: DraftContext,
  envelopeProvenance: KnowledgeProvenanceItem[],
): { payload: DossierDraftPayload; provenance: KnowledgeProvenanceItem[] } | null {
  if (!nonEmpty(item.core_condition) || !nonEmpty(item.dissent)) return null;
  const scores = {
    evidence: draftDossierAxis(item.scores?.evidence, context.corpus),
    product_applicability: draftDossierAxis(
      item.scores?.product_applicability,
      context.corpus,
    ),
    measurability: draftDossierAxis(item.scores?.measurability, context.corpus),
    orthogonality: draftDossierAxis(item.scores?.orthogonality, context.corpus),
    safety: draftDossierAxis(item.scores?.safety, context.corpus),
  };
  // The envelope carries the exact union of the top-level citations and every
  // per-axis provenance item, so /review re-grounds each axis transitively.
  const union = new Map<string, KnowledgeProvenanceItem>();
  for (const entry of [
    ...envelopeProvenance,
    ...Object.values(scores).flatMap((axis) => axis.provenance),
  ]) {
    union.set(JSON.stringify(entry), entry);
  }
  const provenance = Array.from(union.values()).sort(
    (left, right) =>
      left.corpus_record_id.localeCompare(right.corpus_record_id) ||
      left.quote_or_locus.localeCompare(right.quote_or_locus),
  );
  const evidenceSources: DossierEvidenceSource[] = [];
  const seenDois = new Set<string>();
  for (const entry of provenance) {
    if (!("doi" in entry) || entry.doi === null || seenDois.has(entry.doi)) continue;
    seenDois.add(entry.doi);
    evidenceSources.push({ ref: entry.title, doi: entry.doi });
  }
  if (evidenceSources.length === 0) return null;
  return {
    payload: {
      id: `DOS-${mechanismId}`,
      mechanism_id: mechanismId,
      scores,
      core_condition: item.core_condition.trim(),
      dissent: item.dissent.trim(),
      evidence_sources: evidenceSources,
    },
    provenance,
  };
}

export function toProposal(
  mode: ExtractionMode,
  mechanismId: string,
  item: DraftItem,
  provenance: KnowledgeProvenanceItem[],
  runId: string,
  proposedAt: string,
  context?: DraftContext,
): Proposal | null {
  const itemConfidence = confidence(item.confidence);
  if (itemConfidence === null) return null;
  if (mode === "mechanism") {
    if (!context) return null;
    const payload = draftMechanismPayload(mechanismId, item, context, proposedAt);
    if (!payload) return null;
    return envelope(
      {
        id: proposalId("mechanism", mechanismId, "record"),
        type: "mechanism",
        target: mechanismId,
        payload,
        provenance,
        confidence: itemConfidence,
      },
      runId,
      proposedAt,
    );
  }
  if (mode === "dossier") {
    if (!context) return null;
    const draft = draftDossierPayload(mechanismId, item, context, provenance);
    if (!draft) return null;
    return envelope(
      {
        id: proposalId("dossier", mechanismId, "draft"),
        type: "dossier",
        target: mechanismId,
        payload: draft.payload,
        provenance: draft.provenance,
        confidence: itemConfidence,
      },
      runId,
      proposedAt,
    );
  }
  if (
    mode === "effects" &&
    typeof item.name === "string" &&
    typeof item.fact === "string" &&
    typeof item.boundary === "string" &&
    evidenceGrade(item.grade)
  ) {
    const id = slug(item.id ?? item.name);
    const dois = Array.from(
      new Set(
        provenance.flatMap((source) =>
          "doi" in source && source.doi !== null ? [source.doi] : [],
        ),
      ),
    );
    if (!id || dois.length === 0) return null;
    const payload = {
      id,
      mechanism_id: mechanismId,
      name: item.name.trim(),
      fact: item.fact.trim(),
      grade: item.grade,
      source: dois,
      boundary: item.boundary.trim(),
      realization_ids: [],
      provenance,
    };
    return envelope(
      {
        id: proposalId("effect", mechanismId, payload.name),
        type: "effect",
        target: mechanismId,
        payload,
        provenance,
        confidence: itemConfidence,
      },
      runId,
      proposedAt,
    );
  }
  if (
    mode === "realizations" &&
    typeof item.term === "string" &&
    typeof item.description_as_reported === "string" &&
    Array.isArray(item.artifact_context) &&
    item.artifact_context.length > 0 &&
    item.artifact_context.every((entry) => typeof entry === "string" && entry.trim())
  ) {
    const id = slug(item.id ?? item.term);
    if (!id) return null;
    const payload: Realization = {
      id,
      mechanism_id: mechanismId,
      ...(typeof item.effect_id === "string" && item.effect_id.trim()
        ? { effect_id: slug(item.effect_id) }
        : {}),
      term: item.term.trim(),
      description_as_reported: item.description_as_reported.trim(),
      artifact_context: Array.from(
        new Set(item.artifact_context.map((entry) => entry.trim())),
      ),
      provenance,
      confidence: itemConfidence,
    };
    return envelope(
      {
        id: proposalId("realization", mechanismId, payload.term),
        type: "realization",
        target: mechanismId,
        payload,
        provenance,
        confidence: itemConfidence,
      },
      runId,
      proposedAt,
    );
  }
  if (
    mode === "interactions" &&
    Array.isArray(item.pair) &&
    item.pair.length === 2 &&
    item.pair.every((entry) => typeof entry === "string" && /^[A-Z]{2}-\d{2}$/.test(entry)) &&
    typeof item.fact === "string" &&
    typeof item.boundary === "string" &&
    typeof item.source === "string" &&
    evidenceGrade(item.grade) &&
    ["sequence-amplifying", "reinforcing", "suppressing", "neutral"].includes(
      item.type ?? "",
    )
  ) {
    const pair = [...item.pair].sort() as [string, string];
    if (pair[0] === pair[1]) return null;
    const target = `${pair[0]}__${pair[1]}`;
    return envelope(
      {
        id: proposalId("interaction", target, target),
        type: "interaction",
        target,
        payload: {
          pair,
          type: item.type as "sequence-amplifying" | "reinforcing" | "suppressing" | "neutral",
          fact: item.fact.trim(),
          grade: item.grade,
          boundary: item.boundary.trim(),
          source: item.source.trim(),
        },
        provenance,
        confidence: itemConfidence,
      },
      runId,
      proposedAt,
    );
  }
  if (mode === "dissent" && typeof item.value === "string" && item.value.trim()) {
    return envelope(
      {
        id: proposalId("dossier_section", mechanismId, "dissent"),
        type: "dossier_section",
        target: mechanismId,
        payload: { field: "dissent", value: item.value.trim() },
        provenance,
        confidence: itemConfidence,
      },
      runId,
      proposedAt,
      "enrich",
    );
  }
  return null;
}

export function proposalIdentity(proposal: Proposal): string {
  switch (proposal.type) {
    case "effect":
      return `effect:${proposal.target}:${normalizeText(proposal.payload.name)}`;
    case "realization":
      return `realization:${proposal.target}:${normalizeText(proposal.payload.term)}`;
    case "interaction":
      return `interaction:${proposal.payload.pair.join("__")}`;
    case "dossier_section":
      return `dossier:${proposal.target}:${proposal.payload.field}:${normalizeText(
        JSON.stringify(proposal.payload.value),
      )}`;
    default:
      return `${proposal.type}:${proposal.target}:${proposal.id}`;
  }
}

interface ExistingMatch {
  proposal: Proposal;
  path: string | null;
  authoritative: boolean;
}

function artifactEnvelope(
  proposal: Pick<Proposal, "id" | "type" | "target" | "payload" | "provenance" | "confidence">,
): Proposal {
  return {
    ...proposal,
    operation: "enrich",
    proposed_by: "authoritative-artifact",
    proposed_at: "1970-01-01T00:00:00.000Z",
    status: "approved",
    hold_reason: null,
    decided_by: "owner",
    decided_at: "1970-01-01T00:00:00.000Z",
    decision_note: "authoritative comparison record",
  } as Proposal;
}

function existingMatches(): ExistingMatch[] {
  const matches: ExistingMatch[] = [];
  for (const file of listJsonRecursive(PROPOSALS_DIR)) {
    if (basename(file) === "proposal.schema.json") continue;
    const proposal = readJson<Proposal>(file);
    if (
      proposal.status === "pending" ||
      proposal.status === "edited" ||
      proposal.status === "held_low_confidence"
    ) {
      matches.push({ proposal, path: file, authoritative: false });
    }
  }
  for (const file of listJsonRecursive(join(ROOT, "effects"))) {
    if (basename(file) === "effect.schema.json") continue;
    const payload = readJson<Extract<Proposal, { type: "effect" }>["payload"]>(file);
    matches.push({
      proposal: artifactEnvelope({
        id: `artifact-effect-${payload.mechanism_id}-${payload.id}`,
        type: "effect",
        target: payload.mechanism_id,
        payload,
        provenance: payload.provenance,
        confidence: 1,
      }),
      path: null,
      authoritative: true,
    });
  }
  for (const file of listJsonRecursive(join(ROOT, "realizations"))) {
    if (basename(file) === "realization.schema.json") continue;
    const payload = readJson<Realization>(file);
    matches.push({
      proposal: artifactEnvelope({
        id: `artifact-realization-${payload.mechanism_id}-${payload.id}`,
        type: "realization",
        target: payload.mechanism_id,
        payload,
        provenance: payload.provenance,
        confidence: payload.confidence,
      }),
      path: null,
      authoritative: true,
    });
  }
  for (const file of listJson(join(ROOT, "interactions"))) {
    if (basename(file) === "interaction.schema.json") continue;
    const payload = readJson<Extract<Proposal, { type: "interaction" }>["payload"]>(file);
    const target = payload.pair.join("__");
    matches.push({
      proposal: artifactEnvelope({
        id: `artifact-interaction-${target}`,
        type: "interaction",
        target,
        payload,
        provenance: [],
        confidence: 1,
      }),
      path: null,
      authoritative: true,
    });
  }
  for (const file of listJson(join(ROOT, "dossiers"))) {
    if (basename(file) === "dossier.schema.json") continue;
    const dossier = readJson<{ mechanism_id: string; dissent: string }>(file);
    matches.push({
      proposal: artifactEnvelope({
        id: `artifact-dossier-${dossier.mechanism_id}-dissent`,
        type: "dossier_section",
        target: dossier.mechanism_id,
        payload: { field: "dissent", value: dossier.dissent },
        provenance: [],
        confidence: 1,
      }),
      path: null,
      authoritative: true,
    });
  }
  return matches;
}

function proposalValidator(): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const path of [
    "registry/mechanism.schema.json",
    "effects/effect.schema.json",
    "realizations/realization.schema.json",
    "interactions/interaction.schema.json",
    "dossiers/dossier.schema.json",
  ]) {
    ajv.addSchema(readJson<object>(join(ROOT, path)));
  }
  return ajv.compile(readJson<object>(join(ROOT, "proposals/proposal.schema.json")));
}

export function buildExtractionManifestCost(
  config: ExtractionOpsConfig,
  usage: Usage,
  durationS: number,
): CorpusManifestCost {
  const models = (["cheap", "strong"] as const)
    .map((name) => {
      const tier = configuredTier(config, name);
      const tierUsage = usage.byTier[name];
      return {
        tier: name,
        model_id: tier.model_id,
        api_calls: tierUsage.calls,
        tokens_in: tierUsage.input,
        tokens_out: tierUsage.output,
        estimated_usd:
          Math.round(
            (
              tierUsage.input * tier.input_usd_per_token +
              tierUsage.output * tier.output_usd_per_token
            ) * 1e8,
          ) / 1e8,
      };
    })
    .filter((model) => model.api_calls > 0);
  return {
    api_calls: usage.calls,
    duration_s: durationS,
    tokens_in: usage.input,
    tokens_out: usage.output,
    estimated_usd:
      Math.round(models.reduce((sum, model) => sum + model.estimated_usd, 0) * 1e8) / 1e8,
    models,
  };
}

function computeUsd(config: ExtractionOpsConfig, usage: Usage): number {
  return buildExtractionManifestCost(config, usage, 0).estimated_usd;
}

function writeManifest(
  mode: ExtractionMode,
  scope: ExtractionScope,
  startedAt: Date,
  config: ExtractionOpsConfig,
  usage: Usage,
  stats: ExtractionStats,
  filesWritten: number,
): void {
  mkdirSync(EXTRACTION_DIR, { recursive: true });
  const duration = Math.round(((Date.now() - startedAt.getTime()) / 1000) * 100) / 100;
  const run: CorpusManifestRun = {
    timestamp: startedAt.toISOString(),
    status: "success",
    params: {
      mode,
      [scope.kind]: scope.id,
      ...extractionSummaryParams(stats),
    },
    records_fetched: stats.candidates,
    files_written: filesWritten,
    duration_s: duration,
    ...(stats.dropped_ungrounded > 0
      ? { warnings: { ungrounded_dropped: true } }
      : {}),
    cost: buildExtractionManifestCost(config, usage, duration),
  };
  const previous = existsSync(MANIFEST_FILE)
    ? readJson<CorpusManifest>(MANIFEST_FILE)
    : null;
  const history = [run, ...(previous?.run_history ?? [])].slice(0, 20);
  const coverage = readJson<ReaderCoverageFile>(READER_COVERAGE_FILE);
  const coveredRecords = Object.values(coverage.mechanisms).reduce(
    (sum, mechanism) =>
      sum +
      (mechanism.evidence?.processed_record_ids.length ?? 0) +
      (mechanism.realization?.processed_record_ids.length ?? 0),
    0,
  );
  writeFileSync(
    MANIFEST_FILE,
    json({
      source_id: "extraction",
      source_ids: [],
      connector_version: "1.1.0",
      last_run: run,
      run_history: history,
      data_files: [
        {
          path: "coverage.json",
          records: coveredRecords,
          bytes: statSync(READER_COVERAGE_FILE).size,
        },
      ],
    }),
  );
}

export async function runExtraction(args: {
  mode: ExtractionMode;
  scope: ExtractionScope;
  config: ExtractionOpsConfig;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<{ proposals: Proposal[]; stats: ExtractionStats; usage: Usage }> {
  const startedAt = args.now ?? new Date();
  const quote = buildQuote(args.mode, args.scope, args.config, startedAt);
  if (!quote.allowed) throw new Error(`Extraction blocked: ${quote.reasons.join("; ")}`);
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required");
  const context: RunContext = {
    config: args.config,
    usage: {
      input: 0,
      output: 0,
      calls: 0,
      byTier: {
        cheap: { input: 0, output: 0, calls: 0 },
        strong: { input: 0, output: 0, calls: 0 },
      },
    },
    fetcher: args.fetcher ?? fetch,
  };
  const stats: ExtractionStats = {
    candidates: 0,
    dropped_ungrounded: 0,
    proposed: 0,
    merged: 0,
    held_low_confidence: 0,
    dropped_volume_cap: 0,
    dropped_volume_cap_high_confidence: 0,
  };
  const proposals: Proposal[] = [];
  const existing = existingMatches();
  const pendingWrites = new Map<string, Proposal>();
  const processedByMechanism = new Map<string, string[]>();
  const validate = proposalValidator();
  const runId = process.env.GITHUB_RUN_ID
    ? `github-actions-${process.env.GITHUB_RUN_ID}`
    : `extract-${startedAt.toISOString()}`;

  // Live progress heartbeat (D-086): report batches drafted and running spend
  // against the per-run token cap so /ops shows extraction moving in flight.
  const batchSize = args.config.limits.records_per_batch;
  let totalBatches = 0;
  for (const mechanismId of args.scope.mechanismIds) {
    if (!modeEligible(args.mode, mechanismId)) continue;
    const records = eligibleRecords(corpusFor(args.mode, mechanismId));
    totalBatches += Math.ceil(records.length / batchSize);
  }
  let batchesDone = 0;
  const reportExtractProgress = (
    phase: string,
    status: "running" | "success" | "partial" | "failed",
    finished: boolean,
  ): void => {
    writeRunProgress({
      kind: "extraction",
      target: `${args.scope.kind} ${args.scope.id}`,
      phase,
      finished,
      status,
      progress: { unit: "batches", done: batchesDone, total: totalBatches },
      records: null,
      spend: {
        api_calls: context.usage.calls,
        tokens_in: context.usage.input,
        tokens_out: context.usage.output,
        estimated_usd: computeUsd(args.config, context.usage),
      },
      caps: {
        per_run_calls: null,
        per_run_tokens: args.config.limits.per_run_tokens,
        monthly_calls: null,
        monthly_usd: null,
      },
      note: null,
    });
  };
  reportExtractProgress("reading corpora", "running", false);

  const draftContextBase = isDraftMode(args.mode)
    ? {
        seeds: seedStubs(),
        knownMechanismIds: new Set([
          ...Array.from(fullMechanisms().keys()),
          ...Array.from(seedStubs().keys()),
        ]) as ReadonlySet<string>,
      }
    : null;

  for (const mechanismId of args.scope.mechanismIds) {
    if (!modeEligible(args.mode, mechanismId)) continue;
    const corpus = corpusFor(args.mode, mechanismId);
    const records = eligibleRecords(corpus);
    if (records.length === 0) continue;
    processedByMechanism.set(
      mechanismId,
      records.map((record) => record.record_id),
    );
    const draftContext: DraftContext | undefined = draftContextBase
      ? {
          corpus,
          seed: draftContextBase.seeds.get(mechanismId),
          knownMechanismIds: draftContextBase.knownMechanismIds,
        }
      : undefined;
    const candidates: DraftItem[] = [];
    for (const batch of batches(records, args.config.limits.records_per_batch)) {
      candidates.push(
        ...(await callOpenRouter(
          context,
          "cheap",
          cheapPrompt(args.mode, mechanismId, batch),
          CHEAP_OUTPUT_RESERVE,
        )),
      );
      batchesDone += 1;
      reportExtractProgress(`drafting ${mechanismId}`, "running", false);
    }
    reportExtractProgress(`composing ${mechanismId}`, "running", false);
    const synthesizedRaw = await callOpenRouter(
      context,
      "strong",
      strongPrompt(args.mode, mechanismId, candidates),
      STRONG_OUTPUT_RESERVE,
    );
    // A draft mode composes exactly one first-time artifact per mechanism.
    const synthesized = isDraftMode(args.mode)
      ? synthesizedRaw.slice(0, 1)
      : synthesizedRaw;
    stats.candidates += synthesized.length;
    const admissible: { proposal: Proposal; outcome: "proposed" | "merged" }[] = [];
    const held: Proposal[] = [];
    for (const item of synthesized) {
      const provenance = groundedProvenance(item, corpus);
      if (!provenance) {
        stats.dropped_ungrounded += 1;
        continue;
      }
      const proposal = toProposal(
        args.mode,
        mechanismId,
        item,
        provenance,
        runId,
        startedAt.toISOString(),
        draftContext,
      );
      if (!proposal || !validate(proposal)) {
        stats.dropped_ungrounded += 1;
        continue;
      }
      const duplicate = existing
        .map((entry) => ({
          entry,
          score: proposalSimilarity(entry.proposal, proposal),
        }))
        .filter(({ score }) => score >= args.config.limits.duplicate_similarity)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.entry.proposal.id.localeCompare(right.entry.proposal.id),
        )[0]?.entry;

      if (duplicate && !duplicate.authoritative) {
        const previous = duplicate.proposal;
        let merged = mergeProposals(duplicate.proposal, proposal);
        if (
          previous.status === "held_low_confidence" &&
          merged.confidence >= args.config.limits.confidence_floor &&
          hasNovelEnrichment(previous, merged)
        ) {
          merged = { ...merged, status: "pending", hold_reason: null } as Proposal;
        }
        if (!validate(merged)) {
          stats.dropped_ungrounded += 1;
          continue;
        }
        duplicate.proposal = merged;
        if (duplicate.path) {
          pendingWrites.set(duplicate.path, merged);
        } else {
          const staged = admissible.find((entry) => entry.proposal === previous);
          if (staged) staged.proposal = merged;
          const heldIndex = held.findIndex((entry) => entry === previous);
          if (heldIndex >= 0) held[heldIndex] = merged;
        }
        stats.merged += 1;
        continue;
      }

      let gatedProposal = proposal;
      let outcome: "proposed" | "merged" = "proposed";
      let addsValue = true;
      if (duplicate?.authoritative) {
        const merged = mergeProposals(duplicate.proposal, proposal);
        addsValue = hasNovelEnrichment(duplicate.proposal, merged);
        gatedProposal = {
          ...proposal,
          operation: "enrich",
          payload: merged.payload,
          provenance: merged.provenance,
        } as Proposal;
        outcome = "merged";
      }

      if (!validate(gatedProposal)) {
        stats.dropped_ungrounded += 1;
        continue;
      }

      if (
        gatedProposal.confidence < args.config.limits.confidence_floor ||
        !addsValue
      ) {
        const heldProposal = {
          ...gatedProposal,
          status: "held_low_confidence",
          hold_reason:
            gatedProposal.confidence < args.config.limits.confidence_floor
              ? "below_confidence_floor"
              : "no_material_enrichment",
        } as Proposal;
        held.push(heldProposal);
        existing.push({ proposal: heldProposal, path: null, authoritative: false });
        stats.held_low_confidence += 1;
        continue;
      }
      admissible.push({ proposal: gatedProposal, outcome });
      existing.push({ proposal: gatedProposal, path: null, authoritative: false });
    }

    admissible.sort(
      (left, right) =>
        right.proposal.confidence - left.proposal.confidence ||
        proposalIdentity(left.proposal).localeCompare(proposalIdentity(right.proposal)),
    );
    const admitted = admissible.slice(
      0,
      args.config.limits.max_proposals_per_mechanism,
    );
    const overflow = admissible.slice(args.config.limits.max_proposals_per_mechanism);
    stats.dropped_volume_cap += overflow.length;
    stats.dropped_volume_cap_high_confidence += overflow.filter(
      ({ proposal: overflowProposal }) => overflowProposal.confidence >= 0.8,
    ).length;
    for (const entry of admitted) stats[entry.outcome] += 1;
    proposals.push(...admitted.map(({ proposal: admittedProposal }) => admittedProposal), ...held);
  }

  for (const [path, proposal] of Array.from(pendingWrites.entries())) {
    writeFileSync(path, json(proposal));
  }
  for (const proposal of proposals) {
    const dir = join(PROPOSALS_DIR, proposal.type);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${proposal.id}.json`), json(proposal));
  }
  writeReaderCoverage(
    args.mode,
    processedByMechanism,
    startedAt.toISOString(),
  );
  writeManifest(
    args.mode,
    args.scope,
    startedAt,
    args.config,
    context.usage,
    stats,
    proposals.length + pendingWrites.size,
  );
  reportExtractProgress(
    `completed — ${stats.proposed + stats.merged} proposals`,
    "success",
    true,
  );
  return { proposals, stats, usage: context.usage };
}

async function main(): Promise<void> {
  const [command = "quote", ...rawParams] = process.argv.slice(2);
  if (command !== "quote" && command !== "run") {
    throw new Error("Usage: npm run extract -- <quote|run> mode=<mode> <scope>=<id>");
  }
  const params = parseParams(rawParams);
  if (!isMode(params.mode)) {
    throw new Error(`mode must be one of ${EXTRACTION_MODES.join(", ")}`);
  }
  const config = loadExtractionOpsConfigFromDisk();
  if (!config) throw new Error("Missing corpora/_ops/extraction.json");
  // A missing/stale/malformed field must fail with an explicit named message,
  // never silently drive the estimator to NaN (D-088). The shared validator is
  // the SAME one CI and the /ops write path use, so the quote can never accept
  // a config the rest of the fleet would reject.
  const configErrors = validateExtractionOpsConfig(config);
  if (configErrors.length > 0) {
    throw new Error(
      `corpora/_ops/extraction.json is invalid: ${configErrors.join("; ")}`,
    );
  }
  const scope = resolveScope(params, { includeSeeds: isDraftMode(params.mode) });
  if (command === "quote") {
    const quote = buildQuote(params.mode, scope, config);
    writeFileSync(QUOTE_FILE, json(quote));
    console.log(json(quote).trim());
    // A computed quote is a SUCCESS, even when its verdict is "blocked": the
    // dry-run job must upload quote.json so /ops can show the operator WHY
    // (e.g. over the per-run cap). Only the pre-flight gate in the real run
    // (enforce=true) exits non-zero on a blocked verdict, to fail closed
    // before any OPENROUTER_API_KEY process starts (D-087/D-088).
    if (!quote.allowed && params.enforce === "true") process.exitCode = 1;
    return;
  }
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Real extraction is Actions-only; dispatch .github/workflows/extract.yml");
  }
  const result = await runExtraction({ mode: params.mode, scope, config });
  console.log(json({ mode: params.mode, scope, ...result.stats }).trim());
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

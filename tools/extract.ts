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
} from "../lib/ops";
import {
  groundingErrors,
  hasNovelEnrichment,
  mergeProposals,
  normalizeQualityText,
  proposalSimilarity,
  realizationGroundingErrors,
} from "../lib/proposal-quality";
import type {
  CorpusManifest,
  CorpusManifestRun,
  EvidenceCorpusFile,
  EvidenceCorpusRecord,
  EvidenceGrade,
  ExtractionModelTierConfig,
  ExtractionOpsConfig,
  KnowledgeProvenanceItem,
  Mechanism,
  PackMapFile,
  Proposal,
  ReaderCoverageFile,
  Realization,
  RealizationCorpusFile,
  RealizationCorpusRecord,
  RealizationCorpusProvenanceItem,
  Segment,
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
] as const;
export type ExtractionMode = (typeof EXTRACTION_MODES)[number];
export type ScopeKind = "mechanism" | "pack" | "segment";

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

interface Usage {
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

export function resolveScope(params: Record<string, string>): ExtractionScope {
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

  let mechanismIds: string[];
  if (kind === "mechanism") {
    if (!mechanisms.has(id)) throw new Error(`Unknown full mechanism "${id}"`);
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
    .filter((mechanismId) => mechanisms.has(mechanismId))
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
    taskInstruction(mode, mechanismId),
    "Synthesize the candidate list: merge true duplicates, preserve all valid citations, remove contradictions that the cited text does not establish, and grade conservatively. Do not add a claim or citation.",
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

export function toProposal(
  mode: ExtractionMode,
  mechanismId: string,
  item: DraftItem,
  provenance: KnowledgeProvenanceItem[],
  runId: string,
  proposedAt: string,
): Proposal | null {
  const itemConfidence = confidence(item.confidence);
  if (itemConfidence === null) return null;
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

function computeUsd(
  config: ExtractionOpsConfig,
  usage: Usage,
): number {
  const usd = (["cheap", "strong"] as const).reduce((sum, name) => {
    const tier = configuredTier(config, name);
    const tierUsage = usage.byTier[name];
    return (
      sum +
      tierUsage.input * tier.input_usd_per_token +
      tierUsage.output * tier.output_usd_per_token
    );
  }, 0);
  return Math.round(usd * 1e8) / 1e8;
}

function writeManifest(
  mode: ExtractionMode,
  scope: ExtractionScope,
  startedAt: Date,
  usage: Usage,
  stats: ExtractionStats,
  estimatedUsd: number,
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
    cost: {
      api_calls: usage.calls,
      duration_s: duration,
      tokens_in: usage.input,
      tokens_out: usage.output,
      estimated_usd: estimatedUsd,
    },
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

  for (const mechanismId of args.scope.mechanismIds) {
    const corpus = corpusFor(args.mode, mechanismId);
    const records = eligibleRecords(corpus);
    if (records.length === 0) continue;
    processedByMechanism.set(
      mechanismId,
      records.map((record) => record.record_id),
    );
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
    }
    const synthesized = await callOpenRouter(
      context,
      "strong",
      strongPrompt(args.mode, mechanismId, candidates),
      STRONG_OUTPUT_RESERVE,
    );
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
    context.usage,
    stats,
    computeUsd(args.config, context.usage),
    proposals.length + pendingWrites.size,
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
  const scope = resolveScope(params);
  if (command === "quote") {
    const quote = buildQuote(params.mode, scope, config);
    writeFileSync(QUOTE_FILE, json(quote));
    console.log(json(quote).trim());
    if (!quote.allowed) process.exitCode = 1;
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

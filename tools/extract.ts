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
import { resolveEffectBasis, type ResolvedEffectBasis } from "../lib/effect-basis";
import {
  computeBudgetSnapshot,
  extractionPriceState,
  loadExtractionOpsConfigFromDisk,
  validateExtractionOpsConfig,
} from "../lib/ops";
import { EXTRACTION_RUN_ID_PREFIX } from "../lib/proposal-meta";
import {
  buildVariablePrompt,
  judgeTransferabilityV2,
  parseVariableJudgement,
  transferabilityClaimOfProposal,
  TRANSFERABILITY_RULESET_VERSION_V2,
  type TransferabilityClaim,
} from "../lib/transferability";
import {
  evidenceSourceText,
  groundingErrors,
  hasNovelEnrichment,
  mergeProposals,
  normalizeQualityText,
  patternParameterErrors,
  proposalSimilarity,
  realizationGroundingErrors,
  realizationSourceText,
  sha256Hex,
} from "../lib/proposal-quality";
import { writeRunProgress } from "./progress";
import { checkSpanRole } from "../lib/span-role";
import {
  INFERENCE_SPAN_ABSENT_REASON,
  isSpanRole,
  PARAMETER_EVIDENCE_BASIS_NONE,
  SPAN_ROLES,
  TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS,
} from "../lib/types";
import type {
  ArtifactType,
  AxisScore,
  CorpusManifest,
  CorpusManifestCost,
  CorpusManifestRun,
  CorpusRunStatus,
  DossierDraftAxis,
  DossierDraftPayload,
  DossierEvidenceSource,
  Effect,
  EvidenceCorpusFile,
  EvidenceCorpusRecord,
  EvidenceGrade,
  EvidenceProvenanceItem,
  InferenceProvenanceItem,
  ExtractionModelTierConfig,
  ExtractionOpsConfig,
  HardRule,
  Implementation,
  KnowledgeProvenanceItem,
  Mechanism,
  PackMapFile,
  Proposal,
  ProvenanceSourceSpan,
  ReaderCoverageFile,
  Realization,
  RealizationDerivation,
  RealizationParameter,
  RealizationCorpusFile,
  RealizationCorpusRecord,
  RealizationCorpusProvenanceItem,
  ExtractionPass,
  RejectedCandidateComparison,
  RejectedCandidateCorpusSide,
  Relation,
  RunProgressSummary,
  Segment,
  SeedStub,
  SegmentsFile,
  SpanRole,
  TransferabilityVerdictUnavailableReason,
  UngroundedDropReason,
  VariableJudgement,
} from "../lib/types";
import {
  anchorCitations,
  resolveRefs,
  SpanLedger,
} from "./provenance-refs";
import {
  createRejectionLog,
  rejectionRecord,
  type RejectionLog,
} from "./rejected-candidates";
import { CandidateLedger, writeCandidateLedger } from "./candidate-ledger";
import { checkLedgerBalance } from "../lib/candidate-ledger";

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
export type ScopeKind = "mechanism" | "pack" | "segment" | "effect";

/** Modes that draft a whole first-time artifact for a seed candidate (D-085). */
export function isDraftMode(mode: ExtractionMode): mode is "mechanism" | "dossier" {
  return mode === "mechanism" || mode === "dossier";
}

export interface ExtractionScope {
  kind: ScopeKind;
  id: string;
  mechanismIds: string[];
  /**
   * The L2 effect this run is aimed at, resolved from /effects or from the
   * pending proposal queue (D-112). Present only for kind="effect", which is
   * accepted by mode=realizations alone: it switches that mode from describing
   * what sources observed to transferring an effect into product-UI patterns,
   * and the effect's text is what the models are anchored on.
   */
  effectBasis?: ResolvedEffectBasis;
}

/**
 * Whether this run infers product-UI patterns from an effect rather than
 * describing observations (D-112). One derivation per run, decided by the scope,
 * so a single proposal can never be half reported and half inferred.
 */
export function realizationDerivation(
  scope: ExtractionScope,
): RealizationDerivation {
  return scope.kind === "effect" ? "inferred" : "reported";
}

/**
 * The one domain every realization in this repository is applied in. Named
 * rather than inlined because it is written into data (D-112), and a phrase
 * written into data from three places drifts into three phrases.
 */
const APPLICATION_DOMAIN = "product UI";

/**
 * Where a REPORTED realization's evidence was observed: the realization corpus
 * holds captures of shipped product interfaces (D-081), so its source domain is
 * the application domain and there is no transfer.
 */
const REPORTED_SOURCE_DOMAIN = APPLICATION_DOMAIN;

export interface ExtractionQuote {
  mode: ExtractionMode;
  scope: { kind: ScopeKind; id: string; mechanism_ids: string[] };
  calls: { cheap: number; strong: number; total: number };
  tokens: { input_upper_bound: number; output_reserved: number; total_upper_bound: number };
  records: {
    eligible_total: number;
    already_completed: number;
    skipped_irrelevant: number;
    selected: number;
    remaining: number;
    /**
     * Relevant records the planner refused to fit under per_run_tokens (D-103).
     * Equal to `remaining` for a single plan — the same count under the name
     * that says WHY those records were left out, so a reader cannot mistake
     * "the cap changed the question" for "the corpus ran out".
     */
    dropped_truncation: number;
  };
  capped: boolean;
  resumable: boolean;
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
  /**
   * Offsets of the quote in the record's source text, present once
   * `anchorCitations` or `resolveRefs` has located it (D-110). Optional because
   * a citation as a model emitted it has not been anchored yet — models are
   * never asked for character arithmetic. Provenance that reaches a proposal
   * must have them; see `requireSpans` in `groundingOutcome`.
   */
  start?: number;
  end?: number;
  /**
   * What the span is doing in its source (D-129). Asserted by the extraction
   * model, which is the pass that actually read the record, then checked against
   * the text. Typed loosely because it arrives from a model: `spanRoleOutcome`
   * validates it against SPAN_ROLES rather than trusting the string.
   */
  span_role?: unknown;
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
  /** Synthesis-side provenance: refs only, resolved back to citations (D-104). */
  provenance_refs?: unknown;
}

export interface DraftItem {
  id?: string | null;
  name?: string;
  fact?: string;
  boundary?: string;
  grade?: string;
  term?: string;
  description_as_reported?: string;
  artifact_context?: string[];
  /** mode=realizations, effect-anchored (D-112): the transferred UI directive. */
  pattern?: string;
  /**
   * mode=realizations, effect-anchored (D-115): the thresholds `pattern`
   * references as {name}. `unknown` because evidence_basis is code-filled, so
   * whatever the model sends for it is validated away rather than trusted.
   */
  parameters?: unknown;
  /** mode=realizations, effect-anchored (D-112): the domain evidence came from. */
  source_domain?: string;
  pair?: string[];
  type?: string;
  source?: string;
  value?: string;
  confidence?: number;
  citations?: CitationDraft[];
  /**
   * Opaque handles to spans the extraction pass already resolved (D-104). This
   * is the ONLY provenance field the synthesis pass may emit; the resolver turns
   * refs back into `citations` with quotes derived from the stored offsets, so a
   * synthesis model cannot author or alter provenance. Typed `unknown` because
   * it arrives from a model and is validated, not trusted.
   */
  provenance_refs?: unknown;
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

export type ExtractionStage = "extract" | "synthesize";
export type ResponseTolerance =
  | "strict"
  | "markdown_code_fence"
  | "bare_array"
  | "embedded_json";

export interface ParsedDraftResponse {
  items: DraftItem[];
  tolerance: ResponseTolerance;
}

export class OpenRouterOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterOutputValidationError";
  }
}

interface JsonSchema {
  [key: string]: unknown;
}

const citationSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    record_id: { type: "string" },
    quote_or_locus: { type: "string" },
    // Required of the extraction model, and an enum rather than a free string:
    // the gate that reads it is only as good as the vocabulary being closed
    // (D-129). A model that cannot decide has "background" available, which
    // costs it the candidate — that is the intended price.
    span_role: { type: "string", enum: [...SPAN_ROLES] },
  },
  required: ["record_id", "quote_or_locus", "span_role"],
};

const citationsSchema: JsonSchema = {
  type: "array",
  items: citationSchema,
};

/**
 * What the synthesis pass is allowed to say about provenance (D-104): an opaque
 * handle to a span the extraction pass already resolved against the source, and
 * nothing else. No record ids, no quote text, no offsets. The synthesis model
 * never sees a source record, so it cannot be trusted to author provenance —
 * enforced here in the schema, not by asking it nicely in the prompt.
 */
const provenanceRefsSchema: JsonSchema = {
  type: "array",
  items: { type: "string" },
};

const stringArraySchema: JsonSchema = {
  type: "array",
  items: { type: "string" },
};

function strictObject(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = Object.keys(properties),
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

/**
 * Provenance is shaped by the pass, not by the mode (D-104). The extraction pass
 * reads the records and quotes them; the synthesis pass may only point at what
 * extraction already verified.
 */
function provenanceProperty(stage: ExtractionStage): Record<string, JsonSchema> {
  return stage === "extract"
    ? { citations: citationsSchema }
    : { provenance_refs: provenanceRefsSchema };
}

function commonItem(
  properties: Record<string, JsonSchema>,
  stage: ExtractionStage,
): JsonSchema {
  return strictObject({
    ...properties,
    confidence: { type: "number" },
    ...provenanceProperty(stage),
  });
}

function extractionItemSchema(
  mode: ExtractionMode,
  stage: ExtractionStage,
  derivation: RealizationDerivation = "reported",
): JsonSchema {
  switch (mode) {
    case "effects":
      return commonItem(
        {
          id: { type: ["string", "null"] },
          name: { type: "string" },
          fact: { type: "string" },
          boundary: { type: "string" },
          grade: { type: "string" },
        },
        stage,
      );
    case "realizations":
      // The inferred shape asks for the two halves separately (D-112): what the
      // source states, in its own domain, and the product-UI pattern transferred
      // from it. effect_refs is NOT asked for — the run knows which effect it was
      // aimed at, and a model-authored link to an artifact is provenance the
      // model does not get to write (D-104).
      return commonItem(
        derivation === "inferred"
          ? {
              id: { type: ["string", "null"] },
              term: { type: "string" },
              description_as_reported: { type: "string" },
              pattern: { type: "string" },
              source_domain: { type: "string" },
              artifact_context: stringArraySchema,
            }
          : {
              id: { type: ["string", "null"] },
              term: { type: "string" },
              description_as_reported: { type: "string" },
              artifact_context: stringArraySchema,
            },
        stage,
      );
    case "interactions":
      return commonItem(
        {
          pair: stringArraySchema,
          type: { type: "string" },
          fact: { type: "string" },
          grade: { type: "string" },
          boundary: { type: "string" },
          source: { type: "string" },
        },
        stage,
      );
    case "dissent":
      return commonItem({ value: { type: "string" } }, stage);
    case "mechanism":
    case "dossier":
      return commonItem(
        {
          section: { type: "string" },
          fact: { type: "string" },
        },
        stage,
      );
  }
}

function mechanismSynthesisSchema(): JsonSchema {
  return commonItem({
    summary: { type: "string" },
    grade: { type: "string" },
    evidence_basis: { type: "string" },
    effect_size_note: { type: "string" },
    caveats: stringArraySchema,
    funnel_stages: stringArraySchema,
    excluded_stages: stringArraySchema,
    applicability_artifact_types: stringArraySchema,
    preconditions: {
      type: "array",
      items: strictObject({
        predicate: { type: "string" },
        reason: { type: "string" },
      }),
    },
    culture_note: { type: "string" },
    implementations: {
      type: "array",
      items: strictObject({
        id_suffix: { type: "string" },
        artifact_types: stringArraySchema,
        product_requirements: stringArraySchema,
        generation_directive: { type: "string" },
        copy_formulas: stringArraySchema,
        metrics: stringArraySchema,
      }),
    },
    hard_rules: {
      type: "array",
      items: strictObject({
        id: { type: "string" },
        rule: { type: "string" },
        severity: { type: "string" },
      }),
    },
    compliance_refs: stringArraySchema,
    boundary_test: { type: "string" },
    relations: {
      type: "array",
      items: strictObject({
        type: { type: "string" },
        target: { type: "string" },
        note: { type: "string" },
      }),
    },
    reference_examples: {
      type: "array",
      items: strictObject({
        product: { type: "string" },
        what: { type: "string" },
      }),
    },
  }, "synthesize");
}

function dossierSynthesisSchema(): JsonSchema {
  // Per-axis provenance is also refs-only: a dossier axis is scored by the
  // synthesis pass, which has never seen a source record.
  const axis = strictObject({
    score: { type: ["integer", "null"] },
    rationale: { type: ["string", "null"] },
    provenance_refs: provenanceRefsSchema,
  });
  return commonItem(
    {
      scores: strictObject({
        evidence: axis,
        product_applicability: axis,
        measurability: axis,
        orthogonality: axis,
        safety: axis,
      }),
      core_condition: { type: "string" },
      dissent: { type: "string" },
    },
    "synthesize",
  );
}

function responseItemSchema(
  mode: ExtractionMode,
  stage: ExtractionStage,
  derivation: RealizationDerivation = "reported",
): JsonSchema {
  if (stage === "synthesize" && mode === "mechanism") {
    return mechanismSynthesisSchema();
  }
  if (stage === "synthesize" && mode === "dossier") {
    return dossierSynthesisSchema();
  }
  return extractionItemSchema(mode, stage, derivation);
}

export function openRouterResponseFormat(
  mode: ExtractionMode,
  stage: ExtractionStage,
  derivation: RealizationDerivation = "reported",
): JsonSchema {
  return {
    type: "json_schema",
    json_schema: {
      name:
        mode === "realizations"
          ? `motivation_engine_realizations_${derivation}_${stage}`
          : `motivation_engine_${mode}_${stage}`,
      strict: true,
      schema: strictObject({
        items: {
          type: "array",
          items: responseItemSchema(mode, stage, derivation),
        },
      }),
    },
  };
}

export const OPENROUTER_SYSTEM_PROMPT =
  'You are a fail-closed scientific extraction function. Return exactly one JSON object with the envelope {"items":[...]}. Do not return markdown, code fences, explanatory prose, or a bare top-level array. Never use knowledge outside supplied records.';

export function openRouterStructuredOutputOptions(
  mode: ExtractionMode,
  stage: ExtractionStage,
  responseFormat: ExtractionModelTierConfig["response_format"],
  derivation: RealizationDerivation = "reported",
): JsonSchema {
  return responseFormat === "json_schema"
    ? {
        response_format: openRouterResponseFormat(mode, stage, derivation),
        provider: { require_parameters: true },
      }
    : { response_format: { type: "json_object" } };
}

/**
 * The optional sampling parameters for a tier, filtered by what its model
 * advertises (D-107).
 *
 * `require_parameters: true` routes only to a provider that honours EVERY
 * parameter in the request. Sending `temperature` to a model that does not
 * advertise it therefore leaves no eligible provider and the request 404s with
 * "no endpoints found" — no model invoked, no usage block, no cost attribution.
 * That is how runs 30102079781 and 30102271340 died. Omitting the parameter
 * rather than dropping the guard keeps the request fail-closed: a provider that
 * would silently ignore a parameter still cannot serve us.
 *
 * Determinism is unaffected in practice — the omitted case is Claude, whose
 * default sampling we accept — and the alternative (dropping require_parameters)
 * would let a provider silently ignore the response format instead.
 */
export function openRouterSamplingOptions(
  supports: ExtractionModelTierConfig["supports"],
): { temperature?: number } {
  return supports.temperature ? { temperature: 0 } : {};
}

/**
 * The exact request body sent to OpenRouter. Extracted so the preflight can
 * prove the production parameter set routes, rather than probing an
 * approximation of it (D-107).
 */
export function openRouterRequestBody(args: {
  tier: ExtractionModelTierConfig;
  mode: ExtractionMode;
  stage: ExtractionStage;
  prompt: string;
  maxTokens: number;
  /** mode=realizations only: which item shape to ask for (D-112). */
  derivation?: RealizationDerivation;
}): Record<string, unknown> {
  return {
    model: args.tier.model_id,
    messages: [
      { role: "system", content: OPENROUTER_SYSTEM_PROMPT },
      { role: "user", content: args.prompt },
    ],
    ...openRouterStructuredOutputOptions(
      args.mode,
      args.stage,
      args.tier.response_format,
      args.derivation,
    ),
    ...openRouterSamplingOptions(args.tier.supports),
    max_tokens: args.maxTokens,
  };
}

function normalizeDraftResponse(value: unknown): DraftItem[] | null {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 1 &&
        Array.isArray((value as DraftResponse).items)
      ? (value as DraftResponse).items
      : null;
  if (
    rawItems === null ||
    !rawItems.every((item) => typeof item === "object" && item !== null)
  ) {
    return null;
  }
  return rawItems as DraftItem[];
}

function balancedJsonBlocks(value: string): string[] {
  const blocks: string[] = [];
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{" && value[start] !== "[") continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{" || char === "[") {
        stack.push(char);
      } else if (char === "}" || char === "]") {
        const opener = stack.pop();
        if (
          opener === undefined ||
          (char === "}" && opener !== "{") ||
          (char === "]" && opener !== "[")
        ) {
          break;
        }
        if (stack.length === 0) {
          blocks.push(value.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return blocks;
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function parseDraftResponse(content: string): ParsedDraftResponse {
  const trimmed = content.trim();
  const direct = parseJson(trimmed);
  if (direct !== undefined) {
    const items = normalizeDraftResponse(direct);
    if (items) {
      return {
        items,
        tolerance: Array.isArray(direct) ? "bare_array" : "strict",
      };
    }
    throw new OpenRouterOutputValidationError(
      'OpenRouter output must be exactly {"items":[]}',
    );
  }

  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) {
    const fenced = parseJson(fence[1]);
    const items = fenced === undefined ? null : normalizeDraftResponse(fenced);
    if (items) return { items, tolerance: "markdown_code_fence" };
  }

  for (const block of balancedJsonBlocks(trimmed)) {
    const parsed = parseJson(block);
    const items = parsed === undefined ? null : normalizeDraftResponse(parsed);
    if (items) return { items, tolerance: "embedded_json" };
  }

  throw new OpenRouterOutputValidationError(
    'OpenRouter output must contain valid JSON matching {"items":[]}',
  );
}

export type SettledResponseBatch<T> =
  | { ok: true; value: T }
  | { ok: false; error: OpenRouterOutputValidationError };

export async function settleResponseBatch<T>(
  operation: () => Promise<T>,
): Promise<SettledResponseBatch<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof OpenRouterOutputValidationError) {
      return { ok: false, error };
    }
    throw error;
  }
}

export function everyResponseBatchFailed(
  attempted: number,
  succeeded: number,
): boolean {
  return attempted > 0 && succeeded === 0;
}

export interface ExtractionStats {
  candidates: number;
  /**
   * Candidates split by the pass that produced them (D-105). The cheap pass
   * reads the source records; the strong pass only ever sees cheap output. They
   * were previously merged into `candidates` with the cheap pass uncounted, so a
   * cheap-pass loss was invisible. `candidates` remains the total.
   */
  candidates_cheap: number;
  candidates_strong: number;
  records_processed: number;
  records_skipped_irrelevant: number;
  dropped_ungrounded: number;
  /** Ungrounded drops split by pass (D-105); the two sum to dropped_ungrounded. */
  dropped_ungrounded_cheap: number;
  dropped_ungrounded_strong: number;
  failed_validation: number;
  proposed: number;
  /**
   * Kept as the sum of the two fates below, because /ops and every committed
   * run entry already read it. On its own it is not an outcome: it conflated a
   * candidate ABSORBED into a pending proposal (no file) with one WRITTEN as an
   * enrichment of an approved artifact (a file), so proposals_out was not
   * derivable from it (D-132).
   */
  merged: number;
  /** Absorbed into an earlier pending proposal; produces no file of its own. */
  merged_into_pending: number;
  /** Written to the queue as an enrichment of an approved artifact. */
  proposed_enrich: number;
  held_low_confidence: number;
  /**
   * Grounded, and refused by the transferability rules (D-160). A HELD fate,
   * not a dropped one: the proposal file is written with the verdict that held
   * it, and no reader coverage is consumed, so the record can always be
   * reconsidered. Counted separately from held_low_confidence because the two
   * say different things — one is "we are unsure", the other is "there is
   * nothing here a product can act on".
   */
  held_non_transferable: number;
  /**
   * Admitted WITHOUT a transferability verdict because the v2 VARIABLE check
   * could not produce one (D-162 fails open). NOT a candidate fate — the
   * candidate still gets its real fate (proposed / merged_into_pending / …), so
   * the D-132 conservation equation is untouched and still balances. That is
   * exactly why this counter has to exist separately: the ledger balancing is
   * what made the loss invisible in the first place. Conservation proves no
   * candidate vanished; it says nothing about whether anyone judged it.
   */
  verdict_unavailable: number;
  /** The same total, split by cause — a cap-driven run and an outage look identical without it. */
  verdict_unavailable_by_reason: Record<TransferabilityVerdictUnavailableReason, number>;
  dropped_volume_cap: number;
  dropped_volume_cap_high_confidence: number;
  /**
   * Synthesis output past the first item, discarded by a draft mode (D-085).
   * Previously never counted as a candidate at all, so a draft run that
   * composed four artifacts and kept one reported having composed one.
   */
  dropped_draft_cap: number;
  /**
   * The cheap-to-strong stage (D-132), where the loss hid. Grounded cheap
   * candidates handed to a synthesis call that RETURNED, those lost with a
   * synthesis call that failed, and the fold between the two totals — a
   * consolidation of several candidates into one is legitimate, but it is a
   * fate, and until now it had no name and no counter.
   */
  into_synthesis: number;
  cheap_synthesis_failed: number;
  consolidated_by_synthesis: number;
  expanded_by_synthesis: number;
  /** Funnel (D-090): total eligible records in the corpus at run start. */
  records_eligible: number;
  /** Funnel (D-090): eligible records that passed the cheap relevance pre-filter. */
  records_relevant: number;
  /** Funnel (D-090): relevant records still unread after this run (0 = corpus exhausted). */
  records_remaining: number;
  /**
   * Records the planner KEPT across every slice of this run (D-103), summed as
   * each slice is planned. Distinct from records_processed, which counts what
   * was actually sent to a model: the two agree unless a slice died before its
   * batches ran, and that divergence is itself worth reading.
   */
  records_selected: number;
  /**
   * Records the planner DROPPED to fit per_run_tokens (D-103). A run that
   * covered a third of its scope and one that covered all of it used to look
   * identical in the report; this is the number that tells them apart. Not the
   * same as records_remaining, which also carries retryable failed batches.
   */
  records_dropped_truncation: number;
  /**
   * Per-reason breakdown of dropped_ungrounded (D-098). Keys are
   * UngroundedReason; only non-zero reasons are present. The values always sum
   * to dropped_ungrounded — this attributes the existing total, it does not
   * change which candidates are admitted.
   */
  dropped_ungrounded_reasons: Partial<Record<UngroundedReason, number>>;
  /**
   * The same attribution, per pass (D-105). Reading the two apart is the only
   * way to tell "the extractor could not ground it" from "synthesis broke the
   * provenance the extractor had already grounded".
   */
  dropped_ungrounded_reasons_cheap: Partial<Record<UngroundedReason, number>>;
  dropped_ungrounded_reasons_strong: Partial<Record<UngroundedReason, number>>;
}

/**
 * Count one ungrounded drop against the total, its reason, and the pass that
 * produced it (D-098 for the reason, D-105 for the pass).
 */
export function recordUngroundedDrop(
  stats: ExtractionStats,
  pass: ExtractionPass,
  reason: UngroundedReason,
): void {
  stats.dropped_ungrounded += 1;
  stats.dropped_ungrounded_reasons[reason] =
    (stats.dropped_ungrounded_reasons[reason] ?? 0) + 1;
  if (pass === "cheap") {
    stats.dropped_ungrounded_cheap += 1;
    stats.dropped_ungrounded_reasons_cheap[reason] =
      (stats.dropped_ungrounded_reasons_cheap[reason] ?? 0) + 1;
  } else {
    stats.dropped_ungrounded_strong += 1;
    stats.dropped_ungrounded_reasons_strong[reason] =
      (stats.dropped_ungrounded_reasons_strong[reason] ?? 0) + 1;
  }
}

/** Stable "reason=count" rendering, densest first, for logs and run params. */
export function formatUngroundedReasons(
  reasons: Partial<Record<UngroundedReason, number>>,
): string {
  return Object.entries(reasons)
    .filter(([, count]) => (count ?? 0) > 0)
    .sort(
      ([leftKey, leftCount], [rightKey, rightCount]) =>
        (rightCount ?? 0) - (leftCount ?? 0) || leftKey.localeCompare(rightKey),
    )
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
}

export interface ReaderCoverageDelta {
  processed_record_ids: readonly string[];
  skipped_irrelevant_record_ids: readonly string[];
}

function sortedUnion(...groups: (readonly string[] | undefined)[]): string[] {
  return Array.from(new Set(groups.flatMap((group) => group ?? []))).sort();
}

export function mergeReaderCoverage(
  previous: ReaderCoverageFile | null,
  mode: ExtractionMode,
  processed: ReadonlyMap<string, ReaderCoverageDelta>,
  processedAt: string,
  // Which corpus the ids belong to. Derived from the mode by default, but an
  // effect-anchored realizations run reads the EVIDENCE corpus (D-112), and
  // filing those ids under the realization ledger would both mislabel them and
  // hide them from the planner, which reads back the branch it read from — so
  // the run would re-read and re-pay for the same records forever.
  corpusKind: "evidence" | "realization" = mode === "realizations"
    ? "realization"
    : "evidence",
  // The effect this run is anchored on (D-140), present only for a
  // scope_kind="effect" realizations run. When set, the delta is ALSO
  // recorded into by_effect[effectId] — the bucket buildExtractionPlan
  // consults for an effect-anchored run's terminal set — in addition to the
  // mode-level union below, which keeps its pre-D-140 meaning unchanged.
  effectId?: string,
): ReaderCoverageFile {
  const kind = corpusKind;
  const mechanisms = structuredClone(previous?.mechanisms ?? {});
  for (const [mechanismId, delta] of Array.from(processed.entries())) {
    const mechanism = mechanisms[mechanismId] ?? {};
    const prior = mechanism[kind];
    const priorMode = prior?.by_mode[mode];
    const modeProcessed = sortedUnion(
      priorMode?.processed_record_ids,
      delta.processed_record_ids,
    );
    const modeSkipped = sortedUnion(
      priorMode?.skipped_irrelevant_record_ids,
      delta.skipped_irrelevant_record_ids,
    );
    const byEffect = effectId
      ? {
          ...(priorMode?.by_effect ?? {}),
          [effectId]: {
            processed_record_ids: sortedUnion(
              priorMode?.by_effect?.[effectId]?.processed_record_ids,
              delta.processed_record_ids,
            ),
            skipped_irrelevant_record_ids: sortedUnion(
              priorMode?.by_effect?.[effectId]?.skipped_irrelevant_record_ids,
              delta.skipped_irrelevant_record_ids,
            ),
            processed_at: processedAt,
          },
        }
      : priorMode?.by_effect;
    mechanism[kind] = {
      processed_record_ids: sortedUnion(
        prior?.processed_record_ids,
        modeProcessed,
        modeSkipped,
      ),
      processed_at: processedAt,
      modes: Array.from(new Set([...(prior?.modes ?? []), mode])).sort(),
      by_mode: {
        ...(prior?.by_mode ?? {}),
        [mode]: {
          processed_record_ids: modeProcessed,
          skipped_irrelevant_record_ids: modeSkipped,
          processed_at: processedAt,
          ...(byEffect ? { by_effect: byEffect } : {}),
        },
      },
    };
    mechanisms[mechanismId] = mechanism;
  }
  return {
    version: "1.2.0",
    updated_at: processedAt,
    mechanisms,
  };
}

function writeReaderCoverage(
  mode: ExtractionMode,
  processed: ReadonlyMap<string, ReaderCoverageDelta>,
  processedAt: string,
  corpusKind?: "evidence" | "realization",
  effectId?: string,
): void {
  mkdirSync(EXTRACTION_DIR, { recursive: true });
  const previous = existsSync(READER_COVERAGE_FILE)
    ? readJson<ReaderCoverageFile>(READER_COVERAGE_FILE)
    : null;
  writeFileSync(
    READER_COVERAGE_FILE,
    json(
      mergeReaderCoverage(previous, mode, processed, processedAt, corpusKind, effectId),
    ),
  );
}

export function extractionSummaryParams(
  stats: ExtractionStats,
): Record<string, string> {
  return {
    candidates: String(stats.candidates),
    records_processed: String(stats.records_processed),
    records_skipped_irrelevant: String(stats.records_skipped_irrelevant),
    proposed: String(stats.proposed),
    merged: String(stats.merged),
    dropped_ungrounded: String(stats.dropped_ungrounded),
    failed_validation: String(stats.failed_validation),
    held_low_confidence: String(stats.held_low_confidence),
    held_non_transferable: String(stats.held_non_transferable),
    verdict_unavailable: String(stats.verdict_unavailable),
    // Written even when zero, and split by cause: "the filter refused nothing"
    // and "the filter never ran" are different runs, and the manifest is where
    // that distinction has to survive the run that produced it.
    verdict_unavailable_by_reason: TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS.map(
      (reason) => `${reason}=${stats.verdict_unavailable_by_reason[reason]}`,
    ).join(" "),
    dropped_volume_cap: String(stats.dropped_volume_cap),
    dropped_volume_cap_high_confidence: String(
      stats.dropped_volume_cap_high_confidence,
    ),
    records_eligible: String(stats.records_eligible),
    records_relevant: String(stats.records_relevant),
    records_remaining: String(stats.records_remaining),
    // D-103: available / kept / dropped-to-fit, written unconditionally so a
    // zero is a measurement and an absent field means the run predates it.
    records_selected: String(stats.records_selected),
    records_dropped_truncation: String(stats.records_dropped_truncation),
    // The per-pass funnel is always present from D-105 on, even at zero: its
    // absence is what tells /ops a run predates the cheap-pass gate, so writing
    // it unconditionally is what makes "not split" a truthful reading.
    candidates_cheap: String(stats.candidates_cheap),
    candidates_strong: String(stats.candidates_strong),
    dropped_ungrounded_cheap: String(stats.dropped_ungrounded_cheap),
    dropped_ungrounded_strong: String(stats.dropped_ungrounded_strong),
    // The conservation counters (D-132), also unconditional: a run whose params
    // lack them predates the invariant, and that is exactly what the ledger's
    // reconstruction status has to say out loud rather than leave to inference.
    merged_into_pending: String(stats.merged_into_pending),
    proposed_enrich: String(stats.proposed_enrich),
    dropped_draft_cap: String(stats.dropped_draft_cap),
    into_synthesis: String(stats.into_synthesis),
    cheap_synthesis_failed: String(stats.cheap_synthesis_failed),
    consolidated_by_synthesis: String(stats.consolidated_by_synthesis),
    expanded_by_synthesis: String(stats.expanded_by_synthesis),
    // Only present when something was actually dropped, so a clean run does
    // not carry an empty field and pre-D-098 runs stay readable as absent.
    ...(stats.dropped_ungrounded > 0
      ? {
          dropped_ungrounded_reasons: formatUngroundedReasons(
            stats.dropped_ungrounded_reasons,
          ),
        }
      : {}),
    ...(stats.dropped_ungrounded_cheap > 0
      ? {
          dropped_ungrounded_reasons_cheap: formatUngroundedReasons(
            stats.dropped_ungrounded_reasons_cheap,
          ),
        }
      : {}),
    ...(stats.dropped_ungrounded_strong > 0
      ? {
          dropped_ungrounded_reasons_strong: formatUngroundedReasons(
            stats.dropped_ungrounded_reasons_strong,
          ),
        }
      : {}),
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
  options: { includeSeeds?: boolean; mode?: ExtractionMode } = {},
): ExtractionScope {
  const supplied = (["mechanism", "pack", "segment", "effect"] as const).filter(
    (key) => params[key],
  );
  if (supplied.length !== 1) {
    throw new Error(
      "Provide exactly one scope: mechanism=, pack=, segment=, or effect=",
    );
  }
  const kind = supplied[0];
  const id = params[kind];
  const mechanisms = fullMechanisms();
  if (kind === "effect") {
    // An effect scope only means anything for realizations: it is the transfer
    // input, and no other mode consumes one (D-112).
    if (options.mode && options.mode !== "realizations") {
      throw new Error(
        `effect= scope is only valid with mode=realizations, not mode=${options.mode}`,
      );
    }
    const basis = resolveEffectBasis(id, ROOT);
    if (!basis) {
      throw new Error(
        `Unknown effect "${id}" — expected effects/{mechanism}/${id}.json or a live proposals/effect entry`,
      );
    }
    if (!mechanisms.has(basis.effect.mechanism_id)) {
      throw new Error(
        `Effect "${id}" belongs to ${basis.effect.mechanism_id}, which is not a full mechanism record`,
      );
    }
    return {
      kind,
      id,
      mechanismIds: [basis.effect.mechanism_id],
      effectBasis: basis,
    };
  }
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

/**
 * Which corpus a run reads. mode=realizations normally reads the interface
 * observation corpus, but an effect-anchored run reads the EVIDENCE corpus
 * (D-112): the material it transfers from is the literature the effect was
 * extracted out of, and reading it there is also what makes each quote
 * span-verifiable, which realization-corpus provenance never is (D-110).
 */
function readsRealizationCorpus(
  mode: ExtractionMode,
  scope?: ExtractionScope,
): boolean {
  return mode === "realizations" && scope?.kind !== "effect";
}

function corpusFor(
  mode: ExtractionMode,
  mechanismId: string,
  scope?: ExtractionScope,
): ExtractionCorpus {
  const fromRealizations = readsRealizationCorpus(mode, scope);
  const path = fromRealizations
    ? join(REALIZATION_CORPUS_DIR, mechanismId, "records.json")
    : join(CORPUS_DIR, `${mechanismId}.json`);
  if (!existsSync(path) && fromRealizations) {
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

const GENERIC_RELEVANCE_TOKENS = new Set([
  "effect",
  "effects",
  "meta",
  "analysis",
  "analyses",
  "replication",
  "motivation",
  "theory",
  "model",
  "review",
  "systematic",
  "consumer",
  "consumers",
]);

function relevanceTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4),
  );
}

function corpusCoreKeywords(corpus: ExtractionCorpus): string[] {
  if (isRealizationCorpus(corpus)) return [];
  const keywords = new Set<string>();
  for (const term of corpus.terms) {
    for (const token of Array.from(relevanceTokens(term))) {
      if (!GENERIC_RELEVANCE_TOKENS.has(token)) keywords.add(token);
    }
  }
  return Array.from(keywords).sort();
}

function keywordHits(value: string, keywords: readonly string[]): number {
  const tokens = relevanceTokens(value);
  return keywords.filter((keyword) => tokens.has(keyword)).length;
}

/**
 * Deterministic, zero-network funnel gate. Pinned evidence is never discarded;
 * tier 1 requires title + abstract confirmation, and tier 2 is the weaker
 * relevant tail. null is terminal skipped_irrelevant for this mode.
 */
export function recordRelevanceTier(
  corpus: ExtractionCorpus,
  record: ExtractionRecord,
): 0 | 1 | 2 | null {
  if (isRealizationRecord(record)) return 1;
  if (record.source_api === "pinned" || record.pin_reason) return 0;
  const keywords = corpusCoreKeywords(corpus);
  // A corpus without usable distinctive terms cannot be rejected safely.
  if (keywords.length === 0) return 2;
  const titleHits = keywordHits(record.title, keywords);
  const abstractHits = keywordHits(record.abstract ?? "", keywords);
  if (titleHits >= 1 && abstractHits >= 1) return 1;
  if (titleHits >= 1 || abstractHits >= 2) return 2;
  return null;
}

/**
 * What an effect-anchored run ranks records against (D-112).
 *
 * Deliberately a RANKING input, never a skip decision. The reader-coverage
 * ledger is keyed by corpus and mode, not by effect, so marking a record
 * "irrelevant" because it misses one effect's vocabulary would hide it from
 * every later realizations run for every other effect on the same mechanism.
 * Ranking leaves the unread tail as `remaining`, which is what it is.
 *
 * DELIBERATELY UNCOVERED: records this run READS still become terminal for
 * mode=realizations, so a second effect on the same mechanism will not re-read
 * them. Re-reading is the spend the ledger exists to prevent, and per-effect
 * coverage would mean a schema key per effect; the limit is stated here instead
 * of being discovered later.
 */
interface EffectAnchor {
  effect: Effect;
  keywords: readonly string[];
  /** Records the effect itself cites: read first, always. */
  citedRecordIds: ReadonlySet<string>;
}

function effectAnchor(scope?: ExtractionScope): EffectAnchor | null {
  const basis = scope?.effectBasis;
  if (!basis) return null;
  const { effect } = basis;
  const keywords = new Set<string>();
  for (const token of Array.from(
    relevanceTokens(`${effect.name} ${effect.fact} ${effect.boundary}`),
  )) {
    if (!GENERIC_RELEVANCE_TOKENS.has(token)) keywords.add(token);
  }
  return {
    effect,
    keywords: Array.from(keywords).sort(),
    citedRecordIds: new Set(
      effect.provenance.map((item) => item.corpus_record_id),
    ),
  };
}

/** How closely a record speaks to the anchored effect; lower reads first. */
function effectAffinity(
  anchor: EffectAnchor,
  record: ExtractionRecord,
): 0 | 1 | 2 | 3 {
  if (anchor.citedRecordIds.has(record.record_id)) return 0;
  if (isRealizationRecord(record)) return 3;
  const titleHits = keywordHits(record.title, anchor.keywords);
  const abstractHits = keywordHits(record.abstract ?? "", anchor.keywords);
  if (titleHits >= 1 && abstractHits >= 1) return 1;
  if (titleHits >= 1 || abstractHits >= 2) return 2;
  return 3;
}

export function rankRelevantRecords(
  corpus: ExtractionCorpus,
  records: readonly ExtractionRecord[],
  anchor: EffectAnchor | null = null,
): { records: ExtractionRecord[]; skippedIrrelevantIds: string[] } {
  const ranked: { record: ExtractionRecord; tier: 0 | 1 | 2 }[] = [];
  const skippedIrrelevantIds: string[] = [];
  for (const record of records) {
    const tier = recordRelevanceTier(corpus, record);
    if (tier === null) {
      skippedIrrelevantIds.push(record.record_id);
    } else {
      ranked.push({ record, tier });
    }
  }
  if (anchor) {
    // Effect affinity outranks the corpus-wide tier: a run aimed at one effect
    // must spend its token cap on the records that speak to that effect.
    ranked.sort((left, right) => {
      const affinity =
        effectAffinity(anchor, left.record) - effectAffinity(anchor, right.record);
      if (affinity !== 0) return affinity;
      return (
        left.tier - right.tier ||
        left.record.record_id.localeCompare(right.record.record_id)
      );
    });
    return {
      records: ranked.map(({ record }) => record),
      skippedIrrelevantIds: skippedIrrelevantIds.sort(),
    };
  }
  ranked.sort((left, right) => {
    const leftCitations = isRealizationRecord(left.record)
      ? -1
      : (left.record.citations ?? -1);
    const rightCitations = isRealizationRecord(right.record)
      ? -1
      : (right.record.citations ?? -1);
    return (
      left.tier - right.tier ||
      rightCitations - leftCitations ||
      left.record.record_id.localeCompare(right.record.record_id)
    );
  });
  return {
    records: ranked.map(({ record }) => record),
    skippedIrrelevantIds: skippedIrrelevantIds.sort(),
  };
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

/**
 * How each pass is told to express provenance (D-104).
 *
 * The extraction pass sees records and quotes them. The synthesis pass sees no
 * records, so it is told to carry refs forward — which is also all its schema
 * permits, and all the resolver will accept. The prompt only explains the shape
 * the code already enforces; it is not what makes provenance immutable.
 */
function provenanceInstruction(
  mode: ExtractionMode,
  stage: ExtractionStage,
  anchor: EffectAnchor | null = null,
): string {
  if (stage === "synthesize") {
    return "Every item must include provenance_refs: the opaque provenance handles of the candidates it draws on, copied unchanged. Never emit record ids, quotes, or offsets — provenance was established upstream and cannot be authored here. If an item has no supporting ref, omit it.";
  }
  const locus =
    mode === "realizations" && !anchor
      ? "a supplied title or observation"
      : "a supplied title or abstract";
  return [
    `Every item must include citations [{record_id,quote_or_locus,span_role}] using only supplied records.`,
    `quote_or_locus must be an exact span from ${locus}.`,
    "span_role states what the span is DOING in the source it was cut from, and is checked against the text:",
    "- background: what the literature, a theory, or prior work says. Includes anything the source is restating rather than testing, and anything it introduces in order to motivate its own question.",
    "- hypothesis: what this source predicted or set out to test.",
    "- method: what was done — design, materials, participants, procedure.",
    "- finding: what THIS source observed in ITS OWN data. Results and conclusions about those results.",
    "- limitation: what this source says it cannot show, or where its result did not hold.",
    "A verbatim quote can still misrepresent a paper. A sentence that states what cognitive load theory PREDICTS is background even if the paper agrees with it, and even if the same paper later confirms it — and some papers report the OPPOSITE of the prediction they open with. Read the sentences after your quote before choosing: if the source goes on to qualify or contradict it, the span is background, not a finding.",
    "Only span_role=finding can ground a fact, so a candidate whose only citations are background, hypothesis, method, or limitation will be dropped. Do not relabel a background span as a finding to save an item — a dropped candidate costs nothing, a false one is filed as knowledge.",
    "If an item cannot be grounded, omit it.",
  ].join(" ");
}

/**
 * The effect the run transfers from, stated to the model as the fixed anchor it
 * is (D-112). Both passes see it: the extraction pass needs it to know which
 * material is on-topic, and the synthesis pass composes the final patterns and
 * would otherwise be transferring from candidates alone.
 */
function anchorBlock(anchor: EffectAnchor): string {
  const { effect } = anchor;
  return [
    "EFFECT (the fixed anchor; treat its wording as given, do not restate it as a finding):",
    JSON.stringify({
      id: effect.id,
      name: effect.name,
      fact: effect.fact,
      boundary: effect.boundary,
      grade: effect.grade,
    }),
  ].join("\n");
}

/**
 * What an effect-anchored realizations run asks for (D-112).
 *
 * Two fields, deliberately: `description_as_reported` stays inside the domain
 * the evidence was measured in, and `pattern` is the product-UI directive
 * transferred out of it. Splitting them is what lets a reader see which half a
 * source supports — a single blended sentence hides the seam, and the seam is
 * the thing under review.
 */
function inferredRealizationInstruction(
  mechanismId: string,
  provenanceField: string,
): string {
  return [
    `Propose implementable product-UI patterns that follow from the anchored effect for ${mechanismId}.`,
    "A pattern must be concrete enough to build without further interpretation: name the interface element, the trigger or threshold that changes it, and what the user sees before and after. \"Collapse the guided tour once the user has completed the core action {core_action_completions} times\" is a pattern; \"adapt to user expertise\" is not.",
    "Fields per item:",
    "- term: a short name for the pattern.",
    "- description_as_reported: what the cited source states, in the source's own domain vocabulary. Do not describe a product interface here, and do not generalise beyond the quote.",
    "- pattern: the product-UI directive transferred from it, in the imperative. This is your inference, not the source's claim. NEVER write a number in this text, as a digit or as a word — no source measured a threshold for a product interface, and a number in prose reads as if one had. Write {snake_case_name} instead and declare it in parameters.",
    "- parameters: one entry per {name} the pattern references, as {name, value (your suggested default), unit (what the number counts, in words), evidence_basis: \"none — default heuristic\"}. Every parameter must be referenced by the pattern and every placeholder must be declared.",
    "- source_domain: the field the cited evidence was measured in, as the records themselves describe it (for example \"medical education\" or \"multimedia instructional design\"). Never write a product or software domain here.",
    `- artifact_context: where the pattern applies, from this vocabulary where one fits: ${ARTIFACT_TYPES.join("|")}.`,
    "- confidence: your confidence in the TRANSFER holding in a product interface, not in the effect being real. No source measured this pattern in a product, so a value above 0.8 is not credible.",
    `- ${provenanceField}.`,
    "Do not claim or imply that the pattern has been tested in a product. Do not propose a pattern that merely restates the effect.",
  ].join("\n");
}

function taskInstruction(
  mode: ExtractionMode,
  mechanismId: string,
  stage: ExtractionStage = "extract",
  anchor: EffectAnchor | null = null,
): string {
  const provenanceField = stage === "synthesize" ? "provenance_refs" : "citations";
  const shared = `Return exactly one JSON object with this envelope: {"items":[]}. Do not return markdown, code fences, prose, or a bare top-level array. ${provenanceInstruction(mode, stage, anchor)}`;
  switch (mode) {
    case "effects":
      return `${shared} Extract distinct named phenomena produced by ${mechanismId}. Fields: id, name, fact, boundary, grade (A+..C-), confidence, ${provenanceField}.`;
    case "realizations":
      return anchor
        ? `${shared}\n\n${inferredRealizationInstruction(mechanismId, provenanceField)}\n\n${anchorBlock(anchor)}`
        : `${shared} Extract concrete interface, copy, or flow embodiments reported in sources for ${mechanismId}. Use neutral descriptive language. Fields: id, term, description_as_reported, artifact_context (strings), confidence, ${provenanceField}.`;
    case "interactions":
      return `${shared} Extract only pairs of known mechanism ids explicitly treated together. Fields: pair (two sorted mechanism ids), type (sequence-amplifying|reinforcing|suppressing|neutral), fact, grade, boundary, source, confidence, ${provenanceField}.`;
    case "dissent":
      return `${shared} Extract critiques, failed replications, null findings, and boundary findings for ${mechanismId}. Fields: value (concise markdown), confidence, ${provenanceField}.`;
    case "mechanism":
      return `${shared} Extract record-drafting claims about the motivation mechanism ${mechanismId}: what it is and predicts (section=summary), the strength and basis of the evidence including effect sizes (section=evidence), caveats, boundary conditions and failed replications (section=caveat), where and how interfaces embody it (section=implementation), what outcomes are measured (section=measurement), and misuse, harm or dark-pattern boundaries (section=risk). Fields: section, fact, confidence, ${provenanceField}.`;
    case "dossier":
      return `${shared} Extract evaluative observations for scoring the mechanism ${mechanismId}: strength and breadth of evidence (section=evidence), applicability to product interfaces (section=product_applicability), how measurable its predicted outcomes are (section=measurability), how distinct it is from neighbouring constructs (section=orthogonality), harms, ethics and misuse boundaries (section=safety), counter-evidence, critiques and null findings (section=dissent), and measured-outcome conditions (section=core_condition). Fields: section, fact, confidence, ${provenanceField}.`;
  }
}

function synthesisInstruction(
  mode: ExtractionMode,
  mechanismId: string,
  anchor: EffectAnchor | null = null,
): string {
  const noInvention =
    "Do not add a claim that is not supported by the candidates.";
  // Refs, not quotes: the synthesis pass has no records to quote from (D-104).
  const refsOnly = provenanceInstruction(mode, "synthesize");
  if (mode === "realizations" && anchor) {
    return [
      taskInstruction(mode, mechanismId, "synthesize", anchor),
      "Compose 3-5 distinct patterns from the candidate list: merge duplicates, drop any whose pattern is not implementable as written, and keep every ref that still applies. Two patterns that change the same interface element under the same trigger are one pattern.",
      noInvention,
    ].join("\n\n");
  }
  switch (mode) {
    case "mechanism":
      return [
        `Return JSON {"items":[]} with EXACTLY ONE item composing a full mechanism record draft for ${mechanismId} from the candidate claims. ${noInvention} ${refsOnly}`,
        "Item fields:",
        `summary (2-4 sentences of generation-facing prose stating what the mechanism does to behaviour and what that implies for interfaces); grade (A+..C-, conservative); evidence_basis (what kinds of studies establish it); effect_size_note; caveats (snake_case strings); funnel_stages (subset of ${FUNNEL_STAGES.join("|")}); excluded_stages (same vocabulary); applicability_artifact_types (subset of ${ARTIFACT_TYPES.join("|")}); preconditions [{predicate,reason}] (predicate as a machine-readable condition, e.g. "artifact.has_choice == true"); culture_note; implementations (1-3 of {id_suffix (kebab-case), artifact_types (subset of the same vocabulary), product_requirements (strings), generation_directive (imperative prose for a generator), copy_formulas (strings), metrics (non-empty measurable product metrics)}); hard_rules (1+ of {id (snake_case), rule, severity block|warn}) covering misuse and dark-pattern boundaries reported in the sources; compliance_refs (strings); boundary_test (one question separating legitimate use from manipulation); relations (only mechanism ids explicitly treated together in the records: {type enabled_by|enables|adjacent|hybrid_with, target, note}); reference_examples [{product, what}] only if reported in sources; confidence; provenance_refs (the union of refs backing summary, evidence and caveats).`,
      ].join("\n");
    case "dossier":
      return [
        `Return JSON {"items":[]} with EXACTLY ONE item composing a full dossier draft for ${mechanismId} from the candidate observations. ${noInvention} ${refsOnly}`,
        `Item fields: scores — an object with keys ${DOSSIER_AXES.join(", ")}, each {score (integer 0-3), rationale (markdown justification arguing from the cited evidence), provenance_refs}; core_condition (the measured condition under which the mechanism could be promoted, grounded in what the sources measure); dissent (markdown documenting counter-evidence, critiques, failed replications and boundary findings — a dossier that can only confirm is broken); confidence; provenance_refs (the union of refs backing dissent and core_condition).`,
        "HARD RULE: if the candidates do not ground a rationale for an axis, emit that axis as {score:null, rationale:null, provenance_refs:[]} — never guess a score. Score conservatively from the cited evidence only.",
      ].join("\n");
    default:
      return [
        taskInstruction(mode, mechanismId, "synthesize"),
        "Synthesize the candidate list: merge true duplicates, carry forward every ref that still applies, remove contradictions that the cited text does not establish, and grade conservatively. Do not add a claim.",
      ].join("\n\n");
  }
}

function cheapPrompt(
  mode: ExtractionMode,
  mechanismId: string,
  records: ExtractionRecord[],
  anchor: EffectAnchor | null = null,
): string {
  return `${taskInstruction(mode, mechanismId, "extract", anchor)}\n\nRECORDS:\n${JSON.stringify(
    records.map(compactRecord),
  )}`;
}

/**
 * An extraction candidate whose provenance has been anchored to offsets, paired
 * with the opaque refs that stand in for it downstream (D-104).
 */
export interface AnchoredCandidate {
  item: DraftItem;
  refs: string[];
}

/**
 * Strip every provenance-shaped field out of a candidate before the synthesis
 * pass sees it, leaving opaque refs (D-104).
 *
 * The synthesis pass gets the CLAIM and a handle. Withholding record ids and
 * quote text is what makes provenance model-immutable: there is no quote to
 * paraphrase and no record id to reattach, so `provenance_refs` is the only
 * provenance the model can possibly return.
 */
export function forSynthesis(candidate: AnchoredCandidate): DraftItem {
  const { citations: _citations, scores, ...claim } = candidate.item;
  const projected: DraftItem = { ...claim, provenance_refs: candidate.refs };
  if (scores) {
    projected.scores = Object.fromEntries(
      Object.entries(scores).map(([axis, value]) => {
        const { citations: _axisCitations, ...rest } = value;
        return [axis, rest];
      }),
    );
  }
  return projected;
}

function strongPrompt(
  mode: ExtractionMode,
  mechanismId: string,
  candidates: AnchoredCandidate[],
  anchor: EffectAnchor | null = null,
): string {
  return [
    synthesisInstruction(mode, mechanismId, anchor),
    `CANDIDATES:\n${JSON.stringify(candidates.map(forSynthesis))}`,
  ].join("\n\n");
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Rough token estimate from a prompt string. English JSON prose runs ~4 UTF-8
 * bytes per token, so counting raw bytes as tokens (the pre-D-090 estimator)
 * overshot ~4.5x and, together with an inflated strong-input reserve, ate the
 * per-run cap before any records were counted — starving every slice to a
 * handful of records. Both the planner (estimateSelected) and the runtime
 * guard (callOpenRouter) use this so the plan and the live cap agree.
 */
export function estimateTokens(value: string): number {
  return Math.ceil(bytes(value) / 4);
}

export function configuredTier(
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

interface PlannedMechanism {
  mechanismId: string;
  corpus: ExtractionCorpus;
  selected: ExtractionRecord[];
  skippedIrrelevantIds: string[];
  relevantRemaining: number;
}

interface ExtractionPlan {
  mechanisms: PlannedMechanism[];
  calls: { cheap: number; strong: number; total: number };
  tokens: { input_upper_bound: number; output_reserved: number; total_upper_bound: number };
  records: ExtractionQuote["records"];
  capped: boolean;
}

function loadReaderCoverage(): ReaderCoverageFile | null {
  return existsSync(READER_COVERAGE_FILE)
    ? readJson<ReaderCoverageFile>(READER_COVERAGE_FILE)
    : null;
}

function estimateSelected(
  mode: ExtractionMode,
  selectedByMechanism: ReadonlyMap<string, readonly ExtractionRecord[]>,
  config: ExtractionOpsConfig,
  // The anchored prompt is longer than the plain one, so the estimate has to be
  // built from the SAME prompt the run will send or the quote understates it.
  anchor: EffectAnchor | null = null,
): Pick<ExtractionPlan, "calls" | "tokens"> {
  const cheap = configuredTier(config, "cheap");
  const strong = configuredTier(config, "strong");
  let cheapCalls = 0;
  let strongCalls = 0;
  let inputUpper = 0;
  let outputReserved = 0;
  for (const [mechanismId, selected] of Array.from(selectedByMechanism.entries())) {
    if (selected.length === 0) continue;
    const mechanismBatches = batches(
      [...selected],
      config.limits.records_per_batch,
    );
    for (const batch of mechanismBatches) {
      cheapCalls += 1;
      inputUpper += estimateTokens(cheapPrompt(mode, mechanismId, batch, anchor));
      outputReserved += Math.min(CHEAP_OUTPUT_RESERVE, cheap.max_tokens_per_call);
    }
    strongCalls += 1;
    // The strong call's input is the synthesized cheap output; reserve at most
    // the sum of the cheap output reserves (token units), capped by the strong
    // tier's own per-call ceiling.
    inputUpper += Math.min(
      mechanismBatches.length * Math.min(CHEAP_OUTPUT_RESERVE, cheap.max_tokens_per_call),
      strong.max_tokens_per_call,
    );
    outputReserved += Math.min(STRONG_OUTPUT_RESERVE, strong.max_tokens_per_call);
  }
  return {
    calls: {
      cheap: cheapCalls,
      strong: strongCalls,
      total: cheapCalls + strongCalls,
    },
    tokens: {
      input_upper_bound: inputUpper,
      output_reserved: outputReserved,
      total_upper_bound: inputUpper + outputReserved,
    },
  };
}

export function buildExtractionPlan(
  mode: ExtractionMode,
  scope: ExtractionScope,
  config: ExtractionOpsConfig,
  coverage: ReaderCoverageFile | null = loadReaderCoverage(),
): ExtractionPlan {
  const anchor = effectAnchor(scope);
  const effectId = scope.effectBasis?.effect.id;
  const candidates: {
    mechanismId: string;
    corpus: ExtractionCorpus;
    relevant: ExtractionRecord[];
    skippedIrrelevantIds: string[];
  }[] = [];
  let eligibleTotal = 0;
  let alreadyCompleted = 0;
  for (const mechanismId of scope.mechanismIds) {
    if (!modeEligible(mode, mechanismId)) continue;
    const corpus = corpusFor(mode, mechanismId, scope);
    const eligible = eligibleRecords(corpus);
    eligibleTotal += eligible.length;
    const kind = readsRealizationCorpus(mode, scope) ? "realization" : "evidence";
    const priorMode = coverage?.mechanisms[mechanismId]?.[kind]?.by_mode[mode];
    // D-140: an effect-anchored run's terminal set is scoped to THIS effect
    // alone. A record terminal for one effect on this mechanism must not
    // block a second effect's read of the same literature — that ceiling
    // was the whole limitation D-112 stated rather than fixed. Every other
    // mode (and a non-effect-anchored realizations run) keeps the pre-D-140
    // mode-level union.
    const terminalSource = effectId ? priorMode?.by_effect?.[effectId] : priorMode;
    const terminal = new Set([
      ...(terminalSource?.processed_record_ids ?? []),
      ...(terminalSource?.skipped_irrelevant_record_ids ?? []),
    ]);
    const pending = eligible.filter((record) => !terminal.has(record.record_id));
    alreadyCompleted += eligible.length - pending.length;
    const ranked = rankRelevantRecords(corpus, pending, anchor);
    candidates.push({
      mechanismId,
      corpus,
      relevant: ranked.records,
      skippedIrrelevantIds: ranked.skippedIrrelevantIds,
    });
  }

  const selectedByMechanism = new Map<string, ExtractionRecord[]>();
  let capReached = false;
  for (const candidate of candidates) {
    const selected: ExtractionRecord[] = [];
    selectedByMechanism.set(candidate.mechanismId, selected);
    for (const record of candidate.relevant) {
      selected.push(record);
      const estimate = estimateSelected(mode, selectedByMechanism, config, anchor);
      if (estimate.tokens.total_upper_bound > config.limits.per_run_tokens) {
        selected.pop();
        capReached = true;
        break;
      }
    }
    if (capReached) break;
  }

  const estimate = estimateSelected(mode, selectedByMechanism, config, anchor);
  const mechanisms = candidates.map((candidate) => {
    const selected = selectedByMechanism.get(candidate.mechanismId) ?? [];
    return {
      mechanismId: candidate.mechanismId,
      corpus: candidate.corpus,
      selected,
      skippedIrrelevantIds: candidate.skippedIrrelevantIds,
      relevantRemaining: candidate.relevant.length - selected.length,
    };
  });
  const skippedIrrelevant = mechanisms.reduce(
    (sum, mechanism) => sum + mechanism.skippedIrrelevantIds.length,
    0,
  );
  const selected = mechanisms.reduce(
    (sum, mechanism) => sum + mechanism.selected.length,
    0,
  );
  const remaining = mechanisms.reduce(
    (sum, mechanism) => sum + mechanism.relevantRemaining,
    0,
  );
  return {
    mechanisms,
    ...estimate,
    records: {
      eligible_total: eligibleTotal,
      already_completed: alreadyCompleted,
      skipped_irrelevant: skippedIrrelevant,
      selected,
      remaining,
      dropped_truncation: remaining,
    },
    capped: remaining > 0,
  };
}

export function buildQuote(
  mode: ExtractionMode,
  scope: ExtractionScope,
  config: ExtractionOpsConfig,
  now: Date = new Date(),
  coverage: ReaderCoverageFile | null = loadReaderCoverage(),
): ExtractionQuote {
  const cheap = configuredTier(config, "cheap");
  const strong = configuredTier(config, "strong");
  const reasons: string[] = [];
  const priceState = extractionPriceState(config, now);
  if (priceState === "unconfigured") reasons.push("model pricing verification date is missing");
  const plan = buildExtractionPlan(mode, scope, config, coverage);
  const { cheap: cheapCalls, strong: strongCalls } = plan.calls;
  const inputUpper = plan.tokens.input_upper_bound;
  const outputReserved = plan.tokens.output_reserved;
  const totalUpper = plan.tokens.total_upper_bound;
  const estimatedUsd =
    inputUpper * Math.max(cheap.input_usd_per_token, strong.input_usd_per_token) +
    cheapCalls *
      Math.min(CHEAP_OUTPUT_RESERVE, cheap.max_tokens_per_call) *
      cheap.output_usd_per_token +
    strongCalls *
      Math.min(STRONG_OUTPUT_RESERVE, strong.max_tokens_per_call) *
      strong.output_usd_per_token;
  const budget = computeBudgetSnapshot(now);
  if (plan.records.remaining > 0 && plan.records.selected === 0) {
    reasons.push(
      `the highest-ranked pending record cannot fit inside the per-run cap ${config.limits.per_run_tokens}`,
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
    records: plan.records,
    capped: plan.capped,
    resumable: plan.capped,
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
  mode: ExtractionMode,
  stage: ExtractionStage,
  prompt: string,
  outputReserve: number,
  derivation: RealizationDerivation = "reported",
): Promise<DraftItem[]> {
  const tier = configuredTier(context.config, tierName);
  const inputUpper = estimateTokens(prompt);
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
      body: JSON.stringify(
        openRouterRequestBody({ tier, mode, stage, prompt, maxTokens, derivation }),
      ),
    });
    if (response.ok) break;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
      throw new Error(
        `OpenRouter ${response.status} model=${tier.model_id} tier=${tierName}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  if (!response?.ok) throw new Error("OpenRouter request failed");
  const body = (await response.json()) as OpenRouterResponse;
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new OpenRouterOutputValidationError(
      "OpenRouter returned no response content",
    );
  }
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
  const parsed = parseDraftResponse(content);
  if (parsed.tolerance !== "strict") {
    console.warn(
      `[extract] tolerated OpenRouter response form model=${tier.model_id} tier=${tierName} strategy=${parsed.tolerance}`,
    );
  }
  return parsed.items;
}

/**
 * The VARIABLE check, as a model judgement (ruleset v2, D-162).
 *
 * It reads only the claim — fact, boundary, source title — and answers whether a
 * product surface could act on the mechanism, returning a named lever or null.
 * It replaces the v1 word list, which could match only cognitive-load vocabulary
 * and refused most of the persuasion registry (SP-08, LA-01, ID-12 all predicted
 * near-zero). SUBJECT, DIRECTION and POPULATION stay deterministic; only this
 * check moved to a model, and the lever it names is frozen into the verdict so
 * the whole thing stays auditable offline (replayTransferability audits v2, it
 * does not re-call the model).
 *
 * Routes to the STRONG tier on purpose. The cheap tier (gpt-4o-mini class) was
 * measured to reintroduce false refusals of a different kind — it reads an
 * abstractly phrased "X is a persuasion principle…" as a definition and refuses
 * it — so the capability, not the approach, is what clears the registry.
 *
 * FAILS OPEN, AND SAYS SO. On a missing model id, a blown token cap, a transport
 * error, or a malformed answer the caller admits the claim WITHOUT a verdict
 * rather than refusing it. A model outage must never silently bury a grounded
 * claim; the safe direction is toward review, not away from it.
 *
 * But it returns a NAMED failure rather than a bare null, because the first
 * version of this returned null and the caller expressed that as an absent
 * `transferability` field — which is also what a pre-D-160 proposal and a
 * non-effect proposal look like. An unjudged item was indistinguishable from a
 * judged one, and nothing counted it. Every exit below therefore carries the
 * reason it took, and the caller stamps it onto the proposal and counts it.
 */
type VariableOutcome =
  | { ok: true; judgement: VariableJudgement }
  | {
      ok: false;
      reason: TransferabilityVerdictUnavailableReason;
      detail?: string;
    };

function variableUnavailable(
  reason: TransferabilityVerdictUnavailableReason,
  detail?: string,
): VariableOutcome {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

export async function judgeVariableViaModel(
  context: RunContext,
  claim: TransferabilityClaim,
): Promise<VariableOutcome> {
  const tier = configuredTier(context.config, "strong");
  if (!tier.model_id) return variableUnavailable("no_model_id");
  const prompt = buildVariablePrompt(claim);
  const maxTokens = Math.min(200, tier.max_tokens_per_call);
  const inputUpper = estimateTokens(prompt);
  const projected =
    context.usage.input + context.usage.output + inputUpper + maxTokens;
  if (projected > context.config.limits.per_run_tokens) {
    return variableUnavailable(
      "per_run_token_cap",
      `projected ${projected} > per_run_tokens ${context.config.limits.per_run_tokens}`,
    );
  }
  if (monthTokenUsage() + projected > context.config.limits.monthly_tokens) {
    return variableUnavailable(
      "monthly_token_cap",
      `projected month total would exceed monthly_tokens ${context.config.limits.monthly_tokens}`,
    );
  }

  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await context.fetcher(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/ventora/motivation-engine",
          "X-Title": "Motivation Engine transferability VARIABLE",
        },
        body: JSON.stringify({
          model: tier.model_id,
          messages: [{ role: "user", content: prompt }],
          ...openRouterSamplingOptions(tier.supports),
          max_tokens: maxTokens,
        }),
      });
      if (response.ok) break;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
        return variableUnavailable(
          "transport_error",
          `OpenRouter ${response.status} model=${tier.model_id} tier=strong after ${attempt + 1} attempt(s)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
    if (!response?.ok) {
      return variableUnavailable("transport_error", "OpenRouter request failed");
    }
    const body = (await response.json()) as OpenRouterResponse;
    const usageInput = body.usage?.prompt_tokens;
    const usageOutput = body.usage?.completion_tokens;
    // Count spend against the monthly cap even on a malformed answer — the tokens
    // were spent (rule 12d). A response that omits usage is left uncounted rather
    // than guessed.
    if (Number.isInteger(usageInput) && Number.isInteger(usageOutput)) {
      context.usage.input += usageInput!;
      context.usage.output += usageOutput!;
      context.usage.calls += 1;
      context.usage.byTier.strong.input += usageInput!;
      context.usage.byTier.strong.output += usageOutput!;
      context.usage.byTier.strong.calls += 1;
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return variableUnavailable("malformed_answer", "response carried no text content");
    }
    const judgement = parseVariableJudgement(content);
    // The raw answer is deliberately NOT carried into `detail`. A malformed
    // model answer is not evidence, and a proposal is not the place to store it.
    if (!judgement) {
      return variableUnavailable("malformed_answer", "answer was not a parseable judgement");
    }
    return { ok: true, judgement };
  } catch (error: unknown) {
    return variableUnavailable(
      "transport_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const normalizeText = normalizeQualityText;

/**
 * Why one candidate failed the grounding gate (D-098).
 *
 * D-093 split Ajv failures out of the single dropped_ungrounded bucket; the
 * bucket was still coarse enough to hide WHICH of the grounding checks a
 * candidate failed, which is why four runs dropping 100% of their candidates
 * told us nothing actionable. These are labels for an existing decision, not
 * new gates: every reason already rejected the candidate before.
 */
export type UngroundedReason = UngroundedDropReason;

/**
 * A refusal, with everything needed to re-check it offline (D-104).
 *
 * The diagnostic fields are additive instrumentation: they describe a decision
 * the gate already made and never influence it. `compared` and `corpus_side`
 * are absent exactly when the refusal happened before any comparison could be
 * made (no citations, a malformed citation, an unknown record id).
 */
export interface GroundingRefusal {
  ok: false;
  reason: UngroundedReason;
  detail: string;
  /** The cited record the refusal concerns; null when none resolved. */
  corpus_record_id: string | null;
  compared?: RejectedCandidateComparison;
  corpus_side?: RejectedCandidateCorpusSide;
}

export type GroundingOutcome =
  | { ok: true; provenance: KnowledgeProvenanceItem[] }
  | GroundingRefusal;

/** Both compared strings, raw and normalized, untruncated (D-104). */
function comparisonFor(quote: string, sourceText: string): RejectedCandidateComparison {
  return {
    quote_raw: quote,
    quote_normalized: normalizeText(quote),
    source_raw: sourceText,
    source_normalized: normalizeText(sourceText),
  };
}

/**
 * The text the gate compares a quote against, for either corpus kind. Both
 * arms come from lib/proposal-quality so this module cannot hold a second
 * definition of the string that spans index and hash (D-110).
 */
function comparableSourceText(record: ExtractionRecord): string {
  return isRealizationRecord(record)
    ? realizationSourceText(record)
    : evidenceSourceText(record);
}

function corpusSideFor(record: ExtractionRecord): RejectedCandidateCorpusSide {
  return {
    doi: isRealizationRecord(record) ? null : record.doi,
    title: record.title,
  };
}

/** Trailing record id in a `groundingErrors` message, e.g. "... for cr_abc". */
function recordIdFromError(error: string): string | null {
  const match = /(?:for|record) (\S+)$/.exec(error.trim());
  return match ? match[1] : null;
}

/**
 * Map one `groundingErrors` / `realizationGroundingErrors` string to its
 * reason. The error strings are the existing contract in lib/proposal-quality;
 * this only classifies them so the funnel can report a cause.
 */
function reasonForGroundingError(error: string): UngroundedReason {
  if (error.startsWith("wrong corpus kind")) return "wrong_corpus_kind";
  if (error.startsWith("missing corpus record")) return "unknown_record_id";
  if (error.startsWith("missing realization corpus record")) return "unknown_record_id";
  if (error.startsWith("DOI does not resolve")) return "doi_unresolved";
  if (error.startsWith("title mismatch")) return "title_mismatch";
  if (error.startsWith("quote does not resolve")) return "quote_not_in_source";
  // Span conditions (D-110) land here too: a stale, out-of-range, or
  // non-re-slicing span is provenance that disagrees with the corpus, which is
  // what provenance_mismatch already means. The nine causes stay nine; the
  // specific condition survives untruncated in the refusal detail.
  return "provenance_mismatch";
}

/**
 * Turn an anchored citation's offsets into a storable `source_span` (D-110).
 *
 * Null when the citation has not been anchored, or when the offsets do not fit
 * the text — the latter must not be silently stored, because a span that cannot
 * be re-sliced is worse than no span: it looks verifiable and is not.
 *
 * The hash is taken over the SAME string the slice came from, obtained from the
 * one shared definition in lib/proposal-quality, so a stored span can always be
 * re-checked against the text it was resolved against rather than against some
 * later reconstruction of it.
 */
function anchoredSpan(
  citation: CitationDraft,
  rawSourceText: string,
): { quote: string; source_span: ProvenanceSourceSpan } | null {
  const { start, end } = citation;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start === undefined ||
    end === undefined ||
    start < 0 ||
    end <= start ||
    end > rawSourceText.length
  ) {
    return null;
  }
  const quote = rawSourceText.slice(start, end);
  if (quote.trim().length === 0) return null;
  return {
    quote,
    source_span: {
      start,
      end,
      source_text_sha256: sha256Hex(rawSourceText),
    },
  };
}

/**
 * The grounding gate, unchanged in what it admits — it now reports WHY it
 * refused (D-098). `groundedProvenance` stays the boolean-shaped view of the
 * same decision for callers that only need the provenance.
 */
export function groundingOutcome(
  item: DraftItem,
  corpus: ExtractionCorpus,
  options: {
    /**
     * Refuse an evidence citation that carries no anchored offsets (D-110).
     * True for the call whose provenance becomes a proposal; false for the
     * cheap pre-gate, which by design runs BEFORE anchoring and would
     * otherwise refuse every candidate for lacking what it has not yet been
     * given. This is amendment 2.2 enforced in code: nothing the pipeline
     * writes can reach a proposal without a verifiable span.
     */
    requireSpans?: boolean;
    /**
     * Check the rhetorical role of every evidence citation, and require the item
     * to carry at least one finding (D-129). Defaults to TRUE: the pipeline must
     * not be able to skip it by forgetting a flag, which is the opposite default
     * from `requireSpans` because that check needs anchoring to have happened
     * first and this one does not.
     *
     * The only caller that turns it off is tools/replay-grounding.ts, replaying
     * a candidate recorded before this field existed. Such a candidate has no
     * roles to check, and reporting `span_role_missing` for it would overwrite
     * the reason it was actually refused for — destroying the record of the
     * defect the replay exists to re-examine.
     */
    requireSpanRole?: boolean;
  } = {},
): GroundingOutcome {
  const checkRoles = options.requireSpanRole !== false;
  if (!Array.isArray(item.citations) || item.citations.length === 0) {
    return {
      ok: false,
      reason: "no_citations",
      detail: "item carried no citations",
      corpus_record_id: null,
    };
  }
  const records = new Map(corpus.records.map((record) => [record.record_id, record]));
  const provenance: KnowledgeProvenanceItem[] = [];
  // Whether any citation reports what its own source OBSERVED (D-129). Tracked
  // across the whole item rather than per citation, because an item may
  // legitimately cite the premise its finding confirms — cl-14-001 does exactly
  // that — but an item with no finding at all rests on nothing observed.
  let sawFinding = false;
  for (const citation of item.citations) {
    if (
      typeof citation?.record_id !== "string" ||
      typeof citation.quote_or_locus !== "string" ||
      !citation.quote_or_locus.trim()
    ) {
      return {
        ok: false,
        reason: "malformed_citation",
        detail: "citation missing a record_id or a non-empty quote_or_locus",
        corpus_record_id:
          typeof citation?.record_id === "string" ? citation.record_id : null,
      };
    }
    const record = records.get(citation.record_id);
    if (!record) {
      return {
        ok: false,
        reason: "unknown_record_id",
        detail: `cited ${citation.record_id}, absent from the corpus slice`,
        corpus_record_id: citation.record_id,
      };
    }
    const locus = normalizeText(citation.quote_or_locus);
    const rawSourceText = comparableSourceText(record);
    const sourceText = normalizeText(rawSourceText);
    if (!sourceText.includes(locus)) {
      return {
        ok: false,
        reason: "quote_not_in_source",
        detail: `quote not a substring of ${record.record_id}: "${citation.quote_or_locus.slice(0, 120)}"`,
        corpus_record_id: record.record_id,
        compared: comparisonFor(citation.quote_or_locus, rawSourceText),
        corpus_side: corpusSideFor(record),
      };
    }
    if (isRealizationRecord(record)) {
      // Realization-corpus provenance deliberately carries no span (D-110), so
      // mode=realizations output is not span-verifiable. Stated, not hidden.
      provenance.push({
        corpus_kind: "realization",
        mechanism_id: corpus.mechanism_id,
        corpus_record_id: record.record_id,
        source_id: record.source_id,
        title: record.title,
        quote_or_locus: citation.quote_or_locus.trim(),
        contributed_by: record.contributed_by,
      });
      continue;
    }
    if (checkRoles) {
      const verdict = checkSpanRole({
        asserted: citation.span_role,
        source: rawSourceText,
        quote: citation.quote_or_locus,
        start: citation.start,
        end: citation.end,
      });
      if (!verdict.ok) {
        return {
          ok: false,
          reason: verdict.reason,
          detail: `${verdict.detail} — record ${record.record_id}`,
          corpus_record_id: record.record_id,
          compared: comparisonFor(citation.quote_or_locus, rawSourceText),
          corpus_side: corpusSideFor(record),
        };
      }
      if (verdict.role === "finding") sawFinding = true;
    }
    const span = anchoredSpan(citation, rawSourceText);
    if (!span && options.requireSpans) {
      return {
        ok: false,
        reason: "malformed_citation",
        detail:
          `citation for ${record.record_id} carries no anchored span, so its quote could ` +
          "not be made re-sliceable (D-110)",
        corpus_record_id: record.record_id,
      };
    }
    provenance.push({
      mechanism_id: corpus.mechanism_id,
      corpus_record_id: record.record_id,
      doi: record.doi,
      title: record.title,
      // The quote is the SLICE, not the trimmed model string, whenever a span
      // exists: re-slicing must reproduce it byte for byte, and a trim would
      // make the stored text disagree with the offsets that produced it.
      quote_or_locus: span ? span.quote : citation.quote_or_locus.trim(),
      ...(span ? { source_span: span.source_span } : {}),
      // Persisted, not merely checked (D-129). A reader asking why an effect is
      // graded as it is needs to know that a citation is the paper's own result
      // rather than its opening premise, and re-deriving that would mean
      // re-reading the source with the same judgement that was already made.
      ...(isSpanRole(citation.span_role) ? { span_role: citation.span_role } : {}),
    });
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
    if (realizationProvenance.length !== result.length) {
      return {
        ok: false,
        reason: "wrong_corpus_kind",
        detail: "evidence provenance produced against a realization corpus",
        corpus_record_id: result[0]?.corpus_record_id ?? null,
      };
    }
    const errors = realizationGroundingErrors(realizationProvenance, corpus);
    if (errors.length > 0) {
      return refusalForGroundingError(errors[0], result, records);
    }
    return { ok: true, provenance: result };
  }
  // An evidence-grounded item must rest on something a source OBSERVED (D-129).
  // Applied to evidence corpora only: a realization-corpus record is an owner's
  // observation of an interface, which has no results section to sit in and no
  // background section to be mistaken for — the observation IS the finding.
  if (checkRoles && !sawFinding) {
    return {
      ok: false,
      reason: "span_role_not_finding",
      detail:
        "no citation carried span_role=finding, so the item rests on background, " +
        "hypothesis, method or limitation spans alone — none of which report what " +
        "a source observed (D-129)",
      corpus_record_id: result[0]?.corpus_record_id ?? null,
    };
  }
  const errors = groundingErrors(result, corpus);
  if (errors.length > 0) {
    return refusalForGroundingError(errors[0], result, records);
  }
  return { ok: true, provenance: result };
}

/**
 * Turn a secondary-check error string into a refusal carrying the same
 * diagnostics as a first-pass refusal (D-104). The error strings are the
 * existing lib/proposal-quality contract; this only classifies and enriches.
 */
function refusalForGroundingError(
  error: string,
  provenance: readonly KnowledgeProvenanceItem[],
  records: ReadonlyMap<string, ExtractionRecord>,
): GroundingRefusal {
  const recordId = recordIdFromError(error);
  const record = recordId ? records.get(recordId) : undefined;
  const source = provenance.find((entry) => entry.corpus_record_id === recordId);
  return {
    ok: false,
    reason: reasonForGroundingError(error),
    detail: error,
    corpus_record_id: recordId ?? provenance[0]?.corpus_record_id ?? null,
    ...(record && source
      ? {
          compared: comparisonFor(source.quote_or_locus, comparableSourceText(record)),
          corpus_side: corpusSideFor(record),
        }
      : {}),
  };
}

export function groundedProvenance(
  item: DraftItem,
  corpus: ExtractionCorpus,
): KnowledgeProvenanceItem[] | null {
  const outcome = groundingOutcome(item, corpus);
  return outcome.ok ? outcome.provenance : null;
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
  /**
   * The effect an effect-anchored realizations run transfers from (D-112).
   * Present for that run only, and the reason a realization payload can carry
   * derivation="inferred": the link, the domain transfer, and the inference
   * provenance item are all built from here, by code, never by a model.
   */
  effectBasis?: ResolvedEffectBasis;
}

/**
 * The transfer step, written as provenance by CODE (D-112).
 *
 * The model is never asked for this item. It quotes the effect's own `fact`
 * verbatim and points at an evidence record the effect itself cites, so the
 * trail from pattern to a paper the owner can open stays walkable — and it
 * declares the absence of a span rather than leaving an empty field behind.
 * Returns null when the effect cites no evidence record with a DOI-shaped
 * corpus id, because then there is nothing to point at and the pattern would be
 * resting on an unreachable claim.
 */
function inferenceProvenance(
  basis: ResolvedEffectBasis,
): InferenceProvenanceItem | null {
  const { effect } = basis;
  const cited = effect.provenance.find(
    (item): item is EvidenceProvenanceItem =>
      !("corpus_kind" in item && item.corpus_kind !== "evidence") &&
      item.corpus_record_id.startsWith("cr_"),
  );
  if (!cited) return null;
  return {
    corpus_kind: "inference",
    mechanism_id: effect.mechanism_id,
    corpus_record_id: cited.corpus_record_id,
    effect_id: effect.id,
    title: cited.title,
    quote_or_locus: effect.fact.trim(),
    span_absent_reason: INFERENCE_SPAN_ABSENT_REASON,
  };
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

/**
 * Coerce the model's `parameters` into declared thresholds (D-115).
 *
 * `evidence_basis` is not read from the model. It is the one literal the schema
 * allows, and letting a model write it would let a model claim a default was
 * measured — the exact assertion the field exists to deny.
 */
function patternParameters(value: unknown): RealizationParameter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { name, value: amount, unit } = entry as Record<string, unknown>;
    if (!nonEmpty(name) || !nonEmpty(unit) || typeof amount !== "number") return [];
    if (!Number.isFinite(amount)) return [];
    return [
      {
        name: snake(name),
        value: amount,
        unit: unit.trim(),
        evidence_basis: PARAMETER_EVIDENCE_BASIS_NONE,
      },
    ];
  });
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
    // The record id comes from the TERM, never from the model's own id field.
    // A realization id becomes a filename and the handle an implementation
    // points at, and the first effect-anchored run returned "cl-14-002-p1" for
    // two different patterns — a label that is neither unique nor readable. The
    // term is both, and it is the same string the proposal id is already hashed
    // from, so one term can only ever occupy one file.
    const id = slug(item.term);
    if (!id) return null;
    const basis = context?.effectBasis;
    const common = {
      id,
      mechanism_id: mechanismId,
      term: item.term.trim(),
      description_as_reported: item.description_as_reported.trim(),
      artifact_context: Array.from(
        new Set(item.artifact_context.map((entry) => entry.trim())),
      ),
    };
    let payload: Realization;
    let itemProvenance = provenance;
    if (basis) {
      // An inferred realization is refused unless every honesty field it needs
      // is present: the pattern it tells a generator to build, the domain the
      // evidence actually came from, and the transfer step as provenance. A
      // half-marked inference reads as evidence, so it is dropped instead.
      const inference = inferenceProvenance(basis);
      const pattern = typeof item.pattern === "string" ? item.pattern.trim() : "";
      const sourceDomain =
        typeof item.source_domain === "string" ? item.source_domain.trim() : "";
      if (!inference || !pattern || !sourceDomain) return null;
      // A threshold stated as prose is a measurement nobody made (D-115). The
      // model is told to write {name} and declare a default; when it writes
      // "three times" anyway, the candidate is dropped rather than repaired,
      // because guessing which number the prose meant is inventing the same
      // precision one layer down.
      const parameters = patternParameters(item.parameters);
      if (patternParameterErrors(pattern, parameters).length > 0) return null;
      itemProvenance = [...provenance, inference];
      payload = {
        ...common,
        effect_refs: [basis.effect.id],
        derivation: "inferred",
        domain_transfer: {
          source_domain: sourceDomain,
          application_domain: APPLICATION_DOMAIN,
        },
        pattern,
        ...(parameters.length > 0 ? { parameters } : {}),
        provenance: itemProvenance,
        confidence: itemConfidence,
      };
    } else {
      payload = {
        ...common,
        derivation: "reported",
        domain_transfer: {
          source_domain: REPORTED_SOURCE_DOMAIN,
          application_domain: APPLICATION_DOMAIN,
        },
        provenance: itemProvenance,
        confidence: itemConfidence,
      };
    }
    return envelope(
      {
        id: proposalId("realization", mechanismId, payload.term),
        type: "realization",
        target: mechanismId,
        payload,
        provenance: itemProvenance,
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
    // held_non_transferable is deliberately absent (D-160). A held record is a
    // valid merge target only if a later candidate merging into it could still
    // be reviewed; merging into a non-transferable hold would silently bury a
    // candidate the rules never judged.
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

function reportValidationFailure(
  validate: ValidateFunction,
  stage: string,
  mechanismId: string,
): void {
  const errors = (validate.errors ?? [])
    .map(
      (error) =>
        `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
  console.warn(
    `[extract] proposal failed schema validation at ${stage} for ${mechanismId}: ` +
      (errors || "unknown validation error"),
  );
}

/**
 * Log every concrete ungrounded drop (D-104). This was capped at five per
 * mechanism, which was the wrong trade: the cap hid exactly the runs that
 * needed reading — the ones dropping everything — and the surviving lines were
 * console output, which is not committed. The cap is gone and the full record
 * is persisted by the rejection log, so the console line can stay a summary.
 */
function reportUngroundedDrop(
  mechanismId: string,
  pass: ExtractionPass,
  reason: UngroundedReason,
  detail: string,
): void {
  console.warn(
    `[extract] ${mechanismId} dropped ungrounded (pass=${pass} reason=${reason}): ${detail}`,
  );
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

export function buildExtractionManifestRun(args: {
  mode: ExtractionMode;
  scope: ExtractionScope;
  startedAt: Date;
  config: ExtractionOpsConfig;
  usage: Usage;
  stats: ExtractionStats;
  filesWritten: number;
  capped: boolean;
  incomplete?: boolean;
  durationS: number;
  /**
   * Whether this run's candidate ledger closes (D-132). False outranks capped
   * and incomplete: a run that cannot account for its candidates is not a run
   * that did less than its scope, it is a run whose numbers cannot be read.
   */
  balanced?: boolean;
}): CorpusManifestRun {
  const unbalanced = args.balanced === false;
  return {
    timestamp: args.startedAt.toISOString(),
    status: unbalanced
      ? "broken"
      : args.capped || args.incomplete
        ? "partial"
        : "success",
    params: {
      mode: args.mode,
      [args.scope.kind]: args.scope.id,
      ...extractionSummaryParams(args.stats),
    },
    records_fetched:
      args.stats.records_processed + args.stats.records_skipped_irrelevant,
    files_written: args.filesWritten,
    duration_s: args.durationS,
    // Recorded, not inferred (D-108). Attribution used to rest on substring
    // matching a workflow run NAME, a display string that can be edited or
    // collide; writing the id the run was dispatched with settles it.
    dispatch_id: process.env.OPS_DISPATCH_ID ?? null,
    github_run_id: process.env.GITHUB_RUN_ID
      ? Number(process.env.GITHUB_RUN_ID)
      : null,
    ...(args.stats.dropped_ungrounded > 0 ||
      args.stats.failed_validation > 0 ||
      args.capped ||
      unbalanced
      ? {
          warnings: {
            ...(args.stats.dropped_ungrounded > 0
              ? { ungrounded_dropped: true }
              : {}),
            ...(args.stats.failed_validation > 0
              ? { validation_failed: true }
              : {}),
            ...(args.capped ? { capped: true } : {}),
            ...(unbalanced ? { ledger_unbalanced: true } : {}),
          },
        }
      : {}),
    cost: buildExtractionManifestCost(
      args.config,
      args.usage,
      args.durationS,
    ),
  };
}

/**
 * Put `run` at the head of the history, replacing any earlier entry for the
 * SAME run (D-099). Accounting is persisted repeatedly while a run is in
 * flight, and each write must supersede the previous snapshot of that run
 * rather than adding a duplicate that would double-count its spend.
 *
 * Append-only otherwise (D-166): this used to slice to the newest 20 entries,
 * which silently evicted older ones from the monthly rollup's view — the
 * safety cap in D-165's own probe runs computed against incomplete data
 * without saying so beyond a per-run stdout line nobody was reading. history
 * now only ever grows or replaces-by-timestamp; nothing here drops a measured
 * cost. Kept in lockstep with tools/candidate-ledger.ts's mergeLedgerRuns,
 * whose entries validate.ts requires one-for-one for every non-probe run in
 * this history (D-132) — the two must both be append-only or neither can be.
 */
export function mergeExtractionRunHistory(
  previous: readonly CorpusManifestRun[],
  run: CorpusManifestRun,
): CorpusManifestRun[] {
  return [run, ...previous.filter((entry) => entry.timestamp !== run.timestamp)];
}

/**
 * Write the extraction manifest for THIS run.
 *
 * Idempotent per run (D-099): a run is identified by its startedAt timestamp,
 * and re-writing replaces that run's history entry instead of appending a
 * second one. This is what makes it safe to call after every batch so that a
 * run which dies mid-way still leaves its spend recorded — the monthly cap is
 * derived from committed manifests, so spend that is never written is spend the
 * cap can never see.
 */
function writeManifest(
  mode: ExtractionMode,
  scope: ExtractionScope,
  startedAt: Date,
  config: ExtractionOpsConfig,
  usage: Usage,
  stats: ExtractionStats,
  filesWritten: number,
  capped: boolean,
  incomplete: boolean,
  status?: CorpusRunStatus,
  balanced = true,
): void {
  mkdirSync(EXTRACTION_DIR, { recursive: true });
  const duration = Math.round(((Date.now() - startedAt.getTime()) / 1000) * 100) / 100;
  const built = buildExtractionManifestRun({
    mode,
    scope,
    startedAt,
    config,
    usage,
    stats,
    filesWritten,
    capped,
    incomplete,
    durationS: duration,
    balanced,
  });
  // An explicit status still cannot overwrite "broken": a failed run whose
  // ledger also does not balance is broken, because "failed" would invite the
  // reading that its counters are merely incomplete rather than unsound.
  const run: CorpusManifestRun =
    status && built.status !== "broken" ? { ...built, status } : built;
  const previous = existsSync(MANIFEST_FILE)
    ? readJson<CorpusManifest>(MANIFEST_FILE)
    : null;
  const history = mergeExtractionRunHistory(previous?.run_history ?? [], run);
  // Coverage is written at the end of a run, so an in-flight or crashed write
  // may find it absent or stale. Report what exists rather than throwing —
  // recording the spend matters more than the record count.
  const coverage = existsSync(READER_COVERAGE_FILE)
    ? readJson<ReaderCoverageFile>(READER_COVERAGE_FILE)
    : null;
  const coveredRecords = Object.values(coverage?.mechanisms ?? {}).reduce(
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
      data_files: coverage
        ? [
            {
              path: "coverage.json",
              records: coveredRecords,
              bytes: statSync(READER_COVERAGE_FILE).size,
            },
          ]
        : [],
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
  const coverageAtStart = loadReaderCoverage();
  const plan = buildExtractionPlan(
    args.mode,
    args.scope,
    args.config,
    coverageAtStart,
  );
  const quote = buildQuote(
    args.mode,
    args.scope,
    args.config,
    startedAt,
    coverageAtStart,
  );
  if (!quote.allowed) throw new Error(`Extraction blocked: ${quote.reasons.join("; ")}`);
  if (quote.calls.total > 0 && !process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required");
  }
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
    candidates_cheap: 0,
    candidates_strong: 0,
    records_processed: 0,
    // Accumulated per slice below; later slices skip nothing new because the
    // first slice's pre-filter already marks every irrelevant record terminal.
    records_skipped_irrelevant: 0,
    dropped_ungrounded: 0,
    dropped_ungrounded_cheap: 0,
    dropped_ungrounded_strong: 0,
    dropped_ungrounded_reasons: {},
    dropped_ungrounded_reasons_cheap: {},
    dropped_ungrounded_reasons_strong: {},
    failed_validation: 0,
    proposed: 0,
    merged: 0,
    merged_into_pending: 0,
    proposed_enrich: 0,
    held_low_confidence: 0,
    held_non_transferable: 0,
    verdict_unavailable: 0,
    verdict_unavailable_by_reason: Object.fromEntries(
      TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS.map((reason) => [reason, 0]),
    ) as Record<TransferabilityVerdictUnavailableReason, number>,
    dropped_volume_cap: 0,
    dropped_volume_cap_high_confidence: 0,
    dropped_draft_cap: 0,
    into_synthesis: 0,
    cheap_synthesis_failed: 0,
    consolidated_by_synthesis: 0,
    expanded_by_synthesis: 0,
    // Funnel is fixed at run start (D-090): total eligible and the relevant
    // subset that cleared the pre-filter. records_remaining is updated after
    // the last slice.
    records_eligible: plan.records.eligible_total,
    records_relevant: plan.records.selected + plan.records.remaining,
    records_remaining: plan.records.remaining,
    // Accumulated per slice below (D-103); the first slice's figures are the
    // starting point, not the final ones, because a run may read several.
    records_selected: 0,
    records_dropped_truncation: plan.records.dropped_truncation,
  };
  const proposals: Proposal[] = [];
  const existing = existingMatches();
  const pendingWrites = new Map<string, Proposal>();
  const processedByMechanism = new Map<string, {
    processed_record_ids: string[];
    skipped_irrelevant_record_ids: string[];
  }>();
  const validate = proposalValidator();
  // Prefixed so "this was produced by the extraction pipeline" is a structural
  // fact the validator can read, not a guess from a free-form string (D-110).
  const runId = process.env.GITHUB_RUN_ID
    ? `${EXTRACTION_RUN_ID_PREFIX}github-actions-${process.env.GITHUB_RUN_ID}`
    : `${EXTRACTION_RUN_ID_PREFIX}local-${startedAt.toISOString()}`;

  // Every refused candidate is persisted, not sampled (D-104), keyed by the
  // same run-start timestamp the manifest uses so the two line up.
  const rejections: RejectionLog = createRejectionLog({
    runId: startedAt.toISOString(),
    mode: args.mode,
    dispatchId: process.env.OPS_DISPATCH_ID ?? null,
    githubRunId: process.env.GITHUB_RUN_ID
      ? Number(process.env.GITHUB_RUN_ID)
      : null,
  });

  // Every candidate's fate, whether or not anything went wrong with it (D-132).
  const candidateLedger = new CandidateLedger();

  /**
   * Record one refusal against both the counters and the committed log.
   * `cheapOrigin` is present for strong-pass drops: the strong pass never sees
   * the source records, so its refusal is only interpretable next to the
   * candidate it was synthesized from.
   */
  const dropUngrounded = (
    mechanismId: string,
    pass: ExtractionPass,
    refusal: GroundingRefusal,
    item: DraftItem,
    candidateId: string,
    cheapOrigin?: unknown,
  ): void => {
    recordUngroundedDrop(stats, pass, refusal.reason);
    candidateLedger.record({
      candidate_id: candidateId,
      mechanism_id: mechanismId,
      pass,
      fate: "dropped_ungrounded",
      reason: refusal.reason,
    });
    reportUngroundedDrop(mechanismId, pass, refusal.reason, refusal.detail);
    rejections.add(
      rejectionRecord({
        mechanismId,
        mode: args.mode,
        pass,
        reason: refusal.reason,
        detail: refusal.detail,
        corpusRecordId: refusal.corpus_record_id,
        item,
        provenance: item.citations ?? null,
        compared: refusal.compared,
        corpusSide: refusal.corpus_side,
        cheapOrigin,
      }),
    );
  };

  // Live progress heartbeat (D-086): report batches drafted and running spend
  // against the per-run token cap so /ops shows extraction moving in flight.
  // D-090: a run may process several slices in one job, so totalBatches grows
  // as each slice is planned rather than being fixed to the first slice.
  let totalBatches = 0;
  let batchesDone = 0;
  const reportExtractProgress = (
    phase: string,
    status: "running" | "success" | "partial" | "failed",
    finished: boolean,
    summary: RunProgressSummary | null = null,
  ): void => {
    writeRunProgress({
      kind: "extraction",
      target: `${args.scope.kind} ${args.scope.id}`,
      phase,
      finished,
      status,
      progress: { unit: "batches", done: batchesDone, total: totalBatches },
      records: stats.records_processed,
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
      summary,
    });
  };
  reportExtractProgress("reading corpora", "running", false);

  /**
   * Write the candidate ledger for this run and report whether it closes
   * (D-132). Written on the same cadence as the manifest, and on the way out of
   * a throw, for the same reason: a run that dies still has to say what became
   * of the candidates it had already produced.
   */
  const persistLedger = (): boolean => {
    try {
      const ledgerRun = candidateLedger.build({
        runId: startedAt.toISOString(),
        dispatchId: process.env.OPS_DISPATCH_ID ?? null,
        githubRunId: process.env.GITHUB_RUN_ID
          ? Number(process.env.GITHUB_RUN_ID)
          : null,
        mode: args.mode,
        scope: args.scope.id,
      });
      if (!ledgerRun.balanced) {
        for (const violation of checkLedgerBalance(ledgerRun)) {
          console.error(
            `[extract] candidate ledger does not balance — ${violation}`,
          );
        }
      }
      writeCandidateLedger(ledgerRun);
      return ledgerRun.balanced;
    } catch (error) {
      console.warn(
        `[extract] could not persist the candidate ledger: ${(error as Error).message}`,
      );
      return true;
    }
  };

  /**
   * Persist this run's spend to the manifest mid-flight (D-099).
   *
   * The monthly cap is computed from committed corpus manifests, so a run that
   * calls models and then dies used real budget that the cap could never see.
   * Writing after every batch — and once more on the way out of a throw —
   * bounds the invisible spend to at most one batch. The entry is keyed by the
   * run's start timestamp, so these writes replace each other instead of
   * accumulating. Best-effort by construction: a failure to record accounting
   * must never mask the error that is already ending the run.
   */
  const persistAccounting = (status?: CorpusRunStatus): void => {
    try {
      // Rejections ride along with accounting for the same reason (D-104): a run
      // that dies must still leave behind why it dropped what it dropped.
      rejections.flush();
    } catch (error) {
      console.warn(
        `[extract] could not persist rejected candidates: ${(error as Error).message}`,
      );
    }
    // The ledger is written before the manifest because the manifest's status
    // depends on whether it balances (D-132).
    const balanced = persistLedger();
    try {
      writeManifest(
        args.mode,
        args.scope,
        startedAt,
        args.config,
        context.usage,
        stats,
        proposals.length + pendingWrites.size,
        currentPlan.capped,
        true,
        status,
        balanced,
      );
    } catch (error) {
      console.warn(
        `[extract] could not persist interim accounting: ${(error as Error).message}`,
      );
    }
  };

  const draftContextBase = isDraftMode(args.mode)
    ? {
        seeds: seedStubs(),
        knownMechanismIds: new Set([
          ...Array.from(fullMechanisms().keys()),
          ...Array.from(seedStubs().keys()),
        ]) as ReadonlySet<string>,
      }
    : null;
  // The effect this run transfers from, and the prompt anchor built from it
  // (D-112). Both null for every other mode and scope.
  const effectBasis = args.scope.effectBasis;
  const anchor = effectAnchor(args.scope);
  const derivation = realizationDerivation(args.scope);
  const coverageCorpusKind = readsRealizationCorpus(args.mode, args.scope)
    ? "realization"
    : "evidence";
  // D-140: threaded into every mergeReaderCoverage/writeReaderCoverage call
  // below so an effect-anchored run's terminal reads land in
  // by_effect[effectId] as well as the mode-level union.
  const coverageEffectId = effectBasis?.effect.id;
  if (effectBasis) {
    console.log(
      `[extract] anchored on effect ${effectBasis.effect.id} (${effectBasis.origin}: ${effectBasis.path}) — ` +
        `realizations will be proposed with derivation=inferred`,
    );
  }
  let responseBatchesAttempted = 0;
  let responseBatchesSucceeded = 0;
  const failedRecordIdsByMechanism = new Map<string, Set<string>>();

  const recordFailedBatch = (
    mechanismId: string,
    tierName: "cheap" | "strong",
    error: OpenRouterOutputValidationError,
    recordIds: readonly string[],
  ): void => {
    stats.failed_validation += 1;
    const failed =
      failedRecordIdsByMechanism.get(mechanismId) ?? new Set<string>();
    for (const recordId of recordIds) failed.add(recordId);
    failedRecordIdsByMechanism.set(mechanismId, failed);
    const modelId = configuredTier(args.config, tierName).model_id;
    console.warn(
      `[extract] response validation failed model=${modelId} tier=${tierName} mechanism=${mechanismId}: ${error.message}`,
    );
  };

  const processSlice = async (slicePlan: ExtractionPlan): Promise<void> => {
    const batchSize = args.config.limits.records_per_batch;
    for (const mechanism of slicePlan.mechanisms) {
      totalBatches += Math.ceil(mechanism.selected.length / batchSize);
    }
    // What the planner kept for THIS slice, counted before any call runs, so a
    // slice that dies mid-way still reports what it had planned to read (D-103).
    stats.records_selected += slicePlan.records.selected;
    for (const mechanismPlan of slicePlan.mechanisms) {
      const { mechanismId, corpus } = mechanismPlan;
      const records = mechanismPlan.selected;
      // Accumulate across slices (D-090): a mechanism can be visited by several
      // slices, each adding more processed ids. Skipped ids arrive only in the
      // first slice, since the pre-filter marks every irrelevant record terminal
      // at once, so appending them is idempotent for later slices.
      const coverageDelta =
        processedByMechanism.get(mechanismId) ?? {
          processed_record_ids: [] as string[],
          skipped_irrelevant_record_ids: [] as string[],
        };
      coverageDelta.skipped_irrelevant_record_ids.push(
        ...mechanismPlan.skippedIrrelevantIds,
      );
      stats.records_skipped_irrelevant +=
        mechanismPlan.skippedIrrelevantIds.length;
      if (coverageDelta.skipped_irrelevant_record_ids.length > 0) {
        processedByMechanism.set(mechanismId, coverageDelta);
      }
      if (records.length === 0) continue;
      const draftContext: DraftContext | undefined =
        draftContextBase || effectBasis
          ? {
              corpus,
              seed: draftContextBase?.seeds.get(mechanismId),
              // Only the draft modes read this set; an effect-anchored
              // realizations run never reaches draftMechanismPayload.
              knownMechanismIds:
                draftContextBase?.knownMechanismIds ?? new Set<string>(),
              ...(effectBasis ? { effectBasis } : {}),
            }
          : undefined;
      const candidates: DraftItem[] = [];
      const parsedRecordIds: string[] = [];
      let parsedCheapBatches = 0;
      for (const batch of batches(
        records,
        args.config.limits.records_per_batch,
      )) {
        responseBatchesAttempted += 1;
        const result = await settleResponseBatch(() =>
          callOpenRouter(
            context,
            "cheap",
            args.mode,
            "extract",
            cheapPrompt(args.mode, mechanismId, batch, anchor),
            CHEAP_OUTPUT_RESERVE,
            derivation,
          ),
        );
        const recordIds = batch.map((record) => record.record_id);
        stats.records_processed += batch.length;
        batchesDone += 1;
        if (result.ok) {
          responseBatchesSucceeded += 1;
          parsedCheapBatches += 1;
          candidates.push(...result.value);
          parsedRecordIds.push(...recordIds);
        } else {
          recordFailedBatch(mechanismId, "cheap", result.error, recordIds);
        }
        reportExtractProgress(`drafting ${mechanismId}`, "running", false);
        persistAccounting();
      }
      if (parsedCheapBatches === 0) continue;

      // Gate the cheap pass too (D-105). These candidates were extracted by the
      // only pass that reads the source records, so an ungrounded one here is a
      // genuine extraction failure worth counting — it used to be discarded
      // silently on the way into synthesis, with no counter and no record.
      stats.candidates += candidates.length;
      stats.candidates_cheap += candidates.length;
      const ledger = new SpanLedger();
      const sourceTextFor = (recordId: string): string | null => {
        const record = corpus.records.find(
          (candidate) => candidate.record_id === recordId,
        );
        return record ? comparableSourceText(record) : null;
      };
      const groundedCheap: AnchoredCandidate[] = [];
      // Parallel to groundedCheap, so a synthesis call that dies can name the
      // candidates it took down with it instead of leaving them counted as
      // having entered a stage they never came out of (D-132).
      const groundedCheapIds: string[] = [];
      for (const item of candidates) {
        const candidateId = candidateLedger.id(mechanismId, "cheap");
        const grounding = groundingOutcome(item, corpus);
        if (!grounding.ok) {
          dropUngrounded(mechanismId, "cheap", grounding, item, candidateId);
          continue;
        }
        // Anchor provenance to offsets while the record is still in view
        // (D-104). From here on the quote is a slice of the record, so no later
        // pass can author or alter it.
        const anchored = anchorCitations(item.citations, sourceTextFor, ledger);
        if (!anchored.ok) {
          dropUngrounded(mechanismId, "cheap", anchored, item, candidateId);
          continue;
        }
        groundedCheap.push({
          item: { ...item, citations: anchored.citations },
          refs: anchored.refs,
        });
        groundedCheapIds.push(candidateId);
        candidateLedger.record({
          candidate_id: candidateId,
          mechanism_id: mechanismId,
          pass: "cheap",
          fate: "into_synthesis",
        });
      }
      if (groundedCheap.length === 0) {
        // The records were read and paid for. Mark them processed even though
        // nothing survived, so the next run advances instead of re-reading and
        // re-spending on the same slice.
        coverageDelta.processed_record_ids.push(...parsedRecordIds);
        processedByMechanism.set(mechanismId, coverageDelta);
        console.warn(
          `[extract] ${mechanismId}: no cheap-pass candidate grounded; skipping synthesis`,
        );
        continue;
      }

      reportExtractProgress(`composing ${mechanismId}`, "running", false);
      responseBatchesAttempted += 1;
      const synthesisResult = await settleResponseBatch(() =>
        callOpenRouter(
          context,
          "strong",
          args.mode,
          "synthesize",
          strongPrompt(args.mode, mechanismId, groundedCheap, anchor),
          STRONG_OUTPUT_RESERVE,
          derivation,
        ),
      );
      persistAccounting();
      if (!synthesisResult.ok) {
        // These candidates were grounded and paid for, and the call that was
        // meant to compose them died. That is a fate with a name, not a gap
        // between two totals (D-132).
        for (const candidateId of groundedCheapIds) {
          candidateLedger.refate(candidateId, "synthesis_batch_failed");
        }
        stats.cheap_synthesis_failed += groundedCheapIds.length;
        recordFailedBatch(
          mechanismId,
          "strong",
          synthesisResult.error,
          parsedRecordIds,
        );
        continue;
      }
      responseBatchesSucceeded += 1;
      coverageDelta.processed_record_ids.push(...parsedRecordIds);
      processedByMechanism.set(mechanismId, coverageDelta);

      stats.into_synthesis += groundedCheapIds.length;
      // Count what the model composed, not what survives the draft cap below:
      // candidates_strong used to be assigned AFTER the slice, so a draft run
      // that composed four artifacts and kept one reported one candidate and
      // discarded three without a counter (D-132).
      const composed = synthesisResult.value;
      stats.candidates += composed.length;
      stats.candidates_strong += composed.length;
      candidateLedger.recordSynthesisFold(
        groundedCheapIds.length,
        composed.length,
      );
      if (composed.length < groundedCheapIds.length) {
        stats.consolidated_by_synthesis +=
          groundedCheapIds.length - composed.length;
      } else {
        stats.expanded_by_synthesis +=
          composed.length - groundedCheapIds.length;
      }
      const strongIds = composed.map(() =>
        candidateLedger.id(mechanismId, "strong"),
      );
      // A draft mode composes exactly one first-time artifact per mechanism.
      const synthesized = isDraftMode(args.mode) ? composed.slice(0, 1) : composed;
      for (let at = synthesized.length; at < composed.length; at += 1) {
        stats.dropped_draft_cap += 1;
        candidateLedger.record({
          candidate_id: strongIds[at],
          mechanism_id: mechanismId,
          pass: "strong",
          fate: "dropped_draft_cap",
        });
      }
      const admissible: {
        proposal: Proposal;
        outcome: "proposed" | "proposed_enrich";
        candidateId: string;
      }[] = [];
      const held: Proposal[] = [];
      // Every ref the synthesis pass was shown, across all candidates. A ref
      // outside this set is provenance the model invented (D-104).
      const suppliedRefs = new Set(
        groundedCheap.flatMap((candidate) => candidate.refs),
      );
      for (let index = 0; index < synthesized.length; index += 1) {
        const rawItem = synthesized[index];
        const candidateId = strongIds[index];
        const failedValidation = (): void => {
          stats.failed_validation += 1;
          candidateLedger.record({
            candidate_id: candidateId,
            mechanism_id: mechanismId,
            pass: "strong",
            fate: "failed_validation",
          });
        };
        // Rebuild citations from refs before gating: the quote is sliced out of
        // the record at the stored offsets, so the string the gate inspects was
        // written by the corpus, not by a model that never read it.
        const resolved = resolveRefs(
          rawItem.provenance_refs,
          suppliedRefs,
          sourceTextFor,
          ledger,
        );
        if (!resolved.ok) {
          dropUngrounded(
            mechanismId,
            "strong",
            resolved,
            rawItem,
            candidateId,
            groundedCheap,
          );
          continue;
        }
        const item: DraftItem = { ...rawItem, citations: resolved.citations };
        delete item.provenance_refs;
        if (rawItem.scores) {
          // Per-axis provenance resolves the same way. An axis whose refs do
          // not resolve becomes citation-less, which draftDossierAxis already
          // renders as unscored — the pre-D-104 outcome for an ungrounded axis,
          // and not a reason to drop the whole dossier.
          item.scores = Object.fromEntries(
            Object.entries(rawItem.scores).map(([axis, value]) => {
              const axisRefs = resolveRefs(
                value.provenance_refs,
                suppliedRefs,
                sourceTextFor,
                ledger,
              );
              return [
                axis,
                {
                  score: value.score,
                  rationale: value.rationale,
                  citations: axisRefs.ok ? axisRefs.citations : [],
                },
              ];
            }),
          );
        }
        // requireSpans: this outcome's provenance is what reaches the proposal,
        // so from here on a citation without a re-sliceable span is refused
        // rather than written (D-110).
        const grounding = groundingOutcome(item, corpus, { requireSpans: true });
        if (!grounding.ok) {
          dropUngrounded(
            mechanismId,
            "strong",
            grounding,
            rawItem,
            candidateId,
            groundedCheap,
          );
          continue;
        }
        const proposal = toProposal(
          args.mode,
          mechanismId,
          item,
          grounding.provenance,
          runId,
          startedAt.toISOString(),
          draftContext,
        );
        if (!proposal) {
          dropUngrounded(
            mechanismId,
            "strong",
            {
              ok: false,
              reason: "proposal_not_built",
              detail: "provenance grounded but the proposal builder refused the item",
              corpus_record_id: grounding.provenance[0]?.corpus_record_id ?? null,
            },
            rawItem,
            candidateId,
            groundedCheap,
          );
          continue;
        }
        if (!validate(proposal)) {
          failedValidation();
          reportValidationFailure(validate, "candidate", mechanismId);
          continue;
        }

        // D-160 — transferability. The last question asked before a grounded
        // claim can become an actionable proposal: is there anything here a
        // product surface could act on? Judged from the claim alone, so it
        // costs nothing and replays offline from the written file.
        //
        // A refusal HOLDS rather than drops. Nothing below writes reader
        // coverage, deletes a candidate, or marks a source record terminal —
        // the record and the reasoning that set it aside both survive in the
        // queue, one owner action away from being reconsidered. That is the
        // whole difference between this gate and the relevance skip, which
        // removes a record from consideration with no diagnostic at all.
        const claim = transferabilityClaimOfProposal(proposal);
        // D-162 — VARIABLE is a model judgement (see judgeVariableViaModel), fed
        // into the v2 verdict alongside the three deterministic checks. It fails
        // open: model unreachable, cap spent or malformed answer admits the
        // claim WITHOUT a verdict rather than refusing it.
        //
        // The two "no verdict" cases are NOT the same thing and must not produce
        // the same record:
        //   claim === null  — not an effect proposal. The pass does not apply.
        //                     Nothing failed; nothing to mark, nothing to count.
        //   outcome.ok false — the pass applied and could not answer. Marked with
        //                     its reason and counted, because an unjudged item
        //                     that looks judged is how a filter reports success
        //                     while doing nothing.
        const variableOutcome = claim ? await judgeVariableViaModel(context, claim) : null;
        const verdict =
          claim && variableOutcome?.ok
            ? judgeTransferabilityV2(claim, variableOutcome.judgement)
            : null;
        // Recorded on admitted claims too: a gate that files only its refusals
        // cannot be audited for what it let through.
        let judged: Proposal;
        if (verdict) {
          judged = { ...proposal, transferability: verdict } as Proposal;
        } else if (variableOutcome && !variableOutcome.ok) {
          judged = {
            ...proposal,
            verdict_unavailable: {
              ruleset_version: TRANSFERABILITY_RULESET_VERSION_V2,
              reason: variableOutcome.reason,
              ...(variableOutcome.detail === undefined
                ? {}
                : { detail: variableOutcome.detail }),
            },
          } as Proposal;
          stats.verdict_unavailable += 1;
          stats.verdict_unavailable_by_reason[variableOutcome.reason] += 1;
          console.warn(
            `[extract] transferability verdict unavailable (${variableOutcome.reason}) for ${proposal.id} — admitted unjudged`,
          );
        } else {
          judged = proposal;
        }
        if (verdict && !verdict.transferable) {
          const heldProposal = {
            ...judged,
            status: "held_non_transferable",
            hold_reason: "not_transferable",
          } as Proposal;
          if (!validate(heldProposal)) {
            failedValidation();
            reportValidationFailure(validate, "non-transferable hold", mechanismId);
            continue;
          }
          held.push(heldProposal);
          stats.held_non_transferable += 1;
          candidateLedger.record({
            candidate_id: candidateId,
            mechanism_id: mechanismId,
            pass: "strong",
            fate: "held_non_transferable",
            proposal_id: heldProposal.id,
            attribution: "recorded",
          });
          continue;
        }

        const duplicate = existing
          .map((entry) => ({
            entry,
            score: proposalSimilarity(entry.proposal, judged),
          }))
          .filter(({ score }) => score >= args.config.limits.duplicate_similarity)
          .sort(
            (left, right) =>
              right.score - left.score ||
              left.entry.proposal.id.localeCompare(right.entry.proposal.id),
          )[0]?.entry;

        if (duplicate && !duplicate.authoritative) {
          const previous = duplicate.proposal;
          let merged = mergeProposals(duplicate.proposal, judged);
          if (
            previous.status === "held_low_confidence" &&
            merged.confidence >= args.config.limits.confidence_floor &&
            hasNovelEnrichment(previous, merged)
          ) {
            merged = {
              ...merged,
              status: "pending",
              hold_reason: null,
            } as Proposal;
          }
          if (!validate(merged)) {
            failedValidation();
            reportValidationFailure(validate, "pending merge", mechanismId);
            continue;
          }
          duplicate.proposal = merged;
          if (duplicate.path) {
            pendingWrites.set(duplicate.path, merged);
          } else {
            const staged = admissible.find(
              (entry) => entry.proposal === previous,
            );
            if (staged) staged.proposal = merged;
            const heldIndex = held.findIndex((entry) => entry === previous);
            if (heldIndex >= 0) held[heldIndex] = merged;
          }
          stats.merged += 1;
          stats.merged_into_pending += 1;
          candidateLedger.record({
            candidate_id: candidateId,
            mechanism_id: mechanismId,
            pass: "strong",
            fate: "merged_into_pending",
            proposal_id: merged.id,
            attribution: "recorded",
          });
          continue;
        }

        let gatedProposal = judged;
        let outcome: "proposed" | "proposed_enrich" = "proposed";
        let addsValue = true;
        if (duplicate?.authoritative) {
          const merged = mergeProposals(duplicate.proposal, judged);
          addsValue = hasNovelEnrichment(duplicate.proposal, merged);
          gatedProposal = {
            ...judged,
            operation: "enrich",
            payload: merged.payload,
            provenance: merged.provenance,
          } as Proposal;
          outcome = "proposed_enrich";
        }

        if (!validate(gatedProposal)) {
          failedValidation();
          reportValidationFailure(
            validate,
            "authoritative enrichment",
            mechanismId,
          );
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
          existing.push({
            proposal: heldProposal,
            path: null,
            authoritative: false,
          });
          stats.held_low_confidence += 1;
          candidateLedger.record({
            candidate_id: candidateId,
            mechanism_id: mechanismId,
            pass: "strong",
            fate: "held_low_confidence",
            proposal_id: heldProposal.id,
          });
          continue;
        }
        admissible.push({ proposal: gatedProposal, outcome, candidateId });
        existing.push({
          proposal: gatedProposal,
          path: null,
          authoritative: false,
        });
      }

      admissible.sort(
        (left, right) =>
          right.proposal.confidence - left.proposal.confidence ||
          proposalIdentity(left.proposal).localeCompare(
            proposalIdentity(right.proposal),
          ),
      );
      // null disables the ceiling (D-146), so every admissible candidate is
      // written and dropped_volume_cap reports a MEASURED zero rather than the
      // absence of a counter.
      const volumeCap = args.config.limits.max_proposals_per_mechanism;
      const admitted =
        volumeCap === null ? admissible : admissible.slice(0, volumeCap);
      const overflow =
        volumeCap === null ? [] : admissible.slice(volumeCap);
      stats.dropped_volume_cap += overflow.length;
      stats.dropped_volume_cap_high_confidence += overflow.filter(
        ({ proposal: overflowProposal }) =>
          overflowProposal.confidence >= 0.8,
      ).length;
      for (const entry of overflow) {
        candidateLedger.record({
          candidate_id: entry.candidateId,
          mechanism_id: mechanismId,
          pass: "strong",
          fate: "dropped_volume_cap",
        });
      }
      for (const entry of admitted) {
        stats[entry.outcome] += 1;
        // `merged` stays the sum of the two merge-shaped fates, because every
        // committed run entry and the /ops reader already read it (D-132).
        if (entry.outcome === "proposed_enrich") stats.merged += 1;
        candidateLedger.record({
          candidate_id: entry.candidateId,
          mechanism_id: mechanismId,
          pass: "strong",
          fate: entry.outcome,
          proposal_id: entry.proposal.id,
          ...(entry.outcome === "proposed_enrich"
            ? { attribution: "recorded" as const }
            : {}),
        });
      }
      proposals.push(
        ...admitted.map(({ proposal: admittedProposal }) => admittedProposal),
        ...held,
      );
    }
  };

  // Slice-continuation driver (D-090): keep reading the next-ranked slice in
  // the SAME job while relevant records remain and the ACTUAL spend leaves
  // headroom under the per-run cap. A run that reads only pre-filtered noise
  // now advances instead of concluding with a misleading zero yield. Each
  // continuation slice is planned against the remaining headroom (not the full
  // cap) so callOpenRouter's per-call guard can never trip mid-run.
  let currentPlan = plan;
  while (true) {
    try {
      await processSlice(currentPlan);
    } catch (error) {
      // Whatever ended the run, the tokens it already burned are real. Record
      // them before the error propagates (D-099) so the monthly cap sees them.
      persistAccounting("failed");
      throw error;
    }
    stats.records_remaining = currentPlan.records.remaining;
    stats.records_dropped_truncation = currentPlan.records.dropped_truncation;
    if (!currentPlan.capped) break; // corpus exhausted for this scope + mode
    const usedTokens = context.usage.input + context.usage.output;
    const headroom = args.config.limits.per_run_tokens - usedTokens;
    if (headroom <= 0) break; // per-run token cap consumed
    // Failed response-form batches are retryable in a later run, but must be
    // treated as attempted while this run advances through additional slices.
    const planningDeltas = new Map<string, ReaderCoverageDelta>();
    const planningMechanismIds = new Set([
      ...Array.from(processedByMechanism.keys()),
      ...Array.from(failedRecordIdsByMechanism.keys()),
    ]);
    for (const mechanismId of Array.from(planningMechanismIds)) {
      const completed = processedByMechanism.get(mechanismId);
      planningDeltas.set(mechanismId, {
        processed_record_ids: Array.from(
          new Set([
            ...(completed?.processed_record_ids ?? []),
            ...Array.from(
              failedRecordIdsByMechanism.get(mechanismId) ?? new Set<string>(),
            ),
          ]),
        ),
        skipped_irrelevant_record_ids:
          completed?.skipped_irrelevant_record_ids ?? [],
      });
    }
    const coverageNow = mergeReaderCoverage(
      coverageAtStart,
      args.mode,
      planningDeltas,
      startedAt.toISOString(),
      coverageCorpusKind,
      coverageEffectId,
    );
    const sliceConfig: ExtractionOpsConfig = {
      ...args.config,
      limits: { ...args.config.limits, per_run_tokens: headroom },
    };
    const nextPlan = buildExtractionPlan(
      args.mode,
      args.scope,
      sliceConfig,
      coverageNow,
    );
    if (nextPlan.records.selected === 0) break; // next record cannot fit headroom
    reportExtractProgress("advancing to next slice", "running", false);
    currentPlan = nextPlan;
  }

  const failedRecordCount = Array.from(
    failedRecordIdsByMechanism.values(),
  ).reduce((sum, recordIds) => sum + recordIds.size, 0);
  stats.records_remaining = currentPlan.records.remaining + failedRecordCount;
  // The last slice's refusal IS the run's truncation drop: every earlier slice's
  // leftovers were re-planned into this one (D-103).
  stats.records_dropped_truncation = currentPlan.records.dropped_truncation;
  const runIncomplete = stats.records_remaining > 0;
  const summary: RunProgressSummary = {
    proposed: stats.proposed,
    merged: stats.merged,
    dropped_ungrounded: stats.dropped_ungrounded,
    failed_validation: stats.failed_validation,
    held_low_confidence: stats.held_low_confidence,
    held_non_transferable: stats.held_non_transferable,
    verdict_unavailable: stats.verdict_unavailable,
    dropped_volume_cap: stats.dropped_volume_cap,
    dropped_volume_cap_high_confidence:
      stats.dropped_volume_cap_high_confidence,
    candidates: stats.candidates,
    records_eligible: stats.records_eligible,
    records_relevant: stats.records_relevant,
    records_processed: stats.records_processed,
    records_skipped_irrelevant: stats.records_skipped_irrelevant,
    records_remaining: stats.records_remaining,
    records_selected: stats.records_selected,
    records_dropped_truncation: stats.records_dropped_truncation,
    ...(stats.dropped_ungrounded > 0
      ? { dropped_ungrounded_reasons: stats.dropped_ungrounded_reasons }
      : {}),
    // Always present from D-105 on; absence is the signal that a run predates
    // the cheap-pass gate, which /ops renders as "not split".
    candidates_cheap: stats.candidates_cheap,
    candidates_strong: stats.candidates_strong,
    dropped_ungrounded_cheap: stats.dropped_ungrounded_cheap,
    dropped_ungrounded_strong: stats.dropped_ungrounded_strong,
    ...(stats.dropped_ungrounded_cheap > 0
      ? { dropped_ungrounded_reasons_cheap: stats.dropped_ungrounded_reasons_cheap }
      : {}),
    ...(stats.dropped_ungrounded_strong > 0
      ? { dropped_ungrounded_reasons_strong: stats.dropped_ungrounded_reasons_strong }
      : {}),
  };
  if (
    everyResponseBatchFailed(
      responseBatchesAttempted,
      responseBatchesSucceeded,
    )
  ) {
    reportExtractProgress(
      `failed — all ${responseBatchesAttempted} response batches failed validation`,
      "failed",
      true,
      summary,
    );
    persistAccounting("failed");
    throw new Error(
      `Every OpenRouter response batch failed validation (${responseBatchesAttempted}/${responseBatchesAttempted})`,
    );
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
    coverageCorpusKind,
    coverageEffectId,
  );
  const ledgerBalanced = persistLedger();
  writeManifest(
    args.mode,
    args.scope,
    startedAt,
    args.config,
    context.usage,
    stats,
    proposals.length + pendingWrites.size,
    currentPlan.capped,
    runIncomplete,
    undefined,
    ledgerBalanced,
  );
  const ungroundedBreakdown = formatUngroundedReasons(stats.dropped_ungrounded_reasons);
  if (rejections.count() > 0) {
    console.warn(
      `[extract] ${rejections.count()} refused candidates persisted to ${rejections.path()} — ` +
        `re-check offline with: npm run replay-grounding -- replay ${rejections.path()}`,
    );
  }
  // The transferability outcomes were previously absent from this line entirely
  // — they travelled only in the structured summary, so the operator's one-line
  // view of a run could not show that the filter had refused anything, let alone
  // that it had failed to run. Both counts are printed, and the unavailable one
  // names its causes so a cap-exhausted run is not read as a clean one.
  const unavailableBreakdown = TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS.filter(
    (reason) => stats.verdict_unavailable_by_reason[reason] > 0,
  )
    .map((reason) => `${reason} ${stats.verdict_unavailable_by_reason[reason]}`)
    .join(", ");
  reportExtractProgress(
    `${runIncomplete ? "slice completed" : "completed"} — ${stats.proposed + stats.merged} proposals · ${stats.records_eligible} available / ${stats.records_selected} kept by the planner / ${stats.records_dropped_truncation} dropped to fit the ${args.config.limits.per_run_tokens}-token cap · ${stats.records_processed}/${stats.records_relevant} relevant read · ${stats.candidates} candidates (cheap ${stats.candidates_cheap} / strong ${stats.candidates_strong}) · ${stats.dropped_ungrounded} dropped ungrounded (cheap ${stats.dropped_ungrounded_cheap} / strong ${stats.dropped_ungrounded_strong})${ungroundedBreakdown ? ` (${ungroundedBreakdown})` : ""} · ${stats.failed_validation} failed validation · ${stats.held_non_transferable} held non-transferable · ${stats.verdict_unavailable} admitted unjudged${unavailableBreakdown ? ` (${unavailableBreakdown})` : ""} · ${stats.records_remaining} remaining`,
    runIncomplete ? "partial" : "success",
    true,
    summary,
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
  const scope = resolveScope(params, {
    includeSeeds: isDraftMode(params.mode),
    mode: params.mode,
  });
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

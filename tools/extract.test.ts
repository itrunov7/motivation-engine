import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { extractionPriceState, validateExtractionOpsConfig } from "../lib/ops";
import {
  evidenceSourceText,
  groundingErrors,
  mergeProposals,
  normalizeQualityText,
  proposalSimilarity,
  sha256Hex,
  spanErrors,
} from "../lib/proposal-quality";
import type {
  CorpusManifestRun,
  EvidenceCorpusFile,
  EvidenceCorpusRecord,
  ExtractionOpsConfig,
  KnowledgeProvenanceItem,
  Proposal,
  ReaderCoverageFile,
  RealizationCorpusFile,
} from "../lib/types";
import {
  OPENROUTER_SYSTEM_PROMPT,
  OpenRouterOutputValidationError,
  buildExtractionManifestRun,
  buildExtractionPlan,
  buildExtractionManifestCost,
  buildQuote,
  everyResponseBatchFailed,
  extractionSummaryParams,
  forSynthesis,
  formatUngroundedReasons,
  groundedProvenance,
  groundingOutcome,
  openRouterRequestBody,
  openRouterResponseFormat,
  mergeExtractionRunHistory,
  mergeReaderCoverage,
  openRouterStructuredOutputOptions,
  parseDraftResponse,
  proposalIdentity,
  rankRelevantRecords,
  recordRelevanceTier,
  recordUngroundedDrop,
  resolveScope,
  settleResponseBatch,
  toProposal,
  type DraftItem,
  type ExtractionMode,
  type ExtractionStats,
  type UngroundedReason,
  type Usage,
} from "./extract";
import { visibleReplayText } from "./connectors/realization-wayback";
import { productionStage, rejectedParameters } from "./openrouter-preflight";
import { anchorCitations, SpanLedger } from "./provenance-refs";
import { rejectionRecord } from "./rejected-candidates";

const ROOT = join(__dirname, "..");
const configured: ExtractionOpsConfig = {
  version: "1.0.0",
  prices_verified_on: "2026-07-21",
  tiers: {
    cheap: {
      model_id: "owner/cheap",
      response_format: "json_object",
      input_usd_per_token: 0.0000001,
      output_usd_per_token: 0.0000002,
      max_tokens_per_call: 24000,
      supports: { temperature: true, structured_outputs: true },
    },
    strong: {
      model_id: "owner/strong",
      response_format: "json_schema",
      input_usd_per_token: 0.0000003,
      output_usd_per_token: 0.0000004,
      max_tokens_per_call: 32000,
      supports: { temperature: false, structured_outputs: true },
    },
  },
  limits: {
    per_run_tokens: 10_000_000,
    monthly_tokens: 100_000_000,
    records_per_batch: 25,
    confidence_floor: 0.5,
    duplicate_similarity: 0.78,
    max_proposals_per_mechanism: 10,
  },
};

test("OpenRouter requests require a strict items envelope", () => {
  const options = openRouterStructuredOutputOptions(
    "effects",
    "extract",
    "json_schema",
  );
  assert.deepEqual(options.provider, { require_parameters: true });
  assert.equal(
    (options.response_format as { type?: string }).type,
    "json_schema",
  );
  const format = options.response_format as {
    json_schema?: {
      strict?: boolean;
      schema?: {
        additionalProperties?: boolean;
        required?: string[];
        properties?: { items?: { type?: string } };
      };
    };
  };
  assert.equal(format.json_schema?.strict, true);
  assert.equal(format.json_schema?.schema?.additionalProperties, false);
  assert.deepEqual(format.json_schema?.schema?.required, ["items"]);
  assert.equal(
    format.json_schema?.schema?.properties?.items?.type,
    "array",
  );
  assert.match(OPENROUTER_SYSTEM_PROMPT, /\{"items":\[\.\.\.\]\}/);
  assert.match(OPENROUTER_SYSTEM_PROMPT, /bare top-level array/);
  assert.deepEqual(
    openRouterStructuredOutputOptions("effects", "extract", "json_object"),
    { response_format: { type: "json_object" } },
  );
});

test("response parser tolerates form deviations but keeps the envelope strict", () => {
  const item = { fact: 'A value with an escaped quote: "yes".' };
  assert.deepEqual(
    parseDraftResponse(JSON.stringify({ items: [item] })),
    { items: [item], tolerance: "strict" },
  );
  assert.deepEqual(
    parseDraftResponse(JSON.stringify([item])),
    { items: [item], tolerance: "bare_array" },
  );
  assert.deepEqual(
    parseDraftResponse(`\`\`\`json\n${JSON.stringify({ items: [item] })}\n\`\`\``),
    { items: [item], tolerance: "markdown_code_fence" },
  );
  assert.deepEqual(
    parseDraftResponse(
      `Model preface with {not JSON}. Result: ${JSON.stringify({
        items: [{ ...item, nested: { braces: "{still text}" } }],
      })} trailing prose.`,
    ),
    {
      items: [{ ...item, nested: { braces: "{still text}" } }],
      tolerance: "embedded_json",
    },
  );
  assert.throws(
    () => parseDraftResponse('{"items":[],"explanation":"extra"}'),
    OpenRouterOutputValidationError,
  );
  assert.throws(
    () => parseDraftResponse("There is no usable JSON here."),
    OpenRouterOutputValidationError,
  );
});

test("response validation failures settle per batch and only all-failed runs fail", async () => {
  const failed = await settleResponseBatch(async () => {
    throw new OpenRouterOutputValidationError("malformed");
  });
  const succeeded = await settleResponseBatch(async () => [{ fact: "valid" }]);
  assert.equal(failed.ok, false);
  assert.equal(succeeded.ok, true);
  assert.equal(everyResponseBatchFailed(2, 1), false);
  assert.equal(everyResponseBatchFailed(2, 0), true);
  await assert.rejects(
    settleResponseBatch(async () => {
      throw new Error("transport failed");
    }),
    /transport failed/,
  );
});

function corpus(): EvidenceCorpusFile {
  return JSON.parse(
    readFileSync(join(ROOT, "corpora/evidence/CL-14.json"), "utf8"),
  ) as EvidenceCorpusFile;
}

/**
 * A citation carrying the role that lets it through the D-129 gate.
 *
 * Every test that is measuring something OTHER than the role gate uses this, so
 * a span-role refusal cannot masquerade as the failure the test names. Tests of
 * the gate itself pass their own role.
 *
 * `null` OMITS the field. Not `undefined`: an omitted argument and an explicit
 * `undefined` are the same thing to a default parameter, so `undefined` would
 * silently produce the default "finding" and a test asserting span_role_missing
 * would pass a perfectly labelled citation.
 */
function cite(recordId: string, quote: string, spanRole: unknown = "finding") {
  return {
    record_id: recordId,
    quote_or_locus: quote,
    ...(spanRole === null ? {} : { span_role: spanRole }),
  };
}

/** A zeroed stats block; tests override only the counters they assert on. */
function statsFixture(overrides: Partial<ExtractionStats> = {}): ExtractionStats {
  return {
    candidates: 0,
    candidates_cheap: 0,
    candidates_strong: 0,
    records_processed: 0,
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
    held_low_confidence: 0,
    dropped_volume_cap: 0,
    dropped_volume_cap_high_confidence: 0,
    records_eligible: 0,
    records_relevant: 0,
    records_remaining: 0,
    records_selected: 0,
    records_dropped_truncation: 0,
    ...overrides,
  };
}

test("resolves mechanism, pack, and segment scopes deterministically", () => {
  assert.deepEqual(resolveScope({ mechanism: "CL-14" }).mechanismIds, ["CL-14"]);
  const pack = resolveScope({ pack: "entry" });
  assert.equal(pack.kind, "pack");
  assert.deepEqual(pack.mechanismIds, [...pack.mechanismIds].sort());
  assert(pack.mechanismIds.includes("CL-14"));
  const segment = resolveScope({ segment: "subscription" });
  assert.equal(segment.kind, "segment");
  assert(segment.mechanismIds.length > pack.mechanismIds.length);
  assert.throws(
    () => resolveScope({ mechanism: "CL-14", pack: "entry" }),
    /exactly one scope/,
  );
});

test("quotes are deterministic and enforce the per-run token cap", () => {
  const scope = resolveScope({ mechanism: "CL-14" });
  const now = new Date("2026-07-21T10:00:00.000Z");
  const first = buildQuote("effects", scope, configured, now);
  const second = buildQuote("effects", scope, configured, now);
  assert.deepEqual(first, second);
  assert(first.calls.cheap > 0);
  assert.equal(first.calls.strong, 1);
  const blocked = buildQuote(
    "effects",
    scope,
    { ...configured, limits: { ...configured.limits, per_run_tokens: 1 } },
    now,
  );
  assert.equal(blocked.allowed, false);
  assert(blocked.reasons.some((reason) => reason.includes("per-run cap")));
  // A blocked verdict is still a fully-formed, computed quote (the dry-run job
  // uploads it and /ops shows the reason); it is not a broken estimate (D-088).
  assert.equal(blocked.mode, "effects");
  assert.deepEqual(blocked.scope.mechanism_ids, ["CL-14"]);
  assert(Number.isFinite(blocked.tokens.total_upper_bound));
});

test("relevance funnel keeps pins, ranks confirmed evidence, and skips noise", () => {
  const file = corpus();
  const base = file.records.find((record) => record.abstract);
  assert(base?.abstract);
  const fixture: EvidenceCorpusFile = {
    ...file,
    terms: ["scarcity persuasion"],
    records: [
      {
        ...base,
        record_id: "cr_111111111111111111111111",
        title: "Unrelated owner pin",
        abstract: "No matching vocabulary.",
        citations: 1,
        source_api: "pinned",
        pin_reason: "owner canon",
      },
      {
        ...base,
        record_id: "cr_222222222222222222222222",
        title: "Scarcity cues in choice",
        abstract: "Scarcity can operate as persuasion.",
        citations: 10,
        source_api: "openalex",
        pin_reason: undefined,
      },
      {
        ...base,
        record_id: "cr_333333333333333333333333",
        title: "Scarcity in markets",
        abstract: "A bounded field observation.",
        citations: 100,
        source_api: "openalex",
        pin_reason: undefined,
      },
      {
        ...base,
        record_id: "cr_444444444444444444444444",
        title: "Liver disease guidance",
        abstract: "Clinical biomarkers and fibrosis staging.",
        citations: 1000,
        source_api: "openalex",
        pin_reason: undefined,
      },
    ],
  };
  const ranked = rankRelevantRecords(fixture, fixture.records);
  assert.deepEqual(
    ranked.records.map((record) => record.record_id),
    [
      "cr_111111111111111111111111",
      "cr_222222222222222222222222",
      "cr_333333333333333333333333",
    ],
  );
  assert.deepEqual(ranked.skippedIrrelevantIds, [
    "cr_444444444444444444444444",
  ]);
  assert.equal(recordRelevanceTier(fixture, fixture.records[0]), 0);
});

test("SC-06 first effects slice fits the unchanged 50k cap and is resumable", () => {
  const config = {
    ...configured,
    limits: { ...configured.limits, per_run_tokens: 50_000 },
  };
  const quote = buildQuote(
    "effects",
    resolveScope({ mechanism: "SC-06" }),
    config,
    new Date("2026-07-23T12:00:00.000Z"),
    null,
  );
  assert.equal(quote.allowed, true);
  assert.equal(quote.capped, true);
  assert.equal(quote.resumable, true);
  assert(quote.records.selected > 0);
  assert(quote.records.remaining > 0);
  assert(quote.tokens.total_upper_bound <= 50_000);
});

test("the quote config guard fails with an explicit named message (D-088)", () => {
  // The extract quote/run path runs this SAME shared validator before building
  // a quote, so a missing/stale/malformed field fails named instead of driving
  // the estimator to NaN.
  const missingCap = {
    ...configured,
    limits: { ...configured.limits, per_run_tokens: undefined },
  };
  const capErrors = validateExtractionOpsConfig(missingCap);
  assert(capErrors.some((error) => error.includes("limits.per_run_tokens")));

  const badPrice = { ...configured, prices_verified_on: "yesterday" };
  const priceErrors = validateExtractionOpsConfig(badPrice);
  assert(priceErrors.some((error) => error.includes("prices_verified_on")));

  const badFormat = {
    ...configured,
    tiers: {
      ...configured.tiers,
      cheap: { ...configured.tiers.cheap, response_format: "guess" },
    },
  };
  const formatErrors = validateExtractionOpsConfig(badFormat);
  assert(formatErrors.some((error) => error.includes("tiers.cheap.response_format")));

  // The guard composes exactly what main() throws.
  assert.equal(validateExtractionOpsConfig(configured).length, 0);
});

test("manifest cost accounts for each configured model and reconciles totals", () => {
  const cost = buildExtractionManifestCost(
    configured,
    {
      input: 1_500,
      output: 500,
      calls: 3,
      byTier: {
        cheap: { input: 1_000, output: 400, calls: 2 },
        strong: { input: 500, output: 100, calls: 1 },
      },
    },
    12.5,
  );
  assert.deepEqual(
    cost.models?.map((model) => [model.tier, model.model_id, model.api_calls]),
    [
      ["cheap", "owner/cheap", 2],
      ["strong", "owner/strong", 1],
    ],
  );
  assert.equal(cost.tokens_in, 1_500);
  assert.equal(cost.tokens_out, 500);
  assert.equal(
    cost.estimated_usd,
    cost.models?.reduce((sum, model) => sum + model.estimated_usd, 0),
  );
});

test("monthly token exhaustion blocks the estimate before extraction", () => {
  const quote = buildQuote(
    "effects",
    resolveScope({ mechanism: "CL-14" }),
    {
      ...configured,
      limits: { ...configured.limits, monthly_tokens: 0 },
    },
    new Date("2026-07-21T10:00:00.000Z"),
  );
  assert.equal(quote.allowed, false);
  assert(quote.reasons.some((reason) => reason.includes("monthly token cap")));
});

test("pricing freshness is computed from the verification date", () => {
  assert.equal(
    extractionPriceState(configured, new Date("2026-08-01T00:00:00Z")),
    "current",
  );
  assert.equal(
    extractionPriceState(configured, new Date("2026-11-01T00:00:00Z")),
    "stale",
  );
  assert.equal(
    extractionPriceState(
      { ...configured, prices_verified_on: null },
      new Date("2026-08-01T00:00:00Z"),
    ),
    "unconfigured",
  );
});

test("reader coverage unions exact record ids and modes", () => {
  const first = mergeReaderCoverage(
    null,
    "effects",
    new Map([
      [
        "CL-14",
        {
          processed_record_ids: ["cr_111111111111111111111111"],
          skipped_irrelevant_record_ids: [],
        },
      ],
    ]),
    "2026-07-21T10:00:00.000Z",
  );
  const second = mergeReaderCoverage(
    first,
    "dissent",
    new Map([
      [
        "CL-14",
        {
          processed_record_ids: ["cr_222222222222222222222222"],
          skipped_irrelevant_record_ids: [
            "cr_333333333333333333333333",
          ],
        },
      ],
    ]),
    "2026-07-21T11:00:00.000Z",
  );
  assert.deepEqual(second.mechanisms["CL-14"].evidence, {
    processed_record_ids: [
      "cr_111111111111111111111111",
      "cr_222222222222222222222222",
      "cr_333333333333333333333333",
    ],
    processed_at: "2026-07-21T11:00:00.000Z",
    modes: ["dissent", "effects"],
    by_mode: {
      effects: {
        processed_record_ids: ["cr_111111111111111111111111"],
        skipped_irrelevant_record_ids: [],
        processed_at: "2026-07-21T10:00:00.000Z",
      },
      dissent: {
        processed_record_ids: ["cr_222222222222222222222222"],
        skipped_irrelevant_record_ids: [
          "cr_333333333333333333333333",
        ],
        processed_at: "2026-07-21T11:00:00.000Z",
      },
    },
  });
});

test("resume state is isolated by extraction mode", () => {
  const file = JSON.parse(
    readFileSync(join(ROOT, "corpora/evidence/SC-06.json"), "utf8"),
  ) as EvidenceCorpusFile;
  const terminalId = file.records.find((record) => record.abstract)?.record_id;
  assert(terminalId);
  const coverage: ReaderCoverageFile = {
    version: "1.1.0",
    updated_at: "2026-07-23T10:00:00.000Z",
    mechanisms: {
      "SC-06": {
        evidence: {
          processed_record_ids: [terminalId],
          processed_at: "2026-07-23T10:00:00.000Z",
          modes: ["effects"],
          by_mode: {
            effects: {
              processed_record_ids: [terminalId],
              skipped_irrelevant_record_ids: [],
              processed_at: "2026-07-23T10:00:00.000Z",
            },
          },
        },
      },
    },
  };
  const scope = resolveScope({ mechanism: "SC-06" });
  assert.equal(
    buildExtractionPlan("effects", scope, configured, coverage).records
      .already_completed,
    1,
  );
  assert.equal(
    buildExtractionPlan("dissent", scope, configured, coverage).records
      .already_completed,
    0,
  );
});

test("capped extraction manifest is partial and records funnel outcomes", () => {
  const run = buildExtractionManifestRun({
    mode: "effects",
    scope: resolveScope({ mechanism: "SC-06" }),
    startedAt: new Date("2026-07-23T12:00:00.000Z"),
    config: configured,
    usage: {
      input: 100,
      output: 20,
      calls: 2,
      byTier: {
        cheap: { input: 60, output: 10, calls: 1 },
        strong: { input: 40, output: 10, calls: 1 },
      },
    },
    stats: statsFixture({
      candidates: 1,
      candidates_strong: 1,
      records_processed: 3,
      records_skipped_irrelevant: 7,
      failed_validation: 1,
      proposed: 1,
      records_eligible: 10,
      records_relevant: 3,
    }),
    filesWritten: 1,
    capped: true,
    durationS: 2,
  });
  assert.equal(run.status, "partial");
  assert.equal(run.warnings?.capped, true);
  assert.equal(run.warnings?.validation_failed, true);
  assert.equal(run.records_fetched, 10);
  assert.equal(run.params.failed_validation, "1");
  assert.equal(run.params.records_processed, "3");
  assert.equal(run.params.records_skipped_irrelevant, "7");
});

test("retryable response failures are partial without claiming a token cap", () => {
  const run = buildExtractionManifestRun({
    mode: "effects",
    scope: resolveScope({ mechanism: "CG-05" }),
    startedAt: new Date("2026-07-24T12:00:00.000Z"),
    config: configured,
    usage: {
      input: 100,
      output: 10,
      calls: 1,
      byTier: {
        cheap: { input: 100, output: 10, calls: 1 },
        strong: { input: 0, output: 0, calls: 0 },
      },
    },
    stats: statsFixture({
      records_processed: 25,
      failed_validation: 1,
      records_eligible: 25,
      records_relevant: 25,
      records_remaining: 25,
    }),
    filesWritten: 0,
    capped: false,
    incomplete: true,
    durationS: 1,
  });
  assert.equal(run.status, "partial");
  assert.equal(run.warnings?.validation_failed, true);
  assert.equal(run.warnings?.capped, undefined);
});

test("grounding accepts exact loci and rejects invented or unknown citations", () => {
  const file = corpus();
  const record = file.records.find((candidate) => candidate.abstract && candidate.doi);
  assert(record?.abstract);
  const exact = record.abstract.slice(0, 80);
  const grounded = groundedProvenance(
    { citations: [cite(record.record_id, exact)] },
    file,
  );
  assert.equal(grounded?.[0].corpus_record_id, record.record_id);
  assert.equal(
    groundedProvenance(
      { citations: [cite(record.record_id, "This span was invented.")] },
      file,
    ),
    null,
  );
  assert.equal(
    groundedProvenance(
      { citations: [cite("cr_000000000000000000000000", exact)] },
      file,
    ),
    null,
  );
  const groundedSource = grounded![0];
  assert("doi" in groundedSource);
  assert.match(
    groundingErrors(
      [
        {
          ...groundedSource,
          doi: "10.9999/fabricated",
        },
      ],
      file,
    ).join(" "),
    /DOI does not resolve/,
  );
});

test("every grounding refusal names its own reason", () => {
  const file = corpus();
  const record = file.records.find((candidate) => candidate.abstract && candidate.doi);
  assert(record?.abstract);
  const exact = record.abstract.slice(0, 80);

  const accepted = groundingOutcome(
    { citations: [cite(record.record_id, exact)] },
    file,
  );
  assert.equal(accepted.ok, true);

  const cases: [DraftItem, UngroundedReason][] = [
    [{ citations: [] }, "no_citations"],
    [{}, "no_citations"],
    [{ citations: [cite(record.record_id, "   ")] }, "malformed_citation"],
    [
      { citations: [cite("cr_000000000000000000000000", exact)] },
      "unknown_record_id",
    ],
    [
      { citations: [cite(record.record_id, "This span was invented.")] },
      "quote_not_in_source",
    ],
    // D-129. The role is checked per citation; the finding requirement is a
    // property of the item, so an item citing only a method span is refused even
    // though that citation is impeccably grounded.
    [{ citations: [cite(record.record_id, exact, null)] }, "span_role_missing"],
    [
      { citations: [cite(record.record_id, exact, "conclusion")] },
      "span_role_missing",
    ],
    [
      { citations: [cite(record.record_id, exact, "method")] },
      "span_role_not_finding",
    ],
  ];
  for (const [item, expected] of cases) {
    const outcome = groundingOutcome(item, file);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, expected);
    assert(outcome.ok === false && outcome.detail.length > 0);
  }

  // A DOI-less record is refused by the evidence gate, and the refusal is
  // attributed to the DOI check rather than to the generic bucket. Injected
  // rather than searched for, so the case is always exercised.
  const doiless = {
    ...record,
    record_id: "cr_111111111111111111111111",
    doi: null,
  };
  const withDoiless: EvidenceCorpusFile = {
    ...file,
    records: [...file.records, doiless],
  };
  const doiOutcome = groundingOutcome(
    { citations: [cite(doiless.record_id, exact)] },
    withDoiless,
  );
  assert.equal(doiOutcome.ok, false);
  assert.equal(doiOutcome.ok === false && doiOutcome.reason, "doi_unresolved");
  // A doi_unresolved refusal must carry the record's own DOI, since that is the
  // value the check actually compared (D-104).
  assert.equal(doiOutcome.ok === false && doiOutcome.corpus_record_id, doiless.record_id);
  assert.equal(doiOutcome.ok === false && doiOutcome.corpus_side?.doi, null);
});

test("an anchored citation stores a span that re-slices to its own quote", () => {
  const file = corpus();
  const record = file.records.find(
    (candidate) => candidate.abstract && candidate.doi,
  );
  assert(record?.abstract);
  const sourceText = evidenceSourceText(record);
  const ledger = new SpanLedger();
  // Quote it the way a model would — with mangled punctuation the gate
  // tolerates — so the stored span is proven to be the SOURCE's text and not
  // the model's string.
  const modelQuote = record.abstract.slice(10, 90).replace(/-/g, "\u2010");
  const anchored = anchorCitations(
    [cite(record.record_id, modelQuote)],
    () => sourceText,
    ledger,
  );
  assert.equal(anchored.ok, true);
  assert(anchored.ok);

  const outcome = groundingOutcome({ citations: anchored.citations }, file, {
    requireSpans: true,
  });
  assert.equal(outcome.ok, true);
  assert(outcome.ok);
  const [item] = outcome.provenance;
  assert(item && !("corpus_kind" in item && item.corpus_kind !== "evidence"));
  const span = item.source_span;
  assert(span, "an extraction-authored evidence item must carry a span");
  // The role survives anchoring and is PERSISTED on the provenance item (D-129),
  // so a reader of the record can see the citation is the paper's own result.
  assert.equal(anchored.citations[0].span_role, "finding");
  assert.equal(item.span_role, "finding");

  // Criterion (d): verified by RE-SLICING, not by trusting the emitted quote.
  assert.equal(sourceText.slice(span.start, span.end), item.quote_or_locus);
  assert.equal(span.source_text_sha256, sha256Hex(sourceText));
  assert.equal(spanErrors(item, sourceText).length, 0);
  assert.notEqual(item.quote_or_locus, modelQuote);
});

test("a stored span reports staleness and drift as distinct named conditions", () => {
  const file = corpus();
  const record = file.records.find(
    (candidate) => candidate.abstract && candidate.abstract.length > 300,
  );
  assert(record?.abstract);
  const sourceText = evidenceSourceText(record);
  const base = {
    mechanism_id: file.mechanism_id,
    corpus_record_id: record.record_id,
    doi: record.doi,
    title: record.title,
  };

  const fresh = {
    ...base,
    quote_or_locus: sourceText.slice(40, 120),
    source_span: {
      start: 40,
      end: 120,
      source_text_sha256: sha256Hex(sourceText),
    },
  };
  assert.deepEqual(spanErrors(fresh, sourceText), []);

  // Re-harvested record: the offsets still slice cleanly, so only the hash can
  // tell that they were resolved against different text.
  const stale = spanErrors(fresh, `${sourceText} appended by a re-harvest.`);
  assert.equal(stale.length, 1);
  assert(stale[0].startsWith("span_stale "));

  const drifted = spanErrors(
    { ...fresh, quote_or_locus: "words no slice of this record produces" },
    sourceText,
  );
  assert(drifted.some((error) => error.startsWith("span_does_not_reslice ")));

  const outOfRange = spanErrors(
    {
      ...fresh,
      source_span: { ...fresh.source_span, end: sourceText.length + 50 },
    },
    sourceText,
  );
  assert(outOfRange.some((error) => error.startsWith("span_out_of_range ")));

  // A legacy item without a span is not invalid — absence is the pre-D-110
  // state, and requiring it of NEW items is enforced where authorship is known.
  assert.deepEqual(spanErrors({ ...base, quote_or_locus: "x" }, sourceText), []);
});

test("provenance reaching a proposal is refused when it carries no span", () => {
  const file = corpus();
  const record = file.records.find(
    (candidate) => candidate.abstract && candidate.doi,
  );
  assert(record?.abstract);
  const unanchored = {
    citations: [cite(record.record_id, record.abstract.slice(0, 80))],
  };
  // The cheap pre-gate runs before anchoring, so it must still admit this.
  assert.equal(groundingOutcome(unanchored, file).ok, true);
  // The call whose provenance becomes a proposal must not (amendment 2.2).
  const refused = groundingOutcome(unanchored, file, { requireSpans: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "malformed_citation");
  assert(refused.ok === false && refused.detail.includes("no anchored span"));
});

test("the run that exposed D-129 replays: a verbatim premise is refused, its findings are not", () => {
  const file = corpus();
  // Tabbers, Martens & van Merriënboer 2004 — the record that grounded BOTH the
  // rejected modality proposal (D-123) and the narrowed cueing effect (D-126).
  // Not a synthetic fixture: the gate has to separate these spans of THIS text,
  // because separating them is the entire reason it exists.
  const record = file.records.find(
    (candidate) => candidate.record_id === "cr_09815b8bafeb7050b14d4cd8",
  );
  assert(record, "the Tabbers record must stay in the CL-14 corpus for this test");
  const source = evidenceSourceText(record);

  // 369-638 is the span the rejected modality proposal actually stored;
  // 1190-1260 and 1369-1527 are the two the approved cueing effect carries.
  const premise = source.slice(369, 638);
  const results = source.slice(1190, 1260);
  const conclusions = source.slice(1369, 1527);
  // Guard the offsets: if a re-harvest moves them, the test must say so rather
  // than quietly assert about different sentences.
  assert.match(premise, /^replacing visual text with spoken text/);
  assert.match(results, /^Adding visual cues to the pictures/);
  assert.match(conclusions, /^Only a weak cueing effect/);

  // What the pipeline actually did: quote the BACKGROUND sentence and call it a
  // finding. The paper labels that section itself, so the structure refuses it.
  const asFinding = groundingOutcome(
    { citations: [cite(record.record_id, premise, "finding")] },
    file,
  );
  assert.equal(asFinding.ok, false);
  assert.equal(
    asFinding.ok === false && asFinding.reason,
    "span_role_contradicted_by_structure",
  );
  assert(asFinding.ok === false && asFinding.detail.includes("BACKGROUND"));

  // Labelled honestly, the same span is a valid citation and a useless one: the
  // item rests on nothing the study observed.
  const asBackground = groundingOutcome(
    { citations: [cite(record.record_id, premise, "background")] },
    file,
  );
  assert.equal(asBackground.ok, false);
  assert.equal(
    asBackground.ok === false && asBackground.reason,
    "span_role_not_finding",
  );

  // Both spans the owner approved must survive. The CONCLUSIONS one is the
  // sharper case: it CONTAINS "reverse", and the sentence after it explains the
  // reversal, so a naive downstream check would refuse the paper's own verdict.
  for (const quote of [results, conclusions]) {
    const outcome = groundingOutcome(
      { citations: [cite(record.record_id, quote, "finding")] },
      file,
    );
    assert.equal(outcome.ok, true, `findings span refused: ${quote.slice(0, 48)}`);
  }

  // An item may cite the premise ALONGSIDE the finding — which is the shape
  // cl-14-001 was narrowed to. One finding is enough; zero is not.
  const both = groundingOutcome(
    {
      citations: [
        cite(record.record_id, premise, "background"),
        cite(record.record_id, results, "finding"),
      ],
    },
    file,
  );
  assert.equal(both.ok, true);
  assert(both.ok);
  assert.deepEqual(
    both.provenance.map((item) => ("span_role" in item ? item.span_role : null)),
    ["background", "finding"],
  );
});

test("an unlabelled abstract falls back to the sentence that reverses the premise", () => {
  const file = corpus();
  const record = file.records.find(
    (candidate) => candidate.record_id === "cr_09815b8bafeb7050b14d4cd8",
  );
  assert(record);
  // The same paper with its section headings stripped — which is what most of
  // this corpus looks like. The structural check goes silent, so the downstream
  // check is all that stands between a background premise and a filed fact.
  const flattened: EvidenceCorpusRecord = {
    ...record,
    abstract: (record.abstract ?? "").replace(
      /\b(BACKGROUND|AIMS|SAMPLE|METHOD|RESULTS|CONCLUSIONS): /g,
      "",
    ),
  };
  const flatFile: EvidenceCorpusFile = {
    ...file,
    records: [flattened, ...file.records.filter((r) => r.record_id !== record.record_id)],
  };
  const source = evidenceSourceText(flattened);
  const premise = source.slice(
    source.indexOf("replacing visual text with spoken text"),
    source.indexOf("less mental effort spent") + "less mental effort spent".length,
  );

  const refused = groundingOutcome(
    { citations: [cite(record.record_id, premise, "finding")] },
    flatFile,
  );
  assert.equal(refused.ok, false);
  assert.equal(
    refused.ok === false && refused.reason,
    "premise_contradicted_downstream",
  );
  // The refusal names the marked word, the contradicting sentence and the shared
  // vocabulary, so a false positive is arguable rather than merely mysterious.
  assert(refused.ok === false && refused.detail.includes("reverse"));
  assert(refused.ok === false && refused.detail.includes("modality"));

  // And the finding sentences still pass with the headings gone.
  for (const marker of [
    "Adding visual cues to the pictures resulted in higher retention scores",
    "Only a weak cueing effect and even a reverse modality effect have been found",
  ]) {
    const at = source.indexOf(marker);
    assert(at >= 0);
    const outcome = groundingOutcome(
      { citations: [cite(record.record_id, source.slice(at, at + marker.length), "finding")] },
      flatFile,
    );
    assert.equal(outcome.ok, true, `refused: ${marker.slice(0, 40)}`);
  }
});

test("a refusal carries both compared strings untruncated", () => {
  const file = corpus();
  const record = file.records.find(
    (candidate) => candidate.abstract && candidate.doi && candidate.abstract.length > 400,
  );
  assert(record?.abstract);

  const invented = "this exact span was never harvested from any source";
  const refusal = groundingOutcome(
    { citations: [{ record_id: record.record_id, quote_or_locus: invented }] },
    file,
  );
  assert.equal(refusal.ok, false);
  if (refusal.ok) return;
  assert.equal(refusal.reason, "quote_not_in_source");
  assert.equal(refusal.corpus_record_id, record.record_id);
  assert(refusal.compared);
  // Untruncated is the whole point: a 120-char detail line was what made the
  // four 100%-drop runs undiagnosable.
  assert.equal(refusal.compared.quote_raw, invented);
  assert.equal(
    refusal.compared.source_raw,
    `${record.title}\n${record.abstract}`,
  );
  assert(refusal.compared.source_raw.length > 400);
  assert.equal(
    refusal.compared.quote_normalized,
    normalizeQualityText(invented),
  );
  assert.equal(
    refusal.compared.source_normalized,
    normalizeQualityText(refusal.compared.source_raw),
  );
  assert.equal(refusal.corpus_side?.title, record.title);
});

test("refusals before any comparison carry no compared strings", () => {
  const file = corpus();
  // Nothing was compared, so claiming a comparison would be a fabrication.
  const noCitations = groundingOutcome({ citations: [] }, file);
  assert.equal(noCitations.ok === false && noCitations.compared, undefined);
  assert.equal(noCitations.ok === false && noCitations.corpus_record_id, null);

  const unknown = groundingOutcome(
    {
      citations: [
        { record_id: "cr_000000000000000000000000", quote_or_locus: "anything" },
      ],
    },
    file,
  );
  assert.equal(unknown.ok === false && unknown.compared, undefined);
  // The cited id survives even though it resolved to nothing.
  assert.equal(
    unknown.ok === false && unknown.corpus_record_id,
    "cr_000000000000000000000000",
  );
});

test("drop reasons are counted per cause and always sum to the total", () => {
  const stats = statsFixture();
  for (const reason of [
    "doi_unresolved",
    "doi_unresolved",
    "quote_not_in_source",
    "no_citations",
    "doi_unresolved",
  ] as const) {
    recordUngroundedDrop(stats, "strong", reason);
  }
  assert.equal(stats.dropped_ungrounded, 5);
  assert.deepEqual(stats.dropped_ungrounded_reasons, {
    doi_unresolved: 3,
    quote_not_in_source: 1,
    no_citations: 1,
  });
  const summed = Object.values(stats.dropped_ungrounded_reasons).reduce(
    (total, count) => total + (count ?? 0),
    0,
  );
  assert.equal(summed, stats.dropped_ungrounded);
  // Densest reason first, so the run log leads with the dominant cause.
  assert.equal(
    formatUngroundedReasons(stats.dropped_ungrounded_reasons),
    "doi_unresolved=3 no_citations=1 quote_not_in_source=1",
  );
  assert.equal(formatUngroundedReasons({}), "");
});

/** An object node of a JSON schema, for navigating one in a test. */
interface SchemaNode {
  additionalProperties?: boolean;
  properties: Record<string, SchemaNode>;
  items?: SchemaNode;
  type?: unknown;
}

/** The per-item schema the model is held to for one mode and stage. */
function itemSchema(mode: ExtractionMode, stage: "extract" | "synthesize"): SchemaNode {
  const format = openRouterResponseFormat(mode, stage) as unknown as {
    json_schema: { schema: SchemaNode };
  };
  const items = format.json_schema.schema.properties.items.items;
  assert(items);
  return items;
}

test("a parameter the model does not advertise is never sent", () => {
  // D-107. require_parameters:true routes only to a provider honouring every
  // parameter in the request, so sending temperature to a model that does not
  // advertise it leaves no eligible provider and 404s before any model runs.
  const claude = openRouterRequestBody({
    tier: configured.tiers.strong,
    mode: "effects",
    stage: "synthesize",
    prompt: "p",
    maxTokens: 1,
  });
  assert.equal("temperature" in claude, false);
  // The guard itself stays on — omitting the parameter is the fix, not
  // loosening routing.
  assert.deepEqual(claude.provider, { require_parameters: true });

  const gemini = openRouterRequestBody({
    tier: { ...configured.tiers.cheap, response_format: "json_schema" },
    mode: "effects",
    stage: "extract",
    prompt: "p",
    maxTokens: 1,
  });
  assert.equal(gemini.temperature, 0);
  assert.deepEqual(gemini.provider, { require_parameters: true });

  // json_object needs no provider constraint, so none is sent.
  const loose = openRouterRequestBody({
    tier: configured.tiers.cheap,
    mode: "effects",
    stage: "extract",
    prompt: "p",
    maxTokens: 1,
  });
  assert.equal("provider" in loose, false);
});

test("the committed extraction config declares capabilities that match its format", () => {
  const config = JSON.parse(
    readFileSync(join(ROOT, "corpora/_ops/extraction.json"), "utf8"),
  ) as ExtractionOpsConfig;
  assert.deepEqual(validateExtractionOpsConfig(config), []);
  // Structural provenance needs a strict schema on both tiers to be
  // enforceable, and json_schema is only routable where the model advertises
  // structured outputs (D-104/D-107).
  for (const tier of [config.tiers.cheap, config.tiers.strong]) {
    assert.equal(tier.response_format, "json_schema");
    assert.equal(tier.supports.structured_outputs, true);
  }
});

test("the synthesis schema has no field a model could put a quote in", () => {
  // D-104 in schema form. The extraction stage may emit citations; the synthesis
  // stage may emit refs and nothing else, so there is no field for a quote or a
  // record id to arrive in.
  for (const mode of ["effects", "realizations", "interactions", "dissent"] as const) {
    const extract = itemSchema(mode, "extract");
    assert("citations" in extract.properties);
    assert.equal("provenance_refs" in extract.properties, false);

    const synthesize = itemSchema(mode, "synthesize");
    assert.equal("citations" in synthesize.properties, false);
    assert("provenance_refs" in synthesize.properties);
    // additionalProperties:false is what makes the absence binding rather than
    // advisory: a citations key would be a schema violation, not extra data.
    assert.equal(synthesize.additionalProperties, false);
    assert.deepEqual(synthesize.properties.provenance_refs, {
      type: "array",
      items: { type: "string" },
    });
  }

  // The two draft modes have their own synthesis schemas; both must agree.
  for (const mode of ["mechanism", "dossier"] as const) {
    const item = itemSchema(mode, "synthesize");
    assert.equal("citations" in item.properties, false);
    assert("provenance_refs" in item.properties);
  }
  // Dossier axes carry provenance too, and are held to the same rule.
  const axes = itemSchema("dossier", "synthesize").properties.scores.properties;
  for (const axis of Object.values(axes)) {
    assert.equal("citations" in axis.properties, false);
    assert("provenance_refs" in axis.properties);
    assert.equal(axis.additionalProperties, false);
  }
});

test("the synthesis projection strips every quote and record id", () => {
  const projected = forSynthesis({
    item: {
      name: "chunking raises effective capacity",
      fact: "grouping items raises recall",
      confidence: 0.8,
      citations: [
        { record_id: "cr_aaaaaaaaaaaaaaaaaaaaaaaa", quote_or_locus: "about four chunks" },
      ],
      scores: {
        evidence: {
          score: 2,
          rationale: "several replications",
          citations: [
            {
              record_id: "cr_aaaaaaaaaaaaaaaaaaaaaaaa",
              quote_or_locus: "about four chunks",
            },
          ],
        },
      },
    },
    refs: ["p1", "p2"],
  });

  // The claim survives; every provenance-shaped field is replaced by handles.
  assert.equal(projected.fact, "grouping items raises recall");
  assert.equal(projected.confidence, 0.8);
  assert.deepEqual(projected.provenance_refs, ["p1", "p2"]);
  assert.equal(projected.citations, undefined);
  assert.equal(projected.scores?.evidence.citations, undefined);
  assert.equal(projected.scores?.evidence.score, 2);

  // The serialized prompt payload is the real guarantee: neither the quote nor
  // the record id can appear anywhere in what the model receives.
  const wire = JSON.stringify(projected);
  assert.equal(wire.includes("cr_aaaaaaaaaaaaaaaaaaaaaaaa"), false);
  assert.equal(wire.includes("about four chunks"), false);
});

test("a persisted rejection omits fields it has no value for", () => {
  const bare = rejectionRecord({
    mechanismId: "CL-14",
    mode: "effects",
    pass: "cheap",
    reason: "no_citations",
    detail: "item carried no citations",
    corpusRecordId: null,
    item: { name: "something" },
  });
  // Absent, not null: a null "compared" would claim a comparison happened.
  assert.equal("compared" in bare, false);
  assert.equal("corpus_side" in bare, false);
  assert.equal("cheap_origin" in bare, false);
  assert.equal(bare.corpus_record_id, null);

  const full = rejectionRecord({
    mechanismId: "CL-14",
    mode: "effects",
    pass: "strong",
    reason: "quote_not_in_source",
    detail: "quote not a substring",
    corpusRecordId: "cr_111111111111111111111111",
    item: { name: "synthesized" },
    provenance: [{ record_id: "cr_111111111111111111111111", quote_or_locus: "x" }],
    compared: {
      quote_raw: "x",
      quote_normalized: "x",
      source_raw: "y",
      source_normalized: "y",
    },
    corpusSide: { doi: "10.1/abc", title: "A title" },
    cheapOrigin: { name: "extracted" },
  });
  // A strong-pass drop must carry the candidate it was synthesized from, since
  // the strong pass never saw the source records.
  assert.deepEqual(full.cheap_origin, { name: "extracted" });
  assert.equal(full.compared?.source_raw, "y");
  assert.equal(full.corpus_side?.doi, "10.1/abc");
});

test("drop reasons are attributed to the pass that produced the candidate", () => {
  const stats = statsFixture();
  recordUngroundedDrop(stats, "cheap", "quote_not_in_source");
  recordUngroundedDrop(stats, "cheap", "quote_not_in_source");
  recordUngroundedDrop(stats, "strong", "doi_unresolved");

  // The total keeps its pre-D-105 meaning; the split explains it.
  assert.equal(stats.dropped_ungrounded, 3);
  assert.equal(stats.dropped_ungrounded_cheap, 2);
  assert.equal(stats.dropped_ungrounded_strong, 1);
  assert.equal(
    stats.dropped_ungrounded_cheap + stats.dropped_ungrounded_strong,
    stats.dropped_ungrounded,
  );
  assert.deepEqual(stats.dropped_ungrounded_reasons_cheap, {
    quote_not_in_source: 2,
  });
  assert.deepEqual(stats.dropped_ungrounded_reasons_strong, {
    doi_unresolved: 1,
  });
  assert.deepEqual(stats.dropped_ungrounded_reasons, {
    quote_not_in_source: 2,
    doi_unresolved: 1,
  });
});

test("realization mode grounds interface observations without a DOI", () => {
  const file: RealizationCorpusFile = {
    mechanism_id: "ZE-07",
    updated_at: "2026-07-21T10:00:00.000Z",
    records: [
      {
        record_id: "rr_111111111111111111111111",
        mechanism_id: "ZE-07",
        source_id: "wayback-cdx",
        origin: "harvested",
        title: "Fixture interface capture",
        source_url: "https://web.archive.org/example",
        source_locator: "capture-1",
        observed_at: "2026-07-21",
        observation: "The interface shows a visible progress counter beside the lesson list.",
        artifact_context: ["dashboard_widget"],
        contributed_by: null,
        license_note: "Fixture public archive",
      },
    ],
  };
  const provenance = groundedProvenance(
    {
      citations: [
        {
          record_id: file.records[0].record_id,
          quote_or_locus: "visible progress counter",
        },
      ],
    },
    file,
  );
  assert(provenance);
  assert.equal(provenance[0].corpus_kind, "realization");
  const proposal = toProposal(
    "realizations",
    "ZE-07",
    {
      term: "Visible progress counter",
      description_as_reported:
        "The captured interface shows a visible progress counter.",
      artifact_context: ["dashboard_widget"],
      confidence: 0.8,
    },
    provenance,
    "fixture-run",
    "2026-07-21T10:00:00.000Z",
  );
  assert.equal(proposal?.type, "realization");
});

/** A resolved effect basis standing in for one still in the proposal queue. */
function effectBasisFixture(recordId: string, doi: string, title: string) {
  return {
    origin: "proposal" as const,
    path: "proposals/effect/fixture.json",
    effect: {
      id: "cl-14-002",
      mechanism_id: "CL-14",
      name: "Expertise reversal effect",
      fact: "Techniques that help early learners may interfere with advanced learners.",
      grade: "A-" as const,
      source: [doi],
      boundary: "Instructional design across levels of learner expertise",
      realization_ids: [],
      provenance: [
        {
          mechanism_id: "CL-14",
          corpus_record_id: recordId,
          doi,
          title,
          quote_or_locus: "Techniques that help early learners may interfere",
        },
      ],
    },
  };
}

test("an effect-anchored realization is marked inferred and carries the transfer as provenance", () => {
  const file = corpus();
  const record = file.records.find((candidate) => candidate.abstract && candidate.doi);
  assert(record?.abstract && record.doi);
  const provenance: KnowledgeProvenanceItem[] = [
    {
      mechanism_id: "CL-14",
      corpus_record_id: record.record_id,
      doi: record.doi,
      title: record.title,
      quote_or_locus: record.abstract.slice(0, 80),
    },
  ];
  const basis = effectBasisFixture(record.record_id, record.doi, record.title);
  const proposal = toProposal(
    "realizations",
    "CL-14",
    {
      term: "Collapsing guided tour",
      description_as_reported:
        "Worked examples helped novices and hindered more advanced learners.",
      pattern:
        "Collapse the guided tour to a dismissible hint once the user has completed the core action {core_action_completions} times.",
      parameters: [
        {
          name: "core_action_completions",
          value: 3,
          unit: "completions of the core action",
          // A model may not author this; the coercion overwrites whatever it sends.
          evidence_basis: "measured in the cited study",
        },
      ],
      source_domain: "medical education",
      artifact_context: ["onboarding_flow"],
      confidence: 0.6,
    },
    provenance,
    "fixture-run",
    "2026-07-31T10:00:00.000Z",
    { corpus: file, knownMechanismIds: new Set<string>(), effectBasis: basis },
  );
  assert(proposal?.type === "realization");
  const payload = proposal.payload;
  assert.equal(payload.derivation, "inferred");
  assert.deepEqual(payload.effect_refs, ["cl-14-002"]);
  assert.equal(payload.domain_transfer?.source_domain, "medical education");
  assert.equal(payload.domain_transfer?.application_domain, "product UI");
  assert.match(payload.pattern ?? "", /^Collapse the guided tour/);
  // The threshold is a declared default, and its basis is code-filled (D-115).
  assert.deepEqual(payload.parameters, [
    {
      name: "core_action_completions",
      value: 3,
      unit: "completions of the core action",
      evidence_basis: "none — default heuristic",
    },
  ]);
  // The transfer step is provenance too, written by code, quoting the effect.
  const inference = payload.provenance.filter(
    (item) => "corpus_kind" in item && item.corpus_kind === "inference",
  );
  assert.equal(inference.length, 1);
  assert.deepEqual(
    inference,
    proposal.provenance.filter(
      (item) => "corpus_kind" in item && item.corpus_kind === "inference",
    ),
  );
  assert.equal(
    (inference[0] as { quote_or_locus: string }).quote_or_locus,
    basis.effect.fact,
  );
  assert.equal(
    (inference[0] as { span_absent_reason: string }).span_absent_reason,
    "no direct span — inferred from effect",
  );
});

test("a pattern that states a threshold as prose is dropped, not repaired (D-115)", () => {
  const file = corpus();
  const record = file.records.find((candidate) => candidate.abstract && candidate.doi);
  assert(record?.abstract && record.doi);
  const provenance: KnowledgeProvenanceItem[] = [
    {
      mechanism_id: "CL-14",
      corpus_record_id: record.record_id,
      doi: record.doi,
      title: record.title,
      quote_or_locus: record.abstract.slice(0, 80),
    },
  ];
  const context = {
    corpus: file,
    knownMechanismIds: new Set<string>(),
    effectBasis: effectBasisFixture(record.record_id, record.doi, record.title),
  };
  const draft = (pattern: string, parameters?: unknown) =>
    toProposal(
      "realizations",
      "CL-14",
      {
        term: "Collapsing guided tour",
        description_as_reported:
          "Worked examples helped novices and made no difference for advanced learners.",
        pattern,
        parameters,
        source_domain: "medical education",
        artifact_context: ["onboarding_flow"],
        confidence: 0.6,
      },
      provenance,
      "fixture-run",
      "2026-07-31T10:00:00.000Z",
      context,
    );

  // The number as a word and as a digit are the same invented precision.
  assert.equal(draft("Collapse the tour after three completions."), null);
  assert.equal(draft("Collapse the tour after 3 completions."), null);
  // A placeholder with nothing declared behind it is not a default either.
  assert.equal(draft("Collapse the tour after {completions} completions."), null);
  // Nor is a declared parameter the pattern never references.
  assert.equal(
    draft("Collapse the tour once the user is fluent.", [
      { name: "completions", value: 3, unit: "completions" },
    ]),
    null,
  );
  // Declared and referenced passes.
  const ok = draft("Collapse the tour after {completions} completions.", [
    { name: "completions", value: 3, unit: "completions of the core action" },
  ]);
  assert(ok?.type === "realization");
  assert.equal(ok.payload.parameters?.length, 1);
});

test("a half-marked inference is dropped rather than proposed as evidence", () => {
  const file = corpus();
  const record = file.records.find((candidate) => candidate.abstract && candidate.doi);
  assert(record?.abstract && record.doi);
  const provenance: KnowledgeProvenanceItem[] = [
    {
      mechanism_id: "CL-14",
      corpus_record_id: record.record_id,
      doi: record.doi,
      title: record.title,
      quote_or_locus: record.abstract.slice(0, 80),
    },
  ];
  const context = {
    corpus: file,
    knownMechanismIds: new Set<string>(),
    effectBasis: effectBasisFixture(record.record_id, record.doi, record.title),
  };
  const withoutPattern = toProposal(
    "realizations",
    "CL-14",
    {
      term: "Adaptive onboarding",
      description_as_reported: "Worked examples helped novices only.",
      source_domain: "medical education",
      artifact_context: ["onboarding_flow"],
      confidence: 0.6,
    },
    provenance,
    "fixture-run",
    "2026-07-31T10:00:00.000Z",
    context,
  );
  const withoutSourceDomain = toProposal(
    "realizations",
    "CL-14",
    {
      term: "Adaptive onboarding",
      description_as_reported: "Worked examples helped novices only.",
      pattern: "Collapse the tour after three completed core actions.",
      artifact_context: ["onboarding_flow"],
      confidence: 0.6,
    },
    provenance,
    "fixture-run",
    "2026-07-31T10:00:00.000Z",
    context,
  );
  assert.equal(withoutPattern, null);
  assert.equal(withoutSourceDomain, null);
});

test("a realization id comes from its term, not from the model's own id", () => {
  const file = corpus();
  const record = file.records.find((candidate) => candidate.abstract && candidate.doi);
  assert(record?.abstract && record.doi);
  const provenance: KnowledgeProvenanceItem[] = [
    {
      mechanism_id: "CL-14",
      corpus_record_id: record.record_id,
      doi: record.doi,
      title: record.title,
      quote_or_locus: record.abstract.slice(0, 80),
    },
  ];
  const ids = ["Collapsing guided tour", "Deferred advanced toolbar"].map((term) => {
    const proposal = toProposal(
      "realizations",
      "CL-14",
      {
        // The first effect-anchored run labelled two different patterns "p1".
        id: "cl-14-002-p1",
        term,
        description_as_reported: "The source reports a fixture pattern.",
        artifact_context: ["onboarding"],
        confidence: 0.6,
      },
      provenance,
      "fixture-run",
      "2026-07-31T10:00:00.000Z",
    );
    assert(proposal?.type === "realization");
    return proposal.payload.id;
  });
  assert.deepEqual(ids, ["collapsing-guided-tour", "deferred-advanced-toolbar"]);
});

test("an effect scope ranks the records the effect cites first", () => {
  const file = corpus();
  const cited = file.records[file.records.length - 1];
  const anchor = {
    effect: effectBasisFixture(cited.record_id, cited.doi ?? "10.0/x", cited.title)
      .effect,
    keywords: ["expertise", "reversal"] as readonly string[],
    citedRecordIds: new Set([cited.record_id]),
  };
  const ranked = rankRelevantRecords(file, file.records, anchor);
  assert.equal(ranked.records[0]?.record_id, cited.record_id);
});

test("Wayback realization ingestion retains text but discards scripts and markup", () => {
  assert.equal(
    visibleReplayText(
      "<html><style>.hidden{}</style><body><h1>Daily progress</h1><script>steal()</script><p>Lesson 3</p></body></html>",
    ),
    "Daily progress Lesson 3",
  );
});

test("all four modes produce typed proposals with canonical identities", () => {
  const file = corpus();
  const record = file.records.find((candidate) => candidate.abstract && candidate.doi);
  assert(record?.abstract && record.doi);
  const provenance: KnowledgeProvenanceItem[] = [
    {
      mechanism_id: "CL-14",
      corpus_record_id: record.record_id,
      doi: record.doi,
      title: record.title,
      quote_or_locus: record.abstract.slice(0, 80),
    },
  ];
  const common = ["test-run", "2026-07-21T10:00:00.000Z"] as const;
  const effect = toProposal(
    "effects",
    "CL-14",
    {
      name: "Fixture phenomenon",
      fact: "Fixture fact.",
      boundary: "Fixture boundary.",
      grade: "B",
      confidence: 0.8,
    },
    provenance,
    ...common,
  );
  const realization = toProposal(
    "realizations",
    "CL-14",
    {
      term: "Fixture interface pattern",
      description_as_reported: "The source reports a fixture pattern.",
      artifact_context: ["interface"],
      confidence: 0.8,
    },
    provenance,
    ...common,
  );
  const interaction = toProposal(
    "interactions",
    "CL-14",
    {
      pair: ["CL-14", "MM-15"],
      type: "reinforcing",
      fact: "Fixture interaction.",
      grade: "B",
      boundary: "Fixture boundary.",
      source: "Fixture citation.",
      confidence: 0.8,
    },
    provenance,
    ...common,
  );
  const dissent = toProposal(
    "dissent",
    "CL-14",
    { value: "Fixture dissent.", confidence: 0.8 },
    provenance,
    ...common,
  );
  for (const proposal of [effect, realization, interaction, dissent]) {
    assert(proposal);
    assert.match(proposalIdentity(proposal), /:/);
    assert.equal(proposal.provenance[0].corpus_record_id, record.record_id);
  }
  assert.equal(effect?.type, "effect");
  assert.equal(realization?.type, "realization");
  assert.equal(interaction?.type, "interaction");
  assert.equal(dissent?.type, "dossier_section");
});

test("near-duplicate realization enriches the existing artifact instead of duplicating it", () => {
  const file = corpus();
  const record = file.records.find((candidate) => candidate.abstract && candidate.doi);
  assert(record?.abstract && record.doi);
  const provenance: KnowledgeProvenanceItem[] = [{
    mechanism_id: "CL-14",
    corpus_record_id: record.record_id,
    doi: record.doi,
    title: record.title,
    quote_or_locus: record.abstract.slice(0, 80),
  }];
  const candidate = toProposal(
    "realizations",
    "CL-14",
    {
      term: "Progress indicator pattern",
      description_as_reported: "A progress indicator pattern was shown in the interface.",
      artifact_context: ["onboarding flow"],
      confidence: 0.86,
    },
    provenance,
    "test-run",
    "2026-07-21T10:00:00.000Z",
  );
  assert(candidate?.type === "realization");
  const existing: Proposal = {
    ...candidate,
    id: "artifact-realization-cl-14-progress-indicator",
    operation: "enrich",
    payload: {
      ...candidate.payload,
      id: "progress-indicator",
      term: "Progress indicator",
      description_as_reported: "A progress indicator is shown in onboarding.",
    },
    proposed_by: "authoritative-artifact",
    status: "approved",
    decided_by: "owner",
    decided_at: "2026-07-20T10:00:00.000Z",
    decision_note: null,
  };
  assert(proposalSimilarity(existing, candidate) >= configured.limits.duplicate_similarity);
  const merged = mergeProposals(existing, candidate);
  assert.equal(merged.type, "realization");
  assert.equal(merged.payload.id, "progress-indicator");
  assert.equal(merged.provenance.length, 1);
});

test("draft modes resolve seed candidates only when seeds are included", () => {
  assert.throws(() => resolveScope({ mechanism: "CO-19" }), /Unknown full mechanism/);
  const scope = resolveScope({ mechanism: "CO-19" }, { includeSeeds: true });
  assert.deepEqual(scope.mechanismIds, ["CO-19"]);
});

test("mode=dossier grounds axes per-citation and leaves ungrounded axes unscored", () => {
  const file = corpus();
  const record = file.records.find((candidate) => candidate.abstract && candidate.doi);
  assert(record?.abstract && record.doi);
  const exact = record.abstract.slice(0, 80);
  const provenance = groundedProvenance(
    { citations: [cite(record.record_id, exact)] },
    file,
  );
  assert(provenance);
  const context = {
    corpus: file,
    knownMechanismIds: new Set(["CL-14", "MM-15"]),
  };
  const axis = (grounded: boolean) => ({
    score: 2,
    rationale: "Grounded rationale from the cited abstract.",
    citations: [
      cite(record.record_id, grounded ? exact : "This span was invented."),
    ],
  });
  const proposal = toProposal(
    "dossier",
    "CL-14",
    {
      scores: {
        evidence: axis(true),
        product_applicability: axis(false),
        measurability: axis(true),
        orthogonality: axis(true),
        safety: axis(true),
      },
      core_condition: "A measured lift in the studied outcome.",
      dissent: "Counter-evidence exists in the corpus.",
      confidence: 0.8,
    },
    provenance,
    "test-run",
    "2026-07-21T10:00:00.000Z",
    context,
  );
  assert(proposal?.type === "dossier");
  assert.equal(proposal.payload.id, "DOS-CL-14");
  assert.equal(proposal.payload.scores.evidence.score, 2);
  assert(proposal.payload.scores.evidence.provenance.length > 0);
  // The invented citation must NOT become a guessed score.
  assert.equal(proposal.payload.scores.product_applicability.score, null);
  assert.equal(proposal.payload.scores.product_applicability.rationale, null);
  assert.deepEqual(proposal.payload.scores.product_applicability.provenance, []);
  assert(proposal.payload.evidence_sources.length > 0);
  // Every axis provenance item is carried by the envelope (re-grounding gate).
  const envelope = new Set(proposal.provenance.map((item) => JSON.stringify(item)));
  for (const axisValue of Object.values(proposal.payload.scores)) {
    for (const item of axisValue.provenance) {
      assert(envelope.has(JSON.stringify(item)));
    }
  }
  // Without draft context the draft modes fail closed.
  assert.equal(
    toProposal(
      "dossier",
      "CL-14",
      { core_condition: "x", dissent: "y", confidence: 0.8 },
      provenance,
      "test-run",
      "2026-07-21T10:00:00.000Z",
    ),
    null,
  );
});

test("mode=mechanism composes a schema-valid record from seed + grounded claims", () => {
  const file = corpus();
  const record = file.records.find((candidate) => candidate.abstract && candidate.doi);
  assert(record?.abstract && record.doi);
  const provenance: KnowledgeProvenanceItem[] = [
    {
      mechanism_id: "CL-14",
      corpus_record_id: record.record_id,
      doi: record.doi,
      title: record.title,
      quote_or_locus: record.abstract.slice(0, 80),
    },
  ];
  const seed = {
    id: "CO-19",
    name: "Competence & mastery",
    grade_draft: "B+",
    oneliner: "Fixture oneliner.",
    parent: "S8" as const,
    lifecycle_status: "candidate" as const,
    evidence_terms: ["competence need satisfaction"],
    pinned_evidence: [
      { doi: "10.1037/0003-066X.55.1.68", title: "SDT", reason: "foundational" },
    ],
  };
  const proposal = toProposal(
    "mechanism",
    "CO-19",
    {
      grade: "B+",
      summary: "People persist when interfaces make growing capability visible.",
      evidence_basis: "Meta-analyses and field experiments on competence need satisfaction.",
      effect_size_note: "Moderate effects in the studied contexts.",
      caveats: ["Validated mainly in education contexts"],
      funnel_stages: ["onboarding", "retention", "not_a_stage"],
      excluded_stages: ["cold_acquisition"],
      applicability_artifact_types: ["onboarding", "dashboard_widget", "bogus"],
      preconditions: [
        { predicate: "artifact.has_skill_progression == true", reason: "no mastery signal otherwise" },
      ],
      culture_note: "General logic; surface vocabulary varies.",
      implementations: [
        {
          id_suffix: "visible-skill-progress",
          artifact_types: ["dashboard_widget"],
          product_requirements: [],
          generation_directive: "Show the user their growing capability explicitly.",
          copy_formulas: [],
          metrics: ["task completion rate"],
        },
      ],
      hard_rules: [
        { id: "No Fake Mastery", rule: "Never fabricate skill progress.", severity: "block" },
      ],
      compliance_refs: [],
      boundary_test: "Does the interface reflect real capability growth?",
      relations: [
        { type: "adjacent", target: "CL-14", note: "Load ceiling limits mastery signals." },
        { type: "adjacent", target: "XX-99", note: "Unknown target must be dropped." },
      ],
      confidence: 0.8,
    },
    provenance,
    "test-run",
    "2026-07-21T10:00:00.000Z",
    {
      corpus: file,
      seed,
      knownMechanismIds: new Set(["CL-14", "CO-19"]),
    },
  );
  assert(proposal?.type === "mechanism");
  const payload = proposal.payload;
  assert.equal(payload.id, "CO-19");
  assert.equal(payload.slug, "competence_mastery");
  assert.equal(payload.name, seed.name);
  assert.equal(payload.lifecycle_status, "candidate");
  assert.equal(payload.dossier_ref, "dossiers/CO-19.json");
  assert.equal(payload.provenance.proposed_by, "derivation-pipeline");
  assert.deepEqual(payload.evidence_terms, seed.evidence_terms);
  assert.deepEqual(payload.applicability.funnel_stages, ["onboarding", "retention"]);
  assert.deepEqual(payload.applicability.artifact_types, [
    "onboarding",
    "dashboard_widget",
  ]);
  assert.equal(payload.implementations[0].id, "CO-19-visible-skill-progress");
  assert.deepEqual(payload.implementations[0].metrics, ["task_completion_rate"]);
  assert.equal(payload.constraints.hard_rules[0].id, "no_fake_mastery");
  assert.deepEqual(
    payload.relations.map((relation) => relation.target),
    ["CL-14"],
  );
  assert.equal(payload.prior_weight, 0.7);
});

test("run summary exposes every quality-gate and cap outcome", () => {
  assert.deepEqual(
    extractionSummaryParams(
      statsFixture({
        candidates: 15,
        candidates_cheap: 12,
        candidates_strong: 3,
        records_processed: 20,
        records_skipped_irrelevant: 5,
        proposed: 4,
        merged: 3,
        dropped_ungrounded: 2,
        dropped_ungrounded_cheap: 1,
        dropped_ungrounded_strong: 1,
        dropped_ungrounded_reasons: { doi_unresolved: 2 },
        dropped_ungrounded_reasons_cheap: { doi_unresolved: 1 },
        dropped_ungrounded_reasons_strong: { doi_unresolved: 1 },
        failed_validation: 1,
        held_low_confidence: 2,
        dropped_volume_cap: 4,
        dropped_volume_cap_high_confidence: 1,
        records_eligible: 200,
        records_relevant: 120,
        records_remaining: 95,
        records_selected: 25,
        records_dropped_truncation: 95,
      }),
    ),
    {
      candidates: "15",
      records_processed: "20",
      records_skipped_irrelevant: "5",
      proposed: "4",
      merged: "3",
      dropped_ungrounded: "2",
      dropped_ungrounded_reasons: "doi_unresolved=2",
      failed_validation: "1",
      held_low_confidence: "2",
      dropped_volume_cap: "4",
      dropped_volume_cap_high_confidence: "1",
      records_eligible: "200",
      records_relevant: "120",
      records_remaining: "95",
      records_selected: "25",
      records_dropped_truncation: "95",
      candidates_cheap: "12",
      candidates_strong: "3",
      dropped_ungrounded_cheap: "1",
      dropped_ungrounded_strong: "1",
      dropped_ungrounded_reasons_cheap: "doi_unresolved=1",
      dropped_ungrounded_reasons_strong: "doi_unresolved=1",
    },
  );
});

test("the per-pass funnel is written even at zero so absence means pre-gate", () => {
  const params = extractionSummaryParams(statsFixture({ candidates: 0 }));
  // Present-at-zero is the contract: /ops distinguishes "gated, nothing lost"
  // from "this run never gated the cheap pass" by presence, not by value.
  assert.equal(params.candidates_cheap, "0");
  assert.equal(params.candidates_strong, "0");
  assert.equal(params.dropped_ungrounded_cheap, "0");
  assert.equal(params.dropped_ungrounded_strong, "0");
  // The per-reason maps stay absent when nothing was dropped.
  assert.equal("dropped_ungrounded_reasons_cheap" in params, false);
  assert.equal("dropped_ungrounded_reasons_strong" in params, false);
  // D-103 counters follow the same present-at-zero rule: absence is what
  // identifies a run recorded before the truncation figures existed.
  assert.equal(params.records_selected, "0");
  assert.equal(params.records_dropped_truncation, "0");
});

test("preflight probes each tier with the stage that tier actually runs", () => {
  // Probing both tiers with "synthesize" proved the cheap tier could route a
  // schema it never sends, and left the schema it does send untested (D-107).
  assert.equal(productionStage("cheap"), "extract");
  assert.equal(productionStage("strong"), "synthesize");

  const cheapBody = openRouterRequestBody({
    tier: configured.tiers.cheap,
    mode: "effects",
    stage: productionStage("cheap"),
    prompt: "probe",
    maxTokens: 1,
  });
  const strongBody = openRouterRequestBody({
    tier: configured.tiers.strong,
    mode: "effects",
    stage: productionStage("strong"),
    prompt: "probe",
    maxTokens: 1,
  });
  const schemaName = (body: Record<string, unknown>): string | undefined =>
    (
      body.response_format as
        | { json_schema?: { name?: string } }
        | undefined
    )?.json_schema?.name;
  // Each tier must be proven against its own schema, so the two probes differ.
  assert.notEqual(schemaName(strongBody), schemaName(cheapBody));
  assert.equal(cheapBody.max_tokens, 1);
  assert.equal(strongBody.max_tokens, 1);
});

test("a 404 names the parameter its own body blames, and never guesses", () => {
  const sent = ["response_format", "provider", "temperature"];
  assert.deepEqual(
    rejectedParameters(
      '{"error":{"message":"No endpoints found that support tool use"}}',
      sent,
    ),
    ["provider"],
  );
  assert.deepEqual(
    rejectedParameters(
      '{"error":{"message":"temperature is not supported by this model"}}',
      sent,
    ),
    ["temperature"],
  );
  assert.deepEqual(
    rejectedParameters('{"error":{"message":"json_schema is unsupported"}}', sent),
    ["response_format"],
  );
  // A parameter the request never carried cannot be blamed for the refusal.
  assert.deepEqual(
    rejectedParameters('{"error":{"message":"temperature unsupported"}}', [
      "response_format",
    ]),
    [],
  );
  // Silence is reported as silence; the caller widens to the whole sent set
  // rather than picking one.
  assert.deepEqual(rejectedParameters('{"error":{"message":"upstream error"}}', sent), []);
});

test("a truncated plan reports available, kept, and dropped as three numbers", () => {
  const config: ExtractionOpsConfig = {
    ...configured,
    limits: {
      ...configured.limits,
      // Small enough that the fixed per-batch overhead admits one batch and
      // refuses the next, which is the condition D-103 exists to describe.
      per_run_tokens: 30000,
      records_per_batch: 5,
    },
  };
  const plan = buildExtractionPlan(
    "effects",
    { kind: "mechanism", id: "CL-14", mechanismIds: ["CL-14"] },
    config,
    null,
  );
  assert(plan.capped, "expected a plan the per-run cap had to truncate");
  assert(plan.records.eligible_total > 0);
  assert(plan.records.selected > 0, "the planner must keep something");
  assert(
    plan.records.dropped_truncation > 0,
    "a capped plan must report what it dropped to fit",
  );
  // "Available" is the corpus; "kept" plus "dropped" is the relevant subset.
  // Reading only two of the three cannot tell a full-scope run from a slice.
  assert.equal(plan.records.dropped_truncation, plan.records.remaining);
  assert(
    plan.records.selected + plan.records.dropped_truncation <=
      plan.records.eligible_total,
  );
});

test("a run that dies mid-way still leaves its spend on the monthly cap", () => {
  const startedAt = new Date("2026-07-30T09:00:00.000Z");
  const spentBeforeCrash: Usage = {
    input: 40000,
    output: 4000,
    calls: 3,
    byTier: {
      cheap: { input: 36000, output: 3000, calls: 2 },
      strong: { input: 4000, output: 1000, calls: 1 },
    },
  };
  const crashStats = statsFixture({
    candidates: 4,
    candidates_strong: 4,
    records_processed: 50,
    records_eligible: 200,
    records_relevant: 150,
    records_remaining: 100,
  });
  const built = buildExtractionManifestRun({
    mode: "effects",
    scope: resolveScope({ mechanism: "CG-05" }),
    startedAt,
    config: configured,
    usage: spentBeforeCrash,
    stats: crashStats,
    filesWritten: 0,
    capped: false,
    incomplete: true,
    durationS: 42,
  });
  const failed: CorpusManifestRun = { ...built, status: "failed" };

  // The whole point: a failed run's cost block is non-zero, so the monthly
  // rollup the budget gate reads can see the spend.
  assert.equal(failed.status, "failed");
  assert(failed.cost);
  assert(failed.cost.estimated_usd > 0);
  assert.equal(failed.cost.api_calls, 3);
  assert.equal(failed.cost.tokens_in, 40000);
  assert.equal(failed.cost.tokens_out, 4000);

  const older: CorpusManifestRun = {
    ...built,
    timestamp: "2026-07-29T09:00:00.000Z",
  };
  // Each in-flight write supersedes the previous snapshot of the SAME run…
  const firstWrite = mergeExtractionRunHistory([older], built);
  const secondWrite = mergeExtractionRunHistory(firstWrite, failed);
  assert.equal(
    secondWrite.filter((entry) => entry.timestamp === built.timestamp).length,
    1,
  );
  assert.equal(secondWrite[0].status, "failed");
  // …while a genuinely different run is preserved, not overwritten.
  assert.equal(secondWrite.length, 2);
  assert.equal(secondWrite[1].timestamp, older.timestamp);

  const monthly = secondWrite.reduce(
    (total, entry) => total + (entry.cost?.estimated_usd ?? 0),
    0,
  );
  assert.equal(monthly, failed.cost.estimated_usd * 2);
});

test("a clean run carries no drop-reason field at all", () => {
  const params = extractionSummaryParams(
    statsFixture({
      candidates: 3,
      candidates_strong: 3,
      records_processed: 3,
      proposed: 3,
      records_eligible: 3,
      records_relevant: 3,
    }),
  );
  assert.equal("dropped_ungrounded_reasons" in params, false);
});


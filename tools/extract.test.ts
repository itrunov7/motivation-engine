import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { extractionPriceState, validateExtractionOpsConfig } from "../lib/ops";
import {
  groundingErrors,
  mergeProposals,
  proposalSimilarity,
} from "../lib/proposal-quality";
import type {
  EvidenceCorpusFile,
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
  groundedProvenance,
  mergeReaderCoverage,
  openRouterStructuredOutputOptions,
  parseDraftResponse,
  proposalIdentity,
  rankRelevantRecords,
  recordRelevanceTier,
  resolveScope,
  settleResponseBatch,
  toProposal,
} from "./extract";
import { visibleReplayText } from "./connectors/realization-wayback";

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
    },
    strong: {
      model_id: "owner/strong",
      response_format: "json_schema",
      input_usd_per_token: 0.0000003,
      output_usd_per_token: 0.0000004,
      max_tokens_per_call: 32000,
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
    stats: {
      candidates: 1,
      records_processed: 3,
      records_skipped_irrelevant: 7,
      dropped_ungrounded: 0,
      failed_validation: 1,
      proposed: 1,
      merged: 0,
      held_low_confidence: 0,
      dropped_volume_cap: 0,
      dropped_volume_cap_high_confidence: 0,
      records_eligible: 10,
      records_relevant: 3,
      records_remaining: 0,
    },
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
    stats: {
      candidates: 0,
      records_processed: 25,
      records_skipped_irrelevant: 0,
      dropped_ungrounded: 0,
      failed_validation: 1,
      proposed: 0,
      merged: 0,
      held_low_confidence: 0,
      dropped_volume_cap: 0,
      dropped_volume_cap_high_confidence: 0,
      records_eligible: 25,
      records_relevant: 25,
      records_remaining: 25,
    },
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
    {
      citations: [{ record_id: record.record_id, quote_or_locus: exact }],
    },
    file,
  );
  assert.equal(grounded?.[0].corpus_record_id, record.record_id);
  assert.equal(
    groundedProvenance(
      {
        citations: [
          { record_id: record.record_id, quote_or_locus: "This span was invented." },
        ],
      },
      file,
    ),
    null,
  );
  assert.equal(
    groundedProvenance(
      {
        citations: [
          { record_id: "cr_000000000000000000000000", quote_or_locus: exact },
        ],
      },
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
    { citations: [{ record_id: record.record_id, quote_or_locus: exact }] },
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
      {
        record_id: record.record_id,
        quote_or_locus: grounded ? exact : "This span was invented.",
      },
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
    extractionSummaryParams({
      candidates: 15,
      records_processed: 20,
      records_skipped_irrelevant: 5,
      proposed: 4,
      merged: 3,
      dropped_ungrounded: 2,
      failed_validation: 1,
      held_low_confidence: 2,
      dropped_volume_cap: 4,
      dropped_volume_cap_high_confidence: 1,
      records_eligible: 200,
      records_relevant: 120,
      records_remaining: 95,
    }),
    {
      candidates: "15",
      records_processed: "20",
      records_skipped_irrelevant: "5",
      proposed: "4",
      merged: "3",
      dropped_ungrounded: "2",
      failed_validation: "1",
      held_low_confidence: "2",
      dropped_volume_cap: "4",
      dropped_volume_cap_high_confidence: "1",
      records_eligible: "200",
      records_relevant: "120",
      records_remaining: "95",
    },
  );
});


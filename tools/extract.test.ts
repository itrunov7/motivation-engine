import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { extractionPriceState } from "../lib/ops";
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
  RealizationCorpusFile,
} from "../lib/types";
import {
  buildQuote,
  extractionSummaryParams,
  groundedProvenance,
  mergeReaderCoverage,
  proposalIdentity,
  resolveScope,
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
      input_usd_per_token: 0.0000001,
      output_usd_per_token: 0.0000002,
      max_tokens_per_call: 24000,
    },
    strong: {
      model_id: "owner/strong",
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
    new Map([["CL-14", ["cr_111111111111111111111111"]]]),
    "2026-07-21T10:00:00.000Z",
  );
  const second = mergeReaderCoverage(
    first,
    "dissent",
    new Map([
      [
        "CL-14",
        [
          "cr_111111111111111111111111",
          "cr_222222222222222222222222",
        ],
      ],
    ]),
    "2026-07-21T11:00:00.000Z",
  );
  assert.deepEqual(second.mechanisms["CL-14"].evidence, {
    processed_record_ids: [
      "cr_111111111111111111111111",
      "cr_222222222222222222222222",
    ],
    processed_at: "2026-07-21T11:00:00.000Z",
    modes: ["dissent", "effects"],
  });
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

test("run summary exposes every quality-gate and cap outcome", () => {
  assert.deepEqual(
    extractionSummaryParams({
      candidates: 15,
      proposed: 4,
      merged: 3,
      dropped_ungrounded: 2,
      held_low_confidence: 2,
      dropped_volume_cap: 4,
      dropped_volume_cap_high_confidence: 1,
    }),
    {
      candidates: "15",
      proposed: "4",
      merged: "3",
      dropped_ungrounded: "2",
      held_low_confidence: "2",
      dropped_volume_cap: "4",
      dropped_volume_cap_high_confidence: "1",
    },
  );
});


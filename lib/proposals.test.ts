import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  applyLocalTransaction,
  FileTransactionConflictError,
  LocalRepositorySnapshot,
} from "./local-transaction";
import { commitGitDataTransaction, type GithubOpsEnv } from "./github";
import { deriveCorpusRecordId } from "./corpus-record-id";
import { isExtractionAuthored } from "./proposal-meta";
import { evidenceSourceText, sha256Hex } from "./proposal-quality";
import {
  BatchProposalValidationError,
  isActionableProposal,
  prepareBatchProposalDecision,
  prepareOwnerObservationTransaction,
  prepareProposalDecision,
  type RepositorySnapshot,
} from "./proposals";
import type {
  EvidenceCorpusFile,
  Mechanism,
  Proposal,
  ProposalType,
  SegmentsFile,
} from "./types";

const ROOT = join(__dirname, "..");
const decidedAt = "2026-07-20T18:00:00.000Z";
const provenance = [
  {
    mechanism_id: "LA-01",
    corpus_record_id: deriveCorpusRecordId({
      doi: "10.2307/1914185",
      title: "Prospect Theory: An Analysis of Decision under Risk",
      year: 1979,
    }),
    doi: "10.2307/1914185",
    title: "Prospect Theory: An Analysis of Decision under Risk",
    quote_or_locus:
      "This paper presents a critique of expected utility theory as a descriptive model of decision making under risk",
  },
];

class FixtureSnapshot implements RepositorySnapshot {
  constructor(
    readonly proposalPath: string,
    readonly proposal: unknown,
  ) {}

  async read(path: string): Promise<string | null> {
    if (path === this.proposalPath) return `${JSON.stringify(this.proposal, null, 2)}\n`;
    try {
      return await readFile(join(ROOT, path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

function envelope(
  type: ProposalType,
  id: string,
  target: string,
  payload: unknown,
  operation: "create" | "enrich" = "create",
): unknown {
  return {
    id,
    type,
    operation,
    target,
    payload,
    provenance,
    confidence: 0.9,
    proposed_by: "test-run",
    proposed_at: "2026-07-20T17:00:00.000Z",
    status: "pending",
    hold_reason: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
  };
}

async function prepare(
  type: ProposalType,
  id: string,
  target: string,
  payload: unknown,
  action: "approve" | "reject" = "approve",
  operation: "create" | "enrich" = "create",
) {
  const path = `proposals/${type}/${id}.json`;
  return prepareProposalDecision(
    new FixtureSnapshot(path, envelope(type, id, target, payload, operation)),
    {
      proposalPath: path,
      action,
      decidedBy: "test-owner",
      decidedAt,
      reason: action === "reject" ? "Not supported by the cited locus" : undefined,
      schemaRoot: ROOT,
    },
  );
}

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "proposal-repository-"));
  for (const path of [
    "registry",
    "dossiers",
    "interactions",
    "effects",
    "realizations",
    "proposals",
    "decisions",
    "segments",
    "corpora",
  ]) {
    await cp(join(ROOT, path), join(root, path), { recursive: true });
  }
  return root;
}

test("projects all six proposal types deterministically", async () => {
  const mechanism = JSON.parse(
    await readFile(join(ROOT, "registry/mechanisms/LA-01.json"), "utf8"),
  ) as Mechanism;
  const interaction = JSON.parse(
    await readFile(join(ROOT, "interactions/LA-01__ST-09.json"), "utf8"),
  ) as unknown;
  const segments = parseYaml(
    await readFile(join(ROOT, "segments/segments.yaml"), "utf8"),
  ) as SegmentsFile;

  const cases: {
    type: ProposalType;
    id: string;
    target: string;
    payload: unknown;
    artifactPaths: string[];
    operation?: "create" | "enrich";
  }[] = [
    {
      type: "effect",
      id: "test-effect-proposal",
      target: "LA-01",
      payload: {
        id: "test-effect",
        mechanism_id: "LA-01",
        name: "Test effect",
        fact: "Fixture fact",
        grade: "A",
        source: ["10.2307/1914185"],
        boundary: "Fixture boundary",
        realization_ids: [],
        provenance,
      },
      artifactPaths: [
        "effects/LA-01/test-effect.json",
        "registry/mechanisms/LA-01.json",
      ],
    },
    {
      type: "realization",
      id: "test-realization-proposal",
      target: "LA-01",
      payload: {
        id: "test-realization",
        mechanism_id: "LA-01",
        term: "Test source-grounded realization",
        description_as_reported: "A fixture description reported by the cited source.",
        artifact_context: ["choice task"],
        provenance,
        confidence: 0.9,
      },
      artifactPaths: ["realizations/LA-01/test-realization.json"],
    },
    {
      type: "interaction",
      id: "test-interaction-proposal",
      target: "LA-01__ST-09",
      payload: { ...(interaction as object), fact: "Updated fixture interaction fact" },
      artifactPaths: ["interactions/LA-01__ST-09.json"],
      operation: "enrich",
    },
    {
      type: "mechanism",
      id: "test-mechanism-proposal",
      target: "LA-01",
      payload: { ...mechanism, name: "Loss aversion fixture" },
      artifactPaths: ["registry/mechanisms/LA-01.json"],
    },
    {
      type: "dossier_section",
      id: "test-dossier-proposal",
      target: "LA-01",
      payload: { field: "notes", value: "Updated fixture note" },
      artifactPaths: ["dossiers/LA-01.json"],
    },
    {
      type: "segment",
      id: "test-segment-proposal",
      target: segments.segments[0].id,
      payload: { ...segments.segments[0], definition: "Updated fixture definition" },
      artifactPaths: ["segments/segments.yaml"],
    },
  ];

  for (const item of cases) {
    const transaction = await prepare(
      item.type,
      item.id,
      item.target,
      item.payload,
      "approve",
      item.operation,
    );
    const paths = transaction.mutations.map((mutation) => mutation.path);
    for (const artifactPath of item.artifactPaths) assert(paths.includes(artifactPath));
    if (item.operation === "enrich") {
      const artifactMutation = transaction.mutations.find(
        (mutation) => mutation.path === item.artifactPaths[0],
      );
      assert(artifactMutation?.expectedContent);
      assert.notEqual(artifactMutation.expectedContent, artifactMutation.content);
    }
    assert(paths.includes(`proposals/${item.type}/${item.id}.json`));
    assert(paths.includes("decisions/decisions.json"));
    assert.deepEqual(paths, [...paths].sort());
  }
});

test("approves a hand-made effect proposal into authoritative files", async () => {
  const root = await temporaryRepository();
  const proposalPath = "proposals/effect/hand-made-effect.json";
  const proposal = envelope("effect", "hand-made-effect", "LA-01", {
    id: "hand-made-effect",
    mechanism_id: "LA-01",
    name: "Hand-made test effect",
    fact: "A grounded fixture phenomenon.",
    grade: "A",
    source: ["10.2307/1914185"],
    boundary: "Only a transaction fixture.",
    realization_ids: [],
    provenance,
  });
  try {
    await mkdir(join(root, "proposals/effect"), { recursive: true });
    await writeFile(
      join(root, proposalPath),
      `${JSON.stringify(proposal, null, 2)}\n`,
      "utf8",
    );
    const beforeDecisions = JSON.parse(
      await readFile(join(root, "decisions/decisions.json"), "utf8"),
    ) as { decisions: unknown[] };
    const transaction = await prepareProposalDecision(
      new LocalRepositorySnapshot(root),
      {
        proposalPath,
        action: "approve",
        decidedBy: "test-owner",
        decidedAt,
        schemaRoot: root,
      },
    );
    await applyLocalTransaction(root, transaction);

    const effect = JSON.parse(
      await readFile(join(root, "effects/LA-01/hand-made-effect.json"), "utf8"),
    ) as { id: string };
    const mechanism = JSON.parse(
      await readFile(join(root, "registry/mechanisms/LA-01.json"), "utf8"),
    ) as Mechanism;
    const decided = JSON.parse(
      await readFile(join(root, proposalPath), "utf8"),
    ) as { status: string };
    const afterDecisions = JSON.parse(
      await readFile(join(root, "decisions/decisions.json"), "utf8"),
    ) as { decisions: unknown[] };
    assert.equal(effect.id, "hand-made-effect");
    assert(mechanism.effect_refs?.includes("hand-made-effect"));
    assert.equal(decided.status, "approved");
    assert.equal(afterDecisions.decisions.length, beforeDecisions.decisions.length + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an inferred realization cannot be approved before the effect it transfers from", async () => {
  const root = await temporaryRepository();
  const effectId = "transfer-basis-effect";
  const effectFact = "A grounded fixture phenomenon.";
  const effectProposalPath = `proposals/effect/${effectId}.json`;
  const realizationPath = "proposals/realization/inferred-transfer.json";
  const inference = {
    corpus_kind: "inference" as const,
    mechanism_id: "LA-01",
    corpus_record_id: provenance[0].corpus_record_id,
    effect_id: effectId,
    title: provenance[0].title,
    quote_or_locus: effectFact,
    span_absent_reason: "no direct span — inferred from effect" as const,
  };
  const realizationPayload = {
    id: "inferred-transfer",
    mechanism_id: "LA-01",
    effect_refs: [effectId],
    derivation: "inferred",
    domain_transfer: {
      source_domain: "behavioural economics",
      application_domain: "product UI",
    },
    term: "Fixture transferred pattern",
    description_as_reported: effectFact,
    pattern: "Collapse the fixture panel after {core_actions} completed core actions.",
    parameters: [
      {
        name: "core_actions",
        value: 3,
        unit: "completed core actions",
        evidence_basis: "none — default heuristic",
      },
    ],
    artifact_context: ["onboarding_flow"],
    provenance: [...provenance, inference],
    confidence: 0.6,
  };
  const realizationProposal = envelope(
    "realization",
    "inferred-transfer",
    "LA-01",
    realizationPayload,
  ) as Record<string, unknown>;
  realizationProposal.provenance = [...provenance, inference];
  const approve = (path: string) =>
    prepareProposalDecision(new LocalRepositorySnapshot(root), {
      proposalPath: path,
      action: "approve",
      decidedBy: "test-owner",
      decidedAt,
      schemaRoot: root,
    });
  try {
    await mkdir(join(root, "proposals/effect"), { recursive: true });
    await mkdir(join(root, "proposals/realization"), { recursive: true });
    await writeFile(
      join(root, realizationPath),
      `${JSON.stringify(realizationProposal, null, 2)}\n`,
      "utf8",
    );
    // The effect is still a proposal: the transfer may be proposed, not applied.
    await assert.rejects(approve(realizationPath), (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /transfer-basis-effect/);
      assert.match(message, /does not (exist|resolve)/);
      return true;
    });

    await writeFile(
      join(root, effectProposalPath),
      `${JSON.stringify(
        envelope("effect", effectId, "LA-01", {
          id: effectId,
          mechanism_id: "LA-01",
          name: "Transfer basis effect",
          fact: effectFact,
          grade: "A",
          source: ["10.2307/1914185"],
          boundary: "Only a transaction fixture.",
          realization_ids: [],
          provenance,
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    await applyLocalTransaction(root, await approve(effectProposalPath));

    // With the effect in place, the threshold is the remaining gate (D-115):
    // the same pattern stating its number as prose is refused.
    const proseThreshold = {
      ...realizationProposal,
      payload: {
        ...realizationPayload,
        pattern: "Collapse the fixture panel after three completed core actions.",
        parameters: undefined,
      },
    };
    const prosePath = "proposals/realization/prose-threshold.json";
    await writeFile(
      join(root, prosePath),
      `${JSON.stringify({ ...proseThreshold, id: "prose-threshold" }, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(approve(prosePath), /ungrounded threshold|no source measured it/);

    await applyLocalTransaction(root, await approve(realizationPath));

    const record = JSON.parse(
      await readFile(join(root, "realizations/LA-01/inferred-transfer.json"), "utf8"),
    ) as {
      derivation: string;
      effect_refs: string[];
      domain_transfer: { source_domain: string; application_domain: string };
      pattern: string;
      parameters: { name: string; evidence_basis: string }[];
    };
    assert.equal(record.derivation, "inferred");
    assert.deepEqual(record.effect_refs, [effectId]);
    assert.equal(record.domain_transfer.application_domain, "product UI");
    assert.match(record.pattern, /^Collapse the fixture panel/);
    assert.equal(record.parameters[0].evidence_basis, "none — default heuristic");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval copies a source span verbatim and refuses a stale one", async () => {
  const root = await temporaryRepository();
  try {
    const corpus = JSON.parse(
      await readFile(join(root, "corpora/evidence/LA-01.json"), "utf8"),
    ) as EvidenceCorpusFile;
    const record = corpus.records.find(
      (candidate) => candidate.record_id === provenance[0].corpus_record_id,
    );
    assert(record, "fixture provenance must cite a real corpus record");
    const sourceText = evidenceSourceText(record);
    const start = sourceText.indexOf(provenance[0].quote_or_locus);
    assert(start >= 0, "fixture quote must be an exact slice of the source text");
    const source_span = {
      start,
      end: start + provenance[0].quote_or_locus.length,
      source_text_sha256: sha256Hex(sourceText),
    };

    const write = async (
      path: string,
      id: string,
      span: typeof source_span,
    ): Promise<void> => {
      await mkdir(join(root, "proposals/effect"), { recursive: true });
      const spanned = [{ ...provenance[0], source_span: span }];
      const body = {
        ...(envelope("effect", id, "LA-01", {
          id,
          mechanism_id: "LA-01",
          name: "Spanned test effect",
          fact: "A grounded fixture phenomenon.",
          grade: "A",
          source: ["10.2307/1914185"],
          boundary: "Only a transaction fixture.",
          realization_ids: [],
          provenance: spanned,
        }) as Record<string, unknown>),
        // The envelope and the payload must agree exactly, span included.
        provenance: spanned,
      };
      await writeFile(join(root, path), `${JSON.stringify(body, null, 2)}\n`, "utf8");
    };

    const proposalPath = "proposals/effect/spanned-effect.json";
    await write(proposalPath, "spanned-effect", source_span);
    const transaction = await prepareProposalDecision(
      new LocalRepositorySnapshot(root),
      {
        proposalPath,
        action: "approve",
        decidedBy: "test-owner",
        decidedAt,
        schemaRoot: root,
      },
    );
    await applyLocalTransaction(root, transaction);
    const effect = JSON.parse(
      await readFile(join(root, "effects/LA-01/spanned-effect.json"), "utf8"),
    ) as { provenance: { source_span?: typeof source_span }[] };
    // 2.1: the authoritative record stays independently verifiable on its own.
    assert.deepEqual(effect.provenance[0].source_span, source_span);

    // A span resolved against different text must not reach an authoritative
    // record: approval re-grounds, and the hash is what catches it.
    const stalePath = "proposals/effect/stale-effect.json";
    await write(stalePath, "stale-effect", {
      ...source_span,
      source_text_sha256: sha256Hex("other"),
    });
    await assert.rejects(
      prepareProposalDecision(new LocalRepositorySnapshot(root), {
        proposalPath: stalePath,
        action: "approve",
        decidedBy: "test-owner",
        decidedAt,
        schemaRoot: root,
      }),
      /span_stale/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extraction authorship is a structural fact, not a naming convention", () => {
  assert.equal(isExtractionAuthored("extraction:github-actions-1234"), true);
  assert.equal(isExtractionAuthored("extraction:local-2026-07-31T00:00:00.000Z"), true);
  // Everything hand-authored or owner-assisted stays legacy, so its provenance
  // may be spanless without failing validation (D-110 amendment 2.2).
  assert.equal(isExtractionAuthored("igor"), false);
  assert.equal(isExtractionAuthored("owner-observation"), false);
  assert.equal(isExtractionAuthored(""), false);
  // The old unprefixed extractor ids must NOT read as extraction-authored:
  // their proposals predate spans and would otherwise fail retroactively.
  assert.equal(isExtractionAuthored("github-actions-1234"), false);
});

test("prepares one atomic batch with one enumerated decision entry", async () => {
  const root = await temporaryRepository();
  const paths = [
    "proposals/dossier_section/batch-one.json",
    "proposals/dossier_section/batch-two.json",
  ];
  try {
    await mkdir(join(root, "proposals/dossier_section"), { recursive: true });
    await writeFile(
      join(root, paths[0]),
      `${JSON.stringify(envelope("dossier_section", "batch-one", "LA-01", {
        field: "notes",
        value: "Batch fixture one",
      }), null, 2)}\n`,
    );
    await writeFile(
      join(root, paths[1]),
      `${JSON.stringify(envelope("dossier_section", "batch-two", "ST-09", {
        field: "notes",
        value: "Batch fixture two",
      }), null, 2)}\n`,
    );
    const transaction = await prepareBatchProposalDecision(
      new LocalRepositorySnapshot(root),
      {
        proposalPaths: paths,
        action: "approve",
        decidedBy: "test-owner",
        decidedAt,
        schemaRoot: root,
      },
    );
    assert.deepEqual(transaction.proposalIds, ["batch-one", "batch-two"]);
    assert.match(transaction.commitMessage, /batch-one: approved/);
    assert.match(transaction.commitMessage, /batch-two: approved/);
    const decisionsMutation = transaction.mutations.find(
      (mutation) => mutation.path === "decisions/decisions.json",
    );
    assert(decisionsMutation?.content);
    const decisions = JSON.parse(decisionsMutation.content) as {
      decisions: { id: string; body: string }[];
    };
    const entry = decisions.decisions.at(-1);
    assert.equal(entry?.id, transaction.decisionId);
    assert.match(entry?.body ?? "", /batch-one: approved/);
    assert.match(entry?.body ?? "", /batch-two: approved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dossier + mechanism batch populates a seed candidate atomically (D-085)", async () => {
  const root = await temporaryRepository();
  const doi = "10.1037/0003-066X.55.1.68";
  const title =
    "Self-determination theory and the facilitation of intrinsic motivation, social development, and well-being";
  const abstract =
    "Perceived competence and autonomy support sustain intrinsic motivation across settings, while controlling contexts undermine it.";
  const record = {
    record_id: deriveCorpusRecordId({ doi, title, year: 2000 }),
    title,
    abstract,
    doi,
    authors: ["Deci", "Ryan"],
    year: 2000,
    venue: "American Psychologist",
    citations: 30000,
    categories: [],
  };
  const co19Provenance = [
    {
      mechanism_id: "CO-19",
      corpus_record_id: record.record_id,
      doi,
      title,
      quote_or_locus: "Perceived competence and autonomy support sustain intrinsic motivation",
    },
  ];
  const scoredAxis = (score: number) => ({
    score,
    rationale: "Grounded fixture rationale arguing from the cited abstract.",
    provenance: co19Provenance,
  });
  const dossierPayload = {
    id: "DOS-CO-19",
    mechanism_id: "CO-19",
    scores: {
      evidence: scoredAxis(3),
      product_applicability: scoredAxis(2),
      measurability: scoredAxis(2),
      orthogonality: scoredAxis(2),
      safety: scoredAxis(2),
    },
    core_condition: "A measured lift in task completion after competence-signalling changes.",
    dissent: "Controlling contexts undermine intrinsic motivation; overuse backfires.",
    evidence_sources: [{ ref: title, doi }],
  };
  const mechanismPayload = {
    id: "CO-19",
    slug: "competence_mastery",
    name: "Competence & mastery",
    version: "1.0.0",
    level: "L1",
    parent: "S8",
    lifecycle_status: "candidate",
    dossier_ref: "dossiers/CO-19.json",
    provenance: { proposed_by: "derivation-pipeline", date: "2026-07-23" },
    evidence: {
      grade: "B+",
      basis: "Fixture basis grounded in SDT literature.",
      effect_size_note: "Moderate effects in studied contexts.",
      caveats: ["fixture_caveat"],
    },
    prior_weight: 0.7,
    mechanism_summary_for_context:
      "Users persist when interfaces make growing capability visible and abandon flows that make them feel incompetent.",
    applicability: {
      funnel_stages: ["onboarding", "retention"],
      excluded_stages: [],
      artifact_types: ["onboarding", "dashboard_widget"],
      preconditions: [],
      culture_note: "",
    },
    implementations: [
      {
        id: "CO-19-visible-skill-progress",
        artifact_types: ["dashboard_widget"],
        product_requirements: [],
        generation_directive: "Show the user their growing capability explicitly.",
        copy_formulas: [],
        metrics: ["task_completion_rate"],
        observed_effects: [],
      },
    ],
    constraints: {
      hard_rules: [
        {
          id: "no_fake_mastery",
          rule: "Never fabricate skill progress.",
          severity: "block",
        },
      ],
      compliance_refs: [],
      boundary_test: "Does the interface reflect real capability growth?",
    },
    relations: [],
    telemetry: {
      tag_format: "me:CO-19:{implementation_id}",
      amplitude_event_property: "mechanism_tags",
    },
  };
  const dossierPath = "proposals/dossier/co-19-dossier-draft.json";
  const mechanismPath = "proposals/mechanism/co-19-record-draft.json";
  try {
    await writeFile(
      join(root, "corpora/evidence/CO-19.json"),
      `${JSON.stringify({ mechanism_id: "CO-19", records: [record] }, null, 2)}\n`,
    );
    await mkdir(join(root, "proposals/dossier"), { recursive: true });
    await mkdir(join(root, "proposals/mechanism"), { recursive: true });
    const dossierProposal = {
      ...(envelope("dossier", "co-19-dossier-draft", "CO-19", dossierPayload) as Record<
        string,
        unknown
      >),
      provenance: co19Provenance,
    };
    const mechanismProposal = {
      ...(envelope("mechanism", "co-19-record-draft", "CO-19", mechanismPayload) as Record<
        string,
        unknown
      >),
      provenance: co19Provenance,
    };
    await writeFile(
      join(root, dossierPath),
      `${JSON.stringify(dossierProposal, null, 2)}\n`,
    );
    await writeFile(
      join(root, mechanismPath),
      `${JSON.stringify(mechanismProposal, null, 2)}\n`,
    );
    const transaction = await prepareBatchProposalDecision(
      new LocalRepositorySnapshot(root),
      {
        proposalPaths: [mechanismPath, dossierPath],
        action: "approve",
        decidedBy: "test-owner",
        decidedAt,
        schemaRoot: root,
      },
    );
    const byPath = new Map(
      transaction.mutations.map((mutation) => [mutation.path, mutation]),
    );
    const dossier = JSON.parse(byPath.get("dossiers/CO-19.json")!.content!) as {
      total: number;
      verdict: string;
      decided_by: string;
      date: string;
      scores: Record<string, { score: number }>;
    };
    // total 11, evidence 3, safety 2 → incubating; stamped from the decision.
    assert.equal(dossier.total, 11);
    assert.equal(dossier.verdict, "incubating");
    assert.equal(dossier.decided_by, "test-owner");
    assert.equal(dossier.date, decidedAt.slice(0, 10));
    const mechanism = JSON.parse(
      byPath.get("registry/mechanisms/CO-19.json")!.content!,
    ) as Mechanism;
    // lifecycle derives from the dossier verdict applied earlier in the batch,
    // not from the drafted "candidate".
    assert.equal(mechanism.lifecycle_status, "incubating");
    // The seed stub is deleted in the same atomic transaction.
    assert.equal(byPath.get("registry/mechanisms/_seed/CO-19.json")?.content, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dossier draft with an unscored axis blocks approval until the owner edits it", async () => {
  const doi = "10.2307/1914185";
  const payload = {
    id: "DOS-AU-20",
    mechanism_id: "AU-20",
    scores: {
      evidence: {
        score: 3,
        rationale: "Grounded fixture rationale.",
        provenance,
      },
      product_applicability: { score: null, rationale: null, provenance: [] },
      measurability: { score: 2, rationale: "Grounded fixture rationale.", provenance },
      orthogonality: { score: 2, rationale: "Grounded fixture rationale.", provenance },
      safety: { score: 2, rationale: "Grounded fixture rationale.", provenance },
    },
    core_condition: "Fixture measured condition.",
    dissent: "Fixture counter-evidence.",
    evidence_sources: [{ ref: "Prospect Theory", doi }],
  };
  await assert.rejects(
    prepare("dossier", "au-20-dossier-unscored", "AU-20", payload),
    /Unscored axis \(owner judgement required\): product_applicability/,
  );
});

test("invalid batch returns per-item reports and no transaction", async () => {
  const root = await temporaryRepository();
  const validPath = "proposals/dossier_section/batch-valid.json";
  const invalidPath = "proposals/dossier_section/batch-invalid.json";
  try {
    await mkdir(join(root, "proposals/dossier_section"), { recursive: true });
    await writeFile(
      join(root, validPath),
      `${JSON.stringify(envelope("dossier_section", "batch-valid", "LA-01", {
        field: "notes",
        value: "Valid",
      }), null, 2)}\n`,
    );
    await writeFile(
      join(root, invalidPath),
      `${JSON.stringify(envelope("dossier_section", "batch-invalid", "LA-01", {
        field: "not_a_dossier_field",
        value: "Invalid",
      }), null, 2)}\n`,
    );
    await assert.rejects(
      prepareBatchProposalDecision(new LocalRepositorySnapshot(root), {
        proposalPaths: [validPath, invalidPath],
        action: "approve",
        decidedBy: "test-owner",
        decidedAt,
        schemaRoot: root,
      }),
      (error: unknown) => {
        assert(error instanceof BatchProposalValidationError);
        assert.equal(error.reports.length, 2);
        assert(error.reports.some((report) => report.outcome === "invalid"));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects empty provenance before preparing any write", async () => {
  const path = "proposals/effect/empty-provenance.json";
  const proposal = envelope("effect", "empty-provenance", "LA-01", {
    id: "empty-provenance",
    mechanism_id: "LA-01",
    name: "Invalid effect",
    fact: "This must never land.",
    grade: "A",
    source: ["10.2307/1914185"],
    boundary: "Invalid fixture.",
    realization_ids: [],
    provenance: [],
  }) as Record<string, unknown>;
  proposal.provenance = [];
  await assert.rejects(
    prepareProposalDecision(new FixtureSnapshot(path, proposal), {
      proposalPath: path,
      action: "approve",
      decidedBy: "test-owner",
      decidedAt,
      schemaRoot: ROOT,
    }),
    /must NOT have fewer than 1 items|provenance must not be empty/i,
  );
});

test("held low-confidence proposals are visible state but never actionable", () => {
  const held = {
    ...(envelope("effect", "held-effect", "LA-01", {
      id: "held-effect",
      mechanism_id: "LA-01",
      name: "Held effect",
      fact: "Held fact",
      grade: "B",
      source: ["10.2307/1914185"],
      boundary: "Held boundary",
      realization_ids: [],
      provenance,
    }) as Proposal),
    status: "held_low_confidence",
    hold_reason: "below_confidence_floor",
  } as Proposal;
  assert.equal(isActionableProposal(held), false);
});

test("owner-assisted manual observation writes corpus only and performs no fetch", async () => {
  const transaction = await prepareOwnerObservationTransaction(
    new FixtureSnapshot("unused", {}),
    {
      mechanismId: "CL-14",
      sourceId: "mobbin",
      sourceUrl: "https://mobbin.com/library/example",
      sourceLocator: "fixture paywall screen",
      observation:
        "A single primary action is shown below three plan choices in the fixture screen.",
      artifactContext: ["paywall"],
      observedAt: "2026-07-21",
      contributedBy: "test-owner",
      submittedAt: "2026-07-21T18:00:00.000Z",
      attested: true,
      schemaRoot: ROOT,
    },
  );
  assert.match(transaction.recordId, /^rr_[a-f0-9]{24}$/);
  assert.deepEqual(
    transaction.mutations.map((mutation) => mutation.path),
    [
      "corpora/realizations/CL-14/records.json",
      "corpora/realizations/manifest.json",
    ],
  );
  const corpusMutation = transaction.mutations.find((mutation) =>
    mutation.path.endsWith("/records.json"),
  );
  assert(corpusMutation?.content);
  const corpus = JSON.parse(corpusMutation.content) as {
    records: { origin: string; source_id: string; contributed_by: string }[];
  };
  assert.equal(corpus.records.at(-1)?.origin, "owner");
  assert.equal(corpus.records.at(-1)?.source_id, "mobbin");
  assert.equal(corpus.records.at(-1)?.contributed_by, "test-owner");
});

test("owner-assisted ingest rejects API sources", async () => {
  await assert.rejects(
    prepareOwnerObservationTransaction(new FixtureSnapshot("unused", {}), {
      mechanismId: "ZE-07",
      sourceId: "wayback-cdx",
      sourceUrl: "https://web.archive.org/example",
      sourceLocator: "fixture",
      observation: "Fixture observation.",
      artifactContext: ["landing_hero"],
      observedAt: "2026-07-21",
      contributedBy: "test-owner",
      submittedAt: "2026-07-21T18:00:00.000Z",
      attested: true,
      schemaRoot: ROOT,
    }),
    /requires a manual source/,
  );
});

test("rejection requires a reason and never mutates an artifact", async () => {
  const mechanism = JSON.parse(
    await readFile(join(ROOT, "registry/mechanisms/LA-01.json"), "utf8"),
  ) as Mechanism;
  const transaction = await prepare(
    "mechanism",
    "reject-mechanism-proposal",
    "LA-01",
    mechanism,
    "reject",
  );
  assert.deepEqual(
    transaction.mutations.map((mutation) => mutation.path),
    ["decisions/decisions.json", "proposals/mechanism/reject-mechanism-proposal.json"],
  );
});

test("applied rejection records the reason and leaves artifacts untouched", async () => {
  const root = await temporaryRepository();
  const proposalPath = "proposals/mechanism/rejected-fixture.json";
  try {
    const mechanismText = await readFile(
      join(root, "registry/mechanisms/LA-01.json"),
      "utf8",
    );
    const proposal = envelope(
      "mechanism",
      "rejected-fixture",
      "LA-01",
      JSON.parse(mechanismText) as unknown,
    );
    await mkdir(join(root, "proposals/mechanism"), { recursive: true });
    await writeFile(
      join(root, proposalPath),
      `${JSON.stringify(proposal, null, 2)}\n`,
      "utf8",
    );
    const transaction = await prepareProposalDecision(
      new LocalRepositorySnapshot(root),
      {
        proposalPath,
        action: "reject",
        decidedBy: "test-owner",
        decidedAt,
        reason: "The cited locus does not support the claim.",
        schemaRoot: root,
      },
    );
    await applyLocalTransaction(root, transaction);
    assert.equal(
      await readFile(join(root, "registry/mechanisms/LA-01.json"), "utf8"),
      mechanismText,
    );
    const decided = JSON.parse(await readFile(join(root, proposalPath), "utf8")) as {
      status: string;
      decision_note: string;
    };
    assert.equal(decided.status, "rejected");
    assert.equal(decided.decision_note, "The cited locus does not support the claim.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an owner reason survives an edit and the approval that follows it", async () => {
  const root = await temporaryRepository();
  const proposalPath = "proposals/effect/regraded-effect.json";
  const basis =
    "Provisional grade. Corpus evidence = one secondary source. " +
    "Model-asserted A rejected as ungrounded.";
  const payload = {
    id: "regraded-effect",
    mechanism_id: "LA-01",
    name: "Regraded test effect",
    fact: "A grounded fixture phenomenon.",
    grade: "A",
    source: ["10.2307/1914185"],
    boundary: "Only a transaction fixture.",
    realization_ids: [],
    provenance,
  };
  try {
    await mkdir(join(root, "proposals/effect"), { recursive: true });
    await writeFile(
      join(root, proposalPath),
      `${JSON.stringify(envelope("effect", "regraded-effect", "LA-01", payload), null, 2)}\n`,
      "utf8",
    );

    const edit = await prepareProposalDecision(new LocalRepositorySnapshot(root), {
      proposalPath,
      action: "edit",
      decidedBy: "test-owner",
      decidedAt,
      reason: basis,
      editedPayload: { ...payload, grade: "C+", grade_basis: basis },
      schemaRoot: root,
    });
    await applyLocalTransaction(root, edit);

    const edited = JSON.parse(await readFile(join(root, proposalPath), "utf8")) as {
      status: string;
      decided_by: string | null;
      decision_note: string | null;
      payload: { grade: string; grade_basis: string };
    };
    assert.equal(edited.status, "edited");
    // Nobody has decided yet, but the reason for the change is recorded.
    assert.equal(edited.decided_by, null);
    assert.equal(edited.decision_note, basis);
    assert.equal(edited.payload.grade, "C+");
    assert.equal(edited.payload.grade_basis, basis);

    const approval = await prepareProposalDecision(new LocalRepositorySnapshot(root), {
      proposalPath,
      action: "approve",
      decidedBy: "test-owner",
      decidedAt,
      reason: basis,
      schemaRoot: root,
    });
    await applyLocalTransaction(root, approval);

    const decisions = JSON.parse(
      await readFile(join(root, "decisions/decisions.json"), "utf8"),
    ) as { decisions: { id: string; body: string }[] };
    const [editDecision, approvalDecision] = decisions.decisions.slice(-2);
    assert.equal(editDecision.id, edit.decisionId);
    assert.equal(approvalDecision.id, approval.decisionId);
    for (const decision of [editDecision, approvalDecision]) {
      assert(decision.body.includes(`Reason: ${basis}`));
    }

    const effect = JSON.parse(
      await readFile(join(root, "effects/LA-01/regraded-effect.json"), "utf8"),
    ) as { grade: string; grade_basis: string };
    assert.equal(effect.grade, "C+");
    assert.equal(effect.grade_basis, basis);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local adapter applies writes/deletes and rejects stale preconditions", async () => {
  const root = await mkdtemp(join(tmpdir(), "proposal-transaction-"));
  try {
    await mkdir(join(root, "data"));
    await writeFile(join(root, "data/existing.txt"), "before", "utf8");
    await writeFile(join(root, "data/delete.txt"), "remove", "utf8");
    await applyLocalTransaction(root, [
      {
        path: "data/existing.txt",
        expectedContent: "before",
        content: "after",
      },
      {
        path: "data/delete.txt",
        expectedContent: "remove",
        content: null,
      },
      {
        path: "nested/new.txt",
        expectedContent: null,
        content: "new",
      },
    ]);
    assert.equal(await readFile(join(root, "data/existing.txt"), "utf8"), "after");
    await assert.rejects(readFile(join(root, "data/delete.txt"), "utf8"), {
      code: "ENOENT",
    });
    assert.equal(await readFile(join(root, "nested/new.txt"), "utf8"), "new");
    await assert.rejects(
      applyLocalTransaction(root, [
        {
          path: "data/existing.txt",
          expectedContent: "before",
          content: "stale-write",
        },
      ]),
      FileTransactionConflictError,
    );
    assert.equal(await readFile(join(root, "data/existing.txt"), "utf8"), "after");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local adapter rolls back earlier paths when a later write fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "proposal-rollback-"));
  try {
    await writeFile(join(root, "first.txt"), "before", "utf8");
    await writeFile(join(root, "blocked"), "not-a-directory", "utf8");
    await assert.rejects(
      applyLocalTransaction(root, [
        {
          path: "first.txt",
          expectedContent: "before",
          content: "after",
        },
        {
          path: "blocked/second.txt",
          expectedContent: null,
          content: "never-written",
        },
      ]),
    );
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "before");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git Data adapter commits writes and deletes with one ref update", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ url, method, body });
    if (url.includes("/git/ref/heads/main")) {
      return Response.json({ object: { sha: "head-sha" } });
    }
    if (url.includes("/contents/data/write.json")) {
      return Response.json({
        sha: "old-write-blob",
        content: Buffer.from("before").toString("base64"),
      });
    }
    if (url.includes("/contents/data/delete.json")) {
      return Response.json({
        sha: "old-delete-blob",
        content: Buffer.from("remove").toString("base64"),
      });
    }
    if (url.endsWith("/git/commits/head-sha")) {
      return Response.json({ tree: { sha: "base-tree" } });
    }
    if (url.endsWith("/git/blobs")) return Response.json({ sha: "new-blob" });
    if (url.endsWith("/git/trees")) return Response.json({ sha: "new-tree" });
    if (url.endsWith("/git/commits")) return Response.json({ sha: "new-commit" });
    if (url.includes("/git/refs/heads/main")) {
      return Response.json({ object: { sha: "new-commit" } });
    }
    return new Response("unexpected request", { status: 500 });
  };
  try {
    const env: GithubOpsEnv = {
      token: "test-token",
      owner: "owner",
      repo: "repo",
      branch: "main",
    };
    const result = await commitGitDataTransaction(env, {
      message: "data: test transaction",
      mutations: [
        {
          path: "data/write.json",
          expectedContent: "before",
          content: "after",
        },
        {
          path: "data/delete.json",
          expectedContent: "remove",
          content: null,
        },
      ],
    });
    assert.equal(result.commitSha, "new-commit");
    const treeRequest = requests.find(
      (request) => request.method === "POST" && request.url.endsWith("/git/trees"),
    );
    assert.deepEqual(treeRequest?.body, {
      base_tree: "base-tree",
      tree: [
        { path: "data/write.json", mode: "100644", type: "blob", sha: "new-blob" },
        { path: "data/delete.json", mode: "100644", type: "blob", sha: null },
      ],
    });
    assert.equal(
      requests.filter(
        (request) =>
          request.method === "PATCH" && request.url.includes("/git/refs/heads/main"),
      ).length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

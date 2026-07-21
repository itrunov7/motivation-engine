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
import {
  BatchProposalValidationError,
  isActionableProposal,
  prepareBatchProposalDecision,
  prepareProposalDecision,
  type RepositorySnapshot,
} from "./proposals";
import type { Mechanism, Proposal, ProposalType, SegmentsFile } from "./types";

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

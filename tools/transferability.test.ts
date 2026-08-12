/**
 * tools/transferability.test.ts — measure the rules against the owner's own
 * verdicts, and hold the fail-open contract (D-160).
 *
 * The important thing this file does NOT do: assert agreement. The owner's nine
 * CL-14 verdicts are a frozen table here, replayed against the ruleset, and the
 * agreement rate is PRINTED rather than required. A test that failed on
 * disagreement would make "edit the lexicon until the test passes" the obvious
 * fix, which is how a measuring instrument turns into a mirror. A disagreement
 * may mean the rules are wrong; it may equally mean a verdict was. Either way
 * it should be visible and argued, not silently engineered away.
 *
 * What it does assert: determinism, table completeness, and the invariants that
 * make a refusal recoverable — every check reports a reason, refusals name a
 * failing check, and a warning on its own never refuses.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type {
  ExtractionOpsConfig,
  Proposal,
  VariableJudgement,
} from "../lib/types";
import { TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS } from "../lib/types";
import { judgeVariableViaModel, type Usage } from "./extract";
import { PROBE_RUN_MODE } from "./connectors/types";
import {
  buildVariablePrompt,
  describeTransferability,
  judgeTransferability,
  judgeTransferabilityV2,
  judgeTransferabilityV3,
  parseVariableJudgement,
  replayTransferability,
  transferabilityClaimOfProposal,
  variableCheckFromJudgement,
  type TransferabilityClaim,
  TRANSFERABILITY_RULESET_VERSION,
  TRANSFERABILITY_RULESET_VERSION_V2,
} from "../lib/transferability";

const ROOT = join(__dirname, "..");

/**
 * The owner's CL-14 verdicts of 3 August 2026, delegated and applied as
 * D-149..D-158. `transferable` is what the OWNER decided, not what the rules
 * say. Ten rows for nine verdicts: the second VST proposal was decided under
 * the same delegated rule as the first (Q1-B), so it belongs in the table it
 * was judged by.
 *
 * The four Figshare proposals rejected as DOMAIN_CONTAMINATION are absent
 * except for Memory Drift itself. Their rejection was a judgement about the
 * SOURCE — a self-published, non-peer-reviewed essay collection — which these
 * rules never see and are not meant to make. Scoring them here would credit or
 * blame the rules for a call they had no input to.
 */
const OWNER_VERDICTS: readonly {
  id: string;
  transferable: boolean;
  why: string;
}[] = [
  {
    id: "effect-cl-14-chromatic-asymmetry-in-visual-attent-86a450d258a0",
    transferable: true,
    why: "surface legibility — background colour is a setting any interface has",
  },
  {
    id: "effect-cl-14-tracing-and-pointing-5a8b0827979f",
    transferable: true,
    why: "touch interfaces — tracing and pointing are gestures a surface can invite",
  },
  {
    id: "effect-cl-14-imagination-effect-ae9f5dd80f99",
    transferable: true,
    why: "onboarding layout — integrated versus split presentation is a layout decision",
  },
  {
    id: "effect-cl-14-germane-cognitive-load-mediation-f5be8b0e7ecc",
    transferable: false,
    why: "NOT_TRANSFERABLE — locked to financial accounting coursework",
  },
  {
    id: "effect-cl-14-extraneous-cognitive-load-suppressio-3daae68fd700",
    transferable: false,
    why: "NOT_TRANSFERABLE — same accounting source, same defect",
  },
  {
    id: "effect-cl-14-xai-scaffolding-effect-on-cognitive--c6d5fa7f0090",
    transferable: false,
    why: "NOT_TRANSFERABLE — multilingual Bel Canto pedagogy",
  },
  {
    id: "effect-cl-14-wsi-induced-cognitive-load-reduction-d72fd5713373",
    transferable: false,
    why: "NOT_TRANSFERABLE — whole-slide imaging versus photomicrographs",
  },
  {
    id: "effect-cl-14-semiotic-informed-digital-health-int-6ae57678db7f",
    transferable: false,
    why: "NOT_TRANSFERABLE — a framework, not a variable",
  },
  {
    id: "effect-cl-14-attention-tunneling-3b701385074a",
    transferable: false,
    why: "NOT_TRANSFERABLE — a symptom with no intervention",
  },
  {
    id: "effect-cl-14-memory-drift-7e627a94664c",
    transferable: false,
    why: "DOMAIN_CONTAMINATION — the subject is a machine memory store",
  },
];

/**
 * Documented false refusals (owner, 5 August 2026). These are the one thing this
 * file otherwise refuses to do — asserted agreement — and they are asserted on
 * purpose: any ruleset that refuses either of them fails this suite.
 *
 * They are NOT an exemption list. Nothing here waves a record past the filter or
 * teaches the filter to recognise these two ids. They are a standing bug report
 * with a failing test attached. When this goes red the required action is to
 * REPAIR THE FILTER so it names the lever it is currently blind to — never to add
 * the record to an allowlist. An allowlist grows forever and buries the defect; a
 * fixture forces the repair and dissolves the moment the filter is right.
 *
 * Why these two are false refusals rather than owner taste:
 *  - Expertise reversal (cl-14-002) already carries an APPROVED realization — the
 *    expertise-based guidance toggle, edited and accepted under D-118/D-119.
 *    Refusing the effect as "names nothing an interface can change" contradicts a
 *    decision already in the log: the interface built on it is in the registry.
 *  - Dialogue versus single-speaker TTS is a MODALITY decision — how many voices
 *    carry the lesson — which is exactly the lever class VARIABLE claims to cover
 *    and which its cognitive-load-derived lexicon happens to have no word for.
 *
 * This is a deliberate, narrow exception to the "never assert agreement" contract
 * at the top of this file. Narrow is the point: two named records with recorded,
 * decision-grounded reasons, not a rate to chase. If a future extraction run holds
 * either of them, that is acceptable — a hold is reversible, and this test keeps
 * the false refusal visible until the filter names the lever it is missing.
 *
 * Since D-162 VARIABLE is a model judgement, so this cannot be checked by calling
 * the judge offline — the offline path is v1, which will always refuse these two.
 * The green signal is therefore the STORED v2 verdict a real strong-tier run
 * writes onto the proposal: transferable, with the VARIABLE check naming a lever.
 * Until such a run exists the test is red because there is no verdict to read;
 * once it does, the fixture dissolves; and if a run ever refuses them, the stored
 * verdict is red and the false refusal is visible again — exactly as intended.
 */
const DOCUMENTED_FALSE_REFUSALS: readonly {
  id: string;
  why: string;
  missing_lever: string;
}[] = [
  {
    id: "effect-cl-14-expertise-reversal-effect-72a394e20f30",
    why: "an approved realization (expertise-based guidance toggle, D-119) is built on this effect; refusing it as non-actionable contradicts a decision already in the log",
    missing_lever:
      "expertise-conditioned guidance — showing or withdrawing worked steps by the learner's prior familiarity",
  },
  {
    id: "effect-cl-14-dialogue-based-tts-lesson-format-6344b7e060e8",
    why: "dialogue versus single-speaker is a modality choice the VARIABLE lexicon has no term for",
    missing_lever:
      "speaker configuration — a single narrating voice versus a dialogue between two",
  },
];

function loadProposal(id: string): Proposal {
  return JSON.parse(
    readFileSync(join(ROOT, "proposals", "effect", `${id}.json`), "utf8"),
  ) as Proposal;
}

test("the ruleset agrees with the owner's CL-14 verdicts at a rate it reports rather than asserts", () => {
  let agreed = 0;
  let agreedWithoutEscalation = 0;
  const disagreements: string[] = [];
  const disagreementsWithoutEscalation: string[] = [];

  console.log(
    `\nTransferability ruleset v${TRANSFERABILITY_RULESET_VERSION} against ${OWNER_VERDICTS.length} owner verdicts:\n`,
  );

  for (const row of OWNER_VERDICTS) {
    const proposal = loadProposal(row.id);
    const claim = transferabilityClaimOfProposal(proposal);
    assert.ok(claim, `${row.id} must be a judgeable claim`);
    const verdict = judgeTransferability(claim);

    // The same verdict without the one rule the owner did not specify: the
    // subject+population pair. Measured separately so its contribution is a
    // number rather than a belief.
    const withoutEscalation = verdict.escalated_by_warning_pair
      ? true
      : verdict.transferable;

    if (verdict.transferable === row.transferable) agreed += 1;
    else {
      disagreements.push(
        `  ${row.id}\n` +
          `    owner: ${row.transferable ? "accept" : "reject"} — ${row.why}\n` +
          `    rules: ${describeTransferability(verdict)}\n` +
          verdict.checks
            .map((check) => `      ${check.outcome.padEnd(4)} ${check.check.padEnd(10)} ${check.reason}`)
            .join("\n"),
      );
    }

    if (withoutEscalation === row.transferable) agreedWithoutEscalation += 1;
    else {
      disagreementsWithoutEscalation.push(
        `  ${row.id}: owner ${row.transferable ? "accept" : "reject"}, ` +
          `rules ${withoutEscalation ? "transferable" : "not transferable"} ` +
          "(escalation disabled)",
      );
    }

    console.log(
      `  ${verdict.transferable === row.transferable ? "agree   " : "DISAGREE"}  ` +
        `${row.id}\n            ${describeTransferability(verdict)}` +
        `${verdict.escalated_by_warning_pair ? " [escalated]" : ""}`,
    );
  }

  const total = OWNER_VERDICTS.length;
  console.log(
    `\n  with the subject+population escalation:    ${agreed}/${total}` +
      ` (${Math.round((agreed / total) * 100)}%)`,
  );
  console.log(
    `  without it:                               ${agreedWithoutEscalation}/${total}` +
      ` (${Math.round((agreedWithoutEscalation / total) * 100)}%)`,
  );
  if (disagreements.length > 0) {
    console.log("\n  Disagreements (with escalation):");
    console.log(disagreements.join("\n"));
  }
  if (disagreementsWithoutEscalation.length > 0) {
    console.log("\n  Disagreements (escalation disabled):");
    console.log(disagreementsWithoutEscalation.join("\n"));
  }
  console.log("");

  // Asserted: the measurement ran over every row. NOT asserted: that it agreed.
  assert.equal(agreed + disagreements.length, total);
});

test("documented false refusals must be named transferable by the production filter — a refusal here is a filter bug, not an exemption", () => {
  for (const row of DOCUMENTED_FALSE_REFUSALS) {
    const proposal = loadProposal(row.id);
    const claim = transferabilityClaimOfProposal(proposal);
    assert.ok(claim, `${row.id} must be a judgeable effect claim`);
    const stored = proposal.transferability;
    const guidance =
      `\n${row.id} is a documented false refusal.\n` +
      `  why it should transfer: ${row.why}\n` +
      `  the lever the filter must name: ${row.missing_lever}\n` +
      `  Fix the filter (v${TRANSFERABILITY_RULESET_VERSION_V2} model VARIABLE / its prompt) so it names this lever.` +
      ` Do NOT add this id to an exemption list.`;

    // No verdict yet means the v1 word list held it and no v2 run has judged it.
    // Red on purpose: the model VARIABLE must run in a dispatched extraction and
    // write a verdict. Offline this can never go green, and it must not — a green
    // fixture with no evidence behind it would be the exemption we refuse to add.
    assert.ok(
      stored,
      `${row.id} carries no transferability verdict — ruleset v1 could not name` +
        ` its lever and no v${TRANSFERABILITY_RULESET_VERSION_V2} run has judged it yet.` +
        guidance,
    );
    assert.equal(
      stored!.transferable,
      true,
      `${row.id} was judged NOT transferable and held.\n` +
        `  the filter says: ${describeTransferability(stored!)}\n` +
        stored!.checks
          .map((check) => `      ${check.outcome.padEnd(4)} ${check.check.padEnd(10)} ${check.reason}`)
          .join("\n") +
        guidance,
    );
    const variable = stored!.checks.find((check) => check.check === "variable");
    assert.ok(
      variable &&
        typeof variable.identified_lever === "string" &&
        variable.identified_lever.trim().length > 0,
      `${row.id} was admitted but its VARIABLE check named no lever, so the` +
        ` reasoning is not auditable.` +
        guidance,
    );
  }
});

test("every check states a reason, whatever it decides", () => {
  for (const row of OWNER_VERDICTS) {
    const claim = transferabilityClaimOfProposal(loadProposal(row.id));
    assert.ok(claim);
    const verdict = judgeTransferability(claim);
    assert.equal(verdict.checks.length, 4, `${row.id} must answer all four checks`);
    for (const check of verdict.checks) {
      assert.ok(
        check.reason.trim().length > 0,
        `${row.id}: ${check.check} decided ${check.outcome} with no stated reason`,
      );
    }
  }
});

test("the same claim always produces the same verdict", () => {
  for (const row of OWNER_VERDICTS) {
    const claim = transferabilityClaimOfProposal(loadProposal(row.id));
    assert.ok(claim);
    assert.deepEqual(
      judgeTransferability(claim),
      judgeTransferability(claim),
      `${row.id} is not deterministic — an offline replay could not reproduce it`,
    );
  }
});

test("a refusal always names a failing check, or the warning pair that caused it", () => {
  for (const row of OWNER_VERDICTS) {
    const claim = transferabilityClaimOfProposal(loadProposal(row.id));
    assert.ok(claim);
    const verdict = judgeTransferability(claim);
    if (verdict.transferable) continue;
    const failed = verdict.checks.filter((check) => check.outcome === "fail");
    const warned = verdict.checks.filter((check) => check.outcome === "warn");
    assert.ok(
      failed.length > 0 || verdict.escalated_by_warning_pair,
      `${row.id} was refused with nothing to point at`,
    );
    if (verdict.escalated_by_warning_pair) {
      assert.equal(failed.length, 0);
      assert.ok(warned.length >= 2, "an escalation needs the pair it is named for");
    }
  }
});

test("one warning alone never refuses, and a variable or direction failure always does", () => {
  // Constructed claims, not repository ones: the scoring rule must hold for
  // shapes the queue happens not to contain today.
  const institutionalOnly = judgeTransferability({
    fact: "Placing the worked example beside the diagram lowers errors.",
    boundary: "Undergraduate classroom instruction.",
    source_title: "Layout and worked examples in the classroom",
  });
  assert.equal(
    institutionalOnly.checks.find((check) => check.check === "subject")?.outcome,
    "warn",
  );
  assert.equal(
    institutionalOnly.transferable,
    true,
    "a classroom finding about layout is a warning, not a refusal",
  );

  const noVariable = judgeTransferability({
    fact: "Higher intrinsic load lowers recall accuracy.",
    boundary: "Adults using a website.",
    source_title: "Load and recall",
  });
  assert.equal(noVariable.transferable, false);
  assert.equal(
    noVariable.checks.find((check) => check.check === "variable")?.outcome,
    "fail",
  );

  const noDirection = judgeTransferability({
    fact: "Split-attention is a phenomenon characterized by divided visual search.",
    boundary: "Adults using a website with diagrams.",
    source_title: "Split attention defined",
  });
  assert.equal(noDirection.transferable, false);
  assert.equal(
    noDirection.checks.find((check) => check.check === "direction")?.outcome,
    "fail",
  );
});

// ---------- ruleset v2: the model-backed VARIABLE (D-162) ----------

test("v2 feeds the model VARIABLE into the same scoring, keeping SUBJECT/DIRECTION/POPULATION deterministic", () => {
  const claim = transferabilityClaimOfProposal(loadProposal(OWNER_VERDICTS[0].id));
  assert.ok(claim);
  const lever = "count of other users who did X";
  const verdict = judgeTransferabilityV2(claim, {
    transferable: true,
    lever,
    reason: "a social count can be shown on any surface",
  });
  assert.equal(verdict.ruleset_version, TRANSFERABILITY_RULESET_VERSION_V2);
  assert.equal(verdict.checks.length, 4);
  const variable = verdict.checks.find((check) => check.check === "variable");
  assert.equal(variable?.outcome, "pass");
  assert.equal(variable?.identified_lever, lever);
  // The three deterministic checks must match what v1 computes for the same claim:
  // v2 changed only VARIABLE.
  const v1 = judgeTransferability(claim);
  for (const name of ["subject", "direction", "population"] as const) {
    assert.equal(
      verdict.checks.find((c) => c.check === name)?.outcome,
      v1.checks.find((c) => c.check === name)?.outcome,
      `${name} must be unchanged between v1 and v2`,
    );
  }
});

test("a non-transferable model judgement refuses on VARIABLE and carries no lever", () => {
  const claim = transferabilityClaimOfProposal(loadProposal(OWNER_VERDICTS[0].id));
  assert.ok(claim);
  const verdict = judgeTransferabilityV2(claim, {
    transferable: false,
    lever: null,
    reason: "a bare definition with nothing to show, hide, or time",
  });
  const variable = verdict.checks.find((check) => check.check === "variable");
  assert.equal(variable?.outcome, "fail");
  assert.equal(variable?.identified_lever, null);
  assert.equal(verdict.transferable, false);
});

test("variableCheckFromJudgement records the lever verbatim so the verdict is auditable", () => {
  const pass = variableCheckFromJudgement({
    transferable: true,
    lever: "countdown timer",
    reason: "urgency shown as a timer",
  });
  assert.equal(pass.outcome, "pass");
  assert.equal(pass.identified_lever, "countdown timer");
  assert.match(pass.reason, /countdown timer/);
});

test("parseVariableJudgement accepts clean answers, strips prose and fences, and rejects incoherent ones", () => {
  const clean = parseVariableJudgement(
    '{"transferable": true, "lever": "stock counter", "reason": "count shown on the surface"}',
  );
  assert.deepEqual(clean, {
    transferable: true,
    lever: "stock counter",
    reason: "count shown on the surface",
  });

  const fenced = parseVariableJudgement(
    'Sure! ```json\n{"transferable": false, "lever": null, "reason": "a market statistic"}\n``` done',
  );
  assert.deepEqual(fenced, {
    transferable: false,
    lever: null,
    reason: "a market statistic",
  });

  // A non-transferable verdict must never carry a lever, even if the model sends one.
  const strippedLever = parseVariableJudgement(
    '{"transferable": false, "lever": "should not be here", "reason": "no mechanism"}',
  );
  assert.equal(strippedLever?.lever, null);

  // Incoherent: transferable with no lever, or an empty/absent reason, or garbage.
  assert.equal(
    parseVariableJudgement('{"transferable": true, "lever": null, "reason": "x"}'),
    null,
  );
  assert.equal(
    parseVariableJudgement('{"transferable": true, "lever": "x", "reason": ""}'),
    null,
  );
  assert.equal(parseVariableJudgement("not json at all"), null);
});

test("replayTransferability audits a v2 verdict offline instead of re-calling the model, and catches tampering", () => {
  const claim = transferabilityClaimOfProposal(loadProposal(OWNER_VERDICTS[0].id));
  assert.ok(claim);
  const judgement: VariableJudgement = {
    transferable: true,
    lever: "count of other users who did X",
    reason: "a social count can be shown on any surface",
  };
  const stored = judgeTransferabilityV2(claim, judgement);

  // A faithful stored verdict replays clean without any model call.
  assert.equal(replayTransferability(stored, claim), null);

  // Flipping the verdict against its own checks is caught by the scoring audit.
  assert.ok(
    replayTransferability({ ...stored, transferable: false }, claim),
    "a verdict that disagrees with its own checks must not replay",
  );

  // Dropping the lever on a passing VARIABLE breaks auditability and is caught.
  const noLever = {
    ...stored,
    checks: stored.checks.map((check) =>
      check.check === "variable" ? { ...check, identified_lever: null } : check,
    ),
  };
  assert.ok(
    replayTransferability(noLever, claim),
    "a passing VARIABLE with no lever must not replay",
  );

  // Corrupting a deterministic check (which v2 DOES recompute) is caught.
  const brokenSubject = {
    ...stored,
    checks: stored.checks.map((check) =>
      check.check === "subject" ? { ...check, outcome: "fail" as const } : check,
    ),
  };
  assert.ok(
    replayTransferability(brokenSubject, claim),
    "drift in a deterministic check must still fail loud under v2",
  );
});

test("replayTransferability audits a v3 verdict and catches tampering with its scoring or modifiers", () => {
  const claim = transferabilityClaimOfProposal(loadProposal(OWNER_VERDICTS[0].id));
  assert.ok(claim);
  const judgement: VariableJudgement = {
    transferable: true,
    lever: "count of other users who did X",
    reason: "a social count can be shown on any surface",
  };
  const stored = judgeTransferabilityV3(claim, judgement);

  // The wiring this test exists to protect: before v3 was adopted,
  // replayTransferability returned "stored under unrecognised ruleset v3" and
  // tools/validate.ts turned that into a build failure, so any persisted v3
  // verdict would have failed validation forever.
  assert.equal(replayTransferability(stored, claim), null);

  // Under v3 the lever alone decides, so a verdict claiming to be refused while
  // VARIABLE passed disagrees with its own checks.
  assert.ok(
    replayTransferability({ ...stored, transferable: false }, claim),
    "a v3 verdict that disagrees with its own VARIABLE check must not replay",
  );

  // v3 has no escalation path at all, so a true here means something other than
  // scoreChecksV3 wrote the verdict.
  assert.ok(
    replayTransferability({ ...stored, escalated_by_warning_pair: true }, claim),
    "a v3 verdict cannot have escalated by a warning pair",
  );

  // Dropping a modifier would hide exactly the signal v3 was created to keep
  // visible on an admitted claim. Asserted on a claim that actually flags one:
  // this is the shape v3 exists for — a lever named, the claim admitted, and
  // the deterministic objections recorded instead of silently refusing it.
  // Under v2 this same claim was refused; the modifiers are what is left of
  // that refusal.
  const flagging: TransferabilityClaim = {
    fact:
      "The unfinishedness of events is spontaneously extracted and prioritized " +
      "in visual processing.",
    boundary: "Replicability has been challenged.",
    source_title: "A Visual Zeigarnik Effect",
  };
  const flagged = judgeTransferabilityV3(flagging, {
    transferable: true,
    lever: "show progress as an incomplete path",
    reason: "a progress indicator can render a path as unfinished",
  });
  assert.ok(flagged.transferable, "a named lever admits the claim under v3");
  assert.ok(
    (flagged.modifiers_flagged ?? []).length > 0,
    "this claim must flag at least one modifier or it cannot test them",
  );
  assert.equal(replayTransferability(flagged, flagging), null);
  assert.ok(
    replayTransferability({ ...flagged, modifiers_flagged: [] }, flagging),
    "modifiers_flagged must match the checks that did not pass",
  );

  // The deterministic checks are still recomputed and compared exactly, as
  // under v2 — v3 removed their power to refuse, not their auditability.
  const brokenSubject = {
    ...stored,
    checks: stored.checks.map((check) =>
      check.check === "subject" ? { ...check, outcome: "fail" as const } : check,
    ),
  };
  assert.ok(
    replayTransferability(brokenSubject, claim),
    "drift in a deterministic check must still fail loud under v3",
  );
});

test("buildVariablePrompt reads only the claim's three fields and asks for a lever or null", () => {
  const prompt = buildVariablePrompt({
    fact: "Scarcity cues increase impulse buying.",
    boundary: "E-commerce checkout.",
    source_title: "Scarcity and impulse buying",
  });
  assert.match(prompt, /fact: Scarcity cues increase impulse buying\./);
  assert.match(prompt, /boundary: E-commerce checkout\./);
  assert.match(prompt, /source_title: Scarcity and impulse buying/);
  assert.match(prompt, /lever/i);
  // It must not smuggle anything beyond the three judgeable fields.
  assert.doesNotMatch(prompt, /confidence|grade|corpus_record_id|doi/i);
});

/**
 * The fail-open path, which had no test at all (D-162 follow-up).
 *
 * `judgeVariableViaModel` used to return a bare null on all five of its failure
 * exits, and the caller expressed that as an ABSENT `transferability` field —
 * indistinguishable from a pre-D-160 proposal and from a non-effect proposal,
 * and counted nowhere. These tests pin each exit to its named reason, because
 * the counter is only worth having if the reasons are right: "the month's cap
 * is spent" and "the model is down" produce the same total and demand opposite
 * responses.
 *
 * Every case runs on a stub fetcher. Nothing here touches the network.
 */

const PROBE_CLAIM = {
  fact: "Framing an outcome as a loss increases the effort spent avoiding it.",
  boundary: "Consumer checkout flows.",
  source_title: "Loss aversion in choice",
};

function probeConfig(overrides: Record<string, unknown> = {}): ExtractionOpsConfig {
  return {
    version: "test",
    prices_verified_on: "2026-08-05",
    tiers: {
      cheap: {
        model_id: "test/cheap",
        response_format: "json_schema",
        input_usd_per_token: 0,
        output_usd_per_token: 0,
        max_tokens_per_call: 1000,
        supports: { temperature: true, structured_outputs: true },
      },
      strong: {
        model_id: "test/strong",
        response_format: "json_schema",
        input_usd_per_token: 0,
        output_usd_per_token: 0,
        max_tokens_per_call: 1000,
        supports: { temperature: false, structured_outputs: true },
      },
    },
    limits: {
      per_run_tokens: 500000,
      monthly_tokens: 3000000,
      records_per_batch: 25,
      confidence_floor: 0.5,
      duplicate_similarity: 0.78,
      max_proposals_per_mechanism: null,
    },
    ...overrides,
  } as ExtractionOpsConfig;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    calls: 0,
    byTier: {
      cheap: { input: 0, output: 0, calls: 0 },
      strong: { input: 0, output: 0, calls: 0 },
    },
  };
}

/** A stub fetcher returning a fixed body/status, counting the calls it received. */
function stubFetcher(
  responses: { status: number; body: unknown }[],
): { fetcher: typeof fetch; calls: () => number } {
  let index = 0;
  return {
    calls: () => index,
    fetcher: (async () => {
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.body,
        text: async () => JSON.stringify(next.body),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  };
}

function answer(content: string): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    },
  };
}

test("a judged claim returns ok with the model's judgement, and charges its tokens", async () => {
  const stub = stubFetcher([
    answer('{"transferable": true, "lever": "countdown timer", "reason": "a timer is an interface element"}'),
  ]);
  const usage = emptyUsage();
  const outcome = await judgeVariableViaModel(
    { config: probeConfig(), usage, fetcher: stub.fetcher },
    PROBE_CLAIM,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.judgement.lever, "countdown timer");
  assert.equal(usage.byTier.strong.calls, 1, "a successful call must be charged");
  assert.equal(usage.input, 120);
  assert.equal(usage.output, 30);
});

test("each fail-open exit returns its own named reason rather than a bare null", async () => {
  // no_model_id — the check could not be asked at all.
  const noModel = await judgeVariableViaModel(
    {
      config: probeConfig({
        tiers: {
          ...probeConfig().tiers,
          strong: { ...probeConfig().tiers.strong, model_id: "" },
        },
      }),
      usage: emptyUsage(),
      fetcher: stubFetcher([answer("{}")]).fetcher,
    },
    PROBE_CLAIM,
  );
  assert.equal(noModel.ok, false);
  assert.equal(!noModel.ok && noModel.reason, "no_model_id");

  // per_run_token_cap — the run's own budget is spent.
  const spent = emptyUsage();
  spent.input = 499_900;
  const capped = await judgeVariableViaModel(
    { config: probeConfig(), usage: spent, fetcher: stubFetcher([answer("{}")]).fetcher },
    PROBE_CLAIM,
  );
  assert.equal(capped.ok, false);
  assert.equal(!capped.ok && capped.reason, "per_run_token_cap");

  // transport_error — a non-retryable status.
  const dead = await judgeVariableViaModel(
    {
      config: probeConfig(),
      usage: emptyUsage(),
      fetcher: stubFetcher([{ status: 404, body: { error: "no endpoints found" } }]).fetcher,
    },
    PROBE_CLAIM,
  );
  assert.equal(dead.ok, false);
  assert.equal(!dead.ok && dead.reason, "transport_error");

  // malformed_answer — the model replied, and the reply was not a judgement.
  const garbage = await judgeVariableViaModel(
    {
      config: probeConfig(),
      usage: emptyUsage(),
      fetcher: stubFetcher([answer("I am not going to answer that.")]).fetcher,
    },
    PROBE_CLAIM,
  );
  assert.equal(garbage.ok, false);
  assert.equal(!garbage.ok && garbage.reason, "malformed_answer");
});

test("a retryable status is retried three times before it is called a transport error", async () => {
  const stub = stubFetcher([
    { status: 429, body: {} },
    { status: 429, body: {} },
    { status: 429, body: {} },
  ]);
  const outcome = await judgeVariableViaModel(
    { config: probeConfig(), usage: emptyUsage(), fetcher: stub.fetcher },
    PROBE_CLAIM,
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.reason, "transport_error");
  assert.equal(stub.calls(), 3, "429 must be retried, not abandoned on the first response");
});

test("a malformed answer still charges the tokens it burned — failing open is not free", async () => {
  const usage = emptyUsage();
  await judgeVariableViaModel(
    {
      config: probeConfig(),
      usage,
      fetcher: stubFetcher([answer("not a judgement")]).fetcher,
    },
    PROBE_CLAIM,
  );
  assert.equal(usage.byTier.strong.calls, 1);
  assert.equal(usage.input, 120, "spend is real whether or not the answer was usable");
});

test("every reason a fail-open can produce is a declared reason", async () => {
  // The counter and the schema enum are only trustworthy if the producer cannot
  // invent a reason outside the list. Checked against the exported tuple rather
  // than a copy of it, so adding a reason to one and not the other fails here.
  const produced = ["no_model_id", "per_run_token_cap", "transport_error", "malformed_answer"];
  for (const reason of produced) {
    assert.ok(
      (TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS as readonly string[]).includes(reason),
      `${reason} is produced by judgeVariableViaModel but is not a declared reason`,
    );
  }
  // monthly_token_cap is declared and reachable only against a real manifest,
  // so it is asserted as declared rather than exercised here.
  assert.ok(
    (TRANSFERABILITY_VERDICT_UNAVAILABLE_REASONS as readonly string[]).includes(
      "monthly_token_cap",
    ),
  );
});

test("the probe cannot write: its read-only claim is checked, not just stated", () => {
  // tools/transferability-report.ts has declared "no writes" in a comment since
  // it was written, and a comment is not a constraint. The probe spends real
  // money against real proposals, so its contract is asserted here against the
  // source: any write primitive appearing in it fails this test, and whoever
  // added it has to either remove it or change this contract deliberately.
  const source = readFileSync(join(ROOT, "tools/transferability-probe.ts"), "utf8");
  // D-164 opened exactly ONE write: the extraction manifest, so the monthly cap
  // can see what the probe spent. Everything else stays shut, and the opening is
  // pinned as narrowly as it was granted.
  const writePrimitives = [
    "appendFileSync",
    "mkdirSync",
    "rmSync",
    "unlinkSync",
    "renameSync",
    "createWriteStream",
  ];
  for (const primitive of writePrimitives) {
    assert.ok(
      !source.includes(primitive),
      `transferability-probe.ts must not write — found ${primitive}`,
    );
  }
  // TWO permitted writes, each pinned to its own named constant. The second was
  // opened deliberately, as this test requires: the probe captures the model's
  // answers so a scoring comparison can be re-derived by running a committed
  // script instead of hand-parsing an Actions log. A THIRD writeFileSync — or
  // either of these pointed somewhere else — is a new capability and has to be
  // argued for, not inherited from these.
  const writes = source.match(/writeFileSync\(/g) ?? [];
  assert.equal(writes.length, 2, "the probe writes exactly two files");
  assert.match(
    source,
    /writeFileSync\(\s*MANIFEST_FILE,/,
    "the probe's spend write must target the extraction manifest",
  );
  assert.match(
    source,
    /const MANIFEST_FILE = join\(ROOT, "corpora", "extraction", "manifest\.json"\)/,
    "MANIFEST_FILE must be the extraction manifest and nothing else",
  );
  assert.match(
    source,
    /writeFileSync\(\s*ANSWERS_FILE,/,
    "the probe's answers write must target the answers artifact",
  );
  assert.match(
    source,
    /const ANSWERS_FILE = join\(ROOT, "transferability-answers\.json"\)/,
    "ANSWERS_FILE must be the run artifact at the repo root and nothing else",
  );
  // The guarantee that actually matters, and the one the probe's whole standing
  // rests on: it does not touch the queue it is measuring. Neither destination
  // may point into proposals/, whatever else changes about them.
  for (const constant of ["MANIFEST_FILE", "ANSWERS_FILE"]) {
    const declaration = source.match(new RegExp(`const ${constant} = [^;]+;`))?.[0] ?? "";
    assert.ok(
      !declaration.includes('"proposals"'),
      `${constant} must never resolve inside proposals/`,
    );
  }
  // A run artifact, not a corpus record. If it were ever committed, one run's
  // snapshot would start reading as a source.
  assert.match(
    readFileSync(join(ROOT, ".gitignore"), "utf8"),
    /^\/transferability-answers\.json$/m,
    "the answers artifact must be gitignored",
  );
  // Off by default: the write happens only when the caller asks for it, so a
  // local probe stays the read-only measurement it has always been.
  assert.match(
    source,
    /const recordSpend = flag\("record-spend"\)/,
    "the manifest write must be gated behind an explicit flag",
  );
  // last_run is what the showcase reads to say what extraction last did. A probe
  // is not an extraction, so it must never appear there.
  assert.ok(
    !/last_run:\s/.test(source),
    "the probe must never write last_run — it is not the last extraction",
  );
  // And it must not reach the approval projector or the ledger either.
  assert.ok(!source.includes("candidateLedger"), "the probe must not touch the candidate ledger");
  assert.ok(!source.includes("persistLedger"), "the probe must not persist a ledger entry");
});

test("a probe entry is marked, so the ledger exemption it gets cannot spread", () => {
  // The exemption in tools/validate.ts is keyed on this exact mode string
  // (D-164). If the writer and the validator ever disagree about it, the probe's
  // entry stops being exempt and starts failing the D-132 ledger requirement —
  // or, worse, some other run silently acquires the exemption.
  const probe = readFileSync(join(ROOT, "tools/transferability-probe.ts"), "utf8");
  const validate = readFileSync(join(ROOT, "tools/validate.ts"), "utf8");
  assert.equal(PROBE_RUN_MODE, "transferability_probe");
  assert.match(probe, /mode: PROBE_RUN_MODE/, "the probe must mark its entry with the shared constant");
  assert.match(
    validate,
    /run\.params\?\.mode === PROBE_RUN_MODE/,
    "validate must key the exemption on the same shared constant",
  );
  // The exemption is not a free pass: both zero-claims are enforced there.
  assert.match(validate, /records_fetched !== 0 \|\| run\.files_written !== 0/);
});

test("the probe measures the configured strong tier, never a model of its own choosing", () => {
  // D-162's figures came from a model the pipeline is not configured to call.
  // A probe that pinned its own model id would reproduce exactly that error, so
  // the model must come from configuredTier and nowhere else.
  const source = readFileSync(join(ROOT, "tools/transferability-probe.ts"), "utf8");
  assert.match(source, /configuredTier\(config, "strong"\)/);
  assert.doesNotMatch(
    source,
    /model_id\s*[:=]\s*["'`]/,
    "the probe must not hardcode a model id",
  );
});

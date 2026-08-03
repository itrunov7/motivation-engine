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
import type { Proposal } from "../lib/types";
import {
  describeTransferability,
  judgeTransferability,
  transferabilityClaimOfProposal,
  TRANSFERABILITY_RULESET_VERSION,
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

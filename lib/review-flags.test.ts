/**
 * PATTERN CARRIES ANCHOR DOMAIN, tested against the leak that motivated it.
 *
 * The fixtures are the three real patterns LA-01 produced while anchored on
 * la-01-04 — two approved, one rejected — all worded in portfolios and
 * volatility metrics that no product outside investing could apply. They are
 * quoted verbatim from the committed records so the test measures the check
 * against the actual failure rather than against a paraphrase of it, and the
 * anchor is resolved from the real effects/LA-01/la-01-04.json.
 *
 * The negative cases matter as much as the positive ones: a check that flags
 * every inferred realization would report a 100% rate and teach nothing about
 * whether the prompt fix held.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { computeProposalFlags, GENERIC_UI_TERMS } from "./review-flags";
import type { Realization, RealizationProposal } from "./types";

const ROOT = join(__dirname, "..");

const provenance = [
  {
    mechanism_id: "LA-01",
    corpus_record_id: "cr-0000000000000000000000000000000000000000",
    doi: "10.1162/003355397555217",
    title:
      "The Effect of Myopia and Loss Aversion on Risk Taking: An Experimental Test",
    quote_or_locus: "placeholder span, not exercised by these checks",
  },
];

function realizationProposal(payload: Partial<Realization>): RealizationProposal {
  return {
    id: "proposal-under-test",
    type: "realization",
    operation: "create",
    target: "LA-01",
    payload: {
      id: "pattern-under-test",
      mechanism_id: "LA-01",
      term: "Pattern under test",
      description_as_reported:
        "Investors evaluating portfolios more frequently took less risk.",
      artifact_context: ["dashboard_widget"],
      derivation: "inferred",
      effect_refs: ["la-01-04"],
      domain_transfer: {
        source_domain: "behavioural finance",
        application_domain: "product UI",
      },
      provenance,
      confidence: 0.6,
      ...payload,
    } as Realization,
    provenance,
    confidence: 0.6,
    proposed_by: "review-flags-test",
    proposed_at: "2026-08-12T00:00:00.000Z",
    status: "pending",
    hold_reason: null,
    decision_note: null,
  } as RealizationProposal;
}

function domainFlags(payload: Partial<Realization>) {
  return computeProposalFlags(realizationProposal(payload), ROOT).filter(
    (flag) => flag.kind === "pattern_carries_anchor_domain",
  );
}

/** The leaked terms the flag reports, parsed back out of its detail line. */
function leakedTerms(payload: Partial<Realization>): string[] {
  const flags = domainFlags(payload);
  assert.equal(flags.length, 1, "expected exactly one anchor-domain flag");
  const match = /Shared non-generic terms: (.+)\.$/.exec(flags[0].detail);
  assert.ok(match, `detail did not carry a leaked-term list: ${flags[0].detail}`);
  return match[1].split(", ");
}

// --- the three real la-01-04 patterns --------------------------------------

test("flags bias-awareness-tooltip: the anchor's construct and subject both survive", () => {
  const leaked = leakedTerms({
    id: "bias-awareness-tooltip",
    term: "Bias awareness tooltip",
    pattern:
      "Trigger an educational tooltip that explains loss aversion and its effect on risk-taking whenever the displayed portfolio volatility metric exceeds {volatility_threshold} percent, replacing the bare number with the annotated explanation until dismissed.",
    parameters: [
      {
        name: "volatility_threshold",
        value: 15,
        unit: "percent of annualised variance",
        evidence_basis: "none — default heuristic",
      },
    ],
  });
  for (const term of ["aversion", "loss", "portfolio", "risk", "taking"]) {
    assert.ok(leaked.includes(term), `expected "${term}" among ${leaked.join(", ")}`);
  }
});

test("flags periodic-performance-digest: plural folding is what catches it", () => {
  const leaked = leakedTerms({
    id: "periodic-performance-digest",
    term: "Periodic performance digest",
    pattern:
      "Replace frequent, granular portfolio performance notifications with a single periodic digest, suppressing intermediate updates until {evaluation_interval} days have elapsed since the last shown update.",
    parameters: [
      {
        name: "evaluation_interval",
        value: 30,
        unit: "days between shown updates",
        evidence_basis: "none — default heuristic",
      },
    ],
  });
  // The anchor's fact says "portfolios"; the pattern says "portfolio". Without
  // singularisation this leak is invisible and the check misses its own case.
  assert.deepEqual(leaked, ["portfolio"]);
});

test("flags the rejected session-threshold-performance-reveal", () => {
  const leaked = leakedTerms({
    id: "session-threshold-performance-reveal",
    term: "Session threshold performance reveal",
    pattern:
      "Withhold the aggregated portfolio performance summary behind a placeholder until the user has completed {evaluation_threshold} usage sessions, then reveal the full multi-session summary.",
    parameters: [
      {
        name: "evaluation_threshold",
        value: 5,
        unit: "usage sessions before the summary is revealed",
        evidence_basis: "none — default heuristic",
      },
    ],
  });
  assert.deepEqual(leaked, ["portfolio"]);
});

// --- the control: the same directive, abstracted --------------------------

test("stays clean on a domain-neutral rewrite of the same directive", () => {
  // Every anchored object replaced by its functional role, per the abstraction
  // rule now in inferredRealizationInstruction. Same behaviour, no finance.
  const flags = domainFlags({
    id: "batched-outcome-digest",
    term: "Batched outcome digest",
    pattern:
      "Replace granular outcome updates the user did not request with a single periodic digest, suppressing intermediate updates until {evaluation_interval} days have elapsed since the last shown update.",
    parameters: [
      {
        name: "evaluation_interval",
        value: 30,
        unit: "days between shown updates",
        evidence_basis: "none — default heuristic",
      },
    ],
  });
  assert.deepEqual(flags, []);
});

// --- scope guards ----------------------------------------------------------

test("a parameter name is not mined for domain words", () => {
  // {portfolio_volatility_threshold} is an identifier the reader never sees;
  // only the prose around it is the pattern's own wording.
  const flags = domainFlags({
    id: "variance-annotation",
    term: "Variance annotation",
    pattern:
      "Annotate a displayed metric with an explanatory overlay once its variance exceeds {portfolio_volatility_threshold} percent.",
    parameters: [
      {
        name: "portfolio_volatility_threshold",
        value: 15,
        unit: "percent of annualised variance",
        evidence_basis: "none — default heuristic",
      },
    ],
  });
  assert.deepEqual(flags, []);
});

test("a reported realization is out of scope — it has no pattern to transfer", () => {
  const proposal = realizationProposal({
    id: "observed-embodiment",
    term: "Observed embodiment",
    description_as_reported:
      "The brokerage showed portfolio performance on a monthly cadence.",
  });
  delete (proposal.payload as Partial<Realization>).pattern;
  delete (proposal.payload as Partial<Realization>).effect_refs;
  delete (proposal.payload as Partial<Realization>).domain_transfer;
  proposal.payload.derivation = "reported";
  const flags = computeProposalFlags(proposal, ROOT).filter(
    (flag) => flag.kind === "pattern_carries_anchor_domain",
  );
  assert.deepEqual(flags, []);
});

test("an unresolvable effect ref raises nothing rather than guessing", () => {
  const flags = domainFlags({
    id: "orphaned-anchor",
    term: "Orphaned anchor",
    effect_refs: ["no-such-effect-id"],
    pattern:
      "Replace granular portfolio performance notifications with a single periodic digest.",
  });
  assert.deepEqual(flags, []);
});

// --- the exemption list ----------------------------------------------------

test("GENERIC_UI_TERMS holds singular forms, since lookups are folded", () => {
  for (const term of Array.from(GENERIC_UI_TERMS)) {
    assert.ok(
      !/(?<!s|u|i)s$/.test(term),
      `"${term}" looks plural; entries are looked up after singularisation`,
    );
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  REVERSAL_MARKERS,
  checkSpanRole,
  downstreamContradiction,
  reversalMarkerIn,
} from "./span-role";

/**
 * lib/span-role.test.ts — controls for the reversal vocabulary (D-133).
 *
 * The vocabulary is mechanics, not science: it decides which sentences the
 * extraction gate is willing to read as "the paper went on to overturn this".
 * It is tested in two directions, and the second matters more. A positive
 * control says a phrasing is caught. A NEGATIVE control says a phrasing that
 * merely looks like disagreement is not — which is the failure D-130 measured
 * in the neighbouring dissent vocabulary, where a bare "question" tagged 539
 * records and a bare "does not" tagged 382.
 */

/** Every phrasing the extended list must catch, with the rule that catches it. */
const POSITIVE: readonly (readonly [string, string])[] = [
  ["the modality effect was reversed in this experiment", "reverse"],
  ["we observed a reversal of the expected pattern", "reversal"],
  ["the opposite pattern emerged for novices", "opposite"],
  ["contrary to the prediction, performance declined", "contrary-to"],
  [
    "in contrast to our predictions, the cue had no bearing on recall",
    "in-contrast-to-prediction",
  ],
  ["only a weak association was detected", "only-a-weak"],
  ["only a marginal advantage remained after correction", "only-a-weak"],
  ["the second experiment failed to replicate this result", "fail-to+verb"],
  ["the manipulation failed to improve retention", "fail-to+verb"],
  ["the advantage failed to materialise in the transfer task", "fail-to+verb"],
  ["the benefit did not generalise to older learners", "neg+claim-verb"],
  ["these results do not support the modality account", "neg+claim-verb"],
  ["the groups did not differ on any measure", "neg+outcome-verb"],
  ["the cue did not improve comprehension scores", "neg+outcome-verb"],
  ["the finding was not replicated in either sample", "was-not+participle"],
  ["the difference was not significant", "was-not+participle"],
  ["the prediction was not borne out", "was-not+participle"],
  ["there was no significant difference between conditions", "no-significant"],
  ["we found no reliable association between the two", "no-significant"],
  ["there was no effect of modality on retention", "no-effect-of"],
  ["we found no evidence of a split-attention cost", "no-evidence"],
  ["no evidence was obtained for the predicted interaction", "no-evidence"],
  ["the data provide no support for this account", "no-support-for"],
  ["little support for the hypothesis was found", "no-support-for"],
  ["this is best described as a null result", "null-result"],
  ["the absence of an effect held across all three samples", "absence-of"],
  ["these data contradict the earlier report", "contradicts"],
  ["the follow-up refuted that interpretation", "contradicts"],
  ["the effect disappeared once prior knowledge was controlled", "effect-disappeared"],
];

/**
 * Phrasings that must NOT fire, each standing for a way a marker set goes wrong.
 * The comment on each is the failure it guards against, so a future addition
 * that breaks one can see what it is trading away.
 */
const NEGATIVE: readonly (readonly [string, string])[] = [
  // The D-130 catch-alls, verbatim in the shapes that fired on 539 and 382
  // records for no reason. These stay out of the reversal set too.
  ["this raises the question of how expertise interacts with cueing", "bare question"],
  ["the model does not assume a fixed capacity limit", "bare does-not"],
  ["however, the mechanism remains debated", "bare however"],
  // Contrast between conditions is how a finding is normally stated.
  ["performance improved as opposed to declining", "as opposed to"],
  ["diagrams outperformed text, in contrast to the audio condition", "condition contrast"],
  // Method words that merely contain a marker's stem. Both are measured
  // against the stored corpus — reverse-engineering in 2 records, reverse
  // transcription in 13 — rather than imagined; no exclusion is carried for a
  // false positive that has never occurred.
  ["we used reverse-engineering to recover the original stimuli", "reverse-engineering"],
  ["samples underwent reverse transcription before amplification", "reverse transcription"],
  // Negation of something that is not the claim.
  ["participants did not receive feedback between blocks", "negated procedure"],
  ["the sample did not include children under eight", "negated sample"],
  ["the effect was not moderated by age", "negated moderator"],
  // A hypothesis stated, not overturned.
  ["we predicted that the cue would improve recall", "hypothesis"],
];

test("every named reversal marker has a positive control", () => {
  const covered = new Set(POSITIVE.map(([, name]) => name));
  const missing = REVERSAL_MARKERS.map((marker) => marker.name).filter(
    (name) => !covered.has(name),
  );
  assert.deepEqual(missing, []);
});

test("marker names are unique, so a coverage report cannot double-count", () => {
  const names = REVERSAL_MARKERS.map((marker) => marker.name);
  assert.equal(new Set(names).size, names.length);
});

for (const [sentence, expected] of POSITIVE) {
  test(`reversal marker ${expected} catches: ${sentence}`, () => {
    const hit = reversalMarkerIn(sentence);
    assert(hit, `no marker fired on "${sentence}"`);
    // The named marker must be the one that fires, not merely SOME marker:
    // a phrasing caught by accident is a phrasing that disappears when the
    // rule that caught it is narrowed for an unrelated reason.
    assert.equal(hit.name, expected);
  });
}

for (const [sentence, guards] of NEGATIVE) {
  test(`reversal vocabulary ignores ${guards}: ${sentence}`, () => {
    const hit = reversalMarkerIn(sentence);
    assert.equal(
      hit,
      null,
      `"${sentence}" fired ${hit?.name} on "${hit?.matched}"`,
    );
  });
}

test("a marker alone does not refuse — the sentence must be about the quote", () => {
  const source =
    "Cueing improved retention for novice learners. " +
    "Response times did not differ across the three practice schedules.";
  const quote = "Cueing improved retention for novice learners.";
  // The second sentence carries neg+outcome-verb and is about something else.
  // Recall in the vocabulary is safe precisely because this gate is not.
  assert.equal(
    downstreamContradiction(source, quote.length, quote),
    null,
  );
});

test("a reversal about the same things does refuse, and names the rule", () => {
  const source =
    "The modality effect improves multimedia learning outcomes. " +
    "In this experiment the modality effect was reversed for multimedia learning outcomes.";
  const quote = "The modality effect improves multimedia learning outcomes.";
  const contradiction = downstreamContradiction(source, quote.length, quote);
  assert(contradiction);
  assert.equal(contradiction.marker_name, "reverse");
  assert(contradiction.shared.length >= 3);

  const verdict = checkSpanRole({
    asserted: "finding",
    source,
    quote,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.reason, "premise_contradicted_downstream");
    assert(verdict.detail.includes("marker reverse"));
  }
});

test("a span that states its own qualification is not undone by it", () => {
  // The honest quote from D-129: the span already carries the reversal, so the
  // sentence explaining it must not be read as overturning it.
  const source =
    "Only a weak cueing effect and even a reverse modality effect have been found. " +
    "The reverse modality effect appears when the cueing effect is weak.";
  const quote =
    "Only a weak cueing effect and even a reverse modality effect have been found.";
  assert.equal(downstreamContradiction(source, quote.length, quote), null);
});

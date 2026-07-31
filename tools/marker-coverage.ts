/**
 * tools/marker-coverage.ts — measure what the reversal vocabulary reaches
 * (D-133).
 *
 * WHY THIS EXISTS. The extraction gate refuses a candidate when the sentence
 * after its quote reverses it (D-129). Whether that gate catches anything is a
 * measurable fact about a vocabulary and a corpus, and it had never been
 * measured reproducibly — the "7.5% against a 31.3% ceiling" pair came from a
 * one-off probe that left no instrument behind. This is the instrument.
 *
 * WHAT IT DOES NOT DO. It writes nothing and decides nothing. Same shape as
 * tools/retag-categories.ts under D-131: a review instrument prints numbers the
 * owner can check, and a number quoted before it has been produced this way is
 * an estimate. The dissent variant in particular is COMPUTED AND NOT APPLIED —
 * tools/connectors/evidence.ts is not touched, and the D-130 freeze on the
 * dissent vocabulary holds until the owner session decides it.
 *
 * THE PROBE. The gate needs a span and its downstream text; a corpus record has
 * neither. So each abstract is probed the way the original measurement was: the
 * first sentence stands in for the quote, the rest for what follows it. That is
 * a proxy for a real span, and it is stated as one — it measures the reach of
 * the vocabulary over the corpus, not the refusal rate of any actual run.
 *
 * Reads corpora/evidence/** and nothing else. No network, no LLM, no writes.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  REVERSAL_MARKERS,
  downstreamContradiction,
  reversalMarkerIn,
  type ReversalMarker,
} from "../lib/span-role";
import { DISSENT_MARKERS } from "./connectors/evidence";
import type { EvidenceCorpusFile, EvidenceCorpusRecord } from "../lib/types";

const ROOT = join(__dirname, "..");
const CORPORA = join(ROOT, "corpora", "evidence");

/**
 * The vocabulary as it shipped under D-129, frozen here as the BEFORE side.
 *
 * A historical copy, kept for measurement only and never used by the gate. It
 * is duplicated rather than recovered from git because a before/after has to be
 * re-runnable by anyone reading the report, and "check out an old commit" is not
 * a measurement anyone repeats.
 */
const SHIPPED_D129_MARKERS: readonly ReversalMarker[] = [
  { name: "reverse", pattern: /\breverse[ds]?\b(?![-\s]?engineer)/i },
  { name: "reversal", pattern: /\breversal\b/i },
  { name: "opposite", pattern: /\bopposite\b/i },
  { name: "contrary-to", pattern: /\bcontrary to\b/i },
  { name: "only-a-weak", pattern: /\bonly a weak\b/i },
  {
    name: "fail-to+verb",
    pattern:
      /\bfail(?:ed|s|ure)? to (?:replicate|find|generalise|generalize|show|emerge|hold)\b/i,
  },
  {
    name: "neg+claim-verb",
    pattern:
      /\b(?:did|does|do) not (?:replicate|generalise|generalize|hold|extend|transfer|appear|emerge|support|survive)\b/i,
  },
  {
    name: "was-not+participle",
    pattern: /\b(?:was|were) not (?:replicated|supported|confirmed|observed|found|significant)\b/i,
  },
  {
    name: "no-significant",
    pattern:
      /\bno (?:statistically )?(?:significant|reliable|detectable|measurable) (?:effect|difference|benefit|advantage|improvement|gain|change)\b/i,
  },
  { name: "no-evidence", pattern: /\bno evidence (?:of|for|that)\b/i },
];

/**
 * The catch-alls, isolated so the "ceiling" can be decomposed rather than
 * quoted as a target.
 *
 * These are exactly the shapes D-130 measured misfiring in the dissent
 * vocabulary: a bare "does not" tagged 382 records, a bare "question" tagged
 * 539. A distance-to-ceiling figure that includes them is a distance to a place
 * this repo has already decided not to go, and reporting it undecomposed would
 * read as an argument for going there.
 */
const CATCH_ALL_MARKERS: readonly ReversalMarker[] = [
  { name: "bare-however", pattern: /\bhowever\b/i },
  {
    name: "bare-negation",
    pattern: /\b(?:did|does|do|was|were|is|are|has|have|had|cannot|could) not\b/i,
  },
  { name: "bare-question", pattern: /\bquestion(?:s|ed|ing)?\b/i },
  { name: "bare-but", pattern: /\bbut\b/i },
];

/** The pre-D-130 dissent rule, verbatim, for the loss decomposition below. */
const PRE_D130_DISSENT_ALTERNATIVES: readonly (readonly [string, RegExp])[] = [
  ["fail-to", /\bfail(s|ed|ure)? to\b/i],
  ["no-evidence", /\bno evidence\b/i],
  ["absence-of", /\babsence of\b/i],
  ["bare-does-not", /\bdoes not\b/i],
  ["not-replicate", /\bnot replicate\b/i],
  ["critique", /critique/i],
  ["bare-question", /\bquestion(s|ing)?\b/i],
  ["reconsider", /reconsider/i],
  ["overestimat", /overestimat/i],
  ["publication-bias", /publication bias/i],
  ["boundary-condition", /boundary condition/i],
];

function corpusFiles(): string[] {
  if (!existsSync(CORPORA)) return [];
  return readdirSync(CORPORA)
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .sort()
    .map((name) => join(CORPORA, name));
}

function allRecords(): EvidenceCorpusRecord[] {
  return corpusFiles().flatMap((file) => {
    const corpus = JSON.parse(readFileSync(file, "utf8")) as EvidenceCorpusFile;
    return corpus.records ?? [];
  });
}

/** The gate reads title + abstract as one text, so the probe does too. */
function sourceTextOf(record: EvidenceCorpusRecord): string {
  return `${record.title} ${record.abstract ?? ""}`.trim();
}

function firstSentenceEnd(text: string): number {
  const match = /[.!?]\s/.exec(text);
  return match ? match.index + 1 : -1;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

interface ProbeResult {
  /** Records where any marker fires anywhere downstream of the first sentence. */
  markerHits: number;
  /** Records the gate would actually refuse: marker AND >=3 shared words. */
  contradictions: number;
  /** Per-marker: records where it is the first to fire. */
  fires: Map<string, number>;
  /** Per-marker: records where removing it would lose the hit entirely. */
  soleReason: Map<string, number>;
}

function probe(
  records: readonly EvidenceCorpusRecord[],
  markers: readonly ReversalMarker[],
): ProbeResult {
  const fires = new Map<string, number>();
  const soleReason = new Map<string, number>();
  let markerHits = 0;
  let contradictions = 0;
  for (const record of records) {
    const source = sourceTextOf(record);
    const end = firstSentenceEnd(source);
    if (end < 0) continue;
    const quote = source.slice(0, end);
    const downstream = source.slice(end);
    const firing = markers.filter((marker) => marker.pattern.test(downstream));
    if (firing.length === 0) continue;
    markerHits += 1;
    const first = reversalMarkerIn(downstream, markers);
    if (first) fires.set(first.name, (fires.get(first.name) ?? 0) + 1);
    if (firing.length === 1) {
      const name = firing[0].name;
      soleReason.set(name, (soleReason.get(name) ?? 0) + 1);
    }
    if (downstreamContradiction(source, end, quote, markers)) {
      contradictions += 1;
    }
  }
  return { markerHits, contradictions, fires, soleReason };
}

function table(
  markers: readonly ReversalMarker[],
  result: ProbeResult,
): void {
  const width = Math.max(...markers.map((marker) => marker.name.length));
  for (const marker of markers) {
    const fired = result.fires.get(marker.name) ?? 0;
    const sole = result.soleReason.get(marker.name) ?? 0;
    console.log(
      `    ${marker.name.padEnd(width)}  first to fire ${String(fired).padStart(5)}   sole reason ${String(sole).padStart(5)}`,
    );
  }
}

function reversalSection(records: readonly EvidenceCorpusRecord[]): void {
  const probeable = records.filter(
    (record) => firstSentenceEnd(sourceTextOf(record)) >= 0,
  );
  const before = probe(probeable, SHIPPED_D129_MARKERS);
  const after = probe(probeable, REVERSAL_MARKERS);
  const ceiling = probe(probeable, [...REVERSAL_MARKERS, ...CATCH_ALL_MARKERS]);
  const catchAllOnly = probe(probeable, CATCH_ALL_MARKERS);
  const total = probeable.length;

  console.log("REVERSAL VOCABULARY — coverage over the stored corpus");
  console.log(
    `  denominator: ${total} of ${records.length} records have a title+abstract with more than one sentence`,
  );
  console.log(
    "  NOTE on the 7.5% / 31.3% pair quoted before this instrument existed. The",
  );
  console.log(
    "  31.3% reproduces EXACTLY, and it is the reach of bare \"however\" on this",
  );
  console.log(
    "  denominator and nothing else — see bare-however below. The ceiling was a",
  );
  console.log(
    "  discourse marker's frequency, not an estimate of how much reversal the",
  );
  console.log(
    "  corpus contains. The 7.5% does not reproduce from any basis reconstructable",
  );
  console.log(
    "  here (whole corpus or CL-14 alone; title+abstract or abstract alone; whole",
  );
  console.log(
    "  text, first tail sentence, or last), so it is superseded rather than",
  );
  console.log("  compared against. The probe below is written down so this cannot recur.");
  console.log("");
  console.log("  marker reach (any marker fires after the first sentence)");
  console.log(
    `    before (D-129, ${SHIPPED_D129_MARKERS.length} markers): ${before.markerHits} (${pct(before.markerHits, total)})`,
  );
  console.log(
    `    after  (D-133, ${REVERSAL_MARKERS.length} markers): ${after.markerHits} (${pct(after.markerHits, total)})`,
  );
  console.log(
    `    delta: +${after.markerHits - before.markerHits} records (+${pct(after.markerHits - before.markerHits, total)} of the denominator)`,
  );
  console.log("");
  console.log(
    "  what the gate would actually refuse (marker AND >=3 shared content words)",
  );
  console.log(
    `    before: ${before.contradictions} (${pct(before.contradictions, total)})`,
  );
  console.log(
    `    after:  ${after.contradictions} (${pct(after.contradictions, total)})`,
  );
  console.log(
    "    This, not the marker reach, is what refuses a candidate. The overlap",
  );
  console.log(
    "    requirement is where the precision comes from, which is why widening",
  );
  console.log("    the vocabulary is safe and widening the overlap gate is not.");
  console.log("");
  console.log("  the ceiling, decomposed");
  console.log(
    `    named phrasings + catch-alls: ${ceiling.markerHits} (${pct(ceiling.markerHits, total)})`,
  );
  console.log(
    `    reached by named phrasings:   ${after.markerHits} (${pct(after.markerHits, total)})`,
  );
  console.log(
    `    reachable ONLY by catch-alls: ${ceiling.markerHits - after.markerHits} (${pct(ceiling.markerHits - after.markerHits, total)})`,
  );
  console.log(
    `    catch-alls alone would reach: ${catchAllOnly.markerHits} (${pct(catchAllOnly.markerHits, total)})`,
  );
  for (const marker of CATCH_ALL_MARKERS) {
    const own = probe(probeable, [marker]);
    console.log(
      `      ${marker.name.padEnd(14)} on its own: ${String(own.markerHits).padStart(5)} (${pct(own.markerHits, total)})`,
    );
  }
  console.log(
    "    Every one of those is discourse rather than a claim, and two of them are",
  );
  console.log(
    "    the exact shapes D-130 measured firing on 539 and 382 records for no reason.",
  );
  console.log(
    "    The distance to the ceiling is therefore not a target: closing it means",
  );
  console.log("    re-importing the defect the neighbouring vocabulary just removed.");
  console.log("");
  console.log("  per-marker, after");
  table(REVERSAL_MARKERS, after);
  console.log("");
  console.log("  the final list, verbatim");
  for (const marker of REVERSAL_MARKERS) {
    console.log(`    ${marker.name}: ${marker.pattern.source}`);
  }
  console.log("");
}

/**
 * What the new phrasings would do to the DISSENT vocabulary — computed, and NOT
 * applied. tools/connectors/evidence.ts is not modified by this file or by
 * D-133; the owner session decides the dissent vocabulary seeing both variants.
 */
function dissentVariantSection(records: readonly EvidenceCorpusRecord[]): void {
  const shippedDissentNames = new Set(
    DISSENT_MARKERS.map((marker) => marker.name),
  );
  const added = REVERSAL_MARKERS.filter(
    (marker) => !shippedDissentNames.has(marker.name),
  );
  let current = 0;
  let variant = 0;
  const soleAdded = new Map<string, number>();
  for (const record of records) {
    const text = `${record.title} ${record.abstract ?? ""} ${record.pin_reason ?? ""}`;
    const currentHit = DISSENT_MARKERS.some((marker) => marker.pattern.test(text));
    const addedHits = added.filter((marker) => marker.pattern.test(text));
    if (currentHit) current += 1;
    if (currentHit || addedHits.length > 0) variant += 1;
    if (!currentHit && addedHits.length === 1) {
      const name = addedHits[0].name;
      soleAdded.set(name, (soleAdded.get(name) ?? 0) + 1);
    }
  }
  console.log("DISSENT VARIANT — computed, NOT applied (D-130 freeze holds)");
  console.log(`  denominator: ${records.length} stored records`);
  console.log(
    `  dissent as shipped today: ${current} (${pct(current, records.length)})`,
  );
  console.log(
    `  dissent if the D-133 reversal phrasings were added: ${variant} (${pct(variant, records.length)})`,
  );
  console.log(
    `  delta: +${variant - current} records (+${pct(variant - current, records.length)})`,
  );
  console.log(
    `  the ${added.length} phrasings not already in DISSENT_MARKERS, by records they alone would add:`,
  );
  for (const marker of added) {
    console.log(
      `    ${marker.name}: ${soleAdded.get(marker.name) ?? 0} records it would be the sole new reason for`,
    );
  }
  console.log(
    "  Nothing here is written. The dissent vocabulary is the rubric's input layer",
  );
  console.log("  (rule 4), so widening it is the owner's call, not a cleanup.");
  console.log("");
}

/**
 * How much of the D-130 dissent shrink is the bare "question" catch-all.
 *
 * Reported here rather than asserted in docs/computed-grading.md, because the
 * 43% share that entry was written against was an estimate and D-131 says only
 * a measured number may be written down.
 */
function dissentLossSection(records: readonly EvidenceCorpusRecord[]): void {
  let oldDissent = 0;
  let newDissent = 0;
  let lost = 0;
  let lostSoleQuestion = 0;
  let lostSoleBareDoesNot = 0;
  for (const record of records) {
    const text = `${record.title} ${record.abstract ?? ""} ${record.pin_reason ?? ""}`;
    const oldFiring = PRE_D130_DISSENT_ALTERNATIVES.filter(([, pattern]) =>
      pattern.test(text),
    ).map(([name]) => name);
    const isOld = oldFiring.length > 0;
    const isNew = DISSENT_MARKERS.some((marker) => marker.pattern.test(text));
    if (isOld) oldDissent += 1;
    if (isNew) newDissent += 1;
    if (isOld && !isNew) {
      lost += 1;
      if (oldFiring.length === 1 && oldFiring[0] === "bare-question") {
        lostSoleQuestion += 1;
      }
      if (oldFiring.length === 1 && oldFiring[0] === "bare-does-not") {
        lostSoleBareDoesNot += 1;
      }
    }
  }
  console.log("D-130 DISSENT SHRINK — what the narrowing actually dropped");
  console.log(`  dissent under the pre-D-130 rule: ${oldDissent}`);
  console.log(`  dissent under the shipped rule:   ${newDissent}`);
  console.log(
    `  records that lost the tag: ${lost}; gained: ${newDissent - oldDissent + lost}`,
  );
  console.log(
    `  lost SOLELY because bare "question" no longer fires: ${lostSoleQuestion} (${pct(lostSoleQuestion, lost)} of losses)`,
  );
  console.log(
    `  lost SOLELY because bare "does not" no longer fires: ${lostSoleBareDoesNot} (${pct(lostSoleBareDoesNot, lost)} of losses)`,
  );
  console.log("");
}

function main(): void {
  const records = allRecords();
  if (records.length === 0) {
    console.log(
      "No evidence corpora on disk yet — nothing to measure. This tool reads " +
        "corpora/evidence/*.json and writes nothing.",
    );
    return;
  }
  console.log("");
  reversalSection(records);
  dissentVariantSection(records);
  dissentLossSection(records);
  console.log(
    "Read-only. Nothing above was written to any file (D-131: these are the " +
      "measured numbers a commit or a decision entry may cite).",
  );
}

main();

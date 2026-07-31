/**
 * tools/retag-categories.ts — re-run the category checklist over corpora that
 * were harvested under the previous rules (D-130).
 *
 * WHY THIS EXISTS. Categories (D-019) are computed by the harvester and written
 * into the corpus, so a rule change does not reach records already on disk: a
 * corpus tagged under the old rules and a corpus tagged under the new ones look
 * identical, and `category_counts` mixes the two without saying so. The dossier
 * pipeline reads those counts, and tools/validate.ts fails a live mechanism whose
 * dissent count is zero — so a silent half-migration is not a cosmetic problem.
 *
 * WHAT IT DOES NOT DO. It does not decide anything. Categories are the input
 * layer of the grading rubric, and rule 4 makes halving a category an owner call,
 * not a cleanup — so the default is --dry-run and writing requires --apply. The
 * dry run is also the measuring instrument: it reports per-corpus and
 * per-category before/after counts, which marker is the SOLE reason a record is
 * tagged dissent, and a deterministic sample of records whose tags change, so the
 * owner can judge whether a shrinking category is losing noise or losing
 * refutation capacity.
 *
 * It never fetches. Classification is metadata-only and reads the stored record,
 * so a retag is a pure function of what is already in the repo.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  classifyRecord,
  dissentMarkersIn,
  isFoundationalByCitations,
  isReviewLike,
} from "./connectors/evidence";
import { EVIDENCE_CATEGORIES } from "../lib/types";
import type {
  CategoryCounts,
  CorpusManifest,
  EvidenceCategory,
  EvidenceCorpusFile,
  EvidenceCorpusRecord,
} from "../lib/types";

const ROOT = join(__dirname, "..");
const CORPORA = join(ROOT, "corpora", "evidence");
const MANIFEST = join(CORPORA, "manifest.json");

interface Args {
  apply: boolean;
  sampleSize: number;
  mechanism: string | null;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const option = (name: string): string | undefined => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  return {
    apply: argv.includes("--apply"),
    sampleSize: Number(option("sample") ?? 15),
    mechanism: option("mechanism") ?? null,
    seed: Number(option("seed") ?? 1),
  };
}

function emptyCounts(): CategoryCounts {
  return Object.fromEntries(
    EVIDENCE_CATEGORIES.map((category) => [category, 0]),
  ) as CategoryCounts;
}

function countCategories(records: readonly EvidenceCorpusRecord[]): CategoryCounts {
  const counts = emptyCounts();
  for (const record of records) {
    for (const category of record.categories) counts[category] += 1;
  }
  return counts;
}

/**
 * A deterministic pseudo-random order over an array.
 *
 * "A random sample of 15" has to mean the SAME 15 every run, or the owner cannot
 * check a claim about them twice, and a second reviewer cannot see what the first
 * one saw. The seed is an argument so a different 15 is requestable rather than
 * accidental.
 */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  let state = (seed || 1) >>> 0;
  for (let index = out.length - 1; index > 0; index -= 1) {
    // xorshift32: enough randomness for sampling, and reproducible everywhere.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

interface Change {
  mechanismId: string;
  record: EvidenceCorpusRecord;
  before: EvidenceCategory[];
  after: EvidenceCategory[];
  gained: EvidenceCategory[];
  lost: EvidenceCategory[];
  /** Dissent markers firing under the NEW rules, for the report. */
  markers: string[];
}

function dissentText(record: EvidenceCorpusRecord): string {
  return `${record.title} ${record.abstract ?? ""} ${record.pin_reason ?? ""}`;
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, at) => tag === right[at]);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const currentYear = new Date().getUTCFullYear();
  const files = readdirSync(CORPORA)
    .filter(
      (name) => name.endsWith(".json") && !name.startsWith("_") && name !== "manifest.json",
    )
    .sort();

  const changes: Change[] = [];
  const before = new Map<string, CategoryCounts>();
  const after = new Map<string, CategoryCounts>();
  const totalBefore = emptyCounts();
  const totalAfter = emptyCounts();
  const soleMarker = new Map<string, number>();
  const markerHits = new Map<string, number>();
  const written: string[] = [];
  let records = 0;
  let untaggedBefore = 0;
  let untaggedAfter = 0;

  for (const name of files) {
    const path = join(CORPORA, name);
    const corpus = JSON.parse(readFileSync(path, "utf8")) as EvidenceCorpusFile;
    if (!Array.isArray(corpus.records)) continue;
    // Keyed by FILE, not by mechanism_id: RE-10.json and RE-10.regression.json
    // both say mechanism_id "RE-10", and folding them together would report one
    // corpus's counts under the other's name.
    const mechanismId = name.replace(/\.json$/, "");
    if (args.mechanism && args.mechanism !== corpus.mechanism_id && args.mechanism !== mechanismId) {
      continue;
    }

    const originals = corpus.records.map((record) => record.categories ?? []);
    const retagged = corpus.records.map((record) => classifyRecord(record, currentYear));

    before.set(mechanismId, countCategories(corpus.records));
    after.set(
      mechanismId,
      countCategories(
        corpus.records.map((record, at) => ({ ...record, categories: retagged[at] })),
      ),
    );

    for (let at = 0; at < corpus.records.length; at += 1) {
      records += 1;
      const record = corpus.records[at];
      const markers = dissentMarkersIn(dissentText(record));
      for (const marker of markers) {
        markerHits.set(marker, (markerHits.get(marker) ?? 0) + 1);
      }
      if (markers.length === 1) {
        soleMarker.set(markers[0], (soleMarker.get(markers[0]) ?? 0) + 1);
      }
      if (originals[at].length === 0) untaggedBefore += 1;
      if (retagged[at].length === 0) untaggedAfter += 1;
      if (sameTags(originals[at], retagged[at])) continue;
      changes.push({
        mechanismId,
        record,
        before: originals[at],
        after: retagged[at],
        gained: retagged[at].filter((tag) => !originals[at].includes(tag)),
        lost: originals[at].filter((tag) => !retagged[at].includes(tag)),
        markers,
      });
    }

    if (args.apply) {
      for (let at = 0; at < corpus.records.length; at += 1) {
        corpus.records[at].categories = retagged[at];
      }
      corpus.category_counts = countCategories(corpus.records);
      writeFileSync(path, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
      written.push(`corpora/evidence/${name}`);
    }
  }

  for (const counts of Array.from(before.values())) {
    for (const category of EVIDENCE_CATEGORIES) totalBefore[category] += counts[category];
  }
  for (const counts of Array.from(after.values())) {
    for (const category of EVIDENCE_CATEGORIES) totalAfter[category] += counts[category];
  }

  report({
    args,
    records,
    corpora: files.length,
    totalBefore,
    totalAfter,
    untaggedBefore,
    untaggedAfter,
    before,
    after,
    changes,
    soleMarker,
    markerHits,
  });

  if (args.apply) {
    // The manifest's per-file category block is a COPY of what the corpus says.
    // Leaving it stale would put two disagreeing counts in the repo, and the
    // /ops reader believes the manifest.
    written.push(...syncManifest(after));
    console.log(`\nAPPLIED — ${written.length} file${written.length === 1 ? "" : "s"} rewritten:`);
    for (const path of written) console.log(`  ${path}`);
    console.log(
      "\nRun npm run validate, then commit with a data: prefix and a decisions entry.",
    );
  } else {
    console.log(
      "\nDRY RUN — nothing was written. Categories are the grading rubric's input " +
        "layer, so re-tagging is an owner decision (rule 4): re-run with --apply " +
        "once the vocabulary above is approved.",
    );
  }
  return 0;
}

/** Rewrite the manifest's per-file category counts to match the corpora. */
function syncManifest(after: ReadonlyMap<string, CategoryCounts>): string[] {
  if (!existsSync(MANIFEST)) return [];
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as CorpusManifest;
  let touched = false;
  for (const file of manifest.data_files ?? []) {
    const key = file.path.split("/").pop()?.replace(/\.json$/, "");
    const counts = key ? after.get(key) : undefined;
    if (!counts || !file.categories) continue;
    file.categories = counts;
    touched = true;
  }
  if (!touched) return [];
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return ["corpora/evidence/manifest.json"];
}

function delta(from: number, to: number): string {
  const diff = to - from;
  return `${String(from).padStart(6)} → ${String(to).padStart(6)}  ${
    diff === 0 ? "     ·" : `${diff > 0 ? "+" : ""}${diff}`.padStart(6)
  }`;
}

interface Report {
  args: Args;
  records: number;
  corpora: number;
  totalBefore: CategoryCounts;
  totalAfter: CategoryCounts;
  untaggedBefore: number;
  untaggedAfter: number;
  before: ReadonlyMap<string, CategoryCounts>;
  after: ReadonlyMap<string, CategoryCounts>;
  changes: readonly Change[];
  soleMarker: ReadonlyMap<string, number>;
  markerHits: ReadonlyMap<string, number>;
}

function report({
  args,
  records,
  corpora,
  totalBefore,
  totalAfter,
  untaggedBefore,
  untaggedAfter,
  before,
  after,
  changes,
  soleMarker,
  markerHits,
}: Report): void {
  console.log(
    `Category retag under the D-130 rules — ${records} records across ${corpora} corpora` +
      `${args.mechanism ? ` (filtered to ${args.mechanism})` : ""}\n`,
  );

  console.log("AGGREGATE, all corpora");
  console.log(`  ${"category".padEnd(16)}${"before".padStart(6)}   ${"after".padStart(6)}  ${"delta".padStart(6)}`);
  for (const category of EVIDENCE_CATEGORIES) {
    console.log(`  ${category.padEnd(16)}${delta(totalBefore[category], totalAfter[category])}`);
  }
  console.log(`  ${"(no category)".padEnd(16)}${delta(untaggedBefore, untaggedAfter)}`);
  console.log(`  ${"records changed".padEnd(16)}${String(changes.length).padStart(6)}`);

  console.log("\nPER CORPUS (only corpora whose counts move)");
  console.log(
    `  ${"mechanism".padEnd(10)}${EVIDENCE_CATEGORIES.map((c) => c.slice(0, 12).padStart(14)).join("")}`,
  );
  for (const [mechanismId, from] of Array.from(before.entries()).sort()) {
    const to = after.get(mechanismId);
    if (!to) continue;
    if (EVIDENCE_CATEGORIES.every((category) => from[category] === to[category])) continue;
    console.log(
      `  ${mechanismId.padEnd(10)}` +
        EVIDENCE_CATEGORIES.map((category) =>
          `${from[category]}→${to[category]}`.padStart(14),
        ).join(""),
    );
  }

  // tools/validate.ts fails any dossier whose corpus reports dissent 0 (D-019):
  // a corpus that can only confirm is broken. The check reads
  // corpora/evidence/{mechanism_id}.json only, so a .regression side file
  // reaching zero is not a build break — but it is still a corpus that lost its
  // capacity to disconfirm, so it is reported either way.
  const zeroed = Array.from(after.entries()).filter(
    ([key, counts]) => counts.dissent === 0 && (before.get(key)?.dissent ?? 0) > 0,
  );
  console.log("\nDISSENT-ZERO CHECK (D-019 gate in tools/validate.ts)");
  if (zeroed.length === 0) {
    console.log("  none — every corpus keeps at least one dissent record");
  } else {
    for (const [key, counts] of zeroed) {
      const gated = !key.includes(".");
      console.log(
        `  ${key}: ${before.get(key)?.dissent ?? 0} → ${counts.dissent}` +
          `${gated ? "  *** FAILS the dossier gate ***" : "  (side file, not read by the gate)"}`,
      );
    }
  }

  console.log("\nDISSENT MARKERS — how often each fires, and how often it is the ONLY one");
  console.log(`  ${"marker".padEnd(24)}${"fires".padStart(7)}${"sole reason".padStart(13)}`);
  const markers = Array.from(
    new Set([...Array.from(markerHits.keys()), ...Array.from(soleMarker.keys())]),
  ).sort((left, right) => (markerHits.get(right) ?? 0) - (markerHits.get(left) ?? 0));
  for (const marker of markers) {
    console.log(
      `  ${marker.padEnd(24)}${String(markerHits.get(marker) ?? 0).padStart(7)}` +
        `${String(soleMarker.get(marker) ?? 0).padStart(13)}`,
    );
  }

  for (const category of EVIDENCE_CATEGORIES) {
    for (const direction of ["lost", "gained"] as const) {
      const affected = changes.filter((change) => change[direction].includes(category));
      if (affected.length === 0) continue;
      const sample = seededShuffle(affected, args.seed).slice(0, args.sampleSize);
      console.log(
        `\nSAMPLE — ${sample.length} of ${affected.length} records that ${direction.toUpperCase()} "${category}"`,
      );
      for (const change of sample) {
        console.log(
          `  ${change.record.record_id} ${change.mechanismId} ${change.record.year ?? "----"} ` +
            `cit=${change.record.citations ?? "-"} type=${change.record.openalex_type ?? "-"}`,
        );
        console.log(`    ${change.record.title.slice(0, 110)}`);
        console.log(
          `    old [${change.before.join(", ")}] -> new [${change.after.join(", ")}]`,
        );
        console.log(`    ${evidenceFor(category, direction, change)}`);
      }
    }
  }
}

/**
 * The text that explains one record's change, so a sample line can be judged
 * without opening the corpus. For dissent this is the marker set; for
 * foundational it is the arithmetic; for meta-analysis it is the type and title
 * signal that fired.
 */
function evidenceFor(
  category: EvidenceCategory,
  direction: "lost" | "gained",
  change: Change,
): string {
  const record = change.record;
  if (category === "dissent") {
    return direction === "gained"
      ? `matched: ${change.markers.join(", ") || "(none — check the rule)"}`
      : `matched under the new markers: ${change.markers.join(", ") || "NOTHING"}`;
  }
  if (category === "foundational") {
    const age = record.year === null ? null : new Date().getUTCFullYear() - record.year;
    const rate =
      record.citations !== null && age !== null && age > 0
        ? (record.citations / age).toFixed(1)
        : "n/a";
    return (
      `citations=${record.citations ?? "-"} age=${age ?? "-"}y rate=${rate}/y ` +
      `foundational=${isFoundationalByCitations(record, new Date().getUTCFullYear())}`
    );
  }
  if (category === "meta-analysis") {
    return `openalex_type=${record.openalex_type ?? "-"}; review-like=${isReviewLike(record)}`;
  }
  return `year=${record.year ?? "-"}`;
}

process.exit(main());

/**
 * tools/replay-grounding.ts — the offline replay entry point for the grounding
 * gate (D-104). No LLM, no network, no writes: it loads a corpus from disk,
 * constructs or reads candidates, and runs the SAME `groundingOutcome` the
 * extraction pipeline runs. Rule 8 is untouched — this tool only observes.
 *
 * Why it exists. Four extraction runs dropped 100% of their candidates at the
 * grounding gate and the committed data could not say which check fired. Two
 * questions had to be answerable for free, forever:
 *
 *   1. Is the gate itself sound? Feed it candidates that are grounded BY
 *      CONSTRUCTION — the quote is sliced verbatim out of the stored abstract,
 *      the DOI is the record's own — and it must admit every one. If it refuses
 *      one, the gate is the bug and the byte-level dump says why.
 *   2. How brittle is the string comparison? Mutate one axis at a time and read
 *      the tolerance off the result, rather than guessing from the regex.
 *
 * The same entry point replays any candidate the pipeline dropped (D-104
 * persistence), so a rejection committed today stays re-checkable offline.
 *
 * Usage (from repo root):
 *   npm run replay-grounding -- synth --mechanism CL-14 --count 10
 *   npm run replay-grounding -- mutate --mechanism CL-14
 *   npm run replay-grounding -- replay corpora/extraction/rejected/<run>.json
 *   npm run replay-grounding -- verify-spans
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  EvidenceCorpusFile,
  EvidenceCorpusRecord,
  KnowledgeProvenanceItem,
  RejectedCandidateFile,
  RejectedCandidateRecord,
} from "../lib/types";
import { isExtractionAuthored } from "../lib/proposal-meta";
import {
  evidenceSourceText,
  normalizeQualityText,
  sha256Hex,
} from "../lib/proposal-quality";
import {
  isInferenceProvenance,
  isRealizationProvenance,
} from "../lib/realization-corpus";
import { groundingOutcome, type DraftItem, type UngroundedReason } from "./extract";

const ROOT = join(__dirname, "..");
const CORPUS_DIR = join(ROOT, "corpora", "evidence");

const DEFAULT_MECHANISM = "CL-14";
const DEFAULT_COUNT = 10;

/** Quote spans are cut to look like a real citation, not a single word. */
const QUOTE_MIN_CHARS = 90;
const QUOTE_MAX_CHARS = 220;

function rel(p: string): string {
  return relative(ROOT, p) || p;
}

// ---------------------------------------------------------------------------
// byte-level reporting
// ---------------------------------------------------------------------------

function hex(value: string): string {
  return Array.from(Buffer.from(value, "utf8"))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function codePoints(value: string): string {
  return Array.from(value)
    .map((char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ");
}

/**
 * The longest prefix of `needle` that still occurs inside `haystack`. This is
 * where a normalized substring match gives up, so it is the only interesting
 * offset in a failed comparison.
 */
function longestContainedPrefix(haystack: string, needle: string): number {
  let low = 0;
  let high = needle.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (haystack.includes(needle.slice(0, mid))) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Dump both compared strings byte-for-byte, with hex for the bytes that
 * actually differ. Printed only on a refusal, where it is the evidence.
 */
function reportComparison(quote: string, sourceText: string): void {
  const normalizedQuote = normalizeQualityText(quote);
  const normalizedSource = normalizeQualityText(sourceText);

  console.log("      compared strings, byte for byte:");
  console.log(`        quote.raw            (${Buffer.byteLength(quote, "utf8")} bytes) ${JSON.stringify(quote)}`);
  console.log(`        quote.normalized     (${Buffer.byteLength(normalizedQuote, "utf8")} bytes) ${JSON.stringify(normalizedQuote)}`);
  console.log(`        source.normalized    (${Buffer.byteLength(normalizedSource, "utf8")} bytes)`);

  if (normalizedQuote.length === 0) {
    console.log("        divergence: the quote normalizes to the empty string");
    console.log(`        quote.raw hex: ${hex(quote)}`);
    console.log(`        quote.raw code points: ${codePoints(quote)}`);
    return;
  }

  const matched = longestContainedPrefix(normalizedSource, normalizedQuote);
  console.log(`        longest contained prefix: ${matched} of ${normalizedQuote.length} normalized chars`);
  if (matched >= normalizedQuote.length) {
    console.log("        the normalized quote IS contained; the refusal came from a later check");
    return;
  }

  const context = 24;
  const quoteTail = normalizedQuote.slice(matched, matched + context);
  const anchor = normalizedQuote.slice(Math.max(0, matched - context), matched);
  const sourceAt = normalizedSource.indexOf(anchor);
  const sourceTail =
    sourceAt >= 0 ? normalizedSource.slice(sourceAt + anchor.length, sourceAt + anchor.length + context) : "";

  console.log(`        matched prefix ends with: ${JSON.stringify(anchor)}`);
  console.log(`        quote continues:  ${JSON.stringify(quoteTail)}`);
  console.log(`          hex: ${hex(quoteTail)}`);
  console.log(`          code points: ${codePoints(quoteTail)}`);
  console.log(`        source continues: ${JSON.stringify(sourceTail)}`);
  console.log(`          hex: ${hex(sourceTail)}`);
  console.log(`          code points: ${codePoints(sourceTail)}`);
}

// ---------------------------------------------------------------------------
// corpus + candidate construction
// ---------------------------------------------------------------------------

function loadCorpus(mechanismId: string): EvidenceCorpusFile {
  const path = join(CORPUS_DIR, `${mechanismId}.json`);
  if (!existsSync(path)) {
    throw new Error(`No evidence corpus at ${rel(path)}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as EvidenceCorpusFile;
}

/** The exact text the gate compares against, for one evidence record. */
function sourceTextFor(record: EvidenceCorpusRecord): string {
  return `${record.title}\n${record.abstract ?? ""}`;
}

/**
 * Cut a verbatim span out of the stored abstract, snapped to word boundaries so
 * it reads like a citation a model would return. Grounded by construction: the
 * result is a literal substring of `record.abstract`.
 */
function verbatimQuote(record: EvidenceCorpusRecord): string | null {
  const abstract = record.abstract;
  if (!abstract) return null;
  const trimmed = abstract.trim();
  if (trimmed.length < QUOTE_MIN_CHARS) return null;

  // Start a third of the way in so the span is interior to the abstract, not a
  // prefix that could accidentally match the title.
  const rawStart = Math.floor(trimmed.length / 3);
  const spaceAfterStart = trimmed.indexOf(" ", rawStart);
  const start = spaceAfterStart >= 0 ? spaceAfterStart + 1 : 0;
  const rawEnd = Math.min(trimmed.length, start + QUOTE_MAX_CHARS);
  const spaceBeforeEnd = trimmed.lastIndexOf(" ", rawEnd);
  const end = spaceBeforeEnd > start + QUOTE_MIN_CHARS ? spaceBeforeEnd : rawEnd;

  const quote = trimmed.slice(start, end).trim();
  if (normalizeQualityText(quote).length === 0) return null;
  // Guard the construction claim itself: it must be a literal substring.
  if (!abstract.includes(quote)) return null;
  return quote;
}

interface GroundedCandidate {
  record: EvidenceCorpusRecord;
  quote: string;
  item: DraftItem;
}

function candidateFor(record: EvidenceCorpusRecord, quote: string): DraftItem {
  return {
    name: `replay probe for ${record.record_id}`,
    fact: "Constructed offline by tools/replay-grounding.ts; never proposed.",
    boundary: "Not a scientific claim.",
    grade: "C-",
    confidence: 0.5,
    citations: [{ record_id: record.record_id, quote_or_locus: quote }],
  };
}

/**
 * Pick `count` DISTINCT records that can carry a definitionally grounded
 * candidate: a resolvable DOI and an abstract long enough to quote. Spread the
 * picks evenly across the record_id-sorted corpus so the sample is not all one
 * harvest angle, and stay deterministic so the matrix is reproducible.
 */
function selectGroundedCandidates(
  corpus: EvidenceCorpusFile,
  count: number,
): GroundedCandidate[] {
  const eligible = corpus.records
    .filter((record) => record.doi !== null && record.abstract !== null)
    .slice()
    .sort((left, right) => left.record_id.localeCompare(right.record_id));

  const picked: GroundedCandidate[] = [];
  const seen = new Set<string>();
  const stride = Math.max(1, Math.floor(eligible.length / count));
  for (let offset = 0; offset < eligible.length && picked.length < count; offset += 1) {
    const index = (offset % count) * stride + Math.floor(offset / count);
    const record = eligible[index];
    if (!record || seen.has(record.record_id)) continue;
    const quote = verbatimQuote(record);
    if (!quote) continue;
    seen.add(record.record_id);
    picked.push({ record, quote, item: candidateFor(record, quote) });
  }
  return picked;
}

// ---------------------------------------------------------------------------
// 0.1 — the control: definitionally grounded candidates must all be admitted
// ---------------------------------------------------------------------------

function outcomeLabel(outcome: ReturnType<typeof groundingOutcome>): string {
  return outcome.ok ? "ok" : outcome.reason;
}

function synth(mechanismId: string, count: number): number {
  const corpus = loadCorpus(mechanismId);
  const candidates = selectGroundedCandidates(corpus, count);

  console.log(
    `PART 0.1 — ${candidates.length} candidates grounded by construction, ` +
      `${mechanismId}, ${corpus.records.length} corpus records`,
  );
  console.log(
    "Each quote is a verbatim slice of the stored abstract; each DOI is the record's own.\n",
  );

  const header = `${"#".padEnd(3)}${"record_id".padEnd(28)}${"doi".padEnd(34)}${"quote chars".padEnd(13)}reason`;
  console.log(header);
  console.log("-".repeat(header.length));

  let refused = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const outcome = groundingOutcome(candidate.item, corpus);
    const label = outcomeLabel(outcome);
    console.log(
      `${String(index + 1).padEnd(3)}${candidate.record.record_id.padEnd(28)}` +
        `${(candidate.record.doi ?? "null").slice(0, 32).padEnd(34)}` +
        `${String(candidate.quote.length).padEnd(13)}${label}`,
    );
    if (!outcome.ok) {
      refused += 1;
      console.log(`      detail: ${outcome.detail}`);
      reportComparison(candidate.quote, sourceTextFor(candidate.record));
    }
  }

  console.log("");
  if (refused > 0) {
    console.log(
      `FAIL — ${refused} of ${candidates.length} definitionally grounded candidates were refused. ` +
        "That is the bug: the gate rejects provenance it constructed itself.",
    );
    return 1;
  }
  console.log(
    `OK — all ${candidates.length} admitted. The gate admits provenance that is ` +
      "grounded by construction, so a 100% drop rate is not the gate refusing valid input.",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// 0.2 — the tolerance matrix: one axis at a time
// ---------------------------------------------------------------------------

type MutationTarget = "candidate" | "corpus_record";

interface Mutation {
  name: string;
  target: MutationTarget;
  note?: string;
  /** Rewrite the quote the candidate cites. */
  quote?: (quote: string) => string;
  /** Rewrite the corpus record the candidate is checked against. */
  record?: (record: EvidenceCorpusRecord) => EvidenceCorpusRecord;
}

const MUTATIONS: Mutation[] = [
  { name: "none (control)", target: "candidate", quote: (quote) => quote },
  {
    name: "hyphen_u2010",
    target: "candidate",
    quote: (quote) => quote.replace(/-/g, "\u2010"),
  },
  {
    name: "hyphen_u2013",
    target: "candidate",
    quote: (quote) => quote.replace(/-/g, "\u2013"),
  },
  {
    name: "curly_quotes",
    target: "candidate",
    quote: (quote) => quote.replace(/'/g, "\u2019").replace(/"/g, "\u201D"),
  },
  {
    name: "whitespace_doubled",
    target: "candidate",
    quote: (quote) => quote.replace(/ /g, "  "),
  },
  {
    name: "whitespace_collapsed",
    target: "candidate",
    quote: (quote) => quote.replace(/\s+/g, " "),
  },
  {
    name: "nbsp",
    target: "candidate",
    quote: (quote) => quote.replace(/ /g, "\u00A0"),
  },
  {
    name: "trailing_ellipsis",
    target: "candidate",
    quote: (quote) => `${quote}\u2026`,
  },
  {
    name: "ligature_fi",
    target: "candidate",
    quote: (quote) => quote.replace(/fi/g, "\uFB01"),
  },
  {
    name: "ligature_fl",
    target: "candidate",
    quote: (quote) => quote.replace(/fl/g, "\uFB02"),
  },
  {
    name: "edge_punctuation",
    target: "candidate",
    quote: (quote) => `\u201C... ${quote} ...\u201D,`,
  },
  {
    name: "doi_case",
    target: "corpus_record",
    note: "unreachable_from_candidate",
    record: (record) => ({ ...record, doi: record.doi?.toUpperCase() ?? null }),
  },
  {
    name: "doi_prefix",
    target: "corpus_record",
    note: "unreachable_from_candidate",
    record: (record) => ({
      ...record,
      doi: record.doi === null ? null : `https://doi.org/${record.doi}`,
    }),
  },
  {
    name: "doi_trailing_period",
    target: "corpus_record",
    note: "unreachable_from_candidate",
    record: (record) => ({
      ...record,
      doi: record.doi === null ? null : `${record.doi}.`,
    }),
  },
  {
    name: "doi_null_on_record",
    target: "corpus_record",
    note: "the only reachable doi_unresolved path",
    record: (record) => ({ ...record, doi: null }),
  },
  {
    name: "quote_invented",
    target: "candidate",
    note: "negative control, must refuse",
    quote: () => "this span was never harvested and appears in no stored abstract",
  },
  {
    name: "quote_punctuation_only",
    target: "candidate",
    note: "negative control, must refuse",
    quote: () => "--- ... ---",
  },
];

/** Swap one record inside a corpus, leaving every other field identical. */
function corpusWithRecord(
  corpus: EvidenceCorpusFile,
  replacement: EvidenceCorpusRecord,
): EvidenceCorpusFile {
  return {
    ...corpus,
    records: corpus.records.map((record) =>
      record.record_id === replacement.record_id ? replacement : record,
    ),
  };
}

function mutate(mechanismId: string, count: number): number {
  const corpus = loadCorpus(mechanismId);
  const candidates = selectGroundedCandidates(corpus, count);
  if (candidates.length === 0) {
    throw new Error(`No groundable records in ${mechanismId}`);
  }

  console.log(
    `PART 0.2 — tolerance matrix, ${MUTATIONS.length} axes x ${candidates.length} candidates, ${mechanismId}`,
  );
  console.log(
    "One axis mutated per run, starting from the definitionally grounded candidate.\n",
  );

  const header = `${"variant".padEnd(24)}${"target".padEnd(16)}${"admitted".padEnd(11)}${"reasons".padEnd(24)}note`;
  console.log(header);
  console.log("-".repeat(header.length));

  const rows: { name: string; admitted: number; reasons: Map<UngroundedReason, number> }[] = [];
  for (const mutation of MUTATIONS) {
    let admitted = 0;
    const reasons = new Map<UngroundedReason, number>();
    for (const candidate of candidates) {
      const quote = mutation.quote ? mutation.quote(candidate.quote) : candidate.quote;
      const record = mutation.record ? mutation.record(candidate.record) : candidate.record;
      const activeCorpus = mutation.record ? corpusWithRecord(corpus, record) : corpus;
      const outcome = groundingOutcome(candidateFor(record, quote), activeCorpus);
      if (outcome.ok) admitted += 1;
      else reasons.set(outcome.reason, (reasons.get(outcome.reason) ?? 0) + 1);
    }
    rows.push({ name: mutation.name, admitted, reasons });
    const reasonText =
      reasons.size === 0
        ? "-"
        : Array.from(reasons.entries())
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .map(([reason, n]) => `${reason}=${n}`)
            .join(" ");
    console.log(
      `${mutation.name.padEnd(24)}${mutation.target.padEnd(16)}` +
        `${`${admitted}/${candidates.length}`.padEnd(11)}${reasonText.padEnd(24)}${mutation.note ?? ""}`,
    );
  }

  const tolerated = rows.filter((row) => row.admitted === candidates.length).map((row) => row.name);
  const refused = rows.filter((row) => row.admitted === 0).map((row) => row.name);
  console.log("");
  console.log(`fully tolerated: ${tolerated.join(", ") || "none"}`);
  console.log(`fully refused:   ${refused.join(", ") || "none"}`);
  return 0;
}

// ---------------------------------------------------------------------------
// replay — re-check a candidate the pipeline dropped (D-104)
// ---------------------------------------------------------------------------

function replayRecord(entry: RejectedCandidateRecord, index: number): boolean {
  const corpus = loadCorpus(entry.mechanism_id);
  const outcome = groundingOutcome(entry.item as DraftItem, corpus);
  const label = outcomeLabel(outcome);
  const agrees = !outcome.ok && outcome.reason === entry.reason;

  console.log(
    `${String(index + 1).padEnd(4)}${entry.pass.padEnd(8)}${(entry.corpus_record_id ?? "-").padEnd(28)}` +
      `${entry.reason.padEnd(22)}${label.padEnd(22)}${agrees ? "same" : "DIFFERS"}`,
  );
  if (!agrees) {
    console.log(`      persisted detail: ${entry.detail}`);
    if (!outcome.ok) console.log(`      replayed detail:  ${outcome.detail}`);
    if (entry.compared) {
      reportComparison(entry.compared.quote_raw, entry.compared.source_raw);
    }
  }
  return agrees;
}

function replay(path: string): number {
  const resolved = path.startsWith("/") ? path : join(ROOT, path);
  if (!existsSync(resolved)) throw new Error(`No rejection file at ${rel(resolved)}`);
  const file = JSON.parse(readFileSync(resolved, "utf8")) as RejectedCandidateFile;

  console.log(
    `PART 1 replay — ${file.rejected.length} persisted rejections from run ${file.run_id}` +
      `${file.dispatch_id ? ` (dispatch ${file.dispatch_id})` : ""}`,
  );
  console.log(`source: ${rel(resolved)}\n`);

  const header = `${"#".padEnd(4)}${"pass".padEnd(8)}${"record_id".padEnd(28)}${"persisted".padEnd(22)}${"replayed".padEnd(22)}verdict`;
  console.log(header);
  console.log("-".repeat(header.length));

  let differs = 0;
  for (let index = 0; index < file.rejected.length; index += 1) {
    if (!replayRecord(file.rejected[index], index)) differs += 1;
  }

  console.log("");
  if (differs > 0) {
    console.log(
      `${differs} of ${file.rejected.length} replayed to a different verdict — the corpus or the gate ` +
        "moved since the run.",
    );
    return 1;
  }
  console.log(`OK — all ${file.rejected.length} rejections reproduce offline.`);
  return 0;
}

// ---------------------------------------------------------------------------
// verify-spans — the independent witness for criterion (d)
// ---------------------------------------------------------------------------

/**
 * Re-slice every proposal's stored offsets and recheck the hash (D-110).
 *
 * Deliberately a SECOND implementation of the check the validator runs, and
 * deliberately arithmetic rather than search: it reads `[start,end)` out of the
 * file, cuts the corpus text itself, and compares bytes to the stored quote. It
 * never looks for the quote in the source, because finding it there would only
 * prove the string occurs somewhere — the question is whether the offsets the
 * proposal claims are the offsets the quote actually came from.
 *
 * The verdict is computed here from the corpus on disk, not read from any field
 * the pipeline wrote, so a bug in the writer cannot make its own output look
 * verified.
 */
function verifySpans(): number {
  const files = listProposalFiles(join(ROOT, "proposals"));
  console.log(`verify-spans — ${files.length} proposal file(s) under proposals/\n`);
  if (files.length === 0) {
    console.log("No proposals on disk yet, so there is nothing to verify (D-110).");
    return 0;
  }

  const header = `${"record_id".padEnd(28)}${"span".padEnd(16)}${"reslice".padEnd(10)}${"hash".padEnd(10)}proposal`;
  console.log(header);
  console.log("-".repeat(header.length));

  let checked = 0;
  let spanless = 0;
  let failures = 0;
  const corpora = new Map<string, EvidenceCorpusFile | null>();

  for (const file of files) {
    const proposal = JSON.parse(readFileSync(file, "utf8")) as {
      proposed_by?: string;
      provenance?: KnowledgeProvenanceItem[];
    };
    const extractionAuthored = isExtractionAuthored(proposal.proposed_by ?? "");
    for (const source of proposal.provenance ?? []) {
      if (isRealizationProvenance(source)) continue; // no span by design (D-110)
      if (isInferenceProvenance(source)) continue; // no span by declaration (D-112)
      if (!source.source_span) {
        spanless += 1;
        // Only a violation for pipeline output; hand-authored items predate spans.
        if (extractionAuthored) failures += 1;
        console.log(
          `${source.corpus_record_id.padEnd(28)}${"absent".padEnd(16)}${"—".padEnd(10)}${"—".padEnd(10)}${rel(file)}` +
            (extractionAuthored ? "  ← EXTRACTION-AUTHORED, span required" : "  (legacy)"),
        );
        continue;
      }
      const key = source.mechanism_id;
      if (!corpora.has(key)) {
        const path = join(CORPUS_DIR, `${key}.json`);
        corpora.set(
          key,
          existsSync(path)
            ? (JSON.parse(readFileSync(path, "utf8")) as EvidenceCorpusFile)
            : null,
        );
      }
      const record = corpora
        .get(key)
        ?.records.find((candidate) => candidate.record_id === source.corpus_record_id);
      const { start, end, source_text_sha256 } = source.source_span;
      if (!record) {
        failures += 1;
        console.log(
          `${source.corpus_record_id.padEnd(28)}${`[${start},${end})`.padEnd(16)}${"n/a".padEnd(10)}${"n/a".padEnd(10)}${rel(file)}  ← record not in corpus`,
        );
        continue;
      }
      checked += 1;
      const sourceText = evidenceSourceText(record);
      const inRange = start >= 0 && end > start && end <= sourceText.length;
      const resliced = inRange ? sourceText.slice(start, end) : null;
      const reslices = resliced === source.quote_or_locus;
      const hashMatches = sha256Hex(sourceText) === source_text_sha256;
      if (!reslices || !hashMatches) failures += 1;
      console.log(
        `${source.corpus_record_id.padEnd(28)}${`[${start},${end})`.padEnd(16)}` +
          `${(inRange ? (reslices ? "identical" : "DIFFERS") : "OUT OF RANGE").padEnd(10)}` +
          `${(hashMatches ? "match" : "STALE").padEnd(10)}${rel(file)}`,
      );
      if (inRange && !reslices) {
        console.log(`    stored quote: ${JSON.stringify(source.quote_or_locus)}`);
        console.log(`    re-sliced:    ${JSON.stringify(resliced)}`);
        console.log(`    first divergence at byte ${firstDivergence(source.quote_or_locus, resliced ?? "")}`);
      }
    }
  }

  console.log("");
  console.log(
    `${checked} span(s) re-sliced against the corpus on disk; ${spanless} evidence item(s) carry no span.`,
  );
  if (failures > 0) {
    console.log(
      `${failures} failure(s) — criterion (d) is NOT met: a stored span did not reproduce its own quote, ` +
        "its record is missing, or extraction-authored provenance shipped without offsets.",
    );
    return 1;
  }
  console.log(
    checked === 0
      ? "No spans to verify yet — criterion (d) is unproven rather than met."
      : "OK — every stored span re-slices to its own quote byte for byte, against text that still hashes to what the offsets were resolved on.",
  );
  return 0;
}

/** Byte index where two strings first differ; their common length when neither diverges. */
function firstDivergence(left: string, right: string): number {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return index;
  }
  return shared;
}

function listProposalFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listProposalFiles(path));
    } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".schema.json")) {
      out.push(path);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  npm run replay-grounding -- synth  [--mechanism CL-14] [--count 10]",
      "  npm run replay-grounding -- mutate [--mechanism CL-14] [--count 10]",
      "  npm run replay-grounding -- replay <path-to-rejected-file>",
      "  npm run replay-grounding -- verify-spans",
    ].join("\n"),
  );
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const mechanismId = flag(argv, "mechanism") ?? DEFAULT_MECHANISM;
  const count = Number(flag(argv, "count") ?? DEFAULT_COUNT);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("--count must be a positive integer");
  }

  switch (command) {
    case "synth":
      process.exitCode = synth(mechanismId, count);
      return;
    case "mutate":
      process.exitCode = mutate(mechanismId, count);
      return;
    case "replay": {
      const path = argv[1];
      if (!path) usage();
      process.exitCode = replay(path);
      return;
    }
    case "verify-spans":
      process.exitCode = verifySpans();
      return;
    default:
      usage();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

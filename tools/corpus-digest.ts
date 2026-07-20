/**
 * tools/corpus-digest.ts — the standard harvest -> record-drafting hand-off
 * (D-065). Reads a mechanism's evidence corpus from disk (NO network — this is
 * a reader, not a connector; rule 12 is untouched) and emits a compact,
 * human-readable digest: the top N works per evidence category plus the corpus
 * stats a drafter actually needs (record count, terms, pins resolved/unresolved,
 * snowball added, coverage note, category counts, diversity/novelty).
 *
 * The digest REPLACES the raw corpus file as the drafting input: a corpus file
 * is 280-370 records of full abstracts; the digest is the ~2-page projection an
 * author reads to write the record + dossier. The raw corpus stays on disk as
 * provenance.
 *
 * Inputs (all local):
 *   - /corpora/evidence/{id}.json                    — the harvest (EvidenceCorpusFile)
 *   - /registry/mechanisms/{id}.json  OR  _seed/{id}.json  — for pinned_evidence
 *     cross-check (declared pins vs pins that landed in the corpus)
 *
 * Output:
 *   - markdown to stdout
 *   - /corpora/evidence/digests/{id}.md
 *
 * Usage (from repo root):
 *   npm run digest -- PS-13
 *   npm run digest -- --all            # every corpus with a matching registry entry
 *   npm run digest -- PS-13 --top 20   # default --top 15
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  CategoryCounts,
  CorpusDigest,
  CorpusDigestEntry,
  CorpusDigestPins,
  EvidenceCategory,
  EvidenceCorpusFile,
  EvidenceCorpusRecord,
  PinnedEvidence,
} from "../lib/types";
import { EVIDENCE_CATEGORIES } from "../lib/types";

const ROOT = join(__dirname, "..");
const EVIDENCE_DIR = join(ROOT, "corpora", "evidence");
const DIGEST_DIR = join(EVIDENCE_DIR, "digests");
const MECHANISMS_DIR = join(ROOT, "registry", "mechanisms");
const SEED_DIR = join(MECHANISMS_DIR, "_seed");

const DEFAULT_TOP = 15;

function rel(p: string): string {
  return relative(ROOT, p) || p;
}

interface CliArgs {
  ids: string[];
  all: boolean;
  top: number;
}

function parseArgs(argv: string[]): CliArgs {
  const ids: string[] = [];
  let all = false;
  let top = DEFAULT_TOP;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--all") {
      all = true;
    } else if (token === "--top") {
      const next = argv[i + 1];
      const n = next ? Number.parseInt(next, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--top expects a positive integer, got "${next ?? ""}"`);
      }
      top = n;
      i += 1;
    } else if (token.startsWith("--")) {
      throw new Error(`unknown flag "${token}"`);
    } else {
      ids.push(token.toUpperCase());
    }
  }
  return { ids, all, top };
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

/** Registry entry (full record or seed stub) carrying optional pinned_evidence. */
interface RegistryEntry {
  name?: string;
  pinned_evidence?: PinnedEvidence[];
}

/** Resolve the registry entry for a mechanism: full record first, then stub. */
function readRegistryEntry(id: string): RegistryEntry | null {
  const full = join(MECHANISMS_DIR, `${id}.json`);
  if (existsSync(full)) return readJson<RegistryEntry>(full);
  const stub = join(SEED_DIR, `${id}.json`);
  if (existsSync(stub)) return readJson<RegistryEntry>(stub);
  return null;
}

/** Normalize a DOI for comparison: lowercase, strip URL prefix. */
function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "—";
  if (authors.length === 1) return authors[0];
  return `${authors[0]} et al.`;
}

/** Cross-check declared pins (registry) against pins that landed in the corpus. */
function computePins(
  entry: RegistryEntry | null,
  records: EvidenceCorpusRecord[],
): CorpusDigestPins {
  const declared = entry?.pinned_evidence ?? [];
  const corpusDois = new Set(
    records.filter((r) => r.doi).map((r) => normalizeDoi(r.doi as string)),
  );
  const missing: string[] = [];
  for (const pin of declared) {
    if (!corpusDois.has(normalizeDoi(pin.doi))) missing.push(pin.doi);
  }
  return {
    declared: declared.length,
    resolved: declared.length - missing.length,
    unresolved: missing.length,
    missing_dois: missing,
  };
}

/** Top N records in a category, ranked by citations (nulls last), then year. */
function topInCategory(
  records: EvidenceCorpusRecord[],
  category: EvidenceCategory,
  top: number,
): CorpusDigestEntry[] {
  return records
    .filter((r) => r.categories.includes(category))
    .sort((a, b) => {
      const ca = a.citations ?? -1;
      const cb = b.citations ?? -1;
      if (cb !== ca) return cb - ca;
      return (b.year ?? 0) - (a.year ?? 0);
    })
    .slice(0, top)
    .map((r) => ({
      title: r.title,
      authors: formatAuthors(r.authors),
      year: r.year,
      venue: r.venue,
      citations: r.citations,
      doi: r.doi,
      source_api: r.source_api,
      categories: r.categories,
      search_angles: r.search_angles ?? [],
    }));
}

function buildDigest(
  id: string,
  corpus: EvidenceCorpusFile,
  entry: RegistryEntry | null,
  top: number,
): CorpusDigest {
  const { records } = corpus;
  const topByCategory = Object.fromEntries(
    EVIDENCE_CATEGORIES.map((c) => [c, topInCategory(records, c, top)]),
  ) as Record<EvidenceCategory, CorpusDigestEntry[]>;
  const div = corpus.diversity_report;

  return {
    mechanism_id: id,
    name: entry?.name ?? id,
    fetched_at: corpus.fetched_at,
    record_count: records.length,
    terms: corpus.terms,
    query_count: corpus.queries.length,
    terms_source: corpus.terms_source,
    pins: computePins(entry, records),
    snowball_added: corpus.coverage_report.snowball_added,
    review_found: corpus.coverage_report.review_found,
    coverage_note: corpus.coverage_report.note ?? null,
    category_counts: corpus.category_counts,
    has_diversity: div !== undefined,
    recency_rate: div?.recency_rate ?? null,
    recent_records: div?.recent_records ?? null,
    novelty_rate: div?.novelty.novelty_rate ?? null,
    low_novelty: div?.novelty.low_novelty ?? null,
    viewpoint_spread: div?.viewpoint_spread ?? [],
    source_spread: div?.source_spread ?? [],
    top_by_category: topByCategory,
  };
}

function categoryCount(counts: CategoryCounts, category: EvidenceCategory): number {
  return counts[category] ?? 0;
}

function renderEntry(e: CorpusDigestEntry): string {
  const cites = e.citations == null ? "—" : `${e.citations} cites`;
  const year = e.year == null ? "n.d." : String(e.year);
  const venue = e.venue ? ` · ${e.venue}` : "";
  const doi = e.doi ? ` · doi:${e.doi}` : "";
  const cross = e.categories.length > 1 ? ` · also: ${e.categories.join(", ")}` : "";
  const angles = e.search_angles.length > 0 ? ` · angles: ${e.search_angles.join(", ")}` : "";
  const src = e.source_api !== "openalex" && e.source_api !== "semantic-scholar" ? ` · **${e.source_api}**` : "";
  return `- **${e.title}** — ${e.authors} (${year})${venue} · ${cites}${doi}${src}${cross}${angles}`;
}

function renderMarkdown(d: CorpusDigest, top: number): string {
  const lines: string[] = [];
  lines.push(`# Corpus digest — ${d.mechanism_id} · ${d.name}`);
  lines.push("");
  lines.push(
    "Standard harvest -> record-drafting hand-off (D-065). Generated by " +
      "`tools/corpus-digest.ts` from the local corpus; no network, no science added. " +
      "Ranking within each category is by citation count.",
  );
  lines.push("");

  lines.push("## Corpus stats");
  lines.push("");
  lines.push(`- Records: **${d.record_count}**`);
  lines.push(`- Harvested: ${d.fetched_at}`);
  lines.push(`- Terms source: ${d.terms_source}`);
  lines.push(`- Terms (${d.terms.length}): ${d.terms.map((t) => `\`${t}\``).join(", ")}`);
  lines.push(`- Queries run: ${d.query_count}`);
  lines.push(
    `- Pins: ${d.pins.resolved}/${d.pins.declared} resolved` +
      (d.pins.unresolved > 0
        ? ` · **${d.pins.unresolved} unresolved**: ${d.pins.missing_dois.map((doi) => `doi:${doi}`).join(", ")}`
        : ""),
  );
  lines.push(
    `- Snowball added: ${d.snowball_added} · review anchor ${d.review_found ? "found" : "**none**"}`,
  );
  if (d.coverage_note) lines.push(`  - note: ${d.coverage_note}`);
  if (d.has_diversity) {
    lines.push(
      `- Novelty: ${d.novelty_rate} (${d.low_novelty ? "**low-novelty**" : "novel"}) · ` +
        `recency ${d.recency_rate} (${d.recent_records} recent)`,
    );
  } else {
    lines.push("- Novelty/recency: not recorded (pre-D-058 harvest)");
  }
  lines.push("");

  lines.push("### Category counts");
  lines.push("");
  lines.push("| category | count |");
  lines.push("|----------|-------|");
  for (const c of EVIDENCE_CATEGORIES) {
    lines.push(`| ${c} | ${categoryCount(d.category_counts, c)} |`);
  }
  lines.push("");

  if (d.has_diversity) {
    lines.push("### Diversity");
    lines.push("");
    lines.push(
      "- Viewpoint spread: " +
        d.viewpoint_spread.map((v) => `${v.angle} ${v.unique_records}`).join(" · "),
    );
    lines.push(
      "- Source spread: " +
        d.source_spread.map((s) => `${s.api} ${s.unique_records}`).join(" · "),
    );
    lines.push("");
  }

  lines.push(`## Top ${top} per category`);
  lines.push("");
  for (const c of EVIDENCE_CATEGORIES) {
    const entries = d.top_by_category[c];
    lines.push(`### ${c} (${categoryCount(d.category_counts, c)} total)`);
    lines.push("");
    if (entries.length === 0) {
      lines.push("_No records in this category._");
    } else {
      for (const e of entries) lines.push(renderEntry(e));
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/** Every mechanism id that has both a corpus file and a registry entry. */
function discoverIds(): string[] {
  if (!existsSync(EVIDENCE_DIR)) return [];
  return readdirSync(EVIDENCE_DIR)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .map((f) => f.replace(/\.json$/, ""))
    .filter((id) => /^[A-Z]{2}-\d{2}$/.test(id) && readRegistryEntry(id) !== null)
    .sort();
}

function digestOne(id: string, top: number): boolean {
  const corpusPath = join(EVIDENCE_DIR, `${id}.json`);
  if (!existsSync(corpusPath)) {
    console.error(`SKIP ${id} — no corpus at ${rel(corpusPath)}`);
    return false;
  }
  const corpus = readJson<EvidenceCorpusFile>(corpusPath);
  const entry = readRegistryEntry(id);
  if (!entry) {
    console.error(`WARN ${id} — no registry record/stub found; pins not cross-checked.`);
  }

  const digest = buildDigest(id, corpus, entry, top);
  const markdown = renderMarkdown(digest, top);

  mkdirSync(DIGEST_DIR, { recursive: true });
  const outPath = join(DIGEST_DIR, `${id}.md`);
  writeFileSync(outPath, markdown, "utf-8");

  process.stdout.write(markdown);
  console.error(
    `OK ${id} — ${digest.record_count} records → ${rel(outPath)} ` +
      `(pins ${digest.pins.resolved}/${digest.pins.declared}, snowball ${digest.snowball_added})`,
  );
  return true;
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR — ${(err as Error).message}`);
    console.error("Usage: npm run digest -- <MECHANISM-ID> [--top N] | --all");
    process.exit(1);
    return;
  }

  const ids = args.all ? discoverIds() : args.ids;
  if (ids.length === 0) {
    console.error(
      args.all
        ? "ERROR — no corpora with a matching registry entry under corpora/evidence/."
        : "ERROR — pass at least one mechanism id, e.g. `npm run digest -- PS-13`, or --all.",
    );
    process.exit(1);
    return;
  }

  let ok = 0;
  for (const id of ids) {
    if (digestOne(id, args.top)) ok += 1;
  }

  console.error(`\nDone — ${ok}/${ids.length} digest(s) written to ${rel(DIGEST_DIR)}.`);
  if (ok < ids.length) process.exit(1);
}

main();

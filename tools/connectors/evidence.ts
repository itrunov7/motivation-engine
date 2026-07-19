/**
 * tools/connectors/evidence.ts — Connector #1: the science pipeline.
 *
 * Harvests the published literature for one mechanism from two D-011
 * whitelisted APIs (source_ids: openalex, semantic-scholar) into a merged,
 * readable evidence file: /corpora/evidence/{mechanism_id}.json.
 *
 * Usage:
 *   npm run connector -- evidence mechanism=LA-01
 *   npm run connector -- evidence mechanism=LA-01 terms="loss aversion;endowment effect"
 *
 * Search terms are per-mechanism DATA, not hardcoded params (D-015): the
 * connector reads them from the record's evidence_terms[], falling back to
 * [name] for records without the field. A generic term harvests only
 * confirming mainstream literature; dissent and boundary-condition papers
 * require targeted terms — a corpus that can only confirm is broken. An
 * optional terms="a;b" param overrides the record for ad-hoc runs.
 *
 * Per search term:
 * - OpenAlex /works: title/abstract match, sorted by cited_by_count, top 25.
 *   A cross-attribute OR (type:review|meta-analysis OR text match) is not
 *   expressible in a single OpenAlex filter; the citation sort surfaces
 *   reviews and meta-analyses at the top of the text match anyway.
 * - Semantic Scholar /graph/v1/paper/search: relevance search, top 15.
 *   Sends x-api-key when the S2_API_KEY env var is set (D-018). The issued
 *   key allows 1 request/second CUMULATIVE across all endpoints, so every
 *   S2 request goes through the global per-process queue in lib/http.ts
 *   (≥1100ms spacing, never parallelized; 429s despite the limiter back
 *   off from 2s) — see D-027. Any S2 429 records
 *   warnings.s2_throttled: true in the manifest; keyless runs additionally
 *   degrade gracefully: per-term batch drops to 10 for the retry passes
 *   (exponential cooldowns: 30s, 60s, 120s).
 *
 * Diversity + novelty (D-058) — a harvest optimizes for BROADER data, not more
 * of the same. Each term fans out across viewpoints: "canon" (the term as-is,
 * most-cited / relevance), "recent" (OpenAlex sorted by date so newer product
 * forms aren't starved), and five contrast angles (application, critique,
 * replication, boundary, cross-domain) whose generic academic suffixes steer
 * the query — never invented science (rule 8). The contrast angles ALTERNATE
 * OpenAlex / Semantic Scholar so a run draws across both sources. After dedupe,
 * a novelty check against the PREVIOUS corpus flags a re-fetch of the same
 * canon as low_novelty (>LOW_NOVELTY_KNOWN_SHARE already on disk) — a warning
 * in the manifest so the maturation loop does not count re-reading as progress.
 * Every harvest writes a diversity_report (viewpoint spread, source spread,
 * recency, novelty rate).
 *
 * Records are deduplicated by DOI AND normalized title (lowercase, punctuation
 * and asterisks stripped), keeping the highest-citation variant of each paper.
 *
 * Pinned evidence (D-017): the record's pinned_evidence[] lists works the
 * search cannot reliably surface (low-citation boundary/dissent papers).
 * Each pin is fetched from OpenAlex by DOI and merged into the output with
 * source_api "pinned" (a pin overlapping a harvested record wins source_api
 * so the owner's intent stays visible). The connector harvests breadth; the
 * owner pins the tail — 100% recall is a human+machine contract, not a
 * query-tuning goal.
 *
 * Structural completeness (D-019) — v2 verifies the corpus without knowing
 * the answers in advance:
 * - Snowballing: the top 2 review/meta-analysis records (OpenAlex type +
 *   title keywords, by citations) have their referenced_works fetched from
 *   OpenAlex — DELIBERATELY OpenAlex, never Semantic Scholar: OpenAlex
 *   carries the same citation graph without S2's 1 rps cumulative ceiling
 *   (D-027), so reference expansion stays off the S2 budget entirely;
 *   coverage = share of each review's references already in the
 *   corpus; references missing from the corpus that appear in ≥2 reviews'
 *   lists are auto-added with source_api "snowball". The coverage_report is
 *   written into the output file.
 * - Category checklist: every record is classified into the (non-exclusive)
 *   categories foundational / meta-analysis / replication / dissent / recent
 *   using METADATA ONLY (type, title, abstract, year, citations, pin_reason).
 *   Per-category counts go into the output file and the corpus manifest; an
 *   empty category is a structural gap the cockpit flags.
 *
 * Fetch and structure ONLY — no scoring, no "quality" filtering, no summaries.
 * What the canon says is for the dossier process to weigh, not this script.
 *
 * Anti-regression guardrail (D-038): a re-harvest that yields FEWER records
 * than the existing corpus (a dropped evidence_terms and name-only fallback, an
 * upstream outage, a throttled partial) never overwrites the good file. The run
 * writes {mechanism_id}.regression.json instead, returns status "partial" with
 * warnings.regression_suspected, and keeps the prior corpus for review.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_CATEGORIES,
  type CategoryCounts,
  type Connector,
  type EvidenceCategory,
  type PoliteFetch,
  type RunQuote,
  type RunResult,
} from "./types";

const MECHANISMS_DIR = join(__dirname, "..", "..", "registry", "mechanisms");

const OPENALEX_PER_TERM = 25;
const S2_PER_TERM = 15;

/** Keyless S2 degradation (D-018): reduced per-term batch after a 429. */
const S2_THROTTLED_PER_TERM = 10;

/** Base cooldown before retrying failed terms; doubles per pass
 *  (exponential backoff: 30s, 60s, 120s). */
const RETRY_COOLDOWN_MS = 30_000;

/** Max cooldown-and-retry passes for failed queries. */
const MAX_RETRY_PASSES = 3;

/** How many review/meta-analysis records get their references snowballed. */
const SNOWBALL_TOP_REVIEWS = 2;

/** A snowball candidate must appear in at least this many reviews' lists. */
const SNOWBALL_MIN_REVIEWS = 2;

/** A snowball anchor must cite at least this many works — a real review, not
 *  a short commentary or editorial (D-034). */
const SNOWBALL_MIN_REFERENCES = 20;

/** Topical concentration: distinct core keywords a review's abstract must
 *  contain to count as on-topic (its title must contain ≥1 already) (D-034). */
const TOPICAL_ABSTRACT_MIN_KEYWORDS = 2;

/** OpenAlex OR-filter cap: batch size for resolving referenced works. */
const OPENALEX_BATCH_SIZE = 50;

// ---------- Dry-run quote estimate params (D-025) ----------
// The quote is DETERMINISTIC and makes ZERO network calls — it estimates from
// the record's terms/pins and the polite spacing only. Snowballing depends on
// the (unknown-until-run) reference graph, so it is a fixed conservative
// allowance rather than a guess per review.

/** Polite spacing for non-S2 calls (run-connector minIntervalMs = 1000ms). */
const QUOTE_POLITE_INTERVAL_S = 1.0;
/** S2 cumulative spacing (≥1100ms per key, D-027). */
const QUOTE_S2_INTERVAL_S = 1.1;
/** Fixed OpenAlex allowance for snowball reference resolution (batched). */
const QUOTE_SNOWBALL_CALLS = 4;
/** Fixed record allowance the snowball pass may add (one OR-batch worth). */
const QUOTE_SNOWBALL_RECORDS = OPENALEX_BATCH_SIZE;

// ---------- Output shape (/corpora/evidence/{mechanism_id}.json) ----------

type SearchApi = "openalex" | "semantic-scholar";
type SourceApi = SearchApi | "pinned" | "snowball";

/**
 * Search angle (D-058): a harvest fans each term out across contrasting
 * viewpoints so the corpus is not mono-viewpoint. "canon" is the term as-is
 * (mainstream, most-cited); "recent" re-queries it sorted by date so newer
 * product forms aren't starved by citation sort; the five contrast angles
 * append generic academic vocabulary (a documented constant, like
 * DISSENT_MARKERS — never invented science) to surface application, critique,
 * replication, boundary-condition, and cross-domain work.
 */
type SearchAngle =
  | "canon"
  | "recent"
  | "application"
  | "critique"
  | "replication"
  | "boundary"
  | "cross-domain";

/** Every angle, in report/display order. */
const ALL_ANGLES: SearchAngle[] = [
  "canon",
  "recent",
  "application",
  "critique",
  "replication",
  "boundary",
  "cross-domain",
];

const SEARCH_APIS: SearchApi[] = ["openalex", "semantic-scholar"];

/**
 * The five contrast angles and the generic vocabulary appended to a term to
 * express each viewpoint. NOT science (rule 8) — the same documented-constant
 * pattern as DISSENT_MARKERS; these words steer WHICH slice of the literature
 * a query surfaces, never what the evidence says.
 */
const CONTRAST_ANGLES: { angle: SearchAngle; suffix: string }[] = [
  { angle: "application", suffix: "applied intervention" },
  { angle: "critique", suffix: "critique criticism" },
  { angle: "replication", suffix: "replication" },
  { angle: "boundary", suffix: "boundary conditions moderators" },
  { angle: "cross-domain", suffix: "cross-domain generalization" },
];

/** Per-term batch for the recency query and each contrast-angle query. */
const RECENT_PER_TERM = 10;
const CONTRAST_PER_TERM = 10;

/**
 * Source spread (D-058): the contrast angles ALTERNATE OpenAlex / Semantic
 * Scholar by index so a run's viewpoint diversity draws across both APIs, not
 * one — even index → OpenAlex, odd → Semantic Scholar.
 */
function contrastApi(index: number): SearchApi {
  return index % 2 === 0 ? "openalex" : "semantic-scholar";
}

/** Contrast angles routed to each API (derived from contrastApi, quote-safe). */
const CONTRAST_OPENALEX_COUNT = CONTRAST_ANGLES.filter(
  (_, i) => contrastApi(i) === "openalex",
).length;
const CONTRAST_S2_COUNT = CONTRAST_ANGLES.length - CONTRAST_OPENALEX_COUNT;

/**
 * Novelty gate (D-058): a harvest whose deduped results are more than this
 * share already-in-corpus is LOW-NOVELTY — it re-fetched the canon it already
 * had and must not count as progress (the loop would otherwise think it filled
 * a gap by re-reading the same papers).
 */
const LOW_NOVELTY_KNOWN_SHARE = 0.8;

interface EvidenceRecord {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  citations: number | null;
  abstract: string | null;
  /** OpenAlex work id ("W…"); null for records only seen on other APIs. */
  openalex_id: string | null;
  /** OpenAlex work type (e.g. "article", "review"); null when unknown. */
  openalex_type: string | null;
  /** OpenAlex outgoing reference count; null for non-OpenAlex records. Used to
   *  gate snowball anchors: a real review cites many works (D-034). */
  referenced_works_count: number | null;
  /** Category checklist (D-019): non-exclusive, metadata-only classification. */
  categories: EvidenceCategory[];
  source_api: SourceApi;
  /** Only on owner-pinned records (D-017): why this work is pinned. */
  pin_reason?: string;
  /** Only on a pinned record whose DOI did NOT resolve on OpenAlex: the pin
   *  still enters the corpus with owner-provided metadata, flagged so the
   *  owner can correct the DOI — a dead pin is a recorded finding, not a run
   *  failure. */
  pin_unresolved?: boolean;
  /** Only on snowballed records (D-019): OpenAlex ids of the reviews whose
   *  reference lists surfaced this work. */
  snowball_from?: string[];
  /** Search angles whose queries surfaced this record (D-058), unioned across
   *  the dedup cluster. Absent on pinned/snowball records (they are not the
   *  product of an angle query). */
  search_angles?: SearchAngle[];
}

interface QueryMeta {
  api: SearchApi;
  /** The viewpoint this query targeted (D-058). */
  angle: SearchAngle;
  term: string;
  requested: number;
  returned: number;
}

/** One planned search query — one (api, angle, term) triple. */
interface QueryTask {
  api: SearchApi;
  angle: SearchAngle;
  /** The query string actually sent (a contrast angle appends its suffix). */
  term: string;
  /** Planned batch size; for the throttleable canon S2 query the keyless 429
   *  path may reduce it at run time. */
  limit: number;
  /** OpenAlex sort override; unused for Semantic Scholar. */
  sort?: string;
  /** True only for the canon Semantic Scholar query (keyless throttle path). */
  throttleable: boolean;
  meta: QueryMeta;
  records: EvidenceRecord[];
  error?: string;
}

type TermsSource = "param" | "record" | "name";

/** Per-review snowball outcome (D-019). */
interface ReviewCoverage {
  title: string;
  doi: string | null;
  openalex_id: string;
  citations: number | null;
  references_total: number;
  references_resolved: number;
  references_in_corpus: number;
  /** references_in_corpus / references_resolved, 4 decimals; null if the
   *  review resolved no references. */
  coverage: number | null;
}

interface CoverageReport {
  /** Whether any review passed topical + type + reference-count validation
   *  (D-034). When false, reviews is empty and no anchor was chosen — an
   *  honest empty state rather than a garbage anchor. */
  review_found: boolean;
  reviews: ReviewCoverage[];
  snowball_added: number;
  /** Honest caveat when fewer reviews were snowballed than planned. */
  note?: string;
}

/** Per-angle query outcome + unique deduped records surfaced (D-058). */
interface AngleSpread {
  angle: SearchAngle;
  queries: number;
  returned: number;
  /** Unique deduped SEARCH records attributable to this angle. */
  unique_records: number;
}

/** Per-API query outcome + unique deduped records the API contributed (D-058). */
interface SourceSpread {
  api: SearchApi;
  queries: number;
  returned: number;
  unique_records: number;
}

/**
 * Dedup-aware novelty vs the PREVIOUS corpus (D-058). A harvest that mostly
 * re-fetches records already on disk is low-novelty and must not count as
 * progress. First harvest (no prior file): novelty_rate 1, never low.
 */
interface NoveltyReport {
  /** Record count of the prior corpus file; null on a first harvest. */
  previous_corpus_records: number | null;
  /** Unique deduped SEARCH records this run (pins/snowball excluded). */
  unique_records: number;
  already_in_corpus: number;
  new_records: number;
  /** new_records / unique_records, 4 decimals; 1 when there was no prior corpus. */
  novelty_rate: number;
  /** True when >LOW_NOVELTY_KNOWN_SHARE of unique results were already on disk. */
  low_novelty: boolean;
  known_share_threshold: number;
}

/**
 * Diversity report (D-058): whether a harvest broadened the corpus. Computed
 * over the deduped SEARCH records only (owner pins and snowballed references
 * are structural completeness, not query diversity).
 */
interface DiversityReport {
  viewpoint_spread: AngleSpread[];
  source_spread: SourceSpread[];
  /** Unique deduped search records published within RECENT_WINDOW_YEARS. */
  recent_records: number;
  /** recent_records / unique deduped search records, 4 decimals. */
  recency_rate: number;
  novelty: NoveltyReport;
}

interface EvidenceFile {
  mechanism_id: string;
  fetched_at: string;
  /** Where the search terms came from: the record's evidence_terms, the
   *  record name fallback, or a terms= param override. */
  terms_source: TermsSource;
  terms: string[];
  queries: QueryMeta[];
  coverage_report: CoverageReport;
  /** Category checklist counts (D-019), computed from records[].categories. */
  category_counts: CategoryCounts;
  /** Diversity + novelty accounting for this harvest (D-058). */
  diversity_report: DiversityReport;
  records: EvidenceRecord[];
}

// ---------- Upstream response shapes (only the fields we read) ----------

interface OpenAlexWork {
  id: string | null;
  type: string | null;
  doi: string | null;
  title: string | null;
  display_name: string | null;
  publication_year: number | null;
  cited_by_count: number | null;
  authorships: { author?: { display_name?: string | null } }[] | null;
  primary_location: { source?: { display_name?: string | null } | null } | null;
  abstract_inverted_index: Record<string, number[]> | null;
  referenced_works_count: number | null;
}

interface S2Paper {
  title: string | null;
  authors: { name?: string | null }[] | null;
  year: number | null;
  venue: string | null;
  citationCount: number | null;
  abstract: string | null;
  externalIds: { DOI?: string | null } | null;
}

// ---------- Normalization helpers ----------

/** "https://openalex.org/W2059372910" → "W2059372910". */
function normalizeOpenAlexId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw.trim().replace(/^https?:\/\/openalex\.org\//i, "").toUpperCase();
  return /^W\d+$/.test(id) ? id : null;
}

/** "https://doi.org/10.1037/…" / "DOI:10.1037/…" → "10.1037/…" (lowercase). */
function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const doi = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .toLowerCase();
  return doi.startsWith("10.") ? doi : null;
}

/** Normalized title: lowercase, punctuation and asterisks stripped. */
function titleKey(record: EvidenceRecord): string {
  return record.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** OpenAlex ships abstracts as {word: [positions]}; rebuild the text. */
function reconstructAbstract(
  index: Record<string, number[]> | null,
): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) words[pos] = word;
  }
  const text = words.filter(Boolean).join(" ").trim();
  return text.length > 0 ? text : null;
}

/**
 * Collapse one cluster of duplicate records (same DOI or same normalized
 * title) into one: the highest-citation variant is the base, and any field
 * it is missing is filled from the others.
 */
function mergeCluster(group: EvidenceRecord[]): EvidenceRecord {
  const cites = (r: EvidenceRecord): number => r.citations ?? -1;
  const base: EvidenceRecord = {
    ...group.reduce((best, r) => {
      if (cites(r) > cites(best)) return r;
      if (cites(r) === cites(best) && !best.doi && r.doi) return r;
      return best;
    }),
  };
  const angles = new Set<SearchAngle>();
  for (const r of group) {
    base.doi = base.doi ?? r.doi;
    base.year = base.year ?? r.year;
    base.venue = base.venue ?? r.venue;
    base.citations = base.citations ?? r.citations;
    base.abstract = base.abstract ?? r.abstract;
    base.openalex_id = base.openalex_id ?? r.openalex_id;
    base.openalex_type = base.openalex_type ?? r.openalex_type;
    base.referenced_works_count = base.referenced_works_count ?? r.referenced_works_count;
    if (base.authors.length === 0) base.authors = r.authors;
    for (const a of r.search_angles ?? []) angles.add(a);
  }
  // Union the angles that surfaced any variant of this paper (D-058).
  if (angles.size > 0) {
    base.search_angles = ALL_ANGLES.filter((a) => angles.has(a));
  }
  return base;
}

/**
 * Deduplicate by DOI AND normalized title, keeping the highest-citation
 * variant of each paper. Two records are the same paper if they share a DOI
 * or a normalized title; union-find groups the transitive clusters (a paper
 * seen with a DOI on one API and without on another still collapses).
 *
 * Returns the merged records AND the raw clusters they came from (aligned by
 * index) so the diversity report (D-058) can attribute each unique record to
 * the angles and APIs that surfaced it.
 */
function dedupeRecords(raw: EvidenceRecord[]): {
  records: EvidenceRecord[];
  groups: EvidenceRecord[][];
} {
  const parent = raw.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) [x, parent[x]] = [parent[x], root];
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const firstByDoi = new Map<string, number>();
  const firstByTitle = new Map<string, number>();
  const firstByOpenAlexId = new Map<string, number>();
  raw.forEach((record, i) => {
    if (record.doi) {
      const seen = firstByDoi.get(record.doi);
      if (seen !== undefined) union(seen, i);
      else firstByDoi.set(record.doi, i);
    }
    if (record.openalex_id) {
      const seen = firstByOpenAlexId.get(record.openalex_id);
      if (seen !== undefined) union(seen, i);
      else firstByOpenAlexId.set(record.openalex_id, i);
    }
    const key = titleKey(record);
    if (key) {
      const seen = firstByTitle.get(key);
      if (seen !== undefined) union(seen, i);
      else firstByTitle.set(key, i);
    }
  });

  const clusters = new Map<number, EvidenceRecord[]>();
  raw.forEach((record, i) => {
    const root = find(i);
    const group = clusters.get(root) ?? [];
    group.push(record);
    clusters.set(root, group);
  });

  const groups = Array.from(clusters.values());
  return { records: groups.map(mergeCluster), groups };
}

// ---------- Per-API fetchers ----------

async function fetchJson<T>(fetch: PoliteFetch, url: URL, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url.hostname}${url.pathname}`);
  }
  return (await response.json()) as T;
}

const OPENALEX_SELECT =
  "id,type,doi,title,display_name,publication_year,cited_by_count,authorships,primary_location,abstract_inverted_index,referenced_works_count";

function fromOpenAlexWork(work: OpenAlexWork, sourceApi: SourceApi): EvidenceRecord | null {
  const title = work.title ?? work.display_name;
  if (!title) return null;
  return {
    title,
    authors: (work.authorships ?? [])
      .map((a) => a.author?.display_name ?? "")
      .filter((name) => name.length > 0),
    year: work.publication_year ?? null,
    venue: work.primary_location?.source?.display_name ?? null,
    doi: normalizeDoi(work.doi),
    citations: work.cited_by_count ?? null,
    abstract: reconstructAbstract(work.abstract_inverted_index),
    openalex_id: normalizeOpenAlexId(work.id),
    openalex_type: work.type ?? null,
    referenced_works_count: work.referenced_works_count ?? null,
    categories: [],
    source_api: sourceApi,
  };
}

async function searchOpenAlex(
  fetch: PoliteFetch,
  term: string,
  sort = "cited_by_count:desc",
  limit = OPENALEX_PER_TERM,
): Promise<EvidenceRecord[]> {
  const url = new URL("https://api.openalex.org/works");
  // Commas separate OpenAlex filters — strip them from the term defensively.
  url.searchParams.set("filter", `title_and_abstract.search:${term.replace(/,/g, " ")}`);
  url.searchParams.set("sort", sort);
  url.searchParams.set("per-page", String(limit));
  url.searchParams.set("select", OPENALEX_SELECT);

  const data = await fetchJson<{ results?: OpenAlexWork[] }>(fetch, url);
  return (data.results ?? []).flatMap((work) => {
    const record = fromOpenAlexWork(work, "openalex");
    return record ? [record] : [];
  });
}

/**
 * Fetch one owner-pinned work from OpenAlex by DOI (D-017). If the lookup
 * fails, the pin still enters the corpus with the owner-provided title/doi —
 * a pin is a contract, not a best-effort suggestion.
 */
async function fetchPinnedWork(
  fetch: PoliteFetch,
  pin: PinnedEvidence,
  log: (message: string) => void,
): Promise<EvidenceRecord> {
  const fallback: EvidenceRecord = {
    title: pin.title,
    authors: [],
    year: null,
    venue: null,
    doi: normalizeDoi(pin.doi),
    citations: null,
    abstract: null,
    openalex_id: null,
    openalex_type: null,
    referenced_works_count: null,
    categories: [],
    source_api: "pinned",
    pin_reason: pin.reason,
    pin_unresolved: true,
  };
  try {
    const url = new URL(`https://api.openalex.org/works/https://doi.org/${pin.doi}`);
    url.searchParams.set("select", OPENALEX_SELECT);
    const work = await fetchJson<OpenAlexWork>(fetch, url);
    const record = fromOpenAlexWork(work, "pinned");
    if (!record) return fallback;
    log(`pinned "${pin.doi}": resolved via OpenAlex (${record.citations ?? "?"} citations)`);
    return { ...record, doi: record.doi ?? fallback.doi, pin_reason: pin.reason };
  } catch (err) {
    log(`pinned "${pin.doi}": OpenAlex lookup failed (${(err as Error).message}) — using owner-provided metadata`);
    return fallback;
  }
}

/**
 * Optional Semantic Scholar API key (D-018): authenticated clients get
 * materially higher rate limits. Keyless works but shares a contended
 * public pool that 429s in bursts.
 */
function s2ApiKey(): string | undefined {
  const key = process.env.S2_API_KEY;
  return key && key.length > 0 ? key : undefined;
}

async function searchSemanticScholar(
  fetch: PoliteFetch,
  term: string,
  limit: number,
): Promise<EvidenceRecord[]> {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", term);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", "title,authors,year,venue,externalIds,citationCount,abstract");

  const apiKey = s2ApiKey();
  const data = await fetchJson<{ data?: S2Paper[] }>(
    fetch,
    url,
    apiKey ? { "x-api-key": apiKey } : undefined,
  );
  return (data.data ?? []).flatMap((paper) => {
    if (!paper.title) return [];
    return [
      {
        title: paper.title,
        authors: (paper.authors ?? [])
          .map((a) => a.name ?? "")
          .filter((name) => name.length > 0),
        year: paper.year ?? null,
        venue: paper.venue && paper.venue.length > 0 ? paper.venue : null,
        doi: normalizeDoi(paper.externalIds?.DOI),
        citations: paper.citationCount ?? null,
        abstract: paper.abstract ?? null,
        openalex_id: null,
        openalex_type: null,
        referenced_works_count: null,
        categories: [] as EvidenceCategory[],
        source_api: "semantic-scholar" as const,
      },
    ];
  });
}

// ---------- Category checklist (D-019) ----------
//
// Structural classification on METADATA ONLY — the connector never judges
// scientific content. Categories are non-exclusive; a record may have none.

/** "foundational" threshold: citation count of a field-anchoring work. */
const FOUNDATIONAL_MIN_CITATIONS = 1000;

/** "recent" window: published within the last N years. */
const RECENT_WINDOW_YEARS = 5;

/** Review/meta-analysis signal in a title. */
const META_ANALYSIS_TITLE = /\bmeta-?analy|systematic review/i;

/** Replication signal in a title or abstract. */
const REPLICATION_MARKERS = /\breplicat/i;

/**
 * Disconfirmation markers: text patterns of papers that push back on a
 * mainstream claim. A documented constant, not a hidden judgment — records
 * matching none of these in title/abstract/pin_reason are not dissent.
 */
const DISSENT_MARKERS =
  /\bfail(s|ed|ure)? to\b|\bno evidence\b|\babsence of\b|\bdoes not\b|\bnot replicate\b|critique|\bquestion(s|ing)?\b|reconsider|overestimat|publication bias|boundary condition/i;

function isReviewLike(record: EvidenceRecord): boolean {
  return record.openalex_type === "review" || META_ANALYSIS_TITLE.test(record.title);
}

/**
 * Generic tokens that appear across many mechanisms' evidence_terms and would
 * cause topical collisions (a dopamine review matching "reward", an endowment
 * review matching "effect"). Dropped when deriving distinctive core keywords.
 */
const GENERIC_TERM_TOKENS = new Set([
  "effect",
  "effects",
  "meta",
  "analysis",
  "analyses",
  "replication",
  "gap",
  "hypothesis",
  "motivation",
  "willingness",
  "accept",
  "theory",
  "model",
  "review",
  "systematic",
]);

/**
 * Distinctive core keywords for topical validation (D-034): tokens from the
 * mechanism's evidence_terms, lowercased, with generic academic words and
 * short tokens (<4 chars) dropped so only mechanism-specific words remain
 * (e.g. "endowment", "zeigarnik", "reinforcement", "dopamine").
 */
function coreKeywords(terms: string[]): string[] {
  const keys = new Set<string>();
  for (const term of terms) {
    for (const token of term.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 4 && !GENERIC_TERM_TOKENS.has(token)) keys.add(token);
    }
  }
  return Array.from(keys);
}

/** Count the distinct core keywords present as whole words in `text`. */
function countCoreKeywords(text: string, keys: string[]): number {
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9]+/));
  return keys.filter((key) => tokens.has(key)).length;
}

/**
 * A review is on-topic (D-034) only if a distinctive core keyword appears in
 * its TITLE and at least TOPICAL_ABSTRACT_MIN_KEYWORDS distinct core keywords
 * appear in its ABSTRACT — a title-keyword collision (e.g. a c-fos or
 * default-mode review sharing one word) cannot qualify. A record with no
 * abstract cannot be validated and is rejected as an anchor.
 */
function isTopicalReview(record: EvidenceRecord, keys: string[]): boolean {
  if (keys.length === 0 || !record.abstract) return false;
  return (
    countCoreKeywords(record.title, keys) >= 1 &&
    countCoreKeywords(record.abstract, keys) >= TOPICAL_ABSTRACT_MIN_KEYWORDS
  );
}

function classifyRecord(record: EvidenceRecord, currentYear: number): EvidenceCategory[] {
  const titleAbstract = `${record.title} ${record.abstract ?? ""}`;
  const dissentText = `${titleAbstract} ${record.pin_reason ?? ""}`;
  const matches: Record<EvidenceCategory, boolean> = {
    foundational:
      record.citations !== null && record.citations >= FOUNDATIONAL_MIN_CITATIONS,
    "meta-analysis": isReviewLike(record),
    replication: REPLICATION_MARKERS.test(titleAbstract),
    dissent: DISSENT_MARKERS.test(dissentText),
    recent:
      record.year !== null && record.year >= currentYear - RECENT_WINDOW_YEARS,
  };
  return EVIDENCE_CATEGORIES.filter((category) => matches[category]);
}

function countCategories(records: EvidenceRecord[]): CategoryCounts {
  const counts = Object.fromEntries(
    EVIDENCE_CATEGORIES.map((category) => [category, 0]),
  ) as CategoryCounts;
  for (const record of records) {
    for (const category of record.categories) counts[category]++;
  }
  return counts;
}

// ---------- Snowballing (D-019) ----------

/** Membership index over the corpus: openalex_id, DOI, normalized title. */
function corpusKeys(records: EvidenceRecord[]): {
  ids: Set<string>;
  dois: Set<string>;
  titles: Set<string>;
} {
  const ids = new Set<string>();
  const dois = new Set<string>();
  const titles = new Set<string>();
  for (const record of records) {
    if (record.openalex_id) ids.add(record.openalex_id);
    if (record.doi) dois.add(record.doi);
    const key = titleKey(record);
    if (key) titles.add(key);
  }
  return { ids, dois, titles };
}

/**
 * Resolve OpenAlex work metadata for "W…" ids in batches of ≤50, filling
 * (and reusing) the given cache so an id is never fetched twice per run.
 */
async function fetchWorksByIds(
  fetch: PoliteFetch,
  ids: string[],
  cache: Map<string, EvidenceRecord>,
): Promise<void> {
  const unfetched = Array.from(new Set(ids)).filter((id) => !cache.has(id));
  for (let i = 0; i < unfetched.length; i += OPENALEX_BATCH_SIZE) {
    const batch = unfetched.slice(i, i + OPENALEX_BATCH_SIZE);
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("filter", `openalex_id:${batch.join("|")}`);
    url.searchParams.set("per-page", String(OPENALEX_BATCH_SIZE));
    url.searchParams.set("select", OPENALEX_SELECT);
    const data = await fetchJson<{ results?: OpenAlexWork[] }>(fetch, url);
    for (const work of data.results ?? []) {
      const record = fromOpenAlexWork(work, "snowball");
      if (record?.openalex_id) cache.set(record.openalex_id, record);
    }
  }
}

/**
 * Snowballing (D-019, D-034): completeness is verified structurally, but only
 * against TOPICALLY VALIDATED anchors — a wrong anchor is worse than none. A
 * qualifying review must (a) contain the mechanism's core terms in its title
 * AND abstract, not a collision word, (b) be typed as a review/meta-analysis,
 * and (c) cite ≥SNOWBALL_MIN_REFERENCES works. The top SNOWBALL_TOP_REVIEWS
 * qualifying reviews (by citations) have their referenced_works fetched;
 * coverage = share of each review's resolved references already in the corpus;
 * references missing from the corpus that appear in ≥SNOWBALL_MIN_REVIEWS
 * reviews' lists are auto-added with source_api "snowball". If no review
 * qualifies, review_found is false and no anchor is chosen. Mutates `records`
 * in place and returns the coverage report.
 */
async function snowball(
  fetch: PoliteFetch,
  records: EvidenceRecord[],
  coreKeys: string[],
  log: (message: string) => void,
): Promise<CoverageReport> {
  const candidates = records
    .filter(
      (r) =>
        isReviewLike(r) &&
        (r.openalex_id || r.doi) &&
        isTopicalReview(r, coreKeys) &&
        (r.referenced_works_count ?? 0) >= SNOWBALL_MIN_REFERENCES,
    )
    .sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1))
    .slice(0, SNOWBALL_TOP_REVIEWS);

  if (candidates.length === 0) {
    log(
      "snowball: no review passed topical validation (core terms in title+abstract), review typing, and the reference-count threshold — no anchor chosen",
    );
    return {
      review_found: false,
      reviews: [],
      snowball_added: 0,
      note: "no topically-validated review anchor (core terms in title+abstract, review typing, ≥"
        + `${SNOWBALL_MIN_REFERENCES} references) — no anchor chosen (D-034)`,
    };
  }

  const notes: string[] = [];
  if (candidates.length < SNOWBALL_TOP_REVIEWS) {
    notes.push(
      `only ${candidates.length} of ${SNOWBALL_TOP_REVIEWS} topically-validated review anchors found in the corpus`,
    );
  }

  const keys = corpusKeys(records);
  const reviews: ReviewCoverage[] = [];
  // Referenced work id → OpenAlex ids of the reviews that cite it.
  const referencedBy = new Map<string, string[]>();
  // Shared metadata cache so a reference cited by both reviews is fetched once.
  const resolved = new Map<string, EvidenceRecord>();

  for (const review of candidates) {
    try {
      const workRef = review.openalex_id ?? `https://doi.org/${review.doi}`;
      const url = new URL(`https://api.openalex.org/works/${workRef}`);
      url.searchParams.set("select", "id,referenced_works");
      const work = await fetchJson<{ id: string | null; referenced_works?: string[] | null }>(
        fetch,
        url,
      );
      const reviewId = normalizeOpenAlexId(work.id);
      if (!reviewId) throw new Error("work has no OpenAlex id");
      review.openalex_id = review.openalex_id ?? reviewId;

      const referenced = (work.referenced_works ?? [])
        .map(normalizeOpenAlexId)
        .filter((id): id is string => id !== null);

      // Resolve metadata for every reference NOT already known by id — DOI
      // and title matching (and any auto-add) need the metadata.
      await fetchWorksByIds(
        fetch,
        referenced.filter((id) => !keys.ids.has(id)),
        resolved,
      );

      let inCorpus = 0;
      for (const refId of referenced) {
        if (keys.ids.has(refId)) {
          inCorpus++;
          continue;
        }
        const ref = resolved.get(refId);
        if (!ref) continue; // unresolvable — counted via references_resolved
        if ((ref.doi && keys.dois.has(ref.doi)) || keys.titles.has(titleKey(ref))) {
          inCorpus++;
        } else {
          referencedBy.set(refId, [...(referencedBy.get(refId) ?? []), reviewId]);
        }
      }
      const referencesResolved =
        referenced.filter((id) => keys.ids.has(id) || resolved.has(id)).length;

      reviews.push({
        title: review.title,
        doi: review.doi,
        openalex_id: reviewId,
        citations: review.citations,
        references_total: referenced.length,
        references_resolved: referencesResolved,
        references_in_corpus: inCorpus,
        coverage:
          referencesResolved > 0
            ? Math.round((inCorpus / referencesResolved) * 10000) / 10000
            : null,
      });
      log(
        `snowball "${review.title}": ${inCorpus}/${referencesResolved} resolved references already in corpus`,
      );
    } catch (err) {
      const message = (err as Error).message;
      notes.push(`review "${review.title}" skipped — ${message}`);
      log(`FAILED snowball "${review.title}": ${message}`);
    }
  }

  // Auto-add: missing references cited by ≥SNOWBALL_MIN_REVIEWS reviews.
  const missingIds = Array.from(referencedBy.entries())
    .filter(([, reviewIds]) => new Set(reviewIds).size >= SNOWBALL_MIN_REVIEWS)
    .map(([id]) => id);
  let added = 0;
  for (const id of missingIds) {
    const record = resolved.get(id);
    if (!record) continue;
    records.push({
      ...record,
      snowball_from: Array.from(new Set(referencedBy.get(id) ?? [])),
    });
    added++;
  }
  if (missingIds.length > 0) {
    log(`snowball: auto-added ${added} references shared by ≥${SNOWBALL_MIN_REVIEWS} reviews`);
  }

  return {
    review_found: true,
    reviews,
    snowball_added: added,
    ...(notes.length > 0 ? { note: notes.join(" · ") } : {}),
  };
}

// ---------- Params ----------

/** Owner-pinned work the search cannot surface (D-017). */
interface PinnedEvidence {
  title: string;
  doi: string;
  reason: string;
}

interface MechanismRecord {
  name?: string;
  evidence_terms?: string[];
  pinned_evidence?: PinnedEvidence[];
}

function loadMechanism(mechanismId: string | undefined): MechanismRecord {
  if (!mechanismId) {
    throw new Error(
      "Missing mechanism id. Usage: npm run connector -- evidence mechanism=LA-01",
    );
  }
  const asFull = join(MECHANISMS_DIR, `${mechanismId}.json`);
  const asSeed = join(MECHANISMS_DIR, "_seed", `${mechanismId}.json`);
  const path = existsSync(asFull) ? asFull : existsSync(asSeed) ? asSeed : null;
  if (!path) {
    throw new Error(
      `Mechanism "${mechanismId}" is not in the registry (/registry/mechanisms) — no corpora for phantom mechanisms.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as MechanismRecord;
}

/**
 * Records of an existing corpus file, or null when the file is absent or
 * unreadable (a first harvest, or a corrupt prior file — neither is a
 * regression, and both mean full novelty). Used by the anti-regression
 * guardrail (D-038) and the novelty gate (D-058).
 */
function readExistingRecords(path: string): EvidenceRecord[] | null {
  if (!existsSync(path)) return null;
  try {
    const prev = JSON.parse(readFileSync(path, "utf-8")) as { records?: unknown };
    return Array.isArray(prev.records) ? (prev.records as EvidenceRecord[]) : null;
  } catch {
    return null;
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Build every search query for a run (D-058): per term, the canon pair
 * (OpenAlex most-cited + Semantic Scholar relevance), a recency query
 * (OpenAlex by publication date), and the five contrast angles alternating
 * across the two APIs. This is where "more data" becomes "broader data".
 */
function buildQueryTasks(terms: string[]): QueryTask[] {
  const mk = (
    api: SearchApi,
    angle: SearchAngle,
    term: string,
    limit: number,
    sort: string | undefined,
    throttleable: boolean,
  ): QueryTask => ({
    api,
    angle,
    term,
    limit,
    sort,
    throttleable,
    meta: { api, angle, term, requested: limit, returned: 0 },
    records: [],
  });

  const tasks: QueryTask[] = [];
  for (const term of terms) {
    // canon — the mainstream, most-cited view (unchanged behavior).
    tasks.push(mk("openalex", "canon", term, OPENALEX_PER_TERM, "cited_by_count:desc", false));
    tasks.push(mk("semantic-scholar", "canon", term, S2_PER_TERM, undefined, true));
    // recent — recency balance so newer product forms aren't starved.
    tasks.push(mk("openalex", "recent", term, RECENT_PER_TERM, "publication_date:desc", false));
    // contrast angles — alternating source for spread.
    CONTRAST_ANGLES.forEach((c, i) => {
      const api = contrastApi(i);
      const query = `${term} ${c.suffix}`.trim();
      tasks.push(
        mk(
          api,
          c.angle,
          query,
          CONTRAST_PER_TERM,
          api === "openalex" ? "cited_by_count:desc" : undefined,
          false,
        ),
      );
    });
  }
  return tasks;
}

/**
 * Dedup-aware novelty vs the prior corpus (D-058). A record is already in the
 * corpus if its OpenAlex id, DOI, or normalized title matches a prior record.
 */
function buildNovelty(
  deduped: EvidenceRecord[],
  previous: EvidenceRecord[] | null,
): NoveltyReport {
  const unique = deduped.length;
  if (previous === null) {
    return {
      previous_corpus_records: null,
      unique_records: unique,
      already_in_corpus: 0,
      new_records: unique,
      novelty_rate: 1,
      low_novelty: false,
      known_share_threshold: LOW_NOVELTY_KNOWN_SHARE,
    };
  }
  const keys = corpusKeys(previous);
  let already = 0;
  for (const r of deduped) {
    const inCorpus =
      (r.openalex_id !== null && keys.ids.has(r.openalex_id)) ||
      (r.doi !== null && keys.dois.has(r.doi)) ||
      keys.titles.has(titleKey(r));
    if (inCorpus) already++;
  }
  const newRecords = unique - already;
  const knownShare = unique > 0 ? already / unique : 0;
  return {
    previous_corpus_records: previous.length,
    unique_records: unique,
    already_in_corpus: already,
    new_records: newRecords,
    novelty_rate: unique > 0 ? round4(newRecords / unique) : 0,
    low_novelty: unique > 0 && knownShare > LOW_NOVELTY_KNOWN_SHARE,
    known_share_threshold: LOW_NOVELTY_KNOWN_SHARE,
  };
}

/**
 * Diversity report (D-058) over the deduped SEARCH records: viewpoint spread
 * (per angle), source spread (per API), recency, and novelty vs the prior
 * corpus. `groups` are the raw dedup clusters aligned to `deduped`, so a unique
 * record is attributed to every angle/API that surfaced any of its variants.
 */
function buildDiversityReport(
  tasks: QueryTask[],
  deduped: EvidenceRecord[],
  groups: EvidenceRecord[][],
  previous: EvidenceRecord[] | null,
  currentYear: number,
): DiversityReport {
  const angleQueries = new Map<SearchAngle, { queries: number; returned: number }>();
  const apiQueries = new Map<SearchApi, { queries: number; returned: number }>();
  for (const t of tasks) {
    const a = angleQueries.get(t.angle) ?? { queries: 0, returned: 0 };
    a.queries += 1;
    a.returned += t.meta.returned;
    angleQueries.set(t.angle, a);
    const s = apiQueries.get(t.api) ?? { queries: 0, returned: 0 };
    s.queries += 1;
    s.returned += t.meta.returned;
    apiQueries.set(t.api, s);
  }

  const angleUnique = new Map<SearchAngle, number>();
  const apiUnique = new Map<SearchApi, number>();
  for (const group of groups) {
    const angles = new Set<SearchAngle>();
    const apis = new Set<SearchApi>();
    for (const r of group) {
      for (const a of r.search_angles ?? []) angles.add(a);
      if (r.source_api === "openalex" || r.source_api === "semantic-scholar") {
        apis.add(r.source_api);
      }
    }
    for (const a of Array.from(angles)) angleUnique.set(a, (angleUnique.get(a) ?? 0) + 1);
    for (const p of Array.from(apis)) apiUnique.set(p, (apiUnique.get(p) ?? 0) + 1);
  }

  const viewpoint_spread: AngleSpread[] = ALL_ANGLES.filter((a) =>
    angleQueries.has(a),
  ).map((angle) => ({
    angle,
    queries: angleQueries.get(angle)?.queries ?? 0,
    returned: angleQueries.get(angle)?.returned ?? 0,
    unique_records: angleUnique.get(angle) ?? 0,
  }));

  const source_spread: SourceSpread[] = SEARCH_APIS.filter((api) =>
    apiQueries.has(api),
  ).map((api) => ({
    api,
    queries: apiQueries.get(api)?.queries ?? 0,
    returned: apiQueries.get(api)?.returned ?? 0,
    unique_records: apiUnique.get(api) ?? 0,
  }));

  const recentRecords = deduped.filter(
    (r) => r.year !== null && r.year >= currentYear - RECENT_WINDOW_YEARS,
  ).length;

  return {
    viewpoint_spread,
    source_spread,
    recent_records: recentRecords,
    recency_rate: deduped.length > 0 ? round4(recentRecords / deduped.length) : 0,
    novelty: buildNovelty(deduped, previous),
  };
}

function splitTerms(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Terms are per-mechanism data (D-015): prefer the record's evidence_terms,
 * fall back to [name]; an explicit terms= param overrides for ad-hoc runs.
 */
function resolveTerms(
  record: MechanismRecord,
  paramTerms: string | undefined,
): { terms: string[]; source: TermsSource } {
  const override = splitTerms(paramTerms);
  if (override.length > 0) return { terms: override, source: "param" };
  if (record.evidence_terms && record.evidence_terms.length > 0) {
    return { terms: record.evidence_terms, source: "record" };
  }
  if (record.name && record.name.length > 0) {
    return { terms: [record.name], source: "name" };
  }
  throw new Error("No search terms: record has no evidence_terms and no name.");
}

// ---------- The connector ----------

export const evidenceConnector: Connector = {
  id: "evidence",
  sourceId: "evidence",
  sourceIds: ["openalex", "semantic-scholar"],
  connectorVersion: "2.4.0",
  description:
    "Evidence harvester: OpenAlex + Semantic Scholar literature for one mechanism → {mechanism_id}.json. Each term fans out across viewpoints (canon, recent, and five contrast angles) alternating both APIs for diversity, with a dedup-aware novelty gate and a diversity_report per harvest (D-058). Terms from the record's evidence_terms; owner pins merged from pinned_evidence; review-reference snowballing and a category checklist verify completeness structurally (D-019). Fetch and structure only.",

  /**
   * Deterministic pre-run estimate (D-025). No network: reads the mechanism
   * record from disk and counts the calls the run WILL make — per term the
   * canon OpenAlex + canon S2 queries, a recency OpenAlex query, and the five
   * contrast angles alternating the two APIs (D-058) — one OpenAlex fetch per
   * pin, plus a fixed snowball allowance. Powers the /ops dry-run quote and the
   * budget gate.
   */
  quote(params): RunQuote {
    const record = loadMechanism(params.mechanism);
    const { terms } = resolveTerms(record, params.terms);
    const pins = record.pinned_evidence?.length ?? 0;

    // Per term: canon OpenAlex + recency OpenAlex + the contrast angles routed
    // to OpenAlex; canon S2 + the contrast angles routed to S2.
    const openAlexPerTerm = 2 + CONTRAST_OPENALEX_COUNT;
    const s2PerTerm = 1 + CONTRAST_S2_COUNT;
    const openAlexCalls = terms.length * openAlexPerTerm + pins + QUOTE_SNOWBALL_CALLS;
    const s2Calls = terms.length * s2PerTerm;
    const calls = openAlexCalls + s2Calls;

    const recordsPerTerm =
      OPENALEX_PER_TERM +
      S2_PER_TERM +
      RECENT_PER_TERM +
      CONTRAST_ANGLES.length * CONTRAST_PER_TERM;
    const records = terms.length * recordsPerTerm + pins + QUOTE_SNOWBALL_RECORDS;

    const duration_s =
      Math.round(
        (openAlexCalls * QUOTE_POLITE_INTERVAL_S + s2Calls * QUOTE_S2_INTERVAL_S) * 10,
      ) / 10;

    // estimated_usd is COMPUTED, not asserted: every D-011 API is free, so a
    // pure-fetch run is 0 until a priced (LLM) job exists.
    return { calls, records, duration_s, estimated_usd: 0 };
  },

  async run(ctx, params): Promise<RunResult> {
    const mechanismId = params.mechanism;
    const record = loadMechanism(mechanismId);
    const { terms, source: termsSource } = resolveTerms(record, params.terms);
    ctx.log(`terms (${termsSource}): ${terms.join(" · ")}`);

    // Any Semantic Scholar 429 — even keyed, despite the global queue —
    // records s2_throttled in the manifest (D-018/D-027); keyless runs
    // additionally drop the per-term batch to 10 for the retry passes.
    let s2Throttled = false;
    const s2Limit = (): number =>
      s2Throttled && !s2ApiKey() ? S2_THROTTLED_PER_TERM : S2_PER_TERM;

    // Fan each term out across viewpoints and both APIs (D-058).
    const tasks = buildQueryTasks(terms);

    const runTask = async (task: QueryTask): Promise<void> => {
      // Only the canon S2 query throttles; contrast S2 queries keep their
      // fixed CONTRAST_PER_TERM batch.
      const limit =
        task.api === "semantic-scholar" && task.throttleable ? s2Limit() : task.limit;
      if (task.api === "semantic-scholar") task.meta.requested = limit;
      try {
        const records =
          task.api === "openalex"
            ? await searchOpenAlex(ctx.fetch, task.term, task.sort, task.limit)
            : await searchSemanticScholar(ctx.fetch, task.term, limit);
        for (const r of records) r.search_angles = [task.angle];
        task.meta.returned = records.length;
        task.records = records;
        task.error = undefined;
        ctx.log(`${task.api} ${task.angle} "${task.term}": ${records.length} records`);
      } catch (err) {
        task.error = `${task.api} ${task.angle} "${task.term}": ${(err as Error).message}`;
        ctx.log(`FAILED ${task.error}`);
        if (
          task.api === "semantic-scholar" &&
          !s2Throttled &&
          /HTTP 429/.test(task.error)
        ) {
          s2Throttled = true;
          ctx.log(
            s2ApiKey()
              ? "WARNING s2_throttled: Semantic Scholar hit 429 despite the 1 rps queue (D-027) — recorded in the manifest"
              : `WARNING s2_throttled: keyless Semantic Scholar hit 429 — reducing batch to ${S2_THROTTLED_PER_TERM}/term for retries (set S2_API_KEY for higher limits)`,
          );
        }
      }
    };

    for (const task of tasks) await runTask(task);

    // Retry passes with exponential backoff (30s, 60s, 120s): the keyless
    // Semantic Scholar pool 429s in bursts.
    const failed = () => tasks.filter((t) => t.error);
    for (let pass = 1; pass <= MAX_RETRY_PASSES; pass++) {
      if (failed().length === 0 || failed().length === tasks.length) break;
      const cooldownMs = RETRY_COOLDOWN_MS * 2 ** (pass - 1);
      ctx.log(
        `retry pass ${pass}/${MAX_RETRY_PASSES}: ${failed().length} failed queries after ${cooldownMs / 1000}s cooldown`,
      );
      await new Promise((resolve) => setTimeout(resolve, cooldownMs));
      for (const task of failed()) await runTask(task);
    }

    const queries = tasks.map((t) => t.meta);
    const failures = failed().map((t) => t.error as string);
    if (failures.length === tasks.length) {
      throw new Error(`All queries failed — ${failures.join(" · ")}`);
    }

    const { records, groups } = dedupeRecords(tasks.flatMap((t) => t.records));

    const currentYear = new Date().getUTCFullYear();
    const fileName = `${mechanismId}.json`;

    // Dedup-aware novelty + diversity (D-058), computed over the deduped SEARCH
    // records BEFORE pins/snowball (owner pins and snowballed references are
    // structural completeness, not query diversity). A harvest that mostly
    // re-fetched the canon already on disk is flagged low_novelty and must not
    // count as progress.
    const previousRecords = readExistingRecords(join(ctx.corpusDir, fileName));
    const diversityReport = buildDiversityReport(
      tasks,
      records,
      groups,
      previousRecords,
      currentYear,
    );
    const lowNovelty = diversityReport.novelty.low_novelty;
    ctx.log(
      `diversity: viewpoints ${diversityReport.viewpoint_spread.length}/${ALL_ANGLES.length} · ` +
        `sources ${diversityReport.source_spread.map((s) => `${s.api} ${s.unique_records}`).join(" / ")} · ` +
        `recency ${diversityReport.recency_rate} · ` +
        `novelty ${diversityReport.novelty.novelty_rate} (${diversityReport.novelty.new_records}/${diversityReport.novelty.unique_records} new)` +
        (lowNovelty
          ? ` — LOW-NOVELTY: >${Math.round(LOW_NOVELTY_KNOWN_SHARE * 100)}% already in corpus; not progress (D-058)`
          : ""),
    );

    // Owner-pinned works (D-017): merge into the corpus with source_api
    // "pinned". A pin overlapping a harvested record fills its gaps and wins
    // source_api so the owner's intent stays visible.
    for (const pin of record.pinned_evidence ?? []) {
      const pinned = await fetchPinnedWork(ctx.fetch, pin, ctx.log);
      const pinTitle = titleKey(pinned);
      const overlap = records.findIndex(
        (r) => (pinned.doi !== null && r.doi === pinned.doi) || titleKey(r) === pinTitle,
      );
      if (overlap >= 0) {
        records[overlap] = { ...mergeCluster([pinned, records[overlap]]), source_api: "pinned", pin_reason: pin.reason };
      } else {
        records.push(pinned);
      }
    }

    // Snowballing (D-019, D-034): review-reference coverage + auto-added
    // references shared by ≥2 reviews, anchored only on topically-validated
    // reviews. Mutates records in place.
    const coverageReport = await snowball(
      ctx.fetch,
      records,
      coreKeywords(terms),
      ctx.log,
    );

    // Category checklist (D-019): metadata-only classification of every
    // record, including snowballed ones.
    for (const r of records) r.categories = classifyRecord(r, currentYear);
    const categoryCounts = countCategories(records);
    ctx.log(
      `categories: ${EVIDENCE_CATEGORIES.map((c) => `${c} ${categoryCounts[c]}`).join(" · ")}`,
    );

    // Presentation order only (readability), not a quality judgment.
    records.sort(
      (a, b) => (b.citations ?? -1) - (a.citations ?? -1) || a.title.localeCompare(b.title),
    );

    const file: EvidenceFile = {
      mechanism_id: mechanismId as string,
      fetched_at: new Date().toISOString(),
      terms_source: termsSource,
      terms,
      queries,
      coverage_report: coverageReport,
      category_counts: categoryCounts,
      diversity_report: diversityReport,
      records,
    };

    // Run warnings shared across both return paths (D-018/D-058): degradation
    // and low-novelty flags flow through to the manifest.
    const warnings: Record<string, boolean> = {};
    if (s2Throttled) warnings.s2_throttled = true;
    if (lowNovelty) warnings.low_novelty = true;

    // Anti-regression guardrail (D-038): a re-harvest that produces FEWER
    // records than the existing corpus is suspicious — a dropped evidence_terms
    // (name-only fallback), an upstream outage, or a throttled partial. Never
    // silently overwrite hard-won breadth with a weaker pull. Write to a side
    // file for review instead and flag the run; the existing corpus is kept.
    const existingCount = previousRecords?.length ?? null;
    if (existingCount !== null && records.length < existingCount) {
      const sideFile = `${mechanismId}.regression.json`;
      ctx.writeJson(sideFile, file);
      const message =
        `regression suspected: re-harvest produced ${records.length} records vs ${existingCount} ` +
        `already in the corpus — corpus NOT overwritten; wrote ${sideFile} for review (D-038)`;
      ctx.log(`WARNING ${message}`);
      return {
        status: "partial",
        recordsFetched: records.length,
        files: [{ path: sideFile, records: records.length, categories: categoryCounts }],
        error: [message, ...failures].join(" · "),
        warnings: { regression_suspected: true, ...warnings },
      };
    }

    ctx.writeJson(fileName, file);
    ctx.log(`wrote ${records.length} deduplicated records to ${fileName}`);

    return {
      status: failures.length > 0 ? "partial" : "success",
      recordsFetched: records.length,
      files: [{ path: fileName, records: records.length, categories: categoryCounts }],
      ...(failures.length > 0 ? { error: failures.join(" · ") } : {}),
      ...(Object.keys(warnings).length > 0 ? { warnings } : {}),
    };
  },
};

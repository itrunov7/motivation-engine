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
}

interface QueryMeta {
  api: SearchApi;
  term: string;
  requested: number;
  returned: number;
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
  }
  return base;
}

/**
 * Deduplicate by DOI AND normalized title, keeping the highest-citation
 * variant of each paper. Two records are the same paper if they share a DOI
 * or a normalized title; union-find groups the transitive clusters (a paper
 * seen with a DOI on one API and without on another still collapses).
 */
function dedupeRecords(raw: EvidenceRecord[]): EvidenceRecord[] {
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

  return Array.from(clusters.values()).map(mergeCluster);
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
): Promise<EvidenceRecord[]> {
  const url = new URL("https://api.openalex.org/works");
  // Commas separate OpenAlex filters — strip them from the term defensively.
  url.searchParams.set("filter", `title_and_abstract.search:${term.replace(/,/g, " ")}`);
  url.searchParams.set("sort", "cited_by_count:desc");
  url.searchParams.set("per-page", String(OPENALEX_PER_TERM));
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
  connectorVersion: "2.2.0",
  description:
    "Evidence harvester: OpenAlex + Semantic Scholar literature for one mechanism → {mechanism_id}.json. Terms from the record's evidence_terms; owner pins merged from pinned_evidence; review-reference snowballing and a category checklist verify completeness structurally (D-019). Fetch and structure only.",

  /**
   * Deterministic pre-run estimate (D-025). No network: reads the mechanism
   * record from disk and counts the calls the run WILL make — one OpenAlex +
   * one S2 search per term, one OpenAlex fetch per pin, plus a fixed snowball
   * allowance. Powers the /ops dry-run quote and the budget gate.
   */
  quote(params): RunQuote {
    const record = loadMechanism(params.mechanism);
    const { terms } = resolveTerms(record, params.terms);
    const pins = record.pinned_evidence?.length ?? 0;

    const openAlexCalls = terms.length + pins + QUOTE_SNOWBALL_CALLS;
    const s2Calls = terms.length;
    const calls = openAlexCalls + s2Calls;

    const records =
      terms.length * (OPENALEX_PER_TERM + S2_PER_TERM) + pins + QUOTE_SNOWBALL_RECORDS;

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

    interface QueryTask {
      api: SearchApi;
      term: string;
      search: (term: string) => Promise<EvidenceRecord[]>;
      meta: QueryMeta;
      records: EvidenceRecord[];
      error?: string;
    }

    // Any Semantic Scholar 429 — even keyed, despite the global queue —
    // records s2_throttled in the manifest (D-018/D-027); keyless runs
    // additionally drop the per-term batch to 10 for the retry passes.
    let s2Throttled = false;
    const s2Limit = (): number =>
      s2Throttled && !s2ApiKey() ? S2_THROTTLED_PER_TERM : S2_PER_TERM;

    const tasks: QueryTask[] = [
      ...terms.map((term): QueryTask => ({
        api: "openalex",
        term,
        search: (t: string) => searchOpenAlex(ctx.fetch, t),
        meta: { api: "openalex", term, requested: OPENALEX_PER_TERM, returned: 0 },
        records: [],
      })),
      ...terms.map((term): QueryTask => ({
        api: "semantic-scholar",
        term,
        search: (t: string) => searchSemanticScholar(ctx.fetch, t, s2Limit()),
        meta: { api: "semantic-scholar", term, requested: S2_PER_TERM, returned: 0 },
        records: [],
      })),
    ];

    const runTask = async (task: QueryTask): Promise<void> => {
      if (task.api === "semantic-scholar") task.meta.requested = s2Limit();
      try {
        const records = await task.search(task.term);
        task.meta.returned = records.length;
        task.records = records;
        task.error = undefined;
        ctx.log(`${task.api} "${task.term}": ${records.length} records`);
      } catch (err) {
        task.error = `${task.api} "${task.term}": ${(err as Error).message}`;
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

    const records = dedupeRecords(tasks.flatMap((t) => t.records));

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
    const currentYear = new Date().getUTCFullYear();
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
      records,
    };
    const fileName = `${mechanismId}.json`;
    ctx.writeJson(fileName, file);
    ctx.log(`wrote ${records.length} deduplicated records to ${fileName}`);

    return {
      status: failures.length > 0 ? "partial" : "success",
      recordsFetched: records.length,
      files: [{ path: fileName, records: records.length, categories: categoryCounts }],
      ...(failures.length > 0 ? { error: failures.join(" · ") } : {}),
      ...(s2Throttled ? { warnings: { s2_throttled: true } } : {}),
    };
  },
};

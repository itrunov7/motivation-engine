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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assignCorpusRecordIds, normalizeCorpusDoi } from "../../lib/corpus-record-id";
import {
  DEFAULT_EVIDENCE_SATURATION,
  loadOpsBudgetFromDisk,
  loadOpsConnectorConfigFromDisk,
  type OpsConnectorConfig,
} from "../../lib/ops";
import type { EvidenceSaturationConfig, RunProgressStatus } from "../../lib/types";
import { writeRunProgress } from "../progress";
import { UpstreamCooldownError } from "./lib/http";
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
export type RetrievalBucket = "relevance" | "recency" | "citation";
type QueryKind = "search" | "backward-reference" | "forward-citation";

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
  /** Assigned after final deduplication, immediately before the corpus is written. */
  record_id?: string;
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
  query_id: string;
  api: SearchApi;
  /** The viewpoint this query targeted (D-058). */
  angle: SearchAngle;
  term: string;
  bucket: RetrievalBucket;
  kind: QueryKind;
  requested: number;
  returned: number;
  unique_returned: number;
  records_added: number;
  novelty_rate: number;
  rolling_novelty_rate: number | null;
  /** Total matching works reported by the upstream search API; null for graph
   * expansion or when the upstream omitted a count. */
  upstream_total_results: number | null;
}

/** One planned search query — one (api, angle, term) triple. */
interface QueryTask {
  id: string;
  kind: QueryKind;
  api: SearchApi;
  angle: SearchAngle;
  /** The query string actually sent (a contrast angle appends its suffix). */
  term: string;
  /** Planned batch size; for the throttleable canon S2 query the keyless 429
   *  path may reduce it at run time. */
  limit: number;
  page: number;
  /** OpenAlex sort override; unused for Semantic Scholar. */
  sort?: string;
  /** True only for the canon Semantic Scholar query (keyless throttle path). */
  throttleable: boolean;
  bucket: RetrievalBucket;
  /** OpenAlex anchor for citation-graph tasks. */
  anchorId?: string;
  anchorTitle?: string;
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

export interface SaturationPoint {
  query_index: number;
  query_id: string;
  bucket: RetrievalBucket;
  kind: QueryKind;
  returned: number;
  unique_returned: number;
  records_added: number;
  novelty_rate: number;
  rolling_novelty_rate: number | null;
  cumulative_records: number;
}

export interface SaturationReport {
  queries_issued: number;
  records_added: number;
  novelty_curve: SaturationPoint[];
  window_queries: number;
  novelty_threshold: number;
  minimum_queries: number;
  retrieval_counts: Record<RetrievalBucket, number>;
  topical_candidates: number;
  topical_confirmed: number;
  topical_rejected: number;
  topical_confirmation_rate: number;
  graph_anchors_expanded: number;
  field_union_estimate: {
    estimate: number | null;
    method: "sample_overlap_adjusted_union";
    measured_queries: number;
    total_search_queries: number;
    summed_upstream_results: number;
    observed_sample_multiplicity: number | null;
  };
  saturation_reached: boolean;
  stop_reason: "saturation" | "storage_tier_record_cap" | "call_cap" | "time_slice";
  cap: {
    max_calls: number;
    max_unique_records: number;
  };
}

export function rollingNoveltyRate(
  previous: readonly Pick<SaturationPoint, "novelty_rate">[],
  next: number,
  windowQueries: number,
): number | null {
  const values = [
    ...previous.slice(-(windowQueries - 1)).map((point) => point.novelty_rate),
    next,
  ];
  return values.length === windowQueries
    ? round4(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

export function saturationReached(
  completedQueries: number,
  rollingRate: number | null,
  config: Pick<
    EvidenceSaturationConfig,
    "minimum_queries" | "novelty_threshold"
  >,
): boolean {
  return (
    completedQueries >= config.minimum_queries &&
    rollingRate !== null &&
    rollingRate < config.novelty_threshold
  );
}

export function enabledGraphDirections(
  graph: EvidenceSaturationConfig["citation_graph"],
): Exclude<QueryKind, "search">[] {
  return [
    ...(graph.backward_references ? (["backward-reference"] as const) : []),
    ...(graph.forward_citations ? (["forward-citation"] as const) : []),
  ];
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
  /** Adaptive query stopping and graph-expansion accounting (D-080). */
  saturation_report: SaturationReport;
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

interface SearchResult {
  records: EvidenceRecord[];
  totalResults: number | null;
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
  return normalizeCorpusDoi(raw);
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
  page = 1,
): Promise<SearchResult> {
  const url = new URL("https://api.openalex.org/works");
  // Commas separate OpenAlex filters — strip them from the term defensively.
  url.searchParams.set("filter", `title_and_abstract.search:${term.replace(/,/g, " ")}`);
  url.searchParams.set("sort", sort);
  url.searchParams.set("per-page", String(limit));
  url.searchParams.set("page", String(page));
  url.searchParams.set("select", OPENALEX_SELECT);

  const data = await fetchJson<{
    meta?: { count?: number };
    results?: OpenAlexWork[];
  }>(fetch, url);
  const records = (data.results ?? []).flatMap((work) => {
    const record = fromOpenAlexWork(work, "openalex");
    return record ? [record] : [];
  });
  return {
    records,
    totalResults:
      typeof data.meta?.count === "number" && data.meta.count >= 0
        ? data.meta.count
        : null,
  };
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
  page = 1,
): Promise<SearchResult> {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", term);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String((page - 1) * limit));
  url.searchParams.set("fields", "title,authors,year,venue,externalIds,citationCount,abstract");

  const apiKey = s2ApiKey();
  const data = await fetchJson<{ total?: number; data?: S2Paper[] }>(
    fetch,
    url,
    apiKey ? { "x-api-key": apiKey } : undefined,
  );
  const records = (data.data ?? []).flatMap((paper) => {
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
  return {
    records,
    totalResults:
      typeof data.total === "number" && data.total >= 0 ? data.total : null,
  };
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

/** Conservative graph-anchor gate: title hit + two abstract core-keyword hits. */
export function isTopicalGraphAnchor(record: EvidenceRecord, keys: string[]): boolean {
  if (!record.openalex_id || !record.abstract || keys.length === 0) return false;
  const titleMinimum = Math.min(2, keys.length);
  const abstractMinimum = Math.min(3, keys.length);
  return (
    countCoreKeywords(record.title, keys) >= titleMinimum &&
    countCoreKeywords(record.abstract, keys) >= abstractMinimum
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

async function fetchBackwardReferences(
  fetch: PoliteFetch,
  anchorId: string,
  limit: number,
): Promise<EvidenceRecord[]> {
  const url = new URL(`https://api.openalex.org/works/${anchorId}`);
  url.searchParams.set("select", "id,referenced_works");
  const work = await fetchJson<{ referenced_works?: string[] | null }>(fetch, url);
  const ids = (work.referenced_works ?? [])
    .map(normalizeOpenAlexId)
    .filter((id): id is string => id !== null)
    .slice(0, limit);
  const resolved = new Map<string, EvidenceRecord>();
  await fetchWorksByIds(fetch, ids, resolved);
  return ids.flatMap((id) => {
    const record = resolved.get(id);
    return record ? [{ ...record, source_api: "snowball" as const, snowball_from: [anchorId] }] : [];
  });
}

async function fetchForwardCitations(
  fetch: PoliteFetch,
  anchorId: string,
  limit: number,
): Promise<EvidenceRecord[]> {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("filter", `cites:${anchorId}`);
  url.searchParams.set("sort", "publication_date:desc");
  url.searchParams.set("per-page", String(limit));
  url.searchParams.set("select", OPENALEX_SELECT);
  const data = await fetchJson<{ results?: OpenAlexWork[] }>(fetch, url);
  return (data.results ?? []).flatMap((work) => {
    const record = fromOpenAlexWork(work, "snowball");
    return record ? [{ ...record, snowball_from: [anchorId] }] : [];
  });
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
    if (!record || !isTopicalGraphAnchor(record, coreKeys)) continue;
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
 * Estimate the union of all search-result sets from upstream totals. API totals
 * overlap heavily across terms and providers, so the raw sum is divided by the
 * multiplicity observed in the fetched samples. Pagination and sort variants
 * of the same (api, term) universe contribute one upstream total.
 */
export function estimateFieldUnion(
  tasks: readonly QueryTask[],
  corpusRecords: number,
): SaturationReport["field_union_estimate"] {
  const scopes = new Map<
    string,
    { total: number; records: EvidenceRecord[] }
  >();
  let totalSearchQueries = 0;
  for (const task of tasks) {
    if (task.kind !== "search" || task.error) continue;
    totalSearchQueries += 1;
    const total = task.meta.upstream_total_results;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) continue;
    const key = `${task.api}\u0000${task.term}`;
    const scope = scopes.get(key) ?? { total, records: [] };
    scope.total = Math.max(scope.total, total);
    scope.records.push(...task.records);
    scopes.set(key, scope);
  }
  const measured = Array.from(scopes.values());
  const summedUpstreamResults = measured.reduce((sum, scope) => sum + scope.total, 0);
  const perScopeUnique = measured.map(
    (scope) => dedupeRecords(scope.records).records,
  );
  const observedUnion = dedupeRecords(perScopeUnique.flat()).records.length;
  const observedMemberships = perScopeUnique.reduce(
    (sum, records) => sum + records.length,
    0,
  );
  const multiplicity =
    observedUnion > 0 ? observedMemberships / observedUnion : null;
  const estimate =
    measured.length > 0 && multiplicity !== null && multiplicity > 0
      ? Math.max(corpusRecords, Math.round(summedUpstreamResults / multiplicity))
      : null;
  return {
    estimate,
    method: "sample_overlap_adjusted_union",
    measured_queries: measured.length,
    total_search_queries: totalSearchQueries,
    summed_upstream_results: summedUpstreamResults,
    observed_sample_multiplicity:
      multiplicity === null ? null : round4(multiplicity),
  };
}

/** Deterministic weighted retrieval cycle; defaults produce 1:1:1 shares. */
function retrievalCycle(
  shares: EvidenceSaturationConfig["retrieval_shares"],
): RetrievalBucket[] {
  const buckets: RetrievalBucket[] = [];
  for (const bucket of ["relevance", "recency", "citation"] as const) {
    for (let i = 0; i < shares[bucket]; i++) buckets.push(bucket);
  }
  return buckets;
}

function angleTerm(term: string, angle: SearchAngle): string {
  if (angle === "canon" || angle === "recent") return term;
  const contrast = CONTRAST_ANGLES.find((entry) => entry.angle === angle);
  return `${term} ${contrast?.suffix ?? ""}`.trim();
}

/**
 * Build the deterministic term × angle × retrieval-bucket frontier (D-080).
 * Relevance alternates OpenAlex/S2; recency and citation use OpenAlex because
 * those explicit orderings are available without adding a new endpoint.
 */
export function buildQueryTasks(
  terms: string[],
  saturation: EvidenceSaturationConfig,
): QueryTask[] {
  const mk = (
    id: string,
    api: SearchApi,
    angle: SearchAngle,
    term: string,
    bucket: RetrievalBucket,
    limit: number,
    page: number,
    sort: string | undefined,
    throttleable: boolean,
  ): QueryTask => ({
    id,
    kind: "search",
    api,
    angle,
    term,
    bucket,
    limit,
    page,
    sort,
    throttleable,
    meta: {
      query_id: id,
      api,
      angle,
      term,
      bucket,
      kind: "search",
      requested: limit,
      returned: 0,
      unique_returned: 0,
      records_added: 0,
      novelty_rate: 0,
      rolling_novelty_rate: null,
      upstream_total_results: null,
    },
    records: [],
  });

  const tasks: QueryTask[] = [];
  const cycle = retrievalCycle(saturation.retrieval_shares);
  let relevanceIndex = 0;
  // Breadth-first pagination: exhaust every variation's first page before any
  // second page, avoiding a deep canon pull that would reintroduce rank bias.
  const maxPages = 10;
  for (let page = 1; page <= maxPages; page++) {
    for (const term of terms) {
      for (const angle of ALL_ANGLES) {
        const query = angleTerm(term, angle);
        for (const bucket of cycle) {
        const api: SearchApi =
          bucket === "relevance" && relevanceIndex++ % 2 === 1
            ? "semantic-scholar"
            : "openalex";
        const sort =
          bucket === "recency"
            ? "publication_date:desc"
            : bucket === "citation"
              ? "cited_by_count:desc"
              : api === "openalex"
                ? "relevance_score:desc"
                : undefined;
          const id = `search:${bucket}:${api}:${angle}:p${page}:${query}`;
          tasks.push(
            mk(
              id,
              api,
              angle,
              query,
              bucket,
              saturation.records_per_query,
              page,
              sort,
              api === "semantic-scholar",
            ),
          );
        }
      }
    }
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

function saturationConfig(): EvidenceSaturationConfig {
  const configured = loadOpsConnectorConfigFromDisk("evidence")?.saturation;
  if (configured) return configured;
  return {
    ...DEFAULT_EVIDENCE_SATURATION,
    retrieval_shares: { ...DEFAULT_EVIDENCE_SATURATION.retrieval_shares },
    citation_graph: { ...DEFAULT_EVIDENCE_SATURATION.citation_graph },
  };
}

const EVIDENCE_CHECKPOINT_DIR = join(
  __dirname,
  "..",
  "..",
  "corpora",
  "_ops",
  "checkpoints",
  "evidence",
);

interface EvidenceCheckpoint {
  version: 1;
  mechanism_id: string;
  logical_run_id: string;
  started_at: string;
  terms: string[];
  fingerprint: string;
  cursor: number;
  tasks: QueryTask[];
  novelty_curve: SaturationPoint[];
  expanded_anchor_ids: string[];
  topical_candidates: number;
  topical_confirmed: number;
  topical_rejected: number;
  s2_throttled?: boolean;
  slice_stop_reason?: "time_slice" | "upstream_quota";
  api_calls_spent: number;
}

function checkpointPath(mechanismId: string): string {
  return join(EVIDENCE_CHECKPOINT_DIR, `${mechanismId}.json`);
}

function runFingerprint(
  mechanismId: string,
  terms: string[],
  saturation: EvidenceSaturationConfig,
  previous: EvidenceRecord[] | null,
): string {
  const baseKeys = (previous ?? []).map((record) =>
    record.record_id ?? record.doi ?? `${titleKey(record)}:${record.year ?? "undated"}`,
  );
  return createHash("sha256")
    .update(JSON.stringify({ mechanismId, terms, saturation, baseKeys }))
    .digest("hex");
}

function readCheckpoint(
  mechanismId: string,
  fingerprint: string,
): EvidenceCheckpoint | null {
  const path = checkpointPath(mechanismId);
  if (!existsSync(path)) return null;
  const checkpoint = JSON.parse(readFileSync(path, "utf-8")) as EvidenceCheckpoint;
  if (!checkpointIsCompatible(checkpoint, mechanismId, fingerprint)) {
    throw new Error(
      `stale saturation checkpoint for ${mechanismId} — terms, config, or base corpus changed; ` +
        `remove ${path} only after reviewing it`,
    );
  }
  return checkpoint;
}

export function checkpointIsCompatible(
  checkpoint: Pick<EvidenceCheckpoint, "version" | "mechanism_id" | "fingerprint">,
  mechanismId: string,
  fingerprint: string,
): boolean {
  return (
    checkpoint.version === 1 &&
    checkpoint.mechanism_id === mechanismId &&
    checkpoint.fingerprint === fingerprint
  );
}

function writeCheckpoint(checkpoint: EvidenceCheckpoint): void {
  mkdirSync(EVIDENCE_CHECKPOINT_DIR, { recursive: true });
  const path = checkpointPath(checkpoint.mechanism_id);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf-8");
  renameSync(temp, path);
}

function removeCheckpoint(mechanismId: string): void {
  const path = checkpointPath(mechanismId);
  if (existsSync(path)) unlinkSync(path);
}

// ---------- The connector ----------

export const evidenceConnector: Connector = {
  id: "evidence",
  sourceId: "evidence",
  sourceIds: ["openalex", "semantic-scholar"],
  connectorVersion: "3.0.0",
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
    const ops = loadOpsConnectorConfigFromDisk("evidence");
    const maxCalls = ops?.limits.max_calls_per_run ?? 150;
    const records = ops?.limits.max_records_per_run ?? 1000;
    const previous = readExistingRecords(
      join(__dirname, "..", "..", "corpora", "evidence", `${params.mechanism}.json`),
    );
    const fingerprint = runFingerprint(
      params.mechanism as string,
      terms,
      saturationConfig(),
      previous,
    );
    const checkpoint = readCheckpoint(params.mechanism as string, fingerprint);
    const calls = Math.max(0, maxCalls - (checkpoint?.api_calls_spent ?? 0));
    return {
      calls,
      records,
      duration_s: Math.round(calls * QUOTE_S2_INTERVAL_S * 10) / 10,
      estimated_usd: 0,
    };
  },

  async run(ctx, params): Promise<RunResult> {
    const mechanismId = params.mechanism;
    const record = loadMechanism(mechanismId);
    const { terms, source: termsSource } = resolveTerms(record, params.terms);
    ctx.log(`terms (${termsSource}): ${terms.join(" · ")}`);
    const saturation = saturationConfig();
    const ops = loadOpsConnectorConfigFromDisk("evidence");
    const maxCalls = ops?.limits.max_calls_per_run ?? 150;
    const maxRecords = ops?.limits.max_records_per_run ?? 1000;
    const fileName = `${mechanismId}.json`;
    const previousRecords = readExistingRecords(join(ctx.corpusDir, fileName));
    const fingerprint = runFingerprint(
      mechanismId as string,
      terms,
      saturation,
      previousRecords,
    );
    const existingCheckpoint = readCheckpoint(mechanismId as string, fingerprint);
    const checkpoint: EvidenceCheckpoint = existingCheckpoint ?? {
      version: 1,
      mechanism_id: mechanismId as string,
      logical_run_id: `${mechanismId}-${Date.now().toString(36)}`,
      started_at: new Date().toISOString(),
      terms,
      fingerprint,
      cursor: 0,
      tasks: buildQueryTasks(terms, saturation),
      novelty_curve: [],
      expanded_anchor_ids: [],
      topical_candidates: 0,
      topical_confirmed: 0,
      topical_rejected: 0,
      s2_throttled: false,
      api_calls_spent: 0,
    };
    if (existingCheckpoint) {
      ctx.log(
        `resuming logical run ${checkpoint.logical_run_id} at query ${checkpoint.cursor + 1} ` +
          `(${checkpoint.api_calls_spent}/${maxCalls} calls spent)`,
      );
    }
    const baseApiCalls = existingCheckpoint?.api_calls_spent ?? 0;

    // Live progress heartbeat (D-086): reported after each checkpoint so /ops
    // shows phase, query progress, records, and spend-against-caps while a long
    // harvest is in flight. Monthly caps are read once (a single small file).
    const monthlyCaps = loadOpsBudgetFromDisk()?.monthly_caps ?? null;
    const reportProgress = (
      phase: string,
      status: RunProgressStatus,
      finished: boolean,
      note: string | null = null,
    ): void => {
      writeRunProgress({
        kind: "harvest",
        target: mechanismId as string,
        phase,
        finished,
        status,
        progress: {
          unit: "queries",
          done: checkpoint.cursor,
          total: checkpoint.tasks.length,
        },
        records: accumulated.length,
        spend: {
          api_calls: baseApiCalls + ctx.apiCalls(),
          tokens_in: null,
          tokens_out: null,
          estimated_usd: 0,
        },
        caps: {
          per_run_calls: maxCalls,
          per_run_tokens: null,
          monthly_calls: monthlyCaps?.calls ?? null,
          monthly_usd: monthlyCaps?.usd ?? null,
        },
        note,
      });
    };

    let s2Throttled = checkpoint.s2_throttled === true;
    const s2Limit = (): number =>
      s2Throttled && !s2ApiKey()
        ? Math.min(S2_THROTTLED_PER_TERM, saturation.records_per_query)
        : saturation.records_per_query;
    const coreKeys = coreKeywords(terms);
    const expandedAnchors = new Set(checkpoint.expanded_anchor_ids);
    const startedSliceAt = Date.now();
    const softDeadline =
      startedSliceAt + saturation.soft_time_limit_minutes * 60_000;
    const reserveCalls = (record.pinned_evidence?.length ?? 0) + 6;
    let stopReason: SaturationReport["stop_reason"] | null = null;
    let upstreamCooldownMessage: string | null = null;

    ctx.log(`rebuilding ${checkpoint.cursor} completed query result(s) from checkpoint`);
    let accumulated = dedupeRecords([
      ...(previousRecords ?? []),
      ...checkpoint.tasks
        .slice(0, checkpoint.cursor)
        .flatMap((task) => task.records),
    ]).records.slice(0, maxRecords);
    ctx.log(`checkpoint state rebuilt: ${accumulated.length} cumulative records`);
    reportProgress("harvesting", "running", false);

    const graphTask = (
      kind: "backward-reference" | "forward-citation",
      anchor: EvidenceRecord,
    ): QueryTask => {
      const anchorId = anchor.openalex_id as string;
      const bucket: RetrievalBucket =
        kind === "forward-citation" ? "recency" : "citation";
      const id = `graph:${kind}:${anchorId}`;
      const angle = anchor.search_angles?.[0] ?? "canon";
      return {
        id,
        kind,
        api: "openalex",
        angle,
        term: anchor.title,
        bucket,
        limit: saturation.records_per_query,
        page: 1,
        throttleable: false,
        anchorId,
        anchorTitle: anchor.title,
        meta: {
          query_id: id,
          api: "openalex",
          angle,
          term: anchor.title,
          bucket,
          kind,
          requested: saturation.records_per_query,
          returned: 0,
          unique_returned: 0,
          records_added: 0,
          novelty_rate: 0,
          rolling_novelty_rate: null,
          upstream_total_results: null,
        },
        records: [],
      };
    };

    const runTask = async (task: QueryTask): Promise<void> => {
      if (
        task.api === "semantic-scholar" &&
        s2Throttled &&
        !s2ApiKey()
      ) {
        task.error =
          `${task.kind} semantic-scholar "${task.term}": skipped after keyless throttling`;
        ctx.log(`SKIPPED ${task.error}`);
        return;
      }
      const limit =
        task.api === "semantic-scholar" && task.throttleable ? s2Limit() : task.limit;
      if (task.api === "semantic-scholar") task.meta.requested = limit;
      try {
        const searchResult =
          task.kind === "search"
            ? task.api === "openalex"
              ? await searchOpenAlex(
                  ctx.fetch,
                  task.term,
                  task.sort,
                  task.limit,
                  task.page,
                )
              : await searchSemanticScholar(
                  ctx.fetch,
                  task.term,
                  limit,
                  task.page,
                )
            : null;
        const rawRecords =
          task.kind === "backward-reference"
            ? await fetchBackwardReferences(
                ctx.fetch,
                task.anchorId as string,
                task.limit,
              )
            : task.kind === "forward-citation"
              ? await fetchForwardCitations(
                  ctx.fetch,
                  task.anchorId as string,
                  task.limit,
                )
            : searchResult?.records ?? [];
        task.meta.upstream_total_results =
          searchResult?.totalResults ?? null;
        const records =
          task.kind === "search"
            ? rawRecords
            : rawRecords.filter((result) =>
                isTopicalGraphAnchor(result, coreKeys),
              );
        if (task.kind === "search") {
          for (const result of records) result.search_angles = [task.angle];
        }
        task.meta.returned = records.length;
        task.records = records;
        task.error = undefined;
        ctx.log(
          `${task.kind} ${task.api} ${task.bucket} ${task.angle} "${task.term}": ` +
            `${records.length} records`,
        );
      } catch (err) {
        if (err instanceof UpstreamCooldownError) {
          upstreamCooldownMessage = err.message;
        }
        task.error =
          `${task.kind} ${task.api} ${task.angle} "${task.term}": ` +
          `${(err as Error).message}`;
        ctx.log(`FAILED ${task.error}`);
        if (
          task.api === "semantic-scholar" &&
          !s2Throttled &&
          /HTTP 429/.test(task.error)
        ) {
          s2Throttled = true;
          checkpoint.s2_throttled = true;
          ctx.log(
            s2ApiKey()
              ? "WARNING s2_throttled: Semantic Scholar hit 429 despite the 1 rps queue (D-027) — recorded in the manifest"
              : `WARNING s2_throttled: keyless Semantic Scholar hit 429 — reducing batch to ${S2_THROTTLED_PER_TERM}/term for retries (set S2_API_KEY for higher limits)`,
          );
        }
      }
    };

    while (checkpoint.cursor < checkpoint.tasks.length) {
      if (Date.now() >= softDeadline) {
        stopReason = "time_slice";
        break;
      }
      if (
        baseApiCalls + ctx.apiCalls() >=
        Math.max(1, maxCalls - reserveCalls)
      ) {
        stopReason = "call_cap";
        break;
      }
      if (accumulated.length >= maxRecords) {
        stopReason = "storage_tier_record_cap";
        break;
      }

      const task = checkpoint.tasks[checkpoint.cursor];
      ctx.log(`issuing query ${checkpoint.cursor + 1}: ${task.id}`);
      await runTask(task);
      checkpoint.cursor++;
      if (task.error) {
        checkpoint.api_calls_spent = baseApiCalls + ctx.apiCalls();
        if (upstreamCooldownMessage !== null) {
          checkpoint.slice_stop_reason = "upstream_quota";
          stopReason = "time_slice";
        }
        writeCheckpoint(checkpoint);
        if (upstreamCooldownMessage !== null) break;
        continue;
      }

      const uniqueReturned = dedupeRecords(task.records).records;
      const before = accumulated.length;
      accumulated = dedupeRecords([...accumulated, ...uniqueReturned]).records.slice(
        0,
        maxRecords,
      );
      const added = accumulated.length - before;
      const noveltyRate =
        uniqueReturned.length > 0 ? round4(added / uniqueReturned.length) : 0;
      const rolling = rollingNoveltyRate(
        checkpoint.novelty_curve,
        noveltyRate,
        saturation.window_queries,
      );
      task.meta.unique_returned = uniqueReturned.length;
      task.meta.records_added = added;
      task.meta.novelty_rate = noveltyRate;
      task.meta.rolling_novelty_rate = rolling;
      checkpoint.novelty_curve.push({
        query_index: checkpoint.novelty_curve.length + 1,
        query_id: task.id,
        bucket: task.bucket,
        kind: task.kind,
        returned: task.records.length,
        unique_returned: uniqueReturned.length,
        records_added: added,
        novelty_rate: noveltyRate,
        rolling_novelty_rate: rolling,
        cumulative_records: accumulated.length,
      });

      if (task.kind === "search" && expandedAnchors.size < saturation.citation_graph.max_anchors) {
        const graphTasks: QueryTask[] = [];
        for (const candidate of uniqueReturned) {
          if (
            !candidate.openalex_id ||
            expandedAnchors.has(candidate.openalex_id) ||
            expandedAnchors.size >= saturation.citation_graph.max_anchors
          ) {
            continue;
          }
          checkpoint.topical_candidates++;
          if (!isTopicalGraphAnchor(candidate, coreKeys)) {
            checkpoint.topical_rejected++;
            continue;
          }
          checkpoint.topical_confirmed++;
          expandedAnchors.add(candidate.openalex_id);
          for (const direction of enabledGraphDirections(saturation.citation_graph)) {
            graphTasks.push(graphTask(direction, candidate));
          }
        }
        if (graphTasks.length > 0) {
          // Preserve a balanced search triplet before graph work so dynamic
          // expansion cannot starve recency/citation retrieval.
          const insertion = Math.min(
            checkpoint.tasks.length,
            checkpoint.cursor + 2,
          );
          checkpoint.tasks.splice(insertion, 0, ...graphTasks);
          checkpoint.expanded_anchor_ids = Array.from(expandedAnchors);
        }
      }

      checkpoint.api_calls_spent = baseApiCalls + ctx.apiCalls();
      if (
        checkpoint.cursor % saturation.checkpoint_every_queries === 0
      ) {
        writeCheckpoint(checkpoint);
        reportProgress(
          `harvesting (query ${checkpoint.cursor}/${checkpoint.tasks.length})`,
          "running",
          false,
        );
      }

      if (
        saturationReached(
          checkpoint.novelty_curve.length,
          rolling,
          saturation,
        )
      ) {
        stopReason = "saturation";
        break;
      }
    }

    if (stopReason === null) {
      // The deterministic frontier was fully consumed. Its final complete
      // window is the best available saturation signal.
      const last = checkpoint.novelty_curve.at(-1);
      stopReason =
        checkpoint.novelty_curve.length >= saturation.minimum_queries &&
        last?.rolling_novelty_rate !== null &&
        (last?.rolling_novelty_rate ?? 1) < saturation.novelty_threshold
          ? "saturation"
          : "call_cap";
    }

    checkpoint.api_calls_spent =
      baseApiCalls + ctx.apiCalls();
    if (stopReason === "time_slice") {
      checkpoint.slice_stop_reason = upstreamCooldownMessage
        ? "upstream_quota"
        : "time_slice";
      writeCheckpoint(checkpoint);
      reportProgress(
        checkpoint.slice_stop_reason === "upstream_quota"
          ? "paused — upstream quota, will resume"
          : "paused — time slice, will resume",
        "partial",
        true,
      );
      return {
        status: "partial",
        recordsFetched: accumulated.length,
        files: [],
        error: checkpoint.slice_stop_reason === "upstream_quota"
          ? `upstream API quota requires a later continuation; logical run ${checkpoint.logical_run_id} checkpointed ` +
            `at query ${checkpoint.cursor}/${checkpoint.tasks.length}`
          : `soft time limit reached; logical run ${checkpoint.logical_run_id} checkpointed ` +
            `at query ${checkpoint.cursor}/${checkpoint.tasks.length}`,
        warnings: { resume_required: true },
      };
    }
    removeCheckpoint(mechanismId as string);

    const completedTasks = checkpoint.tasks.slice(0, checkpoint.cursor);
    const searchTasks = completedTasks.filter((task) => task.kind === "search");
    const searchDedupe = dedupeRecords(searchTasks.flatMap((task) => task.records));
    const queries = completedTasks.map((task) => ({
      ...task.meta,
      upstream_total_results: task.meta.upstream_total_results ?? null,
    }));
    const failures = completedTasks
      .filter((task) => task.error)
      .map((task) => task.error as string);
    if (queries.length > 0 && failures.length === queries.length) {
      throw new Error(`All queries failed — ${failures.join(" · ")}`);
    }

    const currentYear = new Date().getUTCFullYear();
    const diversityReport = buildDiversityReport(
      searchTasks,
      searchDedupe.records,
      searchDedupe.groups,
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

    let records = accumulated;

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

    // The storage-tier cap is a runtime invariant, including pins and legacy
    // review snowballing. Pins win, then the most cited records fill the tier.
    records = dedupeRecords(records).records
      .sort(
        (a, b) =>
          Number(b.source_api === "pinned") - Number(a.source_api === "pinned") ||
          (b.citations ?? -1) - (a.citations ?? -1),
      )
      .slice(0, maxRecords);
    if (records.length >= maxRecords && stopReason !== "saturation") {
      stopReason = "storage_tier_record_cap";
    }

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

    const recordsWithIds = assignCorpusRecordIds(records);
    const retrievalCounts: Record<RetrievalBucket, number> = {
      relevance: 0,
      recency: 0,
      citation: 0,
    };
    for (const task of searchTasks) retrievalCounts[task.bucket]++;
    const completedGraphAnchors = new Set(
      completedTasks
        .filter((task) => task.kind !== "search")
        .flatMap((task) => (task.anchorId ? [task.anchorId] : [])),
    );
    const topicalTotal = checkpoint.topical_candidates;
    const saturationReport: SaturationReport = {
      queries_issued: checkpoint.novelty_curve.length,
      records_added: Math.max(
        0,
        recordsWithIds.length - (previousRecords?.length ?? 0),
      ),
      novelty_curve: checkpoint.novelty_curve,
      window_queries: saturation.window_queries,
      novelty_threshold: saturation.novelty_threshold,
      minimum_queries: saturation.minimum_queries,
      retrieval_counts: retrievalCounts,
      topical_candidates: topicalTotal,
      topical_confirmed: checkpoint.topical_confirmed,
      topical_rejected: checkpoint.topical_rejected,
      topical_confirmation_rate:
        topicalTotal > 0
          ? round4(checkpoint.topical_confirmed / topicalTotal)
          : 0,
      graph_anchors_expanded: completedGraphAnchors.size,
      field_union_estimate: estimateFieldUnion(
        completedTasks,
        recordsWithIds.length,
      ),
      saturation_reached: stopReason === "saturation",
      stop_reason: stopReason,
      cap: {
        max_calls: maxCalls,
        max_unique_records: maxRecords,
      },
    };
    const file: EvidenceFile = {
      mechanism_id: mechanismId as string,
      fetched_at: new Date().toISOString(),
      terms_source: termsSource,
      terms,
      queries,
      coverage_report: coverageReport,
      category_counts: categoryCounts,
      diversity_report: diversityReport,
      saturation_report: saturationReport,
      records: recordsWithIds,
    };

    // Run warnings shared across both return paths (D-018/D-058): degradation
    // and low-novelty flags flow through to the manifest.
    const warnings: Record<string, boolean> = {};
    if (s2Throttled) warnings.s2_throttled = true;
    if (lowNovelty) warnings.low_novelty = true;
    if (stopReason === "call_cap" || stopReason === "storage_tier_record_cap") {
      warnings.capped = true;
    }

    // Anti-regression guardrail (D-038): a re-harvest that produces FEWER
    // records than the existing corpus is suspicious — a dropped evidence_terms
    // (name-only fallback), an upstream outage, or a throttled partial. Never
    // silently overwrite hard-won breadth with a weaker pull. Write to a side
    // file for review instead and flag the run; the existing corpus is kept.
    const existingCount = previousRecords?.length ?? null;
    if (existingCount !== null && recordsWithIds.length < existingCount) {
      const sideFile = `${mechanismId}.regression.json`;
      ctx.writeJson(sideFile, file);
      const message =
        `regression suspected: re-harvest produced ${recordsWithIds.length} records vs ${existingCount} ` +
        `already in the corpus — corpus NOT overwritten; wrote ${sideFile} for review (D-038)`;
      ctx.log(`WARNING ${message}`);
      reportProgress("regression suspected — corpus kept", "partial", true, message);
      return {
        status: "partial",
        recordsFetched: recordsWithIds.length,
        files: [{ path: sideFile, records: recordsWithIds.length, categories: categoryCounts }],
        error: [message, ...failures].join(" · "),
        warnings: { regression_suspected: true, ...warnings },
      };
    }

    ctx.writeJson(fileName, file);
    ctx.log(`wrote ${recordsWithIds.length} deduplicated records to ${fileName}`);
    reportProgress(
      failures.length > 0 ? "completed with query failures" : "completed",
      failures.length > 0 ? "partial" : "success",
      true,
    );

    return {
      status: failures.length > 0 ? "partial" : "success",
      recordsFetched: recordsWithIds.length,
      files: [{ path: fileName, records: recordsWithIds.length, categories: categoryCounts }],
      ...(failures.length > 0 ? { error: failures.join(" · ") } : {}),
      ...(Object.keys(warnings).length > 0 ? { warnings } : {}),
    };
  },
};

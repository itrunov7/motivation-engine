/**
 * tools/connectors/evidence.ts — Connector #1: the science pipeline.
 *
 * Harvests the published literature for one mechanism from two D-011
 * whitelisted APIs (source_ids: openalex, semantic-scholar) into a merged,
 * readable evidence file: /corpora/evidence/{mechanism_id}.json.
 *
 * Usage:
 *   npm run connector -- evidence mechanism=LA-01 \
 *     terms="loss aversion;prospect theory meta-analysis"
 *
 * Per search term:
 * - OpenAlex /works: title/abstract match, sorted by cited_by_count, top 25.
 *   A cross-attribute OR (type:review|meta-analysis OR text match) is not
 *   expressible in a single OpenAlex filter; the citation sort surfaces
 *   reviews and meta-analyses at the top of the text match anyway.
 * - Semantic Scholar /graph/v1/paper/search: relevance search, top 15.
 *   Sends x-api-key when the S2_API_KEY env var is set; works keyless at
 *   public rate limits otherwise. The keyless pool is shared and 429s in
 *   bursts, so failed terms get up to 3 retry passes with 30s cooldowns.
 *
 * Records are deduplicated by DOI (fallback: normalized title). Fetch and
 * structure ONLY — no scoring, no "quality" filtering, no summaries. What
 * the canon says is for the dossier process to weigh, not this script.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Connector, PoliteFetch, RunResult } from "./types";

const MECHANISMS_DIR = join(__dirname, "..", "..", "registry", "mechanisms");

const OPENALEX_PER_TERM = 25;
const S2_PER_TERM = 15;

/** Cooldown before retrying terms that failed on the shared keyless pool. */
const RETRY_COOLDOWN_MS = 30_000;

/** Max cooldown-and-retry passes for failed queries. */
const MAX_RETRY_PASSES = 3;

// ---------- Output shape (/corpora/evidence/{mechanism_id}.json) ----------

type SourceApi = "openalex" | "semantic-scholar";

interface EvidenceRecord {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  citations: number | null;
  abstract: string | null;
  source_api: SourceApi;
}

interface QueryMeta {
  api: SourceApi;
  term: string;
  requested: number;
  returned: number;
}

interface EvidenceFile {
  mechanism_id: string;
  fetched_at: string;
  queries: QueryMeta[];
  records: EvidenceRecord[];
}

// ---------- Upstream response shapes (only the fields we read) ----------

interface OpenAlexWork {
  doi: string | null;
  title: string | null;
  display_name: string | null;
  publication_year: number | null;
  cited_by_count: number | null;
  authorships: { author?: { display_name?: string | null } }[] | null;
  primary_location: { source?: { display_name?: string | null } | null } | null;
  abstract_inverted_index: Record<string, number[]> | null;
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

/** Dedup key: DOI when present, else lowercase-alphanumeric title. */
function dedupKey(record: EvidenceRecord): string {
  if (record.doi) return `doi:${record.doi}`;
  return `title:${record.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
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

/** First-seen record wins; the duplicate only fills fields the winner lacks. */
function mergeInto(target: EvidenceRecord, duplicate: EvidenceRecord): void {
  target.doi = target.doi ?? duplicate.doi;
  target.year = target.year ?? duplicate.year;
  target.venue = target.venue ?? duplicate.venue;
  target.citations = target.citations ?? duplicate.citations;
  target.abstract = target.abstract ?? duplicate.abstract;
  if (target.authors.length === 0) target.authors = duplicate.authors;
}

// ---------- Per-API fetchers ----------

async function fetchJson<T>(fetch: PoliteFetch, url: URL, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url.hostname}${url.pathname}`);
  }
  return (await response.json()) as T;
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
  url.searchParams.set(
    "select",
    "doi,title,display_name,publication_year,cited_by_count,authorships,primary_location,abstract_inverted_index",
  );

  const data = await fetchJson<{ results?: OpenAlexWork[] }>(fetch, url);
  return (data.results ?? []).flatMap((work) => {
    const title = work.title ?? work.display_name;
    if (!title) return [];
    return [
      {
        title,
        authors: (work.authorships ?? [])
          .map((a) => a.author?.display_name ?? "")
          .filter((name) => name.length > 0),
        year: work.publication_year ?? null,
        venue: work.primary_location?.source?.display_name ?? null,
        doi: normalizeDoi(work.doi),
        citations: work.cited_by_count ?? null,
        abstract: reconstructAbstract(work.abstract_inverted_index),
        source_api: "openalex" as const,
      },
    ];
  });
}

async function searchSemanticScholar(
  fetch: PoliteFetch,
  term: string,
): Promise<EvidenceRecord[]> {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", term);
  url.searchParams.set("limit", String(S2_PER_TERM));
  url.searchParams.set("fields", "title,authors,year,venue,externalIds,citationCount,abstract");

  const apiKey = process.env.S2_API_KEY;
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
        source_api: "semantic-scholar" as const,
      },
    ];
  });
}

// ---------- Params ----------

function parseTerms(raw: string | undefined): string[] {
  const terms = (raw ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) {
    throw new Error(
      'Missing search terms. Usage: npm run connector -- evidence mechanism=LA-01 terms="loss aversion;prospect theory meta-analysis"',
    );
  }
  return terms;
}

function assertKnownMechanism(mechanismId: string | undefined): string {
  if (!mechanismId) {
    throw new Error(
      'Missing mechanism id. Usage: npm run connector -- evidence mechanism=LA-01 terms="…;…"',
    );
  }
  const asFull = join(MECHANISMS_DIR, `${mechanismId}.json`);
  const asSeed = join(MECHANISMS_DIR, "_seed", `${mechanismId}.json`);
  if (!existsSync(asFull) && !existsSync(asSeed)) {
    throw new Error(
      `Mechanism "${mechanismId}" is not in the registry (/registry/mechanisms) — no corpora for phantom mechanisms.`,
    );
  }
  return mechanismId;
}

// ---------- The connector ----------

export const evidenceConnector: Connector = {
  id: "evidence",
  sourceId: "evidence",
  sourceIds: ["openalex", "semantic-scholar"],
  connectorVersion: "1.0.0",
  description:
    "Evidence harvester: OpenAlex + Semantic Scholar literature for one mechanism → {mechanism_id}.json. Fetch and structure only.",

  async run(ctx, params): Promise<RunResult> {
    const mechanismId = assertKnownMechanism(params.mechanism);
    const terms = parseTerms(params.terms);

    const deduped = new Map<string, EvidenceRecord>();

    interface QueryTask {
      api: SourceApi;
      term: string;
      requested: number;
      search: (term: string) => Promise<EvidenceRecord[]>;
      meta: QueryMeta;
      error?: string;
    }

    const tasks: QueryTask[] = [
      { api: "openalex" as const, requested: OPENALEX_PER_TERM, search: (t: string) => searchOpenAlex(ctx.fetch, t) },
      { api: "semantic-scholar" as const, requested: S2_PER_TERM, search: (t: string) => searchSemanticScholar(ctx.fetch, t) },
    ].flatMap((s) =>
      terms.map((term): QueryTask => ({
        ...s,
        term,
        meta: { api: s.api, term, requested: s.requested, returned: 0 },
      })),
    );

    const runTask = async (task: QueryTask): Promise<void> => {
      try {
        const records = await task.search(task.term);
        task.meta.returned = records.length;
        task.error = undefined;
        for (const record of records) {
          const key = dedupKey(record);
          const existing = deduped.get(key);
          if (existing) mergeInto(existing, record);
          else deduped.set(key, record);
        }
        ctx.log(`${task.api} "${task.term}": ${records.length} records`);
      } catch (err) {
        task.error = `${task.api} "${task.term}": ${(err as Error).message}`;
        ctx.log(`FAILED ${task.error}`);
      }
    };

    for (const task of tasks) await runTask(task);

    // Retry passes: the keyless Semantic Scholar pool 429s in bursts.
    const failed = () => tasks.filter((t) => t.error);
    for (let pass = 1; pass <= MAX_RETRY_PASSES; pass++) {
      if (failed().length === 0 || failed().length === tasks.length) break;
      ctx.log(
        `retry pass ${pass}/${MAX_RETRY_PASSES}: ${failed().length} failed queries after ${RETRY_COOLDOWN_MS / 1000}s cooldown`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_COOLDOWN_MS));
      for (const task of failed()) await runTask(task);
    }

    const queries = tasks.map((t) => t.meta);
    const failures = failed().map((t) => t.error as string);
    if (failures.length === tasks.length) {
      throw new Error(`All queries failed — ${failures.join(" · ")}`);
    }

    // Presentation order only (readability), not a quality judgment.
    const records = Array.from(deduped.values()).sort(
      (a, b) => (b.citations ?? -1) - (a.citations ?? -1) || a.title.localeCompare(b.title),
    );

    const file: EvidenceFile = {
      mechanism_id: mechanismId,
      fetched_at: new Date().toISOString(),
      queries,
      records,
    };
    const fileName = `${mechanismId}.json`;
    ctx.writeJson(fileName, file);
    ctx.log(`wrote ${records.length} deduplicated records to ${fileName}`);

    return {
      status: failures.length > 0 ? "partial" : "success",
      recordsFetched: records.length,
      files: [{ path: fileName, records: records.length }],
      ...(failures.length > 0 ? { error: failures.join(" · ") } : {}),
    };
  },
};

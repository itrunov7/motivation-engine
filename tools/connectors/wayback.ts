/**
 * tools/connectors/wayback.ts — Connector #2: interface evolution.
 *
 * Builds a time-lapse INDEX of surviving products' web surfaces from the
 * Internet Archive CDX API (source_id: wayback-cdx, D-011 whitelisted):
 * per domain, one clean (statuscode 200) capture per quarter across a year
 * range → /corpora/wayback/{domain}.json. URLs and dates ONLY — page
 * contents are deliberately NOT downloaded at this step (content harvesting
 * is a later, size-conscious step; a full-page corpus would blow the 40 MB
 * corpus guardrail immediately).
 *
 * Usage:
 *   npm run connector -- wayback
 *   npm run connector -- wayback domains="duolingo.com;calm.com;notion.so"
 *   npm run connector -- wayback path=/onboarding years=2018-2024
 *
 * Params:
 * - domains="a.com;b.com" — semicolon list; default: the full owner-editable
 *   list in tools/connectors/wayback-domains.json.
 * - path=/onboarding — optional path appended to every domain's CDX query;
 *   default: the original page (bare domain).
 * - years=2015-2026 — inclusive range; default 2015-2026.
 *
 * Per domain, ONE CDX call:
 *   /cdx/search/cdx?url={domain}{path}&output=json&from={y1}&to={y2}
 *     &filter=statuscode:200&collapse=timestamp:6&fl=timestamp,original
 * collapse=timestamp:6 collapses server-side to at most one capture per
 * MONTH (a quarter is not expressible in CDX collapse); the connector then
 * reduces client-side to the FIRST capture of each quarter.
 *
 * Failure handling mirrors evidence.ts: a domain that errors is logged and
 * skipped, the run returns "partial" with the joined errors, and throws only
 * if every domain failed. A domain with zero captures still writes an honest
 * empty file — "the archive has nothing" is a finding, not an error.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connector, PoliteFetch, RunQuote, RunResult } from "./types";

/** Owner-editable starter domain list (survivor products). */
const DOMAINS_FILE = join(__dirname, "wayback-domains.json");

const DEFAULT_YEAR_FROM = 2015;
const DEFAULT_YEAR_TO = 2026;

/** Polite spacing for web.archive.org calls (run-connector minIntervalMs). */
const QUOTE_POLITE_INTERVAL_S = 1.0;

// ---------- Output shape (/corpora/wayback/{domain}.json) ----------

interface WaybackCapture {
  /** Capture date, "YYYY-MM-DD". */
  date: string;
  /** Replay URL: https://web.archive.org/web/{timestamp}/{original}. */
  wayback_url: string;
  /** The URL as captured (scheme/host variant the crawler saw). */
  original_url: string;
}

interface WaybackFile {
  domain: string;
  /** The optional path suffix this index was queried with, or null. */
  path: string | null;
  fetched_at: string;
  years: { from: number; to: number };
  captures: WaybackCapture[];
}

// ---------- Params ----------

interface YearRange {
  from: number;
  to: number;
}

function loadDomainList(): string[] {
  const data = JSON.parse(readFileSync(DOMAINS_FILE, "utf-8")) as {
    domains?: string[];
  };
  const domains = (data.domains ?? []).filter((d) => d.trim().length > 0);
  if (domains.length === 0) {
    throw new Error(`No domains in ${DOMAINS_FILE} — the owner-editable list is empty.`);
  }
  return domains;
}

function resolveDomains(param: string | undefined): string[] {
  const fromParam = (param ?? "")
    .split(";")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  const domains = fromParam.length > 0 ? fromParam : loadDomainList();
  for (const domain of domains) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      throw new Error(`"${domain}" is not a bare domain (expected e.g. duolingo.com).`);
    }
  }
  return domains;
}

function resolveYears(param: string | undefined): YearRange {
  if (!param) return { from: DEFAULT_YEAR_FROM, to: DEFAULT_YEAR_TO };
  const match = /^(\d{4})-(\d{4})$/.exec(param.trim());
  if (!match) {
    throw new Error(`Invalid years "${param}" — expected e.g. years=2015-2026.`);
  }
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from > to) throw new Error(`Invalid years "${param}" — from (${from}) is after to (${to}).`);
  return { from, to };
}

function resolvePath(param: string | undefined): string | null {
  const trimmed = (param ?? "").trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

// ---------- CDX fetch + quarterly reduction ----------

/** CDX output=json: first row is the field header, then one row per capture. */
type CdxRow = [timestamp: string, original: string];

async function fetchCdxCaptures(
  fetch: PoliteFetch,
  domain: string,
  path: string | null,
  years: YearRange,
): Promise<WaybackCapture[]> {
  const url = new URL("https://web.archive.org/cdx/search/cdx");
  url.searchParams.set("url", `${domain}${path ?? ""}`);
  url.searchParams.set("output", "json");
  url.searchParams.set("from", String(years.from));
  url.searchParams.set("to", String(years.to));
  url.searchParams.set("filter", "statuscode:200");
  // Server-side collapse to ≤1 capture per month (timestamp prefix YYYYMM) —
  // the finest CDX collapse that still bounds the response; quarters are
  // reduced client-side below.
  url.searchParams.set("collapse", "timestamp:6");
  url.searchParams.set("fl", "timestamp,original");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url.hostname}${url.pathname}`);
  }
  const rows = (await response.json()) as CdxRow[];
  // Row 0 is the field header (["timestamp","original"]); an empty archive
  // returns [] with no header at all.
  const captures = rows.slice(1).flatMap((row): WaybackCapture[] => {
    const [timestamp, original] = row;
    if (!/^\d{14}$/.test(timestamp ?? "") || !original) return [];
    const date = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
    return [
      {
        date,
        wayback_url: `https://web.archive.org/web/${timestamp}/${original}`,
        original_url: original,
      },
    ];
  });
  return firstCapturePerQuarter(captures);
}

/** "2015-04-12" → "2015-Q2". */
function quarterKey(date: string): string {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  return `${year}-Q${Math.ceil(month / 3)}`;
}

/** Keep the FIRST capture of each quarter (input is CDX chronological order). */
function firstCapturePerQuarter(captures: WaybackCapture[]): WaybackCapture[] {
  const seen = new Set<string>();
  const kept: WaybackCapture[] = [];
  for (const capture of captures) {
    const key = quarterKey(capture.date);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(capture);
  }
  return kept;
}

// ---------- The connector ----------

export const waybackConnector: Connector = {
  id: "wayback",
  sourceId: "wayback",
  sourceIds: ["wayback-cdx"],
  connectorVersion: "1.0.0",
  description:
    "Interface-evolution indexer: Wayback CDX quarterly capture index (statuscode 200, one per quarter) per survivor domain → {domain}.json. URLs and dates only — page contents are a later, size-conscious step.",

  /**
   * Deterministic pre-run estimate (D-025). No network: one CDX call per
   * domain; records are an upper bound of 4 quarters per year per domain.
   */
  quote(params): RunQuote {
    const domains = resolveDomains(params.domains);
    const years = resolveYears(params.years);
    const quarters = (years.to - years.from + 1) * 4;
    const calls = domains.length;
    return {
      calls,
      records: domains.length * quarters,
      duration_s: Math.round(calls * QUOTE_POLITE_INTERVAL_S * 10) / 10,
      // estimated_usd is COMPUTED, not asserted: the CDX API is free (D-011).
      estimated_usd: 0,
    };
  },

  async run(ctx, params): Promise<RunResult> {
    const domains = resolveDomains(params.domains);
    const years = resolveYears(params.years);
    const path = resolvePath(params.path);
    ctx.log(
      `indexing ${domains.length} domain(s), ${years.from}–${years.to}` +
        (path ? `, path ${path}` : ""),
    );

    const files: RunResult["files"] = [];
    const failures: string[] = [];
    let totalCaptures = 0;

    for (const domain of domains) {
      try {
        const captures = await fetchCdxCaptures(ctx.fetch, domain, path, years);
        const file: WaybackFile = {
          domain,
          path,
          fetched_at: new Date().toISOString(),
          years,
          captures,
        };
        const fileName = `${domain}.json`;
        ctx.writeJson(fileName, file);
        files.push({ path: fileName, records: captures.length });
        totalCaptures += captures.length;
        ctx.log(
          captures.length > 0
            ? `${domain}: ${captures.length} quarterly captures (${captures[0].date} → ${captures[captures.length - 1].date})`
            : `${domain}: no captures in the archive for this range — wrote an honest empty index`,
        );
      } catch (err) {
        const message = `${domain}: ${(err as Error).message}`;
        failures.push(message);
        ctx.log(`FAILED ${message}`);
      }
    }

    if (failures.length === domains.length) {
      throw new Error(`All domains failed — ${failures.join(" · ")}`);
    }

    return {
      status: failures.length > 0 ? "partial" : "success",
      recordsFetched: totalCaptures,
      files,
      ...(failures.length > 0 ? { error: failures.join(" · ") } : {}),
    };
  },
};

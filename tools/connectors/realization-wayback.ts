/**
 * Bounded Wayback replay-text ingestion for interface realization corpora
 * (D-081). It consumes the existing CDX index, keeps only visible text, and
 * never stores raw HTML or binaries.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveRealizationRecordId } from "../../lib/realization-corpus";
import type {
  RealizationCorpusFile,
  RealizationCorpusRecord,
} from "../../lib/types";
import type { Connector, RunQuote } from "./types";

const ROOT = join(__dirname, "..", "..");
const TARGETS_FILE = join(__dirname, "realization-wayback-targets.json");
const MAX_TEXT_CHARS = 12_000;

interface TargetConfig {
  domain: string;
  artifact_context: string[];
}

interface WaybackCapture {
  date: string;
  wayback_url: string;
  original_url: string;
}

interface WaybackIndex {
  domain: string;
  captures: WaybackCapture[];
}

function targets(): Record<string, TargetConfig> {
  return (
    JSON.parse(readFileSync(TARGETS_FILE, "utf8")) as {
      targets: Record<string, TargetConfig>;
    }
  ).targets;
}

function selectedTarget(params: Record<string, string>): {
  mechanismId: string;
  config: TargetConfig;
  capture?: string;
} {
  const mechanismId = params.mechanism;
  if (!mechanismId || !/^[A-Z]{2}-\d{2}$/.test(mechanismId)) {
    throw new Error("realization-wayback requires mechanism=XX-00");
  }
  const configured = targets()[mechanismId];
  const domain = params.domain ?? configured?.domain;
  const artifactContext = params.artifact_context
    ?.split(";")
    .map((item) => item.trim())
    .filter(Boolean) ?? configured?.artifact_context;
  if (!domain || !artifactContext?.length) {
    throw new Error(
      `No realization Wayback target for ${mechanismId}; provide domain= and artifact_context=a;b`,
    );
  }
  return {
    mechanismId,
    config: { domain, artifact_context: artifactContext },
    ...(params.capture ? { capture: params.capture } : {}),
  };
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

export function visibleReplayText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function rawReplayUrl(url: string): string {
  return url.replace(/\/web\/(\d{14})\//, "/web/$1id_/");
}

function readExisting(mechanismId: string): RealizationCorpusFile | null {
  const path = join(
    ROOT,
    "corpora",
    "realizations",
    mechanismId,
    "records.json",
  );
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as RealizationCorpusFile)
    : null;
}

export const realizationWaybackConnector: Connector = {
  id: "realization-wayback",
  sourceId: "realizations",
  sourceIds: ["wayback-cdx"],
  connectorVersion: "1.0.0",
  description:
    "Fetch one selected Wayback replay and retain bounded visible text as interface evidence.",

  quote(params): RunQuote {
    selectedTarget(params);
    return { calls: 1, records: 1, duration_s: 1, estimated_usd: 0 };
  },

  async run(ctx, params) {
    const { mechanismId, config, capture } = selectedTarget(params);
    const indexPath = join(ROOT, "corpora", "wayback", `${config.domain}.json`);
    if (!existsSync(indexPath)) {
      throw new Error(`Missing Wayback index corpora/wayback/${config.domain}.json`);
    }
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as WaybackIndex;
    const selected = capture
      ? index.captures.find(
          (item) => item.date === capture || item.wayback_url === capture,
        )
      : index.captures.at(-1);
    if (!selected) throw new Error(`No matching capture for ${config.domain}`);

    const response = await ctx.fetch(rawReplayUrl(selected.wayback_url), {
      headers: { accept: "text/html" },
    });
    if (!response.ok) {
      throw new Error(`Wayback replay returned HTTP ${response.status}`);
    }
    const observation = visibleReplayText(await response.text());
    if (observation.length < 40) {
      throw new Error("Wayback replay produced no useful visible text");
    }

    const base = {
      mechanism_id: mechanismId,
      source_id: "wayback-cdx",
      origin: "harvested" as const,
      title: `${config.domain} interface — ${selected.date} Wayback capture`,
      source_url: selected.wayback_url,
      source_locator: selected.wayback_url,
      observed_at: selected.date,
      observation,
      artifact_context: config.artifact_context,
      contributed_by: null,
      license_note: "Wayback CDX/replay public access; bounded text only",
    };
    const record: RealizationCorpusRecord = {
      record_id: deriveRealizationRecordId(base),
      ...base,
    };
    const existing = readExisting(mechanismId);
    const records = [
      ...(existing?.records ?? []).filter(
        (item) => item.record_id !== record.record_id,
      ),
      record,
    ].sort((left, right) => left.record_id.localeCompare(right.record_id));
    const file: RealizationCorpusFile = {
      mechanism_id: mechanismId,
      updated_at: new Date().toISOString(),
      records,
    };
    const path = `${mechanismId}/records.json`;
    ctx.writeJson(path, file);
    ctx.log(`${mechanismId}: retained ${observation.length} visible-text characters`);
    return {
      status: "success",
      recordsFetched: 1,
      files: [{ path, records: records.length }],
    };
  },
};

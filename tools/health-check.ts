/**
 * tools/health-check.ts — source health heartbeat (D-021).
 *
 * Health is a separate axis from connection: connection says "has a harvest
 * run ever succeeded" (computed from corpus manifests, D-013/D-014); health
 * says "is the API answering right now". For every api/internal source in
 * /sources/sources.json this script performs ONE minimal request (a
 * single-record search) and records the outcome in
 * /corpora/_health/heartbeat.json. The app never calls external APIs —
 * it only reads that file.
 *
 * Rules:
 * - Probes are restricted to the D-011 whitelist. Api sources whose host is
 *   not whitelisted get status "unknown" with a "no probe" note — the
 *   whitelist grows when a connector for that source gets built, not ahead
 *   of it. Internal sources get "n_a": no external endpoint by design.
 * - One attempt per probe, no retries — retries would mask "degraded".
 * - Status mapping: ok = 2xx (except 206); degraded = 429 or 206 (the
 *   s2_throttled condition, D-018); down = network error, timeout, or any
 *   other HTTP status.
 * - Commit-noise rule: if the per-source status vector is identical to the
 *   committed heartbeat AND that heartbeat is younger than 11 hours, the
 *   file is left untouched (the workflow commits only when git sees a
 *   diff). The 11h refresh keeps the heartbeat inside the UI's 12h stale
 *   threshold on quiet days.
 * - A "down" source is a recorded fact, not a script failure: the script
 *   exits 0 whenever the probe loop itself ran; non-zero only on script
 *   errors (malformed sources.json, unwritable file).
 *
 * Usage: npm run health
 * Env: CONNECTOR_MAILTO (polite headers / OpenAlex mailto param),
 *      S2_API_KEY (optional Semantic Scholar key, D-018).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ALLOWED_HOSTS } from "./connectors/lib/http";
import { writeJsonPretty } from "./connectors/lib/io";

const ROOT = join(__dirname, "..");
const SOURCES_FILE = join(ROOT, "sources", "sources.json");
const HEARTBEAT_FILE = join(ROOT, "corpora", "_health", "heartbeat.json");

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_SPACING_MS = 1_000;
/** Rewrite an unchanged heartbeat only after this many hours (D-021). */
const REFRESH_HOURS = 11;

// ---------- Heartbeat contract (writer side; reader mirror in lib/types.ts) ----------

export type HealthStatus = "ok" | "degraded" | "down" | "unknown" | "n_a";

export interface HeartbeatEntry {
  source_id: string;
  checked_at: string;
  status: HealthStatus;
  /** Round-trip of the probe; null when no request was made. */
  latency_ms: number | null;
  note: string;
}

export interface HeartbeatFile {
  generated_at: string;
  entries: HeartbeatEntry[];
}

// ---------- Probe table ----------

interface Probe {
  url: string;
  /** Human description of the request, recorded in the entry note. */
  request: string;
  headers?: Record<string, string>;
}

/**
 * One minimal single-record request per probeable source. Every host here
 * must be in the D-011 whitelist — enforced again at probe time.
 */
function buildProbes(): Record<string, Probe> {
  const mailto = process.env.CONNECTOR_MAILTO;
  const s2Key = process.env.S2_API_KEY;

  const openalex = new URL("https://api.openalex.org/works");
  openalex.searchParams.set("search", "motivation");
  openalex.searchParams.set("per-page", "1");
  if (mailto) openalex.searchParams.set("mailto", mailto);

  return {
    openalex: {
      url: openalex.toString(),
      request: "GET /works search=motivation per-page=1",
    },
    "semantic-scholar": {
      url: "https://api.semanticscholar.org/graph/v1/paper/search?query=motivation&limit=1",
      request: `GET /graph/v1/paper/search limit=1 (${s2Key ? "keyed" : "keyless"})`,
      ...(s2Key ? { headers: { "x-api-key": s2Key } } : {}),
    },
    "pubmed-europepmc": {
      url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=motivation&retmax=1&retmode=json",
      request: "GET esearch.fcgi db=pubmed retmax=1",
    },
    "wayback-cdx": {
      url: "https://web.archive.org/cdx/search/cdx?url=example.com&output=json&limit=1",
      request: "GET /cdx/search/cdx limit=1",
    },
  };
}

// ---------- Probe execution ----------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProbe(sourceId: string, probe: Probe): Promise<HeartbeatEntry> {
  const url = new URL(probe.url);
  if (!(ALLOWED_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new Error(
      `Probe host "${url.hostname}" for "${sourceId}" is not in the D-011 whitelist (${ALLOWED_HOSTS.join(", ")}).`,
    );
  }

  const mailto = process.env.CONNECTOR_MAILTO;
  const headers: Record<string, string> = {
    "user-agent": `motivation-engine/0.1 (${mailto ? `mailto:${mailto}` : "no-contact-configured"})`,
    accept: "application/json",
    ...probe.headers,
  };

  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    // Drain the body so the socket closes cleanly.
    await response.arrayBuffer().catch(() => undefined);

    const status: HealthStatus =
      response.status === 429 || response.status === 206
        ? "degraded"
        : response.ok
          ? "ok"
          : "down";
    const detail =
      status === "degraded"
        ? `HTTP ${response.status} (throttled)`
        : `HTTP ${response.status}`;
    return {
      source_id: sourceId,
      checked_at: checkedAt,
      status,
      latency_ms: latencyMs,
      note: `${probe.request} — ${detail}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const error = err as Error;
    const reason =
      error.name === "TimeoutError"
        ? `timeout after ${PROBE_TIMEOUT_MS / 1000}s`
        : (error.cause as Error | undefined)?.message ?? error.message;
    return {
      source_id: sourceId,
      checked_at: checkedAt,
      status: "down",
      latency_ms: latencyMs,
      note: `${probe.request} — ${reason}`,
    };
  }
}

// ---------- Main ----------

interface SourceLike {
  id: string;
  connection_mode: string;
}

function loadHealthSources(): SourceLike[] {
  const registry = JSON.parse(readFileSync(SOURCES_FILE, "utf-8")) as {
    classes: { sources: SourceLike[] }[];
  };
  return registry.classes
    .flatMap((cls) => cls.sources)
    .filter(
      (source) =>
        source.connection_mode === "api" || source.connection_mode === "internal",
    );
}

function loadPreviousHeartbeat(): HeartbeatFile | undefined {
  if (!existsSync(HEARTBEAT_FILE)) return undefined;
  try {
    return JSON.parse(readFileSync(HEARTBEAT_FILE, "utf-8")) as HeartbeatFile;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const sources = loadHealthSources();
  const probes = buildProbes();
  console.log(
    `Health check — ${sources.length} api/internal sources, probing whitelisted hosts only (D-011)\n`,
  );

  const entries: HeartbeatEntry[] = [];
  let probed = false;
  for (const source of sources) {
    if (source.connection_mode === "internal") {
      entries.push({
        source_id: source.id,
        checked_at: new Date().toISOString(),
        status: "n_a",
        latency_ms: null,
        note: "internal source — no external endpoint by design",
      });
    } else {
      const probe = probes[source.id];
      if (!probe) {
        entries.push({
          source_id: source.id,
          checked_at: new Date().toISOString(),
          status: "unknown",
          latency_ms: null,
          note: "no probe — host not in the D-011 whitelist (a probe arrives with this source's connector)",
        });
      } else {
        if (probed) await sleep(PROBE_SPACING_MS);
        probed = true;
        entries.push(await runProbe(source.id, probe));
      }
    }
    const entry = entries[entries.length - 1];
    const latency = entry.latency_ms === null ? "" : ` (${entry.latency_ms}ms)`;
    console.log(`  ${entry.source_id}: ${entry.status}${latency} — ${entry.note}`);
  }

  // Commit-noise rule: leave the file untouched when nothing changed and
  // the committed heartbeat is still fresh enough for the 12h UI threshold.
  const previous = loadPreviousHeartbeat();
  if (previous) {
    const sameVector =
      entries.length === previous.entries.length &&
      entries.every(
        (entry) =>
          previous.entries.find((p) => p.source_id === entry.source_id)?.status ===
          entry.status,
      );
    const ageMs = Date.now() - Date.parse(previous.generated_at);
    const fresh = Number.isFinite(ageMs) && ageMs < REFRESH_HOURS * 3_600_000;
    if (sameVector && fresh) {
      console.log(
        `\nOK — statuses unchanged and heartbeat is ${Math.floor(ageMs / 3_600_000)}h old (<${REFRESH_HOURS}h): file left untouched, nothing to commit.`,
      );
      return;
    }
  }

  const heartbeat: HeartbeatFile = {
    generated_at: new Date().toISOString(),
    entries,
  };
  writeJsonPretty(HEARTBEAT_FILE, heartbeat);
  console.log(`\nOK — wrote ${relative(ROOT, HEARTBEAT_FILE)} (${entries.length} entries).`);
}

main().catch((err) => {
  console.error(`FAILED — ${(err as Error).message}`);
  process.exit(1);
});

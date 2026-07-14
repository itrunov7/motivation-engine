/**
 * tools/run-connector.ts — CLI runner for source connectors.
 *
 * Usage: npm run connector -- <id> [key=value ...]
 *   e.g. npm run connector -- dummy
 *        npm run connector -- dummy fail=1
 *        npm run connector -- openalex query=loss+aversion mailto=me@example.com
 *
 * Flow: look up the connector in the registry → execute → enforce the
 * 40 MB corpus guardrail → write /corpora/{source_id}/manifest.json.
 * The manifest is written on EVERY outcome (status failed on errors),
 * and the process exits non-zero on any failure.
 */

import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { CONNECTORS } from "./connectors";
import type { ManifestCost, ManifestRun, RunContext, RunParams, RunResult } from "./connectors/types";
import { createPoliteFetch } from "./connectors/lib/http";
import { MAX_CORPUS_BYTES, dirSizeBytes, formatBytes, writeJsonPretty } from "./connectors/lib/io";
import { writeManifest } from "./connectors/lib/manifest";
import { loadOpsConnectorConfigFromDisk } from "../lib/ops";

const ROOT = join(__dirname, "..");
const CORPORA_DIR = join(ROOT, "corpora");

function usage(): never {
  console.error("Usage: npm run connector -- <id> [key=value ...]");
  console.error(`Registered connectors: ${Object.keys(CONNECTORS).sort().join(", ")}`);
  process.exit(1);
}

function parseParams(args: string[]): RunParams {
  const params: RunParams = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      console.error(`Invalid param "${arg}" — expected key=value.`);
      usage();
    }
    params[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return params;
}

async function main(): Promise<void> {
  const [id, ...rest] = process.argv.slice(2);
  if (!id) usage();

  const connector = CONNECTORS[id];
  if (!connector) {
    console.error(`Unknown connector "${id}".`);
    usage();
  }

  const params = parseParams(rest);
  const corpusDir = join(CORPORA_DIR, connector.sourceId);
  mkdirSync(corpusDir, { recursive: true });

  const mailto = params.mailto ?? process.env.CONNECTOR_MAILTO;
  // Ops limits (D-024/D-027): the connector's /corpora/_ops config caps the
  // run's request budget at the fetch layer — a connector cannot opt out.
  const opsConfig = loadOpsConnectorConfigFromDisk(connector.id);
  const { fetch: politeFetch, stats: fetchStats } = createPoliteFetch({
    minIntervalMs: 1000,
    mailto,
    maxApiCalls: opsConfig?.limits.max_calls_per_run,
  });
  const ctx: RunContext = {
    corpusDir,
    fetch: politeFetch,
    writeJson: (path, data) => writeJsonPretty(join(corpusDir, path), data),
    log: (message) => console.log(`  [${connector.id}] ${message}`),
  };

  console.log(
    `Running connector "${connector.id}" v${connector.connectorVersion} → ${relative(ROOT, corpusDir)}/` +
      (opsConfig ? ` (ops limit: max_calls_per_run ${opsConfig.limits.max_calls_per_run})` : "") +
      "\n",
  );

  const startedAt = new Date();
  let result: RunResult | undefined;
  let runError: string | undefined;

  try {
    result = await connector.run(ctx, params);
  } catch (err) {
    runError = (err as Error).message;
  }

  // Guardrail: a corpus over 40 MB means "corpora arrive (thousands of
  // rows)" — the Postgres escalation trigger in docs/architecture.md.
  // We fail the run instead of silently bloating the repo.
  const corpusBytes = dirSizeBytes(corpusDir);
  if (!runError && corpusBytes > MAX_CORPUS_BYTES) {
    runError =
      `Corpus ${relative(ROOT, corpusDir)} is ${formatBytes(corpusBytes)}, over the ` +
      `${formatBytes(MAX_CORPUS_BYTES)} limit. This fires the Postgres escalation trigger ` +
      `in docs/architecture.md ("Corpora arrive (thousands of rows) → activate Postgres") — ` +
      "move this corpus to managed Postgres / object storage instead of growing the repo.";
  }

  const durationS = Math.round(((Date.now() - startedAt.getTime()) / 1000) * 100) / 100;

  // Cost accounting (D-022): api_calls counted at the polite-fetch layer
  // (includes retries), duration from the wall clock. Token fields are
  // reserved for future LLM jobs — null until an engine exists (rule 5).
  // estimated_usd is COMPUTED: the D-011 whitelist is entirely free public
  // APIs, so a pure-fetch run computes to 0. This becomes non-zero only when
  // a priced job reports token usage — it is never a hardcoded status.
  const cost: ManifestCost = {
    api_calls: fetchStats.apiCalls,
    duration_s: durationS,
    tokens_in: null,
    tokens_out: null,
    estimated_usd: 0,
  };

  const run: ManifestRun = runError
    ? {
        timestamp: startedAt.toISOString(),
        status: "failed",
        params,
        records_fetched: result?.recordsFetched ?? 0,
        files_written: result?.files.length ?? 0,
        duration_s: durationS,
        error: runError,
        ...(result?.warnings ? { warnings: result.warnings } : {}),
        cost,
      }
    : {
        timestamp: startedAt.toISOString(),
        status: result!.status,
        params,
        records_fetched: result!.recordsFetched,
        files_written: result!.files.length,
        duration_s: durationS,
        ...(result!.error ? { error: result!.error } : {}),
        ...(result!.warnings ? { warnings: result!.warnings } : {}),
        cost,
      };

  const manifest = writeManifest(connector, corpusDir, run, result?.files ?? []);

  console.log(`\n  manifest: ${relative(ROOT, join(corpusDir, "manifest.json"))}`);
  console.log(`  status: ${run.status} · records: ${run.records_fetched} · files: ${manifest.data_files.length} · api_calls: ${cost.api_calls} · ${formatBytes(corpusBytes)} · ${durationS}s`);

  if (run.status === "failed") {
    console.error(`\nFAILED — ${runError}`);
    process.exit(1);
  }
  console.log(`\nOK — connector "${connector.id}" ${run.status}.`);
}

main().catch((err) => {
  console.error(`FAILED — ${(err as Error).message}`);
  process.exit(1);
});

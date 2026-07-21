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

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONNECTORS } from "./connectors";
import type { ManifestCost, ManifestRun, RunContext, RunParams, RunResult, RunStatus } from "./connectors/types";
import { createPoliteFetch } from "./connectors/lib/http";
import { MAX_CORPUS_BYTES, dirSizeBytes, formatBytes, writeJsonPretty } from "./connectors/lib/io";
import { writeManifest } from "./connectors/lib/manifest";
import {
  computeBudgetSnapshot,
  evaluateRunAgainstOps,
  loadOpsConnectorConfigFromDisk,
  type QuoteArtifact,
} from "../lib/ops";

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

/** Path the ephemeral dry-run quote is written to (uploaded as a workflow
 *  artifact, D-025; never committed — see .gitignore). */
const QUOTE_FILE = join(ROOT, "quote.json");

/**
 * `quote` subcommand (D-025): a DETERMINISTIC, zero-network cost estimate for
 * a run, merged with the month-to-date budget snapshot and the run gate. The
 * result is written to quote.json for the workflow to upload and printed for
 * local use. This NEVER harvests.
 */
function runQuote(args: string[]): void {
  const [id, ...paramArgs] = args;
  if (!id) usage();
  const connector = CONNECTORS[id];
  if (!connector) {
    console.error(`Unknown connector "${id}".`);
    usage();
  }
  if (!connector.quote) {
    console.error(`Connector "${id}" has no quote() — cannot estimate (D-025).`);
    process.exit(1);
  }

  const params = parseParams(paramArgs);
  const raiseCap = params.raise_cap === "1" || params.raise_cap === "true";
  const quote = connector.quote(params);
  const config = loadOpsConnectorConfigFromDisk(id);
  const decision = config
    ? evaluateRunAgainstOps({ config, quote, raiseCap })
    : undefined;

  const artifact: QuoteArtifact = {
    connector: id,
    target: params.mechanism ?? null,
    params,
    quote,
    budget: decision?.budget ?? computeBudgetSnapshot(),
    over_budget: decision?.overBudget ?? false,
    allowed: decision?.allowed ?? true,
    reasons: decision?.reasons ?? [],
    raise_cap: raiseCap,
    generated_at: new Date().toISOString(),
  };

  writeFileSync(QUOTE_FILE, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify(artifact, null, 2));
}

async function main(): Promise<void> {
  const [id, ...rest] = process.argv.slice(2);
  if (!id) usage();

  // `quote` subcommand: estimate a run's cost, no network, no manifest write.
  if (id === "quote") {
    runQuote(rest);
    return;
  }

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
    apiCalls: () => fetchStats.apiCalls,
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
  const sizeExceeded = corpusBytes > MAX_CORPUS_BYTES;
  const sizeError = sizeExceeded
    ? `Corpus ${relative(ROOT, corpusDir)} is ${formatBytes(corpusBytes)}, over the ` +
      `${formatBytes(MAX_CORPUS_BYTES)} limit. This fires the Postgres escalation trigger ` +
      `in docs/architecture.md ("Corpora arrive (thousands of rows) → activate Postgres") — ` +
      "move this corpus to managed Postgres / object storage instead of growing the repo."
    : undefined;

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

  // Run budget (D-024/D-027): once the fetch layer spent max_calls_per_run it
  // throws RunBudgetExceededError. That is a GRACEFUL stop, not a failure —
  // we record status "partial" with warnings.capped = true and keep whatever
  // was written, exiting 0. The size guardrail still hard-fails.
  const maxApiCalls = opsConfig?.limits.max_calls_per_run;
  const capped = maxApiCalls !== undefined && fetchStats.apiCalls >= maxApiCalls;

  let status: RunStatus;
  let error: string | undefined;
  if (sizeError) {
    status = "failed";
    error = sizeError;
  } else if (runError) {
    if (capped) {
      status = "partial";
      error =
        `run budget reached (max_calls_per_run=${maxApiCalls}) — stopped gracefully after ` +
        `${fetchStats.apiCalls} calls; ${runError}`;
    } else {
      status = "failed";
      error = runError;
    }
  } else {
    status = result!.status;
    error = result!.error;
  }

  const warnings: Record<string, boolean> = {
    ...(result?.warnings ?? {}),
    ...(capped ? { capped: true } : {}),
  };

  const run: ManifestRun = {
    timestamp: startedAt.toISOString(),
    status,
    params,
    records_fetched: result?.recordsFetched ?? 0,
    files_written: result?.files.length ?? 0,
    duration_s: durationS,
    ...(error ? { error } : {}),
    ...(Object.keys(warnings).length > 0 ? { warnings } : {}),
    cost,
  };

  const manifest = writeManifest(
    {
      sourceId: connector.sourceId,
      sourceIds: connector.sourceIds,
      connectorVersion: connector.connectorVersion,
    },
    corpusDir,
    run,
    result?.files ?? [],
  );

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

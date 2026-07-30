import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { computeExtractionBudgetState, type BudgetSnapshot } from "./ops";
import { computeMonthlyRollup, type CorpusEntry } from "./status";
import type {
  CorpusManifest,
  CorpusManifestRun,
  ExtractionOpsConfig,
} from "./types";

const extractionConfig: ExtractionOpsConfig = {
  version: "1.0.0",
  prices_verified_on: "2026-07-23",
  tiers: {
    cheap: {
      model_id: "owner/cheap",
      response_format: "json_object",
      input_usd_per_token: 0.000001,
      output_usd_per_token: 0.000002,
      max_tokens_per_call: 24_000,
      supports: { temperature: true, structured_outputs: true },
    },
    strong: {
      model_id: "owner/strong",
      response_format: "json_schema",
      input_usd_per_token: 0.000003,
      output_usd_per_token: 0.000004,
      max_tokens_per_call: 32_000,
      supports: { temperature: false, structured_outputs: true },
    },
  },
  limits: {
    per_run_tokens: 50_000,
    monthly_tokens: 1_000_000,
    records_per_batch: 25,
    confidence_floor: 0.5,
    duplicate_similarity: 0.78,
    max_proposals_per_mechanism: 10,
  },
};

function snapshot(usd: number, tokens: number): BudgetSnapshot {
  return {
    month: "2026-07",
    caps: { usd: 100, calls: 20_000 },
    used: { usd, calls: 10, tokensIn: tokens, tokensOut: 0 },
    remaining: { usd: Math.max(0, 100 - usd), calls: 19_990 },
  };
}

test("extraction manifest cost is included in the monthly cockpit rollup", () => {
  const run: CorpusManifestRun = {
    timestamp: "2026-07-23T10:00:00.000Z",
    status: "success",
    params: { mode: "effects", mechanism: "LA-01" },
    records_fetched: 4,
    files_written: 1,
    duration_s: 12,
    cost: {
      api_calls: 2,
      duration_s: 12,
      tokens_in: 1_200,
      tokens_out: 300,
      estimated_usd: 0.42,
      models: [
        {
          tier: "cheap",
          model_id: "owner/cheap",
          api_calls: 2,
          tokens_in: 1_200,
          tokens_out: 300,
          estimated_usd: 0.42,
        },
      ],
    },
  };
  const manifest: CorpusManifest = {
    source_id: "extraction",
    source_ids: [],
    connector_version: "1.1.0",
    last_run: run,
    run_history: [run],
    data_files: [],
  };
  const entries: CorpusEntry[] = [{ dirName: "extraction", manifest }];
  const rollup = computeMonthlyRollup(entries, new Date("2026-07-23T12:00:00.000Z"));

  assert.equal(rollup.perConnector[0].label, "extraction");
  assert.equal(rollup.total.estimatedUsd, 0.42);
  assert.equal(rollup.total.tokensIn, 1_200);
  assert.equal(rollup.total.tokensOut, 300);
});

test("extraction budget warns at 80 percent and pauses at exhaustion", () => {
  const warning = computeExtractionBudgetState(snapshot(80, 100), extractionConfig);
  assert.equal(warning.level, "warning");
  assert.match(warning.message, /80%/);

  const paused = computeExtractionBudgetState(
    snapshot(100, extractionConfig.limits.monthly_tokens),
    extractionConfig,
  );
  assert.equal(paused.level, "paused");
  assert.equal(paused.label, "scheduled extraction paused");
  assert.match(paused.message, /resumes next UTC month/);
});

test("scheduled extraction estimates before running and records cap pauses", () => {
  const workflow = readFileSync(
    join(__dirname, "..", ".github", "workflows", "maturation.yml"),
    "utf8",
  );
  const quote = workflow.indexOf('npm run extract -- quote "mode=$mode"');
  const run = workflow.indexOf('npm run extract -- run "mode=$mode"');
  assert(quote >= 0);
  assert(run > quote);
  assert.match(workflow, /paused — monthly extraction cap exhausted/);
});

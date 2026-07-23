/**
 * lib/ops.ts — the operational config contract (/corpora/_ops, D-024).
 *
 * ONE module, shared by three consumers so they can never drift:
 * - CI (tools/validate.ts) validates every _ops file on disk.
 * - The write path (app/ops/actions.ts) validates a payload with the SAME
 *   validators before committing — the UI can never push a config that would
 *   redden CI.
 * - The scheduler gate (tools/ops-gate.ts) and the /ops page read the config.
 *
 * Pure logic + fs loaders only; no Next-specific imports, so tsx scripts and
 * server code both use it. lib/ never imports from tools/ (D-020), so the set
 * of known connector ids is declared here and cross-checked against the
 * connector registry in CI (tools/validate.ts) — adding a connector without
 * updating this list fails the build.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_PATHS } from "./data";
import { computeMonthlyRollup, loadCorpusManifests } from "./status";
import type {
  CorpusManifest,
  CorpusRunStatus,
  ExtractionOpsConfig,
  OpsBudget,
  OpsConnectorConfig,
  RunQuote,
} from "./types";

export type { ExtractionOpsConfig, OpsBudget, OpsConnectorConfig, RunQuote } from "./types";

/**
 * Connector ids the ops surface knows about. Declared here because lib/ never
 * imports tools/; tools/validate.ts asserts this equals the connector
 * registry keys, so it cannot silently drift.
 */
export const KNOWN_CONNECTOR_IDS = [
  "dummy",
  "evidence",
  "realization-wayback",
  "wayback",
] as const;

export type KnownConnectorId = (typeof KNOWN_CONNECTOR_IDS)[number];

export function isKnownConnectorId(id: string): id is KnownConnectorId {
  return (KNOWN_CONNECTOR_IDS as readonly string[]).includes(id);
}

// ---------- Paths ----------

/** Absolute filesystem paths (read side). */
export const OPS_PATHS = {
  dir: join(DATA_PATHS.corporaDir, "_ops"),
  budget: join(DATA_PATHS.corporaDir, "_ops", "budget.json"),
  extraction: join(DATA_PATHS.corporaDir, "_ops", "extraction.json"),
  connectorsDir: join(DATA_PATHS.corporaDir, "_ops", "connectors"),
} as const;

/** Repo-relative path the GitHub Contents API commits to. */
export const OPS_BUDGET_REPO_PATH = "corpora/_ops/budget.json";
export const OPS_EXTRACTION_REPO_PATH = "corpora/_ops/extraction.json";

/** Repo-relative path for one connector's config. */
export function opsConnectorRepoPath(id: string): string {
  return `corpora/_ops/connectors/${id}.json`;
}

/** decisions.json — the only knowledge file the write path may append to. */
export const DECISIONS_REPO_PATH = "decisions/decisions.json";

const CONNECTOR_PATH_RE = /^corpora\/_ops\/connectors\/([a-z0-9-]+)\.json$/;

/**
 * The hard allowlist for the server-action write surface (D-023). Any path
 * that is not the budget file or a registered connector's config is rejected
 * before a byte leaves the process. decisions.json is handled by a separate,
 * append-only code path (not this allowlist).
 */
export function isAllowedOpsWritePath(path: string): boolean {
  if (path === OPS_BUDGET_REPO_PATH) return true;
  const match = CONNECTOR_PATH_RE.exec(path);
  return match !== null && isKnownConnectorId(match[1]);
}

// ---------- Defaults ----------

/**
 * Default monthly caps. Every D-011 API is free, so `usd` guards only future
 * priced (LLM) jobs; `calls` is the meaningful ceiling today.
 */
export const DEFAULT_BUDGET: OpsBudget = {
  monthly_caps: { usd: 100, calls: 20000 },
};

export const DEFAULT_EVIDENCE_SATURATION = {
  window_queries: 10,
  novelty_threshold: 0.05,
  minimum_queries: 30,
  records_per_query: 25,
  retrieval_shares: { relevance: 1, recency: 1, citation: 1 },
  citation_graph: {
    backward_references: true,
    forward_citations: true,
    max_anchors: 20,
  },
  checkpoint_every_queries: 1,
  soft_time_limit_minutes: 300,
} as const;

/** A sane default config for a connector with the given harvest targets. */
export function defaultConnectorConfig(
  connectorId: string,
  targets: string[],
): OpsConnectorConfig {
  return {
    connector_id: connectorId,
    paused: false,
    paused_reason: null,
    cadence: { every_days: 7 },
    limits: { max_calls_per_run: 500, max_records_per_run: 5000 },
    ...(connectorId === "evidence"
      ? { saturation: { ...DEFAULT_EVIDENCE_SATURATION } }
      : {}),
    targets,
  };
}

// ---------- Validation (shared by CI and the write path) ----------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

/** Validate a budget payload. Returns [] when valid, else error messages. */
export function validateOpsBudget(data: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(data)) return ["budget must be a JSON object"];
  const caps = data.monthly_caps;
  if (!isPlainObject(caps)) {
    errors.push("monthly_caps must be an object");
    return errors;
  }
  if (!isNonNegativeNumber(caps.usd)) {
    errors.push("monthly_caps.usd must be a non-negative number");
  }
  if (!isNonNegativeInteger(caps.calls)) {
    errors.push("monthly_caps.calls must be a non-negative integer");
  }
  const extraTop = Object.keys(data).filter((k) => k !== "monthly_caps");
  if (extraTop.length > 0) errors.push(`unexpected field(s): ${extraTop.join(", ")}`);
  const extraCaps = Object.keys(caps).filter((k) => k !== "usd" && k !== "calls");
  if (extraCaps.length > 0) {
    errors.push(`unexpected monthly_caps field(s): ${extraCaps.join(", ")}`);
  }
  return errors;
}

export function validateExtractionOpsConfig(data: unknown): string[] {
  if (!isPlainObject(data)) return ["extraction config must be a JSON object"];
  const errors: string[] = [];
  const allowed = new Set(["version", "prices_verified_on", "tiers", "limits"]);
  const extras = Object.keys(data).filter((key) => !allowed.has(key));
  if (extras.length > 0) errors.push(`unexpected field(s): ${extras.join(", ")}`);
  if (typeof data.version !== "string" || !/^\d+\.\d+\.\d+$/.test(data.version)) {
    errors.push("version must be semver");
  }
  if (
    data.prices_verified_on !== null &&
    (typeof data.prices_verified_on !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(data.prices_verified_on))
  ) {
    errors.push("prices_verified_on must be YYYY-MM-DD or null");
  }
  if (!isPlainObject(data.tiers)) {
    errors.push("tiers must be an object");
  } else {
    for (const name of ["cheap", "strong"] as const) {
      const tier = data.tiers[name];
      if (!isPlainObject(tier)) {
        errors.push(`tiers.${name} must be an object`);
        continue;
      }
      const tierExtras = Object.keys(tier).filter(
        (key) =>
          ![
            "model_id",
            "input_usd_per_token",
            "output_usd_per_token",
            "max_tokens_per_call",
          ].includes(key),
      );
      if (tierExtras.length > 0) {
        errors.push(`unexpected tiers.${name} field(s): ${tierExtras.join(", ")}`);
      }
      if (tier.model_id !== null && (typeof tier.model_id !== "string" || !tier.model_id.trim())) {
        errors.push(`tiers.${name}.model_id must be non-empty or null`);
      }
      for (const key of ["input_usd_per_token", "output_usd_per_token"] as const) {
        if (tier[key] !== null && !isNonNegativeNumber(tier[key])) {
          errors.push(`tiers.${name}.${key} must be non-negative or null`);
        }
      }
      if (!isNonNegativeInteger(tier.max_tokens_per_call) || tier.max_tokens_per_call < 1) {
        errors.push(`tiers.${name}.max_tokens_per_call must be an integer ≥ 1`);
      }
    }
  }
  if (!isPlainObject(data.limits)) {
    errors.push("limits must be an object");
  } else {
    const limitExtras = Object.keys(data.limits).filter(
      (key) =>
        ![
          "per_run_tokens",
          "monthly_tokens",
          "records_per_batch",
          "confidence_floor",
          "duplicate_similarity",
          "max_proposals_per_mechanism",
        ].includes(key),
    );
    if (limitExtras.length > 0) {
      errors.push(`unexpected limits field(s): ${limitExtras.join(", ")}`);
    }
    for (const key of [
      "per_run_tokens",
      "monthly_tokens",
      "records_per_batch",
      "max_proposals_per_mechanism",
    ] as const) {
      if (!isNonNegativeInteger(data.limits[key]) || data.limits[key] < 1) {
        errors.push(`limits.${key} must be an integer ≥ 1`);
      }
    }
    for (const key of ["confidence_floor", "duplicate_similarity"] as const) {
      if (
        !isNonNegativeNumber(data.limits[key]) ||
        data.limits[key] <= 0 ||
        data.limits[key] > 1
      ) {
        errors.push(`limits.${key} must be a number in (0, 1]`);
      }
    }
  }
  return errors;
}

export interface ConnectorConfigCheckOptions {
  /** When provided, connector_id must be one of these. */
  knownConnectorIds?: readonly string[];
  /** When provided, connector_id (and the filename stem) must equal this. */
  expectedId?: string;
  /** When provided, every target must be a member. */
  knownMechanismIds?: readonly string[];
}

/** Validate a connector config payload. Returns [] when valid. */
export function validateOpsConnectorConfig(
  data: unknown,
  options: ConnectorConfigCheckOptions = {},
): string[] {
  const errors: string[] = [];
  if (!isPlainObject(data)) return ["connector config must be a JSON object"];

  const allowedTop = new Set([
    "connector_id",
    "paused",
    "paused_reason",
    "cadence",
    "limits",
    "saturation",
    "targets",
  ]);
  const extraTop = Object.keys(data).filter((k) => !allowedTop.has(k));
  if (extraTop.length > 0) errors.push(`unexpected field(s): ${extraTop.join(", ")}`);

  const { connector_id, paused, paused_reason, cadence, limits, saturation, targets } = data;

  if (typeof connector_id !== "string" || !/^[a-z0-9-]+$/.test(connector_id)) {
    errors.push("connector_id must be a lowercase slug string");
  } else {
    if (options.expectedId && connector_id !== options.expectedId) {
      errors.push(
        `connector_id "${connector_id}" must equal the filename stem "${options.expectedId}"`,
      );
    }
    if (
      options.knownConnectorIds &&
      !options.knownConnectorIds.includes(connector_id)
    ) {
      errors.push(`connector_id "${connector_id}" is not a registered connector`);
    }
  }

  if (typeof paused !== "boolean") errors.push("paused must be a boolean");

  if (paused_reason !== null && typeof paused_reason !== "string") {
    errors.push("paused_reason must be a string or null");
  }
  if (paused === true && (typeof paused_reason !== "string" || paused_reason.trim().length === 0)) {
    errors.push("paused_reason is required (non-empty) when paused is true");
  }

  if (!isPlainObject(cadence) || !isNonNegativeInteger(cadence.every_days) || cadence.every_days < 1) {
    errors.push("cadence.every_days must be an integer ≥ 1");
  } else {
    const extra = Object.keys(cadence).filter((k) => k !== "every_days");
    if (extra.length > 0) errors.push(`unexpected cadence field(s): ${extra.join(", ")}`);
  }

  if (!isPlainObject(limits)) {
    errors.push("limits must be an object");
  } else {
    if (!isNonNegativeInteger(limits.max_calls_per_run) || limits.max_calls_per_run < 1) {
      errors.push("limits.max_calls_per_run must be an integer ≥ 1");
    }
    if (!isNonNegativeInteger(limits.max_records_per_run) || limits.max_records_per_run < 1) {
      errors.push("limits.max_records_per_run must be an integer ≥ 1");
    }
    const extra = Object.keys(limits).filter(
      (k) => k !== "max_calls_per_run" && k !== "max_records_per_run",
    );
    if (extra.length > 0) errors.push(`unexpected limits field(s): ${extra.join(", ")}`);
  }

  if (connector_id === "evidence") {
    if (!isPlainObject(saturation)) {
      errors.push("saturation is required for the evidence connector");
    } else {
      const allowed = new Set([
        "window_queries",
        "novelty_threshold",
        "minimum_queries",
        "records_per_query",
        "retrieval_shares",
        "citation_graph",
        "checkpoint_every_queries",
        "soft_time_limit_minutes",
      ]);
      const extras = Object.keys(saturation).filter((key) => !allowed.has(key));
      if (extras.length > 0) errors.push(`unexpected saturation field(s): ${extras.join(", ")}`);
      for (const key of [
        "window_queries",
        "minimum_queries",
        "records_per_query",
        "checkpoint_every_queries",
        "soft_time_limit_minutes",
      ] as const) {
        if (!isNonNegativeInteger(saturation[key]) || saturation[key] < 1) {
          errors.push(`saturation.${key} must be an integer ≥ 1`);
        }
      }
      if (
        !isNonNegativeNumber(saturation.novelty_threshold) ||
        saturation.novelty_threshold <= 0 ||
        saturation.novelty_threshold > 1
      ) {
        errors.push("saturation.novelty_threshold must be a number in (0, 1]");
      }
      if (!isPlainObject(saturation.retrieval_shares)) {
        errors.push("saturation.retrieval_shares must be an object");
      } else {
        const shares = saturation.retrieval_shares;
        const shareKeys = ["relevance", "recency", "citation"] as const;
        const shareExtras = Object.keys(shares).filter(
          (key) => !shareKeys.includes(key as (typeof shareKeys)[number]),
        );
        if (shareExtras.length > 0) {
          errors.push(`unexpected saturation.retrieval_shares field(s): ${shareExtras.join(", ")}`);
        }
        for (const key of shareKeys) {
          if (!isNonNegativeInteger(shares[key]) || shares[key] < 1) {
            errors.push(`saturation.retrieval_shares.${key} must be an integer ≥ 1`);
          }
        }
      }
      if (!isPlainObject(saturation.citation_graph)) {
        errors.push("saturation.citation_graph must be an object");
      } else {
        const graph = saturation.citation_graph;
        const graphExtras = Object.keys(graph).filter(
          (key) => !["backward_references", "forward_citations", "max_anchors"].includes(key),
        );
        if (graphExtras.length > 0) {
          errors.push(`unexpected saturation.citation_graph field(s): ${graphExtras.join(", ")}`);
        }
        if (typeof graph.backward_references !== "boolean") {
          errors.push("saturation.citation_graph.backward_references must be a boolean");
        }
        if (typeof graph.forward_citations !== "boolean") {
          errors.push("saturation.citation_graph.forward_citations must be a boolean");
        }
        if (!isNonNegativeInteger(graph.max_anchors) || graph.max_anchors < 1) {
          errors.push("saturation.citation_graph.max_anchors must be an integer ≥ 1");
        }
      }
    }
  } else if (saturation !== undefined) {
    errors.push("saturation is only valid for the evidence connector");
  }

  if (!Array.isArray(targets) || !targets.every((t) => typeof t === "string")) {
    errors.push("targets must be an array of strings");
  } else {
    const seen = new Set<string>();
    for (const target of targets) {
      if (seen.has(target)) errors.push(`duplicate target "${target}"`);
      seen.add(target);
      if (options.knownMechanismIds && !options.knownMechanismIds.includes(target)) {
        errors.push(`target "${target}" is not a mechanism id in /registry/mechanisms`);
      }
    }
  }

  return errors;
}

// ---------- Plain-language helpers ----------

/** Cadence in words for the non-technical operator (e.g. "about once a week"). */
export function describeCadence(everyDays: number): string {
  if (everyDays <= 1) return "about once a day";
  if (everyDays === 7) return "about once a week";
  if (everyDays === 14) return "about once every two weeks";
  if (everyDays >= 28 && everyDays <= 31) return "about once a month";
  return `about once every ${everyDays} days`;
}

// ---------- Loaders (read side; server components / tsx scripts) ----------

function readJsonSafe<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/** /corpora/_ops/budget.json from disk, or undefined if absent/broken. */
export function loadOpsBudgetFromDisk(): OpsBudget | undefined {
  return readJsonSafe<OpsBudget>(OPS_PATHS.budget);
}

export function loadExtractionOpsConfigFromDisk(): ExtractionOpsConfig | undefined {
  return readJsonSafe<ExtractionOpsConfig>(OPS_PATHS.extraction);
}

export interface ExtractionRunSummary {
  timestamp: string;
  mode: string;
  scope: string;
  proposed: number;
  merged: number;
  droppedUngrounded: number;
  heldLowConfidence: number;
  droppedVolumeCap: number;
  droppedVolumeCapHighConfidence: number;
}

export function loadExtractionRunSummary(): ExtractionRunSummary | undefined {
  const manifest = readJsonSafe<CorpusManifest>(
    join(DATA_PATHS.corporaDir, "extraction", "manifest.json"),
  );
  if (!manifest) return undefined;
  const params = manifest.last_run.params;
  const number = (key: string): number => {
    const parsed = Number(params[key] ?? "0");
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  const scopeEntry = Object.entries(params).find(([key]) =>
    ["mechanism", "pack", "segment"].includes(key),
  );
  return {
    timestamp: manifest.last_run.timestamp,
    mode: params.mode ?? "unknown",
    scope: scopeEntry ? `${scopeEntry[0]} ${scopeEntry[1]}` : "unknown scope",
    proposed: number("proposed"),
    merged: number("merged"),
    droppedUngrounded: number("dropped_ungrounded"),
    heldLowConfidence: number("held_low_confidence"),
    droppedVolumeCap: number("dropped_volume_cap"),
    droppedVolumeCapHighConfidence: number("dropped_volume_cap_high_confidence"),
  };
}

export type ExtractionPriceState = "unconfigured" | "current" | "stale";

export function extractionPriceState(
  config: ExtractionOpsConfig,
  now: Date = new Date(),
): ExtractionPriceState {
  const configured = Object.values(config.tiers).every(
    (tier) =>
      tier.model_id !== null &&
      tier.input_usd_per_token !== null &&
      tier.output_usd_per_token !== null,
  );
  if (!configured || config.prices_verified_on === null) return "unconfigured";
  const verified = Date.parse(`${config.prices_verified_on}T00:00:00Z`);
  if (!Number.isFinite(verified)) return "unconfigured";
  return now.getTime() - verified > 90 * 86_400_000 ? "stale" : "current";
}

/** One connector's config from disk, or undefined if absent/broken. */
export function loadOpsConnectorConfigFromDisk(
  id: string,
): OpsConnectorConfig | undefined {
  return readJsonSafe<OpsConnectorConfig>(join(OPS_PATHS.connectorsDir, `${id}.json`));
}

/** Every connector config file present under _ops/connectors, by connector id. */
export function loadOpsConnectorConfigsFromDisk(): OpsConnectorConfig[] {
  if (!existsSync(OPS_PATHS.connectorsDir)) return [];
  return readdirSync(OPS_PATHS.connectorsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.replace(/\.json$/, ""))
    .sort()
    .flatMap((id) => {
      const config = loadOpsConnectorConfigFromDisk(id);
      return config ? [config] : [];
    });
}

/** The last run of a connector, flattened for the /ops connector card. */
export interface ConnectorLastRun {
  status: CorpusRunStatus;
  timestamp: string;
  apiCalls: number | null;
  estimatedUsd: number | null;
  /** True when the run stopped at the max_calls_per_run budget (D-027). */
  capped: boolean;
  error: string | null;
}

/**
 * The connector's most recent run, read from its corpus manifest. Tries both
 * /corpora/{id} and /corpora/_{id} (the smoke-test connectors use the "_"
 * prefix) so /ops need not import the connector registry from tools/.
 */
export function loadConnectorLastRun(id: string): ConnectorLastRun | undefined {
  for (const dir of [id, `_${id}`]) {
    const manifest = readJsonSafe<CorpusManifest>(join(DATA_PATHS.corporaDir, dir, "manifest.json"));
    const run = manifest?.last_run;
    if (run) {
      return {
        status: run.status,
        timestamp: run.timestamp,
        apiCalls: run.cost?.api_calls ?? null,
        estimatedUsd: run.cost?.estimated_usd ?? null,
        capped: Boolean(run.warnings?.capped),
        error: run.error ?? null,
      };
    }
  }
  return undefined;
}

// ---------- Budget snapshot + run gate (shared by /ops and the scheduler) ----------

/**
 * Month-to-date budget picture (D-024/D-025), COMPUTED from the manifests —
 * never asserted. `used` sums this UTC month's run costs across every corpus
 * manifest (lib/status.ts computeMonthlyRollup); `remaining` is caps − used,
 * floored at 0. The /ops progress bar and the run gate both read this.
 */
export interface BudgetSnapshot {
  /** UTC "YYYY-MM". */
  month: string;
  caps: { usd: number; calls: number };
  used: { usd: number; calls: number; tokensIn: number; tokensOut: number };
  remaining: { usd: number; calls: number };
}

export interface ExtractionBudgetState {
  level: "normal" | "warning" | "paused";
  tone: "ok" | "warn" | "err";
  label: string;
  message: string;
  usdPercent: number;
  tokenPercent: number;
  tokensUsed: number;
  tokensRemaining: number;
}

function usagePercent(used: number, cap: number): number {
  if (cap <= 0) return used > 0 ? 100 : 0;
  return (used / cap) * 100;
}

/** Computed paid-extraction state used by both the cockpit and tests (D-087). */
export function computeExtractionBudgetState(
  budget: BudgetSnapshot,
  extraction: ExtractionOpsConfig,
): ExtractionBudgetState {
  const tokensUsed = budget.used.tokensIn + budget.used.tokensOut;
  const tokenCap = extraction.limits.monthly_tokens;
  const usdPercent = usagePercent(budget.used.usd, budget.caps.usd);
  const tokenPercent = usagePercent(tokensUsed, tokenCap);
  const usdExhausted = budget.caps.usd <= 0 || budget.used.usd >= budget.caps.usd;
  const tokensExhausted = tokenCap <= 0 || tokensUsed >= tokenCap;
  const tokensRemaining = Math.max(0, tokenCap - tokensUsed);

  if (usdExhausted || tokensExhausted) {
    const exhausted = [
      ...(usdExhausted ? ["monthly USD cap"] : []),
      ...(tokensExhausted ? ["monthly token cap"] : []),
    ].join(" and ");
    return {
      level: "paused",
      tone: "err",
      label: "scheduled extraction paused",
      message: `Scheduled extraction is paused — ${exhausted} exhausted. It resumes next UTC month or after an owner-reviewed cap increase.`,
      usdPercent,
      tokenPercent,
      tokensUsed,
      tokensRemaining,
    };
  }

  if (usdPercent >= 80 || tokenPercent >= 80) {
    const nearCap = [
      ...(usdPercent >= 80 ? ["monthly USD cap"] : []),
      ...(tokenPercent >= 80 ? ["monthly token cap"] : []),
    ].join(" and ");
    return {
      level: "warning",
      tone: "warn",
      label: "budget alert",
      message: `Extraction has reached at least 80% of the ${nearCap}; scheduled runs still quote fail-closed before execution.`,
      usdPercent,
      tokenPercent,
      tokensUsed,
      tokensRemaining,
    };
  }

  return {
    level: "normal",
    tone: "ok",
    label: "within budget",
    message: "Extraction is below the 80% monthly alert threshold.",
    usdPercent,
    tokenPercent,
    tokensUsed,
    tokensRemaining,
  };
}

export function computeBudgetSnapshot(now: Date = new Date()): BudgetSnapshot {
  const caps = (loadOpsBudgetFromDisk() ?? DEFAULT_BUDGET).monthly_caps;
  const rollup = computeMonthlyRollup(loadCorpusManifests(), now);
  const used = {
    usd: rollup.total.estimatedUsd,
    calls: rollup.total.apiCalls,
    tokensIn: rollup.total.tokensIn,
    tokensOut: rollup.total.tokensOut,
  };
  return {
    month: rollup.month,
    caps,
    used,
    remaining: {
      usd: Math.max(0, caps.usd - used.usd),
      calls: Math.max(0, caps.calls - used.calls),
    },
  };
}

/**
 * The full dry-run quote artifact (D-025): the deterministic estimate merged
 * with the budget snapshot and the gate outcome. Produced by
 * tools/run-connector.ts `quote` and uploaded as the run's quote.json; the
 * /ops run flow downloads and renders it.
 */
export interface QuoteArtifact {
  connector: string;
  target: string | null;
  params: Record<string, string>;
  quote: RunQuote;
  budget: BudgetSnapshot;
  over_budget: boolean;
  allowed: boolean;
  reasons: string[];
  raise_cap: boolean;
  generated_at: string;
}

/** The outcome of gating one run against its config + the monthly budget. */
export interface OpsRunDecision {
  /** True only when no per-run limit is exceeded AND (budget ok OR raiseCap). */
  allowed: boolean;
  /** Human-readable blockers; empty when allowed. */
  reasons: string[];
  /** The estimate would push month-to-date past a cap. */
  overBudget: boolean;
  budget: BudgetSnapshot;
}

/**
 * Gate a single run (D-025). Per-run limits are HARD — raiseCap NEVER bypasses
 * them, it only overrides the monthly budget for this one run (and the caller
 * logs that override to decisions.json). Budget is evaluated against the
 * month-to-date snapshot plus this run's estimate. When a caller gates a BATCH
 * of runs before any of them executes (the maturation loop, D-052), it passes
 * the calls/usd already committed to earlier runs in the same batch as
 * pendingSpend — projected on top of month-to-date so the batch as a whole can
 * never exhaust the budget. pendingSpend only tightens the gate, never loosens
 * it.
 */
export function evaluateRunAgainstOps(args: {
  config: OpsConnectorConfig;
  quote: RunQuote;
  raiseCap?: boolean;
  now?: Date;
  pendingSpend?: { calls: number; usd: number };
}): OpsRunDecision {
  const { config, quote, raiseCap = false } = args;
  const budget = computeBudgetSnapshot(args.now);
  const pendingCalls = args.pendingSpend?.calls ?? 0;
  const pendingUsd = args.pendingSpend?.usd ?? 0;
  const reasons: string[] = [];

  if (quote.calls > config.limits.max_calls_per_run) {
    reasons.push(
      `estimated ${quote.calls} calls exceeds this connector's max_calls_per_run (${config.limits.max_calls_per_run})`,
    );
  }
  if (quote.records > config.limits.max_records_per_run) {
    reasons.push(
      `estimated ${quote.records} records exceeds this connector's max_records_per_run (${config.limits.max_records_per_run})`,
    );
  }

  const overBudget =
    budget.used.calls + pendingCalls + quote.calls > budget.caps.calls ||
    budget.used.usd + pendingUsd + quote.estimated_usd > budget.caps.usd;
  if (overBudget && !raiseCap) {
    const pendingNote = pendingCalls > 0 || pendingUsd > 0 ? `+${pendingCalls} pending` : "";
    reasons.push(
      `this run would exceed the monthly budget (calls ${budget.used.calls}${pendingNote}+${quote.calls} of ${budget.caps.calls}; ` +
        `usd ${budget.used.usd}+${pendingUsd + quote.estimated_usd} of ${budget.caps.usd}) — raise the cap for this run to proceed`,
    );
  }

  return { allowed: reasons.length === 0, reasons, overBudget, budget };
}

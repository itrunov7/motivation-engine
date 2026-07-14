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
import type { OpsBudget, OpsConnectorConfig } from "./types";

export type { OpsBudget, OpsConnectorConfig } from "./types";

/**
 * Connector ids the ops surface knows about. Declared here because lib/ never
 * imports tools/; tools/validate.ts asserts this equals the connector
 * registry keys, so it cannot silently drift.
 */
export const KNOWN_CONNECTOR_IDS = ["dummy", "evidence"] as const;

export type KnownConnectorId = (typeof KNOWN_CONNECTOR_IDS)[number];

export function isKnownConnectorId(id: string): id is KnownConnectorId {
  return (KNOWN_CONNECTOR_IDS as readonly string[]).includes(id);
}

// ---------- Paths ----------

/** Absolute filesystem paths (read side). */
export const OPS_PATHS = {
  dir: join(DATA_PATHS.corporaDir, "_ops"),
  budget: join(DATA_PATHS.corporaDir, "_ops", "budget.json"),
  connectorsDir: join(DATA_PATHS.corporaDir, "_ops", "connectors"),
} as const;

/** Repo-relative path the GitHub Contents API commits to. */
export const OPS_BUDGET_REPO_PATH = "corpora/_ops/budget.json";

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
  monthly_caps: { usd: 5, calls: 20000 },
};

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
    "targets",
  ]);
  const extraTop = Object.keys(data).filter((k) => !allowedTop.has(k));
  if (extraTop.length > 0) errors.push(`unexpected field(s): ${extraTop.join(", ")}`);

  const { connector_id, paused, paused_reason, cadence, limits, targets } = data;

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

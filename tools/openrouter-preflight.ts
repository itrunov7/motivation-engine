/**
 * tools/openrouter-preflight.ts — prove each tier routes, for ~$0.0001 (D-107).
 *
 * WHY. `provider.require_parameters: true` routes only to a provider that honours
 * every parameter in the request. Send one the model does not advertise and there
 * is no eligible provider: OpenRouter answers 404 "no endpoints found" before any
 * model is invoked. Runs 30102079781 and 30102271340 died that way, on their
 * first strong-tier call, and left nothing behind — no completion, no usage
 * block, so no cost attribution either (D-106).
 *
 * A 404 like that is not a model problem, it is a routing problem, and routing
 * can be tested for a fraction of a cent. This sends the EXACT production
 * parameter set with `max_tokens: 1` to each tier. Sharing
 * `openRouterRequestBody` with the real path is the point: a preflight that
 * approximated the parameters could pass while production 404s.
 *
 * Rule 12(a): Actions or an explicit dispatch only, never from the Next.js app.
 * Spend is real but negligible (~$0.0001 for both tiers) and is reported, not
 * silently absorbed — it is too small to move the monthly cap and is not written
 * to the ledger, since a preflight produces no proposals.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateExtractionOpsConfig } from "../lib/ops";
import type { ExtractionOpsConfig } from "../lib/types";
import { openRouterRequestBody } from "./extract";

const ROOT = join(__dirname, "..");
const CONFIG_PATH = join(ROOT, "corpora", "_ops", "extraction.json");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

interface TierVerdict {
  tier: "cheap" | "strong";
  model: string;
  routed: boolean;
  status: number;
  /** Which optional parameters the request actually carried. */
  sent: string[];
  promptTokens: number | null;
  completionTokens: number | null;
  detail: string;
}

function loadConfig(): ExtractionOpsConfig {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
  const errors = validateExtractionOpsConfig(raw);
  if (errors.length > 0) {
    throw new Error(`extraction.json is invalid:\n  ${errors.join("\n  ")}`);
  }
  return raw as ExtractionOpsConfig;
}

async function probe(
  config: ExtractionOpsConfig,
  tierName: "cheap" | "strong",
): Promise<TierVerdict> {
  const tier = config.tiers[tierName];
  if (!tier.model_id) {
    throw new Error(`tiers.${tierName}.model_id is null — nothing to preflight`);
  }
  // The production body, verbatim, differing only in max_tokens and the prompt.
  // "effects"/"synthesize" is the strictest combination: it carries the
  // refs-only provenance schema that D-104 depends on.
  const body = openRouterRequestBody({
    tier,
    mode: "effects",
    stage: "synthesize",
    prompt: 'Return {"items":[]}.',
    maxTokens: 1,
  });
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/ventora/motivation-engine",
      "X-Title": "Motivation Engine extraction preflight",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const sent = Object.keys(body).filter(
    (key) => !["model", "messages", "max_tokens"].includes(key),
  );
  if (!response.ok) {
    return {
      tier: tierName,
      model: tier.model_id,
      routed: false,
      status: response.status,
      sent,
      promptTokens: null,
      completionTokens: null,
      // The body names the offending parameter, which is the whole diagnostic.
      detail: text.slice(0, 500),
    };
  }
  const parsed = JSON.parse(text) as {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };
  return {
    tier: tierName,
    model: parsed.model ?? tier.model_id,
    routed: true,
    status: response.status,
    sent,
    promptTokens: parsed.usage?.prompt_tokens ?? null,
    completionTokens: parsed.usage?.completion_tokens ?? null,
    detail: "routed and returned a usage block",
  };
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(
      "[preflight] OPENROUTER_API_KEY is not set. This tool runs in GitHub Actions or an explicit dispatch only (rule 12a).",
    );
    process.exit(2);
  }
  const config = loadConfig();
  const verdicts: TierVerdict[] = [];
  for (const tierName of ["cheap", "strong"] as const) {
    verdicts.push(await probe(config, tierName));
  }

  console.log(`[preflight] extraction.json version ${config.version}`);
  for (const verdict of verdicts) {
    const tier = config.tiers[verdict.tier];
    console.log(
      [
        `  ${verdict.tier.padEnd(6)} ${verdict.model}`,
        `    response_format=${tier.response_format} supports.temperature=${tier.supports.temperature} supports.structured_outputs=${tier.supports.structured_outputs}`,
        `    optional params sent: ${verdict.sent.join(", ") || "none"}`,
        `    ${verdict.routed ? "ROUTED" : "REFUSED"} ${verdict.status} — ${verdict.detail}`,
        verdict.routed
          ? `    usage: prompt=${verdict.promptTokens} completion=${verdict.completionTokens}`
          : "    usage: none — no provider accepted the request, so this spend is unattributable (D-106)",
      ].join("\n"),
    );
  }

  const refused = verdicts.filter((verdict) => !verdict.routed);
  if (refused.length > 0) {
    console.error(
      `[preflight] ${refused.length} tier(s) did not route: ${refused
        .map((verdict) => `${verdict.tier}=${verdict.status}`)
        .join(" ")}. Fix the tier's supports block or response_format before dispatching a run.`,
    );
    process.exit(1);
  }
  console.log(
    "[preflight] both tiers route with the production parameter set; a run will not 404 on its first call.",
  );
}

void main().catch((error: unknown) => {
  console.error(`[preflight] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

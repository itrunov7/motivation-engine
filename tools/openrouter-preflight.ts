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
import { openRouterRequestBody, type ExtractionStage } from "./extract";

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
  /** The production stage this tier runs, and therefore the schema proven. */
  stage: ExtractionStage;
  /**
   * Whether the request carried a json_schema response format at all, and
   * whether the provider honoured it. Honoured is EVIDENCE, not assertion:
   * response_format json_schema sent together with provider.require_parameters
   * true means OpenRouter routes only to a provider that accepts every
   * parameter, so a 2xx is that provider having accepted the schema.
   */
  jsonSchemaSent: boolean;
  jsonSchemaAccepted: boolean | null;
  /** Provider OpenRouter resolved to, or null when the response omitted it. */
  provider: string | null;
  /** The exact body sent, kept for the non-2xx dump. */
  requestBody: Record<string, unknown>;
  /** Optional parameters the error text actually names, when it names any. */
  rejectedParameters: string[];
}

/**
 * The stage each tier runs in production (D-107).
 *
 * The cheap tier extracts and the strong tier synthesizes, and the two stages
 * carry DIFFERENT response schemas — synthesize uses the refs-only provenance
 * schema D-104 depends on. Probing both tiers with "synthesize", as this tool
 * previously did, therefore proved the cheap tier could route a schema it never
 * sends and left its real one untested.
 */
export function productionStage(tier: "cheap" | "strong"): ExtractionStage {
  return tier === "cheap" ? "extract" : "synthesize";
}

/**
 * Name the optional parameters an error body actually blames.
 *
 * Only the keys the request really carried are considered, so the report cannot
 * accuse the request of something it never sent. When the body names none, the
 * caller reports the whole sent set as the suspect set — guessing one parameter
 * out of several would be an invented finding.
 */
export function rejectedParameters(errorText: string, sent: string[]): string[] {
  const haystack = errorText.toLowerCase();
  const candidates = new Map<string, string[]>([
    ["response_format", ["response_format", "json_schema", "structured output"]],
    ["provider", ["require_parameters", "no endpoints found", "no allowed provider"]],
    ["temperature", ["temperature"]],
  ]);
  return sent.filter((key) =>
    (candidates.get(key) ?? [key]).some((needle) => haystack.includes(needle)),
  );
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
  // The production body, verbatim, differing only in max_tokens and the prompt —
  // including the stage THIS tier actually runs, so the schema being proven is
  // the schema the tier will send.
  const stage = productionStage(tierName);
  const body = openRouterRequestBody({
    tier,
    mode: "effects",
    stage,
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
  const responseFormat = body.response_format as { type?: string } | undefined;
  const jsonSchemaSent = responseFormat?.type === "json_schema";
  const shared = {
    tier: tierName,
    model: tier.model_id,
    sent,
    stage,
    jsonSchemaSent,
    requestBody: body,
  };
  if (!response.ok) {
    return {
      ...shared,
      routed: false,
      status: response.status,
      promptTokens: null,
      completionTokens: null,
      // Untruncated: a 404 body is the whole diagnostic, and the previous
      // 500-character clip is how the rejected parameter went unnamed.
      detail: text,
      jsonSchemaAccepted: jsonSchemaSent ? false : null,
      provider: null,
      rejectedParameters: rejectedParameters(text, sent),
    };
  }
  const parsed = JSON.parse(text) as {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
    provider?: string;
  };
  return {
    ...shared,
    model: parsed.model ?? tier.model_id,
    routed: true,
    status: response.status,
    promptTokens: parsed.usage?.prompt_tokens ?? null,
    completionTokens: parsed.usage?.completion_tokens ?? null,
    detail: "routed and returned a usage block",
    // A 2xx under require_parameters is the provider having honoured every
    // parameter, json_schema included. Null when no schema was sent, so
    // "not applicable" never reads as "accepted".
    jsonSchemaAccepted: jsonSchemaSent ? true : null,
    // Reported as absent rather than inferred from the model id.
    provider: typeof parsed.provider === "string" ? parsed.provider : null,
    rejectedParameters: [],
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
  // Two independent checks, reported independently: a partial pass is a fail,
  // and the tier that routed must not read as evidence about the tier that did not.
  for (const verdict of verdicts) {
    const tier = config.tiers[verdict.tier];
    console.log(
      [
        "",
        `  ── ${verdict.tier} tier — ${verdict.model} (production stage: ${verdict.stage})`,
        `     declared: response_format=${tier.response_format} supports.temperature=${tier.supports.temperature} supports.structured_outputs=${tier.supports.structured_outputs}`,
        `     optional params sent: ${verdict.sent.join(", ") || "none"}`,
        `     HTTP status: ${verdict.status} — ${verdict.routed ? "ROUTED" : "REFUSED"}`,
        `     json_schema: ${jsonSchemaLine(verdict)}`,
        `     resolved provider: ${verdict.provider ?? "not returned by the response — reported absent rather than inferred"}`,
        verdict.routed
          ? `     usage: prompt=${verdict.promptTokens} completion=${verdict.completionTokens}`
          : "     usage: none — no provider accepted the request, so this spend is unattributable (D-106)",
      ].join("\n"),
    );
    if (!verdict.routed) {
      console.log(`     error body (untruncated):\n${indent(verdict.detail, 7)}`);
      console.log(
        `     rejected parameter: ${
          verdict.rejectedParameters.length > 0
            ? verdict.rejectedParameters.join(", ")
            : `not named by the response — the suspect set is everything sent: ${verdict.sent.join(", ") || "none"}`
        }`,
      );
      // The body carries no secret: the key travels in the Authorization header.
      console.log(
        `     full request body as sent:\n${indent(JSON.stringify(verdict.requestBody, null, 2), 7)}`,
      );
    }
  }

  const refused = verdicts.filter((verdict) => !verdict.routed);
  if (refused.length > 0) {
    console.error(
      `\n[preflight] ${refused.length} of ${verdicts.length} tier(s) did not route: ${refused
        .map((verdict) => `${verdict.tier}=${verdict.status}`)
        .join(" ")}. A partial pass is a fail — the untested tier will 404 mid-run and leave no usage block to attribute (D-106). Fix the tier's supports block or response_format before dispatching a run.`,
    );
    process.exit(1);
  }
  console.log(
    "\n[preflight] both tiers routed with their own production parameter set and stage; a run will not 404 on its first call.",
  );
}

function jsonSchemaLine(verdict: TierVerdict): string {
  if (!verdict.jsonSchemaSent) {
    return `not sent — this tier's response_format is ${
      (verdict.requestBody.response_format as { type?: string } | undefined)?.type ??
      "unset"
    }, so nothing about json_schema support is proven here`;
  }
  return verdict.jsonSchemaAccepted
    ? "sent and ACCEPTED — response_format=json_schema went out alongside provider.require_parameters=true, which routes only to a provider honouring every parameter, so this 2xx is that provider having accepted the schema"
    : "sent and REJECTED — no provider honoured it at these parameters";
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

// Guarded so the pure helpers above can be imported by the test suite without
// firing a live probe as a side effect of the import.
if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(`[preflight] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}

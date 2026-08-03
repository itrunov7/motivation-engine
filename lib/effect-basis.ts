/**
 * Resolving the effect an inferred realization was transferred from (D-112).
 *
 * The basis can be in one of two places, and the difference matters: an
 * approved record under /effects is authoritative knowledge, while a pending
 * proposal is a candidate the owner has not accepted. Both are legitimate
 * inputs to a realization PROPOSAL — a proposal building on a proposal changes
 * no authoritative artifact — but only the first is a legitimate input to an
 * approval, and lib/proposals enforces that by requiring the record itself.
 * This module reports which one it found instead of flattening them.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeReaddirSync } from "./fs-safe";
import type { Effect, Proposal } from "./types";

export type EffectBasisOrigin = "artifact" | "proposal";

export interface ResolvedEffectBasis {
  effect: Effect;
  origin: EffectBasisOrigin;
  /** Repo-relative path, so a report can name where the basis came from. */
  path: string;
}

const EFFECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Proposal statuses whose payload may still become knowledge. */
const LIVE_STATUSES = new Set(["pending", "edited", "held_low_confidence"]);

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function jsonFilesIn(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return safeReaddirSync(directory)
    .filter(
      (name) =>
        name.endsWith(".json") &&
        name !== "effect.schema.json" &&
        name !== "proposal.schema.json",
    )
    .sort()
    .map((name) => join(directory, name));
}

/**
 * Every effect a realizations run could be anchored on, approved records first.
 * Used by the /ops scope picker so an effect id is chosen from what exists
 * rather than typed from memory.
 */
export function listEffectBases(
  root: string = process.cwd(),
): { id: string; mechanismId: string; origin: EffectBasisOrigin }[] {
  const found = new Map<string, { id: string; mechanismId: string; origin: EffectBasisOrigin }>();
  const effectsRoot = join(root, "effects");
  if (existsSync(effectsRoot)) {
    for (const entry of safeReaddirSync(effectsRoot).sort()) {
      const directory = join(effectsRoot, entry);
      if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
      for (const path of jsonFilesIn(directory)) {
        const effect = readJson<Effect>(path);
        if (!effect?.id) continue;
        found.set(effect.id, {
          id: effect.id,
          mechanismId: effect.mechanism_id,
          origin: "artifact",
        });
      }
    }
  }
  for (const path of jsonFilesIn(join(root, "proposals", "effect"))) {
    const proposal = readJson<Proposal>(path);
    if (
      proposal?.type !== "effect" ||
      !LIVE_STATUSES.has(proposal.status) ||
      found.has(proposal.payload.id)
    ) {
      continue;
    }
    found.set(proposal.payload.id, {
      id: proposal.payload.id,
      mechanismId: proposal.payload.mechanism_id,
      origin: "proposal",
    });
  }
  return Array.from(found.values()).sort(
    (left, right) =>
      left.origin.localeCompare(right.origin) || left.id.localeCompare(right.id),
  );
}

export function resolveEffectBasis(
  effectId: string,
  root: string = process.cwd(),
): ResolvedEffectBasis | null {
  if (!EFFECT_ID.test(effectId)) return null;
  const effectsRoot = join(root, "effects");
  if (existsSync(effectsRoot)) {
    for (const entry of safeReaddirSync(effectsRoot).sort()) {
      const path = join(effectsRoot, entry, `${effectId}.json`);
      if (!existsSync(path)) continue;
      const effect = readJson<Effect>(path);
      if (effect?.id === effectId) {
        return { effect, origin: "artifact", path: `effects/${entry}/${effectId}.json` };
      }
    }
  }
  for (const path of jsonFilesIn(join(root, "proposals", "effect"))) {
    const proposal = readJson<Proposal>(path);
    if (
      proposal?.type !== "effect" ||
      !LIVE_STATUSES.has(proposal.status) ||
      proposal.payload.id !== effectId
    ) {
      continue;
    }
    return {
      effect: proposal.payload,
      origin: "proposal",
      path: `proposals/effect/${path.split("/").pop()}`,
    };
  }
  return null;
}

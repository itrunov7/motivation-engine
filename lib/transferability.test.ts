/**
 * Hard-rule collision (D-357/D-362), tested against the six known collisions
 * that motivated it: D-344's four (view-count-triggered-text-suppression,
 * narration-text-redundancy-toggle, low-stock-indicator-badge,
 * repeated-view-scarcity-nudge — original, pre-narrow pattern text, pulled from
 * git history at the extraction commit before the owner's edit-approve) and
 * D-357's two (loss-first-framing, high-involvement-loss-emphasis).
 *
 * This file does NOT assert that all six fire. Measured before being wired in:
 * plain token containment between a pattern and a mechanism's own hard-rule
 * prose catches the collision only when the two happen to share vocabulary
 * (repeated-view-scarcity-nudge does; loss-first-framing and
 * high-involvement-loss-emphasis score zero on their true rule and never
 * surface panic_cap at all). A test that forced every case to pass would mean
 * hand-tuning the lexicon from the answer key — the owner's own instruction was
 * not to. What IS asserted: which of the six catch and which miss, so a future
 * change to the check shows up here as a change to a known, honest baseline —
 * and the structural properties (warning-only, deterministic, pack-scoped)
 * that make it trustworthy regardless of recall.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  HARD_RULE_COLLISION_PATTERN_RARITY_THRESHOLD,
  HARD_RULE_COLLISION_RULE_RARITY_THRESHOLD,
  HARD_RULE_COLLISION_TOKEN_THRESHOLD,
  judgeHardRuleCollisions,
  peerMechanismIds,
} from "./transferability";

const ROOT = join(__dirname, "..");

function flagsFor(mechanismId: string, pattern: string) {
  return judgeHardRuleCollisions(
    { mechanism_id: mechanismId, pattern, derivation: "inferred" },
    ROOT,
  );
}

function ruleIds(flags: ReturnType<typeof flagsFor>): string[] {
  return flags.map((f) => `${f.mechanism_id}/${f.rule_id}`);
}

// --- structural properties --------------------------------------------------

test("every flag is severity carried straight from the registry, never invented", () => {
  const flags = flagsFor(
    "SC-06",
    "Inject a scarcity-based notification when the user has viewed a specific item {view_count} times, showing a limited-availability message where none was previously visible.",
  );
  assert.ok(flags.length > 0);
  for (const flag of flags) assert.ok(flag.severity === "block" || flag.severity === "warn");
});

test("a reported realization is out of scope — there is no pattern to check", () => {
  assert.deepEqual(
    judgeHardRuleCollisions({ mechanism_id: "SC-06", derivation: "reported" }, ROOT),
    [],
  );
});

test("a pattern with no cross-threshold overlap returns no flags, not a guess", () => {
  const flags = flagsFor(
    "LA-01",
    "Reduce how often performance updates are surfaced to the user, showing them no more often than every {update_interval}.",
  );
  assert.deepEqual(flags, []);
});

test("a parameter identifier is not mined for rule vocabulary", () => {
  // {panic_cap_days} names a tunable; it must not itself be read as the text
  // "panic cap days" and matched against LA-01/panic_cap's own rule prose.
  const flags = flagsFor(
    "LA-01",
    "Show a summary digest every {panic_cap_days} instead of individual updates.",
  );
  assert.deepEqual(flags, []);
});

test("peer set is cross_cutting-aware: SC-17 (cross_cutting) is in scope for an LA-01 pattern", () => {
  const peers = peerMechanismIds("LA-01", ROOT);
  assert.ok(peers.includes("SC-17"), `expected SC-17 among LA-01's peers: ${peers.join(", ")}`);
  assert.ok(peers.includes("LA-01"));
});

test("peer set for a cross_cutting mechanism includes every pack-mapped mechanism", () => {
  const peers = peerMechanismIds("MM-15", ROOT);
  assert.ok(peers.includes("LA-01"));
  assert.ok(peers.includes("SC-06"));
  assert.ok(peers.includes("SC-17"));
});

test("HARD_RULE_COLLISION_TOKEN_THRESHOLD is the documented value", () => {
  assert.equal(HARD_RULE_COLLISION_TOKEN_THRESHOLD, 0.1);
});

// --- the six known collisions: catches ------------------------------------

test("catches repeated-view-scarcity-nudge on both of its true SC-06 rules", () => {
  const ids = ruleIds(
    flagsFor(
      "SC-06",
      "Inject a scarcity-based notification into the browsing flow when the user has viewed a specific item {view_count} times without completing a purchase, showing a limited-availability message where none was previously visible.",
    ),
  );
  assert.ok(ids.includes("SC-06/genuine_scarcity_only"), ids.join(", "));
  assert.ok(ids.includes("SC-06/no_manufactured_limits"), ids.join(", "));
});

test("low-stock-indicator-badge: the true rule is present, not top-ranked (a partial catch)", () => {
  const flags = flagsFor(
    "SC-06",
    "Display a remaining-stock counter or badge on the product card or page when inventory falls below {stock_threshold} units to trigger competitive anxiety and increase perceived value.",
  );
  const ids = ruleIds(flags);
  assert.ok(ids.includes("SC-06/no_fake_timers"), ids.join(", "));
  assert.notEqual(ids[0], "SC-06/no_fake_timers", "expected it NOT to be top-ranked — that is the partial-catch finding");
});

// --- the six known collisions: honest misses --------------------------------
//
// These assert the MISS, not the catch — pinning the honest baseline so a
// future change to the lexicon or the threshold shows up here as a measured
// change in recall, not a silent one.

test("misses view-count-triggered-text-suppression's true rule (accessibility_preserved)", () => {
  const ids = ruleIds(
    flagsFor(
      "MM-15",
      "Offer a toggle that hides redundant text captions once the user has viewed the associated image {view_threshold} times, while keeping a manual re-enable option visible at all times.",
    ),
  );
  assert.ok(!ids.includes("MM-15/accessibility_preserved"), ids.join(", "));
});

test("misses narration-text-redundancy-toggle's true rule (accessibility_preserved)", () => {
  const ids = ruleIds(
    flagsFor(
      "MM-15",
      "Provide a user-controlled toggle that hides on-screen text whenever audio narration is playing, defaulting to {default_hidden_state}, and automatically re-enable the text after {audio_pause_duration} seconds of narration inactivity so users are never locked into a single modality.",
    ),
  );
  assert.ok(!ids.includes("MM-15/accessibility_preserved"), ids.join(", "));
});

test("misses loss-first-framing's true rule (panic_cap) entirely", () => {
  const ids = ruleIds(
    flagsFor(
      "LA-01",
      "When a user is about to commit to a choice, present the negative consequence of that choice above or before the positive consequence, and scale the visual weight of the negative consequence to be {loss_magnitude} times more prominent than the positive consequence, triggering this treatment once the user has interacted with the choice {loss_focus_threshold} time(s).",
    ),
  );
  assert.ok(!ids.includes("LA-01/panic_cap"), ids.join(", "));
});

test("misses high-involvement-loss-emphasis's true rule (panic_cap) entirely", () => {
  const ids = ruleIds(
    flagsFor(
      "LA-01",
      "Increase the visual prominence of potential negative outcomes shown to a user once they have engaged with the interface for {involvement_threshold} interactions or more, reflecting that users with greater personal stake react more strongly to potential losses.",
    ),
  );
  assert.ok(!ids.includes("LA-01/panic_cap"), ids.join(", "));
});

// --- the distinctiveness gate (D-365) ---------------------------------------
//
// D-364 reported 41 flags across the 28-proposal corpus, 26 of them noise —
// every noise flag driven by a single shared word ordinary enough to appear
// in both texts by chance ("users", "never", "high", "displayed", "data",
// "must", "product", "full", "visible", "options", "forced", "reflect"). The
// gate below requires a single-token match to be rare in both the full
// hard-rule corpus and the full pattern corpus before it may fire alone.

test("HARD_RULE_COLLISION_RULE_RARITY_THRESHOLD and _PATTERN_RARITY_THRESHOLD are the documented values", () => {
  assert.equal(HARD_RULE_COLLISION_RULE_RARITY_THRESHOLD, 0.06);
  assert.equal(HARD_RULE_COLLISION_PATTERN_RARITY_THRESHOLD, 0.5);
});

test("a single-token match on \"users\" no longer fires alone (4 of 58 rules use it)", () => {
  const ids = ruleIds(
    flagsFor(
      "VR-02",
      "Show a confirmation banner to users once a task completes, with no repeated prompts.",
    ),
  );
  assert.ok(!ids.includes("VR-02/vulnerable_users"), ids.join(", "));
});

test("a single-token match on \"never\" no longer fires alone (8 of 58 rules use it)", () => {
  const ids = ruleIds(
    flagsFor(
      "LA-01",
      "Keep the summary panel expanded so the total is never hidden from view.",
    ),
  );
  assert.ok(!ids.includes("LA-01/no_data_hostage"), ids.join(", "));
});

test("a single-token match on \"scarcity\" still fires alone (1 of 58 rules use it — the reliable case)", () => {
  const ids = ruleIds(
    flagsFor(
      "SC-06",
      "Send a push notification when a limited-quantity deal is expiring soon to leverage scarcity messaging.",
    ),
  );
  assert.ok(ids.includes("SC-06/genuine_scarcity_only"), ids.join(", "));
});

test("a single-token match on \"anxiety\" still fires alone (1 of 58 rules use it)", () => {
  const ids = ruleIds(
    flagsFor(
      "SC-06",
      "Display a remaining-stock counter to trigger anxiety and increase perceived value.",
    ),
  );
  assert.ok(ids.includes("LA-01/panic_cap"), ids.join(", "));
});

test("a multi-token match still fires regardless of any single token's commonness", () => {
  const ids = ruleIds(
    flagsFor(
      "SC-06",
      "Disable high-arousal scarcity indicators such as countdown timers or stock counters after repeated exposure within a session.",
    ),
  );
  assert.ok(ids.includes("SC-06/no_fake_timers"), ids.join(", "));
});

// --- acceptance criterion, pinned against the real corpus -------------------
//
// The owner's condition for the gate: genuine_scarcity_only must keep firing
// 5 times and panic_cap 3 times across the 28-proposal corpus that D-364
// measured. If a future change to either rarity threshold regresses either
// count, this is the test that catches it — "if either drops, the threshold
// is too tight" is not a one-time check, it is a standing invariant.
test("genuine_scarcity_only fires 5/5 and panic_cap fires 3/3 across the real 28-proposal corpus", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (entry.endsWith(".json")) out.push(full);
    }
    return out;
  }
  let genuineScarcityOnly = 0;
  let panicCap = 0;
  for (const path of walk(join(ROOT, "proposals/realization"))) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw.payload?.derivation !== "inferred" || !raw.payload?.pattern) continue;
    for (const flag of judgeHardRuleCollisions(raw.payload, ROOT)) {
      if (flag.mechanism_id === "SC-06" && flag.rule_id === "genuine_scarcity_only") {
        genuineScarcityOnly += 1;
      }
      if (flag.mechanism_id === "LA-01" && flag.rule_id === "panic_cap") panicCap += 1;
    }
  }
  assert.equal(genuineScarcityOnly, 5, "genuine_scarcity_only occurrence count");
  assert.equal(panicCap, 3, "panic_cap occurrence count");
});

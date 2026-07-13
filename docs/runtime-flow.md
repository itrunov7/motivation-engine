# Motivation Engine · Runtime: how the registry works at generation time

End-to-end example: Ventora generates a **paywall** for a user's product (AI Headshots, trial, the user has created 12 photos). This document is the integration spec for the August phase; nothing here runs at Baseline.

---

## Step 1. Generation context (assembled automatically by the platform)

```json
{
  "artifact_type": "paywall",
  "funnel_stage": "conversion",
  "product": {
    "category": "ai_image_tool",
    "has_trial": true,
    "has_subscription": false,
    "user_creates_artifacts": true,
    "has_points_or_credits": false
  },
  "user_state": { "accumulated_value_score": 12, "artifacts_created": 12, "trial_days_left": 3 },
  "locale": "en-US"
}
```

## Step 2. Mechanism selection (deterministic registry filter, ~ms)

```
SELECT mechanisms WHERE
  artifact_type IN applicability.artifact_types
  AND funnel_stage NOT IN excluded_stages
  AND ALL(preconditions) = true
ORDER BY prior_weight * niche_effect_weight DESC
LIMIT 3
```

Result: `LA-01 (loss_aversion)` — precondition passes (value_score=12>0); `EN-03 (endowment)`; `SC-06 (scarcity)` is dropped — the product has no real limit (hard rule: real_loss_only).

## Step 3. Payload into the generation prompt (compact directives, not full records)

```
<motivation_mechanisms>
1. [LA-01/trial-ownership] A loss weighs ~2x a gain. The paywall shows what the
   user has CREATED (12 photos, previews) and frames payment as keeping access
   to what is theirs: "Your 12 portraits will be deleted in 3 days."
   Not "buy" — "keep".
2. [EN-03/preview-ownership] Reinforce ownership: previews inside the user's
   own space, caption "Your gallery".
FORBIDDEN: fake timers, confirm-shaming, deletion pressure without a real
deadline and export. Loss frame ≤ 1 per screen.
Tag every element with a data-me attribute carrying the mechanism tag.
</motivation_mechanisms>
```

## Step 4. Tagged generation output

```html
<section class="paywall">
  <div class="gallery-preview" data-me="me:EN-03:preview-ownership">
    <!-- 12 previews of the user's portraits -->
    <h3>Your gallery · 12 portraits</h3>
  </div>
  <h2 data-me="me:LA-01:trial-ownership">
    Your 12 portraits will be deleted in 3 days
  </h2>
  <button data-me="me:LA-01:trial-ownership">Keep my portraits — $9</button>
</section>
```

## Step 5. Telemetry (Amplitude)

```json
{
  "event": "paywall_converted",
  "properties": {
    "mechanism_tags": ["me:LA-01:trial-ownership", "me:EN-03:preview-ownership"],
    "variant": "B", "product_category": "ai_image_tool"
  }
}
```

## Step 6. The loop: outcome → registry weights

A nightly job aggregates events by tag and writes back into the JSON record:

```json
"observed_effects": [
  {
    "implementation_id": "LA-01-trial-ownership",
    "niche": "ai_image_tool",
    "metric": "trial_to_paid_cvr",
    "baseline": 0.041, "treatment": 0.058,
    "n": 1240, "updated": "2026-08-30"
  }
]
```

→ `niche_effect_weight` for LA-01 in the ai_image_tool niche rises → in Step 2 of subsequent generations this mechanism ranks higher. The loop is closed.

---

## v1 stack (July–August): deliberately boring

- Registry: JSON files in git (12 mechanisms, ~50–100 implementations — fits entirely)
- Selection: a pure filter function inside the generation pipeline (no ML, no search)
- Human cards: generated from JSON by a script (one command)
- Loop: Amplitude export → nightly job → observed_effects written into JSON

## When we escalate (v2, September+): by triggers, not by appetite

- Corpora (millions of creatives/reviews) → embeddings for evidence-example search. Vectors sit over the examples; the core remains a registry.
- >500 implementations or conflicting selection rules → registry moves out of git into a DB.
- Enough observed_effects → learned ranking replaces manual weights.

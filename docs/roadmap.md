# Motivation Engine · Roadmap M1–M6

Six milestones. Each has a result, steps, and a "done" criterion. Critical path: M1 → M2 → M4. M3 and M5 strengthen but do not block. If July gets squeezed by the fundraise — M3 shrinks to a single variant without a full A/B, but M2 is untouchable: without the ontology there is nothing to hand off.

---

## M1. System foundation *(Igor · July, weeks 1–2)*
**Result:** a knowledge core you can work with — now realized as the Baseline build (repo + shelves + showcase; see the development playbook).
Steps: workspace and constitution (.cursorrules, SPEC) → record format fixed (mechanism → evidence → implementations → metric → guardrail) → exemplar record LA-01 as the template for the rest.
**Done:** looking at LA-01 makes it obvious what the other eleven look like; the showcase renders the true state of every shelf.

## M2. Ontology v1 *(Igor · July, weeks 2–4)*
**Result:** the full core — 10–12 grade A/B mechanisms.
Steps: records for all mechanisms (sources — meta-analyses, not single papers) → 3+ reference examples from live products per mechanism → comprehension test: one team member applies the ontology to a task without explanations.
**Done:** 12 records + examples + test passed.

## M3. First proof *(Igor · July, weeks 3–4, parallel to M2)*
**Result:** a live number: "mechanism → screen → effect."
Steps: pick one element of a current test product (Headshots paywall or landing) → rebuild it by hand through the ontology → A/B against the current version.
**Done:** a run result exists — for the team and for a deck slide.

## M4. Handoff and integration *(team · August)*
**Result:** the engine runs in Ventora production.
Steps: handoff package (ontology + M3 result + integration spec) → half-day session: walkthrough, owner assignment → hook into the generation pipeline on **one** artifact type → telemetry standard in all new products (conversion, D7, organic returns, tag → outcome).
**Done:** first products ship with tagged mechanisms and telemetry on; Igor is no longer the bottleneck.

## M5. Data and the loop *(team · August–September)*
**Result:** the machine starts learning on its own.
Steps: science/interface connectors (OpenAlex, Wayback CDX, EDGAR) + reviews→labels pipeline → corpora tagged with ontology mechanisms → return pipeline: real outcomes → registry weights → weekly "mechanism × niche → effect" table in the check-in rhythm.
**Done:** the effects table updates itself and is reviewed weekly.

## M6. Scaling *(September+)*
**Result:** the engine is the standard layer of all generation.
Steps: expand from one artifact type to the rest (onboarding, ads, email) → the cheap selection funnel (synthetic panels → pre-tests → micro-CTR) → cultural profiles as surface parameters (geo expansion) → investor-deck slide with numbers from M3–M5.
**Done:** every product on the platform passes through the engine by default; the deck carries live numbers.

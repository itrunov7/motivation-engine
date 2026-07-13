# Motivation Engine — the new product we are building

**What it is:** we are building a new engine inside Ventora. Working name — Motivation Engine. It is an AI machine that knows which buttons in the human mind successful products press — and builds those buttons into every product our platform generates. This is not a feature and not a prompt. It is a separate layer of Ventora's architecture and possibly the most important thing we will do this year.

## The story that makes it all clear

Why do millions of people open Duolingo every day? Not because it's pretty. They are afraid of losing a 40-day streak. That is an ancient brain mechanism: losing hurts us roughly twice as much as gaining feels good. Duolingo simply pressed that button.

There are about a dozen such buttons. Fear of loss. An unfinished task that itches (the "profile 80% complete" progress bar). Unpredictable reward (why you pull the feed to refresh one more time — like a slot machine lever). The feeling of "this is already mine" (why free trials work: taking away hurts more than not giving). Status. Habit: cue → action → reward.

Every successful product stands on these buttons. Science has known them for decades; the best product people feel them intuitively. **The AI that generates products today does not know them at all.** It writes "the way things are usually written" — and produces software that works but doesn't grip. Open, shrug, close.

## What this gives our users

Maria is a pastry chef who built an order-taking site through Ventora. An ordinary generator gives her a correct business card site. Ventora with the engine works differently: her customer sees "2 weekend slots left" (scarcity moves decisions); after ordering — "your cake made this week's top 5" (people need confirmation of their choice); a regular customer accumulates status and a growing discount that is painful to abandon (what retains is not the newsletter — it's the fear of losing what's accumulated). Maria doesn't know the words "loss aversion." The machine built it in for her — the thing only a $200K/year product manager used to be able to do.

## How it works — the machine's design

Three layers:

**1. Core: the mechanism ontology.** A structured base of 10–12 fundamental motivation mechanisms. Each mechanism is a record: description, scientific evidence grade (only what replicates in research enters the core), a library of implementations in interface/copy/flow, a proxy metric (how we measure that it worked), applicability conditions (niche, funnel stage, culture), and a guardrail against overreach. Technically — a knowledge base fed to the generating models as context and as scoring rules.

**2. Generation with tagging.** When Ventora generates a landing page, onboarding, paywall, or ad creative, the engine does two things. Before generation — it injects the relevant mechanisms for the task into the context ("this is a subscription paywall → endowment effect + progress loss"). After generation — every element is tagged: this block activates this mechanism. No magic: it's an LLM pipeline on top of our current models (the same three-tier Haiku/Sonnet/Opus routing), plus variant scoring before anything is shown to the user.

**3. The learning loop.** Every product on the platform sends standard telemetry (we already run Amplitude): conversion, D7, organic returns, rage clicks. Because elements are tagged with mechanisms, we can — for the first time — connect "button X in niche Y → this measured effect." Those outcomes flow back into the base and shift the weights. The hundredth product on the platform is born smarter than the first.

## Where the data comes from at the start (the cold-start problem — solved)

We don't need to burn budget for the machine to learn. The starting fuel is free:

- **Surviving ads:** under EU transparency rules, ad libraries expose reach data for all ads; a creative running 6+ months is profitable. Millions of examples, labeled with other people's money.
- **Reviews as emotional labels:** millions of app-store reviews ("love it because…", "deleted because…") → NLP mapping of emotion to a concrete product element and version.
- **Flow libraries:** thousands of screen-by-screen onboardings of top apps and their version evolution — what survived, worked.
- **Codified research:** databases of documented A/B tests and usability studies.

Then a cheap selection funnel replaces expensive testing: thousands of variants → scoring by synthetic panels (LLM agents calibrated on real data — used for ranking only, never absolute numbers) → predictive attention pre-tests → micro-CTR tests at $10–15 per variant → a real test for 2–3 finalists. 99% of the culling happens nearly free.

## Who does this and how we launch it

**July — I (Igor) build the first version.** Three results by end of month: the ontology of 10–12 mechanisms with reference examples from live products; the record format and core rules; the first live run — an element of one of our test products rebuilt through the ontology, with an A/B number against the current version. The team works on its own OKRs in July — nothing is required from you yet. Everything happens in the open: records, working documents, and the decision log live in a shared space from day one. Everyone is welcome to read, comment, and propose — voluntarily and not at the expense of your goals.

**August — handoff to the team and integration into the product.** Early August: a half-day session — system walkthrough, owner assignments, integration start. By end of August the engine runs in production on **one** artifact type (landing page or paywall — decided at the session), and the first products ship with tagged mechanisms and telemetry on.

**What the team integrates and maintains:**
- **Generation hook-in** — the engine plugs into Ventora's pipeline: injects mechanisms into context before generation, tags elements after.
- **Telemetry standard** — in every new product on the platform: conversion, D7, organic returns, the "mechanism tag → outcome" link.
- **Starting corpora** — the interface/science connectors and the reviews→labels pipeline: August's first engineering task. Not a blocker for launch — the engine starts on the ontology; data tunes the weights afterward.
- **The loop** — the pipeline returning real numbers into the mechanism base; a weekly look at the "mechanism × niche → effect" table.
- **Maintenance and growth** — expanding the implementation library, corpora upkeep, proposing new mechanisms for the core.

After the handoff I remain the owner of the ontology: I admit new mechanisms into the core and watch evidence grades and guardrails. Everything else is yours.

## Why this cannot be copied

A feature gets copied in a week. Here the value is in accumulated data on "what actually worked" — and that only appears for whoever owns the whole chain: built → launched ads → saw money → measured returns. Code generators see only code. We see the whole path.

## How we measure success

Three numbers for Ventora products versus a "plainly generated" baseline: D7 retention, share of organic returns, conversion to payment. A mechanism without a metric does not enter the machine.

## One important rule

A casino presses the same buttons. We build in a guardrail: the machine amplifies value for the user, it does not squeeze the user. That's not moralizing — it's business protection: dark patterns get apps banned from stores and fined by the EU.

## The essence in one paragraph

Today AI creates products by guessing the next word. We are building an engine that creates them on a different foundation: a dozen buttons of human motivation, verified by science and trillions of other people's ad dollars, closed into a loop with our platform's real numbers. Whoever owns this layer owns the difference between "the software works" and "people can't put it down."

# /decisions — Architectural decision log

## What lives here

`decisions.json` — the append-only decision log:

```json
{ "decisions": [{ "id": "D-001", "date": "YYYY-MM-DD", "title": "…", "body": "…", "area": "architecture|data|process|stack" }] }
```

Every architectural decision (stack, data structure, deviation from plan)
gets an entry in the same PR that makes the change. The app renders the log
reverse-chronologically at `/decisions`.

## Filled by

Ships with D-001…D-005 (source-of-truth-in-git, generated cards, validation
hard rules, seed roster v0.9, showcase honesty contract) in the data step,
plus new entries added during the build.

## Phase

July (baseline), then continuously.

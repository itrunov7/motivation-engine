#!/usr/bin/env node
/**
 * PreToolUse guard for the Motivation Engine.
 *
 * Enforces the boundaries prose in CLAUDE.md failed to hold — three times an
 * agent ran extraction after being told to report only, and once built a UI
 * filter after being told not to:
 *
 *   1. Dispatching any extraction or harvest workflow (local run OR CI dispatch),
 *      or calling OpenRouter directly (openrouter-preflight)
 *   2. Pushing to main            (branch policy D-136: main is truth)
 *   3. Deleting a git branch, or a push that deletes/rewrites a remote ref
 *   4. Writing to the DATA the pipeline produces, never to the SOURCE that
 *      produces it: effects/**\/*.json, realizations/**\/*.json,
 *      registry/**\/*.json, corpora/evidence/**, corpora/extraction/**,
 *      decisions/decisions.json, and proposals/**\/*.json — but never a
 *      *.schema.json anywhere (a schema is source, not data, wherever it
 *      lives) — including via the approval projector (tools/proposal.ts) for
 *      any subcommand except the read-only `list`/`show`
 *
 * Everything else — tools/, lib/, app/, docs/, tests, schema files, corpora
 * config (corpora/_ops/**), reads, and ordinary git — is allowed by default
 * (settings.json permissions.defaultMode: dontAsk). This guard exists to
 * carve the few genuinely dangerous exceptions back OUT of that default, not
 * to gate ordinary source edits.
 *
 * On a match it returns permissionDecision "ask", so the owner must approve the
 * call in person. It NEVER auto-allows: a clean call exits silently and normal
 * permission evaluation continues (governed by settings.json's allow/ask lists).
 * On its own internal error it fails SAFE by asking — a broken guard escalates
 * to a human rather than waving work through.
 *
 * Matching is scoped to what a segment actually INVOKES, not what it merely
 * mentions: `grep foo tools/extract.ts` reads a file and must never be treated
 * the same as `tsx tools/extract.ts run ...`, which dispatches a paid run. Each
 * `;`/`&&`/`||`/`|`-separated segment is checked against its own leading
 * command, so a compound command cannot hide a dispatch behind an earlier
 * innocuous one, and a read tool earlier in a pipe cannot launder a later one.
 *
 * The guard reads only the tool call (command string / file path) and, for a
 * git push with no explicit branch named, the current branch via a local,
 * read-only `git rev-parse`. It performs no writes, no network, no dispatch of
 * its own.
 */
"use strict";

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    decide(JSON.parse(raw || "{}"));
  } catch (err) {
    ask(`guard could not evaluate this call (${err && err.message}); asking to be safe`);
  }
});

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// A schema is source, not data — proposals/proposal.schema.json,
// effects/effect.schema.json, realizations/realization.schema.json, and
// registry/mechanism.schema.json describe the shape of the data below them;
// they are never themselves a record. This exclusion is checked FIRST and
// applies uniformly, so a new schema anywhere is safe by construction.
function isSchemaFile(rel) {
  return /\.schema\.json$/.test(rel);
}

// The exact write surface that needs owner approval: DATA the pipeline
// produces (effects/realizations/registry records, the evidence/extraction
// corpora, the append-only decision log, and proposal payloads) — never the
// SOURCE that produces it.
function isProtectedWritePath(rel) {
  if (isSchemaFile(rel)) return false;
  if (rel === "decisions/decisions.json") return true;
  if (/^effects\/.*\.json$/.test(rel)) return true;
  if (/^realizations\/.*\.json$/.test(rel)) return true;
  if (/^registry\/.*\.json$/.test(rel)) return true;
  if (/^corpora\/evidence\//.test(rel)) return true;
  if (/^corpora\/extraction\//.test(rel)) return true;
  if (/^proposals\/.*\.json$/.test(rel)) return true;
  return false;
}

// Leading commands that only ever read. A gated path or script appearing as
// an ARGUMENT to one of these is evidence of a read, not a dispatch or a
// mutation — `grep tools/extract.ts`, `cat corpora/CL-14/manifest.json`,
// `wc -l tools/proposal.ts` must never ask.
const READ_ONLY_LEADERS = new Set([
  "grep", "egrep", "fgrep", "rg",
  "cat", "less", "more", "head", "tail",
  "ls", "find", "wc", "file", "stat", "tree", "nl", "sort", "uniq",
]);

function leadingCommand(seg) {
  // Strip leading env-var assignments (FOO=bar cmd ...), take the first
  // token, drop any path prefix (/usr/bin/grep -> grep).
  const stripped = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "");
  const m = stripped.match(/^(\S+)/);
  return m ? m[1].replace(/^.*\//, "") : "";
}

function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function pass() {
  process.exit(0);
}

function decide(evt) {
  const tool = evt.tool_name || "";
  const input = evt.tool_input || {};

  if (tool === "Bash") return decideBash(String(input.command || ""));

  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const p = String(input.file_path || input.notebook_path || "");
    let rel = p;
    if (rel.startsWith(projectDir)) rel = rel.slice(projectDir.length);
    rel = rel.replace(/^\/+/, "").replace(/^\.\//, "");
    if (isProtectedWritePath(rel)) {
      return ask(`writes ${rel || p} (${tool}) — owner approval required for pipeline data`);
    }
    return pass();
  }

  return pass();
}

// True when a git push segment (already confirmed to contain `push`) targets
// main. An explicit "main" token anywhere in the segment settles it. Failing
// that, an explicit non-main ref settles it the other way. A bare `git push`
// or `git push <remote>` names no branch — it pushes the current branch to
// its upstream, so fall back to asking git itself which branch that is
// (read-only; fails safe to "true"/ask if that call cannot run).
function pushTargetsMain(seg) {
  if (/(^|[\s/:])main\b/.test(seg)) return true;

  const afterPush = seg.replace(/^.*?\bpush\b/, "").trim();
  const positional = afterPush.split(/\s+/).filter((a) => a && !a.startsWith("-"));
  if (positional.length >= 2) return false; // explicit "<remote> <ref>", ref isn't main

  try {
    const { execSync } = require("node:child_process");
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch === "main";
  } catch {
    return true; // can't determine the current branch — fail safe, ask.
  }
}

// Returns the subcommand token for a `tools/extract.ts` / `npm run extract`
// invocation, or null if the segment does not invoke it at all.
function extractSubcommand(seg) {
  const invoked =
    /\b(?:npm|pnpm|yarn)\s+run\s+extract\b/.test(seg) ||
    /\b(?:npx\s+)?tsx\s+tools\/extract\.ts\b/.test(seg) ||
    /\btools\/extract\.ts\b/.test(seg);
  if (!invoked) return null;
  const m = seg.match(/(?:tools\/extract\.ts|run\s+extract(?:\s+--)?)\s+(\S+)/);
  return m ? m[1] : undefined;
}

// Same shape for `tools/run-connector.ts` / `npm run connector`.
function connectorSubcommand(seg) {
  const invoked =
    /\b(?:npm|pnpm|yarn)\s+run\s+connector\b/.test(seg) ||
    /\b(?:npx\s+)?tsx\s+tools\/run-connector\.ts\b/.test(seg) ||
    /\btools\/run-connector\.ts\b/.test(seg);
  if (!invoked) return null;
  const m = seg.match(/(?:tools\/run-connector\.ts|run\s+connector(?:\s+--)?)\s+(\S+)/);
  return m ? m[1] : undefined;
}

// Same shape for `tools/proposal.ts` / `npm run proposal`.
function proposalSubcommand(seg) {
  const invoked =
    /\b(?:npm|pnpm|yarn)\s+run\s+proposal\b/.test(seg) ||
    /\b(?:npx\s+)?tsx\s+tools\/proposal\.ts\b/.test(seg) ||
    /\btools\/proposal\.ts\b/.test(seg);
  if (!invoked) return null;
  const m = seg.match(/(?:tools\/proposal\.ts|run\s+proposal(?:\s+--)?)\s+(\S+)/);
  return m ? m[1] : undefined;
}

function decideBash(command) {
  const reasons = [];
  // Evaluate each shell segment on its own so a compound command
  // (`cd x && git push`) is caught, and `git help push` in one segment does not
  // taint an unrelated one.
  const segments = command
    .split(/\n|;|&&|\|\||\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  const isGit = (s) => /(^|\s|`)git(\s|$)/.test(s);

  // Read-only git subcommands: `git status`/`git fetch` etc. are reads, not
  // pushes or dispatches, even though the word "push" or a gated path can
  // legitimately appear in their output-adjacent text (e.g. `git log --grep`).
  const isGitDoc = (s) =>
    /\bgit\s+(?:help|log|show|config|grep|blame|diff|status|fetch)\b/.test(s);

  for (const seg of segments) {
    if (isGit(seg) && !isGitDoc(seg) && /\bpush\b/.test(seg)) {
      const isDeleteForm = /(--delete|--mirror|--prune)\b/.test(seg) || /\s:\S/.test(seg);
      if (isDeleteForm) {
        reasons.push("git push that deletes or rewrites a remote ref");
      } else if (pushTargetsMain(seg)) {
        reasons.push(
          "git push to main — remote history is owner-gated (branch policy D-136: main is truth)",
        );
      }
      // else: push to a named non-main branch — not flagged, falls through
      // to the broad `Bash(git push:*)` allow rule in settings.json.
    }
    if (
      /\bgit\s+branch\b/.test(seg) &&
      /(^|\s)(-D|-d|--delete)(\b|=)/.test(seg)
    ) {
      reasons.push("git branch delete");
    }
  }

  // Segments whose actually-invoked command only reads never count toward the
  // dispatch/write checks below, even when they mention a gated path or
  // script as an argument.
  const isReadOnlySegment = (seg) =>
    READ_ONLY_LEADERS.has(leadingCommand(seg)) || (isGit(seg) && isGitDoc(seg));

  for (const seg of segments) {
    if (isReadOnlySegment(seg)) continue;

    // Extraction: the `quote` subcommand is a deterministic, zero-network cost
    // estimate (writes only the gitignored /quote.json) — it spends nothing
    // and dispatches nothing, so it is not flagged. Everything else
    // (`run`, or no subcommand at all) is a real dispatch attempt.
    const extractSub = extractSubcommand(seg);
    if (extractSub !== null && extractSub !== "quote") {
      reasons.push(
        "dispatches an extraction run (consumes reader coverage / corpus reads / budget)",
      );
    }

    // Connector: same shape — `quote` is a zero-network estimate (D-025).
    const connectorSub = connectorSubcommand(seg);
    if (connectorSub !== null && connectorSub !== "quote") {
      reasons.push(
        "dispatches a connector harvest (consumes reader coverage / corpus reads / budget)",
      );
    }

    if (
      /\bgh\s+workflow\s+run\s+(?:extract|harvest|connectors|maturation)/.test(seg) ||
      /\bgh\s+run\s+rerun\b/.test(seg) ||
      new RegExp(
        "actions/workflows/(extract|harvest|connectors|maturation)[\\w.-]*/dispatches",
      ).test(seg) ||
      (/\bgh\s+api\b/.test(seg) &&
        /dispatch/.test(seg) &&
        /(extract|harvest|connector|maturation)/.test(seg))
    ) {
      reasons.push(
        "dispatches an extraction or harvest workflow via CI (consumes reader coverage / corpus reads / budget)",
      );
    }

    // openrouter-preflight calls OpenRouter for real, if for a fraction of a
    // cent (D-107) — it has no dry-run mode, so every invocation asks.
    if (
      /\b(?:npm|pnpm|yarn)\s+run\s+openrouter-preflight\b/.test(seg) ||
      /\b(?:npx\s+)?tsx\s+tools\/openrouter-preflight\.ts\b/.test(seg) ||
      /\btools\/openrouter-preflight\.ts\b/.test(seg)
    ) {
      reasons.push("calls OpenRouter directly (openrouter-preflight spends real budget)");
    }

    // Proposal projector: `list`/`show` are read-only inspection; every other
    // subcommand (approve/reject/batch-reject/edit/edit-approve, or none)
    // writes under effects/, registry/, and proposals/.
    const proposalSub = proposalSubcommand(seg);
    if (proposalSub !== null && proposalSub !== "list" && proposalSub !== "show") {
      reasons.push(
        "runs the approval projector (tools/proposal.ts) — writes under effects/, registry/, and proposals/",
      );
    }
  }

  // Shell writes to the protected DATA surface: a redirect into a matching
  // path, or a mutating verb naming one. Reads (cat/grep) are not matched. A
  // tempered-dot loop (the `(?:(?!\.schema\.json)[\w./-])*` clause) walks the
  // path one character at a time and refuses to cross a `.schema.json`
  // boundary, so `effects/effect.schema.json` can never satisfy the pattern
  // even though it ends in `.json` — the same exclusion isProtectedWritePath
  // applies to Write/Edit, reimplemented here for free-text shell matching.
  const jsonNotSchema = (dir) => dir + "(?:(?!\\.schema\\.json)[\\w./-])*\\.json";
  const anyNotSchema = (dir) => dir + "(?:(?!\\.schema\\.json)[\\w./-])+";
  const PROTECTED_TARGET = new RegExp(
    "(?:\\.\\/)?(?:" +
      "decisions\\/decisions\\.json" +
      "|" + jsonNotSchema("effects\\/") +
      "|" + jsonNotSchema("realizations\\/") +
      "|" + jsonNotSchema("registry\\/") +
      "|" + anyNotSchema("corpora\\/evidence\\/") +
      "|" + anyNotSchema("corpora\\/extraction\\/") +
      "|" + jsonNotSchema("proposals\\/") +
    ")",
  );
  const redirect = new RegExp(">>?\\s*" + PROTECTED_TARGET.source);
  const mutating =
    /\b(rm|rmdir|mv|cp|dd|truncate|tee|touch|mkdir|ln|sed\s+-i|perl\s+-i|install|shred)\b/;
  const touchesProtected = new RegExp("(^|[\\s'\"(=`])" + PROTECTED_TARGET.source);
  for (const seg of segments) {
    if (redirect.test(seg) || (mutating.test(seg) && touchesProtected.test(seg))) {
      reasons.push(
        "shell command that may write pipeline data (effects/ realizations/ registry/ corpora/evidence/ corpora/extraction/ decisions.json/ proposals/, excluding *.schema.json)",
      );
      break;
    }
  }

  if (reasons.length === 0) return pass();
  return ask("Owner approval required — " + [...new Set(reasons)].join("; ") + ".");
}

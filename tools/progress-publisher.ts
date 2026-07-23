/**
 * tools/progress-publisher.ts — publishes the run-progress heartbeat to the
 * dedicated `ops-progress` git ref (D-086).
 *
 * Usage (inside GitHub Actions only):
 *   npx tsx tools/progress-publisher.ts <command> [args...]
 *   e.g. npx tsx tools/progress-publisher.ts npm run connector -- evidence mechanism=CL-14
 *
 * It spawns the wrapped command with inherited stdio (so `tee` logging still
 * works), and every ~2 minutes — plus once when the child exits — force-pushes
 * the gitignored working heartbeat (tools/progress.ts RUN_PROGRESS_FILE) to
 * refs/heads/ops-progress as a single-file ORPHAN commit. An orphan tree keeps
 * the branch tiny AND carries no .github/workflows, so heartbeat pushes trigger
 * no CI and never touch main. Pushing uses the job's existing checkout
 * credentials (GITHUB_TOKEN, contents: write).
 *
 * The publisher exits with the wrapped command's exit code; a failed push is
 * logged and swallowed — telemetry must never redden a real run.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { RUN_PROGRESS_FILE } from "./progress";

const INTERVAL_MS = Number.parseInt(
  process.env.OPS_PROGRESS_INTERVAL_MS ?? "120000",
  10,
);
const REF = process.env.OPS_PROGRESS_REF ?? "ops-progress";
const REMOTE = process.env.OPS_PROGRESS_REMOTE ?? "origin";
/** The single file's path on the ops-progress ref. */
const ENTRY = "run-progress.json";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "github-actions[bot]",
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "github-actions[bot]",
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com",
};

let lastPushed: string | null = null;
let pushing = false;

function git(args: string[], input?: Buffer): string {
  const result = spawnSync("git", args, {
    input,
    env: { ...process.env, ...GIT_IDENTITY },
    encoding: "buffer",
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf-8") ?? "";
    throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  }
  return result.stdout.toString("utf-8").trim();
}

/** Push the current heartbeat to the ops-progress ref if it changed. */
function publish(): void {
  if (pushing || !existsSync(RUN_PROGRESS_FILE)) return;
  let content: Buffer;
  try {
    content = readFileSync(RUN_PROGRESS_FILE);
  } catch {
    return;
  }
  const fingerprint = content.toString("utf-8");
  if (fingerprint === lastPushed) return;
  pushing = true;
  try {
    const blob = git(["hash-object", "-w", "--stdin"], content);
    const tree = git(["mktree"], Buffer.from(`100644 blob ${blob}\t${ENTRY}\n`));
    const commit = git([
      "commit-tree",
      tree,
      "-m",
      "ops: run progress heartbeat (D-086)",
    ]);
    git(["push", "--force", REMOTE, `${commit}:refs/heads/${REF}`]);
    lastPushed = fingerprint;
  } catch (error) {
    console.error(
      `[progress-publisher] push skipped: ${(error as Error).message}`,
    );
  } finally {
    pushing = false;
  }
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error(
      "Usage: npx tsx tools/progress-publisher.ts <command> [args...]",
    );
    process.exit(2);
  }

  const child = spawn(command, args, { stdio: "inherit", shell: false });
  const timer = setInterval(publish, INTERVAL_MS);
  timer.unref?.();

  const finish = (code: number): void => {
    clearInterval(timer);
    publish(); // final heartbeat (the tool marks it finished)
    process.exit(code);
  };

  child.on("exit", (code, signal) => {
    finish(code ?? (signal ? 1 : 0));
  });
  child.on("error", (error) => {
    console.error(`[progress-publisher] failed to start: ${error.message}`);
    finish(127);
  });
}

main();

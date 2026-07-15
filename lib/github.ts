/**
 * lib/github.ts — the GitHub API client for the Operations UI (D-023).
 *
 * This is the ONLY module in the app that touches the network at runtime, and
 * it is imported ONLY by the app/ops server actions (D-023 amendment to rule
 * 12): the app never harvests — it commits the narrow _ops write surface via
 * the Contents API and triggers/reads the harvest workflow via the Actions
 * API. All calls go to api.github.com; nothing else. Auth is a fine-grained,
 * repo-scoped PAT read from env GH_OPS_TOKEN (never committed). Without the
 * token the whole surface is disabled and /ops renders read-only.
 */

import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";

const API_BASE = "https://api.github.com";

/** The workflow the app dispatches; must exist at .github/workflows/. */
export const HARVEST_WORKFLOW_FILE = "harvest.yml";

/** Resolved GitHub target for the write + run surface. */
export interface GithubOpsEnv {
  token: string;
  owner: string;
  repo: string;
  /** Branch the app commits to and dispatches against (default "main"). */
  branch: string;
}

/**
 * Reads the ops GitHub config from env, or null when the write token is
 * absent — the signal /ops uses to render its disabled, read-only state.
 * Repo comes from GH_OPS_REPO ("owner/repo"), falling back to the standard
 * GITHUB_REPOSITORY.
 */
export function readGithubOpsEnv(): GithubOpsEnv | null {
  const token = process.env.GH_OPS_TOKEN;
  const repoSlug = process.env.GH_OPS_REPO ?? process.env.GITHUB_REPOSITORY;
  if (!token || !repoSlug || !repoSlug.includes("/")) return null;
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) return null;
  return { token, owner, repo, branch: process.env.GH_OPS_BRANCH ?? "main" };
}

/** True when the operational write/run surface is configured. */
export function isOpsWriteEnabled(): boolean {
  return readGithubOpsEnv() !== null;
}

export class GithubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

async function ghFetch(
  env: GithubOpsEnv,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.token}`);
  headers.set("accept", "application/vnd.github+json");
  headers.set("x-github-api-version", "2022-11-28");
  headers.set("user-agent", "motivation-engine-ops/0.1");
  return fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
}

// ---------- Contents API (the _ops write surface) ----------

export interface RepoFile {
  /** Decoded UTF-8 contents. */
  text: string;
  /** Blob sha, required to update the file (optimistic concurrency). */
  sha: string;
}

/** GET a file's contents + sha, or null when it does not exist (404). */
export async function getRepoFile(
  env: GithubOpsEnv,
  path: string,
): Promise<RepoFile | null> {
  const res = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(env.branch)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GithubApiError(res.status, `GET contents ${path} failed: ${await res.text()}`);
  }
  const body = (await res.json()) as { content?: string; sha: string };
  const text = body.content ? Buffer.from(body.content, "base64").toString("utf-8") : "";
  return { text, sha: body.sha };
}

/**
 * PUT a file via the Contents API with one sha-conflict retry: if the commit
 * races another write (409 / 422 stale sha), we re-read the current sha and
 * retry once so a concurrent commit never clobbers or fails silently.
 */
export async function putRepoFile(
  env: GithubOpsEnv,
  args: { path: string; message: string; text: string; sha?: string },
): Promise<{ commitSha: string }> {
  const attempt = async (sha: string | undefined): Promise<Response> =>
    ghFetch(env, `/repos/${env.owner}/${env.repo}/contents/${encodeURIComponent(args.path).replace(/%2F/g, "/")}`, {
      method: "PUT",
      body: JSON.stringify({
        message: args.message,
        content: Buffer.from(args.text, "utf-8").toString("base64"),
        branch: env.branch,
        ...(sha ? { sha } : {}),
      }),
    });

  let res = await attempt(args.sha);
  if (res.status === 409 || res.status === 422) {
    const current = await getRepoFile(env, args.path);
    res = await attempt(current?.sha);
  }
  if (!res.ok) {
    throw new GithubApiError(res.status, `PUT contents ${args.path} failed: ${await res.text()}`);
  }
  const body = (await res.json()) as { commit: { sha: string } };
  return { commitSha: body.commit.sha };
}

// ---------- Actions API (dispatch, poll, artifact) ----------

/** Fire a workflow_dispatch on HARVEST_WORKFLOW_FILE with string inputs. */
export async function dispatchHarvest(
  env: GithubOpsEnv,
  inputs: Record<string, string>,
): Promise<void> {
  const res = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/actions/workflows/${HARVEST_WORKFLOW_FILE}/dispatches`,
    { method: "POST", body: JSON.stringify({ ref: env.branch, inputs }) },
  );
  if (!res.ok) {
    throw new GithubApiError(res.status, `workflow_dispatch failed: ${await res.text()}`);
  }
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

/**
 * Find the most recent workflow_dispatch run whose name contains the given
 * dispatch id (the workflow echoes dispatch_id into run-name for correlation,
 * D-025). Returns null until GitHub has registered the run.
 */
export async function findRunByDispatchId(
  env: GithubOpsEnv,
  dispatchId: string,
): Promise<WorkflowRun | null> {
  const res = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/actions/workflows/${HARVEST_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=30`,
  );
  if (!res.ok) {
    throw new GithubApiError(res.status, `list runs failed: ${await res.text()}`);
  }
  const body = (await res.json()) as { workflow_runs: WorkflowRun[] };
  return body.workflow_runs.find((run) => run.name?.includes(dispatchId)) ?? null;
}

export async function getRun(env: GithubOpsEnv, runId: number): Promise<WorkflowRun> {
  const res = await ghFetch(env, `/repos/${env.owner}/${env.repo}/actions/runs/${runId}`);
  if (!res.ok) {
    throw new GithubApiError(res.status, `get run ${runId} failed: ${await res.text()}`);
  }
  return (await res.json()) as WorkflowRun;
}

interface WorkflowJob {
  name: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
}

/**
 * A short, human-readable reason a completed run did not succeed, read from
 * the run's jobs: the first non-successful job and its first failed step
 * (D-025). Used by the /ops poll to show WHY a dry run produced no estimate,
 * instead of the generic "no quote" message. Best-effort — falls back to the
 * run's own conclusion when the jobs list is empty or unreadable.
 */
export async function getRunFailureSummary(
  env: GithubOpsEnv,
  runId: number,
  runConclusion: string | null,
): Promise<string> {
  const fallback = `the dry run did not succeed (${runConclusion ?? "unknown"})`;
  try {
    const res = await ghFetch(
      env,
      `/repos/${env.owner}/${env.repo}/actions/runs/${runId}/jobs`,
    );
    if (!res.ok) return fallback;
    const jobs = ((await res.json()) as { jobs?: WorkflowJob[] }).jobs ?? [];
    const failedJob = jobs.find(
      (job) => job.conclusion !== null && job.conclusion !== "success" && job.conclusion !== "skipped",
    );
    if (!failedJob) return fallback;
    const failedStep = (failedJob.steps ?? []).find(
      (step) => step.conclusion !== null && step.conclusion !== "success" && step.conclusion !== "skipped",
    );
    return failedStep
      ? `the "${failedJob.name}" job failed at step "${failedStep.name}" (${failedStep.conclusion})`
      : `the "${failedJob.name}" job did not succeed (${failedJob.conclusion})`;
  } catch {
    return fallback;
  }
}

/**
 * Download a run's named artifact zip and extract one JSON entry from it.
 * GitHub artifacts are ZIPs; we parse the central directory and inflate the
 * entry with node:zlib (no dependency). Returns null when the artifact or the
 * entry is not present yet.
 */
export async function downloadArtifactJson<T>(
  env: GithubOpsEnv,
  runId: number,
  artifactName: string,
  entryName: string,
): Promise<T | null> {
  const list = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/actions/runs/${runId}/artifacts`,
  );
  if (!list.ok) {
    throw new GithubApiError(list.status, `list artifacts failed: ${await list.text()}`);
  }
  const artifacts = ((await list.json()) as { artifacts: { id: number; name: string }[] }).artifacts;
  const artifact = artifacts.find((a) => a.name === artifactName);
  if (!artifact) return null;

  const zipRes = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/actions/artifacts/${artifact.id}/zip`,
  );
  if (!zipRes.ok) {
    throw new GithubApiError(zipRes.status, `download artifact failed: ${await zipRes.text()}`);
  }
  const zip = Buffer.from(await zipRes.arrayBuffer());
  const entry = extractZipEntry(zip, entryName);
  if (!entry) return null;
  return JSON.parse(entry.toString("utf-8")) as T;
}

/**
 * Minimal ZIP entry extractor (stored or deflate) via the End-Of-Central-
 * Directory record — enough for GitHub's small artifact zips, no dependency.
 */
function extractZipEntry(zip: Buffer, entryName: string): Buffer | null {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const cdEntries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);

  for (let n = 0; n < cdEntries && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== CD_SIG) break;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);

    if (name === entryName) {
      if (zip.readUInt32LE(localOffset) !== LFH_SIG) return null;
      const lNameLen = zip.readUInt16LE(localOffset + 26);
      const lExtraLen = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

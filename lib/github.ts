/**
 * lib/github.ts — the GitHub API client for authorized app write surfaces.
 *
 * Operations use the Contents + Actions APIs (D-023). Proposal approval uses
 * the Git Data API to create one tree/commit and advances the branch ref once
 * (D-076). All calls go to api.github.com; nothing else. Auth is a fine-
 * grained, repo-scoped PAT read from env GH_OPS_TOKEN (never committed).
 */

import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";
import type { FileMutation, PreparedProposalTransaction } from "./proposals";

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

export class GithubTransactionConflictError extends GithubApiError {
  constructor(message: string) {
    super(409, message);
    this.name = "GithubTransactionConflictError";
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

export interface RepoDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

/** List one repository directory at the configured branch. */
export async function listRepoDirectory(
  env: GithubOpsEnv,
  path: string,
): Promise<RepoDirectoryEntry[]> {
  const res = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(env.branch)}`,
  );
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new GithubApiError(res.status, `GET directory ${path} failed: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    name: string;
    path: string;
    type: "file" | "dir";
  }[];
  return body.map(({ name, path: entryPath, type }) => ({
    name,
    path: entryPath,
    type,
  }));
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

// ---------- Git Data API (atomic multi-file knowledge transactions) ----------

async function getRepoFileAtRef(
  env: GithubOpsEnv,
  path: string,
  ref: string,
): Promise<RepoFile | null> {
  const res = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GithubApiError(
      res.status,
      `GET contents ${path} at ${ref} failed: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { content?: string; sha: string };
  return {
    text: body.content ? Buffer.from(body.content, "base64").toString("utf8") : "",
    sha: body.sha,
  };
}

async function getBranchHead(env: GithubOpsEnv): Promise<string> {
  const branchPath = encodeURIComponent(env.branch).replace(/%2F/g, "/");
  const res = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/git/ref/heads/${branchPath}`,
  );
  if (!res.ok) {
    throw new GithubApiError(res.status, `get branch ref failed: ${await res.text()}`);
  }
  return ((await res.json()) as { object: { sha: string } }).object.sha;
}

export interface GitDataTransactionOptions {
  message: string;
  mutations: FileMutation[];
  /** Optional caller-observed head for an additional whole-repo stale check. */
  expectedHeadSha?: string;
}

/**
 * Creates blobs, one tree, and one commit, then advances the branch ref once.
 * Per-file expectedContent guards prevent stale proposal/artifact decisions;
 * the non-forced ref update rejects a concurrent branch advance. A null
 * mutation content emits a Git tree deletion.
 */
export async function commitGitDataTransaction(
  env: GithubOpsEnv,
  transaction:
    | GitDataTransactionOptions
    | (Pick<PreparedProposalTransaction, "commitMessage" | "mutations"> & {
        expectedHeadSha?: string;
      }),
): Promise<{ commitSha: string; previousHeadSha: string }> {
  const message =
    "message" in transaction ? transaction.message : transaction.commitMessage;
  const mutations = transaction.mutations;
  const uniquePaths = new Set<string>();
  for (const mutation of mutations) {
    if (uniquePaths.has(mutation.path)) {
      throw new Error(`Duplicate transaction path: ${mutation.path}`);
    }
    uniquePaths.add(mutation.path);
  }

  const headSha = await getBranchHead(env);
  if (transaction.expectedHeadSha && transaction.expectedHeadSha !== headSha) {
    throw new GithubTransactionConflictError(
      `Branch ${env.branch} advanced from ${transaction.expectedHeadSha} to ${headSha}`,
    );
  }
  for (const mutation of mutations) {
    const current = await getRepoFileAtRef(env, mutation.path, headSha);
    if ((current?.text ?? null) !== mutation.expectedContent) {
      throw new GithubTransactionConflictError(
        `${mutation.path} changed after the proposal transaction was prepared`,
      );
    }
  }
  if (mutations.length === 0) {
    return { commitSha: headSha, previousHeadSha: headSha };
  }

  const commitRes = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/git/commits/${headSha}`,
  );
  if (!commitRes.ok) {
    throw new GithubApiError(
      commitRes.status,
      `get base commit failed: ${await commitRes.text()}`,
    );
  }
  const baseTreeSha = ((await commitRes.json()) as { tree: { sha: string } }).tree.sha;

  const blobShas = await Promise.all(
    mutations.map(async (mutation): Promise<string | null> => {
      if (mutation.content === null) return null;
      const res = await ghFetch(
        env,
        `/repos/${env.owner}/${env.repo}/git/blobs`,
        {
          method: "POST",
          body: JSON.stringify({ content: mutation.content, encoding: "utf-8" }),
        },
      );
      if (!res.ok) {
        throw new GithubApiError(
          res.status,
          `create blob for ${mutation.path} failed: ${await res.text()}`,
        );
      }
      return ((await res.json()) as { sha: string }).sha;
    }),
  );

  const treeRes = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: mutations.map((mutation, index) => ({
          path: mutation.path,
          mode: "100644",
          type: "blob",
          sha: blobShas[index],
        })),
      }),
    },
  );
  if (!treeRes.ok) {
    throw new GithubApiError(treeRes.status, `create tree failed: ${await treeRes.text()}`);
  }
  const treeSha = ((await treeRes.json()) as { sha: string }).sha;

  const newCommitRes = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({ message, tree: treeSha, parents: [headSha] }),
    },
  );
  if (!newCommitRes.ok) {
    throw new GithubApiError(
      newCommitRes.status,
      `create commit failed: ${await newCommitRes.text()}`,
    );
  }
  const newCommitSha = ((await newCommitRes.json()) as { sha: string }).sha;

  const branchPath = encodeURIComponent(env.branch).replace(/%2F/g, "/");
  const refRes = await ghFetch(
    env,
    `/repos/${env.owner}/${env.repo}/git/refs/heads/${branchPath}`,
    {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommitSha, force: false }),
    },
  );
  if (refRes.status === 409 || refRes.status === 422) {
    throw new GithubTransactionConflictError(
      `Branch ${env.branch} advanced while the transaction commit was being created`,
    );
  }
  if (!refRes.ok) {
    throw new GithubApiError(
      refRes.status,
      `update branch ref failed: ${await refRes.text()}`,
    );
  }
  return { commitSha: newCommitSha, previousHeadSha: headSha };
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

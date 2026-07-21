import {
  constants,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { FileMutation, PreparedProposalTransaction, RepositorySnapshot } from "./proposals";

export class FileTransactionConflictError extends Error {
  constructor(readonly path: string) {
    super(`Stale transaction: ${path} changed after the proposal was prepared`);
    this.name = "FileTransactionConflictError";
  }
}

function absolutePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolute.startsWith(prefix)) {
    throw new Error(`Mutation escapes repository root: ${path}`);
  }
  return absolute;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class LocalRepositorySnapshot implements RepositorySnapshot {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  read(path: string): Promise<string | null> {
    return readOptional(absolutePath(this.root, path));
  }
}

/**
 * Applies a prepared multi-file transaction under one local lock. Every
 * precondition is checked before the first target is changed. Existing files
 * are moved to transaction-local backups, and any failure rolls all applied
 * paths back before releasing the lock.
 */
export async function applyLocalTransaction(
  repositoryRoot: string,
  transaction: Pick<PreparedProposalTransaction, "mutations"> | FileMutation[],
): Promise<void> {
  const root = resolve(repositoryRoot);
  const mutations = Array.isArray(transaction) ? transaction : transaction.mutations;
  const paths = new Set<string>();
  for (const mutation of mutations) {
    if (paths.has(mutation.path)) throw new Error(`Duplicate mutation path: ${mutation.path}`);
    paths.add(mutation.path);
    absolutePath(root, mutation.path);
  }

  const lockPath = join(root, ".proposal-transaction.lock");
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  const stagingRoot = join(root, `.proposal-transaction-${randomUUID()}`);
  const applied: {
    mutation: FileMutation;
    backedUp: boolean;
    wroteTarget: boolean;
  }[] = [];
  try {
    for (const mutation of mutations) {
      const current = await readOptional(absolutePath(root, mutation.path));
      if (current !== mutation.expectedContent) {
        throw new FileTransactionConflictError(mutation.path);
      }
    }

    for (const mutation of mutations) {
      if (mutation.content === null) continue;
      const staged = join(stagingRoot, "new", mutation.path);
      await mkdir(dirname(staged), { recursive: true });
      await writeFile(staged, mutation.content, "utf8");
    }

    for (const mutation of mutations) {
      const target = absolutePath(root, mutation.path);
      const backup = join(stagingRoot, "backup", mutation.path);
      await mkdir(dirname(target), { recursive: true });
      const state = { mutation, backedUp: false, wroteTarget: false };
      applied.push(state);
      if (mutation.expectedContent !== null) {
        await mkdir(dirname(backup), { recursive: true });
        await rename(target, backup);
        state.backedUp = true;
      }
      if (mutation.content !== null) {
        await rename(join(stagingRoot, "new", mutation.path), target);
        state.wroteTarget = true;
      }
    }
  } catch (error) {
    for (const state of [...applied].reverse()) {
      const { mutation } = state;
      const target = absolutePath(root, mutation.path);
      const backup = join(stagingRoot, "backup", mutation.path);
      if (state.wroteTarget) {
        await rm(target, { force: true, recursive: false }).catch(() => undefined);
      }
      if (state.backedUp) {
        await mkdir(dirname(target), { recursive: true });
        await rename(backup, target).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/** Lightweight probe used by callers that want to fail before preparation. */
export async function assertLocalRepository(root: string): Promise<void> {
  const metadata = await stat(resolve(root));
  if (!metadata.isDirectory()) throw new Error(`${root} is not a directory`);
}

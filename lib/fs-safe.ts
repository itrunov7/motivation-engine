/**
 * lib/fs-safe.ts — a directory listing that degrades to empty on any fs
 * error (a missing directory, a permission error, a transient EMFILE under
 * load) instead of throwing.
 *
 * Every caller here is advisory or best-effort (a /review triage flag, a
 * proposal listing that already has its own fallback): treating a listing
 * failure as "nothing found this pass" can never fabricate or hide
 * authoritative data, because these callers already treat an empty list the
 * same as a missing directory. What it prevents is a single transient I/O
 * error turning into an unhandled exception that crashes an entire page.
 */
import { readdirSync } from "node:fs";

export function safeReaddirSync(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

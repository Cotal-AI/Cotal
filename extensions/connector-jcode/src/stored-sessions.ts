/**
 * Local facts about a Jcode home's `sessions/` directory, and a bounded reading of the
 * harness panic that empty directory currently produces.
 *
 * The panic lives in the jcode binary (`stored_session_ids` chunks a zero-length list).
 * This module exists so the connector can refuse to poke that RPC when the answer is
 * already known (an empty directory holds no resumable session), and so a listing
 * failure still names the panic and the path instead of `unknown`.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function storedSessionsPath(jcodeHome: string): string {
  return join(jcodeHome, "sessions");
}

export type StoredSessionsInspection =
  | { kind: "absent"; path: string }
  | { kind: "empty-directory"; path: string }
  | { kind: "populated"; path: string; entries: number }
  | { kind: "not-a-directory"; path: string };

export function inspectStoredSessions(jcodeHome: string): StoredSessionsInspection {
  const path = storedSessionsPath(jcodeHome);
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory()) return { kind: "not-a-directory", path };
    const entries = readdirSync(path).length;
    if (entries === 0) return { kind: "empty-directory", path };
    return { kind: "populated", path, entries };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent", path };
    throw error;
  }
}

/** True only for a real empty directory. A missing directory is a first launch, not this defect. */
export function isEmptyStoredSessionsDirectory(inspection: StoredSessionsInspection): boolean {
  return inspection.kind === "empty-directory";
}

/**
 * Accept only the rust panic the empty-directory listing currently throws. Prose that happens
 * to mention the assertion, or a panic at a different site, is not this failure.
 */
export function classifyStoredSessionPanic(stderr: string): string | undefined {
  const match =
    /thread '[^']*'[^\n]* panicked at ([^\n]*translate\.rs:\d+:\d+):\s*\n\s*(chunk size must be non-zero)/.exec(
      stderr,
    );
  return match ? `${match[2]} at ${match[1]}` : undefined;
}

/** Operator-facing cause: allow-listed phrases only, never arbitrary child bytes. */
export function boundStoredSessionCause(text: string): string {
  if (/chunk size must be non-zero/.test(text)) return "chunk size must be non-zero";
  if (/harness connection closed/i.test(text)) return "harness connection closed";
  if (/write EPIPE/i.test(text)) return "write EPIPE";
  return "harness connection closed";
}

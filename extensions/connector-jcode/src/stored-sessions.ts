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
  | { kind: "not-a-directory"; path: string }
  | { kind: "unreadable"; path: string; code: string };

/**
 * A local read of the seat's own `sessions/` directory. This runs on the startup path of every
 * managed seat, so it must never throw: a home the connector cannot read is a question for the
 * harness, not a reason to kill a seat that would otherwise start. Both reads here can fail on a
 * home whose permissions were perturbed from outside (operator chmod, restored backup, container
 * UID remap): `lstat` when the home itself is unreadable, `readdir` when only `sessions/` is.
 * Anything but a real empty directory falls through to the ordinary listing attempt.
 */
export function inspectStoredSessions(jcodeHome: string): StoredSessionsInspection {
  const path = storedSessionsPath(jcodeHome);
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory()) return { kind: "not-a-directory", path };
    const entries = readdirSync(path).length;
    if (entries === 0) return { kind: "empty-directory", path };
    return { kind: "populated", path, entries };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent", path };
    return { kind: "unreadable", path, code: code ?? "unknown" };
  }
}

/** True only for a real empty directory. A missing directory is a first launch, not this defect. */
export function isEmptyStoredSessionsDirectory(inspection: StoredSessionsInspection): boolean {
  return inspection.kind === "empty-directory";
}

/**
 * Accept only the rust panic the empty-directory listing currently throws. Prose that happens
 * to mention the assertion, a panic at a different site, or a same-named file in another crate
 * is not this failure. The site is anchored on the whole owning path, not the basename: a bare
 * `translate.rs` suffix match would accept any crate that happens to carry that filename.
 */
const STORED_SESSION_PANIC_SITE = "crates/jcode-harness-api-server/src/translate.rs";
const STORED_SESSION_PANIC = new RegExp(
  `thread '[^']*'[^\\n]* panicked at (${STORED_SESSION_PANIC_SITE.replace(/[.]/g, "\\.")}:\\d+:\\d+):\\s*\\n\\s*(chunk size must be non-zero)`,
);

export function classifyStoredSessionPanic(stderr: string): string | undefined {
  const match = STORED_SESSION_PANIC.exec(stderr);
  return match ? `${match[2]} at ${match[1]}` : undefined;
}

/**
 * Operator-facing cause: allow-listed phrases only, never arbitrary child bytes.
 *
 * The fallback is deliberately non-committal. Naming a specific cause for text we do not
 * recognise sends the operator to the wrong place: an out-of-memory spawn failure rendered as
 * "harness connection closed" points at sockets. An unrecognised cause is reported as such.
 */
export const UNRECOGNISED_STORED_SESSION_CAUSE = "unrecognised harness failure";

export function boundStoredSessionCause(text: string): string {
  if (/chunk size must be non-zero/.test(text)) return "chunk size must be non-zero";
  if (/harness connection closed/i.test(text)) return "harness connection closed";
  if (/write EPIPE/i.test(text)) return "write EPIPE";
  return UNRECOGNISED_STORED_SESSION_CAUSE;
}

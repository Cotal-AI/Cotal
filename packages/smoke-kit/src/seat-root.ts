/**
 * A custody root short enough that the seat socket inside it fits a Unix `sun_path`.
 *
 * WHY THIS EXISTS. A seat socket is `<root>/<32 hex>/seat.sock`, so it costs the root plus 43
 * characters, against a hard 107-character ceiling. Every seat suite built its root from `tmpdir()`,
 * which is whatever `TMPDIR` says, and the operating instructions for this repo tell an agent to set
 * `TMPDIR` INSIDE its worktree. A worktree path of any depth then pushes the socket past the limit.
 *
 * That is not a hypothetical either. Two independent reviews of #1648 did exactly that, their seat
 * sockets came to 116 bytes, and every gate run they attempted died before reaching one assertion.
 * `launchSeat` now refuses an overlong path by name instead of dying unattributably, which turns a
 * silent void into a clear message; this helper is the other half, so a suite that needs a custody
 * root gets one that WORKS rather than a clear explanation of why it cannot run.
 *
 * It prefers `TMPDIR`, because honouring a caller's temp location is the point of `TMPDIR` and the
 * containment rules in this repo depend on it. It falls back to `/tmp` ONLY when the requested
 * location cannot hold a socket, and says so on stderr rather than silently relocating a suite's
 * files. A caller that must keep its files inside the worktree should use `tmpdir()` directly and
 * accept the refusal.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Bytes a seat custody root adds before its socket: `/` + 32 hex + `/` + `seat.sock`. */
export const SEAT_SOCKET_OVERHEAD = 1 + 32 + 1 + "seat.sock".length;

/** The `sun_path` ceiling, duplicated from `@cotal-ai/seat` on purpose: smoke-kit depends on
 *  nothing in this repo, and the seat suite asserts the two agree. */
export const SEAT_MAX_SOCKET_PATH = 107;

/** Does a custody root at `base` leave room for the socket inside it? `extra` is the length of the
 *  prefix `mkdtemp` will add, plus its six random characters. */
export function rootFits(base: string, extra: number): boolean {
  return Buffer.byteLength(base, "utf8") + extra + SEAT_SOCKET_OVERHEAD <= SEAT_MAX_SOCKET_PATH;
}

/**
 * Make a temporary seat custody root that a socket actually fits inside.
 *
 * @param prefix directory prefix, as `mkdtempSync` takes it (six random characters are appended).
 * @returns the created directory.
 */
export function makeSeatRoot(prefix: string): string {
  const extra = Buffer.byteLength(prefix, "utf8") + 6 + 1; // prefix + mkdtemp randomness + separator
  const preferred = tmpdir();
  if (rootFits(preferred, extra)) return mkdtempSync(join(preferred, prefix));
  if (!rootFits("/tmp", extra))
    throw new Error(
      `no usable seat custody root: even /tmp leaves a socket over the ${SEAT_MAX_SOCKET_PATH}-byte limit with prefix ${JSON.stringify(prefix)}`,
    );
  // Said out loud: a suite whose files move is a suite whose cleanup and containment must know.
  console.error(
    `[smoke-kit] TMPDIR ${preferred} is too deep for a seat socket (${SEAT_MAX_SOCKET_PATH}-byte sun_path limit); using /tmp for this custody root only`,
  );
  return mkdtempSync(join("/tmp", prefix));
}

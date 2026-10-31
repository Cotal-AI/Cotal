/**
 * Node's own compile cache, for the entry that launches a seat.
 *
 * A seat's shipped bundle is one 5-6 MB module. V8 parses it on every launch, and the parse leaves
 * about 5.7 MiB retained in the process's main malloc arena for as long as the seat lives. Node's
 * compile cache stores the V8 code cache on disk and removes that parse from every launch after the
 * first one.
 *
 * It has to run from an entry IN FRONT of the bundle, never inside it. The cache covers modules
 * compiled after `enableCompileCache()` returns, and a bundle's own compile is already finished
 * before its first statement runs, so a call the bundler inlined into the bundle caches nothing.
 * The seat entry (`dist/seat.cjs`) therefore enables the cache and then loads the bundle.
 */
import { constants, enableCompileCache, flushCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkSecretDir } from "@cotal-ai/core/secret-fs";

/**
 * The oldest Node a seat entry runs on. `enableCompileCache()` arrived in v22.8.0 and
 * `flushCompileCache()` in v22.10.0, and the entry calls both, so v22.10.0 is the first Node that
 * has all of it. The published `engines.node` says the same thing.
 */
export const SEAT_NODE_FLOOR = "22.10.0";

/**
 * Where the seat keeps its compile cache: `compile-cache` under this OS user's own Cotal
 * directory, so it persists across restarts and upgrades and is never in a temp directory that a
 * reboot clears. Node keys a subdirectory inside it, so a Node upgrade pays one compile instead of
 * reading a stale entry.
 *
 * This repeats `userCotalDir()` from `@cotal-ai/workspace` because a connector peer-depends on
 * `@cotal-ai/core` alone and cannot import the workspace layer. `pnpm smoke:seat-compile-cache`
 * asserts the two agree, so they cannot drift apart.
 */
export function seatCompileCacheDir(): string {
  const user = process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Cotal")
    : join(homedir(), ".cotal");
  return join(user, "compile-cache");
}

/**
 * Refuse a runtime that cannot cache a seat's compile, before anything calls into the cache.
 *
 * Serving anyway without a cache is a silent downgrade of the one thing this entry exists for, so
 * an old runtime is refused rather than degraded. The version is checked first and the two
 * functions after it, so a runtime that reports the version without shipping the API gets this
 * sentence instead of a `TypeError` from the next line. `label` prefixes the line, matching the
 * seat's other stderr lines.
 */
export function assertSeatRuntime(label: string): void {
  const reason = unsupportedRuntime();
  if (!reason) return;
  process.stderr.write(
    `[${label}] fatal: unsupported_node: a Cotal seat needs Node >= ${SEAT_NODE_FLOOR}, ${reason}. ` +
      `Upgrade Node, or run the server bundle dist/mcp.cjs, which needs no compile cache.\n`,
  );
  process.exit(1);
}

/** Why this runtime cannot run a seat entry, or nothing when it can. */
function unsupportedRuntime(): string | undefined {
  const [floorMajor, floorMinor] = SEAT_NODE_FLOOR.split(".").map(Number);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < floorMajor! || (major === floorMajor && minor! < floorMinor!))
    return `this is v${process.versions.node}`;
  if (typeof enableCompileCache !== "function" || typeof flushCompileCache !== "function")
    return `v${process.versions.node} reports the version but has no module compile cache`;
  return undefined;
}

/**
 * Enable the compile cache for everything this process loads after the call.
 *
 * The directory is created the way the rest of `~/.cotal` is created, 0700 and owner-only, because
 * `enableCompileCache()` would otherwise create it at whatever the process umask allows and a
 * seat's compiled bundle belongs to one user. Node still creates its own version-keyed directory
 * inside it at the umask, and the 0700 above that is what keeps another user out.
 *
 * Neither step is allowed to end a seat. `enableCompileCache()` does not throw, it returns a
 * status, so a cache this process cannot open prints one line with the real reason and the seat
 * runs on without a cache. `label` prefixes that line.
 */
export function enableSeatCompileCache(label: string): void {
  // Node's two cache environment variables decide this before we do: `NODE_COMPILE_CACHE` enables
  // the cache in the operator's directory at startup, and `NODE_DISABLE_COMPILE_CACHE` turns it
  // off. Either way the directory below is not the one in use, so do not create it and do not
  // report on a cache this call does not own.
  if (process.env.NODE_COMPILE_CACHE || process.env.NODE_DISABLE_COMPILE_CACHE) return;
  const dir = seatCompileCacheDir();
  try {
    mkSecretDir(dir);
  } catch (e) {
    unavailable(label, (e as Error).message);
    return;
  }
  const result = enableCompileCache(dir);
  if (result.status === constants.compileCacheStatus.FAILED)
    unavailable(label, result.message ?? "no reason reported");
}

function unavailable(label: string, reason: string): void {
  process.stderr.write(`[${label}] compile cache unavailable, continuing without it: ${reason}\n`);
}

/**
 * Write the code cache this process has accumulated to disk now.
 *
 * Node flushes the cache when the instance is about to exit, and a seat is normally ended by a
 * signal, which runs no exit handler. Without this call the first seat on a new bundle would
 * compile it, die to a signal, and leave the next seat nothing to read. Node documents this call
 * for that case. It reports no errors by design: a cache write that fails must not disturb the
 * seat.
 */
export function flushSeatCompileCache(): void {
  flushCompileCache();
}

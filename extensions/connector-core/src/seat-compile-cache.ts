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
import { constants, enableCompileCache, flushCompileCache, type EnableCompileCacheResult } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

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
 * Enable the compile cache for everything this process loads after the call, and report what Node
 * decided. `label` prefixes the one diagnostic line, matching the seat's other stderr lines.
 *
 * `enableCompileCache()` does not throw: it returns a status. A cache this process cannot open is
 * not a seat failure, so FAILED prints Node's own message once and the seat runs on without a
 * cache. DISABLED means the operator set `NODE_DISABLE_COMPILE_CACHE`, which is an answer rather
 * than an error, so it says nothing.
 */
export function enableSeatCompileCache(label: string): EnableCompileCacheResult {
  const result = enableCompileCache(seatCompileCacheDir());
  if (result.status === constants.compileCacheStatus.FAILED)
    process.stderr.write(`[${label}] compile cache unavailable, continuing without it: ${result.message ?? "no reason reported"}\n`);
  return result;
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

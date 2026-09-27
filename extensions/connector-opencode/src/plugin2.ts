/**
 * The Cotal OpenCode plugin, OpenCode 2.x adapter. Loaded from the same bundle directory as the
 * 1.x factory (`plugin.ts`) — `plugin.entry.ts`'s default export carries both `server` (1.x) and
 * `setup` (this module's `setupCotal`, 2.x); the 2.x loader calls `setup(context)` only, never
 * `server`. See `fx105/measurements.md` for the measured 2.x plugin context, routes and events this
 * adapter is built against.
 *
 * Placeholder for M1 (the module split): the real port (session/model/turn hooks, tool
 * registration, event-driven presence) lands in M3. This stub keeps the identity gate and
 * single-setup-per-process guard so the directory-target bundle is loadable on a 2.x binary from
 * M1 onward, without yet driving a session.
 */
import { hasIdentity } from "@cotal-ai/connector-core";

/** Process-global guard, mirroring `plugin.ts`'s `guard.__cotalOpencodeHooks`: 2.x may call
 *  `setup` more than once per process (per location boot), and we want exactly one mesh agent. */
const guard = globalThis as { __cotalOpencodeSetup?: boolean };

/** The 2.x `setup(context)` entry point. `context` is intentionally untyped here (M1 stub); M3
 *  introduces the structural `src/opencode2-types.ts` subset and the real adapter body. */
export async function setupCotal(_ctx: unknown): Promise<(() => Promise<void>) | void> {
  if (!hasIdentity()) return; // no COTAL_* env — a plain `opencode`, stay inert (same rule as 1.x)
  if (guard.__cotalOpencodeSetup) return; // one agent; a later boot in this process is a no-op
  guard.__cotalOpencodeSetup = true;
  process.stderr.write("[cotal-connector] opencode 2.x adapter: setup stub (M3 lands the real port)\n");
}

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { clearSpaceHistory, registry, resolveAuthProvider, type AuthProvider, type CompletionResult, type ParsedArgs } from "@cotal-ai/core";
import { DELIVERY_CREDS_KEY, removeMeshesByRoot, resolveSpace, workspaceSecretStore } from "@cotal-ai/workspace";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { pidfileState, pidfileTargets } from "./down.js";

const TARGETS = ["history", "store", "all"] as const;
type Target = (typeof TARGETS)[number];

/** `cotal clean <history|store|all>` - one configurable cleanup verb.
 *   - `history`: purge the retained message backlog on the RUNNING broker (CHAT, plus DMs with
 *     `--dms`) via the least-privilege purger cred. `cotal history clear` is a thin alias.
 *   - `store`: delete the STOPPED mesh's JetStream store (`.cotal/nats` or `--store-dir`) - streams,
 *     durables, and messages. The reset for stale on-disk state (e.g. durables minted by an older,
 *     incompatible protocol generation).
 *   - `all`: `store` plus the space identity (`.cotal/auth`) and every local cred derived from it;
 *     the next `cotal up` mints a fresh identity.
 *  `history` needs the mesh UP (it is a live purge); `store`/`all` need it DOWN (files can't be
 *  deleted under a live server) and refuse loudly while any recorded process is still alive.
 *  Personas (`.cotal/agents`) are source and are never touched. */
export async function clean(args: ParsedArgs): Promise<void> {
  const target = args.positionals[0] as Target | undefined;
  const values = args.values as {
    server?: string; space?: string; creds?: string; dms?: boolean; force?: boolean; "store-dir"?: string;
  };
  if (!target || !TARGETS.includes(target)) return usage();
  if (!values.force) {
    console.error(c.red(`refusing to clean ${target} without --force`));
    console.error(c.dim(`usage: ${USAGE}`));
    process.exit(1);
  }
  if (target === "history") return purgeHistory(values);

  const root = cotalRoot();
  const running = liveMeshProcess(root);
  if (running) {
    console.error(c.red(`✗ the mesh is still running (${running}) - stop it first: \`cotal down\`, then \`cotal clean ${target}\``));
    process.exit(1);
  }
  const removed = await removeLocalState(root, { includeAuth: target === "all", storeDir: values["store-dir"] });
  // Full reset also drops the mesh from the machine registry (and the `current` pointer),
  // keyed by ROOT - see removeMeshesByRoot for why a space-name key would be wrong. A normal
  // `down` already did this; after a crash it is exactly the ghost entry to clear.
  if (target === "all") removeMeshesByRoot(root);
  if (removed.length === 0) {
    console.log(c.dim("nothing to clean - no local state found"));
    return;
  }
  for (const path of removed) console.log(c.green(`✓ removed ${path}`));
  if (target === "all") console.log(c.dim("a fresh space identity is minted on the next `cotal up`"));
}

/** The live-purge half, shared with the `cotal history clear` alias. Resolves the running mesh (from
 *  any dir) + a least-privilege PURGER cred - `--creds` is a raw off-registry connect. Purge-only and
 *  destructive, so it mints exactly the purge grant (STREAM.PURGE on CHAT + DM), not the broad
 *  operator cred. In USER MODE the purge rides a one-shot "purger" VIEW bearer, exchange-gated on
 *  ledger scope "admin" (the refusal names the exact re-grant). */
export async function purgeHistory(values: { server?: string; space?: string; creds?: string; dms?: boolean }): Promise<void> {
  const conn = await connectOrExit(values, "purger");
  const user = conn.bearer ? await userViewAuthOrExit(conn, "purger") : undefined;
  const { server, space, creds } = conn;
  const result = await clearSpaceHistory({
    servers: server,
    space,
    ...(user ? { bearer: user.bearer, sentinelCreds: user.sentinelCreds } : { creds }),
    includeDms: values.dms,
  });
  const dm = result.dm === undefined ? "" : `, ${result.dm} DM message${result.dm === 1 ? "" : "s"}`;
  console.log(c.green(`✓ cleared ${result.chat} channel message${result.chat === 1 ? "" : "s"}${dm} from "${space}"`));
}

/** The recorded mesh process still alive under this root, as a "label (pid N)" string - or
 *  undefined when everything is stopped. A stale pidfile (recorded pid no longer alive) does not
 *  block: a crashed broker must not wedge its own cleanup. Liveness rides the shared hardened
 *  probe (`pidfileState`): pid > 0 only, EPERM counts as alive. */
export function liveMeshProcess(root: string): string | undefined {
  for (const [file, label] of pidfileTargets(resolveSpace(root))) {
    const s = pidfileState(join(root, ".cotal", file));
    if (s.live) return `${label}, pid ${s.pid}`;
  }
  return undefined;
}

/** Delete the stopped mesh's local state and return what was removed (paths relative to the root).
 *  `store`: the JetStream store directory. `all` adds the space identity (`.cotal/auth`), the
 *  locally persisted creds/markers tied to it - all invalid once the identity regenerates, and
 *  re-minted by the next fresh `cotal up` - plus crash residue a normal `down` would have swept
 *  (stale pidfiles, `run/`). Callers guard liveness first (`liveMeshProcess`).
 *
 *  MIGRATED SECRET KINDS are removed through the SecretStore seam FIRST — `delivery.creds` via
 *  its workspace key, the auth kinds via the registered provider's `deprovisionSecrets` — and a
 *  failure there THROWS BEFORE any raw removal of the local identity: wiping trust/IdP/ledger
 *  after a failed store delete would leave the store's old secrets authoritative over a freshly
 *  minted identity (split authority). The store deletes are idempotent, so a failed reset re-runs
 *  as-is, with `auth.json` still present to name the space. This surface stays the LOCAL
 *  filesystem composition (hosted resets ride the closed composition's own store + the same
 *  provider hook, never a KMS mode on this CLI). */
export async function removeLocalState(root: string, opts: { includeAuth: boolean; storeDir?: string }): Promise<string[]> {
  const removed: string[] = [];
  const rm = (path: string, label: string) => {
    if (!existsSync(path)) return;
    rmSync(path, { recursive: true, force: true });
    removed.push(label);
  };
  // The space must be read before `.cotal/auth` goes - it names the auth service's pidfile
  // and keys the provider's secret deprovision.
  const space = resolveSpace(root);
  const storeDir = opts.storeDir ? resolve(opts.storeDir) : join(root, ".cotal", "nats");
  rm(storeDir, opts.storeDir ? storeDir : ".cotal/nats (JetStream store)");
  if (opts.includeAuth) {
    // ---- the seam deletes, before ANY raw identity removal (see the doc above) ----
    const store = workspaceSecretStore(root);
    const failures: string[] = [];
    try {
      if ((await store.get(DELIVERY_CREDS_KEY)) !== undefined) {
        await store.delete(DELIVERY_CREDS_KEY);
        removed.push(`.cotal/${DELIVERY_CREDS_KEY}`);
      }
    } catch (e) {
      failures.push(`${DELIVERY_CREDS_KEY}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Gate on registration: an open-mode composition may not register an auth provider, and a
    // reset there must not start failing. With one registered, its deprovision must SUCCEED
    // (absent keys are idempotent no-ops) before the identity goes.
    if (registry.all<AuthProvider>("auth-provider").length) {
      try {
        await resolveAuthProvider().deprovisionSecrets({ store, space });
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (failures.length)
      throw new Error(
        `clean all: secret-store deprovision failed (${failures.join("; ")}) - the local identity was NOT removed; the deletes are idempotent, fix the cause and re-run \`cotal clean all --force\``,
      );
    rm(join(root, ".cotal", "auth"), ".cotal/auth (space identity + creds)");
    // Creds/records signed by (or tied to) the deleted identity: stale the moment it is gone.
    // The fresh-`up` path re-mints every one of these (keep in sync with `provisionMembershipCreds`
    // in up.ts); sweeping them keeps `doctor auth` honest in between and guarantees no
    // old-operator material survives the reset. (`delivery.creds` is gone already — it is a
    // migrated kind and went through the store above, never a raw rm.)
    for (const f of [
      "manager.delivery-aware",
      "membership-observer.creds",
      "membership-rw.creds",
      "connection-evictor.creds",
      "membership.json",
      "renewal.json",
    ]) rm(join(root, ".cotal", f), `.cotal/${f}`);
    // Crash residue: after a clean `down` none of this exists; after a crash the dead pidfiles and
    // transient launch artifacts are exactly the leftovers a "full local reset" must not keep.
    for (const [file] of pidfileTargets(space)) rm(join(root, ".cotal", file), `.cotal/${file} (stale pidfile)`);
    rm(join(root, ".cotal", "run"), ".cotal/run (launch artifacts)");
  }
  return removed;
}

const USAGE =
  "cotal clean <history|store|all> --force [--dms] [--space <s>] [--server <url>] [--creds <path>] [--store-dir <dir>]";

function usage(): void {
  console.error(c.red(`usage: ${USAGE}`));
  console.error(c.dim("  history  purge the message backlog on the running broker (--dms to include DMs)"));
  console.error(c.dim("  store    delete the stopped mesh's JetStream store (.cotal/nats)"));
  console.error(c.dim("  all      store + the space identity (.cotal/auth) - full local reset"));
  process.exit(1);
}

export function cleanComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1) return { items: TARGETS.map((value) => ({ value })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

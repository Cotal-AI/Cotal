import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { clearSpaceHistory, isReachable, registry, resolveAuthProvider, type AuthProvider, type CompletionResult, type ParsedArgs } from "@cotal-ai/core";
import {
  DELIVERY_CREDS_KEY,
  MEMBERSHIP_RW_CREDS_KEY,
  acquireMaintenanceLock,
  agentSecretKeysUnder,
  cleanupRestoreFallback,
  deleteSpaceAuth,
  localProcessPath,
  meshesForRoot,
  readMaintenanceJournal,
  releaseMaintenanceLock,
  removeMeshesByRoot,
  resolveSpace,
  rollbackRestore,
  workspaceSecretStore,
  type LocalProcessContext,
} from "@cotal-ai/workspace";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { pidfileState, pidfileTargets } from "./down.js";
import { localProcessSurface } from "../ext-loader.js";

const TARGETS = ["history", "store", "all", "restore-fallback", "restore-attempt"] as const;
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
    server?: string; space?: string; creds?: string; dms?: boolean; force?: boolean; "store-dir"?: string; attempt?: string;
  };
  if (!target || !TARGETS.includes(target)) return usage();
  if (!values.force) {
    console.error(c.red(`refusing to clean ${target} without --force`));
    console.error(c.dim(`usage: ${USAGE}`));
    process.exit(1);
  }
  if (target === "history") return purgeHistory(values);
  if (target === "restore-attempt") {
    // The explicit pre-commit recovery action: roll back one exact stale attempt. A live claim
    // (deadline not elapsed, or any recorded owner alive) is always refused.
    if (!values.attempt) throw new Error("clean restore-attempt requires --attempt <id>");
    const root = cotalRoot();
    const lock = acquireMaintenanceLock(root);
    try {
      const journal = readMaintenanceJournal(root);
      if (!journal || journal.state !== "restore-ready" || journal.restore.attemptId !== values.attempt)
        throw new Error(`no pre-commit restore attempt ${values.attempt} is recorded${journal ? ` (maintenance state is ${journal.state}${"restore" in journal ? ` for attempt ${journal.restore.attemptId}` : ""})` : ""}`);
      rollbackRestore(lock);
      console.log(c.green(`✓ rolled back stale restore attempt ${values.attempt}`));
      console.log(c.dim("  the preserved source is back at ready; resume with `cotal up` or retry `cotal up --restore`"));
    } finally {
      releaseMaintenanceLock(lock);
    }
    return;
  }
  if (target === "restore-fallback") {
    if (!values.attempt) throw new Error("clean restore-fallback requires --attempt <id>");
    const root = cotalRoot();
    const lock = acquireMaintenanceLock(root);
    try {
      const record = cleanupRestoreFallback(lock, values.attempt);
      console.log(c.green(`✓ removed retained source for restore ${record.restore.attemptId}`));
    } finally {
      releaseMaintenanceLock(lock);
    }
    return;
  }

  const root = cotalRoot();
  const lock = acquireMaintenanceLock(root);
  let removed: string[];
  try {
    const maintenance = readMaintenanceJournal(root);
    if (maintenance)
      throw new Error(`clean ${target} is refused while maintenance state is ${maintenance.state}; use the recorded restore recovery or fallback-cleanup command`);
    const running = liveMeshProcess(root);
    if (running) {
      console.error(c.red(`✗ the mesh is still running (${running}) - stop it first: \`cotal down\`, then \`cotal clean ${target}\``));
      process.exitCode = 1;
      return;
    }
    for (const mesh of meshesForRoot(root)) {
      if (await isReachable(mesh.server))
        throw new Error(`clean ${target} is refused while the recorded mesh endpoint ${mesh.server} is reachable; stop the broker and verify it is offline first`);
    }
    removed = await removeLocalState(root, { includeAuth: target === "all", storeDir: values["store-dir"] });
    // Keep registry/current-pointer cleanup in the same lock transaction as local identity removal.
    if (target === "all") removeMeshesByRoot(root);
  } finally {
    releaseMaintenanceLock(lock);
  }
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
  return liveMeshProcesses(root)[0];
}

export function liveMeshProcesses(root: string): string[] {
  const context: LocalProcessContext = { root, space: resolveSpace(root) };
  const running: string[] = [];
  for (const component of localProcessSurface()) {
    const state = pidfileState(localProcessPath(component.pidFile, context));
    if (state.live) running.push(`${component.label}, pid ${state.pid}`);
  }
  return running;
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
  const store = safeStoreCleanupPath(root, opts.storeDir);
  if (store.identity) {
    removePinnedStoreDirectory(store.path, store.identity);
    removed.push(opts.storeDir ? store.path : ".cotal/nats (JetStream store)");
  }
  if (opts.includeAuth) {
    // ---- the seam deletes, before ANY raw identity removal (see the doc above) ----
    const secrets = workspaceSecretStore(root);
    const failures: string[] = [];
    for (const key of [DELIVERY_CREDS_KEY, MEMBERSHIP_RW_CREDS_KEY]) {
      // Migrated kinds: the store delete is authoritative (idempotent on an absent key). Both went
      // through `store.put` at write time and are read back through the seam, so they must be removed
      // through it too — never a raw rm below (which would leave a non-FS store's copy authoritative).
      try {
        if ((await secrets.get(key)) !== undefined) {
          await secrets.delete(key);
          removed.push(`.cotal/${key}`);
        }
      } catch (e) {
        failures.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Per-agent standing secrets (static creds / actor tokens / sentinel creds) are migrated
    // kinds too. Despawn owns the primary delete; this is the crash-residue backstop, enumerated
    // from the LOCAL creds dir (this surface IS the FS composition, per the doc above). Health
    // files and unrecognizable strays are runtime state and fall to the raw removal below.
    for (const key of agentSecretKeysUnder(root)) {
      try {
        await secrets.delete(key);
        removed.push(`.cotal/${key}`);
      } catch (e) {
        failures.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Gate on registration: an open-mode composition may not register an auth provider, and a
    // reset there must not start failing. With one registered, its deprovision must SUCCEED
    // (absent keys are idempotent no-ops) before the identity goes.
    if (registry.all<AuthProvider>("auth-provider").length) {
      try {
        await resolveAuthProvider().deprovisionSecrets({ store: secrets, space });
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (failures.length)
      throw new Error(
        `clean all: secret-store deprovision failed (${failures.join("; ")}) - the local identity was NOT removed; the deletes are idempotent, fix the cause and re-run \`cotal clean all --force\``,
      );
    // Creds/records signed by (or tied to) the space identity: stale the moment it is gone. The
    // fresh-`up` path re-mints every one of these (keep in sync with `provisionMembershipCreds` in
    // up.ts); sweeping them keeps `doctor auth` honest in between and guarantees no old-operator
    // material survives the reset. (`delivery.creds` and `membership-rw.creds` went through the store
    // above, never a raw rm.) These, the pidfiles, and `run/` are removed BEFORE the space namer, so
    // that if ANY of them fails to remove — an immutable/locked file EPERMs — auth.json is still
    // present and a re-run resolves THIS space, not the default.
    for (const f of [
      "manager.delivery-aware",
      "membership-observer.creds",
      "connection-evictor.creds",
      "membership.json",
      "renewal.json",
    ]) rm(join(root, ".cotal", f), `.cotal/${f}`);
    // Crash residue: after a clean `down` none of this exists; after a crash the dead pidfiles and
    // transient launch artifacts are exactly the leftovers a "full local reset" must not keep.
    for (const [file] of pidfileTargets(space)) rm(join(root, ".cotal", file), `.cotal/${file} (stale pidfile)`);
    rm(join(root, ".cotal", "run"), ".cotal/run (launch artifacts)");
    // The auth dir's NON-namer contents (callout, creds, server.conf, the user-auth state dir, any
    // stray) are removed BEFORE auth.json — a locked/immutable stray UNDER `.cotal/auth` throws HERE,
    // while the namer is still present, so a re-run still resolves THIS space. Removing the whole dir
    // (auth.json included) in one raw `rm` would strand a wrong-space retry if such a stray survived
    // after auth.json had already gone.
    const authDirPath = join(root, ".cotal", "auth");
    if (existsSync(authDirPath))
      for (const entry of readdirSync(authDirPath))
        if (entry !== "auth.json") rm(join(authDirPath, entry), `.cotal/auth/${entry}`);
    // The space-NAMER (`resolveSpace` above reads it) dies ABSOLUTELY LAST, as a single authoritative
    // op: the store delete is real for a non-FS store, and on the FS composition it removes the file.
    if (existsSync(join(authDirPath, "auth.json"))) removed.push(".cotal/auth/auth.json (space signer)");
    await deleteSpaceAuth(secrets);
    rmSync(authDirPath, { recursive: true, force: true }); // drop the now-empty auth dir (nothing lockable left)
  }
  return removed;
}

function pathContains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  const separator = process.platform === "win32" ? "\\" : "/";
  return path === "" || (path !== ".." && !path.startsWith(`..${separator}`) && !isAbsolute(path));
}

function safeStoreCleanupPath(root: string, override: string | undefined): { path: string; identity?: { dev: bigint; ino: bigint } } {
  const requested = resolve(override ?? join(root, ".cotal", "nats"));
  if (!existsSync(requested)) return { path: requested };
  const stat = lstatSync(requested, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`store cleanup target is not a real directory: ${requested}`);
  const target = realpathSync.native(requested);
  const canonicalRoot = realpathSync.native(root);
  const cotal = join(canonicalRoot, ".cotal");
  const defaultStore = join(cotal, "nats");
  const protectedTrees = [join(cotal, "auth"), join(cotal, "agents"), join(cotal, "maintenance"), join(cotal, "run")];
  if (target === parse(target).root || pathContains(target, canonicalRoot) || target === cotal ||
      protectedTrees.some((path) => pathContains(path, target)) || (override && pathContains(cotal, target) && target !== defaultStore))
    throw new Error(`refusing unsafe store cleanup target: ${target}`);
  if (override) {
    const generation = join(target, ".cotal-store-id");
    const jetstream = join(target, "jetstream");
    const hasGeneration = existsSync(generation) && lstatSync(generation).isFile() && !lstatSync(generation).isSymbolicLink();
    const hasJetStream = existsSync(jetstream) && lstatSync(jetstream).isDirectory() && !lstatSync(jetstream).isSymbolicLink();
    if (!hasGeneration && !hasJetStream)
      throw new Error(`refusing custom cleanup target without a Cotal or JetStream store marker: ${target}`);
  }
  return { path: target, identity: { dev: stat.dev, ino: stat.ino } };
}

function removePinnedStoreDirectory(path: string, identity: { dev: bigint; ino: bigint }): void {
  const tomb = join(dirname(path), `.cotal-clean-${randomUUID()}`);
  renameSync(path, tomb);
  const moved = lstatSync(tomb, { bigint: true });
  if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== identity.dev || moved.ino !== identity.ino) {
    if (!existsSync(path)) renameSync(tomb, path);
    throw new Error(`store cleanup target changed before deletion: ${path}`);
  }
  rmSync(tomb, { recursive: true });
}

const USAGE =
  "cotal clean <history|store|all> --force [--dms] [--space <s>] [--server <url>] [--creds <path>] [--store-dir <dir>] | cotal clean <restore-attempt|restore-fallback> --attempt <id> --force";

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

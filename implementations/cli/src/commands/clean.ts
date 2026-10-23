import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { clearSpaceHistory, isReachable, registry, resolveAuthProvider, type AuthProvider, type CompletionResult, type ParsedArgs, type SecretStore } from "@cotal-ai/core";
import {
  CommandFailure,
  DELIVERY_CREDS_KIND,
  MEMBERSHIP_CONFIG_KIND,
  MEMBERSHIP_RW_CREDS_KIND,
  segmentedKey,
  spaceMaterialDir,
  spaceSegment,
  acquireMaintenanceLock,
  agentSecretKeysUnder,
  assertSingleSpaceBroker,
  authDir,
  cleanupRestoreFallback,
  deleteSpaceAuth,
  localProcessPath,
  localMeshesForRoot,
  readMaintenanceJournal,
  releaseMaintenanceLock,
  renewalRecordPath,
  removeMeshesByRoot,
  resolveRuntimeSpace,
  resolveSpace,
  SYSTEM_CREDS_FILES,
  workspaceSecretStore,
  type LocalProcess,
  type LocalProcessContext,
} from "@cotal-ai/workspace";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { pidfileState, pidfileTargets } from "./down.js";
import { localProcessSurface } from "../ext-loader.js";
import { readStackJournal, STACK_DEFINITION } from "../lib/stack-journal.js";
import { rollbackRestoreWithBroker } from "../lib/controller-restore.js";
import { observeServiceProcess, serviceInstances } from "../lib/service-instances.js";

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
  if (!target || !TARGETS.includes(target))
    throw new CommandFailure("refused", "USAGE_INVALID", target ? `clean has no target "${target}"; it takes ${TARGETS.join(", ")}` : `clean needs a target: ${TARGETS.join(", ")}`);
  if (!values.force) throw new CommandFailure("refused", "USAGE_INVALID", `clean ${target} deletes without prompting, so it requires --force`, { remedy: `cotal clean ${target} --force` });
  if (target === "history") return purgeHistory(values);

  // Everything below acts on the SHARED broker, never one space: `store`/`all` delete the single
  // JetStream store and (for `all`) the broker trust record every account is signed under, and the
  // restore-recovery verbs roll the broker-wide preserved source back or delete it. None can be
  // scoped by a space name, so refuse on a multi-space root HERE - before any branch takes a
  // maintenance lock or touches the preserved source. Guarding only the `store`/`all` path (below)
  // left `restore-attempt`/`restore-fallback` a broker-wide bypass.
  const root = cotalRoot();
  assertSingleSpaceBroker(authDir(root), `cotal clean ${target}`);

  if (target === "restore-attempt") {
    // The explicit pre-commit recovery action: roll back one exact stale attempt. A live claim
    // (deadline not elapsed, or any recorded owner alive) is always refused.
    if (!values.attempt) throw new Error("clean restore-attempt requires --attempt <id>");
    const lock = acquireMaintenanceLock(root);
    try {
      const journal = readMaintenanceJournal(root);
      if (!journal || journal.state !== "restore-ready" || journal.restore.attemptId !== values.attempt)
        throw new Error(`no pre-commit restore attempt ${values.attempt} is recorded${journal ? ` (maintenance state is ${journal.state}${"restore" in journal ? ` for attempt ${journal.restore.attemptId}` : ""})` : ""}`);
      rollbackRestoreWithBroker(lock);
      console.log(c.green(`✓ rolled back stale restore attempt ${values.attempt}`));
      console.log(c.dim("  the preserved source is back at ready; resume with `cotal up` or retry `cotal up --restore`"));
    } finally {
      releaseMaintenanceLock(lock);
    }
    return;
  }
  if (target === "restore-fallback") {
    if (!values.attempt) throw new Error("clean restore-fallback requires --attempt <id>");
    const lock = acquireMaintenanceLock(root);
    try {
      const record = cleanupRestoreFallback(lock, values.attempt);
      console.log(c.green(`✓ removed retained source for restore ${record.restore.attemptId}`));
    } finally {
      releaseMaintenanceLock(lock);
    }
    return;
  }

  // store | all: the JetStream store delete, plus (for `all`) the space identity. The broker-wide
  // refusal already ran above, before this branch could take the lock.
  const lock = acquireMaintenanceLock(root);
  let removed: string[];
  try {
    const maintenance = readMaintenanceJournal(root);
    if (maintenance)
      throw new Error(`clean ${target} is refused while maintenance state is ${maintenance.state}; use the recorded restore recovery or fallback-cleanup command`);
    const running = liveMeshProcess(root, undefined, true);
    if (running) {
      console.error(c.red(`✗ the mesh is still running (${running}) - stop it first: \`cotal down\`, then \`cotal clean ${target}\``));
      process.exitCode = 1;
      return;
    }
    // Only this root's OWN meshes gate the wipe. A hand-registered record co-rooted here describes a
    // mesh running on another machine: it is reachable by design and is not the operator's to stop,
    // so counting it would refuse `clean` forever with an instruction nobody here can carry out.
    for (const mesh of localMeshesForRoot(root)) {
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

/** The recorded mesh process that may still be running under this root, as a "label, pid N" string -
 *  or undefined when everything is stopped. A stale pidfile (recorded pid proven dead) does not
 *  block: a crashed broker must not wedge its own cleanup. Liveness rides the shared hardened
 *  probe (`pidfileState`): pid > 0 only, EPERM counts as alive. */
export function liveMeshProcess(root: string, space?: string, settledByDown = false): string | undefined {
  return liveMeshProcesses(root, space, settledByDown)[0];
}

/**
 * The possibly running process that makes this root the mesh's HOME, or undefined.
 *
 * Not "any Cotal process here": a manager, a delivery daemon or a web dashboard under this root can
 * perfectly well be pointed at a mesh running on another machine, and their liveness says nothing
 * about who owns the record. The BROKER is the mesh — and `clearsMesh` already marks it, because it
 * is the component whose teardown drops the registry entry (`down`). Asking the same question here
 * keeps "this mesh is running here, use `cotal down`" a true statement: found live against a real
 * registry, where a dashboard watching the remote optiplex mesh made `meshes rm` refuse and point
 * at a `cotal down` that would not have stopped that mesh at all.
 *
 * The controller stack this root recorded for the same space makes it the home too. `cotal up`
 * starts that stack's members as service instances with no pidfile, and `cotal down` stops them
 * together and drops the record. A member counts here while its process may still run. One proven
 * gone without its stop receipt does not, and {@link unsettledStackMembers} names it.
 */
export function liveMeshOwner(root: string, space?: string): string | undefined {
  const context: LocalProcessContext = { root, space: space ?? resolveRuntimeSpace(root) };
  for (const component of localProcessSurface()) {
    if (!component.clearsMesh) continue;
    const running = possiblyRunning(component, context);
    if (running) return running;
  }
  return liveStackMembers(root, context.space, false)[0];
}

/** `space` names the tenant whose pidfiles to look at. Pass it whenever the caller already knows
 *  which mesh it means (a registry entry does): re-deriving it from the root can resolve a
 *  DIFFERENT tenant on a multi-space root, and the derivation throws outright on an unreadable or
 *  ambiguous one — a caller asking a yes/no liveness question should not inherit that failure.
 *  `settledByDown` is for the commands that remove the store, as {@link liveStackMembers} says. */
export function liveMeshProcesses(root: string, space?: string, settledByDown = false): string[] {
  const context: LocalProcessContext = { root, space: space ?? resolveRuntimeSpace(root) };
  const running: string[] = [];
  for (const component of localProcessSurface()) {
    const record = possiblyRunning(component, context);
    if (record) running.push(record);
  }
  return [...running, ...liveStackMembers(root, undefined, true, settledByDown)];
}

/** The members of the controller stack recorded at this root that may still run. A member counts as
 *  live unless its process is gone and its record carries the stop receipt its role requires.
 *  Backup, reset store and reset space share this rule. With `unreceipted` false, a member whose
 *  process is proven gone does not count even without its receipt, as `space forget` asks. With
 *  `settledByDown`, which reset and clean pass because they remove the store rather than keep it, a
 *  gone member also counts as stopped when the stack's last whole-stack operation is a completed
 *  `down` that recorded it already stopped: after a crash that `down` has nothing left to stop, and
 *  only a full restart could add a receipt. */
function liveStackMembers(root: string, space?: string, unreceipted = true, settledByDown = false): string[] {
  return stackMembers(root, space, settledByDown).filter((row) => !row.gone || unreceipted && !row.receipted).map((row) => `${row.label}${row.gone ? ", no stop receipt" : ""}`);
}

/** The members of the controller stack recorded at this root for `space` whose process is proven
 *  gone with no stop receipt: they can no longer run, but nothing stopped them cleanly. */
export function unsettledStackMembers(root: string, space: string): string[] {
  return stackMembers(root, space).filter((row) => row.gone && !row.receipted).map((row) => row.label);
}

/** Each instance record of the controller stack recorded at this root. The members live under the
 *  stack's own recorded space. A space derived from the root's pidfiles or accounts can name another
 *  tenant, or the default, once the stack is stopped. `space` limits the answer to that space's
 *  stack. */
function stackMembers(root: string, space?: string, settledByDown = false): { label: string; gone: boolean; receipted: boolean }[] {
  const stack = readStackJournal(root);
  if (!stack || space !== undefined && stack.journal.space !== space) return [];
  const { operation, members } = stack.journal;
  const down = settledByDown && operation.kind === "down" && operation.phase === "completed";
  return Object.values(STACK_DEFINITION).flatMap((definition) => serviceInstances(stack.journal.space, definition).map((row) => {
    const value = row.record.value;
    return {
      label: `${definition}, instance ${row.name}`,
      gone: ["gone", "previous-boot"].includes(observeServiceProcess(value)),
      receipted: value.state === "stopped" && Boolean(value.nativeStop ?? value.kernelStop ?? value.processStop)
        || down && members.some((member) => member.instanceId === row.name && member.state === "already-stopped"),
    };
  }));
}

/** "label, pid N" for a record that may still front a process, with the probe's note when it is not
 *  proven alive; undefined only for no record, an empty husk or a pid proven dead. Every caller
 *  guards a delete or a snapshot, so a record `cotal down` refuses as unattributable or of unknown
 *  liveness must not read as stopped here. */
function possiblyRunning(component: LocalProcess, context: LocalProcessContext): string | undefined {
  const state = pidfileState(localProcessPath(component.pidFile, context));
  if (state.liveness === "dead") return undefined;
  return `${component.label}, ${[state.pid && `pid ${state.pid}`, state.note].filter(Boolean).join(", ")}`;
}

/** Fixed filesystem targets shared by native identity cleanup and its read-only impact plan. */
export function localIdentityCleanupTargets(root: string, space: string) {
  const control = join(root, ".cotal");
  return {
    material: spaceMaterialDir(root, space), renewal: renewalRecordPath(root, space),
    legacy: [...SYSTEM_CREDS_FILES, MEMBERSHIP_CONFIG_KIND, "renewal.json"].map((name) => join(control, name)),
    runtime: pidfileTargets(space, root).flatMap(([path]) => [path, `${path}.identity`]),
    run: join(control, "run"), auth: authDir(root),
  };
}

export interface ReviewedIdentityCleanup {
  store: SecretStore;
  provider: AuthProvider | null;
  agentKeys: readonly string[];
  beforeRemove(path: string): void;
  afterRemove(path: string): void;
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
export async function removeLocalState(root: string, opts: { includeAuth: boolean; storeDir?: string; space?: string; expectedStore?: { path: string; identity?: { dev: bigint; ino: bigint } }; onRemoved?: (label: string) => void; identity?: ReviewedIdentityCleanup }): Promise<string[]> {
  const removed: string[] = [];
  const recordRemoved = (label: string) => { removed.push(label); opts.onRemoved?.(label); };
  const rm = (path: string, label: string) => {
    opts.identity?.beforeRemove(path);
    if (!existsSync(path)) return;
    rmSync(path, { recursive: true, force: true });
    opts.identity?.afterRemove(path);
    recordRemoved(label);
  };
  // Trust removal always derives its space from the root's local authority. A named
  // store-only reset may supply the recorded open space, which has no auth record.
  if (opts.includeAuth && opts.space !== undefined) throw new Error("identity cleanup cannot take a caller-selected space");
  const space = opts.space ?? resolveSpace(root);
  const store = safeStoreCleanupPath(root, opts.storeDir);
  if (opts.expectedStore && (store.path !== opts.expectedStore.path || Boolean(store.identity) !== Boolean(opts.expectedStore.identity) || store.identity && (store.identity.dev !== opts.expectedStore.identity?.dev || store.identity.ino !== opts.expectedStore.identity?.ino)))
    throw new Error("store path or pinned filesystem identity changed before cleanup; no directory was removed");
  if (store.identity) {
    removePinnedStoreDirectory(store.path, store.identity);
    recordRemoved(opts.storeDir ? store.path : ".cotal/nats (JetStream store)");
  }
  if (opts.includeAuth) {
    const targets = localIdentityCleanupTargets(root, space);
    // ---- the seam deletes, before ANY raw identity removal (see the doc above) ----
    const secrets = opts.identity?.store ?? workspaceSecretStore(root);
    const failures: string[] = [];
    // Both kinds are PER-SPACE as of P7 (§3.1's `(space) => key` shape), and both are swept at BOTH
    // spellings: the segmented key this space writes today, and the flat pre-P7 key, which a root
    // `up` has not re-provisioned still holds and which a hosted store re-keyed by P7 may still hold
    // too. The builders are `segmentedKey`, never the migrating resolvers — a sweep must not move
    // material into the path it is about to delete, and a §2 rule 3/4 refusal must not fail a reset
    // over material the reset does not care about.
    const p7StoreKeys = [DELIVERY_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND].flatMap((kind) => [segmentedKey(kind, space), kind]);
    for (const key of p7StoreKeys) {
      // Migrated kinds: the store delete is authoritative (idempotent on an absent key). Both went
      // through `store.put` at write time and are read back through the seam, so they must be removed
      // through it too — never a raw rm below (which would leave a non-FS store's copy authoritative).
      try {
        if ((await secrets.get(key)) !== undefined) {
          await secrets.delete(key);
          recordRemoved(`.cotal/${key}`);
        }
      } catch (e) {
        failures.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Per-agent standing secrets (static creds / actor tokens / sentinel creds) are migrated
    // kinds too, per-agent-FILE as of P1. Despawn owns the primary delete; this is the
    // crash-residue backstop, enumerated from the LOCAL creds dir (this surface IS the FS
    // composition, per the doc above). Health files and unrecognizable strays are runtime state
    // and fall to the raw removal below.
    //
    // The enumeration is ROOT-WIDE and deliberately not narrowed to `space`, the one sweep here
    // that is not: `clean all` resets THE ROOT, and P1 made a co-resident tenant's secrets a
    // sibling segment rather than a separate root — narrowing would silently start stranding
    // material this command has always removed. It is migration-free for the same reason the P7
    // sweep above is (never move material into the path you are about to delete), which is why it
    // reports both the segmented keys and the flat pre-P1 level rather than resolving through
    // `agentCredsDir`.
    for (const key of opts.identity?.agentKeys ?? agentSecretKeysUnder(root)) {
      try {
        await secrets.delete(key);
        recordRemoved(`.cotal/${key}`);
      } catch (e) {
        failures.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Gate on registration: an open-mode composition may not register an auth provider, and a
    // reset there must not start failing. With one registered, its deprovision must SUCCEED
    // (absent keys are idempotent no-ops) before the identity goes.
    const provider = opts.identity ? opts.identity.provider : registry.all<AuthProvider>("auth-provider").length ? resolveAuthProvider() : null;
    if (provider) {
      try {
        await provider.deprovisionSecrets({ store: secrets, space });
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (failures.length)
      throw new Error(
        `clean all: secret-store deprovision failed (${failures.join("; ")}) - the local identity was NOT removed; the deletes are idempotent, fix the cause and re-run \`cotal clean all --force\``,
      );
    // Creds/records signed by (or tied to) the space identity: stale the moment it is gone. The
    // fresh-`up` path re-mints every one of these; sweeping them keeps `doctor auth` honest in
    // between and guarantees no old-operator material survives the reset. These, the pidfiles, and
    // `run/` are removed BEFORE the space namer, so that if ANY of them fails to remove — an
    // immutable/locked file EPERMs — auth.json is still present and a re-run resolves THIS space,
    // not the default.
    //
    // THE PER-SPACE SEGMENT, ENTIRE (P7 §5). This space's five kinds live under
    // `.cotal/space.<hex>/`, so the reset removes the directory rather than naming its contents —
    // which is what ends this list's standing coupling to `provisionMembershipCreds` for those
    // kinds: a sixth kind added to that provisioner is swept here by construction, not by someone
    // remembering to add a literal. `delivery.creds` and `membership-rw.creds` are inside it and
    // went through the store above; the seam deletes are authoritative and their failure already
    // threw, so by here the dir holds only what a raw rm owns. On a multi-space root this removes
    // ONLY this space's segment — the other tenants' material is not this reset's to touch.
    rm(targets.material, `.cotal/${spaceSegment(space)} (this space's material)`);
    // This space's renewal record is per-space (#1850), removed with the rest of its material. The
    // LEGACY root-scoped `renewal.json` below stays in the list too: a pre-per-space build's copy
    // must not survive a full local reset either.
    rm(targets.renewal, `${relative(root, targets.renewal)} (renewal record)`);
    for (const path of targets.legacy) {
      // The LEGACY FLAT copies of the raw P7 kinds: still present on a root no post-P7 `up` has
      // touched, and this surface must not leave old-operator $SYS material behind because the
      // migration had not run yet. The $SYS pair comes from its ONE named source, shared with the
      // rotation writer, so a file added to that class can never be minted-but-not-swept.
      rm(path, relative(root, path));
    }
    // Crash residue: after a clean `down` none of this exists; after a crash the dead pidfiles and
    // transient launch artifacts are exactly the leftovers a "full local reset" must not keep.
    // Absolute paths, every spelling: the runtime records are `{space}` templates now, and the
    // delivery-aware marker rides along with them (it was a literal in the list above).
    for (const path of targets.runtime) {
      rm(path, `${relative(root, path)} (${path.endsWith(".identity") ? "stale identity pin" : "stale runtime record"})`);
    }
    rm(targets.run, ".cotal/run (launch artifacts)");
    // The auth dir's NON-namer contents (callout, creds, server.conf, the user-auth state dir, any
    // stray) are removed BEFORE the trust records — a locked/immutable stray UNDER `.cotal/auth`
    // throws HERE, while the namer is still present, so a re-run still resolves THIS space. Removing
    // the whole dir (trust records included) in one raw `rm` would strand a wrong-space retry if such
    // a stray survived after the namer had already gone. The protected set is exactly what
    // `deleteSpaceAuth` owns: the account record (the space NAMER `resolveSpace` reads), the broker
    // record, and the legacy monolith.
    const authDirPath = targets.auth;
    const trustRecord = (entry: string) => entry === "auth.json" || entry === "broker.json" || (entry.startsWith("account.") && entry.endsWith(".json"));
    if (existsSync(authDirPath))
      for (const entry of readdirSync(authDirPath))
        if (!trustRecord(entry)) rm(join(authDirPath, entry), `.cotal/auth/${entry}`);
    // The trust records — the space-NAMER last among them — die ABSOLUTELY LAST, as a single
    // authoritative op: the store delete is real for a non-FS store, and on the FS composition it
    // removes the same files.
    const trustPaths = existsSync(authDirPath) ? readdirSync(authDirPath).filter(trustRecord) : [];
    await deleteSpaceAuth(secrets, space);
    for (const entry of trustPaths) recordRemoved(`.cotal/auth/${entry} (space trust)`);
    opts.identity?.beforeRemove(authDirPath);
    rmSync(authDirPath, { recursive: true, force: true }); // drop the now-empty auth dir (nothing lockable left)
    opts.identity?.afterRemove(authDirPath);
  }
  return removed;
}

function pathContains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  const separator = process.platform === "win32" ? "\\" : "/";
  return path === "" || (path !== ".." && !path.startsWith(`..${separator}`) && !isAbsolute(path));
}

/** Inspect the same pinned local store path that the existing guarded cleanup deletes. */
export function safeStoreCleanupPath(root: string, override: string | undefined): { path: string; identity?: { dev: bigint; ino: bigint } } {
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

export function cleanComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1) return { items: TARGETS.map((value) => ({ value })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

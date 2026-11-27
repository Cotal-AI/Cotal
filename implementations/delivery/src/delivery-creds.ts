/** The delivery daemon's credential source and root: which secret store and key hold the scoped
 *  delivery cred, the daemon root it resolves from flags or the cwd, the reload identity a renewed
 *  cred is re-read through, the cred load itself (pre-minted, or `--dev-mint`) and the pidfile
 *  record. It reads nothing else of the daemon. */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  credsClaims,
  injectedSecretStoreIdentity,
  mintCreds,
  newIdentity,
  type SecretStore,
  type SecretStoreIdentity,
} from "@cotal-ai/core";
import { DELIVERY_CREDS_KIND, DELIVERY_PIDFILE, FsSecretStore, authDir, canonicalLocalProcessPath, deliveryCredsKey, findCotalRoot, isStoreIdFile, loadSpaceAuth, reclaimDeadPreUpgradeRecord, removePidPair, requireCotalRoot, segmentedKey, spaceSegment, workspaceSecretStore, writePidPair } from "@cotal-ai/workspace";

export type Values = Record<string, string | undefined>;

type CredsSource = { store: SecretStore; key: string; where: string } & (
  | { injected: true }
  | { injected: false; identity: SecretStoreIdentity }
);

/**
 * The store identity THIS daemon will re-read on `reloadCreds`. It is the same store
 * `resolveCredsStore` returns: an injected coordinate, a `--creds` file that is
 * exactly `<root>/.cotal/<spaceSegment(space)>/delivery.creds` (named as the
 * workstation root, matching the canonical arm), a `--creds` file that is not
 * that file (named as the file's own directory), or the workstation root.
 * Naming an ancestor via `findCotalRoot` would certify a two-root composition
 * as a same-store proof.
 */
export function reloadStoreIdentityOf(
  src: { injected: true; store: SecretStore } | { injected: false; identity: SecretStoreIdentity },
): SecretStoreIdentity {
  return src.injected ? injectedSecretStoreIdentity(src.store) : src.identity;
}

/**
 * Identity of the store a `--creds` file is reloaded from.
 *
 * With `--creds` the store object is deliberately FLAT (root = the file's own
 * directory, key = basename). The canonical store is `<root>/.cotal` with a
 * segmented key. Different store objects, but when `--creds` names THE FILE THE
 * MANAGER WRITES they resolve THE SAME FILE, so they are the same authority.
 * Identity names that authority, not the store object's root.
 *
 * The manager remints only `segmentedKey(DELIVERY_CREDS_KIND, space)` under
 * `<root>/.cotal`. Collapse only that exact path: basename is `delivery.creds`,
 * parent of the file dir is `.cotal`, and the file dir is `spaceSegment(space)`
 * for THIS space. Another space's segment, a decoy basename, `.cotal/auth/...`,
 * or a legacy `<root>/.cotal/delivery.creds` keep `dirname`. Never
 * `spaceFromSegment` ("a valid segment") and never `findCotalRoot`.
 */
export function reloadStoreIdentityFromCredsPath(credsPath: string, space: string): SecretStoreIdentity {
  const p = resolve(credsPath);
  const fileDir = dirname(p);
  const parent = dirname(fileDir);
  const grand = dirname(parent);
  const canonical =
    basename(p) === DELIVERY_CREDS_KIND
    && basename(parent) === ".cotal"
    && basename(fileDir) === spaceSegment(space)
    && grand !== parent;
  // Naming the store reads or creates its id file, so this cannot wait for the store to refuse the key.
  if (isStoreIdFile(canonical ? parent : fileDir, p))
    throw new Error(`delivery: --creds ${p} is the file that holds its store id; move the credential to a file of its own`);
  return canonical ? workspaceSecretStore(grand).identity : new FsSecretStore(fileDir).identity;
}

/**
 * Workstation root implied by a `--creds` path: the parent of the enclosing
 * `.cotal` directory. A path that is not under any `.cotal` tree names no
 * workstation (a flat mount, a container file) and returns undefined.
 *
 * Distinct from {@link reloadStoreIdentityFromCredsPath}, which names the
 * SecretStore the manager challenges. That identity stays the file's own
 * directory for a legacy shallow path; this helper answers a different
 * question so the cwd guard can compare two workspace roots.
 */
export function workspaceRootFromCredsPath(credsPath: string): string | undefined {
  let dir = dirname(resolve(credsPath));
  for (;;) {
    if (basename(dir) === ".cotal") {
      const root = dirname(dir);
      return root === dir ? undefined : root;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Uninjected `--creds` that names one real workstation root while process cwd
 * resolves another is a false same-store proof: membership-rw still resolves
 * via `findCotalRoot()` (cwd), not the `--creds` file. Fire only when BOTH
 * sides resolve real workstation roots and those differ. A path that is not
 * under a `.cotal` tree names no workstation, so this check does not fire
 * (the manager challenge already diverges on that composition). Injected
 * compositions skip this: both rails take the injected store. Never silently
 * prefer either root.
 */
export function assertUninjectedCredsSharesCwdRoot(opts: {
  injected: boolean;
  credsPath: string;
  cwdRoot?: string;
  /** Where `cwdRoot` came from, for the refusal: the cwd walk unless `--root` named it. */
  via?: "process cwd" | "--root";
}): void {
  if (opts.injected) return;
  const cwdRoot = opts.cwdRoot ?? findCotalRoot();
  if (!existsSync(join(cwdRoot, ".cotal"))) return;
  const credsWorkspace = workspaceRootFromCredsPath(opts.credsPath);
  if (credsWorkspace === undefined || credsWorkspace === resolve(cwdRoot)) return;
  throw new Error(
    `delivery: --creds names workstation ${credsWorkspace} while membership-rw resolves under ${cwdRoot} (${opts.via ?? "process cwd"}). Pass both the same workstation root, or inject one SecretStore.`,
  );
}

/**
 * THE ORDERING-CRITICAL HALF of the cred-source decision, split out so it cannot drift below the
 * ambient reads. With an injected store the store is the ONLY credential source: every local-source
 * flag (`--creds`, `--dev-mint`) is rejected loudly HERE, before `runDelivery` derives a space —
 * because that derivation itself reads the local signer under `--dev-mint`. A hosted composition
 * must never cross back into workstation trust material, not even for a space label, and the space
 * is now an INPUT to the key, which is exactly the pressure that would otherwise pull the
 * derivation above this check.
 */
export function assertNoLocalCredSourceFlags(v: Values, injected?: SecretStore): void {
  if (!injected) return;
  const local = ["creds", "dev-mint"].filter((f) => v[f] !== undefined);
  if (local.length)
    throw new Error(
      `delivery: ${local.map((f) => `--${f}`).join(" and ")} cannot be combined with an injected secret store — the store is the cred's only source`,
    );
}

/** The workspace root a workstation daemon serves, chosen ONCE at start (#723). `--root` names it;
 *  otherwise it is the nearest `.cotal/` above the working directory. With neither, the daemon refuses
 *  here and names where it searched: the start directory is not a root anyone set up, and reading the
 *  cred, the registry and the $SYS pair from it only failed later, after the dial, on a symptom. An
 *  injected store is the composition's only credential source, so there the root holds no trust
 *  material and a missing `.cotal/` stays allowed, as {@link recordDeliveryPid} documents. */
export function daemonRoot(v: Values, injected?: SecretStore): string {
  if (v.root !== undefined) {
    const root = resolve(v.root);
    if (!existsSync(join(root, ".cotal")))
      throw new Error(`delivery: --root ${v.root} holds no .cotal/ - name the directory that contains the workspace's .cotal/`);
    return root;
  }
  if (injected) return findCotalRoot();
  try {
    return requireCotalRoot();
  } catch (e) {
    throw new Error(`delivery: ${(e as Error).message} - run the daemon from inside its workspace, or name the root with --root <dir>`);
  }
}

/** Where the daemon's pre-minted cred lives — exactly ONE source: an injected {@link SecretStore}
 *  (a hosted composition), an explicit `--creds <file>` as an FS store over that exact file
 *  (uninjected `--creds` that names one real workstation while process cwd
 *  resolves another is refused, because membership-rw still uses
 *  `findCotalRoot`; a path that is not under any `.cotal` tree is not that
 *  case and is not refused here), or the default workstation location. `where` is the human label used
 *  in error messages so a local operator still sees a path, not an abstract key.
 *
 *  Called AFTER {@link assertNoLocalCredSourceFlags} has settled the injected/local conflict, which
 *  is what lets it take the derived `space`. The workstation arm goes through the per-kind RESOLVER:
 *  it is the reader whose "absent" answer sends `ensureDelivery` off to mint, so reading the
 *  canonical location past an unmigrated cred is how a root ends up with two live delivery creds.
 *  The injected arm builds the key without touching a filesystem it does not have. `--creds` names
 *  ONE file and is per-space by the operator's own choice of path, so it is neither segmented nor
 *  migrated — the store there is rooted at that file's own directory. */
export function resolveCredsStore(v: Values, space: string, root: string, injected?: SecretStore): CredsSource {
  if (injected) {
    const key = segmentedKey(DELIVERY_CREDS_KIND, space);
    return {
      store: injected,
      key,
      where: `secret-store key "${key}"`,
      injected: true,
    };
  }
  if (v.creds !== undefined) {
    const p = resolve(v.creds);
    return {
      store: new FsSecretStore(dirname(p)),
      key: basename(p),
      where: p,
      injected: false,
      identity: reloadStoreIdentityFromCredsPath(p, space),
    };
  }
  const key = deliveryCredsKey(space, { injected: false, root });
  const store = workspaceSecretStore(root);
  return {
    store,
    key,
    where: join(root, ".cotal", key),
    injected: false,
    identity: store.identity,
  };
}

/** The daemon's scoped `delivery` creds — the PRODUCTION path reads a PRE-MINTED cred through the
 *  {@link SecretStore} seam ({@link resolveCredsStore}; locally the CLI's `ensureDelivery` setup helper
 *  wrote it) and NEVER touches the signer: this runtime does not load `.cotal/auth`. Returned as
 *  `{ initial, source }`: the SOURCE is the D5 slice-5 class-2 reload seam — the endpoint re-invokes it
 *  at 75% of each JWT's lifetime, so the daemon renews from the renewal-owner-re-signed store entry
 *  without a restart or a signal. Adoption is IDEMPOTENT on an unchanged value while its cred is still
 *  ahead of the renewal point (explicit reload may race the backstop); past it, an unchanged value is a
 *  MISSED remint, surfaced loudly with the exact repair — never a silent ride to expiry. A standalone
 *  dev run with no stored cred can opt into `--dev-mint`, which loads the local signer and self-remints
 *  a scoped `delivery` cred (one stable identity) — LOUDLY flagged as dev-only, never the production
 *  contract. */
export async function loadDeliveryCreds(src: CredsSource, v: Values, root: string, space: string): Promise<{ initial: string; source: () => Promise<string> }> {
  const { store, key, where } = src;
  const initial = await store.get(key);
  if (initial !== undefined) {
    let last: string | undefined; // set by the FIRST source call (the endpoint's initial fetch)
    return {
      initial,
      source: async () => {
        const content = await store.get(key);
        if (content === undefined)
          throw new Error(`delivery: the scoped delivery cred is gone (${where}) — restore it (locally: re-run \`cotal up\`) before the current JWT expires`);
        if (last !== undefined && content === last) {
          // Unchanged value: adoption is IDEMPOTENT while the cred is still ahead of its renewal
          // point (the explicit reload may race the 75% backstop that just adopted the same
          // re-sign — both succeeding is correct). Past the renewal point an unchanged value is a
          // MISSED remint: fail loud with the exact repair, never a silent ride to expiry.
          const { iat, exp } = credsClaims(content);
          if (typeof exp === "number" && typeof iat === "number" && Date.now() / 1000 < iat + 0.75 * (exp - iat)) return content;
          throw new Error(`${where} still holds the previous cred — the renewal owner has not re-signed it (the manager re-signs + reloads every half-TTL); run \`cotal doctor auth --fix\`, or restart the mesh's manager, before this JWT expires`);
        }
        last = content;
        return content;
      },
    };
  }
  if (src.injected)
    throw new Error(
      `delivery: no cred in the injected secret store under key "${key}" — the hosted composition must put it before starting the daemon (local sources are never consulted when a store is injected). The key is PER-SPACE as of P7; a cred put under the bare kind "${DELIVERY_CREDS_KIND}" is not read here.`,
    );
  if (v["dev-mint"] !== undefined) {
    // The signer is the served space's own account: on a multi-space root any other choice signs
    // this daemon's cred with another tenant's authority.
    const auth = loadSpaceAuth(authDir(root), space);
    if (!auth) throw new Error(`delivery --dev-mint: no .cotal/auth for space "${space}" here to mint from`);
    console.error("⚠ delivery: --dev-mint — minting a scoped delivery cred from the LOCAL SIGNER (DEV ONLY; production mounts a pre-minted delivery.creds and the daemon never sees the signer)");
    const identity = newIdentity(); // stable across self-remints — the endpoint pins it
    const initial = await mintCreds(auth, identity, "delivery");
    return { initial, source: () => mintCreds(auth, identity, "delivery") };
  }
  throw new Error(
    `delivery: no scoped creds at ${where}. Start the space with \`cotal up\`, which mints and writes them, or pass --creds <file>; for a standalone dev run use --dev-mint.`,
  );
}

// Parsing lives in the dispatcher now, driven by the `deliver` command's declared flags.

/**
 * RECORD THIS PROCESS as the space's delivery daemon, and un-record it on a clean exit (#1528).
 *
 * The daemon writes its OWN record because it is the only participant that always knows it is
 * running. Until now `delivery.<space>.pid` was written ONLY by the CLI launcher
 * (`startDeliveryDetached`), so every other route to a live daemon — a container entrypoint,
 * systemd, an operator typing `cotal deliver --space …`, a hosted composition calling
 * {@link runDelivery} — left whatever was on disk untouched and readers believed it. A record naming
 * a pid that died days ago does not merely under-report: `down`'s `mayBeRunning` check exists to
 * fail CLOSED, so a `down --preserve-state` cut neither skips fencing a live daemon nor calls the
 * stack down around it, and a stale record supplies the proof-of-death that check requires.
 *
 * The launcher's shape is followed rather than re-invented: the CANONICAL path (never a pre-upgrade
 * name), a provably dead pre-upgrade record reclaimed first so an upgraded root never holds both
 * spellings, then the #969 identity pin beside it. The pin goes with the record on the way out.
 *
 * The removal is pid-CHECKED, like the manager's: a daemon that exits must not delete a record that
 * already belongs to its successor (a fast restart writes the new pid before the old process has
 * finished unwinding), so the record goes only while it still names this process.
 *
 * A root with no `.cotal/` is not a workstation and gets no record — a hosted composition has none,
 * and creating one here would plant a stray workspace root wherever the daemon happened to run.
 */
export function recordDeliveryPid(root: string, space: string): () => void {
  if (!existsSync(join(root, ".cotal"))) {
    console.error(`• delivery: no ${join(root, ".cotal")} here, so this daemon is not recorded in a pidfile (nothing local will find it by pid)`);
    return () => {};
  }
  const ctx = { root, space };
  reclaimDeadPreUpgradeRecord(DELIVERY_PIDFILE, ctx);
  const pidPath = canonicalLocalProcessPath(DELIVERY_PIDFILE, ctx);
  const mine = String(process.pid);
  // #969/#1238: publish the pair by rename so a later teardown never sees a torn pairing.
  writePidPair(pidPath, process.pid);
  return () => {
    try {
      removePidPair(pidPath, mine); // a successor's record is not ours to remove
    } catch {
      /* already gone, or unreadable: leaving a record we cannot prove is ours is the safe error */
    }
  };
}

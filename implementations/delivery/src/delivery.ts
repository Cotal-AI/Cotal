import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  LEASE_TTL_MS,
  accountFromCreds,
  credsClaims,
  deliveryBucket,
  dialerFor,
  idFromCreds,
  injectedSecretStoreIdentity,
  isCasLoss,
  isPermissionDenied,
  isReachable,
  leaseKey,
  mintCreds,
  newIdentity,
  parseSecretStoreIdentity,
  sameSecretStoreIdentity,
  standaloneConnectOpts,
  startTimerWriter,
  type MembershipFeedHandle,
  type ParsedArgs,
  type SecretStore,
  type SecretStoreIdentity,
  type TimerWriterHandle,
} from "@cotal-ai/core";
import { PermissionViolationError } from "@nats-io/transport-node";
import { DELIVERY_CREDS_KIND, DELIVERY_PIDFILE, FsSecretStore, authDir, canonicalLocalProcessPath, canonicalRoot, deliveryCredsKey, findCotalRoot, isStoreIdFile, isWorkspaceTargetError, loadSpaceAuth, reclaimDeadPreUpgradeRecord, removePidPair, requireCotalRoot, resolveMeshTarget, segmentedKey, soleSpaceOf, spaceSegment, workspaceSecretStore, writePidPair, type MeshTarget } from "@cotal-ai/workspace";
import { startMembership } from "./membership.js";
import { mayServeOn, leaseAction, type LeaseReading } from "./watchdog.js";
import { DeliveryTransportHealth } from "./transport-health.js";
import { executeEviction, executeEvictions, executePlaneLiveness, executePrincipalLiveness, validateScanTargetAdmission, type ScanTarget } from "./evict-exec.js";
import type { HostedContextInputs, HostedServiceHandle, HostedServiceState } from "@cotal-ai/workspace";

type Values = Record<string, string | undefined>;

/** Re-exported for hosted compositions: the daemon cred's KIND, and the builder that turns it into
 *  the {@link SecretStore} key for a space. Defined once in workspace (the layout is the workspace's)
 *  so the writer, the renewal owner, and this reader can never drift apart. As of P7 the kind is NOT
 *  the key — the key is per-space — so a hosted store must be keyed with the builder; the flat kind
 *  is the pre-P7 key and putting there leaves this daemon reading an empty location. */
export { DELIVERY_CREDS_KIND, deliveryCredsKey };

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
function assertNoLocalCredSourceFlags(v: Values, injected?: SecretStore): void {
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
function daemonRoot(v: Values, injected?: SecretStore): string {
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
function resolveCredsStore(v: Values, space: string, root: string, injected?: SecretStore): CredsSource {
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
async function loadDeliveryCreds(src: CredsSource, v: Values, root: string): Promise<{ initial: string; source: () => Promise<string> }> {
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
    // Space-blind dev path: the root must name exactly one space (soleSpaceOf fails loud on several).
    const devRoot = authDir(root);
    const devSpace = soleSpaceOf(devRoot);
    const auth = devSpace ? loadSpaceAuth(devRoot, devSpace) : undefined;
    if (!auth) throw new Error("delivery --dev-mint: no .cotal/auth here to mint from");
    console.error("⚠ delivery: --dev-mint — minting a scoped delivery cred from the LOCAL SIGNER (DEV ONLY; production mounts a pre-minted delivery.creds and the daemon never sees the signer)");
    const identity = newIdentity(); // stable across self-remints — the endpoint pins it
    const initial = await mintCreds(auth, identity, "delivery");
    return { initial, source: () => mintCreds(auth, identity, "delivery") };
  }
  throw new Error(
    `delivery: no scoped creds at ${where}. Launch via \`cotal setup\`/\`cotal go\` (the setup helper mints + writes it), or pass --creds <file>; for a standalone dev run use --dev-mint.`,
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
 * a pid that died days ago does not merely under-report: `down`'s `mayBeRunning` guard exists to
 * fail CLOSED so `cotal down nats` cannot pull the broker out from under a live dependant, and a
 * stale record supplies exactly the proof-of-death that guard requires.
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

/**
 * Run the delivery daemon: the server-side Plane-3 durable backstop. A thin composition root that
 * builds a scoped `delivery` endpoint, acquires the single-flight lease, and runs the existing
 * Plane-3 loops (`startPlane3`) — which ALSO serve the `ctl.delivery` runtime durable join/leave/list
 * ops. Runs from a PRE-MINTED scoped `delivery` cred and a `--space`; it does NOT load `.cotal/auth`
 * (no signer in the daemon's trust boundary) — minting is the CLI setup helper's job (or `--dev-mint`
 * for standalone dev). N=1 only — `shards > 1` (or a non-zero shard) is HARD-REJECTED (the partition
 * seam ships, operating sharded delivery is deferred to the channel-prefix grammar; see core-sub-fabric.md).
 *
 * `store` is the hosted-composition seam: a closed composition root calls this export directly and
 * injects its own {@link SecretStore} (KMS/Vault…) holding the daemon cred under
 * {@link deliveryCredsKey}`(space, …)` AND the membership feed's rw cred under the matching
 * `membership-rw.creds` key — both PER-SPACE as of P7, so the bare kinds are the pre-P7 spelling and
 * are not read; the registered `deliver` command passes none and gets the workstation FS store (or
 * `--creds`). The
 * renewal owner's write side (`remintDaemonCreds`) is threaded through the manager's
 * `ManagerOptions.secretStore` too, so a hosted composition renews both daemon kinds end-to-end when
 * the manager and this daemon are handed the SAME store.
 */
export async function runDelivery(args: ParsedArgs, store?: SecretStore): Promise<void> {
  // A START-UP FAILURE AFTER THE ACQUIRE MUST GIVE THE SHARD BACK, INCLUDING WHEN THE CALLER
  // CATCHES IT. `runDelivery` is awaited inside the CLI dispatcher's own try/catch, so a rejection
  // out of start-up is an ordinary handled error: the process prints one line and exits 1 while the
  // lease row still claims the shard for the rest of the 30s bucket TTL, and the next `cotal up` is
  // refused. That is this issue's outage reached without any signal, starvation or broker fault.
  //
  // The release therefore hangs off the REJECTION rather than off a process event. `runStartedDelivery`
  // publishes its own releaser once the shard is actually ours, so before the acquire there is nothing
  // to give back and this catch re-throws untouched.
  //
  // THE FAULT STAYS A FAULT. This never swallows: the original error is re-thrown after the release,
  // so the CLI prints the same line and exits with the same non-zero code it would have without any
  // of this. Cleaning up a lease must not turn a start-up failure into a quiet one.
  let releaseOnStartupFailure: (() => Promise<void>) | undefined;
  try {
    await runStartedDelivery(args, store, (r) => { releaseOnStartupFailure = r; });
  } catch (e) {
    if (releaseOnStartupFailure !== undefined) {
      console.error(`\u2717 delivery: start-up failed - releasing the shard before exiting`);
      try { await releaseOnStartupFailure(); } catch { /* the throw below is the report */ }
    }
    throw e;
  }
  await new Promise<void>(() => {}); // CLI runs until signalled
}

/** Start one independently owned delivery context. No cwd, process signal, pidfile, or exit
 * policy is borrowed from the CLI runner. The caller owns its explicit state path and store. */
export async function startDeliveryService(inputs: HostedContextInputs): Promise<HostedServiceHandle> {
  if (!inputs.context.accountPublicKey || !inputs.context.lifecycleUid || !inputs.space || !inputs.servers || !inputs.stateDir)
    throw new Error("delivery: hosted context needs an account, lifecycle, space, server and stateDir");
  if (inputs.store.identity === undefined)
    throw new Error("delivery: hosted SecretStore must declare a stable identity");
  const actual = parseSecretStoreIdentity(inputs.store.identity);
  if (!sameSecretStoreIdentity(actual, inputs.storeIdentity) || actual.kind !== "injected")
    throw new Error("delivery: hosted SecretStore identity does not match the assigned store identity");
  let releaseOnStartupFailure: (() => Promise<void>) | undefined;
  try {
    const started = await runStartedDelivery(
      { values: { space: inputs.space, server: inputs.servers }, positionals: [], raw: [] } as ParsedArgs,
      inputs.store,
      (release) => { releaseOnStartupFailure = release; },
      inputs,
    );
    return {
      readiness: (): HostedServiceState => ({ ...started.status(), context: inputs.context }),
      drain: started.close,
      close: started.close,
    };
  } catch (error) {
    // The start-up fault is the report; a row the release left behind is the bucket TTL's to expire.
    await releaseOnStartupFailure?.().catch((e: Error) => console.error(`! ${e.message}`));
    throw error;
  }
}

type DeliveryStatus = { state: "ready" | "draining" } | { state: "unavailable"; cause: string };

/** Both entries get the same result, so a start-up path that hands back nothing fails to compile.
 * The hosted entry stamps the status with its context; the CLI runner owns its own wait. */
async function runStartedDelivery(
  args: ParsedArgs,
  store: SecretStore | undefined,
  publishReleaser: (release: () => Promise<void>) => void,
  hosted?: HostedContextInputs,
): Promise<{ status(): DeliveryStatus; close(): Promise<void> }> {
  const v = args.values as Values;
  const shard = v.shard ? Number(v.shard) : 0;
  const shards = v.shards ? Number(v.shards) : 1;
  if (shards !== 1 || shard !== 0)
    throw new Error(
      `delivery: sharded operation is not supported (N=1 only; got shard=${shard} shards=${shards}). ` +
        "The partition() seam ships but operating shards>1 needs the channel-prefix grammar — see core-sub-fabric.md.",
    );

  // Reject local-source flags FIRST — before the ambient space derivation below — so an injected
  // store can never reach the workstation signer. The cred KEY is per-space as of P7, so resolving
  // the source now needs the space that this check must precede; the check is therefore split out
  // and stays here, ahead of everything ambient.
  assertNoLocalCredSourceFlags(v, store);
  // Every workstation read below (cred, registry, $SYS pair, membership feed, pidfile) uses this one
  // root. A hosted context names its own state directory and borrows no cwd.
  const root = hosted?.stateDir ?? daemonRoot(v, store);

  // Space comes from --space (the CLI passes it). Only --dev-mint may derive it from the local signer.
  const space = v.space ?? (v["dev-mint"] !== undefined ? soleSpaceOf(authDir(root)) : undefined);
  if (!space) throw new Error("delivery: --space is required (the scoped creds file does not encode it)");
  const credsSrc = resolveCredsStore(v, space, root, store);
  if (v.creds !== undefined)
    assertUninjectedCredsSharesCwdRoot({ injected: credsSrc.injected, credsPath: resolve(v.creds), cwdRoot: root, via: v.root !== undefined ? "--root" : "process cwd" });
  const creds = await loadDeliveryCreds(credsSrc, v, root); // pre-minted scoped cred; NO signer/loadSpaceAuth in this path
  if (hosted !== undefined && accountFromCreds(creds.initial) !== hosted.context.accountPublicKey)
    throw new Error("delivery: scoped credential account does not match the assigned hosted context");
  let latestCreds = creds.initial; // freshest renewal — the broker-reachability poll below presents it

  // WHICH BROKER, WORKSTATION COMPOSITION (#756, the deliver half). `cotal ps`/`spawn`/`attach`/
  // `status`/`supervise` all resolve the registered mesh for the space/root and dial its broker;
  // this daemon alone took `v.server ?? DEFAULT_SERVER`, so a registered space whose record names
  // a non-default broker was dialed at the loopback default, and the refusal then named that wrong
  // URL with the wrong remedy. Mirrors `superviseTarget` (manager/commands.ts): the record is the
  // broker authority, an explicit `--server` may repeat it but never silently override it, and the
  // recorded TLS requirement rides along (see the TLS block below for why a downgrade repeats on
  // every reconnect). A resolver error because NOTHING is recorded for the space keeps today's
  // bare default: scratch suites, standalone dev runs and hosted compositions register nothing and
  // must not change. Any other resolver error propagates. An INJECTED store never consults the
  // registry at all: the hosted daemon learns everything from argv and the store (the launcher
  // comment in cli delivery-proc.ts), and coupling it to a workstation artifact it may not have
  // would break the composition it exists for.
  let server = v.server ?? DEFAULT_SERVER;
  let registered: MeshTarget | undefined;
  if (store === undefined) {
    try {
      registered = resolveMeshTarget(root, { space });
    } catch (error) {
      // `unknown-space` is the no-record-for-that-space case: the bare default above stands. A
      // corrupt/ambiguous record stays its own loud error rather than a silent loopback dial.
      if (!isWorkspaceTargetError(error) || error.code !== "unknown-space") throw error;
    }
    if (registered !== undefined) {
      // The resolution moves the BROKER to the record while creds and the $SYS scan target stay on
      // the daemon's own root, so a record for another root would serve this root's tenant material
      // against another tenant's broker — the silent wrong-mesh outcome the registry exists to
      // prevent. Refuse before any dial, naming both roots (canonicalRoot-wise, the rule
      // meshesForRoot states: a raw `===` silently misses differently-spelled roots).
      if (canonicalRoot(registered.root) !== canonicalRoot(root))
        throw new Error(
          `delivery: space "${space}" is registered for root ${registered.root} but this daemon serves root ${root} - the recorded broker belongs to another workspace; run the daemon from that root, or re-register with \`cotal meshes add\``,
        );
      if (v.server !== undefined && v.server !== registered.server)
        throw new Error(
          `--server ${v.server} does not match registered space "${space}" at ${registered.server} - deliver refuses to use a different broker than the meshes entry`,
        );
      server = registered.server;
    }
  }

  // REQUIRE TLS when the operator said to, and when the record the server came from demands it
  // (same rule as an explicit `--tls`). This daemon holds a STANDING credential and reconnects
  // unattended, so a downgrade here is not a one-shot exposure like a human running `cotal status`
  // - it is repeated, on every reconnect, with nobody watching. `tls: true` makes the client refuse
  // rather than fall back, which is the only behaviour that survives a forged plaintext INFO.
  // Boolean flags arrive as presence in this Values map (`Record<string, string | undefined>`),
  // matching how `--dev-mint` is read below. Comparing to `true` would silently never match.
  const tls = v.tls !== undefined || registered?.tlsRequired === true;
  // SAY THE DIAL TARGET before anything can refuse on it, in every workstation shape: an operator
  // (and a cell) can then assert WHAT the daemon dialed even when the default port is live on the
  // host and the run gets past the reachability refusal. The hosted (injected-store) daemon learns
  // its target from argv and stays silent here.
  if (store === undefined)
    console.error(
      registered !== undefined
        ? `• delivery: space "${space}" is registered at ${server} (meshes entry) - dialing it${tls ? " with TLS required" : ""}`
        : `• delivery: no meshes entry for "${space}" - dialing ${server}${v.server !== undefined ? " (--server)" : " (the local default)"}${tls ? " with TLS required" : ""}`,
    );
  if (!(await isReachable(server, { creds: latestCreds, ...(tls ? { tls: true } : {}) }))) {
    // The refusal names the URL actually dialed, and — when that URL came from a registry record —
    // the remedy that fits the record's origin, in the same wording render.ts uses for preflight
    // `unreachable`: an `up` record is THIS machine's mesh and `cotal up` restarts it; a `manual`
    // record is a broker elsewhere that only its own operator can start, so `Run: cotal up` here
    // would prescribe starting a DIFFERENT, local mesh under that name.
    if (registered !== undefined) {
      console.error(
        registered.origin === "manual" || registered.origin === "catalog"
          ? `✗ delivery: no broker answered at ${server} - "${space}" is registered here but its mesh is not up; start it where it runs, or \`cotal meshes rm ${space}\` to unregister it`
          : `✗ delivery: no mesh running at ${server} - mesh "${space}" is recorded at ${registered.root} but not running; run \`cotal up\` there to restart`,
      );
      if (hosted !== undefined) throw new Error(`delivery: no broker answered at ${server}`);
      process.exit(1);
    }
    console.error(`✗ delivery: can't reach NATS at ${server}. Run: cotal up`);
    if (hosted !== undefined) throw new Error(`delivery: can't reach NATS at ${server}`);
    process.exit(1);
  }

  // PIN THE SCAN TARGET ONCE, HERE. The $SYS sweeps below resolve an ACCOUNT, and a complete sweep
  // of the WRONG account is indistinguishable from "the principal is gone" — a healthy-looking
  // answer that authorizes eviction and gate reconciliation. Resolving the root per request from
  // `process.cwd()` let that drift; and a daemon started in a foreign mesh root would sweep a
  // foreign tenant while looking entirely well. So: the root is fixed at start, and the OBSERVER
  // CRED is cross-checked against the account this daemon's OWN credential authenticates as — two
  // facts, neither of which comes from that root, which is what makes it an independent check.
  // The $SYS pair resolves through the SAME injected store, so a hosted composition needs no
  // `.cotal/` file for it. `injected` is this composition root's own fact — recorded here, where it
  // is known for certain, rather than inferred later by probing the store or sniffing the
  // filesystem, both of which report "workstation" for a hosted daemon and would emit a CLI repair
  // the host cannot run. It selects the REPAIR IDIOM only; failure semantics never fork on it.
  const scanTarget: ScanTarget = {
    root,
    named: v.root !== undefined,
    expectedAccount: accountFromCreds(creds.initial),
    source: store === undefined
      ? { secrets: workspaceSecretStore(root), space, injected: false, root }
      : { secrets: store, space, injected: true },
  };
  // The singleton lease is admission to serve this space, so the daemon must prove its scan tenancy
  // before it can claim that slot. A wrong-root process previously acquired and renewed lease.0,
  // then refused every admin-rail request on the account mismatch while blocking the valid daemon.
  await validateScanTargetAdmission(scanTarget);
  console.error(`• delivery: $SYS sweeps bound to ${join(scanTarget.root, ".cotal")} (account ${scanTarget.expectedAccount})`);
  const reloadStoreIdentity = reloadStoreIdentityOf(credsSrc);
  // THIS daemon's connection nkey, pinned once. It is what the endpoint AUTHENTICATES as, and it is
  // what `card.id` must carry at construction (a creds SOURCE has no cred to derive it from yet).
  // It is NOT what the lease record carries as `holder`, see readOwnLease, which compares against
  // `ep.card.id`, the value the endpoint actually stamps.
  const ownId = idFromCreds(creds.initial);

  const ep = new CotalEndpoint({
    space,
    servers: server,
    ...(tls ? { tls: true } : {}),
    // The RELOAD seam (D5 slice 5 class 2): the endpoint re-invokes the source at 75% of each JWT's
    // lifetime and swaps the connection onto the re-signed file — bounded delivery creds renew with
    // no daemon restart. The explicit card.id pins the daemon's nkey across renewals.
    creds: async () => (latestCreds = await creds.source()),
    channels: [],
    consume: false, // it pulls the Plane-3 consumers itself; no agent live-tail
    watchPresence: true, // read the roster for @mention resolution …
    registerPresence: false, // … but NEVER publish the daemon onto the roster (it's infra, not a peer)
    card: { id: ownId, name: "delivery", role: "delivery", kind: "endpoint" },
    transportPingIntervalMs: Number(process.env.COTAL_DELIVERY_PING_INTERVAL_MS) || 2500,
    transportMaxPingOut: Number(process.env.COTAL_DELIVERY_MAX_PING_OUT) || 2,
  });
  // Both channels: raw connection errors ride `error`, while every condition the endpoint is
  // already surviving — a failed 75% renewal, the passive backstop's "still holds the previous
  // cred" repair line — rides `warning` (#891). An operator who only sees the first watches the
  // daemon go silent and then die at `exp` with no word of the remint it was waiting for.
  const say = (e: Error) => console.error(`! delivery endpoint: ${e.message}`);
  ep.on("error", say);
  ep.on("warning", say);
  try { await ep.start(); }
  catch (error) { await ep.stop(); throw error; }

  const BROKER_GONE_MS = Number(process.env.COTAL_DELIVERY_BROKER_GONE_MS) || 15_000;
  const BROKER_GONE_BACKSTOP_MS = Math.max(
    BROKER_GONE_MS,
    Number(process.env.COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS) || BROKER_GONE_MS * 4,
  );
  let stopHandler: ((code: number, cause?: string) => void) | undefined;
  let hostedStartupFailure: Error | undefined;
  let stopHosted: ((cause: string) => void) | undefined;
  const health = new DeliveryTransportHealth(
    (reason) => {
      console.error(
        reason === "credential-expired"
          ? "✗ delivery: credential expired without renewal"
          : reason === "backstop"
            ? "✗ delivery: broker connection unavailable past backstop (broker unreachable), exiting (coupled to the broker)"
            : "✗ delivery: broker connection unavailable (broker unreachable), exiting (coupled to the broker)",
      );
      const cause = reason === "credential-expired" ? "credential expired without renewal" : `broker connection unavailable (${reason})`;
      if (hosted !== undefined) {
        hostedStartupFailure ??= new Error(`delivery context stopped during startup: ${cause}`);
        if (stopHosted !== undefined) stopHosted(cause);
        else void ep.stop(); // before lease acquisition, no context-owned lease can be released
        return;
      }
      if (stopHandler !== undefined) stopHandler(1, cause);
      else earlyStop(1);
    },
    () => console.error("! delivery: credential expired, awaiting proved renewal"),
    BROKER_GONE_MS,
    BROKER_GONE_BACKSTOP_MS,
  );
  // close() reads these to tell a lease read lost with a dropped socket from one the broker did not answer.
  let transportUp = true;
  let transportGeneration = 0;
  ep.on("transport", ({ connected }: { connected: boolean }) => {
    health.transport(connected);
    transportUp = connected;
    if (connected) transportGeneration++;
  });
  ep.on("error", (e: Error) => {
    if (e.name === "UserAuthenticationExpiredError" || (e as { cause?: { name?: string } }).cause?.name === "UserAuthenticationExpiredError") {
      health.credentialExpired();
    }
  });
  ep.on("creds-adopted", () => {
    health.adopted();
  });

  // Acquire the single-flight lease BEFORE binding the loops: a loud refusal-to-bind if another daemon
  // already holds this shard (two clients binding the same durable name SPLIT delivery). The bucket TTL
  // frees a crashed holder's lease so a fresh daemon re-acquires.
  // THE REVISION THIS PROCESS OWNS, or `undefined` once it knows it does not own the row any more.
  // `releaseDeliveryLease` takes it as a compare-and-swap, so a shutdown that no longer holds the
  // shard releases NOTHING rather than deleting whatever row is there. The exits where that matters
  // are exactly the takeover exits below: without it, the departing daemon removes the REPLACEMENT's
  // lease on its way out and leaves the shard with no holder at all.
  let revision: number | undefined;
  try {
    revision = await ep.acquireDeliveryLease(shard);
  } catch (e) {
    if (isCasLoss(e)) {
      console.error(`✗ delivery: a live lease already exists for shard ${shard} — another delivery daemon is running. Not binding.`);
    } else if (isPermissionDenied(e)) {
      const typed = e instanceof PermissionViolationError
        ? e
        : (e as { cause?: unknown } | null)?.cause instanceof PermissionViolationError
          ? (e as { cause: PermissionViolationError }).cause
          : undefined;
      const refused = typed
        ? `${typed.operation} "${typed.subject}"`
        : (e as Error).message;
      console.error(
        `✗ delivery: the lease write for shard ${shard} was refused (${refused}) — this credential ` +
          `cannot write ${deliveryBucket(space)}.${leaseKey(shard)}. Not binding. Use a credential ` +
          `holding the "delivery" profile.`,
      );
    } else {
      console.error(`✗ delivery: acquiring the lease for shard ${shard} failed: ${(e as Error).message}. Not binding.`);
    }
    await ep.stop();
    if (hosted !== undefined) throw e;
    process.exit(1);
  }

  // SIGNAL HANDLING IS ARMED HERE, THE STATEMENT AFTER THE SHARD BECOMES OURS, not at the end of
  // start-up, and not merely before the readiness flip. From this line on there is a row on the
  // broker with this daemon's name on it, and every instant until a handler exists is an instant in
  // which SIGTERM takes Node's DEFAULT action: immediate death, no release, the shard claimed by a
  // process that no longer exists for the rest of the 30s bucket TTL. The next `cotal up` is then
  // refused outright with "a live lease already exists".
  //
  // THE WINDOW WAS REACHABLE FROM THE PUBLIC CLI, and reviewers reproduced it deterministically:
  // SIGTERM at the instant the lease row turns ready killed the daemon 6/6 times with the row left
  // behind and a real replacement refused, while the same signal 1500ms later released cleanly 2/2.
  // Registration used to sit ~460 lines below, past the readiness flip and the awaited membership
  // and timer-writer starts, so `cotal up` could return on a ready row while the daemon was still
  // defenceless. Moving it merely below `shutdown`'s own definition is NOT enough: that still sits
  // after markReady and after `startMembership`.
  //
  // The handler cannot call `shutdown` (defined far below, over state that does not exist yet), so
  // it does the one thing that is always correct here and never wrong later: give the lease back if
  // it is provably ours, then exit. Once the real `shutdown` is installed it REPLACES this, and
  // `stopping` makes the pair idempotent, so a signal arriving mid-swap cannot run both.
  let stopping = false;
  let unavailable: string | undefined;
  let closePromise: Promise<void> | undefined;
  let membership: MembershipFeedHandle | undefined;
  let timerWriter: { handle: TimerWriterHandle; nc: Awaited<ReturnType<ReturnType<typeof dialerFor>>> } | undefined;
  let timerWriterAttempt: Promise<void> | undefined;
  let stopLeaseWatch: (() => void) | undefined;
  let renew: ReturnType<typeof setInterval> | undefined;
  /** Removes THIS process's liveness record, once it has one. Declared BEFORE the handlers that
   *  call it and assigned below, so a signal landing between the two is a no-op rather than a
   *  temporal-dead-zone throw: at that instant nothing has been written, so there is nothing to
   *  remove. Every exit path from the acquire onward goes through one of the three closures that
   *  call it, which is what keeps the record's lifetime equal to this daemon's. */
  let unrecordPid: (() => void) | undefined;
  const earlyStop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    health.stop();
    setTimeout(() => process.exit(code), 2000);
    unrecordPid?.();
    void (async () => {
      try {
        const own = await ep.readDeliveryLeaseEntry(shard);
        if (own !== undefined && ep.ownsDeliveryLease(own.info)) await ep.releaseDeliveryLease(shard, own.revision);
      } catch { /* broker may be gone, the bucket TTL is the crash-safe release authority */ }
      try { await ep.stop(); } catch { /* broker may be gone */ }
      process.exit(code);
    })();
  };
  stopHandler = earlyStop;
  // A SIGNALLED STOP NAMES ITSELF BEFORE TEARDOWN (#1443). Every other deliberate exit writes its
  // reason first; without this line a `cotal down`, a systemd stop or Ctrl-C left the log ending on
  // routine work, which an operator cannot tell from a silent death.
  const onSignal = (signal: NodeJS.Signals, stop: (code: number) => void) => (): void => {
    console.error(`• delivery: received ${signal}, exiting (space ${space}, shard ${shard})`);
    stop(0);
  };
  const earlySigint = onSignal("SIGINT", earlyStop);
  const earlySigterm = onSignal("SIGTERM", earlyStop);
  if (hosted === undefined) {
    process.on("SIGINT", earlySigint);
    process.on("SIGTERM", earlySigterm);
  }
  // THE LIVENESS RECORD GOES HERE, AFTER THE ACQUIRE AND NOT BEFORE IT (#1528).
  //
  // The record answers "which process is this space's delivery daemon", and until this line this
  // process cannot answer it: the lease is the single-flight admission, and a daemon that loses the
  // CAS above REFUSES TO BIND and exits. Writing on entry would let such a loser overwrite the live
  // holder's record on its way out the door — a fresh record naming a process that is about to be
  // gone, which is the same lie this issue is about with a newer timestamp on it. The acquire is
  // the first instant the answer is this process, so it is the first instant the record may say so.
  //
  // It is also written BEFORE `startPlane3`, deliberately: from the acquire onward there is a row on
  // the broker with this daemon's name on it, so an operator's `cotal down` must be able to FIND
  // this process even if the bind below hangs or fails. Readiness is a separate fact and the lease's
  // own `ready` flag already carries it; the pidfile only ever claimed a process.
  //
  // Placed one statement after the signal handlers, so every exit path from here on can remove it.
  if (hosted === undefined) unrecordPid = recordDeliveryPid(root, space);
  // AND THE SAME RELEASE, REACHABLE BY AN ORDINARY `catch`. The two process-level guards below
  // only see a fault that reaches the RUNTIME. A start-up rejection on the public CLI path does
  // not: `runCli` awaits this function inside its own try/catch (cli/src/command.ts), so the
  // rejection is HANDLED, `unhandledRejection` never fires, and the process exits 1 through the
  // CLI's own error line with the shard still claimed. A reviewer reproduced exactly that against
  // a real broker by pre-creating a conflicting fan-out durable so `startPlane3` rejects after the
  // acquire: exit 1, row still on the broker, replacement refused with "a live lease already
  // exists". So the release is published HERE, to a scope that a plain `catch` around the rest of
  // start-up can reach, and the process guards stay as the backstop for faults that never become
  // a rejection this function can see (a synchronous throw in a timer, say).
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    stopping = true;
    if (renew !== undefined) clearInterval(renew);
    health.stop();
    stopLeaseWatch?.();
    unrecordPid?.();
    closePromise = (async () => {
      try { await ep.quiescePlane3(); } catch { /* stop still releases the connection */ }
      // `releaseDeliveryLease` swallows a delete that did not commit, so the row the broker holds
      // afterwards is the verdict: while one is there, a successor is refused.
      const release = async () => {
        const own = await ep.readDeliveryLeaseEntry(shard);
        if (own !== undefined && ep.ownsDeliveryLease(own.info)) await ep.releaseDeliveryLease(shard, own.revision);
        return ep.readDeliveryLeaseEntry(shard);
      };
      let left: Awaited<ReturnType<typeof ep.readDeliveryLeaseEntry>>;
      try {
        // nats.js never answers a request written to a socket that dropped, nor one buffered while it
        // was down (each dial discards the buffer), even once the same connection reconnects. Such a
        // timeout says nothing about the broker, so one attempt on the reconnected transport decides.
        // A transport still down is waited for as long as a serving daemon waits for its broker.
        const generation = transportGeneration;
        left = await release().catch(async (e) => {
          if (!transportUp) await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); ep.off("transport", onTransport); resolve(); };
            const onTransport = ({ connected }: { connected: boolean }) => { if (connected) done(); };
            const timer = setTimeout(done, BROKER_GONE_MS);
            ep.on("transport", onTransport);
          });
          if (!transportUp || transportGeneration === generation) throw e;
          return release();
        });
      } catch (e) {
        throw new Error(`delivery: the lease release for shard ${shard} could not be confirmed (${(e as Error).message}); the bucket TTL expires a row left behind`, { cause: e });
      } finally {
        try { await membership?.stop(); } catch { /* broker may be gone */ }
        try { await timerWriter?.handle.stop(); } catch { /* broker may be gone */ }
        try { await Promise.race([timerWriter?.nc.drain(), new Promise((r) => setTimeout(r, 1000))]); } catch { /* broker may be gone */ }
        try { await timerWriterAttempt; } catch { /* startup or broker fault */ }
        try { await ep.stop(); } catch { /* broker may be gone */ }
      }
      if (left !== undefined)
        throw new Error(`delivery: the lease for shard ${shard} is still held by ${ep.ownsDeliveryLease(left.info) ? "this instance" : left.info.holder} after close`);
    })();
    return closePromise;
  };
  publishReleaser(close);
  stopHosted = (cause) => {
    unavailable = `delivery context stopped (code 1): ${cause}`;
    // A later close() returns this same promise, so its failure still reaches the host.
    close().catch(() => {});
  };
  if (hostedStartupFailure !== undefined) throw hostedStartupFailure;
  // A START-UP FAILURE AFTER THE ACQUIRE MUST ALSO GIVE THE SHARD BACK. Between this point and the
  // handler swap far below, a throw would otherwise propagate out of `runDelivery` with the row
  // still claiming the shard, stranding it for the bucket TTL exactly as an unhandled signal did -
  // a different door into the same outage. So the release happens HERE, where the failure is,
  // rather than being trusted to a caller that may not have one.
  //
  // THE FAULT STAYS LOUD, AND STAYS A FAULT. These guards change WHEN the process dies, never
  // whether it reports why: the original error is printed with its stack, as Node's default handler
  // would, and the exit code is non-zero. Cleaning up a lease must not turn a crash into a quiet
  // stop - that would trade this issue's outage for a silent one.
  //
  // DISARMED BEFORE THEY CAN RECURSE. `earlyStop`'s own async body can itself reject (the broker may
  // be mid-teardown), which would re-enter these listeners while cleanup is in flight. They are
  // removed on first use, so a cleanup fault falls through to the default handler and the 2s
  // hard-exit timer remains the backstop. `stopping` already makes a second entry a no-op; this
  // makes the recursion impossible rather than merely harmless.
  const earlyFault = (what: string, err: unknown): void => {
    process.off("uncaughtException", earlyUncaught);
    process.off("unhandledRejection", earlyRejection);
    console.error(`\u2717 delivery: start-up ${what} - releasing shard ${shard} before exiting`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    earlyStop(1);
  };
  const earlyUncaught = (e: Error): void => earlyFault("faulted", e);
  const earlyRejection = (e: unknown): void => earlyFault("rejected a promise", e);
  if (hosted === undefined) {
    process.on("uncaughtException", earlyUncaught);
    process.on("unhandledRejection", earlyRejection);
  }

  // Broker-sourced graph membership handle — declared BEFORE Plane-3 so the delivery-admin reload
  // hook below can close over it (it starts further down; the closure reads it live).
  // WHY the feed is down, carried from `startMembership` so the adoption refusal below names the real
  // fault instead of its symptom. Without it, an expired $SYS observer cred surfaces to the operator
  // only as "membership feed is not running" (#338).
  let membershipDown: string | undefined;
  // START-UP IS NOT DONE UNTIL THE LEASE WATCH IS BOUND (#2304). The ready flip below releases
  // `ensureDelivery`, and so the manager, whose boot renewal pass sends `reloadCreds` at once. The
  // endpoint refuses that adoption while this is false, rather than reconnecting this connection
  // underneath the membership start and the lease watch that are still pending on it.
  let startedUp = false;

  // Host Plane-3 (fan-out writer + trusted reader) AND serve the ctl.delivery runtime durable ops. The
  // reader re-authorizes each entry against the durable ACL registry, read FRESH per entry. The
  // delivery-admin rail's `reloadCreds` (explicit class-2 adoption) also reloads the membership feed's
  // rw connection via this hook.
  await ep.startPlane3((owner, lifecycleUid) => ep.aclForOwner(owner, lifecycleUid), {
    reloadMembershipCreds: async (expected?: string) => {
      if (!membership) {
        // Absent feed: a FAILURE when the renewal owner EXPECTED a membership generation (it re-signed
        // membership-rw.creds but the feed that must adopt it is not running), else n/a — a
        // delivery-only renewal must never be falsely failed by an unprovisioned feed.
        if (expected !== undefined)
          throw new Error(
            `membership feed is not running, but a membership generation was expected - nothing adopted${membershipDown ? `: ${membershipDown}` : ""}`,
          );
        return { skipped: `membership feed not running (nothing to reload)${membershipDown ? `: ${membershipDown}` : ""}` };
      }
      // Symmetric with delivery: claim broker acceptance (the preflight), not verified resident reauth.
      return { brokerAccepted: await membership.reloadRwCreds(expected), residentSwap: "best-effort" as const };
    },
    // Live-eviction executor (D5 slice 6): per-call $SYS observer/evictor connections; refuses
    // loudly on a pre-evictor space. Rare repair/flip step — never a standing $SYS conn here.
    evictPrincipal: (principal) => executeEviction(server, scanTarget, principal),
    // The same executor over a set: one shared sweep for a large credential family's holders.
    evictPrincipals: (principals) => executeEvictions(server, scanTarget, principals),
    // Plane-claim liveness oracle (#29 HIGH 3): read-only $SYS CONNZ per call; the auth plane's
    // stale-claim reclaim gates on this verdict (any refusal/unknown blocks takeover, fail-closed).
    planeConnLiveness: (query) => executePlaneLiveness(server, scanTarget, query),
    // Freeze-holder liveness probe (#391): read-only $SYS CONNZ per call — the READ half of
    // evictPrincipal, so gate reconciliation can refuse on a live holder's behalf rather than
    // killing it to discover it was alive (any refusal/unknown blocks the repair, fail-closed).
    principalLiveness: (principal) => executePrincipalLiveness(server, scanTarget, principal),
    reloadStoreIdentity: () => reloadStoreIdentity,
    onDeliveryCredsAdopted: () => health.adopted(),
    startupComplete: () => startedUp,
  });
  // The peer-readable liveness responder (#1577), bound BEFORE the ready flip below and
  // deliberately so. It answers from the lease at PROBE time, so during the window between binding
  // the loops and flipping ready it answers `unbound` — which is the truth, and is the whole point:
  // a surface that only came up once everything was healthy could never report the unhealthy state
  // it exists to report. Presence only; the lease row never crosses the wire.
  ep.serveDeliveryLiveness(shard);
  // Flip the lease to READY only now — after the loops + ctl.delivery responder are bound — so readiness
  // waiters (ensureDelivery) and the cotal_channels health surface see "ready" iff the responder is up,
  // not merely that the single-flight slot was claimed.
  try { revision = await ep.markDeliveryLeaseReady(shard, revision); }
  catch (error) {
    if (hosted !== undefined) throw error;
    /* CLI: the renew loop's CAS failure will exit us if the lease was lost. */
  }
  if (hostedStartupFailure !== undefined) throw hostedStartupFailure;
  console.log(`✓ delivery daemon up (space ${space}${shards > 1 ? `, shard ${shard}/${shards}` : ""}) — stop with: cotal down`);

  // Broker-sourced graph membership: a SEPARATE module on its OWN connections (system-account CONNZ
  // reader + data-account feed writer), isolated from Plane-3. Fail-soft — a missing cred / start error
  // logs and the graph degrades to traffic-only; Plane-3 delivery is never affected.
  try {
    // Pass the INJECTED store (hosted KMS/Vault), NOT credsSrc.store — that one may be an FS store over
    // an arbitrary `--creds` path, whereas membership-rw lives under the workstation `.cotal/` key. With
    // no injected store, startMembership falls back to the workstation FS store.
    // Fail-soft, but never fault-FORGETFUL: whichever way the feed fails to come up, keep the reason.
    // `accountId` is the account THIS daemon's own cred authenticates as (pinned above), not a
    // `.cotal/membership.json` read: the file was never an independent source (same directory as the
    // creds, so a wrong root was wrong for both) and a hosted composition has none.
    ({ handle: membership, down: membershipDown } = await startMembership(
      { space, server, accountId: scanTarget.expectedAccount, root },
      store,
    ));
  } catch (e) {
    membershipDown = (e as Error).message;
    console.error(`! membership: failed to start (${membershipDown}); graph membership degraded, delivery unaffected`);
  }

  // A store read can finish after a startup health fault closed the endpoint. Dispose the feed
  // it just returned before rejecting; it did not exist when the original close ran.
  if (hostedStartupFailure !== undefined) {
    await membership?.stop();
    throw hostedStartupFailure;
  }

  // The TIMER WRITER (SPEC 13.2): the pump that turns workflow `.schedule` requests into armed
  // broker schedules. Hosted here because this daemon is the space's standing server-side process;
  // without a running writer no pause on the space ever expires. Its OWN connection under the same
  // daemon cred (the endpoint's connection is private to it, and membership set the precedent of
  // module-per-connection isolation), re-dialed with the FRESHEST cred by a supervised restart
  // loop: a fault never kills delivery, is never silent (each attempt logs why the space cannot
  // expire pauses right now), and a cred that gains rows at renewal is picked up on the next dial.
  timerWriterAttempt = (async () => {
    let backoffMs = 5_000;
    for (;;) {
      if (stopping) return;
      let nc: Awaited<ReturnType<ReturnType<typeof dialerFor>>> | undefined;
      try {
        nc = await dialerFor(server)({
          servers: server,
          ...standaloneConnectOpts({ creds: latestCreds, tls }),
          name: "cotal-delivery-timer-writer",
          maxReconnectAttempts: -1,
        });
        if (stopping) { await nc.close(); return; }
        const handle = await startTimerWriter(nc, space);
        if (stopping) { await handle.stop(); await nc.close(); return; }
        timerWriter = { handle, nc };
        backoffMs = 5_000;
        console.log(`✓ timer writer up (space ${space}) — workflow pauses on this space expire`);
        await handle.done; // resolves only through stop(); a fault rejects
        return;
      } catch (e) {
        if (stopping) { try { await nc?.close(); } catch { /* already closed */ } return; }
        console.error(
          `! timer writer: down (${(e as Error).message}) — retrying in ${Math.round(backoffMs / 1000)}s; pauses on this space do not expire until it is back`,
        );
        try { await nc?.drain(); } catch { /* connection already gone */ }
        timerWriter = undefined;
        await new Promise((r) => setTimeout(r, backoffMs).unref());
        backoffMs = Math.min(backoffMs * 2, 300_000);
      }
    }
  })();

  const shutdown = (code: number, cause?: string): void => {
    if (hosted !== undefined) {
      unavailable = cause ? `delivery context stopped (code ${code}): ${cause}` : `delivery context stopped (code ${code})`;
      close().catch(() => {}); // as in stopHosted, the host's own close() reports it
      return;
    }
    if (stopping) return;
    stopping = true;
    if (renew !== undefined) clearInterval(renew);
    health.stop();
    stopLeaseWatch?.();
    // THE RECORD GOES FIRST, AND SYNCHRONOUSLY. Everything below this line talks to a broker that
    // may be dead and is bounded only by the 2s hard exit; a record left behind because a drain
    // hung is a record that outlives its process, which is this issue's defect re-entering through
    // the exit path. Removing it needs no broker, and waits only on a publish of the same record
    // that is in flight (#1238), so it runs before any of it.
    unrecordPid?.();
    // Hard-exit fallback: a graceful release/stop talks to the broker, which may be DEAD (the broker-gone
    // exit path) — don't let that hang the process. Force exit if the graceful path doesn't finish quickly.
    setTimeout(() => process.exit(code), 2000);
    void (async () => {
      // THE LEASE GOES FIRST. Everything else here is this process's own teardown, which nobody is
      // waiting on; the lease row is the one piece of SHARED state, and while it survives no
      // replacement daemon can acquire the shard at all (the acquire is an atomic create, so it is
      // refused outright and the row blocks the slot for the rest of the 30s bucket TTL). Behind
      // three awaits it was reachable only if all three finished inside the 2s hard-exit above, and
      // membership.stop() and the timer writer's stop+drain each talk to the broker on their own
      // connections.
      //
      // RELEASE AGAINST THE BROKER'S REVISION, NOT THE ONE THIS PROCESS HAPPENS TO HOLD.
      //
      // The release is a compare-and-swap, so a token one step behind frees NOTHING, and it fails
      // SILENTLY: `releaseDeliveryLease` swallows every error by design, because at shutdown the
      // broker may already be gone. A daemon can therefore stop cleanly, believe it released, and
      // leave its row claiming the shard for the rest of the 30s bucket TTL - after which the next
      // `cotal up` is refused with "a live lease already exists" and the shard is unservable by
      // anyone. That is this issue's outage reached without any starvation or broker fault at all.
      //
      // THE CACHED TOKEN CAN LAG THE BROKER, and it does not take a fault to get there. The claim is
      // deliberately that general, because more than one ordinary interleaving produces it and the
      // trace does not distinguish them: `markDeliveryLeaseReady` MOVES the row, so between the
      // broker applying that write and the daemon assigning the returned value, `revision` still
      // holds the acquire token - and a shutdown running in that interval argues it. A markReady
      // that rejects AFTER its write landed leaves the same lag permanently, since the failure is
      // caught (correctly: the renew loop repairs it). The launcher can already have observed the
      // row ready in either case, so from outside this is a started daemon. Measured, with both
      // controls in one run: release at the acquire revision left the row in place, release at the
      // current revision removed it, and a replacement endpoint could then acquire.
      //
      // So: re-read, and release only what is PROVABLY ours. `ownsDeliveryLease` is the same test
      // the renew path uses, so a row belonging to a successor is left alone - which is the property
      // the CAS was protecting in the first place, now argued from evidence rather than from a
      // token that may be out of date. No row, or not ours: nothing to release, and the TTL remains
      // the crash-safe authority for anything this path cannot reach.
      try {
        const own = await ep.readDeliveryLeaseEntry(shard);
        if (own !== undefined && ep.ownsDeliveryLease(own.info)) await ep.releaseDeliveryLease(shard, own.revision);
      } catch { /* broker may be gone - the bucket TTL is the crash-safe release authority */ }
      try { await membership?.stop(); } catch { /* broker may be gone */ }
      try { await timerWriter?.handle.stop(); } catch { /* broker may be gone */ }
      try { await timerWriter?.nc.drain(); } catch { /* broker may be gone */ }
      try { await ep.stop(); } catch { /* broker may be gone */ }
      process.exit(code);
    })();
  };
  stopHandler = shutdown;

  // SIGNAL HANDLERS GO UP THE MOMENT `shutdown` EXISTS, NOT AFTER STARTUP FINISHES.
  //
  // The lease is acquired long before this point, and registration used to sit at the very end of
  // start-up, past 22 further `await`s (Plane-3 bind, membership feed, timer writer, broker watch).
  // A SIGTERM landing in that window hit Node's DEFAULT handler and killed the process outright:
  // no release, no CAS, the row left behind for the rest of the 30s bucket TTL. The daemon had
  // already announced itself up, so from outside it was a fully started daemon that died silently
  // holding the shard, and the next `cotal up` was refused with "a live lease already exists", the
  // shard unservable for 30s after a perfectly ordinary stop-and-restart.
  //
  // Measured, not reasoned: with a diagnostic on the handler, the failing run's daemon log shows
  // the up line and NO `SIGTERM received`, while the two roots that passed in the same run show it.
  // That is what reddened `delivery-refresh-keeps-tls`, which stops the daemon and relaunches at
  // once. Registering here closes the window to the span before the lease exists, where there is
  // nothing to release.
  //
  // HAND OVER FROM `earlyStop`. The early handlers armed at the lease acquire are REMOVED rather
  // than left alongside these: `process.on` appends, so both would fire and the early one - which
  // knows nothing of the renew timer, the membership feed or the timer writer - would run first and
  // set `stopping`, making the full teardown a no-op. `stopping` still guards the swap itself, so a
  // signal delivered between these two statements is handled exactly once.
  if (hosted === undefined) {
    process.off("SIGINT", earlySigint);
    process.off("SIGTERM", earlySigterm);
    // The start-up fault guards go too, and BY REFERENCE: `removeAllListeners` here would strip
    // listeners this daemon does not own. They exist to cover the window where no `shutdown` exists;
    // past this line a fault should surface normally rather than become a quiet exit that skips the
    // full teardown.
    process.off("uncaughtException", earlyUncaught);
    process.off("unhandledRejection", earlyRejection);
    process.on("SIGINT", onSignal("SIGINT", shutdown));
    process.on("SIGTERM", onSignal("SIGTERM", shutdown));
  }
  /** What the broker says about THIS shard's lease key right now, the verdict a failed renew does
   *  NOT have. `unknown` never collapses into `gone`: not being able to look is not the same fact as
   *  looking and finding nothing (#1318).
   *
   *  The ownership test is `ep.ownsDeliveryLease`, which compares the row against BOTH this
   *  endpoint's wire identity and its per-run incarnation. Neither half is optional, and the two
   *  failures they rule out are different:
   *
   *  1. Comparing against `ownId` (the bare connection nkey `U…`) is comparing across NAMESPACES:
   *     the endpoint rewrites `card.id` in its constructor to the wire PRINCIPAL dot-form
   *     `${owner}.${actor}` (`local.U…`), and that is what `encodeLease` stamps. That mismatch made
   *     `held` UNREACHABLE, the daemon read its own row, failed to recognise itself, took the
   *     `taken` branch and exited naming ITSELF as the thief, leaving a not-ready row and no
   *     process. `held` is the one survivable reading ("your renew failed but the shard is still
   *     yours"), so making it unreachable turned every recoverable renew failure into a permanent
   *     withdrawal: #1318's own outage re-entering through the path built to prevent it.
   *
   *  2. Comparing on the principal ALONE is not sufficient either, and this is the one that looks
   *     correct: the daemon's cred is a FILE that every restart re-reads, so a REPLACEMENT daemon
   *     authenticates as the same nkey and writes the same `holder`. A displaced daemon would then
   *     read its successor's row, conclude the shard was still its own, carry on serving a shard it
   *     had lost (two daemons on one durable, which is the split this lease exists to prevent) and
   *     CAS-release the live holder's row on the way out. Cells F and G stage exactly that, with two
   *     daemons sharing one creds file, because that is what the product does. */
  const readOwnLease = async (): Promise<LeaseReading> => {
    let current: Awaited<ReturnType<typeof ep.readDeliveryLeaseEntry>>;
    try { current = await ep.readDeliveryLeaseEntry(shard); }
    catch (e) { return { kind: "unknown", why: (e as Error).message }; }
    if (current === undefined) return { kind: "gone" };
    if (!ep.ownsDeliveryLease(current.info)) return { kind: "taken", by: current.info.holder };
    // Held by us, AND at the broker's own revision rather than the one this process last cached.
    // That distinction is load-bearing: the renew that just failed may have been applied before its
    // reply was lost, in which case the cached revision is permanently one behind and every later
    // CAS is refused over a sequence this daemon moved itself. Adopting the read revision is what
    // lets a survivable renew failure actually be survived. (An earlier comment here claimed the
    // record carries no revision; it does, the KV entry's own `revision`, and that claim was
    // wrong, which is why the stale token went unnoticed.)
    return { kind: "held", revision: current.revision };
  };

  /** Print a lease state only when it CHANGES. The renew ticks every few seconds, so a broker
   *  outage would otherwise write the same line thousands of times into the daemon's log; an
   *  operator needs the line going in and the line coming out. */
  let leaseState = "held";
  const noteLease = (state: string, what: string): void => {
    if (state === leaseState) return;
    leaseState = state;
    console.error(`${state === "held" ? "✓" : "!"} delivery: ${what} (space ${space}, shard ${shard})`);
  };

  /** Announce going quiet, once per quiesced episode. Same rule as {@link noteLease}: the renew ticks
   *  forever, and an operator needs the edge, not a log line per tick. */
  let quiesced = false;
  const noteQuiesce = (): void => {
    if (quiesced) return;
    quiesced = true;
    console.error(`! delivery: stopped serving shard ${shard} (fan-out, reader and control unbound) while it re-checks who owns the lease (space ${space})`);
  };

  /** Resume serving, and CLOSE the quiesced episode so a later one announces itself again. Every
   *  caller has just proven ownership; `why` is what proved it, since "it started serving again" is
   *  only auditable next to the evidence that permitted it. */
  const resumeServing = async (why: string): Promise<void> => {
    if (stopping) return;
    try { await ep.rearmPlane3(); }
    catch (e) { console.error(`! delivery: ${why} but could not resume Plane-3 (${(e as Error).message})`); return; }
    // `ready` MEANS "THE RESPONDER IS UP", and it is what `ensureDelivery` waits on and what the
    // `cotal_channels` health surface reports. Startup flips it only after binding, for exactly that
    // reason, and a re-acquire creates the row afresh, which `acquireDeliveryLease` deliberately
    // makes NOT-ready. Without this flip a daemon that recovered would serve correctly while every
    // readiness waiter in the space timed out against a permanently not-ready lease: the outage
    // #1318 is about, surviving the repair by hiding in the readiness flag instead of the exit path.
    // Ordered AFTER the re-arm so the flag never claims more than has actually been bound.
    if (revision !== undefined) {
      try { revision = await ep.markDeliveryLeaseReady(shard, revision); }
      catch (e) { console.error(`! delivery: resumed serving but could not mark the lease ready (${(e as Error).message}); the next renew re-synchronises`); }
    }
    if (!quiesced) return;
    quiesced = false;
    console.error(`\u2713 delivery: serving shard ${shard} again, ${why} (space ${space})`);
  };

  // ── LEASE-LOSS WATCH (#1596): the row changing hands must be FELT, not polled into view ────────
  //
  // Nothing below the renew interval observed the lease row, so a daemon whose shard was taken
  // served a full renew period (~half the lease TTL, 15s at the shipped constant) before its next
  // CAS failure told it: two processes on one shard's fan-out durable, reader and ctl.delivery
  // responder for the whole window. A native KV watch on the daemon's own lease key — filtered to
  // that key, the same JetStream ordered-consumer mechanism the presence and channel watchers
  // ride — pushes the row the moment the broker applies the change, so the window is bounded by
  // the delivery latency of that one KV update instead of by the renew period.
  //
  // A TRIGGER, NEVER A SECOND DECISION PATH. Every event re-runs the SAME tree a failed renew
  // runs: quiesce, read the row, `leaseAction`/`mayServeOn` decide, re-arm only on proven
  // ownership, exit on `taken`, repair `gone` via the atomic create. The interval stays the
  // arbiter and the backstop — a watch event lost to a reconnect is still caught by the next
  // tick, and the endpoint rebinds the watch itself on every rebuild.
  //
  // A WATCH EVENT THAT READS OUR OWN WRITE MUST NOT TRIGGER A QUIESCE, and here that needs no
  // filtering: this daemon's writes (acquire, markReady/notReady, every renew) put a row this
  // endpoint OWNS into the key, so the handler reads the row, recognises itself, and returns
  // without touching Plane-3 — one extra broker read per own write, no state change, no log. Only
  // a row that is provably NOT ours (different holder or incarnation) or a real delete starts the
  // tree, which is exactly what the renew tick would have concluded one interval later.
  //
  // NO FALLBACK: the watch is part of the single-server guarantee, so a daemon that cannot
  // establish it refuses to start, loudly (the await below throws out of start-up and the
  // releaser gives the shard back), rather than degrade into the polled window this issue is
  // about. The stop handle is cleared on every exit path the renew interval is: `shutdown`.
  stopLeaseWatch = await ep.watchDeliveryLease(shard, (info) => {
   if (stopping) return;
   // The row as this event states it: an event for a row we own answers ITSELF (no state
   // change); a row we do not own, or a delete, needs the broker's word on what is there NOW
   // before anything is unbound, so fall through to the same re-read the renew failure path
   // performs. `undefined` here means the KV entry was DEL/PURGE'd, which is `gone`'s territory.
   if (info !== undefined && ep.ownsDeliveryLease(info)) return;
   void (async () => {
     // QUIESCE FIRST, exactly as a failed renew does: across the re-read below this process
     // does not know whether the shard is still its own, and an un-quiesced loser splits the
     // durable with whoever took the row. Same edge announcement, same not-ready withdrawal.
     try {
       await ep.quiescePlane3();
       if (revision !== undefined) {
         try { revision = await ep.markDeliveryLeaseNotReady(shard, revision); }
         catch { /* the row has moved on; the ownership read below is what decides */ }
       }
       noteQuiesce();
     } catch (e) {
       console.error(`! delivery: could not quiesce Plane-3 on a lease watch event (${(e as Error).message})`);
     }
     const reading = await readOwnLease();
     switch (leaseAction(reading)) {
       case "keep-serving":
         if (mayServeOn(reading)) {
           if (reading.kind !== "held") throw new Error(`delivery: mayServeOn admitted a "${reading.kind}" reading, which carries no revision to serve on`);
           revision = reading.revision;
           await resumeServing("a lease watch event re-read the key and found it still its own");
         }
         noteLease(
           reading.kind === "held" ? "held-unrenewed" : "unknown",
           reading.kind === "held"
             ? "a lease watch event fired but the key is still its own; serving"
             : `a lease watch event fired and the key could not be re-read (${reading.kind === "unknown" ? reading.why : ""}); staying quiet until the broker answers`,
         );
         return;
       case "reacquire":
         try {
           revision = await ep.acquireDeliveryLease(shard);
           await resumeServing(`it won the atomic create at revision ${revision} after a lease watch event`);
           noteLease("held", `a lease watch event found its lease key gone and re-acquired it at revision ${revision}`);
         } catch (e) {
           revision = undefined;
           console.error(
             `✗ delivery: a lease watch event found the key gone and another daemon has taken shard ${shard} (${(e as Error).message}), exiting so the holder is single`,
           );
           shutdown(1);
         }
         return;
       case "exit":
         revision = undefined;
         console.error(
           `✗ delivery: a lease watch event read the key as held by ${reading.kind === "taken" ? reading.by : "another daemon"}, not by this process, exiting so the holder is single`,
         );
         shutdown(1);
         return;
     }
   })().catch((e) => console.error(`! delivery: the lease watch trigger faulted (${(e as Error).message}); the renew interval remains the arbiter`));
 });
  if (hosted !== undefined && stopping) {
    stopLeaseWatch?.();
    throw hostedStartupFailure ?? new Error(unavailable ?? "delivery context stopped during startup");
  }
  startedUp = true;
  // Renew the lease at ~half the TTL so a healthy holder never self-evicts.

  //
  // A FAILED RENEW IS A QUESTION, NOT A VERDICT (#1318). The shipped code exited on ANY renew
  // error, so a key that had EXPIRED under local CPU starvation, with nobody else holding it,
  // reported as `wrong last sequence: 0`, was indistinguishable from a genuine takeover, and the
  // only holder there was ended itself. The verdict comes from RE-READING the key: `taken` exits so
  // the holder stays single, `gone` is repaired by an ATOMIC create (which arbitrates: if a
  // replacement got there first the create fails and THAT is the genuine loss), and `held`/`unknown`
  // keep serving. Overlap-guarded: two CAS attempts against the same cached revision would have the
  // second refused over a sequence the first legitimately moved, a conflict this daemon manufactures
  // itself and then reads as someone else's takeover.
  let renewInFlight = false;
  renew = setInterval(() => {
    if (stopping || renewInFlight) return;
    renewInFlight = true;
    void (async () => {
      try {
        // A renew with no owned revision is not a renew: this process already established that the
        // shard is someone else's and is on its way out. Attempting one would either fail noisily or,
        // worse, be graded as a lease question when ownership is already settled.
        if (revision === undefined) return;
        revision = await ep.renewDeliveryLease(shard, revision);
        // A SUCCESSFUL CAS RENEW IS PROOF OF OWNERSHIP, so it is also a re-arm point. Without this a
        // daemon that quiesced on `unknown` (the broker could not answer who owns the shard) would
        // stay silent forever once the broker came back: the `held` re-arm below only runs on the
        // failure path, and the failure path stops running as soon as renews succeed again. Quiesce
        // must be recoverable by the same evidence that makes it unnecessary.
        await resumeServing("it renewed its lease");
        noteLease("held", "renews its delivery lease again");
        return;
      } catch (renewError) {
        const why = (renewError as Error).message;
        // GO QUIET BEFORE ASKING. From here this process does not know whether the shard is still
        // its own, and a CAS on the lease row keeps one ROW, not one SERVER: across the re-read and
        // the re-acquire below, an un-quiesced daemon would still be consuming the fan-out durable,
        // still running the reader, and still answering ctl.delivery, so a replacement that won the
        // shard in that window would SPLIT the durable with it. A review finding, and the pre-fix
        // code did not have this window because it simply exited on the first renew failure.
        try {
          await ep.quiescePlane3();
          // WITHDRAW THE READINESS CLAIM TOO. `ready` asserts the responder is up; it is now down, so
          // leaving it set would tell every `ensureDelivery` waiter in the space to keep waiting on a
          // daemon that is deliberately not answering. Best-effort: the renew that just failed means
          // the CAS may fail too, and staying quiet matters more than the flag being tidy. The row
          // itself is kept, the shard is still claimed, only the answering claim is withdrawn.
          if (revision !== undefined) {
            try { revision = await ep.markDeliveryLeaseNotReady(shard, revision); }
            catch { /* the row may have moved on; the ownership read below is what decides */ }
          }
          // ANNOUNCED, because an operator watching a stall needs to know the daemon stopped serving
          // on purpose rather than silently wedged, and because the live cell anchors on this line
          // to know when to start demanding that this process holds no Plane-3 bindings.
          noteQuiesce();
        }
        catch (e) { console.error(`! delivery: could not quiesce Plane-3 while checking the lease (${(e as Error).message})`); }
        const reading = await readOwnLease();
        switch (leaseAction(reading)) {
          case "keep-serving":
            // Still ours, or unanswerable. Only a PROVEN `held` re-arms: `unknown` stays quiet,
            // because not being able to ask is not permission to keep acting on the shard.
            if (mayServeOn(reading)) {
              // ADOPT THE BROKER'S REVISION before serving again. The failed renew may have landed
              // with its reply lost, so the cached token can be stale; re-arming on it would leave
              // every later CAS refused over this daemon's own write and manufacture the takeover
              // it is trying to rule out. The read just told us the sequence, use it.
              // Narrowed by the guard above: `mayServeOn` admits only `held`, which is the one
              // reading that carries a revision. Stated as an assert rather than a cast so a future
              // widening of `mayServeOn` fails here loudly instead of serving without a CAS token.
              if (reading.kind !== "held") throw new Error(`delivery: mayServeOn admitted a "${reading.kind}" reading, which carries no revision to serve on`);
              revision = reading.revision;
              await resumeServing("re-reading the key showed the lease is still its own");
            }
            noteLease(
              reading.kind === "held" ? "held-unrenewed" : "unknown",
              reading.kind === "held"
                ? `could not renew its lease (${why}) but the key is still its own; serving, retrying`
                // NOT "serving": the quiesce above is still in force on this branch, and `mayServeOn`
                // refuses `unknown`, so nothing re-armed. Saying "serving" here would describe the
                // pre-fix behaviour and hide the very state this repair introduced.
                : `could not renew its lease (${why}) or re-read it (${reading.kind === "unknown" ? reading.why : ""}); staying quiet, retrying until the broker answers`,
            );
            return;
          case "reacquire":
            try {
              revision = await ep.acquireDeliveryLease(shard);
              // Won the atomic create, so the shard is provably ours again: resume serving.
              await resumeServing(`it won the atomic create at revision ${revision}`);
              noteLease("held", `found its lease key gone (renew: ${why}) and re-acquired it at revision ${revision}`);
            } catch (e) {
              // Refused: a live lease exists that is not ours, so a replacement daemon holds this
              // shard. THIS is the genuine loss, and it exits, WITHOUT a revision to release, or
              // the exit would delete the replacement's row.
              revision = undefined;
              console.error(
                `✗ delivery: lost the lease (${why}) and another daemon has taken shard ${shard} (${(e as Error).message}), exiting so the holder is single`,
              );
              shutdown(1);
            }
            return;
          case "exit":
            // Another daemon's row. Forget our revision first: releasing on the way out would delete
            // the holder's lease and turn a clean handover into an unheld shard.
            revision = undefined;
            console.error(
              `✗ delivery: the lease for shard ${shard} is held by ${reading.kind === "taken" ? reading.by : "another daemon"}, not by this process (renew: ${why}), exiting so the holder is single`,
            );
            shutdown(1);
            return;
        }
      } finally {
        renewInFlight = false;
      }
    })();
  }, Math.max(1000, Math.floor(LEASE_TTL_MS / 2)));

  return {
    status: (): DeliveryStatus =>
      unavailable !== undefined ? { state: "unavailable", cause: unavailable } : { state: stopping ? "draining" : "ready" },
    close,
  };
}

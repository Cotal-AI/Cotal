import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  LEASE_TTL_MS,
  accountFromCreds,
  credsClaims,
  dialerFor,
  idFromCreds,
  defaultProbeTimeoutMs,
  isReachable,
  mintCreds,
  newIdentity,
  formatSecretStoreIdentity,
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
import { DELIVERY_CREDS_KIND, DELIVERY_PIDFILE, FsSecretStore, authDir, canonicalLocalProcessPath, deliveryCredsKey, findCotalRoot, loadSpaceAuth, reclaimDeadPreUpgradeRecord, removeIdentityPin, segmentedKey, soleSpaceOf, spaceSegment, workspaceSecretStore, writeIdentityPin } from "@cotal-ai/workspace";
import { startMembership } from "./membership.js";
import { mayServeOn, brokerGoneVerdict, classifyProbe, DescheduleSampler, leaseAction, LoopLagMeter, PROBE_INTERVAL_MS, PROBE_LATE_FACTOR, type LeaseReading } from "./watchdog.js";
import { executeEviction, executePlaneLiveness, executePrincipalLiveness, validateScanTargetAdmission, type ScanTarget } from "./evict-exec.js";

type Values = Record<string, string | undefined>;

/** Re-exported for hosted compositions: the daemon cred's KIND, and the builder that turns it into
 *  the {@link SecretStore} key for a space. Defined once in workspace (the layout is the workspace's)
 *  so the writer, the renewal owner, and this reader can never drift apart. As of P7 the kind is NOT
 *  the key — the key is per-space — so a hosted store must be keyed with the builder; the flat kind
 *  is the pre-P7 key and putting there leaves this daemon reading an empty location. */
export { DELIVERY_CREDS_KIND, deliveryCredsKey };

type CredsSource = { store: SecretStore; key: string; where: string; injected: boolean; identity: SecretStoreIdentity };

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
  src: Pick<CredsSource, "injected" | "identity"> & { store?: SecretStore },
): SecretStoreIdentity {
  if (src.injected) {
    if (src.store?.identity !== undefined) return parseSecretStoreIdentity(src.store.identity);
    const coordinate = process.env.COTAL_SECRET_STORE;
    if (!coordinate)
      throw new Error(
        "delivery: an injected SecretStore must declare its identity or name its coordinate in COTAL_SECRET_STORE so the manager can challenge the same authority (never a silent local-root fallback)",
      );
    return { kind: "injected", coordinate };
  }
  return src.identity;
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
  if (
    basename(p) === DELIVERY_CREDS_KIND
    && basename(parent) === ".cotal"
    && basename(fileDir) === spaceSegment(space)
    && grand !== parent
  )
    return { kind: "fs", root: grand };
  return { kind: "fs", root: fileDir };
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
}): void {
  if (opts.injected) return;
  const cwdRoot = opts.cwdRoot ?? findCotalRoot();
  if (!existsSync(join(cwdRoot, ".cotal"))) return;
  const credsWorkspace = workspaceRootFromCredsPath(opts.credsPath);
  if (credsWorkspace === undefined) return;
  const cwdIdentity: SecretStoreIdentity = { kind: "fs", root: cwdRoot };
  const credsIdentity: SecretStoreIdentity = { kind: "fs", root: credsWorkspace };
  if (sameSecretStoreIdentity(credsIdentity, cwdIdentity)) return;
  throw new Error(
    `delivery: --creds names workstation ${formatSecretStoreIdentity(credsIdentity)} while membership-rw resolves under ${formatSecretStoreIdentity(cwdIdentity)} (process cwd). Pass both the same workstation root, or inject one SecretStore.`,
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
function resolveCredsStore(v: Values, space: string, injected?: SecretStore): CredsSource {
  if (injected) {
    const key = segmentedKey(DELIVERY_CREDS_KIND, space);
    return {
      store: injected,
      key,
      where: `secret-store key "${key}"`,
      injected: true,
      // Coordinate is named AFTER the cred is found. An absent key must still be
      // the absent-key error, never a COTAL_SECRET_STORE throw that masks it.
      identity: { kind: "injected", coordinate: process.env.COTAL_SECRET_STORE ?? "" },
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
  const root = findCotalRoot();
  const key = deliveryCredsKey(space, { injected: false, root });
  return {
    store: workspaceSecretStore(root),
    key,
    where: join(root, ".cotal", key),
    injected: false,
    identity: { kind: "fs", root },
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
async function loadDeliveryCreds(src: CredsSource, v: Values): Promise<{ initial: string; source: () => Promise<string> }> {
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
    const devRoot = authDir(findCotalRoot());
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
  writeFileSync(pidPath, mine);
  // #969: pin the pid to its process start so a later teardown can refuse a reused pid.
  writeIdentityPin(pidPath, process.pid);
  return () => {
    try {
      if (readFileSync(pidPath, "utf8").trim() !== mine) return; // a successor's record: not ours to remove
      removeIdentityPin(pidPath);
      rmSync(pidPath, { force: true });
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
}

async function runStartedDelivery(
  args: ParsedArgs,
  store: SecretStore | undefined,
  publishReleaser: (release: () => Promise<void>) => void,
): Promise<void> {
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

  // Space comes from --space (the CLI passes it). Only --dev-mint may derive it from the local signer.
  const space = v.space ?? (v["dev-mint"] !== undefined ? soleSpaceOf(authDir(findCotalRoot())) : undefined);
  if (!space) throw new Error("delivery: --space is required (the scoped creds file does not encode it)");
  const credsSrc = resolveCredsStore(v, space, store);
  if (v.creds !== undefined)
    assertUninjectedCredsSharesCwdRoot({ injected: credsSrc.injected, credsPath: resolve(v.creds) });
  const server = v.server ?? DEFAULT_SERVER;
  const creds = await loadDeliveryCreds(credsSrc, v); // pre-minted scoped cred; NO signer/loadSpaceAuth in this path
  let latestCreds = creds.initial; // freshest renewal — the broker-reachability poll below presents it

  // REQUIRE TLS when the operator said to. This daemon holds a STANDING credential and reconnects
  // unattended, so a downgrade here is not a one-shot exposure like a human running `cotal status`
  // - it is repeated, on every reconnect, with nobody watching. `tls: true` makes the client refuse
  // rather than fall back, which is the only behaviour that survives a forged plaintext INFO.
  // Boolean flags arrive as presence in this Values map (`Record<string, string | undefined>`),
  // matching how `--dev-mint` is read below. Comparing to `true` would silently never match.
  const tls = v.tls !== undefined;
  if (!(await isReachable(server, { creds: latestCreds, ...(tls ? { tls: true } : {}) }))) {
    console.error(`✗ delivery: can't reach NATS at ${server}. Run: cotal up`);
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
  const scanRoot = findCotalRoot();
  const scanTarget: ScanTarget = {
    root: scanRoot,
    expectedAccount: accountFromCreds(creds.initial),
    source: store === undefined
      ? { secrets: workspaceSecretStore(scanRoot), space, injected: false, root: scanRoot }
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
  });
  // Both channels: raw connection errors ride `error`, while every condition the endpoint is
  // already surviving — a failed 75% renewal, the passive backstop's "still holds the previous
  // cred" repair line — rides `warning` (#891). An operator who only sees the first watches the
  // daemon go silent and then die at `exp` with no word of the remint it was waiting for.
  const say = (e: Error) => console.error(`! delivery endpoint: ${e.message}`);
  ep.on("error", say);
  ep.on("warning", say);
  await ep.start();

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
  } catch {
    console.error(`✗ delivery: a live lease already exists for shard ${shard} — another delivery daemon is running. Not binding.`);
    await ep.stop();
    process.exit(1);
    return;
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
  /** Removes THIS process's liveness record, once it has one. Declared BEFORE the handlers that
   *  call it and assigned below, so a signal landing between the two is a no-op rather than a
   *  temporal-dead-zone throw: at that instant nothing has been written, so there is nothing to
   *  remove. Every exit path from the acquire onward goes through one of the three closures that
   *  call it, which is what keeps the record's lifetime equal to this daemon's. */
  let unrecordPid: (() => void) | undefined;
  const earlyStop = (code: number): void => {
    if (stopping) return;
    stopping = true;
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
  const earlySigint = (): void => earlyStop(0);
  const earlySigterm = (): void => earlyStop(0);
  process.on("SIGINT", earlySigint);
  process.on("SIGTERM", earlySigterm);
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
  unrecordPid = recordDeliveryPid(findCotalRoot(), space);
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
  publishReleaser(async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    unrecordPid?.(); // the record dies with the daemon it describes, including on a start-up failure
    try {
      const own = await ep.readDeliveryLeaseEntry(shard);
      if (own !== undefined && ep.ownsDeliveryLease(own.info)) await ep.releaseDeliveryLease(shard, own.revision);
    } catch { /* broker may be gone - the bucket TTL is the crash-safe release authority */ }
    try { await ep.stop(); } catch { /* broker may be gone */ }
  });
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
  process.on("uncaughtException", earlyUncaught);
  process.on("unhandledRejection", earlyRejection);

  // Broker-sourced graph membership handle — declared BEFORE Plane-3 so the delivery-admin reload
  // hook below can close over it (it starts further down; the closure reads it live).
  let membership: MembershipFeedHandle | undefined;
  // WHY the feed is down, carried from `startMembership` so the adoption refusal below names the real
  // fault instead of its symptom. Without it, an expired $SYS observer cred surfaces to the operator
  // only as "membership feed is not running" (#338).
  let membershipDown: string | undefined;

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
    // Plane-claim liveness oracle (#29 HIGH 3): read-only $SYS CONNZ per call; the auth plane's
    // stale-claim reclaim gates on this verdict (any refusal/unknown blocks takeover, fail-closed).
    planeConnLiveness: (query) => executePlaneLiveness(server, scanTarget, query),
    // Freeze-holder liveness probe (#391): read-only $SYS CONNZ per call — the READ half of
    // evictPrincipal, so gate reconciliation can refuse on a live holder's behalf rather than
    // killing it to discover it was alive (any refusal/unknown blocks the repair, fail-closed).
    principalLiveness: (principal) => executePrincipalLiveness(server, scanTarget, principal),
    reloadStoreIdentity: () => reloadStoreIdentity,
  });
  // Flip the lease to READY only now — after the loops + ctl.delivery responder are bound — so readiness
  // waiters (ensureDelivery) and the cotal_channels health surface see "ready" iff the responder is up,
  // not merely that the single-flight slot was claimed.
  try { revision = await ep.markDeliveryLeaseReady(shard, revision); }
  catch { /* lost the lease between acquire and ready — the renew loop's CAS failure will exit us */ }
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
      { space, server, accountId: scanTarget.expectedAccount },
      store,
    ));
  } catch (e) {
    membershipDown = (e as Error).message;
    console.error(`! membership: failed to start (${membershipDown}); graph membership degraded, delivery unaffected`);
  }

  // The TIMER WRITER (SPEC 13.2): the pump that turns workflow `.schedule` requests into armed
  // broker schedules. Hosted here because this daemon is the space's standing server-side process;
  // without a running writer no pause on the space ever expires. Its OWN connection under the same
  // daemon cred (the endpoint's connection is private to it, and membership set the precedent of
  // module-per-connection isolation), re-dialed with the FRESHEST cred by a supervised restart
  // loop: a fault never kills delivery, is never silent (each attempt logs why the space cannot
  // expire pauses right now), and a cred that gains rows at renewal is picked up on the next dial.
  let timerWriter: { handle: TimerWriterHandle; nc: Awaited<ReturnType<ReturnType<typeof dialerFor>>> } | undefined;
  void (async () => {
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
        const handle = await startTimerWriter(nc, space);
        timerWriter = { handle, nc };
        backoffMs = 5_000;
        console.log(`✓ timer writer up (space ${space}) — workflow pauses on this space expire`);
        await handle.done; // resolves only through stop(); a fault rejects
        return;
      } catch (e) {
        if (stopping) return;
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

  const shutdown = (code: number): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(renew);
    clearInterval(brokerWatch);
    // THE RECORD GOES FIRST, AND SYNCHRONOUSLY. Everything below this line talks to a broker that
    // may be dead and is bounded only by the 2s hard exit; a record left behind because a drain
    // hung is a record that outlives its process, which is this issue's defect re-entering through
    // the exit path. `rmSync` needs no broker and cannot hang, so it runs before any of it.
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
  process.off("SIGINT", earlySigint);
  process.off("SIGTERM", earlySigterm);
  // The start-up fault guards go too, and BY REFERENCE: `removeAllListeners` here would strip
  // listeners this daemon does not own. They exist to cover the window where no `shutdown` exists;
  // past this line a fault should surface normally rather than become a quiet exit that skips the
  // full teardown.
  process.off("uncaughtException", earlyUncaught);
  process.off("unhandledRejection", earlyRejection);
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
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
  const renew = setInterval(() => {
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

  // Coupled to the broker: POLL its reachability. Survive brief blips (the endpoint reconnects on its
  // own), but EXIT if the broker is GONE, the endpoint would otherwise retry reconnect forever (its
  // terminal-close never fires), so this is what stops the daemon outliving the server it serves.
  // (`cotal up`/`down` teardown stops it too.) The window is env-overridable for tests.
  //
  // WHAT "GONE" MEANS IS NOW DECIDED FROM EVIDENCE, NOT FROM A CLOCK (#1318). Three conditions used
  // to produce one signal and only one of them was a dead server: the broker being down, this
  // process being descheduled so the interval never fired, and a probe that could not complete a
  // handshake because the local process could not get scheduled to finish it. A wall-clock
  // `Date.now() - lastReachable` cannot tell them apart, and widening it only moves the threshold.
  // Three signals separate them, and all three are things this process can actually observe:
  //
  //   • MEASURED LOOP LAG. The gap between consecutive firings of a timer we own, minus its nominal
  //     period, is local starvation by direct measurement. It is credited back, so time this process
  //     spent off the runqueue is never counted against the broker.
  //   • COMPLETED NEGATIVE PROBES. Only a probe that RAN TO COMPLETION and returned false is
  //     evidence about the server. A probe that never ran contributes nothing (that was the whole
  //     defect: the window aged with no probe having failed), and one that REJECTED is an
  //     unanswered question, it now resets the counter and logs, where it used to be swallowed by
  //     `.catch(() => {})` and silently age the window.
  //   • TRANSPORT-LEVEL LIVENESS. A `transport: connected` edge from the endpoint's own connection
  //     cannot happen without a server on the other end, so it is positive evidence obtained for
  //     free, on a path that does not need this process to schedule a probe at all.
  //
  // A starvation diagnosis therefore reports DEGRADED and keeps serving; a genuinely dead broker
  // still exits, on the same window, as fast as completed probes can say so.
  const BROKER_GONE_MS = Number(process.env.COTAL_DELIVERY_BROKER_GONE_MS) || 15_000;
  // How many completed negatives make elapsed time believable. Two is the floor: one completed
  // negative is a single refused connect, which a loopback under momentary pressure can produce.
  // The default scales with the window so a test that shortens the window does not thereby demand
  // more evidence than the window has room for.
  const BROKER_GONE_PROBES = Math.max(
    2,
    Number(process.env.COTAL_DELIVERY_BROKER_GONE_PROBES) || Math.ceil(BROKER_GONE_MS / PROBE_INTERVAL_MS / 2),
  );
  // The hard backstop: past this, no amount of measured lag or transport optimism keeps the daemon
  // alive. A daemon that OUTLIVES a dead broker is worse than one that restarts unnecessarily, so
  // the repair is bounded and fails toward exiting.
  const BROKER_GONE_BACKSTOP_MS = Math.max(
    BROKER_GONE_MS,
    Number(process.env.COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS) || BROKER_GONE_MS * 4,
  );
  let lastReachable = Date.now();
  let completedNegatives = 0;
  let degraded = false;
  // What the endpoint's OWN connection reports about its socket to this same broker. Seeded true
  // because `ep.start()` above completed, which it cannot do without a server having answered.
  let transportConnected = true;
  const lag = new LoopLagMeter(PROBE_INTERVAL_MS);
  /** Positive evidence, from wherever it came: restart the window and its lag budget together. */
  const sawBroker = (): void => {
    lastReachable = Date.now();
    completedNegatives = 0;
    lag.reset();
    if (degraded) {
      degraded = false;
      console.error(`✓ delivery: the broker is answering again, Plane-3 is serving normally (space ${space})`);
    }
  };
  // The endpoint's OWN transport edge. This is evidence the daemon gets without being scheduled to
  // probe for it, and it is the signal that distinguishes "the connection object reports a
  // transport-level close" from "silence": a live connection to that address proves a server, while
  // a disconnect is the endpoint's own business (nats.js reconnects through blips of its own
  // accord) and merely stops excusing a probe that will not complete.
  ep.on("transport", (t: { connected: boolean }) => {
    transportConnected = t.connected;
    if (t.connected) sawBroker();
  });
  // THE BUDGET THE PROBE IS ACTUALLY GIVEN, asked of the one function that decides it. A ws(s)
  // broker rides an HTTPS edge and gets 5s, not the 1s a loopback TCP broker gets; judging a ws
  // probe against 1000 would read every honest refusal on such a broker as this process's own
  // starvation, so the completed-negative count could never rise and a genuinely dead ws broker
  // would be ended only by the backstop, with the wrong reason in its log. The budget and the
  // judgment have to come from the same place.
  const probeBudgetMs = defaultProbeTimeoutMs(server);
  const brokerWatch = setInterval(() => {
    if (stopping) return;
    // Measure FIRST, before any await: this is the gap since the previous firing, and it is the
    // only place the daemon can learn that it was not scheduled.
    lag.tick(Date.now());
    // THE SAME TRANSPORT AS EVERY OTHER DIAL IN THIS PROCESS. This poll carries `latestCreds` — a
    // standing credential — and `isReachable` performs a real authenticated connect whenever creds
    // are supplied, every 2 seconds, for the life of the daemon. It is the most repeated credential
    // presentation in the system, and it was the one dial here that did not name its transport.
    //
    // The poll predates TLS and is identical on `main`, where nothing is encrypted and it is at
    // least consistent. What is new is the ASYMMETRY: with the two dials above upgraded, an operator
    // who enables TLS would get a protected main path and an unprotected watchdog. An inconsistent
    // guarantee is worse than a uniformly absent one, because the operator now believes something.
    const probeStarted = Date.now();
    // Watch this process's own scheduling FOR THE DURATION OF THE PROBE. A refusal is only evidence
    // about the server if the server was actually given the time the deadline promised it, and
    // under short CPU slices most of a probe's wall-clock can be time this process was not running.
    const sampler = new DescheduleSampler();
    sampler.start(probeStarted);
    void isReachable(server, { creds: latestCreds, ...(tls ? { tls: true } : {}) })
      .then(
        (ok) => classifyProbe(ok, Date.now() - probeStarted, probeBudgetMs, PROBE_LATE_FACTOR, sampler.stop()),
        // A REJECTED probe is an unanswered question, not a negative answer. It used to be swallowed
        // whole by `.catch(() => {})`, so it neither refreshed the window nor evaluated anything and
        // silently aged the daemon toward an exit it had gathered no evidence for.
        (e: Error) => {
          sampler.stop();
          console.error(`! delivery: the broker probe did not complete (${e.message}), no verdict from it; serving, retrying`);
          return classifyProbe(undefined, Date.now() - probeStarted);
        },
      )
      .then((probe) => {
        if (stopping) return;
        if (probe.counts === "positive") { sawBroker(); return; }
        if (probe.counts === "incomplete") {
          // The run of credible refusals is broken by a probe that did not complete.
          completedNegatives = 0;
          return;
        }
        if (probe.counts === "starved") {
          // The probe RAN and said no, but its answer arrived so far past its own deadline that the
          // deadline was enforced against this process rather than against the server. That is the
          // starved-client case, and it is the one an elapsed-time predicate cannot see at all: the
          // timer is firing, the probes are completing, and every one of them is `false`.
          // Dated with the instant the answer ARRIVED, so the meter can tell whether this stall is
          // the same wall-clock interval the tick above already charged (union, counted once) or an
          // adjacent one (disjoint, both counted). The overlap question is settled by timestamps
          // rather than by comparing magnitudes, which cannot distinguish the two.
          lag.credit(probe.lateBy, Date.now());
          completedNegatives = 0;
        } else {
          // A refusal that arrived on time. This is the only thing that may accrue against the broker.
          completedNegatives += 1;
        }
        // ONE SPAN, MEASURED ONCE, USED FOR BOTH. Reading the clock twice would let the elapsed span
        // and the lag clamp disagree by the cost of the call itself.
        const sinceReachable = Date.now() - lastReachable;
        const verdict = brokerGoneVerdict({
          msSinceLastReachable: sinceReachable,
          // CLAMPED TO THE SPAN IT IS SUBTRACTED FROM. The interval gap and a late probe answer can
          // testify to the same stall, and the meter cannot tell that from two adjacent stalls, so it
          // keeps both charges and the bound is applied here, where the span is known. Without it a
          // 10s stall read 17s and drove unstarved time negative, which cannot be cleared by any
          // amount of real outage: a dead broker then survives the evidence clause and exits only on
          // the backstop, 44s -> 62s measured. Time not had cannot exceed time passed.
          starvedMs: lag.starvedMsWithin(sinceReachable),
          completedNegatives,
          transportConnected,
          windowMs: BROKER_GONE_MS,
          requiredNegatives: BROKER_GONE_PROBES,
          backstopMs: BROKER_GONE_BACKSTOP_MS,
        });
        if (verdict.exit) {
          // SAY WHICH EXIT THIS IS. The single message here previously claimed completed probes over
          // ">15s of unstarved time" on BOTH paths, and on the backstop path that sentence is simply
          // false: the backstop fires precisely when the evidence clauses did NOT conclude, often
          // with zero completed refusals. An operator debugging a starved host was handed a
          // confident evidentiary claim the daemon had not established.
          console.error(
            verdict.reason === "backstop"
              ? `✗ delivery: giving up on elapsed time alone, ${Math.round(BROKER_GONE_BACKSTOP_MS / 1000)}s since the last ` +
                  `confirmed reachability with no sufficient evidence either way (${completedNegatives} completed probes refused, ` +
                  `${Math.round(lag.starvedMsWithin(sinceReachable) / 1000)}s of local scheduler lag credited). This is a BOUND, not a diagnosis: the ` +
                  `broker may be gone or this process may have been starved past the bound, exiting (coupled to the broker)`
              : `✗ delivery: broker unreachable, ${completedNegatives} completed probes refused within their deadline over ` +
                  `>${BROKER_GONE_MS / 1000}s of unstarved time (${Math.round(lag.starvedMsWithin(sinceReachable) / 1000)}s of local scheduler lag credited), exiting (coupled to the broker)`,
          );
          shutdown(1);
          return;
        }
        // NOT an exit. Say so once per episode, naming WHICH condition it is, so an operator reading
        // the log during a load incident sees "this host starved me" rather than a daemon that
        // silently vanished.
        if (!degraded && verdict.reason !== "reachable") {
          degraded = true;
          console.error(
            verdict.reason === "starved"
              ? `! delivery: DEGRADED, cannot reach the broker, but ${Math.round(lag.starvedMsWithin(sinceReachable) / 1000)}s of that window was local scheduler lag (this host is starving this process, not the broker); serving, retrying`
              : verdict.reason === "transport-live"
                ? `! delivery: DEGRADED, a fresh probe cannot complete, but this daemon's own connection to ${server} is still open, so the broker is there and this process cannot ask; serving, retrying`
                : `! delivery: DEGRADED, the broker has not answered for >${BROKER_GONE_MS / 1000}s but only ${completedNegatives} of ${BROKER_GONE_PROBES} probes have refused within their deadline; serving, retrying`,
          );
        }
      })
      .catch((e: Error) => {
        // The verdict path itself faulted. Never silent, and never an exit: a bug in the detector
        // must not end the daemon it is meant to keep alive.
        console.error(`! delivery: the broker watch tick faulted (${e.message}); serving, retrying`);
      });
  }, PROBE_INTERVAL_MS);

  await new Promise<void>(() => {}); // run until signalled
}

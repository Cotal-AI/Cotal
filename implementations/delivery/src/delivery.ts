import { existsSync } from "node:fs";
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
import { DELIVERY_CREDS_KIND, FsSecretStore, authDir, deliveryCredsKey, findCotalRoot, loadSpaceAuth, segmentedKey, soleSpaceOf, spaceSegment, workspaceSecretStore } from "@cotal-ai/workspace";
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
  // THIS daemon's endpoint id, pinned once. It is what the lease record carries as `holder`, so it
  // is the fact that distinguishes "our own key" from "a replacement daemon's key" when a failed
  // renew has to be re-read rather than believed (#1318).
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

  let stopping = false;

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
    // Hard-exit fallback: a graceful release/stop talks to the broker, which may be DEAD (the broker-gone
    // exit path) — don't let that hang the process. Force exit if the graceful path doesn't finish quickly.
    setTimeout(() => process.exit(code), 2000);
    void (async () => {
      try { await membership?.stop(); } catch { /* broker may be gone */ }
      try { await timerWriter?.handle.stop(); } catch { /* broker may be gone */ }
      try { await timerWriter?.nc.drain(); } catch { /* broker may be gone */ }
      try { await ep.releaseDeliveryLease(shard, revision); } catch { /* broker may be gone */ }
      try { await ep.stop(); } catch { /* broker may be gone */ }
      process.exit(code);
    })();
  };
  /** What the broker says about THIS shard's lease key right now — the verdict a failed renew does
   *  NOT have. `unknown` never collapses into `gone`: not being able to look is not the same fact as
   *  looking and finding nothing (#1318). The holder comparison is against OUR OWN endpoint id, which
   *  is what distinguishes this process from a replacement daemon that took the slot. */
  const readOwnLease = async (): Promise<LeaseReading> => {
    let current: Awaited<ReturnType<typeof ep.readDeliveryLeaseEntry>>;
    try { current = await ep.readDeliveryLeaseEntry(shard); }
    catch (e) { return { kind: "unknown", why: (e as Error).message }; }
    if (current === undefined) return { kind: "gone" };
    if (current.info.holder !== ownId) return { kind: "taken", by: current.info.holder };
    // Held by us, AND at the broker's own revision rather than the one this process last cached.
    // That distinction is load-bearing: the renew that just failed may have been applied before its
    // reply was lost, in which case the cached revision is permanently one behind and every later
    // CAS is refused over a sequence this daemon moved itself. Adopting the read revision is what
    // lets a survivable renew failure actually be survived. (An earlier comment here claimed the
    // record carries no revision; it does — the KV entry's own `revision` — and that claim was
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
    // reason — and a re-acquire creates the row afresh, which `acquireDeliveryLease` deliberately
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
    console.error(`\u2713 delivery: serving shard ${shard} again \u2014 ${why} (space ${space})`);
  };

  // Renew the lease at ~half the TTL so a healthy holder never self-evicts.
  //
  // A FAILED RENEW IS A QUESTION, NOT A VERDICT (#1318). The shipped code exited on ANY renew
  // error, so a key that had EXPIRED under local CPU starvation — with nobody else holding it,
  // reported as `wrong last sequence: 0` — was indistinguishable from a genuine takeover, and the
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
          // itself is kept — the shard is still claimed, only the answering claim is withdrawn.
          if (revision !== undefined) {
            try { revision = await ep.markDeliveryLeaseNotReady(shard, revision); }
            catch { /* the row may have moved on; the ownership read below is what decides */ }
          }
          // ANNOUNCED, because an operator watching a stall needs to know the daemon stopped serving
          // on purpose rather than silently wedged — and because the live cell anchors on this line
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
              // it is trying to rule out. The read just told us the sequence — use it.
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
                : `could not renew its lease (${why}) or re-read it (${reading.kind === "unknown" ? reading.why : ""}); serving, retrying until the broker answers`,
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
              // shard. THIS is the genuine loss, and it exits — WITHOUT a revision to release, or
              // the exit would delete the replacement's row.
              revision = undefined;
              console.error(
                `✗ delivery: lost the lease (${why}) and another daemon has taken shard ${shard} (${(e as Error).message}) — exiting so the holder is single`,
              );
              shutdown(1);
            }
            return;
          case "exit":
            // Another daemon's row. Forget our revision first: releasing on the way out would delete
            // the holder's lease and turn a clean handover into an unheld shard.
            revision = undefined;
            console.error(
              `✗ delivery: the lease for shard ${shard} is held by ${reading.kind === "taken" ? reading.by : "another daemon"}, not by this process (renew: ${why}) — exiting so the holder is single`,
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
  // own), but EXIT if the broker is GONE — the endpoint would otherwise retry reconnect forever (its
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
  //     unanswered question — it now resets the counter and logs, where it used to be swallowed by
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
      console.error(`✓ delivery: the broker is answering again — Plane-3 is serving normally (space ${space})`);
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
          console.error(`! delivery: the broker probe did not complete (${e.message}) — no verdict from it; serving, retrying`);
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
          lag.credit(probe.lateBy);
          completedNegatives = 0;
        } else {
          // A refusal that arrived on time. This is the only thing that may accrue against the broker.
          completedNegatives += 1;
        }
        const verdict = brokerGoneVerdict({
          msSinceLastReachable: Date.now() - lastReachable,
          starvedMs: lag.starvedMs,
          completedNegatives,
          transportConnected,
          windowMs: BROKER_GONE_MS,
          requiredNegatives: BROKER_GONE_PROBES,
          backstopMs: BROKER_GONE_BACKSTOP_MS,
        });
        if (verdict.exit) {
          console.error(
            `✗ delivery: broker unreachable — ${completedNegatives} completed probes refused within their deadline over ` +
              `>${BROKER_GONE_MS / 1000}s of unstarved time (${Math.round(lag.starvedMs / 1000)}s of local scheduler lag credited) — exiting (coupled to the broker)`,
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
              ? `! delivery: DEGRADED — cannot reach the broker, but ${Math.round(lag.starvedMs / 1000)}s of that window was local scheduler lag (this host is starving this process, not the broker); serving, retrying`
              : verdict.reason === "transport-live"
                ? `! delivery: DEGRADED — a fresh probe cannot complete, but this daemon's own connection to ${server} is still open, so the broker is there and this process cannot ask; serving, retrying`
                : `! delivery: DEGRADED — the broker has not answered for >${BROKER_GONE_MS / 1000}s but only ${completedNegatives} of ${BROKER_GONE_PROBES} probes have refused within their deadline; serving, retrying`,
          );
        }
      })
      .catch((e: Error) => {
        // The verdict path itself faulted. Never silent, and never an exit: a bug in the detector
        // must not end the daemon it is meant to keep alive.
        console.error(`! delivery: the broker watch tick faulted (${e.message}); serving, retrying`);
      });
  }, PROBE_INTERVAL_MS);

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  await new Promise<void>(() => {}); // run until signalled
}

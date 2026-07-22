import { basename, dirname, join, resolve } from "node:path";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  LEASE_TTL_MS,
  credsClaims,
  idFromCreds,
  isReachable,
  mintCreds,
  newIdentity,
  type MembershipFeedHandle,
  type ParsedArgs,
  type SecretStore,
} from "@cotal-ai/core";
import { DELIVERY_CREDS_KEY, FsSecretStore, authDir, findCotalRoot, loadSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { startMembership } from "./membership.js";
import { executeEviction, executePlaneLiveness } from "./evict-exec.js";

type Values = Record<string, string | undefined>;

/** Re-exported for hosted compositions: the {@link SecretStore} key a store injected into
 *  {@link runDelivery} must hold the cred under. Defined once in workspace (the key↔filename
 *  convention is the workspace layout's) so the writer, the renewal owner, and this reader can
 *  never drift apart. */
export { DELIVERY_CREDS_KEY };

type CredsSource = { store: SecretStore; key: string; where: string; injected: boolean };

/** Where the daemon's pre-minted cred lives — exactly ONE source, resolved up front: an injected
 *  {@link SecretStore} (a hosted composition), an explicit `--creds <file>` (e.g. a read-only
 *  container mount) as an FS store over that exact file, or the default workstation location.
 *  With an injected store the store is the ONLY credential source: every local-source flag
 *  (`--creds`, `--dev-mint`) is rejected loudly at this boundary — and it runs BEFORE any ambient
 *  read in `runDelivery` — so a hosted composition can never cross back into workstation trust
 *  material (a creds file, the local signer), not even for a space label. `where` is the human
 *  label used in error messages so a local operator still sees a path, not an abstract key. */
function resolveCredsStore(v: Values, injected?: SecretStore): CredsSource {
  if (injected) {
    const local = ["creds", "dev-mint"].filter((f) => v[f] !== undefined);
    if (local.length)
      throw new Error(
        `delivery: ${local.map((f) => `--${f}`).join(" and ")} cannot be combined with an injected secret store — the store is the cred's only source`,
      );
    return { store: injected, key: DELIVERY_CREDS_KEY, where: `secret-store key "${DELIVERY_CREDS_KEY}"`, injected: true };
  }
  if (v.creds !== undefined) {
    const p = resolve(v.creds);
    return { store: new FsSecretStore(dirname(p)), key: basename(p), where: p, injected: false };
  }
  const root = findCotalRoot();
  return { store: workspaceSecretStore(root), key: DELIVERY_CREDS_KEY, where: join(root, ".cotal", DELIVERY_CREDS_KEY), injected: false };
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
      `delivery: no cred in the injected secret store under key "${DELIVERY_CREDS_KEY}" — the hosted composition must put it before starting the daemon (local sources are never consulted when a store is injected)`,
    );
  if (v["dev-mint"] !== undefined) {
    const auth = loadSpaceAuth(authDir(findCotalRoot()));
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
 * {@link DELIVERY_CREDS_KEY} AND the membership feed's rw cred under `membership-rw.creds`; the
 * registered `deliver` command passes none and gets the workstation FS store (or `--creds`). The
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

  // Resolve the cred source FIRST — before the ambient space derivation below — so an injected
  // store rejects local-source flags before anything can read the workstation signer.
  const credsSrc = resolveCredsStore(v, store);

  // Space comes from --space (the CLI passes it). Only --dev-mint may derive it from the local signer.
  const space = v.space ?? (v["dev-mint"] !== undefined ? loadSpaceAuth(authDir(findCotalRoot()))?.space : undefined);
  if (!space) throw new Error("delivery: --space is required (the scoped creds file does not encode it)");
  const server = v.server ?? DEFAULT_SERVER;
  const creds = await loadDeliveryCreds(credsSrc, v); // pre-minted scoped cred; NO signer/loadSpaceAuth in this path
  let latestCreds = creds.initial; // freshest renewal — the broker-reachability poll below presents it

  if (!(await isReachable(server, { creds: latestCreds }))) {
    console.error(`✗ delivery: can't reach NATS at ${server}. Run: cotal up`);
    process.exit(1);
  }

  const ep = new CotalEndpoint({
    space,
    servers: server,
    // The RELOAD seam (D5 slice 5 class 2): the endpoint re-invokes the source at 75% of each JWT's
    // lifetime and swaps the connection onto the re-signed file — bounded delivery creds renew with
    // no daemon restart. The explicit card.id pins the daemon's nkey across renewals.
    creds: async () => (latestCreds = await creds.source()),
    channels: [],
    consume: false, // it pulls the Plane-3 consumers itself; no agent live-tail
    watchPresence: true, // read the roster for @mention resolution …
    registerPresence: false, // … but NEVER publish the daemon onto the roster (it's infra, not a peer)
    card: { id: idFromCreds(creds.initial), name: "delivery", role: "delivery", kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(`! delivery endpoint: ${e.message}`));
  await ep.start();

  // Acquire the single-flight lease BEFORE binding the loops: a loud refusal-to-bind if another daemon
  // already holds this shard (two clients binding the same durable name SPLIT delivery). The bucket TTL
  // frees a crashed holder's lease so a fresh daemon re-acquires.
  let revision: number;
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
          throw new Error("membership feed is not running, but a membership generation was expected - nothing adopted");
        return { skipped: "membership feed not running (nothing to reload)" };
      }
      // Symmetric with delivery: claim broker acceptance (the preflight), not verified resident reauth.
      return { brokerAccepted: await membership.reloadRwCreds(expected), residentSwap: "best-effort" as const };
    },
    // Live-eviction executor (D5 slice 6): per-call $SYS observer/evictor connections; refuses
    // loudly on a pre-evictor space. Rare repair/flip step — never a standing $SYS conn here.
    evictPrincipal: (principal) => executeEviction(server, principal),
    // Plane-claim liveness oracle (#29 HIGH 3): read-only $SYS CONNZ per call; the auth plane's
    // stale-claim reclaim gates on this verdict (any refusal/unknown blocks takeover, fail-closed).
    planeConnLiveness: (query) => executePlaneLiveness(server, query),
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
    membership = await startMembership({ space, server }, store);
  } catch (e) {
    console.error(`! membership: failed to start (${(e as Error).message}) — graph membership degraded, delivery unaffected`);
  }

  let stopping = false;
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
      try { await ep.releaseDeliveryLease(shard); } catch { /* broker may be gone */ }
      try { await ep.stop(); } catch { /* broker may be gone */ }
      process.exit(code);
    })();
  };
  // Renew the lease at ~half the TTL so a healthy holder never self-evicts; losing the CAS means
  // another daemon took over (we exit rather than double-deliver).
  const renew = setInterval(() => {
    ep.renewDeliveryLease(shard, revision)
      .then((r) => (revision = r))
      .catch((e: Error) => {
        console.error(`✗ delivery: lost the lease (${e.message}) — exiting so the holder is single`);
        shutdown(1);
      });
  }, Math.max(1000, Math.floor(LEASE_TTL_MS / 2)));

  // Coupled to the broker: POLL its reachability. Survive brief blips (the endpoint reconnects on its
  // own), but EXIT if the broker has been gone for BROKER_GONE_MS — the endpoint would otherwise retry
  // reconnect forever (its terminal-close never fires), so this is what stops the daemon outliving the
  // server it serves. (`cotal up`/`down` teardown stops it too.) The window is env-overridable for tests.
  const BROKER_GONE_MS = Number(process.env.COTAL_DELIVERY_BROKER_GONE_MS) || 15_000;
  let lastReachable = Date.now();
  const brokerWatch = setInterval(() => {
    if (stopping) return;
    void isReachable(server, { creds: latestCreds })
      .then((ok) => {
        if (ok) { lastReachable = Date.now(); return; }
        if (Date.now() - lastReachable > BROKER_GONE_MS) {
          console.error(`✗ delivery: broker unreachable for >${BROKER_GONE_MS / 1000}s — exiting (coupled to the broker)`);
          shutdown(1);
        }
      })
      .catch(() => {});
  }, 2000);

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  await new Promise<void>(() => {}); // run until signalled
}

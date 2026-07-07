import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
} from "@cotal-ai/core";
import { authDir, findCotalRoot, loadSpaceAuth } from "@cotal-ai/workspace";
import { startMembership } from "./membership.js";
import { executeEviction } from "./evict-exec.js";

type Values = Record<string, string | undefined>;

/** Default location of the pre-minted scoped `delivery` creds the daemon loads (the CLI's
 *  `ensureDelivery` mints it once from the signer and writes it here, then launches the daemon WITHOUT
 *  signer access). A container mounts it read-only and passes `--creds`. */
function deliveryCredsPath(): string {
  return join(findCotalRoot(), ".cotal", "delivery.creds");
}

/** The daemon's scoped `delivery` creds — the PRODUCTION path reads a PRE-MINTED file (`--creds` or the
 *  default `.cotal/delivery.creds`, written by the CLI's `ensureDelivery` setup helper) and NEVER touches
 *  the signer: this runtime does not load `.cotal/auth`. Returned as `{ initial, source }`: the SOURCE
 *  is the D5 slice-5 class-2 reload seam — the endpoint re-invokes it at 75% of each JWT's lifetime, so
 *  the daemon renews from the renewal-owner-re-signed file without a restart or a signal. Adoption is
 *  IDEMPOTENT on an unchanged file while its cred is still ahead of the renewal point (explicit reload
 *  may race the backstop); past it, an unchanged file is a MISSED remint, surfaced loudly with the
 *  exact repair — never a silent ride to expiry. A standalone dev run
 *  with no creds file can opt into `--dev-mint`, which loads the local signer and self-remints a scoped
 *  `delivery` cred (one stable identity) — LOUDLY flagged as dev-only, never the production contract. */
async function loadDeliveryCreds(v: Values): Promise<{ initial: string; source: () => Promise<string> }> {
  const path = v.creds ?? deliveryCredsPath();
  if (existsSync(path)) {
    const initial = readFileSync(path, "utf8");
    let last: string | undefined; // set by the FIRST source call (the endpoint's initial fetch)
    return {
      initial,
      source: async () => {
        const content = readFileSync(path, "utf8");
        if (last !== undefined && content === last) {
          // Unchanged file: adoption is IDEMPOTENT while the cred is still ahead of its renewal
          // point (the explicit reload may race the 75% backstop that just adopted the same
          // re-sign — both succeeding is correct). Past the renewal point an unchanged file is a
          // MISSED remint: fail loud with the exact repair, never a silent ride to expiry.
          const { iat, exp } = credsClaims(content);
          if (typeof exp === "number" && typeof iat === "number" && Date.now() / 1000 < iat + 0.75 * (exp - iat)) return content;
          throw new Error(`${path} still holds the previous cred — the renewal owner has not re-signed it (the manager re-signs + reloads every half-TTL); run \`cotal doctor auth --fix\`, or restart the mesh's manager, before this JWT expires`);
        }
        last = content;
        return content;
      },
    };
  }
  if (v["dev-mint"] !== undefined) {
    const auth = loadSpaceAuth(authDir(findCotalRoot()));
    if (!auth) throw new Error("delivery --dev-mint: no .cotal/auth here to mint from");
    console.error("⚠ delivery: --dev-mint — minting a scoped delivery cred from the LOCAL SIGNER (DEV ONLY; production mounts a pre-minted delivery.creds and the daemon never sees the signer)");
    const identity = newIdentity(); // stable across self-remints — the endpoint pins it
    const initial = await mintCreds(auth, identity, "delivery");
    return { initial, source: () => mintCreds(auth, identity, "delivery") };
  }
  throw new Error(
    `delivery: no scoped creds at ${path}. Launch via \`cotal setup\`/\`cotal go\` (the setup helper mints + writes it), or pass --creds <file>; for a standalone dev run use --dev-mint.`,
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
 */
export async function runDelivery(args: ParsedArgs): Promise<void> {
  const v = args.values as Values;
  const shard = v.shard ? Number(v.shard) : 0;
  const shards = v.shards ? Number(v.shards) : 1;
  if (shards !== 1 || shard !== 0)
    throw new Error(
      `delivery: sharded operation is not supported (N=1 only; got shard=${shard} shards=${shards}). ` +
        "The partition() seam ships but operating shards>1 needs the channel-prefix grammar — see core-sub-fabric.md.",
    );

  // Space comes from --space (the CLI passes it). Only --dev-mint may derive it from the local signer.
  const space = v.space ?? (v["dev-mint"] !== undefined ? loadSpaceAuth(authDir(findCotalRoot()))?.space : undefined);
  if (!space) throw new Error("delivery: --space is required (the scoped creds file does not encode it)");
  const server = v.server ?? DEFAULT_SERVER;
  const creds = await loadDeliveryCreds(v); // pre-minted scoped cred; NO signer/loadSpaceAuth in this path
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
  await ep.startPlane3((owner) => ep.aclForOwner(owner), {
    reloadMembershipCreds: async () =>
      membership ? membership.reloadRwCreds() : "membership feed not running (nothing to reload)",
    // Live-eviction executor (D5 slice 6): per-call $SYS observer/evictor connections; refuses
    // loudly on a pre-evictor space. Rare repair/flip step — never a standing $SYS conn here.
    evictPrincipal: (principal) => executeEviction(server, principal),
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
    membership = await startMembership({ space, server });
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

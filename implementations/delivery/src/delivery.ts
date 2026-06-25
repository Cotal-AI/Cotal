import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  LEASE_TTL_MS,
  isReachable,
  mintCreds,
  newIdentity,
  type MembershipFeedHandle,
} from "@cotal-ai/core";
import { authDir, findCotalRoot, loadSpaceAuth } from "@cotal-ai/workspace";
import { startMembership } from "./membership.js";

type Values = Record<string, string | undefined>;

/** Default location of the pre-minted scoped `delivery` creds the daemon loads (the CLI's
 *  `ensureDelivery` mints it once from the signer and writes it here, then launches the daemon WITHOUT
 *  signer access). A container mounts it read-only and passes `--creds`. */
function deliveryCredsPath(): string {
  return join(findCotalRoot(), ".cotal", "delivery.creds");
}

/** The daemon's scoped `delivery` creds — the PRODUCTION path reads a PRE-MINTED file (`--creds` or the
 *  default `.cotal/delivery.creds`, written by the CLI's `ensureDelivery` setup helper) and NEVER touches
 *  the signer: this runtime does not load `.cotal/auth`. A standalone dev run with no creds file can opt
 *  into `--dev-mint`, which loads the local signer and mints a scoped `delivery` cred once — LOUDLY
 *  flagged as dev-only, never the production contract. Never an allow-all cred either way. */
async function loadDeliveryCreds(v: Values): Promise<string> {
  const path = v.creds ?? deliveryCredsPath();
  if (existsSync(path)) return readFileSync(path, "utf8");
  if (v["dev-mint"] !== undefined) {
    const auth = loadSpaceAuth(authDir(findCotalRoot()));
    if (!auth) throw new Error("delivery --dev-mint: no .cotal/auth here to mint from");
    console.error("⚠ delivery: --dev-mint — minting a scoped delivery cred from the LOCAL SIGNER (DEV ONLY; production mounts a pre-minted delivery.creds and the daemon never sees the signer)");
    return mintCreds(auth, newIdentity(), "delivery");
  }
  throw new Error(
    `delivery: no scoped creds at ${path}. Launch via \`cotal setup\`/\`cotal go\` (the setup helper mints + writes it), or pass --creds <file>; for a standalone dev run use --dev-mint.`,
  );
}

function parse(argv: string[]): Values {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      creds: { type: "string" },
      shard: { type: "string" },
      shards: { type: "string" },
      "dev-mint": { type: "boolean" }, // standalone dev: mint a scoped delivery cred from the local signer
    },
  });
  return values as Values;
}

/**
 * Run the delivery daemon: the server-side Plane-3 durable backstop. A thin composition root that
 * builds a scoped `delivery` endpoint, acquires the single-flight lease, and runs the existing
 * Plane-3 loops (`startPlane3`) — which ALSO serve the `ctl.delivery` runtime durable join/leave/list
 * ops. Runs from a PRE-MINTED scoped `delivery` cred and a `--space`; it does NOT load `.cotal/auth`
 * (no signer in the daemon's trust boundary) — minting is the CLI setup helper's job (or `--dev-mint`
 * for standalone dev). N=1 only — `shards > 1` (or a non-zero shard) is HARD-REJECTED (the partition
 * seam ships, operating sharded delivery is deferred to the channel-prefix grammar; see core-sub-fabric.md).
 */
export async function runDelivery(argv: string[]): Promise<void> {
  const v = parse(argv);
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

  if (!(await isReachable(server, { creds }))) {
    console.error(`✗ delivery: can't reach NATS at ${server}. Run: cotal up`);
    process.exit(1);
  }

  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false, // it pulls the Plane-3 consumers itself; no agent live-tail
    watchPresence: true, // read the roster for @mention resolution …
    registerPresence: false, // … but NEVER publish the daemon onto the roster (it's infra, not a peer)
    card: { name: "delivery", role: "delivery", kind: "endpoint" },
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

  // Host Plane-3 (fan-out writer + trusted reader) AND serve the ctl.delivery runtime durable ops. The
  // reader re-authorizes each entry against the durable ACL registry, read FRESH per entry.
  await ep.startPlane3((owner) => ep.aclForOwner(owner));
  // Flip the lease to READY only now — after the loops + ctl.delivery responder are bound — so readiness
  // waiters (ensureDelivery) and the cotal_channels health surface see "ready" iff the responder is up,
  // not merely that the single-flight slot was claimed.
  try { revision = await ep.markDeliveryLeaseReady(shard, revision); }
  catch { /* lost the lease between acquire and ready — the renew loop's CAS failure will exit us */ }
  console.log(`✓ delivery daemon up (space ${space}${shards > 1 ? `, shard ${shard}/${shards}` : ""}) — stop with: cotal down`);

  // Broker-sourced graph membership: a SEPARATE module on its OWN connections (system-account CONNZ
  // reader + data-account feed writer), isolated from Plane-3. Fail-soft — a missing cred / start error
  // logs and the graph degrades to traffic-only; Plane-3 delivery is never affected.
  let membership: MembershipFeedHandle | undefined;
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
    void isReachable(server, { creds })
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

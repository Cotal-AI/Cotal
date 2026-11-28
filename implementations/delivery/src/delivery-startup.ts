/** Start-up steps of the delivery daemon that read their inputs once and write nothing the daemon
 *  shares: the TLS requirement and reachability refusal, the single-flight lease acquire, and the
 *  reader of this shard's own lease row. runStartedDelivery calls them in its original order. */
import { isCasLoss, isPermissionDenied, isReachable, deliveryBucket, leaseKey, type CotalEndpoint, type SecretStore } from "@cotal-ai/core";
import { PermissionViolationError } from "@nats-io/transport-node";
import { workspaceErrorParts, type MeshTarget } from "@cotal-ai/workspace";
import type { Values } from "./delivery-creds.js";
import type { DeliveryLog } from "./delivery.js";
import type { LeaseReading } from "./watchdog.js";

/** What the reachability step reads; every field is final before it runs. */
export interface DeliveryReachDeps {
  v: Values;
  registered: MeshTarget | undefined;
  store: SecretStore | undefined;
  server: string;
  space: string;
  creds: { initial: string };
  log: DeliveryLog;
  held: boolean;
}

/** Decide whether TLS is required, say the dial target, and refuse an unreachable broker. Returns the TLS requirement. */
export async function requireReachableBroker(deps: DeliveryReachDeps): Promise<boolean> {
  const { v, registered, store, server, space, creds, log, held } = deps;
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
    log.err(
      registered !== undefined
        ? `• delivery: space "${space}" is registered at ${server} (meshes entry) - dialing it${tls ? " with TLS required" : ""}`
        : `• delivery: no meshes entry for "${space}" - dialing ${server}${v.server !== undefined ? " (--server)" : " (the local default)"}${tls ? " with TLS required" : ""}`,
    );
  if (!(await isReachable(server, { creds: creds.initial, ...(tls ? { tls: true } : {}) }))) {
    // The refusal names the URL actually dialed, and — when that URL came from a registry record —
    // the remedy that fits the record's origin, in the same wording render.ts uses for preflight
    // `unreachable`: an `up` record is THIS machine's mesh and `cotal up` restarts it; a `manual`
    // record is a broker elsewhere that only its own operator can start, so `Run: cotal up` here
    // would prescribe starting a DIFFERENT, local mesh under that name.
    if (registered !== undefined) {
      if (registered.origin === "manual" || registered.origin === "catalog") {
        const { message, remedy } = workspaceErrorParts({ kind: "preflight", failure: "unreachable", target: registered, pruned: false });
        log.err(`✗ delivery: ${message}${remedy ? `; ${remedy}` : ""}`);
      } else log.err(`✗ delivery: no mesh running at ${server} - mesh "${space}" is recorded at ${registered.root} but not running; run \`cotal up\` there to restart`);
      if (held) throw new Error(`delivery: no broker answered at ${server}`);
      process.exit(1);
    }
    log.err(`✗ delivery: can't reach NATS at ${server}. Run: \`cotal up\``);
    if (held) throw new Error(`delivery: can't reach NATS at ${server}`);
    process.exit(1);
  }
  return tls;
}

/** What the lease acquire reads; every field is final before it runs. */
export interface DeliveryLeaseDeps {
  ep: CotalEndpoint;
  shard: number;
  space: string;
  log: DeliveryLog;
  held: boolean;
}

/** Acquire this shard's single-flight lease, refusing loudly when it cannot. Returns the owned revision. */
export async function acquireShardLease(deps: DeliveryLeaseDeps): Promise<number> {
  const { ep, shard, space, log, held } = deps;
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
      log.err(`✗ delivery: a live lease already exists for shard ${shard} — another delivery daemon is running. Not binding.`);
    } else if (isPermissionDenied(e)) {
      const typed = e instanceof PermissionViolationError
        ? e
        : (e as { cause?: unknown } | null)?.cause instanceof PermissionViolationError
          ? (e as { cause: PermissionViolationError }).cause
          : undefined;
      const refused = typed
        ? `${typed.operation} "${typed.subject}"`
        : (e as Error).message;
      log.err(
        `✗ delivery: the lease write for shard ${shard} was refused (${refused}) — this credential ` +
          `cannot write ${deliveryBucket(space)}.${leaseKey(shard)}. Not binding. Use a credential ` +
          `holding the "delivery" profile.`,
      );
    } else {
      log.err(`✗ delivery: acquiring the lease for shard ${shard} failed: ${(e as Error).message}. Not binding.`);
    }
    await ep.stop();
    if (held) throw e;
    process.exit(1);
  }
  return revision;
}

/** What the own-lease reader reads; both are final before it is built. */
export interface DeliveryOwnLeaseDeps {
  ep: CotalEndpoint;
  shard: number;
}

/** Build the reader of this shard's own lease row. */
export function ownLeaseReader(deps: DeliveryOwnLeaseDeps): () => Promise<LeaseReading> {
  const { ep, shard } = deps;
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
  return readOwnLease;
}

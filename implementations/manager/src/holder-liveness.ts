/**
 * The gate reconciler's AFFIRMATIVE freeze-holder check (Cotal #391), over the delivery daemon's
 * `ctl.delivery-admin` rail — the READ twin of {@link makeManagerEndpointEvictor}, and deliberately
 * shaped like it so the two guards of the same repair read the same way.
 *
 * The `$SYS` CONNZ capability lives with the DELIVERY DAEMON (co-located with the broker), never in
 * a seed-holding process — the same D5 rail-split the evictor obeys. This reaches it with a
 * per-call SCOPED `endpoint-evictor` credential: pub the delivery-admin subject + reply +
 * `$JS.API.INFO`, nothing else. That credential names eviction because it is the rail's existing
 * scope; the VERB it calls here is read-only, and the daemon-side executor opens only the CONNZ
 * observer cred — the kick-capable evictor cred is never read on that path.
 *
 * EVERY FAILURE IS A REFUSAL, NEVER A PASS. Unlike the evictor — whose no-oracle case throws so the
 * barrier fails closed — this returns a STRUCTURED verdict, because the reconciler must tell the
 * operator WHICH condition refused. The mapping is total and there is no branch that infers death:
 *   - a reachable daemon's `live` / `gone` / `unknown` verdict passes through as-is;
 *   - a daemon refusal, an unreachable rail, or a REQUEST TIMEOUT is `unestablishable` — a timeout
 *     is the canonical "absence of evidence", and reading it as death is the exact defect this
 *     command exists to avoid;
 *   - a garbled reply, or one that does not ECHO the principal asked about, is `unestablishable` —
 *     a result that does not verifiably describe THIS principal never authorizes.
 *
 * Each query also reads the delivery lease (`lease.0`) before it is sent, and a refusal or an
 * unreachable rail reads it again, so the refusal names what is blocking the rail instead of always
 * advising a restart (#1062). Those reads are diagnostic only: they change the copy, never the verdict.
 */
import { CotalEndpoint, mintCreds, newIdentity, parsePrincipalLivenessResult, type DeliveryLeaseInfo, type SpaceAuth } from "@cotal-ai/core";
import type { HolderLiveness } from "./reconcile-gate.js";

/**
 * Map a delivery-admin reply to the reconciler's verdict — the whole trust-boundary decision, as
 * ONE pure function so the rail probe and the tests exercise the SAME mapping rather than two
 * copies that can drift. Every non-verdict is `unestablishable`; nothing here can yield `gone`
 * except an oracle that affirmatively said so under a complete sweep.
 */
export function holderLivenessFromReply(data: unknown, principal: string): HolderLiveness {
  // Closed + ECHO-BOUND parse: the reply crosses a trust boundary, and one that describes a
  // different principal (or no principal) tells us nothing about ours.
  const parsed = parsePrincipalLivenessResult(data, principal);
  if (parsed === undefined)
    return {
      state: "unestablishable",
      detail: `garbled or foreign liveness result (${JSON.stringify(data ?? null)}); a result that does not verifiably describe "${principal}" never authorizes`,
    };
  // An internally CONTRADICTORY success never authorizes: `gone` is (sweep complete, none remain),
  // so `gone` under an incomplete sweep is a broken oracle, not a verdict.
  if (parsed.state === "gone" && parsed.sweepComplete !== true)
    return {
      state: "unestablishable",
      detail: "the oracle reported gone with sweepComplete=false; a contradictory result never authorizes",
    };
  return {
    state: parsed.state,
    detail: `delivery-daemon CONNZ sweep, sweepComplete=${String(parsed.sweepComplete)}${parsed.note ? `: ${parsed.note}` : ""}`,
  };
}

/** What `lease.0` says about the daemon that should have answered. `absent` and `unreadable` stay
 *  apart for the reason `readDeliveryLeaseEntry` keeps them apart: a row that cannot be read is not
 *  evidence that nobody holds the shard. */
type DeliveryLeaseReading =
  | { state: "absent" }
  | { state: "unreadable"; error: string }
  | { state: "held"; lease: DeliveryLeaseInfo };

/** A lease time the diagnosis can print. Finite is not enough: `Date` stops at ±8.64e15 ms, and
 *  `toISOString()` throws past it. */
function isLeaseTime(t: unknown): t is number {
  return typeof t === "number" && !Number.isNaN(new Date(t).getTime());
}

function leaseTime(t: number, now: number): string {
  return `${new Date(t).toISOString()} (${Math.max(0, Math.round((now - t) / 1000))}s ago)`;
}

/** The lease row as facts. The row records no account, so the account named is the space account
 *  whose lease bucket holds it, the only account its writer can have authenticated in. */
function deliveryLeaseFacts(reading: DeliveryLeaseReading, account: string, now: number = Date.now()): string {
  if (reading.state === "absent") return "lease.0 is absent: no delivery daemon holds the shard";
  if (reading.state === "unreadable") return `lease.0 is unreadable (${reading.error})`;
  const { holder, acquiredAt, since, ready } = reading.lease;
  const acquired = acquiredAt === undefined ? "acquired at an unknown time (the row predates that field)" : `acquired ${leaseTime(acquiredAt, now)}`;
  return `lease.0 is held by "${holder}" (account ${account}), ${ready ? "ready" : "NOT ready"}, ${acquired}, row written ${leaseTime(since, now)}`;
}

/** Did one run of one daemon hold `lease.0` both before the query and after it failed? Only then can
 *  the holder read afterwards be the daemon that left the query unanswered. */
function sameLeaseHolder(before: DeliveryLeaseReading, after: DeliveryLeaseReading): boolean {
  return (
    before.state === "held" &&
    after.state === "held" &&
    before.lease.holder === after.lease.holder &&
    before.lease.incarnation === after.lease.incarnation
  );
}

/** Who to act on when the rail did not answer at all. Only an absent lease means no daemon is
 *  running; every other reading names something that starting another daemon would not fix. A
 *  holder that took the shard while the query was outstanding was never asked, so it is not named
 *  as the blocker. */
function unansweredRailBlocker(before: DeliveryLeaseReading, after: DeliveryLeaseReading): string {
  if (after.state === "absent") return "Start the delivery daemon (`cotal up` runs it) and re-run";
  if (after.state === "unreadable")
    return "The daemon that should answer cannot be named, so do not assume none is running: fix the lease read, then re-run";
  const { holder, ready } = after.lease;
  if (!sameLeaseHolder(before, after)) {
    const was = before.state === "held" ? `held by "${before.lease.holder}" (incarnation ${before.lease.incarnation ?? "unknown"})` : before.state;
    return `lease.0 was ${was} when the query was sent, so "${holder}" may not be the daemon that left it unanswered. Re-run before stopping anything`;
  }
  return ready
    ? `The blocker is "${holder}": it holds the shard as ready but did not answer. Stop or restart that process; another daemon cannot take the lease while it is held`
    : `The blocker is "${holder}": it claimed the shard and has not bound its rails. Wait for it to become ready, or stop it so its lease lapses, then re-run`;
}

/** Read `lease.0` under a per-call read-only `observer` credential, the profile `cotal status` reads
 *  it with; the evictor credential holds no lease read by design. Never throws: a failed read is
 *  itself a reading. */
async function readDeliveryLeaseForDiagnosis(opts: { space: string; servers: string; auth: SpaceAuth }): Promise<DeliveryLeaseReading> {
  const id = newIdentity();
  let ep: CotalEndpoint | undefined;
  try {
    ep = new CotalEndpoint({
      space: opts.space,
      servers: opts.servers,
      creds: await mintCreds(opts.auth, id, "observer", { expiresInSeconds: 60 }),
      card: { id: id.id, name: "manager-lease-diagnosis", kind: "endpoint" },
      channels: [],
      consume: false,
      watchChannels: false,
      watchPresence: false,
      registerPresence: false,
    });
    ep.on("error", () => {});
    await ep.start();
    const entry = await ep.readDeliveryLeaseEntry(0);
    if (!entry) return { state: "absent" };
    const { holder, acquiredAt, since, ready } = entry.info;
    if (typeof holder !== "string" || typeof ready !== "boolean" || !isLeaseTime(since) || (acquiredAt !== undefined && !isLeaseTime(acquiredAt)))
      return { state: "unreadable", error: `row is not a lease record: ${JSON.stringify(entry.info)}` };
    return { state: "held", lease: entry.info };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // No lease bucket means no daemon can hold the shard, the reading `cotal status --components` gives it.
    return /stream not found/i.test(error) ? { state: "absent" } : { state: "unreadable", error };
  } finally {
    await ep?.stop().catch(() => {});
  }
}

/** Build the reconciler's `probeHolder(principal) → verdict`. Per-call connection, exactly as the
 *  evictor does: a standing privileged connection would be a wider surface holding nothing. */
export function makeManagerHolderLivenessProbe(opts: {
  space: string;
  servers: string;
  auth: SpaceAuth;
  log: (line: string) => void;
}): (principal: string) => Promise<HolderLiveness> {
  return async (principal: string): Promise<HolderLiveness> => {
    // Read before the query so a failed query can be pinned to the holder it could have reached.
    const leaseBefore = await readDeliveryLeaseForDiagnosis(opts);
    const id = newIdentity();
    let ep: CotalEndpoint | undefined;
    try {
      const creds = await mintCreds(opts.auth, id, "endpoint-evictor", { expiresInSeconds: 60 });
      ep = new CotalEndpoint({
        space: opts.space,
        servers: opts.servers,
        creds,
        card: { id: id.id, name: "manager-holder-liveness", kind: "endpoint" },
        channels: [],
        consume: false,
        watchChannels: false,
        watchPresence: false,
        registerPresence: false,
      });
      ep.on("error", () => {});
      await ep.start();
      const r = await ep.requestDeliveryAdmin("principalLiveness", { principal }, 15_000);
      if (!r.ok)
        return {
          state: "unestablishable",
          detail: `the delivery daemon refused the liveness query: ${r.error ?? "(no error copy)"}; ${deliveryLeaseFacts(await readDeliveryLeaseForDiagnosis(opts), opts.auth.account.pub)}`,
        };
      const verdict = holderLivenessFromReply(r.data, principal);
      opts.log(`manager-holder-liveness: ${principal}: ${verdict.state} (${verdict.detail})`);
      return verdict;
    } catch (e) {
      // The rail is unreachable, or the request TIMED OUT. Both are UNKNOWABILITY, and neither is
      // death: this is the branch a mutation would have to corrupt to turn verify-dead into
      // assume-dead-on-timeout, and it is the reason the reconciler refuses instead of proceeding.
      const lease = await readDeliveryLeaseForDiagnosis(opts);
      return {
        state: "unestablishable",
        detail:
          `the delivery daemon is not reachable on the ctl.delivery-admin rail (${e instanceof Error ? e.message : String(e)}); ` +
          `${deliveryLeaseFacts(lease, opts.auth.account.pub)}. ${unansweredRailBlocker(leaseBefore, lease)}. ` +
          `Without the liveness oracle the freeze-holder "${principal}" cannot be proven gone, and this repair never infers death from silence`,
      };
    } finally {
      await ep?.stop().catch(() => {});
    }
  };
}

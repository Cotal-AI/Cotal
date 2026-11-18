import type { CotalEndpoint, ManagerLeaseInfo } from "@cotal-ai/core";
import { MANAGER_LEASE_TTL_MS, awaitLeaseExpiry, leaseRemainingMs, rejectionText } from "@cotal-ai/core";
import { probeLiveness } from "@cotal-ai/workspace";

/** How long a clean stop keeps trying to release its liveness lease when the broker does not answer
 *  (#3916). The client redials a lost broker every 2 s, so a connection dropped by an outage of up to
 *  about 3 s is back inside this budget. A longer outage is left to the row's TTL: the stop's other
 *  steps also wait on the broker, and the whole stop must still finish inside the 15 s a CLI stop
 *  waits before it sends SIGKILL. */
const LEASE_RELEASE_BUDGET_MS = 5_000;
/** The pause between lease release attempts that got no answer. An attempt that waits for its own
 *  deadline already spaces the retries; this only keeps one that fails at once, on a closed
 *  connection, from spinning. */
const LEASE_RELEASE_RETRY_MS = 250;

/** `start()`'s refusal when this manager instance's lease is held (#3915): by another live process
 *  on this workspace root, or by a holder on another root. A restart whose predecessor on this root
 *  is dead, this process's own earlier start included, waits the key out instead (#4092). The
 *  message is the operator copy; `held` and `sameRoot` are the data, so no caller parses it. A
 *  lease that could not be read or written is a plain `Error`. */
export class ManagerInstanceLeaseHeld extends Error {
  override readonly name = "ManagerInstanceLeaseHeld";
  constructor(
    message: string,
    readonly instanceId: string,
    readonly space: string,
    readonly held: ManagerLeaseInfo,
    readonly sameRoot: boolean,
  ) {
    super(message);
  }
}

type LeaseState = "held" | "held-unrenewed" | "gone" | "unknown";

/** What the lease keeper reads from its manager. Each is read when a call runs: `start()` assigns
 *  the endpoint and the instance id after construction, and `stopping` is the manager's stop fence. */
export interface LeaseKeeperDeps {
  endpoint: () => CotalEndpoint;
  instanceId: () => string;
  space: () => string;
  stopping: () => boolean;
}

/** This manager instance's liveness lease key: acquire it at start, renew it on a timer, release it
 *  on a clean stop. */
export class LeaseKeeper {
  leaseInfo?: Omit<ManagerLeaseInfo, "since">;
  leaseRevision?: number;
  leaseTimer?: ReturnType<typeof setInterval>;
  /** What the last renew tick learned about this instance's key. Only a CHANGE of state is printed
   *  (see {@link noteLease}), so an outage of hours is one line going in and one line coming out. */
  private leaseState: LeaseState = "held";
  /** A renew is in flight. The tick must not start a second one: both would read the same cached
   *  revision, so whichever lands second CASes against a sequence the first already moved. */
  private leaseRenewInFlight = false;
  /** The promise a currently in-flight `renewLease()` is running, so `stop()` can await it before
   *  releasing the key instead of racing it: a renew that lands after the cached revision was read
   *  for release would otherwise move the row out from under a same-cached-revision CAS delete. */
  leaseRenewTask?: Promise<void>;

  constructor(private readonly deps: LeaseKeeperDeps) {}

  private get ep(): CotalEndpoint { return this.deps.endpoint(); }
  private get managerInstanceId(): string { return this.deps.instanceId(); }
  private get space(): string { return this.deps.space(); }
  private get leaseStopping(): boolean { return this.deps.stopping(); }

  /** Create THIS instance's lease key, waiting out a dead predecessor's row first (#4092).
   *
   *  A manager SIGKILLed on this host cannot release its key, so a restart inside the key's TTL
   *  loses the create. When the row names this workspace root and a pid that is not running here
   *  (or is this process's own pid, which a live predecessor cannot hold), the holder is dead and
   *  the restart waits for the bucket TTL to remove the row, then creates again. It never writes
   *  over the row: a live holder renews it inside the TTL, and the wait then refuses on that write.
   *  Any other conflict refuses at once, as before. */
  async acquireInstanceLease(info: Omit<ManagerLeaseInfo, "since">): Promise<number> {
    const refuse = (held: ManagerLeaseInfo | undefined, e: unknown): Error => {
      if (!held) return new Error(`could not acquire the manager lease for space "${this.space}": ${rejectionText(e)}`);
      const sameRoot = held.root === info.root;
      return new ManagerInstanceLeaseHeld(
        `manager instance ${this.managerInstanceId} already serves space "${this.space}" from ${sameRoot ? "this" : "another"} workspace root (${held.runtime}, pid ${held.pid}, root ${held.root}) - stop it first before restarting the same instance`,
        this.managerInstanceId,
        this.space,
        held,
        sameRoot,
      );
    };
    try {
      return await this.ep.acquireManagerLease(info);
    } catch (e) {
      // Our OWN instance id already holds a live key ⇒ refuse. Anything else (e.g. a KV/JS error) is a
      // real failure to surface, not a silent "held" — keep the cause so it isn't misread as a conflict.
      const held = await this.ep.readOwnManagerLease(this.managerInstanceId).catch(() => undefined);
      if (!held || held.info.root !== info.root || (held.info.pid !== process.pid && probeLiveness(held.info.pid) !== "dead"))
        throw refuse(held?.info, e);
      console.error(
        `• manager instance ${this.managerInstanceId}: its lease is still held by pid ${held.info.pid}, which is not running on this host; ` +
          `waiting ${Math.ceil(leaseRemainingMs(held.created, MANAGER_LEASE_TTL_MS) / 1000)}s for the lease to expire`,
      );
      const waited = await awaitLeaseExpiry({
        read: async () => {
          const row = await this.ep.readOwnManagerLease(this.managerInstanceId);
          return row && { revision: row.revision, created: row.created };
        },
        revision: held.revision,
        created: held.created,
        ttlMs: MANAGER_LEASE_TTL_MS,
        aborted: () => this.leaseStopping,
      });
      if (waited === "rewritten")
        throw new Error(
          `manager instance ${this.managerInstanceId}: its lease was written again while waiting for pid ${held.info.pid}'s lease to expire, so a live process holds it - stop it first before restarting the same instance`,
        );
      if (waited !== "expired") throw refuse(held.info, e);
      try {
        return await this.ep.acquireManagerLease(info);
      } catch (again) {
        throw refuse((await this.ep.readOwnManagerLease(this.managerInstanceId).catch(() => undefined))?.info, again);
      }
    }
  }

  /** Release this instance's liveness lease key on a clean stop, at the broker's own revision
   *  rather than a cached one that a renew still in flight moments ago may have already moved past.
   *  Re-reads the row and releases only what is PROVABLY this process's (absent, or another pid's,
   *  is left alone — the same test {@link reconcileLease} uses).
   *
   *  A read or delete that gets no answer, as during a reconnect, is tried again until the delete is
   *  acknowledged or {@link LEASE_RELEASE_BUDGET_MS} has passed (#3916). Nothing here throws: a stop
   *  must complete either way, and a row that could not be released is left for the bucket TTL, with
   *  one line of warning so the cost (a same-root restart waiting out the TTL) is not silent. */
  async releaseOwnManagerLease(): Promise<void> {
    const deadline = Date.now() + LEASE_RELEASE_BUDGET_MS;
    for (;;) {
      let why: string;
      try {
        const own = await this.ep.readOwnManagerLease(this.managerInstanceId);
        if (own === undefined || own.info.pid !== process.pid) return;
        await this.ep.releaseManagerLease(this.managerInstanceId, own.revision);
        return;
      } catch (e) {
        why = rejectionText(e);
      }
      if (Date.now() >= deadline) {
        console.error(`! manager instance ${this.managerInstanceId} could not release its liveness lease (space "${this.space}"): ${why}; a same-root restart inside the bucket TTL will be refused`);
        return;
      }
      await new Promise((r) => setTimeout(r, LEASE_RELEASE_RETRY_MS));
    }
  }

  /** Keep this instance's liveness key fresh, and end the process only when another process holds it.
   *
   *  A renew that throws is a question, not a verdict: the request may have timed out with the write
   *  landed and only its acknowledgement lost, the key may have expired during a stall, or a same-id
   *  process may hold it. The verdict comes from RE-READING the key ({@link reconcileLease}), and each
   *  answer has one response:
   *  - `held`: adopt the broker's revision and carry on.
   *  - `gone`: the key expired or was released while this process was still here, so put it back. The
   *    create is atomic, so a same-id process that got there first shows up as `taken` next tick.
   *  - `taken`: a different process holds this instance's key, so it took this instance over while
   *    this one stalled. This process is the superseded one and stops serving by exiting (SPEC 13.1).
   *    An open mesh has no barrier that would evict its serve connection, so nothing else stops it.
   *  - `unknown`: the broker could not be asked. Keep serving and ask again next tick, for as long as it
   *    takes. A manager that cannot reach its broker gains nothing by ending itself, and the seats it
   *    holds lose everything (a pty child dies with its parent).
   *
   *  This replaces a fail-close that ended the process one tick past the lease TTL with no answer, which
   *  on a live mesh turned a ten-second broker or KV outage into a manager outage that lasted until an
   *  operator noticed. */
  async renewLease(): Promise<void> {
    // A manager that is stopping never puts its own key back: a stop already fenced this loop, and
    // any tick or explicit call landing after that must be a no-op, not a fresh acquire attempt.
    if (this.leaseStopping) return;
    // A renew that runs long must not be overlapped by the next tick: both would CAS against the same
    // cached revision, so whichever lands second is refused over a sequence the first legitimately
    // moved, a conflict this instance manufactured itself.
    if (this.leaseRenewInFlight) return;
    this.leaseRenewInFlight = true;
    const task = this.renewLeaseAttempt();
    this.leaseRenewTask = task;
    return task;
  }

  /** The renew attempt itself, split out from {@link renewLease} only so `stop()` can hold the
   *  promise a renew already in flight is running ({@link leaseRenewTask}) and await it before
   *  releasing the key: releasing against a cached revision a live renew has since moved is a CAS
   *  the broker correctly refuses, silently, forever. */
  async renewLeaseAttempt(): Promise<void> {
    try {
      if (!this.leaseInfo || this.leaseRevision === undefined) return;
      try {
        this.leaseRevision = await this.ep.renewManagerLease(this.leaseInfo, this.leaseRevision);
        this.noteLease("held", `renews its liveness lease again (revision ${this.leaseRevision})`);
        return;
      } catch (renewError) {
        const why = rejectionText(renewError);
        const verdict = await this.reconcileLease();
        switch (verdict.kind) {
          case "held":
            // The re-read is the broker's truth about the revision: adopt it, whether our write landed
            // with its acknowledgement lost (revision moved) or never landed (revision unchanged).
            this.leaseRevision = verdict.revision;
            this.noteLease("held-unrenewed", `could not renew its liveness lease (${why}) but the key is still its own at revision ${verdict.revision}; serving, retrying`);
            return;
          case "gone": {
            // A stop that began while this renew was already in flight fences it here too: the
            // await above can cross the point where `stop()` set the flag, and a re-acquire past
            // that point would put a stopping process's key straight back.
            if (this.leaseStopping) return;
            // The key being gone is a fact before the re-acquire is attempted, so a successful
            // re-acquire is a change of state (gone to held) and prints, every time it happens.
            const before = this.leaseState;
            this.leaseState = "gone";
            try {
              this.leaseRevision = await this.ep.acquireManagerLease(this.leaseInfo);
              this.noteLease("held", `found its liveness lease key gone (renew: ${why}) and re-acquired it at revision ${this.leaseRevision}`);
            } catch (e) {
              this.leaseState = before;
              this.noteLease("gone", `found its liveness lease key gone (renew: ${why}) and could not re-acquire it yet (${rejectionText(e)}); serving, retrying`);
            }
            return;
          }
          case "taken":
            // No `stop()` on the way out: its deregistration deletes the instance's current
            // registration, which is the other process's now. That process took over on the premise
            // that this one was gone, so this exit leaves what a crash would, and seats a custodian or
            // multiplexer owns outlive it the same way.
            console.error(`! manager instance ${this.managerInstanceId} finds its liveness lease key held by ${verdict.by}, not by this process (renew: ${why}); that process serves this instance now, so this one stops serving and exits (space "${this.space}")`);
            process.exit(1);
          case "unknown":
            this.noteLease("unknown", `could not renew its liveness lease (${why}) or re-read it (${verdict.why}); serving, retrying until the broker answers`);
            return;
        }
      }
    } finally {
      this.leaseRenewInFlight = false;
    }
  }

  /** Print `what` only when the lease state CHANGES. The renew ticks every few seconds, so a long
   *  outage would otherwise print the same line thousands of times; an operator needs the line going
   *  in and the line coming out, with the instance and the space on both. */
  private noteLease(state: LeaseState, what: string): void {
    if (state === this.leaseState) return;
    this.leaseState = state;
    console.error(`${state === "held" ? "✓" : "!"} manager instance ${this.managerInstanceId} ${what} (space "${this.space}")`);
  }

  /** What the broker actually says about THIS instance's lease key, right now. `unknown` is a first-class
   *  answer and never collapses into `gone`: not being able to look is not the same fact as looking and
   *  finding nothing. */
  private async reconcileLease(): Promise<
    | { kind: "held"; revision: number }
    | { kind: "gone" }
    | { kind: "taken"; by: string }
    | { kind: "unknown"; why: string }
  > {
    let current: Awaited<ReturnType<CotalEndpoint["readOwnManagerLease"]>>;
    try {
      current = await this.ep.readOwnManagerLease(this.managerInstanceId);
    } catch (e) {
      return { kind: "unknown", why: rejectionText(e) };
    }
    if (current === undefined) return { kind: "gone" };
    // The pid is what distinguishes US from a same-id restart: the logical instance id and the serve
    // identity both PERSIST across restart by design, so neither can tell the two processes apart.
    if (current.info.pid !== process.pid) return { kind: "taken", by: `pid ${current.info.pid} (${current.info.runtime}, root ${current.info.root})` };
    return { kind: "held", revision: current.revision };
  }
}

import type { NatsConnection } from "@nats-io/transport-node";

/** How long one stop waits on the broker across its dedicated connections (serve, deregistration,
 *  goal-writer, session-ledger) before it closes them instead (#3972, #4013). A healthy drain takes
 *  milliseconds. A frozen broker never answers a drain's flush, so without a bound the stop would last
 *  until the client's stale-ping check, minutes later. Shared, so the whole stop still fits the CLI's
 *  15 s stop grace next to the lease release and the shared endpoint's own bounded teardown. */
export const STOP_BROKER_BUDGET_MS = 2_000;
/** The least each of those steps gets, so a slow first drain cannot leave a later one no time at all. */
const STOP_BROKER_FLOOR_MS = 250;

/** What is left of a stop's broker budget that ends at `until`, never under the floor. */
export function stopBrokerWait(until: number): number {
  return Math.max(STOP_BROKER_FLOOR_MS, until - Date.now());
}

/** Whether each watched connection's transport is down while the client reconnects it. Such a
 *  connection is open (`isClosed()` is false under unbounded reconnects) yet the broker holds none of
 *  its rails. Keyed by the connection, so a re-dial that swaps in a fresh one starts from its own state. */
export class TransportWatch {
  private readonly down = new WeakSet<NatsConnection>();
  private readonly waiters = new WeakMap<NatsConnection, Set<() => void>>();

  /** Track `nc` from the first moment: nats.js reports `disconnect` when the socket drops and
   *  `reconnect` only after it has re-sent the connection's subscriptions. If the status stream itself
   *  fails, the transport can no longer be observed, so it counts as down. */
  watch(nc: NatsConnection): void {
    void (async () => {
      for await (const st of nc.status()) {
        if (st.type === "disconnect") this.markDown(nc);
        else if (st.type === "reconnect") this.down.delete(nc);
      }
    })().catch(() => this.markDown(nc));
  }

  isDown(nc: NatsConnection): boolean {
    return this.down.has(nc);
  }

  /** Call `fn` once when `nc` next goes down. Returns the cancel. */
  onDown(nc: NatsConnection, fn: () => void): () => void {
    let set = this.waiters.get(nc);
    if (!set) this.waiters.set(nc, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  private markDown(nc: NatsConnection): void {
    this.down.add(nc);
    const set = this.waiters.get(nc);
    this.waiters.delete(nc);
    for (const fn of set ?? []) fn();
  }
}

/** Retire a dedicated connection at stop: run `graceful` (a drain by default), and close the
 *  connection instead when its transport is down, drops while `graceful` runs, or `graceful` gets no
 *  answer within `waitMs`. A drain on a reconnecting connection does not fail, it waits for the
 *  reconnect, so a one-time state check alone would still hang on a drop that lands after it.
 *
 *  Resolves only when `graceful` finished. Otherwise it throws after the close, because whatever the
 *  connection had not yet flushed to the broker was dropped. The close ends every write this
 *  connection could still make, so nothing it carries outlives the stop. */
export async function retireConnection(
  nc: NatsConnection,
  label: string,
  opts: { waitMs: number; watch?: TransportWatch; graceful?: () => Promise<void> },
): Promise<void> {
  if (nc.isClosed()) return;
  const cut = async (why: string): Promise<never> => {
    await nc.close().catch(() => {});
    throw new Error(`${label} connection ${why}, so it was closed and anything it had not yet flushed to the broker was dropped`);
  };
  if (opts.watch?.isDown(nc)) return cut("was down at stop");
  const { waitMs } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelDown = (): void => {};
  const graceful = (opts.graceful ?? (() => nc.drain()))();
  const outcome = await Promise.race([
    graceful.then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, why: `failed to drain (${e instanceof Error ? e.message : String(e)})` })),
    new Promise<{ ok: false; why: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, why: `got no broker answer within ${waitMs} ms` }), waitMs);
      if (opts.watch) cancelDown = opts.watch.onDown(nc, () => resolve({ ok: false, why: "went down during its drain" }));
    }),
  ]);
  clearTimeout(timer);
  cancelDown();
  if (!outcome.ok) return cut(outcome.why);
}

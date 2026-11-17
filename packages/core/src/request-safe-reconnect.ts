import type { NatsConnection } from "@nats-io/transport-node";

const reconnects = new WeakMap<NatsConnection, Promise<void>>();

/** Refresh the same transport after at most five seconds waiting for outgoing requests.
 * A busy connection is retained. During native reconnect, new requests wait before their first
 * send, within their original timeout budget. No request is replayed. Named-reply users must
 * supply their pending count because those requests are outside the native multiplexer. */
export function requestSafeReconnect(nc: NatsConnection, additionalPending: () => number = () => 0): Promise<void> {
  const active = reconnects.get(nc);
  if (active) return active;
  const refresh = reconnectOnce(nc, additionalPending).finally(() => { reconnects.delete(nc); });
  reconnects.set(nc, refresh);
  return refresh;
}

async function reconnectOnce(nc: NatsConnection, additionalPending: () => number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (nc.isClosed()) throw new Error("credential reconnect: connection already closed");
    const mux = (nc as unknown as { protocol?: { muxSubscriptions?: { size?: () => number } } }).protocol?.muxSubscriptions;
    if (typeof mux?.size !== "function")
      throw new Error("credential reconnect: native request multiplexer unavailable; connection retained");
    if (mux.size() + additionalPending() === 0) break;
    if (Date.now() >= deadline)
      throw new Error("credential reconnect: outgoing requests remained busy for 5000ms; connection retained, refresh must be retried");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  // Native reconnect returns before disconnect/prepare. Requests in that gap can be discarded.
  // Install the admission gate in the same synchronous turn as the quiet observation above.
  const original = nc.request;
  const statuses = nc.status()[Symbol.asyncIterator]();
  let ready!: () => void;
  let failed!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  void gate.catch(() => {});
  const timer = setTimeout(() => failed(new Error("credential reconnect: native readiness exceeded 5000ms; new requests were not sent")), 5_000);
  const gated: NatsConnection["request"] = async (subject, data, opts) => {
    const start = Date.now();
    const budget = opts?.timeout || 1_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([gate, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("credential reconnect: request deadline elapsed before initial send")), budget);
      })]);
      const remaining = budget - (Date.now() - start);
      if (remaining <= 0) throw new Error("credential reconnect: request deadline elapsed before initial send");
      return await original.call(nc, subject, data, { ...opts, timeout: remaining });
    } finally { clearTimeout(timeout); }
  };
  nc.request = gated;
  const watch = (async () => {
    for (;;) {
      const next = await statuses.next();
      if (next.done) break;
      if (next.value.type === "reconnect") { ready(); return; }
    }
    failed(new Error("credential reconnect: connection closed before native readiness"));
  })();
  void watch.catch((error: unknown) => failed(error instanceof Error ? error : new Error(String(error))));
  try {
    await nc.reconnect();
    await gate;
  } catch (error) {
    failed(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    clearTimeout(timer);
    if (nc.request === gated) nc.request = original;
    await statuses.return?.();
  }
}

import type { NatsConnection } from "@nats-io/transport-node";

/** One owned connection's terminal state. Reconnecting disconnects are not terminal ends. */
export interface AuthConnectionState {
  label: string;
  ended: boolean;
}

/** The terminal inventory. A failed close leaves this signal pending while any client is live. */
export interface AuthServiceClosed {
  connections: AuthConnectionState[];
}

/** Context-local custody, including short-lived clients and replaced readiness readers. */
export class OwnedConnections {
  private readonly clients: Array<{ nc?: NatsConnection; state: AuthConnectionState }> = [];
  private readonly seen = new WeakSet<NatsConnection>();
  private completed = false;
  private resolve!: (result: AuthServiceClosed) => void;
  readonly closed = new Promise<AuthServiceClosed>((resolve) => { this.resolve = resolve; });

  track(nc: NatsConnection, label: string): void {
    if (this.seen.has(nc)) return;
    this.seen.add(nc);
    const state = { label, ended: false };
    const client = { nc: nc as NatsConnection | undefined, state };
    this.clients.push(client);
    void nc.closed().then(() => {
      state.ended = true;
      client.nc = undefined;
      this.settle();
    });
  }

  connections(): AuthConnectionState[] {
    return this.clients.map(({ state }) => ({ ...state }));
  }

  complete(): void {
    this.completed = true;
    this.settle();
  }

  private settle(): void {
    if (this.completed && this.clients.every(({ state }) => state.ended))
      this.resolve({ connections: this.connections() });
  }

  /** Called only after the plane's scanner/release/barrier close order has completed. */
  async closeRemaining(): Promise<void> {
    const errors: Error[] = [];
    await Promise.all(this.clients.map(async ({ nc, state }) => {
      if (state.ended || nc === undefined) return;
      try { await nc.close(); }
      catch (cause) { errors.push(new Error(`auth connection ${state.label} failed to close`, { cause })); }
    }));
    if (errors.length) throw new AggregateError(errors, `auth connection close failed: ${errors.map((e) => e.message).join(", ")}`);
  }
}

/**
 * The daemon side of the endpoints the delivery daemon serves (A1): which endpoints it was asked to
 * serve, where each one's material comes from, and the delivery-admin hooks that adopt and report.
 *
 * Opt-in only (plan section 2, C4). A daemon started without `--serve` (or a hosted context without
 * `endpoints`) builds none of this, serves nothing new and opens no new connection. A daemon asked to
 * serve an endpoint starts with it `unbound`: it binds Plane-3 and the delivery-admin rail first, so
 * the signer holder's registration barrier has its eviction oracle, and binds the endpoint only when the
 * signer holder asks it to adopt a freshly minted serve credential.
 *
 * The daemon never holds a grant from the store. On every adoption it re-reads the serve credential, the
 * instance id and the serve nkey's public half, then re-derives the grant from leader reads
 * (`endpoint-bind.ts`).
 */
import type { JetStreamManager } from "@nats-io/jetstream";
import type { CotalEndpoint, NativeConnectionBinding, SecretStore } from "@cotal-ai/core";
import { daemonEndpointKey, DAEMON_ENDPOINT_SERVE_CREDS_KIND, readDaemonEndpointInstanceId, readDaemonEndpointServeId } from "@cotal-ai/workspace";
import { DaemonEndpointBinder, type DaemonServedEndpoint, type ServeState } from "./endpoint-bind.js";

/** Every endpoint a delivery daemon knows how to serve, by name. A name outside this table is refused
 *  at start, before anything dials. Each factory gets what it needs to open its own connections. */
export type ServedEndpointCatalog = Readonly<Record<string, (ctx: ServedEndpointContext) => DaemonServedEndpoint>>;

/** What a served endpoint's factory is handed: where to dial, the store holding its material, the
 *  daemon's own endpoint for fresh ACL reads, and the daemon's log. */
export interface ServedEndpointContext {
  space: string;
  servers: string;
  tls: boolean;
  store: SecretStore;
  /** The daemon's delivery endpoint: the live read ACL by alias rides its connection. */
  delivery: Pick<CotalEndpoint, "aclForAlias">;
  /** The daemon's delivery connection's JetStream manager, for the leader reads the delivery
   *  credential holds (confirm-attach's chat entry). Throws before the first adoption. */
  deliveryJsm: () => JetStreamManager;
  log: (line: string) => void;
}

/** Parse `--serve <a,b>` into endpoint names: deduplicated, each one in the catalog. */
export function parseServeFlag(raw: string | undefined, catalog: ServedEndpointCatalog): string[] {
  if (raw === undefined) return [];
  const names = raw.split(",").map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length === 0) throw new Error("delivery: --serve needs an endpoint name (for example --serve artifacts)");
  const unknown = names.filter((n) => !Object.hasOwn(catalog, n));
  if (unknown.length)
    throw new Error(`delivery: --serve ${unknown.join(",")}: this daemon serves only ${Object.keys(catalog).join(", ") || "no endpoint"}`);
  return [...new Set(names)];
}

/** The daemon's served endpoints: one binder each, and the two delivery-admin hooks. */
export class ServedEndpoints {
  private readonly binders = new Map<string, DaemonEndpointBinder>();

  /** The daemon's delivery connection's JetStream manager, as the last adoption handed it over. */
  private deliveryJsm: JetStreamManager | undefined;

  constructor(private readonly opts: {
    space: string;
    servers: string;
    tls: boolean;
    names: readonly string[];
    catalog: ServedEndpointCatalog;
    /** The store the signer holder writes each endpoint's material to: the delivery cred's store. */
    store: SecretStore;
    delivery: Pick<CotalEndpoint, "aclForAlias">;
    log: (line: string) => void;
  }) {
    const ctx: ServedEndpointContext = {
      space: opts.space, servers: opts.servers, tls: opts.tls, store: opts.store, delivery: opts.delivery, log: opts.log,
      deliveryJsm: () => {
        if (this.deliveryJsm === undefined) throw new Error("the delivery connection has not handed over its JetStream manager yet");
        return this.deliveryJsm;
      },
    };
    for (const name of opts.names) {
      const factory = opts.catalog[name];
      if (factory === undefined) throw new Error(`delivery: no served endpoint named ${name}`);
      this.binders.set(name, new DaemonEndpointBinder({
        space: opts.space, servers: opts.servers, tls: opts.tls, endpoint: factory(ctx), log: opts.log,
      }));
    }
  }

  get names(): string[] {
    return [...this.binders.keys()];
  }

  private binder(endpoint: string): DaemonEndpointBinder {
    const binder = this.binders.get(endpoint);
    if (binder === undefined)
      throw new Error(`this daemon does not serve ${endpoint}${this.binders.size ? ` (it serves ${this.names.join(", ")})` : ""}`);
    return binder;
  }

  /** delivery-admin `adoptEndpointCreds`: re-read the endpoint's material and bind it. `jsm` is the
   *  daemon's own connection's manager; the bind's gate and spec reads ride it, and so do the handlers'
   *  delivery-connection reads (confirm-attach's chat entry), through {@link ServedEndpointContext.deliveryJsm}. */
  async adopt(endpoint: string, adoptionOpId: string, jsm: JetStreamManager): Promise<ServeState> {
    this.deliveryJsm = jsm;
    const binder = this.binder(endpoint);
    const { store, space } = this.opts;
    const [creds, instanceId, serveId] = await Promise.all([
      store.get(daemonEndpointKey(space, endpoint, DAEMON_ENDPOINT_SERVE_CREDS_KIND)),
      readDaemonEndpointInstanceId(store, space, endpoint),
      readDaemonEndpointServeId(store, space, endpoint),
    ]);
    if (creds === undefined || instanceId === undefined || serveId === undefined)
      throw new Error(`${endpoint}: the signer holder has not registered it yet (no ${[creds === undefined ? "serve credential" : "", instanceId === undefined ? "instance id" : "", serveId === undefined ? "serve identity" : ""].filter(Boolean).join(", ")}); nothing adopted`);
    return binder.adopt({ creds, instanceId, serveId, adoptionOpId, jsm });
  }

  /** delivery-admin `serveState`. */
  state(endpoint: string): ReturnType<DaemonEndpointBinder["serveState"]> {
    return this.binder(endpoint).serveState();
  }

  /** The startup line: what was asked for and what is bound. */
  describe(): string {
    return this.names.map((n) => {
      const s = this.binder(n).serveState();
      return s.bound ? `${n} bound at epoch ${s.state.epoch}` : `${n} unbound (${s.cause})`;
    }).join("; ");
  }

  async quiesce(cause: string): Promise<void> {
    await Promise.all([...this.binders.values()].map((b) => b.quiesce(cause)));
  }

  leaseRegained(): void {
    for (const b of this.binders.values()) b.leaseRegained();
  }

  nativeConnections(): { label: string; binding: NativeConnectionBinding }[] {
    return [...this.binders.values()].flatMap((b) => b.nativeConnections());
  }

  async close(): Promise<void> {
    await Promise.all([...this.binders.values()].map((b) => b.close()));
  }
}

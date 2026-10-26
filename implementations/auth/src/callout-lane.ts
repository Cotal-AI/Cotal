/**
 * One space's membership of its `cotal-auth-callout` queue group: the connections, the authority
 * hooks and the callout subscription that answer that space's connects, with no process-level
 * concern of its own. A lane installs no signal handler and never exits the process, so one process
 * may hold a lane per space ({@link runCalloutHost}) or exactly one ({@link runAuthCalloutReplica}).
 *
 * A lane's signing material is bound to its closure: {@link serveCallout} passes this space's xkey,
 * auth account and data account into `startAuthCallout`, which captures them for the life of the
 * subscription. Nothing maps a space to a key at request time. The broker's own account isolation
 * decides which lane sees a request: the callout connection authenticates as this space's auth
 * account's only `auth_users` entry, and a NATS account is a disjoint subject namespace, so another
 * space's `$SYS.REQ.USER.AUTH` request cannot be delivered on it.
 *
 * A lane that loses a store connection or the broker closes itself and settles {@link CalloutLane.lost}.
 * It never answers a connect it cannot authorize from live reads.
 */
import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { dialerFor, EpEnvelopeError, holdIssuerSession, isReachable, type SecretStore } from "@cotal-ai/core";
import { loadManagerInstanceIdentity, userAuthStateDir } from "@cotal-ai/workspace";
import { calloutReplicaGrants, openAuthorityClient, type AuthorityClient } from "./authority-client.js";
import { calloutAuthority, managerGateReads, serveCallout } from "./callout-authority.js";
import type { AuthCalloutLimits } from "./callout.js";
import { chatConnectAuthority } from "./chat-session-authority.js";
import { authConnectReaderGrants, openConnectReader } from "./connect-reader.js";
import { openLifecycleRegistry, registryStores } from "./lifecycle-registry.js";
import { ADMISSION_KEY, parseServiceAdmissionRecord } from "./service-host-ops.js";
import { dataAccountAuth, loadCalloutAuth, loadIssuer, loadServiceKeys, spaceIssuer } from "./store.js";

/** What one space's callout membership exposes to whoever holds it. */
export interface CalloutLane {
  readonly space: string;
  /** Settles with what this lane lost once it stops answering, by {@link close} or by a loss. It
   *  never rejects: a holder distinguishes the two by whether it asked for the close. */
  readonly lost: Promise<string>;
  /** Stop answering and release every connection, the callout connection first so the broker routes
   *  this space around the lane before its authority reads go. Safe to call more than once. */
  close(): Promise<void>;
}

/** Everything a lane needs. `secrets` is the one store a host opens for every space it serves. */
export interface CalloutLaneOptions {
  space: string;
  server: string;
  root: string;
  secrets: SecretStore;
  limits?: AuthCalloutLimits;
  /** Diagnostics sink. Default `console.error`. Lines already name their space. */
  log?: (line: string) => void;
}

/** Open one space's callout membership. Throws before holding anything when the space's material is
 *  missing, its issuer pin disagrees with its name, the broker is unreachable with its callout creds,
 *  or the space admits service endpoints, which a callout membership cannot issue. */
export async function openCalloutLane(options: CalloutLaneOptions): Promise<CalloutLane> {
  const { space, server, root, secrets } = options;
  const dir = userAuthStateDir(root, space);
  const log = options.log ?? ((l: string) => console.error(l));
  const keys = await loadServiceKeys(secrets, space);
  const callout = await loadCalloutAuth(secrets, space);
  const issuer = await loadIssuer(secrets, space);
  if (!keys || !callout || !issuer) {
    const missing = [...(keys ? [] : ["service keys"]), ...(callout ? [] : ["callout account"]), ...(issuer ? [] : ["issuer keys"])];
    throw new Error(`auth-service --callout-only: user-auth material is missing (${missing.join(", ")}) for space "${space}" - a replica serves a space whose auth service is already provisioned`);
  }
  if (issuer.issuer !== spaceIssuer(space))
    throw new Error(`auth-service --callout-only: issuer pin ${issuer.issuer} does not match space "${space}"`);
  if (!(await isReachable(server, { creds: callout.calloutCreds })))
    throw new Error(`auth-service --callout-only: can't reach the broker at ${server} with the callout creds for space "${space}" - is the mesh up?`);

  const dataAccount = { pub: keys.dataAccount.pub, signingSeed: keys.dataAccount.signingSeed };
  let stopping = false;
  let settle!: (what: string) => void;
  const lost = new Promise<string>((resolve) => { settle = resolve; });
  const clients: AuthorityClient[] = [];
  let calloutNc: NatsConnection | undefined;
  // This lane's own held issuer session for user-caller issuance (SPEC 13.15). It is one session per
  // account, space and authority plane, private to this lane and never shared with another space's.
  const issuerSession = holdIssuerSession({ servers: server, space, auth: dataAccountAuth(space, dataAccount), tls: false, name: `cotal:auth-replica-issuer:${space}` });
  const closeAll = async (): Promise<void> => {
    // The callout connection goes first: from then on the queue group routes around this lane.
    await calloutNc?.close().catch(() => {});
    await issuerSession.close();
    for (const c of clients) await c.close().catch(() => {});
  };
  /** The one path off the answering state, for a loss and for a deliberate close alike. */
  const end = (what: string): void => {
    if (stopping) return;
    stopping = true;
    void closeAll().then(() => settle(what));
  };
  try {
    const open = async (label: string, grants: (connId: string) => { publish: string[]; subscribe: string[] }) => {
      const client = await openAuthorityClient({ server, space, dataAccount, label, grants, log, onRenewalFailure: () => end(`${label} credential renewal`) });
      clients.push(client);
      return client;
    };
    const stores = await open(`cotal:auth-replica-store:${space}`, (id) => calloutReplicaGrants(space, id));
    const readerClient = await open(`cotal:auth-replica-reader:${space}`, (id) => authConnectReaderGrants(space, id));
    const registry = await openLifecycleRegistry(stores.nc, space);
    // A lane cannot issue a service-endpoint connection, so in a space that admits them it would
    // deny the service connects the broker routes to it. It refuses to open there instead.
    const admission = await registryStores(registry).authKv.get(ADMISSION_KEY);
    if (admission?.operation === "PUT" && parseServiceAdmissionRecord(admission.json()).state === "open")
      throw new Error(`auth-service --callout-only: space "${space}" admits service endpoints (its auth service runs with --service-endpoints), and a callout replica cannot issue a service-endpoint connection - serve no lane for this space`);
    const reader = await openConnectReader(readerClient.nc, space);
    const recordsJsm = await jetstreamManager(stores.nc);
    const hooks = calloutAuthority({
      space, issuer: issuerSession, dir, dataAccount, registry, reader: () => reader,
      chat: chatConnectAuthority({ space, dir, registry, now: Date.now }),
      gate: managerGateReads({ space, authKv: registryStores(registry).authKv, recordsJsm, localManager: () => loadManagerInstanceIdentity(root, space) }),
      recordsJsm,
      refuse: () => {
        if (stopping) throw new EpEnvelopeError("unavailable", `this auth callout lane for space "${space}" is stopping; retry shortly`);
      },
    });
    calloutNc = await dialerFor(server)({
      servers: server,
      authenticator: credsAuthenticator(new TextEncoder().encode(callout.calloutCreds)),
      name: `cotal:auth-callout-replica:${space}`,
    });
    // This space's signing material enters the request path here and nowhere else.
    serveCallout(calloutNc as never, { space, dir, callout, dataAccount, issuer, hooks, ...(options.limits !== undefined ? { limits: options.limits } : {}) });
    await calloutNc.flush();
  } catch (e) {
    stopping = true;
    await closeAll();
    throw e;
  }

  // Any loss of a store connection ends this lane: it never rides a disconnect while answering,
  // because a connect it cannot read the ledger for would be denied rather than routed on.
  for (const c of clients) {
    void (async () => {
      for await (const s of c.nc.status()) if (s.type === "disconnect") end("its store connection");
    })();
    void c.nc.closed().then(() => end("its store connection"));
  }
  void calloutNc.closed().then(() => end("its broker connection"));

  return {
    space,
    lost,
    close: async () => {
      end("a deliberate close");
      await lost;
    },
  };
}

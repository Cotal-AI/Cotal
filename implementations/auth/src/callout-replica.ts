/**
 * The callout-only replica (`cotal auth-service --callout-only`): one more member of the space's
 * `cotal-auth-callout` queue group, for availability and horizontal scale. It answers connects
 * with the same hooks as the full auth service ({@link calloutAuthority}) and holds nothing else:
 * no HTTP listener, no `auth-service.json`, no plane claim, no service registration, scanners,
 * barrier, evictor, pruning or sweeps. Its store connection holds {@link calloutReplicaGrants}.
 *
 * A replica that loses a store connection or the broker stops answering and exits non-zero, so the
 * broker routes every later callout to the other members. It never answers a connect it cannot
 * authorize from live reads.
 */
import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { dialerFor, EpEnvelopeError, holdIssuerSession, isReachable, type SecretStore } from "@cotal-ai/core";
import { loadManagerInstanceIdentity, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { calloutReplicaGrants, openAuthorityClient, type AuthorityClient } from "./authority-client.js";
import { calloutAuthority, managerGateReads, serveCallout } from "./callout-authority.js";
import type { AuthCalloutLimits } from "./callout.js";
import { chatConnectAuthority } from "./chat-session-authority.js";
import { authConnectReaderGrants, openConnectReader } from "./connect-reader.js";
import { openLifecycleRegistry, registryStores } from "./lifecycle-registry.js";
import { ADMISSION_KEY, parseServiceAdmissionRecord } from "./service-host-ops.js";
import { dataAccountAuth, loadCalloutAuth, loadIssuer, loadServiceKeys, spaceIssuer } from "./store.js";

/** Run one callout replica for `space` until a signal or a lost connection ends it. `limits` are the
 *  full service's: the broker's timeout is one value for every member of the queue group. */
export async function runAuthCalloutReplica(args: { space: string; server: string; root: string; limits?: AuthCalloutLimits }, store?: SecretStore): Promise<void> {
  const { space, server, root } = args;
  const dir = userAuthStateDir(root, space);
  const secrets = store ?? workspaceSecretStore(root);
  const keys = await loadServiceKeys(secrets, space);
  const callout = await loadCalloutAuth(secrets, space);
  const issuer = await loadIssuer(secrets, space);
  if (!keys || !callout || !issuer) {
    const missing = [...(keys ? [] : ["service keys"]), ...(callout ? [] : ["callout account"]), ...(issuer ? [] : ["issuer keys"])];
    throw new Error(`auth-service --callout-only: user-auth material is missing (${missing.join(", ")}) - a replica serves a space whose auth service is already provisioned`);
  }
  if (issuer.issuer !== spaceIssuer(space))
    throw new Error(`auth-service --callout-only: issuer pin ${issuer.issuer} does not match space "${space}"`);
  if (!(await isReachable(server, { creds: callout.calloutCreds })))
    throw new Error(`auth-service --callout-only: can't reach the broker at ${server} with the callout creds - is the mesh up?`);

  const log = (l: string) => console.error(l);
  const dataAccount = { pub: keys.dataAccount.pub, signingSeed: keys.dataAccount.signingSeed };
  let stopping = false;
  let lose: (what: string) => void = () => {};
  const clients: AuthorityClient[] = [];
  let calloutNc: NatsConnection | undefined;
  // This replica's own held issuer session for user-caller issuance (SPEC 13.15).
  const issuerSession = holdIssuerSession({ servers: server, space, auth: dataAccountAuth(space, dataAccount), tls: false, name: `cotal:auth-replica-issuer:${space}` });
  const closeAll = async (): Promise<void> => {
    // The callout connection goes first: from then on the queue group routes around this replica.
    await calloutNc?.close().catch(() => {});
    await issuerSession.close();
    for (const c of clients) await c.close().catch(() => {});
  };
  try {
    const open = async (label: string, grants: (connId: string) => { publish: string[]; subscribe: string[] }) => {
      const client = await openAuthorityClient({ server, space, dataAccount, label, grants, log, onRenewalFailure: () => lose(`${label} credential renewal`) });
      clients.push(client);
      return client;
    };
    const stores = await open(`cotal:auth-replica-store:${space}`, (id) => calloutReplicaGrants(space, id));
    const readerClient = await open(`cotal:auth-replica-reader:${space}`, (id) => authConnectReaderGrants(space, id));
    const registry = await openLifecycleRegistry(stores.nc, space);
    // A replica cannot issue a service-endpoint connection, so in a space that admits them it would
    // deny the service connects the broker routes to it. It refuses to start there instead.
    const admission = await registryStores(registry).authKv.get(ADMISSION_KEY);
    if (admission?.operation === "PUT" && parseServiceAdmissionRecord(admission.json()).state === "open")
      throw new Error(`auth-service --callout-only: space "${space}" admits service endpoints (its auth service runs with --service-endpoints), and a callout replica cannot issue a service-endpoint connection - run no replica for this space`);
    const reader = await openConnectReader(readerClient.nc, space);
    const recordsJsm = await jetstreamManager(stores.nc);
    const hooks = calloutAuthority({
      space, issuer: issuerSession, dir, dataAccount, registry, reader: () => reader,
      chat: chatConnectAuthority({ space, dir, registry, now: Date.now }),
      gate: managerGateReads({ space, authKv: registryStores(registry).authKv, recordsJsm, localManager: () => loadManagerInstanceIdentity(root, space) }),
      recordsJsm,
      refuse: () => {
        if (stopping) throw new EpEnvelopeError("unavailable", `this auth callout replica for space "${space}" is stopping; retry shortly`);
      },
    });
    calloutNc = await dialerFor(server)({
      servers: server,
      authenticator: credsAuthenticator(new TextEncoder().encode(callout.calloutCreds)),
      name: `cotal:auth-callout-replica:${space}`,
    });
    serveCallout(calloutNc as never, { space, dir, callout, dataAccount, issuer, hooks, ...(args.limits !== undefined ? { limits: args.limits } : {}) });
    await calloutNc.flush();
  } catch (e) {
    await closeAll();
    throw e;
  }

  const ended = new Promise<number>((resolve) => {
    lose = (what) => {
      if (stopping) return;
      stopping = true;
      log(`✗ auth-service --callout-only: lost ${what} - stopped answering the callout; exiting`);
      void closeAll().then(() => resolve(1));
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void closeAll().then(() => resolve(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  // Any loss of a store connection is the end of this replica: it never rides a disconnect while
  // answering, because a connect it cannot read the ledger for would be denied rather than routed on.
  for (const c of clients) {
    void (async () => {
      for await (const s of c.nc.status()) if (s.type === "disconnect") lose("its store connection");
    })();
    void c.nc.closed().then(() => lose("its store connection"));
  }
  void calloutNc.closed().then(() => lose("its broker connection"));
  console.log(`✓ auth callout replica up (space ${space}) - answering the callout on ${server}${args.limits?.authTimeoutMs !== undefined ? ` with a ${args.limits.authTimeoutMs / 1000}s authorization timeout` : ""}; no HTTP listener, no auth-service.json`);
  process.exit(await ended);
}

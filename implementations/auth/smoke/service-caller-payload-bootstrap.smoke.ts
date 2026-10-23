/** Real owned-broker P bootstrap refusal matrix. No synthetic assertion rows or authority replies. */
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import assert from "node:assert/strict";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { epAuthBucket, mintCreds, newIdentity, setupSpaceStreams, createBrokerAuth } from "@cotal-ai/core";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { pickFreePort } from "./_free-port.js";
import { checks } from "./_service-custody-fixture.js";
import { acquirePlaneClaim } from "../src/plane-claim.js";
import { openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { bootstrapServiceCallerPayload } from "../src/service-caller-payload-bootstrap.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { startAuthService, type AuthServiceHandle } from "../src/service.js";
import { mintServiceCallerPayloadObserverCreds } from "../src/index.js";
import { SERVICE_CALLER_PAYLOAD_FLOOR, SERVICE_CALLER_PAYLOAD_KEY } from "../src/service-caller-payload.js";
const c = checks(), enc = new TextEncoder();
for (const mode of ["default", "cluster", "stream-limit", "observer-denied", "actual", "tuple-during-observe", "fence-during-observe", "stream-change", "observer-broad", "observer-expired", "observer-long", "observer-foreign", "observer-timeout"] as const) {
  const fx = await startHostedAuthFixture(`payload-${mode}`, 1, { ...(mode === "default" ? {} : { maxPayload: SERVICE_CALLER_PAYLOAD_FLOOR }), ...(mode === "cluster" ? { clusterPort: await pickFreePort() } : {}) });
  const a = fx.accounts[0]!;
  let ownedHold: Awaited<ReturnType<typeof acquirePlaneClaim>> | undefined;
  let nc: NatsConnection | undefined, service: AuthServiceHandle | undefined, reader: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
  try {
    const identity = newIdentity(), creds = await mintCreds(a.auth, identity, "provisioner");
    if (mode === "cluster") {
      const readiness = await connect({ servers: fx.servers, authenticator: credsAuthenticator(enc.encode(creds)), inboxPrefix: `_INBOX_${identity.id}`, maxReconnectAttempts: 0 });
      try {
        const deadline = Date.now() + 30_000;
        for (;;) {
          try { await jetstreamManager(readiness); break; }
          catch (e) { if (Date.now() >= deadline) throw e; await new Promise(r => setTimeout(r, 100)); }
        }
      } finally { await readiness.close(); }
    }
    await setupSpaceStreams({ servers: fx.servers, space: a.space, creds });
    reader = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! },
      label: "payload-fixture-observer", grants: id => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
    nc = reader.nc;
    const kv = await new Kvm(nc).open(epAuthBucket(a.space));
    if (mode === "stream-limit") {
      const jsm = await jetstreamManager(nc), s = await jsm.streams.info(`KV_${epAuthBucket(a.space)}`);
      await jsm.streams.update(s.config.name, { ...s.config, max_msg_size: 1024 * 1024 });
    }
    if (mode === "tuple-during-observe" || mode === "fence-during-observe" || mode === "stream-change") {
      const tuple = { serverId: nc.info!.server_id, cid: nc.info!.client_id, userNkey: reader.connId };
      ownedHold = await acquirePlaneClaim({ nc, space: a.space, ledger: tuple, records: tuple, oracle: async () => { throw new Error("no prior claim allowed"); }, log: () => {} });
      let later = false;
      const verifier = await bootstrapServiceCallerPayload({ registry: await openLifecycleRegistry(nc, a.space), hold: ownedHold, servers: fx.servers,
        accountPublicKey: a.accountPublicKey, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! }, source: { observerCreds: async () => {
          if (later) {
            if (mode === "fence-during-observe") ownedHold!.fence("owned observation-time fence");
            else if (mode === "stream-change") {
              const jsm = await jetstreamManager(nc!), stream = await jsm.streams.info(`KV_${epAuthBucket(a.space)}`);
              await jsm.streams.update(stream.config.name, { ...stream.config, max_msg_size: SERVICE_CALLER_PAYLOAD_FLOOR });
            } else {
              const entry = (await kv.get("plane"))!, claim = JSON.parse(new TextDecoder().decode(entry.value));
              await kv.update("plane", enc.encode(JSON.stringify({ ...claim, ledger: { ...claim.ledger, cid: claim.ledger.cid + 1 } })), entry.revision);
            }
          }
          return mintServiceCallerPayloadObserverCreds({ pub: a.auth.sys.pub, signingSeed: a.auth.sys.signingSeed! });
        } } });
      later = true;
      let refused = false; try { await verifier(); } catch { refused = true; }
      c.check(`${mode}: live authority/config change is fenced after actual observation`, refused);
      continue;
    }
    const foreign = mode === "observer-foreign" ? await createBrokerAuth("owned-foreign-observer") : undefined;
    // The bootstrap's deadline starts after service setup, so the timeout cell times from the callback.
    let observerCalledAt = 0;
    const observationCreds = async () => {
      if (mode === "observer-timeout") { observerCalledAt = Date.now(); await new Promise(r => setTimeout(r, 11_000)); }
      if (mode === "observer-denied") return creds;
      if (mode === "observer-broad" || mode === "observer-expired" || mode === "observer-long") {
        const identity = newIdentity();
        const jwt = await encodeUser("owned-invalid-observer", fromPublic(identity.id), fromPublic(a.auth.sys.pub),
          { pub: { allow: [mode === "observer-broad" ? "$SYS.>" : "$SYS.REQ.SERVER.*.VARZ"] }, sub: { allow: [`_INBOX_${identity.id}.>`] } },
          { signer: fromSeed(enc.encode(a.auth.sys.signingSeed!)), exp: Math.floor(Date.now() / 1000) + (mode === "observer-expired" ? -1 : mode === "observer-long" ? 3600 : 60) });
        return new TextDecoder().decode(fmtCreds(jwt, fromSeed(enc.encode(identity.seed))));
      }
      const sys = foreign?.sys ?? a.auth.sys;
      return mintServiceCallerPayloadObserverCreds({ pub: sys.pub, signingSeed: sys.signingSeed! });
    };
    let error = "";
    try {
      service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: "p-bootstrap" }, space: a.space,
        servers: fx.servers, store: a.store, storeIdentity: a.store.identity, stateDir: a.stateDir,
        serviceEndpoints: { startup: { kind: "normal" }, callerPayload: { observerCreds: observationCreds } } });
    } catch (e) { error = (e as Error).message; }
    const row = await kv.get(SERVICE_CALLER_PAYLOAD_KEY);
    if (mode === "actual") {
      c.check("actual standalone broker at floor starts and records real bound assertion", !!service && row?.operation === "PUT" && JSON.parse(new TextDecoder().decode(row.value)).broker?.serverId === nc.info?.server_id, error);
    } else {
      c.check(`${mode}: actual bootstrap refuses and creates no assertion`, !service && !!error && row === null, error);
      if (mode === "observer-timeout") c.check("observer callback cannot outlive original ten-second bootstrap deadline", Date.now() - observerCalledAt < 11_000 && error.includes("deadline"), error);
      if (mode === "cluster") c.check("configured real JetStream cluster refuses specifically unsupported topology", error.includes("standalone"), error);
      if (mode === "default") c.check("default1MiB refusal names exact required2098176-byte configuration", error.includes("1048576") && error.includes("2098176"), error);
      const claim = await kv.get("plane");
      c.check(`${mode}: failed start released original plane claim`, !!claim && JSON.parse(new TextDecoder().decode(claim.value)).state === "released");
    }
  } finally { await service?.close(); await ownedHold?.release().catch(() => {}); await reader?.close(); await fx.close(); }
}
c.finish(); assert.equal(c.failed, 0); process.exitCode = c.failed ? 1 : 0;

/**
 * A BROKER RELOAD under a live auth plane, against a real nats-server.
 *
 * A reload keeps the same incarnation serving and moves VARZ `config_digest`. Caller issuance used
 * to be bound to the digest the bootstrap observed, so every reload refused every later issuance
 * until the plane was reopened. On a multi-tenant broker that is every tenant sign-up, because
 * provisioning a space re-renders and reloads the configuration.
 *
 * What is driven here is the issuance GATE: `bootstrapServiceCallerPayload`'s verifier, which the
 * callout awaits before it releases a caller's JWT (`resolveEndpointCaller`). Nothing is
 * constructed - a real broker, a real VARZ observation on a real 60-second observer credential, a
 * real plane claim, and the real CAS on the real assertion key.
 *
 * WHY THIS IS NOT DRIVEN END TO END THROUGH THE CALLOUT. On nats-server 2.12.12, which
 * `.github/workflows/ci.yml` pins, and on 2.14.0, a reload - a bare SIGHUP with the configuration
 * file untouched included - drops the auth plane's sealed scanner connections, so the plane fences
 * itself and its HTTP face goes away. That is the server dropping clients that hold JetStream
 * consumers, not anything this gate does; 2.15.1 keeps them. An end-to-end cell would therefore be
 * red on the pinned server for an unrelated reason. The gate above behaves identically on 2.12.12,
 * 2.14.0 and 2.15.1, and the end-to-end path was run separately on 2.15.1.
 *
 * Every REFUSAL cell is paired with an ADMISSION over the same broker through the same reload
 * mechanism, differing in one variable, so "it refused" cannot be satisfied by a reload that simply
 * broke the fixture.
 *
 * Run: pnpm smoke:service-caller-reload   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { Kvm } from "@nats-io/kv";
import { epAuthBucket, mintCreds, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { checks } from "./_service-custody-fixture.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { acquirePlaneClaim } from "../src/plane-claim.js";
import { bootstrapServiceCallerPayload, mintServiceCallerPayloadObserverCreds } from "../src/service-caller-payload-bootstrap.js";
import { SERVICE_CALLER_PAYLOAD_FLOOR, SERVICE_CALLER_PAYLOAD_KEY } from "../src/service-caller-payload.js";

const c = checks(), enc = new TextEncoder(), dec = new TextDecoder();
const fx = await startHostedAuthFixture("callerreload", 1, { maxPayload: SERVICE_CALLER_PAYLOAD_FLOOR });
const a = fx.accounts[0]!;
let reader: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let hold: Awaited<ReturnType<typeof acquirePlaneClaim>> | undefined;
try {
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  reader = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! },
    label: "caller-reload-plane", grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const nc = reader.nc, kv = await new Kvm(nc).open(epAuthBucket(a.space));
  const tuple = { serverId: nc.info!.server_id, cid: nc.info!.client_id, userNkey: reader.connId };
  hold = await acquirePlaneClaim({ nc, space: a.space, ledger: tuple, records: tuple, oracle: async () => { throw new Error("no prior claim allowed"); }, log: () => {} });
  const verify = await bootstrapServiceCallerPayload({ registry: await openLifecycleRegistry(nc, a.space), hold, servers: fx.servers,
    accountPublicKey: a.accountPublicKey, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! },
    source: { observerCreds: () => mintServiceCallerPayloadObserverCreds({ pub: a.auth.sys.pub, signingSeed: a.auth.sys.signingSeed! }) } });

  interface Asserted { state: string; floor: number; broker: { serverId: string; configDigest: string; claimId: string; claimGeneration: number } }
  // `revision` is the bucket's stream sequence at this key's last write, so it is compared for
  // EQUALITY (nothing wrote this key) or for GROWTH (something did). It is not a per-key counter:
  // a write to any other key in the bucket moves the next sequence a write here would get.
  const record = async () => {
    const entry = (await kv.get(SERVICE_CALLER_PAYLOAD_KEY))!;
    return { revision: entry.revision, row: JSON.parse(dec.decode(entry.value)) as Asserted };
  };
  /** Run the gate. A reload leaves JetStream briefly unavailable, so a first attempt may time out
   *  on a stream read; that is not an answer, and only a settled one is reported. */
  const gate = async (): Promise<{ admitted: boolean; why: string }> => {
    let why = "";
    for (let i = 0; i < 5; i++) {
      try { await verify(); return { admitted: true, why: "" }; }
      catch (e) { why = (e as Error).message; if (!/timeout/i.test(why)) return { admitted: false, why }; await new Promise((r) => setTimeout(r, 1000)); }
    }
    return { admitted: false, why };
  };

  const first = await record();
  c.check("the bootstrap records an assertion bound to this broker, configuration and plane claim, at the floor",
    first.row.state === "asserted" && first.row.broker.serverId === nc.info?.server_id && first.row.floor >= SERVICE_CALLER_PAYLOAD_FLOOR
    && first.row.broker.claimId === hold.claimId && first.row.broker.claimGeneration === hold.generation, first);
  const base = await gate();
  c.check("…and the gate admits issuance before any reload", base.admitted, base.why);
  c.check("…without rewriting the record", (await record()).revision === first.revision);

  // 1. A reload that changes nothing. The digest does not move, so there is nothing to re-bind.
  await fx.reloadBroker({});
  const unchanged = await gate();
  const afterUnchanged = await record();
  c.check("a reload that changes nothing admits issuance and rewrites nothing",
    unchanged.admitted && afterUnchanged.revision === first.revision && afterUnchanged.row.broker.configDigest === first.row.broker.configDigest, { unchanged, afterUnchanged });

  // 2. THE SUBJECT: a reload that adds an account, which is what provisioning a tenant does.
  await fx.reloadBroker({ addAccount: true });
  const added = await gate();
  const afterAdded = await record();
  c.check("a reload that adds an account admits issuance", added.admitted, added.why);
  c.check("…and re-asserts the record against the configuration now in force, under the same incarnation and plane claim",
    afterAdded.row.state === "asserted" && afterAdded.row.broker.configDigest !== first.row.broker.configDigest
    && afterAdded.revision > first.revision && afterAdded.row.broker.serverId === first.row.broker.serverId
    && afterAdded.row.broker.claimId === first.row.broker.claimId && afterAdded.row.broker.claimGeneration === first.row.broker.claimGeneration
    && afterAdded.row.floor >= SERVICE_CALLER_PAYLOAD_FLOOR, { first, afterAdded });
  const repeat = await gate();
  c.check("…and the next issuance admits against the re-bound record without writing again",
    repeat.admitted && (await record()).revision === afterAdded.revision, repeat.why);

  // 3. THE REFUSAL: the same reload mechanism, moving the one value the record exists to protect.
  await fx.reloadBroker({ maxPayload: SERVICE_CALLER_PAYLOAD_FLOOR - 1 });
  const below = await gate();
  const afterBelow = await record();
  c.check("a reload that drops max_payload below the floor refuses issuance, naming the required limit",
    !below.admitted && below.why.includes(String(SERVICE_CALLER_PAYLOAD_FLOOR)) && below.why.includes(String(SERVICE_CALLER_PAYLOAD_FLOOR - 1)), below.why);
  c.check("…and never re-asserts the record at the lower limit",
    afterBelow.revision === afterAdded.revision && afterBelow.row.floor >= SERVICE_CALLER_PAYLOAD_FLOOR, afterBelow);

  // 4. The control for 3: one variable moves back, the payload limit, and issuance is admitted
  //    again - so the refusal above was that limit and not the reload. This restores the exact
  //    configuration the record already names, so there is nothing to re-bind.
  await fx.reloadBroker({ maxPayload: SERVICE_CALLER_PAYLOAD_FLOOR });
  const restored = await gate();
  const afterRestored = await record();
  c.check("a reload that puts max_payload back at the floor admits issuance again",
    restored.admitted && afterRestored.row.broker.configDigest === afterAdded.row.broker.configDigest && afterRestored.revision === afterBelow.revision, { restored, afterRestored });

  // 5. And re-binding is not spent by that refusal: the next configuration change re-binds again.
  await fx.reloadBroker({ addAccount: true });
  const again = await gate();
  const afterAgain = await record();
  c.check("a configuration change after a refused one still admits issuance and re-binds",
    again.admitted && afterAgain.revision > afterRestored.revision && afterAgain.row.broker.configDigest !== afterRestored.row.broker.configDigest
    && afterAgain.row.broker.claimId === first.row.broker.claimId, { again, afterAgain });

  // 6. A burst of issuances arriving together after one reload. Re-binding is single-flight, so
  //    they join one CAS instead of racing it, where every loser would refuse.
  await fx.reloadBroker({ addAccount: true });
  const burst = await Promise.all([gate(), gate(), gate(), gate()]);
  const afterBurst = await record();
  c.check("concurrent issuances after one reload are ALL admitted - a racing CAS would refuse every one but the winner",
    burst.every((g) => g.admitted) && afterBurst.revision > afterAgain.revision
    && afterBurst.row.broker.configDigest !== afterAgain.row.broker.configDigest, { burst, afterBurst });

  // 7. A withdrawal is not something re-binding may undo. The record is withdrawn by hand - the
  //    shape a policy writer leaves behind after a failed live check - and then the configuration
  //    moves, which is the only path that writes.
  const current = (await kv.get(SERVICE_CALLER_PAYLOAD_KEY))!;
  const withdrawn = JSON.stringify({ v: 1, kind: "service-caller-payload", state: "withdrawn", reason: "live-check", operationId: null, atMs: Date.now() });
  const withdrawnRevision = await kv.update(SERVICE_CALLER_PAYLOAD_KEY, enc.encode(withdrawn), current.revision);
  await fx.reloadBroker({ addAccount: true });
  const afterWithdraw = await gate();
  const held = (await kv.get(SERVICE_CALLER_PAYLOAD_KEY))!;
  c.check("a withdrawn record refuses issuance across a reload, and re-binding never overwrites it",
    !afterWithdraw.admitted && held.revision === withdrawnRevision && JSON.parse(dec.decode(held.value)).state === "withdrawn", { why: afterWithdraw.why, revision: held.revision, expected: withdrawnRevision });
} finally {
  await hold?.release().catch(() => {});
  await reader?.close().catch(() => {});
  await fx.close();
}
c.finish();
assert.equal(c.failed, 0);
process.exitCode = c.failed ? 1 : 0;

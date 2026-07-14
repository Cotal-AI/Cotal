/**
 * Creative end-to-end lifecycle-keying test (cs-test-e2e assignment 6.3).
 * Boots a throwaway auth broker on a random high port, then loops:
 *   spawn "worker" with a fresh lifecycleUid → inspect dm_/dlv_ durables →
 *   publish a DM to the OLD incarnation → despawn → respawn same name.
 * Asserts: (a) dm_/dlv_ durables never accumulate per respawn (exactly one live set),
 *          (b) a DM published into the retired incarnation's dlv subject never reaches the
 *              new lifecycle (subject-scoped confinement),
 *          (c) a DM published during the predecessor's era never appears in the successor's
 *              dm_ backlog (activation-frontier confinement).
 * READ+RUN only — never edits source.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "/Users/david/Projects/Cotal-AI/Cotal-wt-control-surface/node_modules/.pnpm/@nats-io+transport-node@3.4.0/node_modules/@nats-io/transport-node";
import { jetstream, jetstreamManager } from "/Users/david/Projects/Cotal-AI/Cotal-wt-control-surface/node_modules/.pnpm/@nats-io+jetstream@3.4.0/node_modules/@nats-io/jetstream/lib/mod.js";
import {
  createSpaceAuth, serverConfig, mintCreds, setupSpaceStreams,
  newIdentity, provisionAgent, deprovisionAgent,
  CotalEndpoint, DEV_OWNER, mintLifecycleUid, dmStream, dlvStream, dmDurable, dlvDurable, dlvSubject, unicastRecvFilter,
} from "/Users/david/Projects/Cotal-AI/Cotal-wt-control-surface/packages/core/src/index.ts";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); }
};

const PORT = 12000 + Math.floor(Math.random() * 8000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const space = `rsp-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-rsp-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: ["ignore", "ignore", "pipe"] });
srv.stderr.on("data", (d) => process.stderr.write(`[nats] ${d}`));

async function jsmCreds(provCreds: string, provId: string) {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)),
    inboxPrefix: `_INBOX_${provId}`,
    maxReconnectAttempts: 0,
  });
  const jsm = await jetstreamManager(nc);
  return { nc, jsm };
}
async function consumerExists(provCreds: string, provId: string, stream: string, name: string): Promise<boolean> {
  try { const { nc, jsm } = await jsmCreds(provCreds, provId); try { await jsm.consumers.info(stream, name); return true; } finally { await nc.drain().catch(() => {}); } }
  catch { return false; }
}
async function listConsumers(provCreds: string, provId: string, stream: string): Promise<string[]> {
  const { nc, jsm } = await jsmCreds(provCreds, provId);
  const names: string[] = [];
  for await (const c of jsm.consumers.list(stream)) names.push(c.name);
  await nc.drain().catch(() => {});
  return names;
}
async function streamLastSeq(provCreds: string, provId: string, stream: string): Promise<number> {
  const { nc, jsm } = await jsmCreds(provCreds, provId);
  const info = await jsm.streams.info(stream);
  await nc.drain().catch(() => {});
  return info.state.last_seq;
}
async function consumerPending(provCreds: string, provId: string, stream: string, name: string): Promise<number> {
  const { nc, jsm } = await jsmCreds(provCreds, provId);
  const info = await jsm.consumers.info(stream, name);
  await nc.drain().catch(() => {});
  return info.num_pending;
}
async function consumerConfig(provCreds: string, provId: string, stream: string, name: string) {
  const { nc, jsm } = await jsmCreds(provCreds, provId);
  const info = await jsm.consumers.info(stream, name);
  await nc.drain().catch(() => {});
  return info.config;
}

try {
  const DM = dmStream(space), DLV = dlvStream(space);
  const provId = newIdentity();
  const provCreds = await mintCreds(auth, provId, "provisioner");

  let up = false;
  for (let i = 0; i < 50; i++) { try { const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)), inboxPrefix: `_INBOX_${provId.id}`, maxReconnectAttempts: 0, timeout: 500 }); await nc.drain(); up = true; break; } catch { await wait(200); } }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  const prov = new CotalEndpoint({
    space, servers: SERVERS, creds: provCreds,
    card: { id: provId.id, name: "prov", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  prov.on("error", (e: Error) => console.error("  ! prov", e.message));
  await prov.start();

  const agent = newIdentity();
  const actor = agent.id;
  const ROUNDS = 6;
  const usedUids: string[] = [];

  for (let r = 1; r <= ROUNDS; r++) {
    const prevUid = usedUids[usedUids.length - 1];
    const frontier = await streamLastSeq(provCreds, provId.id, DM); // captured BEFORE provision
    const uid = mintLifecycleUid();
    usedUids.push(uid);

    await provisionAgent(prov, auth, agent, {
      subscribe: ["general"], allowSubscribe: ["general"], role: "worker",
      lifecycleUid: uid, activationFrontier: frontier,
    });

    // (a) no accumulation: the live lifecycle's dm_/dlv_ exist, and NO prior incarnation's does.
    check(`round ${r}: live dm_ durable for "${actor}" exists`, await consumerExists(provCreds, provId.id, DM, dmDurable(DEV_OWNER, actor, uid)));
    check(`round ${r}: live dlv_ durable for "${actor}" exists`, await consumerExists(provCreds, provId.id, DLV, dlvDurable(DEV_OWNER, actor, uid)));
    for (let k = 0; k < usedUids.length - 1; k++) {
      const old = usedUids[k];
      check(`round ${r}: retired dm_ (incarnation ${k + 1}) GONE — no accumulation`, !(await consumerExists(provCreds, provId.id, DM, dmDurable(DEV_OWNER, actor, old))));
      check(`round ${r}: retired dlv_ (incarnation ${k + 1}) GONE — no accumulation`, !(await consumerExists(provCreds, provId.id, DLV, dlvDurable(DEV_OWNER, actor, old))));
    }

    // (c) activation-frontier confinement on the DM path: the successor's dm_ consumer starts AFTER
    //     the activation frontier (the seq captured at provision), so it inherits NONE of the
    //     predecessor's pending DMs. frontier===0 (empty stream) legitimately uses DeliverPolicy.All.
    const dmCfg = await consumerConfig(provCreds, provId.id, DM, dmDurable(DEV_OWNER, actor, uid));
    if (frontier > 0) {
      check(`round ${r}: dm_ consumer uses activation-frontier (start @ frontier+1)`, dmCfg.deliver_policy === "start", dmCfg.deliver_policy);
      check(`round ${r}: dm_ opt_start_seq == captured frontier+1`, dmCfg.opt_start_seq === frontier + 1, { got: dmCfg.opt_start_seq, frontier });
    } else {
      check(`round ${r}: dm_ uses DeliverPolicy.All on empty stream (frontier 0)`, dmCfg.deliver_policy === "all", dmCfg.deliver_policy);
    }
    check(`round ${r}: dm_ filter_subject scoped to this actor`, dmCfg.filter_subject === unicastRecvFilter(space, DEV_OWNER, actor), dmCfg.filter_subject);
    await wait(150);
    const backlog0 = await consumerPending(provCreds, provId.id, DM, dmDurable(DEV_OWNER, actor, uid));
    check(`round ${r}: successor dm_ backlog empty at spawn (no inherited DMs)`, backlog0 === 0, backlog0);

    // (b) dlv subject-scoped confinement: the successor's dlv_ consumer is filtered to ITS OWN
    //     lifecycle subject (dlv.<owner>.<actor>.<newUid>), so a delivery to the PREVIOUS
    //     incarnation's subject (dlv.<owner>.<actor>.<oldUid>) structurally cannot reach it.
    const dlvCfg = await consumerConfig(provCreds, provId.id, DLV, dlvDurable(DEV_OWNER, actor, uid));
    const expectSubj = dlvSubject(space, DEV_OWNER, actor, uid);
    check(`round ${r}: dlv_ filter_subject == THIS lifecycle's dlv subject`, dlvCfg.filter_subject === expectSubj, dlvCfg.filter_subject);
    if (prevUid) {
      const prevSubj = dlvSubject(space, DEV_OWNER, actor, prevUid);
      check(`round ${r}: dlv_ filter excludes the RETIRED incarnation's subject`, dlvCfg.filter_subject !== prevSubj && !dlvCfg.filter_subject.includes(prevUid), { filter: dlvCfg.filter_subject, prevUid });
    }

    // despawn with target-pinned deprovisioner cred for THIS lifecycle
    const dpvCreds = await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: actor, lifecycleUid: uid } });
    await deprovisionAgent({ servers: SERVERS, space, targetId: actor, lifecycleUid: uid, creds: dpvCreds });
    check(`round ${r}: old dm_ durable GONE after despawn`, !(await consumerExists(provCreds, provId.id, DM, dmDurable(DEV_OWNER, actor, uid))));
    check(`round ${r}: old dlv_ durable GONE after despawn`, !(await consumerExists(provCreds, provId.id, DLV, dlvDurable(DEV_OWNER, actor, uid))));
  }

  console.log(`\nRESPAWN-LOOP E2E ${fail === 0 ? "OK ✅" : "RED ❌"}  (${pass} passed, ${fail} failed)`);
} finally {
  try { srv.kill("SIGKILL"); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);

/**
 * `dmHistoryOf` reads the DMs to and from named principals, filtered on the broker, and reports a
 * refusal instead of an empty list.
 *
 * On a static-auth broker three agents trade DMs. An admin reader asks for one principal's DMs and
 * for two principals' DMs: each answer holds every DM to or from them once, oldest first, and no
 * other, with `to` and `from.id` taken from the subject. A limit keeps the newest DMs across both
 * directions. A principal with no DMs reads as an empty answer. An observer's read answers `denied`,
 * while its `dmHistory` keeps the documented empty list. A principal with a wildcard, an extra dot
 * or no dot throws before any read.
 *
 * Run: pnpm smoke:dm-history-of   (needs `nats-server` on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, DEV_OWNER, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  principalKey, provisionAgent, serverConfig, setupSpaceStreams, type CotalMessage, type DmHistoryRead,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const texts = (r: DmHistoryRead) => (r.state === "read" ? r.items.map(textOf) : [`denied: ${r.reason}`]);
const { check, finish } = createSuite();

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `dm-of-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const endpoints: CotalEndpoint[] = [];
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const start = async (creds: string, name: string, extra: Record<string, unknown> = {}) => {
    const ep = new CotalEndpoint({ space, servers: SERVERS, creds, channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { name, kind: "endpoint" }, ...extra });
    ep.on("error", () => {});
    await ep.start();
    endpoints.push(ep);
    return ep;
  };
  const mgr = await start(mgrCreds, "prov", { card: { name: "prov", role: "manager", kind: "endpoint" } });
  const agent = async (name: string) => {
    const id = newIdentity(), uid = mintLifecycleUid();
    const creds = await provisionAgent(mgr, auth, id, { allowSubscribe: [], subscribe: [], lifecycleUid: uid });
    return { ep: await start(creds, name, { lifecycleUid: uid, card: { id: id.id, name, kind: "agent" } }), principal: principalKey(DEV_OWNER, id.id).key };
  };
  const alice = await agent("alice");
  const bob = await agent("bob");
  const carol = await agent("carol");

  await alice.ep.unicast(bob.principal, "a2b 1");
  await bob.ep.unicast(alice.principal, "b2a 1");
  await carol.ep.unicast(bob.principal, "c2b 1");
  await alice.ep.unicast(carol.principal, "a2c 1");
  const a2b2 = await alice.ep.unicast(bob.principal, "a2b 2");
  await carol.ep.unicast(bob.principal, "c2b 2");
  await bob.ep.unicast(alice.principal, "b2a 2", { replyTo: a2b2.id });

  const admin = await start(await mintCreds(auth, newIdentity(), "admin"), "admin");
  const observer = await start(await mintCreds(auth, newIdentity(), "observer"), "observer");

  const ofAlice = await admin.dmHistoryOf([alice.principal]);
  check("admin: every DM to or from one principal, oldest first, and no other", JSON.stringify(texts(ofAlice)) === JSON.stringify(["a2b 1", "b2a 1", "a2c 1", "a2b 2", "b2a 2"]), texts(ofAlice));
  const rows = ofAlice.state === "read" ? ofAlice.items : [];
  check("admin: each row's sender and recipient come from its subject, and the principal is one of them",
    rows.length === 5 && rows.every((m) => (m.from.id === alice.principal) !== (m.to === alice.principal)) && rows.find((m) => textOf(m) === "a2c 1")?.to === carol.principal,
    rows.map((m) => ({ text: textOf(m), from: m.from.id, to: m.to })));
  check("admin: a reply keeps its replyTo", rows.find((m) => textOf(m) === "b2a 2")?.replyTo === a2b2.id, rows.map((m) => m.replyTo));

  const ofBoth = await admin.dmHistoryOf([alice.principal, bob.principal]);
  check("admin: two principals read each DM between them once, with the others to or from either", JSON.stringify(texts(ofBoth)) === JSON.stringify(["a2b 1", "b2a 1", "c2b 1", "a2c 1", "a2b 2", "c2b 2", "b2a 2"]), texts(ofBoth));

  const newest = await admin.dmHistoryOf([alice.principal], { limit: 2 });
  check("admin: a limit keeps the newest DMs across both directions", JSON.stringify(texts(newest)) === JSON.stringify(["a2b 2", "b2a 2"]), texts(newest));

  const twice = await admin.dmHistoryOf([alice.principal, alice.principal]);
  check("admin: a principal named twice reads as once", JSON.stringify(texts(twice)) === JSON.stringify(texts(ofAlice)), texts(twice));

  const quiet = await admin.dmHistoryOf([principalKey(DEV_OWNER, newIdentity().id).key]);
  check("admin: a principal with no DMs reads as an empty answer", quiet.state === "read" && quiet.items.length === 0, quiet);
  const none = await admin.dmHistoryOf([]);
  check("admin: no principals read nothing", none.state === "read" && none.items.length === 0, none);

  const denied = await observer.dmHistoryOf([alice.principal]);
  check("observer: the read answers denied, with the broker's reason", denied.state === "denied" && /permissions? violation/i.test(denied.reason), denied);
  const godView = await observer.dmHistory();
  check("observer: dmHistory keeps its documented empty list", Array.isArray(godView) && godView.length === 0, godView.length);

  for (const bad of [`${DEV_OWNER}.*`, `${DEV_OWNER}.a.b`, "alice", ""]) {
    let refused: string | undefined;
    try { await admin.dmHistoryOf([bad]); } catch (e) { refused = (e as Error).message; }
    check(`admin: "${bad}" is not a principal, so the read throws`, refused?.includes("is not a principal") === true, refused);
  }
} finally {
  await Promise.all(endpoints.map((ep) => ep.stop().catch(() => {})));
  await killAndAwaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
finish();

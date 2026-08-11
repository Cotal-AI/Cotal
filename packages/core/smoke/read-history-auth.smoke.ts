/**
 * Mediated channel-history read (Track D, D3, PHASE 1) — RED FIRST.
 *
 * NOT a capability gap. An observer can already page history today — measured, not assumed: an
 * `observer`-profile connection with no `lifecycleUid` returns messages from `channelHistory`. It
 * does so by holding **raw consumer-create on the chat stream**, which is exactly what SPEC's
 * "Mediated reads (normative)" rule refuses an untrusted holder: no raw consumer / `DIRECT.GET` /
 * `STREAM.MSG.GET`; those reads come from the trusted reader onto the caller's own confined rail.
 *
 * So `read-history` is a PRIVILEGE REDUCTION that aligns the code with a normative rule, served by
 * the delivery daemon on the rail it already owns (`ctl.delivery.<owner>.<actor>`, beside
 * `durableJoin`/`listMemberships`). The caller never names itself: `serveControl` fail-closes unless
 * the payload sender matches the broker-authenticated subject.
 *
 * Phase 1 is ADDITIVE — it adds the mediated path and removes nothing. Taking consumer-create away
 * from the observer profile is Phase 2, held and brokered separately, because the dashboard reads
 * history through that grant today.
 *
 * The property that distinguishes this from the consumer path, and the reason it is worth shipping:
 * a consumer pins its authorization at CREATE time, so a revoked ACL keeps serving the open
 * consumer. The mediator re-reads the ACL PER PAGE, so a revocation stops the very next page. That
 * is directly observable, and it is what this asserts.
 *
 * Run: pnpm smoke:read-history:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
  serverConfig, newIdentity, setupSpaceStreams, seedChannelRegistry,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `read-history-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-readhist-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

let mgr: CotalEndpoint | undefined, daemon: CotalEndpoint | undefined;
let poster: CotalEndpoint | undefined, reader: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  await seedChannelRegistry({
    servers: SERVERS, space, creds: mgrCreds,
    file: { defaults: { replay: true }, channels: { ops: { replay: true }, secret: { replay: true } } },
  });

  mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  mgr.on("error", () => {}); await mgr.start();

  daemon = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {}); await daemon.start();
  await daemon.startPlane3((owner, lifecycleUid) => daemon!.aclForOwner(owner, lifecycleUid));

  // Backlog worth reading back.
  const pId = newIdentity();
  const uidP = mintLifecycleUid();
  const pCreds = await provisionAgent(mgr, auth, pId, { allowSubscribe: ["ops"], allowPublish: ["ops"], subscribe: ["ops"], lifecycleUid: uidP });
  poster = new CotalEndpoint({ space, servers: SERVERS, creds: pCreds, channels: ["ops"], consume: false, lifecycleUid: uidP, watchPresence: false, registerPresence: false, card: { id: pId.id, name: "poster", kind: "agent" } });
  poster.on("error", () => {}); await poster.start();
  for (let i = 1; i <= 4; i++) await poster.multicast(`scrollback line ${i}`, { channel: "ops" });
  await wait(400);

  // The CALLER: an ordinary provisioned agent whose ACL admits `ops` and not `secret`. It reads
  // through the mediator, so the interesting facts are about authorization, not about reachability.
  const rId = newIdentity();
  const uidR = mintLifecycleUid();
  const rCreds = await provisionAgent(mgr, auth, rId, { allowSubscribe: ["ops"], subscribe: ["ops"], lifecycleUid: uidR });
  reader = new CotalEndpoint({ space, servers: SERVERS, creds: rCreds, channels: [], consume: false, lifecycleUid: uidR, watchPresence: false, registerPresence: false, card: { id: rId.id, name: "reader", kind: "agent" } });
  reader.on("error", () => {}); await reader.start();

  // 1. It serves a caller inside its ACL, and pages.
  const p1 = await reader.readHistory("ops", { limit: 2 });
  check("read-history serves an in-ACL caller", (p1.items?.length ?? 0) === 2, p1);
  check("...with the message bodies", p1.items?.[0]?.text === "scrollback line 1", p1.items?.map((i) => i.text));
  check("...and hands back a cursor when more remains", !p1.complete && typeof p1.nextCursor === "string", p1);

  const p2 = await reader.readHistory("ops", { limit: 2, cursor: p1.nextCursor });
  check("the cursor continues rather than restarting", p2.items?.[0]?.text === "scrollback line 3", p2.items?.map((i) => i.text));

  // 2. A channel outside the ACL is refused, and SAYS so — an empty page reads as "no history".
  let aclErr = "";
  try { await reader.readHistory("secret", { limit: 10 }); }
  catch (e) { aclErr = (e as Error).message; }
  check("read-history refuses a channel outside the caller's ACL", aclErr !== "", { aclErr });
  check("...loudly, not as an empty page", /acl|not permitted|refus|denied/i.test(aclErr), { aclErr });

  // 3. THE PROPERTY THAT JUSTIFIES THE FEATURE: authorization is re-read PER PAGE. A consumer pins
  // its ACL at create time and keeps serving after a revocation; the mediator must not.
  const p3 = await reader.readHistory("ops", { limit: 1 });
  check("a page is served while the ACL still admits the channel", (p3.items?.length ?? 0) === 1, p3);
  await mgr.commitAcl(rId.id, uidR, []); // revoke mid-scroll
  await wait(300);
  let revokedErr = "";
  try { await reader.readHistory("ops", { limit: 1, cursor: p3.nextCursor }); }
  catch (e) { revokedErr = (e as Error).message; }
  check("a revoked ACL stops the very NEXT page (re-read per page, not pinned at create)", revokedErr !== "", { revokedErr });
} finally {
  await reader?.stop().catch(() => {});
  await poster?.stop().catch(() => {});
  await daemon?.stop().catch(() => {});
  await mgr?.stop().catch(() => {});
  srv.kill("SIGKILL");
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
}
console.log(fail === 0 ? `\nREAD-HISTORY SMOKE OK ✅  (${pass} passed, 0 failed)` : `\nREAD-HISTORY SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Auth-mode per-channel attention e2e (no test runner) — the open `per-channel-attention.smoke.ts`
 * flow under JWT auth, the real deployment stack. Spins up its OWN JWT-auth nats-server, mints scoped
 * creds for the agent (Otto) and a peer (Pubby), and proves quiet/muted hold for an agent holding ONLY
 * the minted "agent" grants — AND that the per-channel modes + global attention round-trip through
 * presence over the wire so a *separate* peer sees them (the mesh-visibility contract):
 *   - boot seed from the agent's quiet/muted config;
 *   - muted: channel ambient AND @-mentions ack-dropped; a DM still pierces;
 *   - quiet: buffered + readable, not wake-eligible; a quiet @-mention IS wake-eligible;
 *   - precedence: quiet buffers even under global focus;
 *   - recall skips overridden channels (no muted resurface / quiet duplicate);
 *   - presence mirror: Pubby (separate creds) reads Otto's attention + channelModes over the wire;
 *   - reset on restart: a fresh agent seeds from config only.
 * Run: pnpm smoke:channel-attention:auth
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  seedChannelRegistry,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  mintLifecycleUid,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  CONTROL_DELIVERY,
  DEV_OWNER,
} from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import type { InboxItem } from "../src/agent.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "chanattnsmoke-auth";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
let pass = 0;
let fail = 0;
// Counting convention (not assert-throw): this suite is graded by mutation-proof through
// connection-status.mutations.json's #445 entry, whose completion marker is a line the suite must
// print whether it passes or fails. A fail-fast check would exit at the first red and never reach it.
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) {
    fail++;
    process.exitCode = 1;
    console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
    return;
  }
  pass++;
  console.log(`  ✓ ${name}`);
};

const channels = ["normal-ch", "quiet-ch", "muted-ch"];

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });

  // Privileged setup: streams + presence KV, channel registry (replay ON so recall has data to skip),
  // and the two peers' bind-only durables + scoped "agent" creds.
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: mgrCreds });
  await seedChannelRegistry({ servers, space, creds: mgrCreds, file: { defaults: { replay: true }, channels: { "fx51-durable": { deliveryClass: "durable" } } } });
  const mgr = new CotalEndpoint({ space, servers, creds: mgrCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  mgr.on("error", () => {});
  await mgr.start();

  const ottoId = newIdentity();
  const pubbyId = newIdentity();
  // Presence/roster entries key by the PRINCIPAL dot-form (`local.<id>` = card.id under the owner+actor grammar).
  const ottoPrincipal = `${DEV_OWNER}.${ottoId.id}`;
  const ottoUid = mintLifecycleUid(); // one lifecycle uid per agent (SPEC §13.1)
  const pubbyUid = mintLifecycleUid();
  const chACL = { subscribe: channels, allowSubscribe: [...channels, "fx51-durable"], allowPublish: channels };
  const ottoCreds = await provisionAgent(mgr, auth, ottoId, { ...chACL, role: "generalist", lifecycleUid: ottoUid });
  const pubbyCreds = await provisionAgent(mgr, auth, pubbyId, { ...chACL, lifecycleUid: pubbyUid });
  // A reader provisioned WITHOUT any durable-read grant: it cannot join fx51-durable's backstop, so
  // its listChannels() row must render the cannot-establish health, never "active" or a bare
  // omission (the #445 undefined-state cell).
  const blindId = newIdentity();
  const blindUid = mintLifecycleUid();
  const blindChans = ["normal-ch"];
  const blindACL = { subscribe: blindChans, allowSubscribe: blindChans, allowPublish: blindChans };
  const blindCreds = await provisionAgent(mgr, auth, blindId, { ...blindACL, lifecycleUid: blindUid, role: "generalist" });

  const cfg: AgentConfig = {
    space,
    name: "Otto",
    role: "generalist",
    servers,
    creds: ottoCreds,
    subscribe: channels,
    allowSubscribe: channels,
    allowPublish: channels,
    quiet: ["quiet-ch"], // operator file default (not an ACL — rides the agent config)
    muted: ["muted-ch"],
    kind: "agent",
    tls: false,
    id: ottoId.id,
    lifecycleUid: ottoUid,
  };

  // ---- #445: deliveryHealth must track the daemon, never its residue ----
  // An in-process delivery endpoint serves ctl.delivery and holds the lease (the boot-retry suite's
  // shape). Otto joins the durable channel, the row reads active while the daemon serves, then the
  // daemon endpoint is stopped WITHOUT any lease release — stop() never releases the delivery lease
  // (#368), so the KV row stays behind ready:true exactly as a SIGKILLed daemon's does, and the
  // ctl.delivery responder is gone. The row must read degraded on the very next listChannels(),
  // never active, while hasDurableMembership still says true (session-local residue).
  const daemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {});
  await daemon.start();
  await daemon.startPlane3((owner, lifecycleUid) => daemon.aclForOwner(owner, lifecycleUid));
  const dcfg: AgentConfig = {
    space, name: "Otto", role: "generalist", servers, creds: ottoCreds,
    subscribe: [...channels, "fx51-durable"], allowSubscribe: [...channels, "fx51-durable"], allowPublish: channels,
    quiet: ["quiet-ch"], muted: ["muted-ch"], kind: "agent", tls: false, id: ottoId.id, lifecycleUid: ottoUid,
  };
  const dagent = new MeshAgent(dcfg);
  dagent.on("error", () => {});
  dagent.start();
  for (let i = 0; i < 50; i++) { if (dagent.connected) break; await sleep(200); }
  let durableUp = false;
  for (let i = 0; i < 20; i++) { if (dagent.ep.hasDurableMembership("fx51-durable")) { durableUp = true; break; } await sleep(500); }
  check("durable membership established (daemon serving)", durableUp);
  // The daemon's readiness flip (lease ready:true) can lag the join responder; the active control
  // must wait for it, else it grades a still-binding daemon. In-process daemons acquire + flip the
  // lease themselves (the CLI daemon does this in runStartedDelivery).
  await daemon.acquireDeliveryLease(0).then((rev) => daemon.markDeliveryLeaseReady(0, rev)).catch(() => {});
  let leaseReady = false;
  for (let i = 0; i < 30; i++) { if ((await dagent.ep.readDeliveryLease(0))?.ready === true) { leaseReady = true; break; } await sleep(500); }
  check("daemon lease reads ready:true (serving)", leaseReady);
  const liveRows = await dagent.listChannels();
  check("deliveryHealth reads active while the daemon serves", liveRows.find((c) => c.channel === "fx51-durable")?.deliveryHealth === "active", liveRows.find((c) => c.channel === "fx51-durable"));
  await daemon.stop(); // no graceful lease release — the ready:true residue stays
  const leaseAfterStop = await dagent.ep.readDeliveryLease(0);
  check("daemon stopped but its lease row still reads ready:true (residue)", leaseAfterStop?.ready === true, leaseAfterStop);
  const deadRows = await dagent.listChannels();
  const deadRow = deadRows.find((c) => c.channel === "fx51-durable");
  check("daemon gone + lease residue still ready ⇒ deliveryHealth degraded, NEVER active (#445)", deadRow?.deliveryHealth === "degraded", deadRow);
  check("…while hasDurableMembership still true (session-local residue)", dagent.ep.hasDurableMembership("fx51-durable") === true);

  // The cannot-establish ("unknown") arm, driven through the route the fix actually has: a
  // responder-PRESENT error on fetchMemberships(). Every minted agent profile carries a read of the
  // delivery KV (provision.ts grants DLVKV to any agent), so "a reader without the delivery grant"
  // is not a shape provisionAgent can mint — the grant arm is covered by reading only. What a suite
  // CAN manufacture is a daemon that answers ctl.delivery with an error: a plain endpoint serving
  // the delivery control subject with {ok:false}, exactly as a shard-rechecking (quiesced) daemon's
  // responder does from behind its may-act fence. The agent's fetchMemberships() then throws
  // (responder present, errored) and health cannot be established.
  // First the premise probe: the blind reader's lease read does NOT throw (DLVKV rides every
  // agent profile), so its row can only read degraded/active — never the no-grant throw.
  const blind = new CotalEndpoint({ space, servers, creds: blindCreds, card: { name: "Blind", kind: "agent", id: blindId.id }, channels: [], lifecycleUid: blindUid, watchPresence: false, registerPresence: false });
  blind.on("error", () => {});
  await blind.start();
  let blindLeaseThrew = false;
  try { await blind.readDeliveryLease(0); } catch { blindLeaseThrew = true; }
  await blind.stop();
  check("every minted agent profile reads the delivery KV, so the no-grant premise is unmintable (unknown is covered by reading)", blindLeaseThrew === false, { blindLeaseThrew });

  // A daemon-shaped responder that answers every control op with an error — the wire shape a
  // shard-rechecking daemon presents from behind its may-act fence. The row must render unknown,
  // never active, degraded, or omitted. No startPlane3: the stub is the ONLY member of the
  // delivery queue group (the real daemon is stopped above), so it is guaranteed the request.
  const errdaemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery2", role: "delivery", kind: "endpoint" } });
  errdaemon.on("error", () => {});
  await errdaemon.start();
  const errSub = errdaemon.serveControl(CONTROL_DELIVERY, () => ({ ok: false, error: "delivery: this daemon is not serving this shard (it is re-checking ownership); retry" }), { boundReply: true });
  // The stub's SUB is in flight when serveControl returns; a request published before the broker
  // registers it takes the no-responders outcome (undefined), not the responder-present error this
  // cell is about. Wait until the stub is the member that answers, bounded, before reading the row.
  let membershipsThrew = false;
  for (let i = 0; i < 50 && !membershipsThrew; i++) {
    try { await dagent.ep.fetchMemberships(); await sleep(100); } catch { membershipsThrew = true; }
  }
  const errRows = await dagent.listChannels();
  const errRow = errRows.find((c) => c.channel === "fx51-durable");
  check("a daemon answering errors (responder present, op refused) renders health unknown, never active/degraded/omitted (#445)",
    membershipsThrew && errRow?.deliveryHealth === "unknown", { membershipsThrew, errRow });
  try { errSub.unsubscribe(); } catch { /* already gone */ }
  await errdaemon.stop();
  await dagent.stop();

  // ---- boot seed from config (before connecting) ----
  const agent = new MeshAgent(cfg);
  agent.on("error", () => {});
  check("boot seeds quiet/muted from config under auth", agent.channelMode("quiet-ch") === "quiet" && agent.channelMode("muted-ch") === "muted");

  const incoming: InboxItem[] = [];
  const mentionWake: InboxItem[] = [];
  agent.on("incoming", (i: InboxItem) => incoming.push(i));
  agent.on("mention-wake", (i: InboxItem) => mentionWake.push(i));

  const pub = new CotalEndpoint({ space, servers, creds: pubbyCreds, card: { name: "Pubby", kind: "agent", id: pubbyId.id }, channels, lifecycleUid: pubbyUid });
  pub.on("error", () => {});

  await pub.start();
  agent.start();
  for (let i = 0; i < 50; i++) { if (agent.connected) break; await sleep(200); }
  check("agent connected (scoped creds)", agent.connected === true);
  await sleep(300);

  // ---- file-default modes are visible in presence at BOOT over the auth wire, before any toggle ----
  const bootSeen = pub.getRoster().find((p) => p.card.id === ottoPrincipal);
  check("file-default channelModes visible in presence at boot under auth (no toggle yet)",
    bootSeen?.channelModes?.["quiet-ch"] === "quiet" && bootSeen?.channelModes?.["muted-ch"] === "muted");

  // ---- muted: ack-dropped (incl. @mention); DM pierces ----
  await pub.multicast("muted-ambient", { channel: "muted-ch" });
  await pub.multicast("muted-mention", { channel: "muted-ch", mentions: ["otto"] });
  await sleep(450);
  check("muted ambient + @-mention NOT buffered (over the wire, auth)", agent.inboxCount() === 0 && mentionWake.length === 0 && incoming.length === 0);
  await pub.unicast(agent.id, "dm-1");
  await sleep(400);
  check("a DM still pierces (kind=dm)", agent.inboxCount() === 1 && incoming.at(-1)?.kind === "dm");

  // ---- quiet: buffered, not wake-eligible; mention IS ----
  agent.drainInbox();
  incoming.length = 0;
  await pub.multicast("quiet-ambient", { channel: "quiet-ch" });
  await sleep(400);
  check("quiet ambient buffered but NOT wake-eligible", agent.inboxCount() === 1 && agent.pendingWake() === 0);
  await pub.multicast("quiet-mention", { channel: "quiet-ch", mentions: ["otto"] });
  await sleep(400);
  check("quiet @-mention is wake-eligible", agent.inboxCount() === 2 && agent.pendingWake() === 1);

  // ---- precedence: quiet buffers even under global focus; normal/muted drop ----
  agent.drainInbox();
  incoming.length = 0;
  await agent.setAttention("focus");
  await pub.multicast("quiet-focus", { channel: "quiet-ch" });
  await pub.multicast("normal-focus", { channel: "normal-ch" });
  await pub.multicast("muted-focus", { channel: "muted-ch" });
  await sleep(450);
  check("quiet overrides focus (buffered); normal+muted drop", agent.inboxCount() === 1 && incoming.at(-1)?.text === "quiet-focus");

  // ---- recall skips overridden channels (no resurface / duplicate) ----
  const recall = await agent.recallAmbient();
  const rtexts = recall.items.map((i) => i.text);
  check("recall surfaces NORMAL focus-dropped ambient", rtexts.includes("normal-focus"));
  check("recall SKIPS muted + quiet channels", !rtexts.includes("muted-focus") && !rtexts.includes("quiet-focus"));
  await agent.setAttention("open");

  // ---- presence mirror over the wire: a SEPARATE peer sees attention + channelModes ----
  await agent.setAttention("dnd");
  await agent.setChannelMode("normal-ch", "muted"); // runtime override on top of file defaults
  await sleep(500);
  const seen = pub.getRoster().find((p) => p.card.id === ottoPrincipal);
  check("peer reads Otto's global attention from presence (auth wire)", seen?.attention === "dnd");
  check("peer reads Otto's channelModes from presence (auth wire)",
    seen?.channelModes?.["normal-ch"] === "muted" && seen?.channelModes?.["quiet-ch"] === "quiet" && seen?.channelModes?.["muted-ch"] === "muted");
  await agent.setChannelMode("normal-ch", "normal");
  await sleep(400);
  check("clearing a mode removes the key for the peer", pub.getRoster().find((p) => p.card.id === ottoPrincipal)?.channelModes?.["normal-ch"] === undefined);

  // ---- reset on restart ----
  const fresh = new MeshAgent(cfg);
  check("restart drops runtime override, keeps file defaults",
    fresh.channelMode("normal-ch") === undefined && fresh.channelMode("quiet-ch") === "quiet" && fresh.channelMode("muted-ch") === "muted");

  await agent.stop();
  await pub.stop();
  await mgr.stop({ withAgents: true });
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
const EXPECTED_CELLS = 22;
const ran = pass + fail;
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
console.log(`SUITE COMPLETE: ${ran} cells`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE: ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);

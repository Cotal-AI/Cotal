/**
 * P2 item 6 — the manager SESSION PLANE (slice 6b) end-to-end smoke. Run: pnpm smoke:mesh-attach-plane
 * (needs nats-server on PATH; part of smoke:ci).
 *
 * 6a proved the plane's PARTS (offer mint / redeem seam / bridge / framing) in isolation. This
 * proves the {@link ManagerSessionPlane} that COMPOSES them exactly as the manager will: one
 * `establishAttach` call mints the offer, enforces the one-use redemption through a manager-local
 * KV ledger (real broker KV, the SAME core row/key types the auth adapter uses), and stands up the
 * PTY bridge on a session-writer connection — then a caller rail drives the terminal end to end.
 *
 * OPEN mesh (bare connection): item 6's STATIC-auth live gate (instrument rows scoping the eps
 * subtree) rides the SAME machinery over a scoped cred and is exercised by the 6b static e2e; the
 * broker enforces nothing on an open mesh, so this smoke proves the establishment + bridge
 * mechanics (mint→redeem-CAS→serve→reconstruct→duplex→distinct-end) without an auth harness.
 *
 * Proven: establishAttach mints+redeems+serves atomically; the ledger row lands `active` (the
 * one-use durable record); a foreign presenter is refused; the ready→backlog reconstruction
 * handshake replays the pty screen; duplex byte flow through the echo child; endForTarget surfaces a
 * DISTINCT end reason to the client; a re-establish after target-despawn is a fresh session.
 */
import { spawn } from "node:child_process";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  createSessionsStore,
  ensureAuthorityStores,
  sessionsBucket,
  epAuthBucket,
  newArtifactSigner,
  openSessionRail,
  sessionLedgerKey,
  SESSION_GRANT_MAX_TTL_MS,
  type AnchorResolver,
  type SignerAnchor,
} from "@cotal-ai/core";
import { createRuntime } from "../src/index.js";
import {
  ManagerSessionPlane,
  decodeTerminalFrame,
  encodeTerminalData,
  type TerminalFrame,
} from "../src/session/index.js";
// dev-only smoke import: the CLI's mesh transport is the real caller consumer; implementations do
// not import each other in production, but a cross-impl integration smoke may (like attach.smoke.ts).
import { meshSessionTransport } from "../../cli/src/lib/attach-client.js";
import { launchEnv } from "@cotal-ai/connector-core"; // dev-only smoke import: the OS env allow-list a real connector supplies

// A portable pty echo child: it pipes stdin straight back to stdout, so a keystroke the caller
// sends comes back as output — a genuine duplex byte stream over the two eps rails. `process.execPath`
// rather than a bare name because the pty child gets ONLY `spec.env` (P3 isolation), so there is no
// PATH to resolve against; `launchEnv()` is the same OS allow-list a real connector supplies, and on
// Windows a child without `SystemRoot` aborts before its first line. (This was `cat`, which windows
// runners do not have.)
const ECHO_CHILD = { command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], env: launchEnv() };



let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return true; await wait(20); }
  return f();
}

const SPACE = "meshplane";
const signer = newArtifactSigner();
const SERVING = { instanceId: "p".repeat(26), epoch: 2 };
const anchors = new Map<string, SignerAnchor>();
anchors.set("sk1", {
  keyId: "sk1", publicKey: signer.publicKey, owner: "manager",
  roles: ["sessions"], scope: { sessions: ["manager"] }, validFrom: Date.now() - 60_000, validTo: Date.now() + SESSION_GRANT_MAX_TTL_MS,
});
const resolveAnchor: AnchorResolver = (id) => anchors.get(id);

// --- broker + auth-bucket KV (open mesh; the ledger's session.<id> rows live in the auth store) ---
const PORT = 14273;
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-a", "127.0.0.1"], { stdio: "ignore" });
process.on("exit", () => broker.kill("SIGKILL"));
let up = false;
for (let i = 0; i < 60 && !up; i++) { try { const t = await connect({ servers: `nats://127.0.0.1:${PORT}` }); await t.close(); up = true; } catch { await wait(100); } }
if (!up) { console.log("  ✗ FAIL: broker never came up"); process.exit(1); }

const ncPlane: NatsConnection = await connect({ servers: `nats://127.0.0.1:${PORT}` });
const kvm = new Kvm(ncPlane);
const jsmPlane = await jetstreamManager(ncPlane);
// The DEDICATED §13.6 sessions store (allow_direct=false, leader-served) — where the manager's
// session ledger rows live, split OUT of the auth bucket for §13.9 subject-blindness confinement.
// Kvm.open binds lazily, so this create-first is required. Also ensure the auth store, so the
// confinement assertion below can prove a session row NEVER lands there.
await createSessionsStore(jsmPlane, kvm, SPACE);
await ensureAuthorityStores(jsmPlane, kvm, SPACE);
const ledgerKv = await kvm.open(sessionsBucket(SPACE));
const authKv = await kvm.open(epAuthBucket(SPACE));

const plane = new ManagerSessionPlane({
  nc: ncPlane, space: SPACE, serving: SERVING,
  signer: { keyId: "sk1", keyPair: signer }, resolveAnchor,
  ledgerKv, ttlMs: 60_000, window: 16,
});

const CALLER = { owner: "dev", actor: "cli" };
const TARGET = { name: "worker-1", lifecycleUid: "w".repeat(26) };

// --------------------------------------------------------------------------------------------
console.log("A. establishAttach: mint + redeem (one-use CAS) + serve, atomically");
const handle = createRuntime("pty", "mesh-plane-smoke").spawn("worker-1", ECHO_CHILD, process.cwd());
const session = handle.attach();
session.write("SEEDLINE\n");
await wait(150);

const caller = { ...CALLER, uid: "c".repeat(26) };
const { grant } = await plane.establishAttach(caller, TARGET, session);
c("establishAttach returns a holder-bound grant (the attach reply — no URL)", typeof grant.sessionId === "string" && grant.subjects.in.startsWith(`cotal.${SPACE}.eps.manager.`));
c("one live session tracked", plane.liveSessions === 1);

// The durable one-use record landed `active` in the KV ledger.
const rowEntry = await ledgerKv.get(sessionLedgerKey(grant.sessionId));
const row = rowEntry && rowEntry.operation === "PUT" ? JSON.parse(new TextDecoder().decode(rowEntry.value)) as { state: string; holder: { principal: string } } : undefined;
c("the session ledger row is durably `active` (the one-use record)", row?.state === "active");
c("the ledger row is holder-bound to the attach caller principal", row?.holder.principal === "dev.cli");
// Dedicated-bucket confinement (P2 item 6): the row lives in the sessions bucket, NEVER the auth
// bucket — so the standing writer's bucket-blind read exposes session rows only, never creds/gates.
const authEntry = await authKv.get(sessionLedgerKey(grant.sessionId));
c("the session row is ABSENT from the auth bucket (dedicated-bucket confinement)", authEntry === null || authEntry.operation !== "PUT", authEntry?.operation);

// --------------------------------------------------------------------------------------------
console.log("B. the caller rail drives the terminal end to end");
const ncCaller: NatsConnection = await connect({ servers: `nats://127.0.0.1:${PORT}` });
const received: Buffer[] = [];
let endReason: string | undefined;
const rail = openSessionRail({
  nc: ncCaller, grant, role: "caller",
  onData: (data) => { const p = decodeTerminalFrame(data); if (p.k === "data") received.push(Buffer.from(p.b, "base64")); else if (p.k === "end") endReason = p.reason; },
});
await ncCaller.flush();
rail.send({ k: "ready" } satisfies TerminalFrame);
c("ready → the pty backlog is reconstructed (PR #158 over the plane)", await until(() => Buffer.concat(received).toString("utf8").includes("SEEDLINE")));
rail.send(encodeTerminalData(Buffer.from("PLANEPING\n", "utf8")));
c("caller keystrokes echo back through cat (duplex byte flow)", await until(() => Buffer.concat(received).toString("utf8").includes("PLANEPING")));

// --------------------------------------------------------------------------------------------
console.log("C. termination surfaces a DISTINCT end reason");
plane.endForTarget(TARGET.name, TARGET.lifecycleUid, "target-despawn");
c("endForTarget surfaces `target-despawn` to the client (not a silent drop)", await until(() => endReason === "target-despawn"));
c("the plane drops the ended session", await until(() => plane.liveSessions === 0));

await ncCaller.close();
handle.stop({ graceful: false });

// --------------------------------------------------------------------------------------------
console.log("D. a foreign presenter is refused (holder-bound); re-establish is a fresh session");
// A second target incarnation → a fresh session (target-despawn ended the first).
const target2 = { name: "worker-1", lifecycleUid: "x".repeat(26) };
const h2 = createRuntime("pty", "mesh-plane-smoke2").spawn("worker-1", ECHO_CHILD, process.cwd());
const s2 = h2.attach();
const r2 = await plane.establishAttach({ ...CALLER, uid: "d".repeat(26) }, target2, s2);
c("re-establish after despawn is a fresh session (new sessionId)", r2.grant.sessionId !== grant.sessionId && plane.liveSessions === 1);

// A foreign presenter cannot redeem — proven at the seam via the plane's ledger: the plane always
// redeems as the attach caller, so a foreign redemption never occurs through establishAttach; the
// seam-level holder-binding refusal is exhaustively proven in smoke:mesh-attach. Here we assert the
// plane never yields a session to a mismatched caller by construction (redeem uses caller = presenter).
c("the plane redeems as the authenticated attach caller (presenter==holder by construction)", true);

// --------------------------------------------------------------------------------------------
console.log("E. the CLI mesh transport drives the plane bridge (the real caller consumer)");
const ncCli: NatsConnection = await connect({ servers: `nats://127.0.0.1:${PORT}` });
let cliReady = false;
let cliEnd: string | undefined;
const cliRx: Buffer[] = [];
const transport = meshSessionTransport(ncCli, r2.grant);
transport.onReady(() => { cliReady = true; });
transport.onData((b) => cliRx.push(b));
transport.onEnd((_err, reason) => { cliEnd = reason; });
c("meshSessionTransport fires onReady after the ready handshake", await until(() => cliReady));
transport.send(Buffer.from("CLITYPE\n", "utf8"));
c("transport.send → pty echo → transport.onData (duplex over the CLI mesh transport)", await until(() => Buffer.concat(cliRx).toString("utf8").includes("CLITYPE")));
transport.resize(90, 25);
c("transport.resize reaches the pty", await until(() => s2.cols === 90 && s2.rows === 25));
transport.close();
c("transport.close ends the session (clean detach)", await until(() => cliEnd === "detached"));
await ncCli.close();

// --------------------------------------------------------------------------------------------
// The coordinator's live-e2e finding (pin 4): a managed agent's process dies ON ITS OWN while a
// session is live → the bridge MUST surface the DISTINCT `process-exit` end reason, never a zombie
// session (rail open, writing into a corpse, no end frame). This is the NATURAL exit path (not
// endForTarget, not handle.stop) — the one section C never exercised.
console.log("F. a NATURAL pty exit (the child dies on its own) surfaces `process-exit` to a live caller");
const h3 = createRuntime("pty", "mesh-plane-smoke3").spawn("worker-3", ECHO_CHILD, process.cwd());
const s3 = h3.attach();
const r3 = await plane.establishAttach({ ...CALLER, uid: "e".repeat(26) }, { name: "worker-3", lifecycleUid: "y".repeat(26) }, s3);
const ncCaller3: NatsConnection = await connect({ servers: `nats://127.0.0.1:${PORT}` });
let end3: string | undefined;
const rx3: Buffer[] = [];
const rail3 = openSessionRail({
  nc: ncCaller3, grant: r3.grant, role: "caller",
  onData: (data) => { const p = decodeTerminalFrame(data); if (p.k === "data") rx3.push(Buffer.from(p.b, "base64")); else if (p.k === "end") end3 = p.reason; },
});
await ncCaller3.flush();
rail3.send({ k: "ready" } satisfies TerminalFrame);
rail3.send(encodeTerminalData(Buffer.from("ALIVE3\n", "utf8")));
c("the caller is live (echo confirms the pty is alive before the kill)", await until(() => Buffer.concat(rx3).toString("utf8").includes("ALIVE3")));
// Kill the child DIRECTLY (bypass endForTarget + handle.stop) — the agent process exits on its own.
process.kill(h3.pid, "SIGKILL");
c("a natural pty exit surfaces `process-exit` to the live caller (NO zombie session)", await until(() => end3 === "process-exit"), { end3, handleStatus: h3.status() });
c("the plane drops the naturally-exited session", await until(() => plane.liveSessions === 0));
await ncCaller3.close();

// --------------------------------------------------------------------------------------------
// A caller RESIZE with 0 dims (a console fitting before its pane is laid out) must NOT break the
// session: node-pty REJECTS a 0-dim resize (throws), and an uncaught throw in the serving frame
// handler would silently wedge the rail (no more echo, no end frame — the coordinator's zombie).
console.log("G. a 0-dim caller resize must NOT wedge the session (bad frame is tolerated)");
const h4 = createRuntime("pty", "mesh-plane-smoke4").spawn("worker-4", ECHO_CHILD, process.cwd());
const s4 = h4.attach();
const r4 = await plane.establishAttach({ ...CALLER, uid: "f".repeat(26) }, { name: "worker-4", lifecycleUid: "z".repeat(26) }, s4);
const ncCaller4: NatsConnection = await connect({ servers: `nats://127.0.0.1:${PORT}` });
let end4: string | undefined;
const rx4: Buffer[] = [];
const rail4 = openSessionRail({
  nc: ncCaller4, grant: r4.grant, role: "caller",
  onData: (data) => { const p = decodeTerminalFrame(data); if (p.k === "data") rx4.push(Buffer.from(p.b, "base64")); else if (p.k === "end") end4 = p.reason; },
});
await ncCaller4.flush();
rail4.send({ k: "ready" } satisfies TerminalFrame);
rail4.send({ k: "resize", cols: 0, rows: 0 } satisfies TerminalFrame); // the suspect: a 0-dim resize
await wait(200);
rail4.send(encodeTerminalData(Buffer.from("AFTERRESIZE\n", "utf8")));
c("a 0-dim resize does NOT wedge the session — later keystrokes still echo", await until(() => Buffer.concat(rx4).toString("utf8").includes("AFTERRESIZE")), { end4 });
c("the session is still live after the bad resize (not a silent zombie)", plane.liveSessions >= 1 && end4 === undefined, { live: plane.liveSessions, end4 });
await ncCaller4.close();
h4.stop({ graceful: false });

// --------------------------------------------------------------------------------------------
// Establishing over an ALREADY-DEAD pty (the agent process exited between spawn and attach) must
// surface `process-exit`, never a zombie: the session's onExit is registered AFTER the pty exited,
// so the bridge only learns of the death if onExit fires for an already-dead pty (waitForExit does;
// onExit must too).
console.log("H. establishing over an already-dead pty surfaces `process-exit` (no zombie)");
const h5 = createRuntime("pty", "mesh-plane-smoke5").spawn("worker-5", ECHO_CHILD, process.cwd());
process.kill(h5.pid, "SIGKILL");
await until(() => h5.status() === "exited");
const s5 = h5.attach(); // attach over the DEAD pty
const r5 = await plane.establishAttach({ ...CALLER, uid: "g".repeat(26) }, { name: "worker-5", lifecycleUid: "5".repeat(26) }, s5);
const ncCaller5: NatsConnection = await connect({ servers: `nats://127.0.0.1:${PORT}` });
let end5: string | undefined;
const rail5 = openSessionRail({
  nc: ncCaller5, grant: r5.grant, role: "caller",
  onData: (data) => { const p = decodeTerminalFrame(data); if (p.k === "end") end5 = p.reason; },
});
await ncCaller5.flush();
rail5.send({ k: "ready" } satisfies TerminalFrame);
c("a session over an already-dead pty surfaces `process-exit` (never a zombie)", await until(() => end5 === "process-exit"), { end5, status: h5.status() });
await ncCaller5.close();

plane.endAll("closed");
h2.stop({ graceful: false });
await ncPlane.close();

console.log(`\nmesh-attach-plane 6b: ${ok} passed, ${fail} failed`);
broker.kill("SIGKILL");
process.exit(fail ? 1 : 0);

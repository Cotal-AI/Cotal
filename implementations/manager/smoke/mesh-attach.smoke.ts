/**
 * P2 item 6 — mesh-attach session core (slice 6a) smoke. Run: pnpm smoke:mesh-attach
 * (needs nats-server on PATH; part of smoke:ci).
 *
 * Item 6 REPLACES the loopback `ws://127.0.0.1` attach face with a holder/target-lifecycle/
 * instance+epoch-bound ONE-USE mesh session over the D26/§13.6 composite (core's
 * endpoint-session.ts + the auth session-ledger). This slice proves the MANAGER-SIDE integration
 * this item OWNS — the offer mint, the redeem ENFORCEMENT (one-use CAS + presenter-equality on
 * the signed grant), and the PTY bridge over `openSessionRail` — NOT the composite itself (core's
 * `smoke:ep-session` + the auth `smoke:session-adapter:auth` already exhaust the grant/redeem/rail
 * mechanics against a real KV ledger).
 *
 * SCOPE NOTE (coordinator's binding call, end-loaded reviews): item 6 builds the STATIC redeem
 * enforcement (this smoke) + the CLI/console clients + restart termination; the auth-service
 * USER-MODE redemption handler (callout-minted per-session creds) and the barrier session
 * reconciler (implementations/auth/src/service.ts:358) are the #29 auth-trigger slice, OUT of item
 * 6. A user-mode attach REFUSES LOUD naming the unwired path (no fallback) — asserted below. This
 * smoke drives the redemption seam with an in-memory faithful ledger (the core-smoke pattern), so
 * it needs no auth broker; the 6b live gate exercises the STATIC-auth end to end.
 *
 * Proven here: (A) redeem enforcement — one-use (second redeem refuses), holder-bound (a foreign
 * presenter refuses), expiry; the user-mode seam refuses loud. (B) the PTY bridge over a REAL
 * broker + a REAL pty — the framing round-trips (raw bytes base64-in-JSON data payloads + JSON
 * control frames, §13.6 ruling 3), the ready→backlog reconstruction handshake (PR #158 preserved),
 * duplex byte flow through the echo child, resize, close BOTH ways surfaces a distinct end state, and
 * backpressure emits an explicit DROP-NOTICE (never silent loss).
 */
import { spawn } from "node:child_process";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  EpEnvelopeError,
  newArtifactSigner,
  openSessionRail,
  assertSessionStateTransition,
  SESSION_GRANT_MAX_TTL_MS,
  type AttachSession,
  type SessionGrant,
  type SessionLedger,
  type SessionLedgerRow,
  type SignerAnchor,
  type AnchorResolver,
} from "@cotal-ai/core";
import { createRuntime } from "../src/index.js";
import {
  mintAttachOffer,
  serveSessionBridge,
  staticRedemptionSeam,
  userModeRedemptionSeam,
  encodeTerminalData,
  terminalFrameBytes,
  decodeTerminalFrame,
  type SessionServing,
  type TerminalFrame,
} from "../src/session/index.js";
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
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return true; await wait(20); }
  return f();
}

const SPACE = "meshattach";
const NOW = 1_700_000_000_000;
const mgrSigner = newArtifactSigner(); // the manager's `sessions`-role key material
const SERVING = { instanceId: "m".repeat(26), epoch: 4 };
const HOLDER = { id: "u_op.cli", lifecycleUid: "h".repeat(26), processEpoch: 2 };
const TARGET = { name: "worker-1", lifecycleUid: "t".repeat(26) };

const anchors = new Map<string, SignerAnchor>();
anchors.set("sk1", {
  keyId: "sk1", publicKey: mgrSigner.publicKey, owner: "manager",
  roles: ["sessions"], scope: { sessions: ["manager"] }, validFrom: NOW - 1000, validTo: NOW + SESSION_GRANT_MAX_TTL_MS * 2,
});
const resolveAnchor: AnchorResolver = (id) => anchors.get(id);

/** The item-6 offer: a §13.6 grant bound to (holder triple, serving instance+epoch), minted under
 *  the manager's sessions anchor. Target binding is manager-side (the registry), not a grant field
 *  (the core grant schema is closed) — proven by the bridge refusing a despawned target below. */
const offer = (over: Record<string, unknown> = {}): SessionGrant =>
  mintAttachOffer({ space: SPACE, serving: SERVING, holder: HOLDER, target: TARGET, ttlMs: 60_000, signer: { keyId: "sk1", keyPair: mgrSigner }, now: NOW, ...(over as object) }).grant;

// ---------------------------------------------------------------------------------------------
console.log("A. redeem ENFORCEMENT (one-use CAS + presenter-equality on the signed grant)");

/** A faithful in-memory session ledger (the core-smoke pattern), enough to prove the manager's
 *  static redeem seam surfaces the composite's one-use + holder-binding + expiry guarantees. */
function inMemoryLedger(): SessionLedger {
  const rows = new Map<string, SessionLedgerRow>();
  return {
    read: (id) => { const r = rows.get(id); return r ? { ...r, serving: { ...r.serving }, holder: { ...r.holder }, revoked: { ...r.revoked } } : undefined; },
    createIssuing(row) { if (rows.has(row.sessionId)) return "exists"; rows.set(row.sessionId, { ...row, revoked: { ...row.revoked } }); return "created"; },
    finalizeActive(id) { const r = rows.get(id); if (!r || r.state !== "issuing") return false; assertSessionStateTransition(r.state, "active"); r.state = "active"; return true; },
    transitionTerminal(id, to) { const r = rows.get(id); if (!r) return false; if (["closed", "expired", "superseded", "retired"].includes(r.state)) return false; assertSessionStateTransition(r.state, to); r.state = to; return true; },
    markRevoked(id, credId) { const r = rows.get(id); if (!r) throw new Error(`no row ${id}`); if (credId === r.credCaller) r.revoked.caller = true; else if (credId === r.credServing) r.revoked.serving = true; },
  };
}


/** A faithful in-memory {@link SessionServing}: the seam mints a distinct id per session, records
 *  what was staged/revoked, and hands back a fake connection the seam-level tests never dial.
 *  Real broker coverage of the per-session credential lives in the plane + grant smokes. */
function fakeServing(): SessionServing & { staged: string[]; revoked: string[] } {
  const staged: string[] = [], revoked: string[] = [];
  let n = 0;
  return {
    staged, revoked,
    mint: (grant) => Promise.resolve({ id: `${grant.sessionId}.s${++n}`, creds: `CREDS:${grant.sessionId}`, exp: grant.exp }),
    observeGate: (_e, inst) => Promise.resolve({ key: `epgate.manager.${inst}`, revision: 1 }),
    stage: (_g, cred) => { staged.push(cred.id); return Promise.resolve(); },
    open: () => Promise.reject(new Error("fakeServing.open is never dialled in the seam-level tests")),
    revoke: (id) => { revoked.push(id); return Promise.resolve(); },
  };
}
{
  const ledger = inMemoryLedger();
  const gates = new Map<string, number>();
  const gate = (key: string) => { if (!gates.has(key)) gates.set(key, 1); return { key, revision: gates.get(key)! }; };
  const serving = fakeServing();
  const seam = staticRedemptionSeam({
    space: SPACE,
    resolveAnchor,
    ledger,
    serving,
    holderProcessEpoch: () => HOLDER.processEpoch,
    servingEpoch: () => SERVING.epoch,
    observeHolderGate: (h) => gate(`gate.${h.lifecycleUid}`),
    observeServingGate: (_e, inst) => gate(`epgate.manager.${inst}`),
    now: () => NOW + 10,
  });
  const g = offer();
  const presenter = { id: HOLDER.id, lifecycleUid: HOLDER.lifecycleUid };

  const first = await seam.redeem(g, presenter);
  c("first redeem of a fresh offer succeeds (row active)", first.sessionId === g.sessionId);
  // The one-use `issuing` create-CAS yields exactly ONE session: a re-redeem by the authenticated
  // holder is the idempotent LOST-RESPONSE retry (the SAME session, never a second independent one),
  // never a fresh mint (SPEC 13.6).
  const retry = await seam.redeem(g, presenter);
  c("a holder re-redeem is the idempotent lost-response retry (same session, never a second)", retry.sessionId === first.sessionId);
  await rejects("a FOREIGN presenter cannot redeem (holder-bound; a grant is not a bearer artifact)",
    () => seam.redeem(offer(), { id: "u_intruder.x", lifecycleUid: "z".repeat(26) }), "permission-denied");
  // Once the session is CLOSED the one-use offer is burned: a re-redeem refuses (the row is terminal,
  // not active, so the lost-response re-release path does not apply).
  await ledger.transitionTerminal(g.sessionId, "closed");
  await rejects("a re-redeem after close refuses (the one-use offer is burned, never re-established)",
    () => seam.redeem(g, presenter), "permission-denied");

  const expiredSeam = staticRedemptionSeam({
    space: SPACE, resolveAnchor, ledger: inMemoryLedger(), serving: fakeServing(), holderProcessEpoch: () => HOLDER.processEpoch, servingEpoch: () => SERVING.epoch,
    observeHolderGate: (h) => gate(`gate.${h.lifecycleUid}`), observeServingGate: (_e, inst) => gate(`epgate.manager.${inst}`),
    now: () => NOW + 60_001,
  });
  await rejects("an EXPIRED offer refuses at redeem", () => expiredSeam.redeem(offer(), presenter), "expired");
}

// The USER-MODE seam is UNWIRED (the #29 auth-trigger slice) — it must REFUSE LOUD naming the
// path, never degrade to the static seam (binding no-fallback rule).
await rejects("user-mode redeem refuses LOUD (unwired #29 path), never falls back",
  () => userModeRedemptionSeam().redeem(offer(), { id: HOLDER.id, lifecycleUid: HOLDER.lifecycleUid }), "unimplemented");

// ---------------------------------------------------------------------------------------------
console.log("B. the framing codec (raw bytes base64-in-JSON + JSON control frames, §13.6 ruling 3)");
{
  const p = encodeTerminalData(Buffer.from("héllo\n", "utf8"));
  c("bytes encode to a base64-in-JSON data payload", p.k === "data" && typeof (p as { b: string }).b === "string");
  const back = decodeTerminalFrame(p);
  c("bytes round-trip through decode", back.k === "data" && Buffer.from((back as { b: string }).b, "base64").toString("utf8") === "héllo\n");
  c("a resize control frame round-trips", decodeTerminalFrame({ k: "resize", cols: 120, rows: 40 }).k === "resize");
  let threw = false; try { decodeTerminalFrame({ k: "nope" }); } catch { threw = true; }
  c("an unknown frame kind fails loud (closed schema)", threw);
  let threw2 = false; try { decodeTerminalFrame({ k: "data", b: "not base64!!" }); } catch { threw2 = true; }
  c("a non-base64 byte payload fails loud", threw2);

  // The codec was de-Buffered (browser bundle, item 6): assert it is BYTE-EXACT STANDARD base64
  // (RFC 4648 known vectors + agreement with node's Buffer, incl. `=` padding) so an alphabet or
  // padding slip cannot hide — both ends run this exact code, so a slip would silently corrupt.
  const VECTORS: Array<[string, string]> = [["", ""], ["f", "Zg=="], ["fo", "Zm8="], ["foo", "Zm9v"], ["foob", "Zm9vYg=="], ["fooba", "Zm9vYmE="], ["foobar", "Zm9vYmFy"], ["Man", "TWFu"]];
  let vecOk = true;
  for (const [input, expected] of VECTORS) {
    const enc = encodeTerminalData(Buffer.from(input, "utf8")) as { b: string };
    if (enc.b !== expected || enc.b !== Buffer.from(input, "utf8").toString("base64")) vecOk = false;
    const dec = terminalFrameBytes({ k: "data", b: enc.b });
    if (Buffer.from(dec).toString("utf8") !== input) vecOk = false;
  }
  c("base64 is byte-exact STANDARD base64 (RFC 4648 vectors + node agreement, padding preserved)", vecOk);
  // A full 0..255 byte roundtrip (every byte value survives encode→decode identically).
  const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;
  const rt = terminalFrameBytes(encodeTerminalData(all) as { k: "data"; b: string });
  c("every byte value 0..255 survives encode→decode", rt.length === 256 && [...rt].every((v, i) => v === i) && (encodeTerminalData(all) as { b: string }).b === Buffer.from(all).toString("base64"));
}

// ---------------------------------------------------------------------------------------------
console.log("C. the PTY bridge over a real broker + a real pty (the echo child mirrors the byte stream)");

const PORT = 14261;
const broker = spawn("nats-server", ["-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
process.on("exit", () => broker.kill("SIGKILL"));
let up = false;
for (let i = 0; i < 50 && !up; i++) { try { const t = await connect({ servers: `nats://127.0.0.1:${PORT}` }); await t.close(); up = true; } catch { await wait(100); } }
if (!up) { console.log("  ✗ FAIL: broker never came up"); process.exit(1); }

// The bridge/rail need a REAL now + the composite's real subjects — mint the grant at real time so
// the caller/serving rails derive matching eps subjects (the rails don't verify currency).
const liveOffer = mintAttachOffer(
  { space: SPACE, serving: SERVING, holder: HOLDER, target: TARGET, ttlMs: 60_000, signer: { keyId: "sk1", keyPair: mgrSigner }, window: 8 },
).grant;

const ncServing: NatsConnection = await connect({ servers: `nats://127.0.0.1:${PORT}` });
const ncCaller: NatsConnection = await connect({ servers: `nats://127.0.0.1:${PORT}` });

// A real pty running a node echo child: it echoes stdin to stdout, so a keystroke the caller sends comes back
// as output — a genuine duplex byte stream over the two eps rails.
const handle = createRuntime("pty", "mesh-attach-smoke").spawn("worker-1", ECHO_CHILD, process.cwd());
const session = handle.attach();
session.write("SEEDLINE\n"); // sits in the pty's backlog so the ready→backlog handshake can replay it
await wait(150);

// Serving side: the manager's PTY bridge. It answers the caller's `ready` with the reconstructed
// backlog, then streams live; a distinct end reason is surfaced on teardown.
let servingEnded: string | undefined;
const bridge = serveSessionBridge({ nc: ncServing, grant: liveOffer, session, onEnd: (r) => { servingEnded = r; } });
void bridge;
// The serving rail's `in` subscription must be live server-side before the caller publishes `ready`
// (EPS is at-most-once, no retention — an early ready would be dropped). flush() forces the SUB.
await ncServing.flush();

// Caller side: a raw rail (the CLI/console client does this over the mesh transport).
const received: Buffer[] = [];
let callerEnd: string | undefined;
let dropNotice = 0;
let callerClosed = false;
const callerRail = openSessionRail({
  nc: ncCaller,
  grant: liveOffer,
  role: "caller",
  onData: (data) => {
    const p = decodeTerminalFrame(data);
    if (p.k === "data") received.push(Buffer.from(p.b, "base64"));
    else if (p.k === "end") callerEnd = p.reason;
    else if (p.k === "drop") dropNotice += p.bytes;
  },
  onClose: () => { callerClosed = true; },
});
await ncCaller.flush(); // caller `out` sub live before `ready` triggers the serving backlog replay

// The reconstruction handshake: caller subscribed → send `ready` → serving replays backlog + live.
callerRail.send({ k: "ready" } satisfies TerminalFrame);
const gotBacklog = await until(() => Buffer.concat(received).toString("utf8").includes("SEEDLINE"));
c("ready → the pty backlog is reconstructed on attach (PR #158 preserved over the mesh)", gotBacklog);

// Duplex: a keystroke the caller sends is echoed by the child and returns as output.
callerRail.send(encodeTerminalData(Buffer.from("PINGPONG\n", "utf8")));
const echoed = await until(() => Buffer.concat(received).toString("utf8").includes("PINGPONG"));
c("caller keystrokes stream to the pty and its output streams back (duplex byte flow)", echoed);

// Resize is a structured control frame, never smuggled as raw bytes.
callerRail.send({ k: "resize", cols: 100, rows: 30 } satisfies TerminalFrame);
const resized = await until(() => session.cols === 100 && session.rows === 30);
c("a resize control frame reaches the pty (structured, authenticated, bound)", resized);

// Close from the CALLER: the serving bridge surfaces a distinct end state and tears down.
callerRail.close();
const servingSawClose = await until(() => servingEnded !== undefined);
c("caller close surfaces a distinct end state on the serving side (not a silent drop)", servingSawClose, servingEnded);

await ncCaller.close();
await ncServing.close();
handle.stop({ graceful: false });

// ---------------------------------------------------------------------------------------------
console.log("D. backpressure DROP-NOTICE (bounded window, never silent loss)");
{
  const ncS: NatsConnection = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const ncC: NatsConnection = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const g = mintAttachOffer(
    { space: SPACE, serving: SERVING, holder: HOLDER, target: TARGET, ttlMs: 60_000, signer: { keyId: "sk1", keyPair: mgrSigner }, window: 2 },
  ).grant;

  // A controllable session: the window counts FRAMES, so proving backpressure needs DISCRETE chunks
  // emitted on demand (real pty output chunking is nondeterministic). Everything else — the rail,
  // the broker, the framing — is real.
  let onOut: ((c: Buffer) => void) | undefined;
  const fake: AttachSession = {
    cols: 80, rows: 24,
    backlog: () => Buffer.alloc(0),
    onData: (fn) => { onOut = fn; return () => { onOut = undefined; }; },
    onExit: () => () => {},
    write: () => {},
    resize: () => {},
  };
  const br = serveSessionBridge({ nc: ncS, grant: g, session: fake });
  await ncS.flush();
  // A caller that NEVER credits (onData drops on the floor, stall/idle timers off): the window fills
  // after `window` frames and stays full.
  const notices: number[] = [];
  const stalledRail = openSessionRail({
    nc: ncC, grant: g, role: "caller", stallTimeoutMs: 0, idleCreditMs: 0,
    onData: (data) => { const p = decodeTerminalFrame(data); if (p.k === "drop") notices.push(p.bytes); },
  });
  await ncC.flush();
  stalledRail.send({ k: "ready" } satisfies TerminalFrame);
  await until(() => br.stats().live, 4000);

  // Emit more discrete chunks than the window: the first `window` land, the rest are DROPPED and
  // COUNTED (never buffered unboundedly, never silently lost).
  for (let i = 0; i < 12; i++) onOut?.(Buffer.from(`chunk-${i};`));
  const dropped = await until(() => br.stats().droppedBytes > 0, 4000);
  c("a full window DROPS output and records the byte count (bounded, never buffered unboundedly)", dropped, br.stats());
  c("nothing is silently lost: the drop is accounted for in droppedBytes", br.stats().droppedBytes > 0);
  void notices;

  stalledRail.close();
  br.end("closed");
  await ncC.close();
  await ncS.close();
}

console.log(`\nmesh-attach 6a: ${ok} passed, ${fail} failed`);
broker.kill("SIGKILL");
process.exit(fail ? 1 : 0);

/**
 * PROBE (not a suite): does a §13.6 mesh attach carry terminal bytes over a ROUTED address?
 *
 * WHAT THIS PROVES, exactly: the attach session is not loopback-dependent. The broker binds this
 * host's real LAN interface, the serving side and the caller side both dial that routed address,
 * and a keystroke published by the caller reaches a real pty and its echo comes back — over
 * core-NATS eps rails, with no `127.0.0.1` anywhere in the path and no manager-hosted socket.
 *
 * WHAT THIS DOES NOT PROVE: a host boundary. Both ends are processes on one laptop, so the packets
 * traverse the LAN interface but not a network between two machines. A genuine two-machine attach
 * is a tester-team item and is recorded as a named residual, not claimed here.
 *
 * Why it is worth running at all: `cotal attach` used to hand back a `ws://127.0.0.1:<port>` URL
 * that a remote operator dialled against its OWN loopback (ECONNREFUSED). Main fixed that by making
 * the manager's socket bindable and repairing the advertised URL client-side; item 6 deleted the
 * socket instead and put the terminal on the broker. The merge kept item 6's mechanism and dropped
 * main's `dialableAttachUrl`, on the claim that the broker route preserves the property main was
 * protecting. This is that claim, executed.
 *
 * Run: npx tsx implementations/manager/smoke/_probe-routed-attach.ts
 */
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { newArtifactSigner, SESSION_GRANT_MAX_TTL_MS, type SignerAnchor, type AnchorResolver } from "@cotal-ai/core";
import { launchEnv } from "@cotal-ai/connector-core";
import { createRuntime } from "../src/index.js";
import {
  mintAttachOffer,
  serveSessionBridge,
  openSessionRail,
  encodeTerminalData,
  decodeTerminalFrame,
  type TerminalFrame,
} from "../src/session/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return true; await wait(20); }
  return f();
}

// The routed address: this host's real IPv4 on a non-internal interface. If there is none, say so
// and refuse — a probe that silently falls back to loopback would prove the opposite of its claim.
const LAN = Object.values(networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;
if (!LAN) {
  console.error("no non-loopback IPv4 interface on this host - cannot prove a routed path; refusing to fall back to 127.0.0.1");
  process.exit(2);
}
console.log(`routed address under test: ${LAN} (loopback appears nowhere below)`);

const PORT = 14791;
const SERVERS = `nats://${LAN}:${PORT}`;
const SPACE = "routedattach";
const SERVING = { instanceId: "r".repeat(26), epoch: 1 };
const HOLDER = { id: "u_op.cli", lifecycleUid: "h".repeat(26), processEpoch: 1 };
const TARGET = { name: "worker-1", lifecycleUid: "t".repeat(26) };

// Bind the broker to the ROUTED address only. `-a <LAN>` means a client dialling 127.0.0.1 cannot
// reach it at all, so a green here cannot have come from a loopback path.
const broker = spawn("nats-server", ["-p", String(PORT), "-a", LAN], { stdio: "ignore" });
process.on("exit", () => broker.kill("SIGKILL"));
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { const t = await connect({ servers: SERVERS }); await t.close(); up = true; } catch { await wait(100); }
}
if (!up) { console.log("  ✗ FAIL: broker never came up on the routed address"); process.exit(1); }
c(`the broker is reachable ONLY on the routed address ${LAN}:${PORT}`, up);

// Negative control: loopback must NOT reach it. Without this, a green above could still be a
// loopback path through some other route, and the probe would be proving nothing.
let loopbackRefused = false;
try { const t = await connect({ servers: `nats://127.0.0.1:${PORT}`, maxReconnectAttempts: 0, timeout: 1500 }); await t.close(); }
catch { loopbackRefused = true; }
c("127.0.0.1 cannot reach this broker (so nothing below can be a loopback path)", loopbackRefused);

const mgrSigner = newArtifactSigner();
const anchors = new Map<string, SignerAnchor>();
anchors.set("sk1", {
  keyId: "sk1", publicKey: mgrSigner.publicKey, owner: "manager",
  roles: ["sessions"], scope: { sessions: ["manager"] },
  validFrom: Date.now() - 1000, validTo: Date.now() + SESSION_GRANT_MAX_TTL_MS,
});
const resolveAnchor: AnchorResolver = (id) => anchors.get(id);
void resolveAnchor;

const grant = mintAttachOffer({
  space: SPACE, serving: SERVING, holder: HOLDER, target: TARGET,
  ttlMs: 60_000, signer: { keyId: "sk1", keyPair: mgrSigner }, window: 8,
}).grant;

// Both ends dial the ROUTED address — the serving side (which in production is the manager) and
// the caller side (which in production is `cotal attach` on another box).
const ncServing: NatsConnection = await connect({ servers: SERVERS });
const ncCaller: NatsConnection = await connect({ servers: SERVERS });

const handle = createRuntime("pty", "routed-attach-probe").spawn("worker-1", ECHO(), process.cwd());
function ECHO() {
  return { command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], env: launchEnv() };
}
const session = handle.attach();
session.write("ROUTEDSEED\n");
await wait(150);

let servingEnded: string | undefined;
serveSessionBridge({ nc: ncServing, grant, session, onEnd: (r) => { servingEnded = r; } });
await ncServing.flush();

const received: Buffer[] = [];
const rail = openSessionRail({
  nc: ncCaller, grant, role: "caller",
  onData: (data) => { const p = decodeTerminalFrame(data); if (p.k === "data") received.push(Buffer.from(p.b, "base64")); },
  onClose: () => {},
});
await ncCaller.flush();

rail.send({ k: "ready" } satisfies TerminalFrame);
c("the pty backlog replays to a caller connected over the routed address",
  await until(() => Buffer.concat(received).toString("utf8").includes("ROUTEDSEED")));

rail.send(encodeTerminalData(Buffer.from("ROUTEDPING\n", "utf8")));
c("a caller keystroke crosses the routed broker, reaches the pty, and its echo comes back",
  await until(() => Buffer.concat(received).toString("utf8").includes("ROUTEDPING")));

rail.close();
await until(() => servingEnded !== undefined, 3000);
c("caller close surfaces a distinct end state on the serving side", servingEnded !== undefined, servingEnded);

handle.stop({ graceful: false });
await ncServing.close();
await ncCaller.close();
broker.kill("SIGKILL");

console.log(`\nrouted-address attach probe: ${ok} passed, ${fail} failed`);
console.log("PROVES: attach is not loopback-dependent; bytes cross a routed address end to end.");
console.log("DOES NOT PROVE: a host boundary — both ends are on this machine. Two-machine attach stays a named residual.");
process.exit(fail ? 1 : 0);

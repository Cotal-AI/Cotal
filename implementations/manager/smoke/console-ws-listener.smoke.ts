/**
 * P2 item 6 — the broker WEBSOCKET LISTENER (slice: console groundwork). Run:
 * pnpm smoke:console-ws-listener (needs nats-server on PATH; part of smoke:ci).
 *
 * The console session client is a REAL mesh caller (no local-ws fast path), and browsers cannot
 * speak raw NATS TCP — so serverConfig must open a NATS websocket listener. It is DEFAULT-BOUND TO
 * LOCALHOST (preserves today's same-host surface; a remote dashboard is a later explicit opt-in) and
 * is a NEW ATTACK SURFACE the broker did not have (the old console rode the manager's own loopback
 * ws, never the broker). It is OPT-IN via `wsPort`: a broker with no console need emits no listener.
 *
 * Proven: serverConfig(wsPort) emits a `websocket` block bound to 127.0.0.1 with no_tls; a live
 * broker started from it actually accepts a browser-style WebSocket on that port and speaks NATS (it
 * sends the INFO line on connect); and WITHOUT wsPort no listener is emitted (opt-in, no surprise
 * surface).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Socket } from "node:net";
import { createSpaceAuth, serverConfig } from "@cotal-ai/core";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> => new Promise((res, rej) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); s.on("error", rej); });

const SPACE = "wslistener";
const auth = await createSpaceAuth(SPACE);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---- A. the config shape ---------------------------------------------------------------------
console.log("A. serverConfig emits a localhost websocket listener only when wsPort is given");
const natsPort = await freePort();
const wsPort = await freePort();
const cfg = serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: natsPort, storeDir: join(dir, "js"), wsPort });
c("wsPort → a `websocket` block is emitted", /websocket\s*\{/.test(cfg));
c("the ws listener is bound to 127.0.0.1 (localhost default, not 0.0.0.0)", /websocket\s*\{[^}]*\b(host|listen):\s*(127\.0\.0\.1|"127\.0\.0\.1")/.test(cfg) && !/0\.0\.0\.0/.test(cfg));
c("the ws listener carries the wsPort", cfg.includes(String(wsPort)));
c("no_tls is set (dev loopback, ws not wss)", /no_tls\s*:\s*true/.test(cfg));
const cfgNoWs = serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: natsPort, storeDir: join(dir, "js") });
c("WITHOUT wsPort no websocket block is emitted (opt-in, no surprise surface)", !/websocket\s*\{/.test(cfgNoWs));

// ---- B. a live broker actually accepts a browser WebSocket on the ws port --------------------
console.log("B. a live broker accepts a browser-style WebSocket and speaks NATS on the ws port");
writeFileSync(join(dir, "server.conf"), cfg);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
process.on("exit", () => srv.kill("SIGKILL"));
// The exit handler above is what a signal reaches under `tsx`, which converts one into an ordinary
// exit. Under a runner that does not convert, a default-disposition signal skips `exit` entirely and
// nothing here would run, so ownership covers that case too.
const releaseBroker = teardownOnSignal(srv, dir);

// Wait for the NATS TCP port to come up.
let up = false;
for (let i = 0; i < 60 && !up; i++) { up = await new Promise<boolean>((r) => { const s = new Socket(); s.setTimeout(200); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); s.once("timeout", () => { s.destroy(); r(false); }); s.connect(natsPort, "127.0.0.1"); }); if (!up) await wait(100); }
c("the broker came up (nats tcp port)", up);

// A browser-style WebSocket to the ws port: the NATS server sends INFO on connect (native WebSocket
// in node >= 22 speaks the same handshake a browser would).
const info = await new Promise<string>((resolve) => {
  let done = false;
  const finish = (v: string) => { if (!done) { done = true; resolve(v); } };
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => { const d = e.data; const s = typeof d === "string" ? d : new TextDecoder().decode(d as ArrayBuffer); finish(s); try { ws.close(); } catch { /* */ } };
    ws.onerror = () => finish("");
    setTimeout(() => finish(""), 4000);
  } catch { finish(""); }
});
c("a WebSocket connects to the ws port and the broker speaks NATS (INFO on connect)", info.startsWith("INFO "));

console.log(`\nconsole-ws-listener: ${ok} passed, ${fail} failed`);
srv.kill("SIGKILL");
releaseBroker(); // last: the exit handler above still removes the tree
process.exit(fail ? 1 : 0);

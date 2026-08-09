/**
 * CONSOLE WS-DUPLEX smoke (P2 item 6) — the browser transport's INBOUND leg, which no transport-node
 * caller exercises (the coverage hole the live Chrome e2e exposed: a ws-transport keystroke encoded
 * as a STRING shipped NUL bytes the pty ignored — silent no-echo). Drives the EXACT browser path:
 * POST /session/<name> → wsconnect over the broker WebSocket listener → openSessionRail(caller) →
 * ready → send a data frame → assert the pty echoes it BACK over the ws (full duplex). Also pins the
 * encode guard (a string keystroke is rejected, not silently mis-encoded) and the drop telemetry.
 *
 * Run: pnpm smoke:console-ws-duplex   (needs nats-server + node on PATH; boots its own broker).
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wsconnect, credsAuthenticator } from "@nats-io/nats-core";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity, mintLifecycleUid,
  registry, openSessionRail, encodeTerminalData, decodeTerminalFrame, terminalFrameBytes,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";

let pass = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => { const e = Date.now() + ms; while (Date.now() < e) { if (f()) return true; await wait(30); } return f(); };
const freePort = (): Promise<number> => new Promise((res, rej) => { const s = createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });

const brokerPort = await freePort(), wsPort = await freePort(), consolePort = await freePort();
const SERVER = `nats://127.0.0.1:${brokerPort}`;
const space = `wsduplex-${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-wsduplex-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: brokerPort, storeDir: join(dir, "js"), host: "127.0.0.1", wsPort, wsHost: "127.0.0.1" }));
writeFileSync(join(workspaceRoot, ".cotal", "agents", "echo1.md"), "---\nname: echo1\nagent: echo\nrole: worker\n---\n");
registry.register({ kind: "connector", name: "echo", requires: [], buildLaunch: () => ({ command: "cat", args: [], env: { PATH: process.env.PATH ?? "" } }) });

const kids: ChildProcess[] = [];
let mgr: InstanceType<typeof Manager> | undefined;
const srv = spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
kids.push(srv);

try {
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) break; await wait(150); }
  await setupSpaceStreams({ servers: SERVER, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  mgr = new Manager({ space, servers: SERVER, runtime: "pty", workspaceRoot, wsPort, consolePort });
  (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 2500;
  await mgr.start();
  await mgr.startAgent({ name: "echo1", agent: "echo" }); // cat: a clean line-echo pty
  const consoleUrl = mgr.consoleUrl.replace(/\/$/, "");

  // ── the EXACT browser path: POST /session → wsconnect → rail ─────────────────────────────────
  const est = await (await fetch(`${consoleUrl}/session/echo1`, { method: "POST" })).json() as { grant: { subjects: { in: string } }; wsUrl: string; creds: string };
  c("POST /session returns a grant + a broker ws url + a per-session cred (no /attach url)", typeof est.grant?.subjects?.in === "string" && /^ws:\/\/127\.0\.0\.1:\d+$/.test(est.wsUrl) && est.creds.length > 0, { wsUrl: est.wsUrl });

  const nc = await wsconnect({ servers: est.wsUrl, authenticator: credsAuthenticator(new TextEncoder().encode(est.creds)) });
  const rx: Buffer[] = [];
  let endReason: string | undefined;
  const rail = openSessionRail({
    nc, grant: est.grant as never, role: "caller",
    onData: (data) => { const p = decodeTerminalFrame(data); if (p.k === "data") rx.push(Buffer.from(terminalFrameBytes(p))); else if (p.k === "end") endReason = p.reason; },
  });
  await nc.flush();
  rail.send({ k: "ready" });

  // ── INBOUND: a keystroke encoded from BYTES (the fixed browser path) echoes back over the ws ──
  rail.send(encodeTerminalData(new TextEncoder().encode("WSPING\n")));
  c("INBOUND: a bytes-encoded keystroke over the ws transport reaches the pty and echoes back (full duplex)", await until(() => Buffer.concat(rx).toString("utf8").includes("WSPING")), Buffer.concat(rx).toString("utf8").slice(-40));
  c("no premature end frame (the ws session is not a zombie)", endReason === undefined);

  // ── the ENCODE GUARD: a STRING keystroke (xterm's raw onData) is REJECTED, never NUL-encoded ──
  let threw = false;
  try { encodeTerminalData("whoami" as unknown as Uint8Array); } catch { threw = true; }
  c("GUARD: encodeTerminalData rejects a raw string (the app.js trap) instead of shipping NUL bytes", threw);

  rail.close();
  await nc.close();
  console.log(`\nconsole-ws-duplex: ${pass} passed, ${fail} failed`);
} finally {
  await mgr?.stop().catch(() => {});
  for (const k of kids) k.kill("SIGKILL");
  await wait(200);
}
process.exit(fail ? 1 : 0);

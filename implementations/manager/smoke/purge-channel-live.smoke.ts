/**
 * Channel-scoped purge live smoke — run with: pnpm smoke:purge-channel:live (needs nats-server).
 *
 * The console's `:delchan` narrows the manager's admin `purge` op with a `channel` arg: a filtered
 * STREAM.PURGE on that channel across all senders plus its channel-registry key delete
 * (core `clearChannel`, the web dashboard's delete path) under a per-op "channel-purger" mint —
 * other channels' history must survive. Guards against a real auth broker + Manager: the narrow
 * purge, the wildcard rejection, and the arg-less op still purging the whole space (regression).
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_ADMIN,
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra?: unknown) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ FAIL: " + n, extra ?? "")); };

/** One control request with a per-action admin cred — the console's exact flow (console/control.ts). */
async function callPurge(space: string, auth: Awaited<ReturnType<typeof createSpaceAuth>>, args: Record<string, unknown>) {
  const creds = await mintCreds(auth, newIdentity(), "control-caller-admin");
  const ep = new CotalEndpoint({ space, servers: SERVERS, creds, channels: [], consume: false, registerPresence: false, watchPresence: false, card: { name: "console-smoke", kind: "endpoint" } });
  ep.on("error", () => {});
  await ep.start();
  try {
    return await ep.requestControl(CONTROL_ADMIN, { op: "purge", args });
  } finally {
    await ep.stop();
  }
}

const space = `delchan-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-delchan-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
let poster: CotalEndpoint | undefined;
let reader: CotalEndpoint | undefined;

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  await mgr.start();

  poster = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "operator"), card: { name: "poster", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  poster.on("error", () => {});
  await poster.start();
  // History reads need the god-view profile (the operator cred can publish but not read the
  // JS backlog) — the same "admin" cred the console/web observer runs on.
  reader = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"), card: { name: "reader", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  reader.on("error", () => {});
  await reader.start();
  await poster.multicast("one", { channel: "kept" });
  await poster.multicast("two", { channel: "doomed" });
  await poster.multicast("three", { channel: "doomed" });
  check("setup: both channels have persisted history", (await reader.channelHistory("kept")).length === 1 && (await reader.channelHistory("doomed")).length === 2);

  // The console's delchan path: admin purge op narrowed by the channel arg.
  const r1 = await callPurge(space, auth, { channel: "doomed" });
  const purged = (r1.data as { purged?: number } | undefined)?.purged;
  check("delchan: purge {channel} → ok with the purged count", r1.ok === true && purged === 2, r1);
  check("delchan: the channel's history is gone", (await reader.channelHistory("doomed")).length === 0);
  check("delchan: other channels survive", (await reader.channelHistory("kept")).length === 1);

  const rWild = await callPurge(space, auth, { channel: "team.>" });
  check("delchan: wildcard channel → {ok:false}", rWild.ok === false && /wildcard/i.test(String(rWild.error)), rWild);

  // Regression: the arg-less op still purges the whole space.
  const rAll = await callPurge(space, auth, {});
  check("purge: arg-less op still clears the space", rAll.ok === true && (await reader.channelHistory("kept")).length === 0, rAll);
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  try { await reader?.stop(); } catch { /* already down */ }
  try { await poster?.stop(); } catch { /* already down */ }
  try { await mgr.stop(); } catch { /* already down */ }
  srv.kill("SIGKILL");
  await new Promise<void>((res) => { if (srv.exitCode !== null || srv.signalCode !== null) return res(); srv.once("exit", () => res()); setTimeout(res, 3000); });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PURGE-CHANNEL SMOKE OK ✅" : "PURGE-CHANNEL SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

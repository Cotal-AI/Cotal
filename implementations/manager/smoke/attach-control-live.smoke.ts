/**
 * Attach control-op live smoke — run with: pnpm smoke:attach-control:live (needs nats-server + node).
 *
 * The console's attach reuses the CLI attach flow: a per-action control-caller-admin cred →
 * requestControl(ADMIN, {op:"attach", args:{name}}) → the manager returns the WS attach URL, which
 * attachClient then streams (that data path is covered by attach-repaint.smoke.ts). This guards the
 * console's dependency end-to-end against a real broker + Manager + pty agent: attach returns a
 * loopback ws for a live pty agent, and errors (not crashes) for a missing one.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_ADMIN,
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  registry,
  type Connector,
  type LaunchOpts,
  type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "e2e-stub.mjs");
const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra?: unknown) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ FAIL: " + n, extra ?? "")); };

/** One control request with a per-action admin cred — the console's exact flow (console/control.ts). */
async function callAttach(space: string, auth: Awaited<ReturnType<typeof createSpaceAuth>>, name: string) {
  const creds = await mintCreds(auth, newIdentity(), "control-caller-admin");
  const ep = new CotalEndpoint({ space, servers: SERVERS, creds, channels: [], consume: false, registerPresence: false, watchPresence: false, card: { name: "console-smoke", kind: "endpoint" } });
  ep.on("error", () => {});
  await ep.start();
  try {
    return await ep.requestControl(CONTROL_ADMIN, { op: "attach", args: { name } });
  } finally {
    await ep.stop();
  }
}

const space = `attach-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-attach-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(workspaceRoot, ".cotal", "agents", "w1.md"), "---\nname: w1\nrole: worker\n---\n");
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
});
const stubCon: Connector = { kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) };
registry.register(stubCon);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  await mgr.start();

  const r1 = await mgr.startAgent({ name: "w1", agent: "e2e-stub", cwd: repoRoot });
  check("spawn: pty stub agent started", r1.ok === true, r1);

  // The console's attach path: admin-tier control op → { ws }.
  const ra = await callAttach(space, auth, "w1");
  const ws = (ra.data as { ws?: string } | undefined)?.ws;
  check("attach: returns ok with a ws url", ra.ok === true && typeof ws === "string", ra);
  check("attach: ws is a loopback /attach/<name> endpoint", !!ws && /^ws:\/\/127\.0\.0\.1:\d+\/attach\/w1$/.test(ws), ws);

  // A missing agent errors, not crashes (the console flashes r.error).
  const rMiss = await callAttach(space, auth, "ghost");
  check("attach: missing agent → {ok:false} with an error", rMiss.ok === false && typeof rMiss.error === "string", rMiss);
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  try { await mgr.stop(); } catch { /* already down */ }
  srv.kill("SIGKILL");
  await new Promise<void>((res) => { if (srv.exitCode !== null || srv.signalCode !== null) return res(); srv.once("exit", () => res()); setTimeout(res, 3000); });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ATTACH-CONTROL SMOKE OK ✅" : "ATTACH-CONTROL SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Pause/resume live-broker smoke — run with: pnpm smoke:pause-resume:live (needs nats-server + node).
 *
 * Drives the REAL wire path the console uses (per-action tier-scoped creds → requestControl), against
 * a real JWT-auth broker + real Manager + a real agent process (e2e-stub.mjs):
 *
 *   1. pause freezes the process (OS state `T`), reply carries {paused:true}, `ps` reports it;
 *   2. resume thaws it, {paused:false}, state leaves `T`;
 *   3. TIER: a non-spawner on the privileged subject is DENIED pause/stop (admin required) — the
 *      regression guard for the console's old mis-tiered kill — while admin reaches any agent;
 *   4. CRED SCOPE: the minted control-caller-admin JWT may publish ONLY its own tier's subject;
 *   5. an unsupported runtime (no owned pid) errors loud, not silently;
 *   6. graceful stop of a PAUSED agent completes (SIGCONT-before-SIGTERM — would otherwise hang).
 */
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_ADMIN,
  CONTROL_PRIVILEGED,
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  registry,
  type AgentHandle,
  type Connector,
  type ControlTier,
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
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** OS process state letter (`T` = stopped) — POSIX ps, present on mac + Linux. */
const stateOf = (pid: number): string => {
  try {
    return execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return ""; // process gone
  }
};

/** One control request with a fresh per-action tier-scoped cred — the console's exact flow. */
async function callControl(
  space: string,
  auth: Awaited<ReturnType<typeof createSpaceAuth>>,
  tier: ControlTier,
  op: string,
  args: Record<string, unknown>,
) {
  const creds = await mintCreds(
    auth,
    newIdentity(),
    tier === CONTROL_ADMIN ? "control-caller-admin" : "control-caller-privileged",
  );
  const ep = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    card: { name: "console-smoke", kind: "endpoint" },
  });
  ep.on("error", () => {});
  await ep.start();
  try {
    return await ep.requestControl(tier, { op, args });
  } finally {
    await ep.stop();
  }
}

const space = `pause-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-pause-"));
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
const stubCon: Connector = {
  kind: "connector", name: "e2e-stub", requires: ["node"],
  buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }),
};
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
  check("spawn: stub agent started", r1.ok === true, r1);
  const managed = (mgr as unknown as { agents: Map<string, { id: string; handle: AgentHandle; paused?: boolean }> }).agents;
  const pid = managed.get("w1")?.handle.pid ?? 0;
  check("spawn: pty handle owns a pid", pid > 0, pid);

  // 4 — cred scope: the admin caller cred publishes ONLY the admin control subject.
  const adminJwt = await mintCreds(auth, newIdentity(), "control-caller-admin");
  const payload = JSON.parse(
    Buffer.from((adminJwt.match(/BEGIN NATS USER JWT-+\n([^\n]+)/)?.[1] ?? "").split(".")[1], "base64url").toString(),
  ) as { nats?: { pub?: { allow?: string[] } } };
  const allow = payload.nats?.pub?.allow ?? [];
  check("cred scope: control-caller-admin pubs ctl.admin only", allow.some((s) => s.includes(".ctl.admin.")), allow);
  check("cred scope: …and NOT the privileged subject", !allow.some((s) => s.includes(".ctl.manager.")), allow);

  // 1 — pause via the ADMIN tier (the console's flow): reply + real OS freeze + ps reports it.
  const rp = await callControl(space, auth, CONTROL_ADMIN, "pause", { name: "w1" });
  check("pause: admin-tier reply {ok, paused:true}", rp.ok === true && (rp.data as { paused?: boolean }).paused === true, rp);
  await wait(300);
  check("pause: child process is OS-stopped (state T)", stateOf(pid).startsWith("T"), stateOf(pid));
  const rps = await callControl(space, auth, CONTROL_PRIVILEGED, "ps", {});
  const w1 = ((rps.data as { name: string; paused?: boolean }[]) ?? []).find((a) => a.name === "w1");
  check("ps: reports paused:true", rps.ok === true && w1?.paused === true, w1);

  // 3 — tier: a NON-spawner on the privileged subject is denied pause and stop (admin required).
  const rDenyPause = await callControl(space, auth, CONTROL_PRIVILEGED, "pause", { name: "w1" });
  check("tier: privileged non-spawner pause is denied", rDenyPause.ok === false && /not authorized/.test(rDenyPause.error ?? ""), rDenyPause);
  const rDenyStop = await callControl(space, auth, CONTROL_PRIVILEGED, "stop", { name: "w1" });
  check("tier: privileged non-spawner stop is denied (old console-kill bug)", rDenyStop.ok === false && /not authorized/.test(rDenyStop.error ?? ""), rDenyStop);

  // 2 — resume: reply + the process leaves the stopped state.
  const rr = await callControl(space, auth, CONTROL_ADMIN, "resume", { name: "w1" });
  check("resume: admin-tier reply {ok, paused:false}", rr.ok === true && (rr.data as { paused?: boolean }).paused === false, rr);
  await wait(300);
  check("resume: child process left state T", !stateOf(pid).startsWith("T"), stateOf(pid));

  // 5 — unsupported runtime: a handle without pause (tmux/cmux shape) errors loud.
  managed.set("fake", {
    id: "fake-id",
    handle: {
      name: "fake", kind: "tmux", status: () => "running" as const,
      stop: () => {}, interrupt: () => {}, attach: () => { throw new Error("n/a"); },
    },
    // The op only needs id/handle/spawner; cast keeps the stub minimal.
  } as never);
  const rf = await callControl(space, auth, CONTROL_ADMIN, "pause", { name: "fake" });
  check("unsupported runtime: pause errors 'not supported by the tmux runtime'", rf.ok === false && /not supported by the tmux runtime/.test(rf.error ?? ""), rf);
  managed.delete("fake");

  // 6 — graceful stop of a PAUSED agent completes (SIGCONT-first guard).
  await callControl(space, auth, CONTROL_ADMIN, "pause", { name: "w1" });
  check("re-pause for the stop test", stateOf(pid).startsWith("T") || (managed.get("w1")?.paused ?? false));
  const rs = await callControl(space, auth, CONTROL_ADMIN, "stop", { name: "w1", graceful: true });
  check("graceful stop of a paused agent replies ok", rs.ok === true, rs);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await wait(200);
    gone = stateOf(pid) === "";
  }
  check("graceful stop of a paused agent actually exits (SIGCONT before SIGTERM)", gone, stateOf(pid));
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  try { await mgr.stop(); } catch { /* already down */ }
  srv.kill("SIGKILL");
  await new Promise<void>((resolveExit) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return resolveExit();
    srv.once("exit", () => resolveExit());
    setTimeout(resolveExit, 3000);
  });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PAUSE-RESUME SMOKE OK ✅" : "PAUSE-RESUME SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

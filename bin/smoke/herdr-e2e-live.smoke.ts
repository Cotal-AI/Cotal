/**
 * Herdr runtime END-TO-END: a real JWT-auth broker + a real Manager running `--runtime herdr` +
 * a real agent PROCESS that joins mesh presence from inside a Herdr pane — and then the manager is
 * KILLED to prove the agent outlives it.
 *
 * Run: pnpm smoke:herdr-e2e:live   (needs nats-server, node and herdr >= 0.8.0 on PATH)
 *
 * The unit suite (extensions/herdr/smoke.ts) proves the driver's contract with herdr using `sleep`
 * as a payload. That is not the same as proving Cotal works on top of it, and the gap is exactly
 * where this integration's headline claims live:
 *
 *   1. A real agent reaches mesh PRESENCE from inside a herdr pane.
 *   2. SIGKILLing the manager does NOT take the agent down. This is the entire reason to use this
 *      runtime. It is checked by killing a real manager process, not by inspecting the process
 *      tree: herdr's server is spawned `detached`, so it IS a child of the manager until the
 *      manager exits and then reparents to init. Ancestry at time T says nothing about T+1.
 *   3. The agent's REAL minted credential never reaches herdr — not its records, not the pane's
 *      scrollback. (The unit suite checks this with a synthetic canary; here it is the real seed.)
 *   4. The pane can still be torn down after the manager is gone, leaving no stray process.
 *
 * Everything created is recorded at creation time and torn down by that exact identity.
 */
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity, isReachable } from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import * as herdr from "../../extensions/herdr/src/driver.js";

const SPACE = `he2e${randomUUID().slice(0, 6)}`;
const HERDR_SESSION = `cotal-${SPACE}`;
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean> | boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return true; await wait(250); }
  return false;
}
const alive = (pid: number): boolean => {
  try { execFileSync("ps", ["-p", String(pid)], { stdio: "ignore" }); return true; } catch { return false; }
};

if (!herdr.available()) {
  const found = herdr.versionText();
  console.log(`• herdr e2e SKIPPED — needs herdr >= ${herdr.MIN_HERDR.join(".")}${found ? ` (found "${found}")` : " (not on PATH)"}`);
  console.log("  NOTE: this suite proves nothing when skipped.");
  process.exit(0);
}
try { execFileSync("nats-server", ["--version"], { stdio: "ignore" }); }
catch {
  console.log("• herdr e2e SKIPPED — nats-server not on PATH");
  console.log("  NOTE: this suite proves nothing when skipped.");
  process.exit(0);
}

// ── recorded identities, for teardown by exact name ────────────────────────────
let srvPid: number | undefined;
let mgrPid: number | undefined;
let scratch: string | undefined;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (mgrPid !== undefined) { try { process.kill(mgrPid, "SIGKILL"); } catch { /* gone */ } }
  try { herdr.stopSession(HERDR_SESSION); } catch { /* not running */ }
  try { execFileSync("herdr", ["session", "delete", HERDR_SESSION], { stdio: "ignore" }); } catch { /* gone */ }
  if (srvPid !== undefined) { try { process.kill(srvPid); } catch { /* gone */ } }
  if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { cleanup(); process.exit(130); });
process.on("uncaughtException", (err) => { console.error("\n✗ UNCAUGHT:", err); cleanup(); process.exit(1); });

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

console.log(`\n── herdr e2e: space ${SPACE} ─────────────\n`);

// ── a real broker on an ephemeral port (NEVER the live :4222 mesh) ─────────────
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const auth = await createSpaceAuth(SPACE);
scratch = mkdtempSync(join(tmpdir(), "cotal-herdr-e2e-"));
const workspaceRoot = join(scratch, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(workspaceRoot, ".cotal", "agents", "hagent.md"), `---\nname: hagent\nrole: worker\n---\n`);
writeFileSync(join(scratch, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port: PORT, storeDir: join(scratch, "js"),
}));
const srv = spawn("nats-server", ["-c", join(scratch, "server.conf")], { stdio: "ignore" });
srvPid = srv.pid;
check("broker started on an ephemeral port, not the live mesh", srvPid !== undefined && PORT !== 4222);
check("broker reachable", await until(() => isReachable(SERVERS), 20_000));
const provId = newIdentity();
await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: await mintCreds(auth, provId, "provisioner") });
check("space streams provisioned", true);

const STUB = join(process.cwd(), "implementations", "manager", "smoke", "e2e-stub.mjs");
check("agent stub present", existsSync(STUB), STUB);
const CANARY = `e2e-control-token-${randomUUID().slice(0, 8)}`;

// ── a real Manager, in its OWN process so it can be killed ────────────────────
const child = spawn(process.execPath, [
  join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
  join(process.cwd(), "bin", "smoke", "herdr-e2e-manager-child.mjs"),
], {
  env: {
    ...process.env,
    HE2E_SPACE: SPACE, HE2E_SERVERS: SERVERS, HE2E_WORKSPACE: workspaceRoot,
    HE2E_STUB: STUB, HE2E_CANARY: CANARY,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
mgrPid = child.pid;
let ready: Record<string, unknown> | undefined;
let childErr = "";
child.stdout.on("data", (b: Buffer) => {
  for (const line of b.toString().split("\n")) {
    const m = /^HE2E_READY (.*)$/.exec(line.trim());
    if (m) ready = JSON.parse(m[1]!);
  }
});
child.stderr.on("data", (b: Buffer) => { childErr += b.toString(); });
check("manager process spawned", mgrPid !== undefined);
const gotReady = await until(() => ready !== undefined, 90_000);
check("manager started an agent and reported ready", gotReady, childErr.slice(-600));
if (!gotReady) { cleanup(); console.log(`\n${pass} passed, ${fail} failed\n`); process.exit(1); }

check("startAgent resolved ok (agent reached REAL mesh presence from inside a herdr pane)",
  ready!.ok === true, ready!.detail);
const agentPid = Number(ready!.agentPid);
const paneId = String(ready!.paneId);
const terminalId = String(ready!.terminalId);
check("the agent's pid was resolved from the pane's process table", agentPid > 0, String(agentPid));
check("the pane id and terminal id were reported", paneId !== "" && terminalId !== "");

const panes = () => herdr.run(HERDR_SESSION, ["pane", "list"]).panes as Record<string, unknown>[];
check("the dedicated herdr session holds exactly one pane", panes().length === 1, `${panes().length}`);
check("the pane carries the cotal metadata token",
  (panes()[0]?.tokens as Record<string, string> | undefined)?.cotal === HERDR_SESSION);

// ── the REAL minted credential never reaches herdr ────────────────────────────
const credsPath = join(authDir(workspaceRoot), "creds", `hagent.${String(ready!.lifecycleUid)}.creds`);
const credsBody = existsSync(credsPath) ? readFileSync(credsPath, "utf8") : "";
const seed = /(SU[A-Z2-7]{20,})/.exec(credsBody)?.[1] ?? "";
check("positive control: the agent's creds file exists on disk", credsBody.length > 0, credsPath);
check("positive control: a real nkey seed was extracted from it", seed.length > 20, `len=${seed.length}`);
const records = JSON.stringify(herdr.run(HERDR_SESSION, ["pane", "list"]))
  + JSON.stringify(herdr.run(HERDR_SESSION, ["agent", "list"]))
  + JSON.stringify(herdr.run(HERDR_SESSION, ["pane", "process-info", "--pane", paneId]));
const scrollback = execFileSync("herdr", ["--session", HERDR_SESSION, "pane", "read", paneId], { encoding: "utf8" });
check("positive control: scrollback is readable and shows the launcher", scrollback.includes("launch.mjs"),
  scrollback.slice(0, 160));
check("herdr records do NOT contain the control token", !records.includes(CANARY));
check("pane scrollback does NOT contain the control token", !scrollback.includes(CANARY));
check("herdr records do NOT contain the agent's nkey seed", seed.length > 20 && !records.includes(seed));
check("pane scrollback does NOT contain the agent's nkey seed", seed.length > 20 && !scrollback.includes(seed));

// ── THE headline claim: kill the manager, the agent lives ─────────────────────
console.log("\n  … SIGKILL the manager and watch the agent:\n");
check("the agent is running before the kill", alive(agentPid));
process.kill(mgrPid!, "SIGKILL");
const managerDead = await until(() => !alive(mgrPid!), 15_000);
mgrPid = undefined; // no longer ours to kill in teardown
check("the manager process is really dead", managerDead);
// Give any process-group signal that WOULD have killed the agent time to land.
await wait(3_000);
check("the agent SURVIVED the manager being killed", alive(agentPid), `pid ${agentPid}`);
check("its pane is still live in the herdr session", panes().length === 1, `${panes().length} panes`);
check("terminalState still reports the agent running", herdr.terminalState(HERDR_SESSION, terminalId) === "running");

// ── and it can still be torn down afterwards ──────────────────────────────────
herdr.closePane(HERDR_SESSION, herdr.agentInfo(HERDR_SESSION, terminalId)!.paneId);
check("the orphaned pane closes on request", await until(() => panes().length === 0, 15_000), `${panes().length}`);
check("the agent process exits with its pane", await until(() => !alive(agentPid), 15_000), `pid ${agentPid}`);

console.log(`\n────────────────────────────────────────────────`);
console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} cells ran)\n`);
cleanup();
if (fail > 0) process.exit(1);

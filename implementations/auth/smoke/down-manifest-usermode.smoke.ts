/**
 * `down -f` USER-MODE teardown live smoke — the crashed-manager residual (found in review of the
 * per-agent seam migration, and hit for real when a mesh supervisor died mid-flight):
 *
 *   user-mode manifest deploy (`spawn -f`) → the manager is SIGKILLed before any deprovision runs
 *   (its lease key lingers to the bucket TTL) → a FRESH supervisor answers control with an empty
 *   roster → `down -f`. The dead agent resolves as "not running", and before the fix the local
 *   cred loop knew only the static `<name>.creds`, so it read the user-mode agent as "proven
 *   absent": the ledger was deleted while the actor token, sentinel cred, and provider grant row
 *   (the standing MINT authority) survived, with no scoped retry record left.
 *
 * Asserts the FIXED behavior: teardown recognizes the ledgered principal id as user-mode, revokes
 * the grant row (owner+actor-keyed), deletes the token + sentinel through the secret-store seam,
 * and only then completes and deletes the ledger. Scenario B repeats the choreography with a
 * TAMPERED (symlinked) token materialization and asserts the suspect gate leaves the files in
 * place while STILL revoking the grant row, so completion never deletes the ledger over standing
 * authority.
 *
 * Real binary, real broker, real Better Auth IdP, real device login; the worker boots a real
 * `claude` connector child (killed immediately), so the claude CLI must be on PATH. Kills only
 * what it starts. Needs nats-server on PATH; `pnpm build` first (subprocesses run built dist).
 * Run: pnpm smoke:down-manifest-usermode:live
 */
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { toNodeHandler } from "better-auth/node";
import { pickFreePort } from "./_free-port.js";

const home = mkdtempSync(join(tmpdir(), "cotal-downf-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), "cotal-downf-root-"));

const { establishIdpSession } = await import("../src/index.js");
type DeviceLoginPrompt = import("../src/index.js").DeviceLoginPrompt;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `downf-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");

function cotal(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ status: number | null; out: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("npx", ["tsx", BIN, ...args], { cwd: root, env: { ...process.env, COTAL_HOME: home } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    const t = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("close", (status) => { clearTimeout(t); resolvePromise({ status, out }); });
  });
}

// ---------- real Better Auth IdP ----------
let handler: ReturnType<typeof toNodeHandler> | undefined;
const idpSrv = createServer((req, res) => handler!(req, res));
await new Promise<void>((r) => idpSrv.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(idpSrv.address() as AddressInfo).port}`;
const base = `${origin}/api/auth`;
const ba = betterAuth({
  baseURL: origin,
  secret: "repro-only-better-auth-secret-0123456789",
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
  emailAndPassword: { enabled: true },
  plugins: [
    jwt({ jwt: { issuer: origin, audience: origin } }),
    deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id) => id === CLIENT_ID }),
    bearer(),
  ],
});
handler = toNodeHandler(ba);
const signup = await ba.api.signUpEmail({
  body: { email: "human@example.test", password: "correct-horse-battery", name: "Human 42" },
  returnHeaders: true,
});
const cookie = signup.headers.get("set-cookie")!.split(";")[0];
async function approve(userCode: string): Promise<void> {
  await fetch(`${base}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
  const res = await fetch(`${base}/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ userCode }),
  });
  if (!res.ok) throw new Error(`device/approve failed: HTTP ${res.status}`);
}

let superviseChild: ReturnType<typeof spawn> | undefined;
try {
  console.log("1) up --user-auth");
  const up = await cotal(["up", "--user-auth", "--idp", base, "--detach", "--server", SERVER, "--space", SPACE]);
  check("up exits 0", up.status === 0, up.out.slice(-800));

  console.log("2) device login + full cli grant");
  const { sub } = await establishIdpSession({
    dir: home, idpUrl: base, clientId: CLIENT_ID,
    onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode),
  });
  const grant = await cotal(["actor", "grant", "cli", "--sub", sub, "--scope", "spawn,role:default,admin", "--label", "repro human"]);
  check("actor grant cli succeeds", grant.status === 0 && grant.out.includes("granted"), grant.out.slice(-400));

  console.log("3) user-mode manifest deploy (spawn -f)");
  const manifest = join(root, "mesh.yaml");
  writeFileSync(manifest, `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
agent: claude
broker: { servers: "${SERVER}", auth: user, idp: "${base}" }
channels: {}
agents:
  worker:
    instructions: "Idle worker for the teardown repro."
`);
  const deploy = await cotal(["spawn", "-f", manifest], { timeoutMs: 180_000 });
  check("spawn -f exits 0 and launched worker", deploy.status === 0 && /launched worker/.test(deploy.out), deploy.out.slice(-1200));

  const credsDir = join(root, ".cotal", "auth", "creds");
  check("user-mode standing secrets exist (actor-token + sentinel)",
    existsSync(join(credsDir, "worker.actor-token")) && existsSync(join(credsDir, "worker.sentinel.creds")));
  check("no static worker.creds was written (user mode)", !existsSync(join(credsDir, "worker.creds")));
  const manifestsDir = join(root, ".cotal", "manifests");
  const ledgers = readdirSync(manifestsDir).filter((f) => f.endsWith(".json"));
  check("exactly one ownership ledger exists", ledgers.length === 1, ledgers);
  const ledger = JSON.parse(readFileSync(join(manifestsDir, ledgers[0]), "utf8")) as { created: { agents: Array<{ name: string; id: string }> } };
  const entry = ledger.created.agents.find((a) => a.name === "worker");
  check("ledger id is the user-mode principal (u_….worker)", /^u_[a-z2-7]{26}\.worker$/.test(entry?.id ?? ""), entry);

  console.log("4) crash: SIGKILL the manager and its child (deprovision never runs)");
  const mgrPid = Number(readFileSync(join(root, ".cotal", "manager.pid"), "utf8").trim());
  // Children first (the launched worker's process tree), then the manager itself.
  const kids = (() => { try { return execSync(`pgrep -P ${mgrPid}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } })();
  for (const k of kids) { try { execSync(`pkill -9 -P ${k}`); } catch { /* leaf */ } try { process.kill(Number(k), "SIGKILL"); } catch { /* gone */ } }
  try { process.kill(mgrPid, "SIGKILL"); } catch { /* gone */ }
  await wait(500);
  check("manager is dead", (() => { try { process.kill(mgrPid, 0); return false; } catch { return true; } })());
  check("secrets still standing after the crash",
    existsSync(join(credsDir, "worker.actor-token")) && existsSync(join(credsDir, "worker.sentinel.creds")));

  console.log("5) fresh supervisor (empty roster) answers control");
  // The crashed holder's lease key lingers until the bucket TTL (MANAGER_LEASE_TTL_MS = 10s) and
  // blocks a replacement's acquire — wait it out first, like the real recovery did.
  await wait(13_000);
  let superviseOut = "";
  superviseChild = spawn("npx", ["tsx", BIN, "supervise", "--space", SPACE, "--server", SERVER], {
    cwd: root, env: { ...process.env, COTAL_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  superviseChild.stdout!.on("data", (d: Buffer) => { superviseOut += d.toString(); });
  superviseChild.stderr!.on("data", (d: Buffer) => { superviseOut += d.toString(); });
  // Wait until the replacement holds the lease and answers ps (down -f needs controlOk).
  let psOk = false;
  for (let i = 0; i < 60 && !psOk; i++) {
    await wait(1000);
    const ps = await cotal(["ps", "--space", SPACE], { timeoutMs: 20_000 });
    psOk = ps.status === 0;
  }
  check("replacement manager answers ps", psOk, superviseOut.slice(-800));

  console.log("6) down -f removes the user-mode authority WITH the ledger");
  const down = await cotal(["down", "-f", manifest], { timeoutMs: 120_000 });
  check("down -f exits 0 (complete teardown)", down.status === 0, down.out.slice(-800));
  check("teardown reports the user-mode authority removal", /removed user-mode authority for worker/.test(down.out), down.out.slice(-800));
  check("ownership ledger is deleted (teardown complete)", readdirSync(manifestsDir).filter((f) => f.endsWith(".json")).length === 0);
  check("actor token is gone", !existsSync(join(credsDir, "worker.actor-token")));
  check("sentinel cred is gone", !existsSync(join(credsDir, "worker.sentinel.creds")));
  const actors = await cotal(["actor", "list"], { timeoutMs: 30_000 });
  check("the grant row is revoked (actor list has no worker)", actors.status === 0 && !/\bworker\b/.test(actors.out), actors.out.slice(-400));

  // ---- scenario B: a SUSPECT materialization must never shield the grant row ----
  // (round-2 panel gate: symlink/irregular token or sentinel → files left in place, but the row
  // is STILL revoked and completion may proceed, because nothing standing survives.)
  console.log("7) second deploy, crash, TAMPERED token (symlink): row revoked, ledger completes, files left");
  const manifest2 = join(root, "mesh2.yaml");
  writeFileSync(manifest2, `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
agent: claude
broker: { servers: "${SERVER}", auth: user, idp: "${base}" }
channels: {}
agents:
  worker2:
    instructions: "Second worker for the suspect-materialization boundary."
`);
  const deploy2 = await cotal(["spawn", "-f", manifest2], { timeoutMs: 180_000 });
  check("second spawn -f exits 0", deploy2.status === 0 && /launched worker2/.test(deploy2.out), deploy2.out.slice(-800));
  check("worker2 secrets exist", existsSync(join(credsDir, "worker2.actor-token")) && existsSync(join(credsDir, "worker2.sentinel.creds")));
  // Crash the replacement supervisor + its child, again before any deprovision. The supervise
  // cmdline carries this run's unique random SPACE token, so the sweep is surgically scoped.
  const mgrPids2 = (() => { try { return execSync(`pgrep -f "supervise.*${SPACE}"`, { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } })();
  check("found the replacement supervisor to crash", mgrPids2.length > 0, mgrPids2);
  for (const p of mgrPids2) {
    const kids2 = (() => { try { return execSync(`pgrep -P ${p}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } })();
    for (const k of kids2) { try { execSync(`pkill -9 -P ${k}`); } catch { /* leaf */ } try { process.kill(Number(k), "SIGKILL"); } catch { /* gone */ } }
    try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ }
  }
  await wait(500);
  check("worker2 secrets still standing after the second crash", existsSync(join(credsDir, "worker2.actor-token")));
  // TAMPER: swap the token materialization for a symlink — the suspect gate's boundary input.
  writeFileSync(join(root, "decoy"), "not-a-secret");
  rmSync(join(credsDir, "worker2.actor-token"));
  symlinkSync(join(root, "decoy"), join(credsDir, "worker2.actor-token"));
  await wait(13_000); // the crashed holder's lease again lingers to the bucket TTL
  superviseChild = spawn("npx", ["tsx", BIN, "supervise", "--space", SPACE, "--server", SERVER], {
    cwd: root, env: { ...process.env, COTAL_HOME: home }, stdio: "ignore" });
  let psOk2 = false;
  for (let i = 0; i < 60 && !psOk2; i++) {
    await wait(1000);
    const ps = await cotal(["ps", "--space", SPACE], { timeoutMs: 20_000 });
    psOk2 = ps.status === 0;
  }
  check("third supervisor answers ps", psOk2);
  const down2 = await cotal(["down", "-f", manifest2], { timeoutMs: 120_000 });
  check("suspect: down -f exits 0 (a suspect file never shields the row)", down2.status === 0, down2.out.slice(-800));
  check("suspect: warns and leaves the tampered file in place",
    /unreadable\/unverifiable/.test(down2.out) && existsSync(join(credsDir, "worker2.actor-token")), down2.out.slice(-600));
  check("suspect: second ledger is deleted (teardown completes)", readdirSync(manifestsDir).filter((f) => f.endsWith(".json")).length === 0);
  const actors2 = await cotal(["actor", "list"], { timeoutMs: 30_000 });
  check("suspect: worker2 grant row IS revoked (no standing authority)", actors2.status === 0 && !/\bworker2\b/.test(actors2.out), actors2.out.slice(-400));

  console.log(`\nDOWN-MANIFEST USER-MODE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("repro threw:", e);
  process.exitCode = 1;
} finally {
  try { superviseChild?.kill("SIGKILL"); } catch { /* gone */ }
  await cotal(["down"], { timeoutMs: 60_000 }).catch(() => ({ status: 1, out: "" }));
  idpSrv.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

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
  // The manager files each incarnation's user secrets lifecycle-keyed: `<name>.<uid>.<kind>`. Find
  // the current incarnation's file by prefix (robust to the uid); returns a never-matching sentinel
  // path when none exists, so a post-teardown "gone" check reads false correctly.
  const incFile = (name: string, kind: string): string => {
    const re = new RegExp(`^${name}\\.[a-z0-9]{26,32}\\.${kind.replace(/\./g, "\\.")}$`);
    let hit: string | undefined;
    try { hit = readdirSync(credsDir).find((f) => re.test(f)); } catch { /* no creds dir yet */ }
    return join(credsDir, hit ?? `${name}.__no-incarnation__.${kind}`);
  };
  check("user-mode standing secrets exist (actor-token + sentinel)",
    existsSync(incFile("worker", "actor-token")) && existsSync(incFile("worker", "sentinel.creds")));
  check("no static creds file was written (user mode)", !existsSync(incFile("worker", "creds")) && !existsSync(join(credsDir, "worker.creds")));
  const manifestsDir = join(root, ".cotal", "manifests");
  const ledgers = readdirSync(manifestsDir).filter((f) => f.endsWith(".json"));
  check("exactly one ownership ledger exists", ledgers.length === 1, ledgers);
  const ledger = JSON.parse(readFileSync(join(manifestsDir, ledgers[0]), "utf8")) as { created: { agents: Array<{ name: string; id: string }> } };
  const entry = ledger.created.agents.find((a) => a.name === "worker");
  check("ledger id is the user-mode principal (u_….worker)", /^u_[a-z2-7]{26}\.worker$/.test(entry?.id ?? ""), entry);

  // ── ARM 2 ────────────────────────────────────────────────────────────────────────────────────
  // Steps 1-3 above are the suite's own, verbatim: `up --user-auth` + device-login grant +
  // user-mode `spawn -f`. The suite's step 4 (SIGKILL the manager) and step 5 (fresh replacement
  // supervisor) are DELIBERATELY NOT RUN — this arm adds ONLY user-mode auth to arm 1, because it
  // is the sole remaining arm that changes the CREDENTIAL the CLI presents, and the fact in hand is
  // that the same manager answers its own service call while the CLI path does not.
  //
  // The suite keeps `ps.status === 0` and discards the output. That discard is why nobody has the
  // message. This prints it whole.
  console.log("\n4') ARM 2: cotal ps --space against the ORIGINAL, still-live manager");

  // HAZARD CONTROL 1: a ps that fails because no manager is up is not this defect.
  const mgrPidFile = join(root, ".cotal", "manager.pid");
  const mgrAlive = (() => {
    try { process.kill(Number(readFileSync(mgrPidFile, "utf8").trim()), 0); return true; } catch { return false; }
  })();
  check("CONTROL: the original manager process is ALIVE before ps is graded", mgrAlive);

  // HAZARD CONTROL 2: a ps pointed at the wrong mesh is indistinguishable from the defect.
  console.log(`   resolving against SPACE=${SPACE} SERVER=${SERVER}`);

  const psArm2 = await cotal(["ps", "--space", SPACE], { timeoutMs: 20_000 });
  console.log(`\n   ===== cotal ps --space ${SPACE} =====`);
  console.log(`   exit status: ${psArm2.status}`);
  console.log(`   output (${psArm2.out.length} bytes), VERBATIM:`);
  console.log(psArm2.out.split("\n").map((l) => `   | ${l}`).join("\n"));
  console.log(`   ===== end =====\n`);

  // A second call, to separate a one-shot timing failure from a standing one.
  const psArm2b = await cotal(["ps", "--space", SPACE], { timeoutMs: 20_000 });
  console.log(`   second call exit status: ${psArm2b.status}`);

  check("ARM 2 RESULT: `cotal ps` exits 0 against a live manager under user-mode auth",
    psArm2.status === 0, { first: psArm2.status, second: psArm2b.status });
  console.log(psArm2.status === 0
    ? "\n   => user-mode auth ALONE does not reproduce. Next arm: the crash. Do NOT conclude 'not reproducible'."
    : "\n   => REPRODUCED with user-mode auth alone. The output above is the finding; read it before any hypothesis.");

  console.log(`\nPS ARM 2 ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
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

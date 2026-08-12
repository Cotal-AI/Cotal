/**
 * USER-MODE `cotal ps` (fix/ps-option3 C): mode chosen up front — ep.one, not scatter.
 *
 *   1. up --user-auth + device login + admin grant (the arm-2 shape that may reach ps)
 *   2. cotal ps exits 0 (the product claim C authorises)
 *   3. manager killed — ps exits non-zero, never a bare empty list
 *
 * Spawn-only refusal is asserted in user-spawn.smoke.ts B1e (ungated); not duplicated here.
 * Gated: a RED here is C or the user-mode connect path broken.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { toNodeHandler } from "better-auth/node";
import { pickFreePort } from "./_free-port.js";

const home = mkdtempSync(join(tmpdir(), "cotal-psuser-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), "cotal-psuser-root-"));
const { establishIdpSession } = await import("../src/index.js");
type DeviceLoginPrompt = import("../src/index.js").DeviceLoginPrompt;

let pass = 0, fail = 0;
const check = (n: string, v: boolean, x?: unknown) => {
  v ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ FAIL: ${n}`, x ?? ""));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `psuser-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
const TSX = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");

function cotal(args: string[], timeoutMs = 120_000): Promise<{ status: number | null; out: string }> {
  return new Promise((res) => {
    const child = spawn(TSX, [BIN, ...args], {
      cwd: root, env: { ...process.env, COTAL_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (status) => { clearTimeout(t); res({ status, out }); });
  });
}

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

try {
  console.log("1) up --user-auth");
  const up = await cotal(["up", "--user-auth", "--idp", base, "--detach", "--server", SERVER, "--space", SPACE]);
  check("up exits 0", up.status === 0, up.out.slice(-600));
  if (up.status !== 0) { process.exitCode = 1; throw new Error("fixture"); }
  await wait(3000);

  console.log("2) device login + admin grant");
  const { sub } = await establishIdpSession({
    dir: home, idpUrl: base, clientId: CLIENT_ID,
    onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode),
  });
  const grant = await cotal(["actor", "grant", "cli", "--sub", sub, "--scope", "spawn,role:default,admin", "--label", "ps human"]);
  check("actor grant succeeds", grant.status === 0 && /granted/i.test(grant.out), grant.out.slice(-300));

  console.log("3) cotal ps under user-mode admin bearer (C: ep.one)");
  const ps = await cotal(["ps", "--space", SPACE], 20_000);
  console.log(`   exit=${ps.status}\n` + ps.out.split("\n").map((l) => `   | ${l}`).join("\n").slice(0, 600));
  check("user-mode ps exits 0 (C: ep.one path)", ps.status === 0, ps.status);
  check("user-mode ps does not die on STREAM.INFO (would mean it still scattered)",
    !/STREAM\.INFO/.test(ps.out), ps.out.slice(-200));

  console.log("4) kill manager — ps must fail loud, not empty-success");
  const pidFile = join(root, ".cotal", "manager.pid");
  if (existsSync(pidFile)) {
    try { process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL"); } catch { /* gone */ }
    await wait(500);
  }
  const psDead = await cotal(["ps", "--space", SPACE], 20_000);
  console.log(`   dead exit=${psDead.status}\n` + psDead.out.split("\n").map((l) => `   | ${l}`).join("\n").slice(0, 500));
  const emptySuccess =
    psDead.status === 0 &&
    !/unreachable/i.test(psDead.out) &&
    (/\(no managed agents\)/.test(psDead.out) || psDead.out.trim() === "");
  check("dead manager: non-zero or explicit failure, never bare empty success",
    psDead.status !== 0 && !emptySuccess, { status: psDead.status, out: psDead.out.slice(-200) });

  console.log(`\nPS USER MODE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} catch (e) {
  console.error("ps-user-mode threw:", e);
  process.exitCode = 1;
} finally {
  await cotal(["down"], 60_000).catch(() => ({ status: 1, out: "" }));
  idpSrv.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
if (fail) process.exitCode = 1;

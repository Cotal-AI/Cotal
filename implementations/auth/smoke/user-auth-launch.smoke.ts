/**
 * USER-AUTH LAUNCH live smoke (D4c, the composition-root E2E) — the whole operator story against a
 * REAL broker, a REAL Better Auth IdP, and the REAL `cotal` binary as subprocesses:
 *
 *   A. `cotal up --user-auth --idp <real IdP> --detach` — provider prepareServer persists the
 *      space-scoped material, the broker preloads the callout account, the auth-service daemon
 *      comes up (callout + exchange/JWKS), the mesh records mode "user".
 *   B. gate-4 surface checks: JWKS served with the explicit cache contract; /exchange rejects
 *      browser-origin requests and requests without the file-ACL capability.
 *   C. a real device-code login (auto-approved) + `cotal actor grant cli --sub …` → a plain
 *      `cotal send msg` connects USER-MODE (login → exchange → bearer → callout) and the message
 *      lands on the wire as the derived `u_….cli` principal (witnessed on a static admin tap).
 *   D. the deny matrix at the operator surface: revoked actor → refused exchange with the reason;
 *      logged-out machine → the exact `cotal login --idp …` line. No fallback anywhere.
 *   E. recovery: a crashed (SIGKILLed) auth service surfaces the exact `cotal up` recovery on a
 *      user connect, a refresh `cotal up` on the RUNNING broker heals it, and a cross-mode flag
 *      (`up --open` on the user mesh) is refused loudly.
 *   F. `cotal down` stops the auth service (space-scoped pid) with the broker; re-`up` WITHOUT
 *      --user-auth on a user-enabled root is refused fail-closed.
 *
 * COTAL_HOME is sandboxed; kills only what it starts. Needs nats-server on PATH.
 * Run: pnpm smoke:user-auth-launch:live   (pnpm build first — the subprocesses run built dist)
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

const home = mkdtempSync(join(tmpdir(), "cotal-ua-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), "cotal-ua-root-"));

const { connect, credsAuthenticator } = await import("@nats-io/transport-node");
const { chatSubject, isReachable, mintCreds, newIdentity } = await import("@cotal-ai/core");
const { authDir, loadSpaceAuth, userAuthStateDir } = await import("@cotal-ai/workspace");
const { deleteIdpSession, establishIdpSession, loadAuthServiceInfo } = await import("../src/index.js");
type CotalMessage = import("@cotal-ai/core").CotalMessage;
type DeviceLoginPrompt = import("../src/index.js").DeviceLoginPrompt;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 8000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(100);
  return cond();
};

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `ua-launch-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");

/** Run the REAL binary (built dist through bin/cotal.ts) in the sandboxed workspace. ASYNC on
 *  purpose: a sync child would block this process's event loop — and the in-process IdP with it —
 *  deadlocking any subprocess step that calls back into the IdP (the user-mode send does). */
function cotal(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ status: number | null; out: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("npx", ["tsx", BIN, ...args], {
      cwd: opts.cwd ?? root,
      env: { ...process.env, COTAL_HOME: home },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    const t = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("close", (status) => { clearTimeout(t); resolvePromise({ status, out }); });
  });
}

// ---------- the real Better Auth IdP ----------
let handler: ReturnType<typeof toNodeHandler> | undefined;
const idpSrv = createServer((req, res) => handler!(req, res));
await new Promise<void>((r) => idpSrv.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(idpSrv.address() as AddressInfo).port}`;
const base = `${origin}/api/auth`;
const ba = betterAuth({
  baseURL: origin,
  secret: "smoke-only-better-auth-secret-0123456789",
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
const userId = signup.response.user.id;
async function approve(userCode: string): Promise<void> {
  const claim = await fetch(`${base}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
  if (!claim.ok) throw new Error(`device claim failed: HTTP ${claim.status}`);
  const res = await fetch(`${base}/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ userCode }),
  });
  if (!res.ok) throw new Error(`device/approve failed: HTTP ${res.status}`);
}

let witnessNc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  // ---------- A. up --user-auth ----------
  console.log("A) cotal up --user-auth --idp <real IdP> --detach");
  const up = await cotal(["up", "--user-auth", "--idp", base, "--detach", "--server", SERVER, "--space", SPACE]);
  check("up exits 0", up.status === 0, up.out);
  check("up announces the user-auth service + login line", up.out.includes("user-auth service up") && up.out.includes(`cotal login --idp ${base}`), up.out);
  const stateDir = userAuthStateDir(root, SPACE);
  for (const f of ["callout.json", "issuer.json", "owner-secret.json", "idp.json", "service-keys.json", "auth-service.json"])
    check(`space-scoped state exists: ${f}`, existsSync(join(stateDir, f)));
  check("auth-service pid file is space-scoped", existsSync(join(root, ".cotal", `auth-service.${encodeURIComponent(SPACE)}.pid`)));
  const meshFile = join(home, "meshes", `${encodeURIComponent(SPACE)}.json`);
  const mesh = JSON.parse(readFileSync(meshFile, "utf8")) as { mode: string; userAuth?: { idp?: { url?: string } } };
  check('mesh recorded mode "user" with the IdP trust pin', mesh.mode === "user" && mesh.userAuth?.idp?.url === base, mesh);

  // ---------- B. gate-4 surface: JWKS cache contract + exchange hardening ----------
  console.log("B) auth-service surface: JWKS cache contract, browser/cap rejection");
  const info = loadAuthServiceInfo(stateDir)!;
  const jwks = await fetch(`${info.url}/jwks`);
  check("JWKS serves with the explicit cache contract", jwks.ok && /max-age=300/.test(jwks.headers.get("cache-control") ?? ""), jwks.headers.get("cache-control"));
  check("JWKS publishes the Ed25519 key set", Array.isArray(((await jwks.json()) as { keys: unknown[] }).keys));
  const noCap = await fetch(`${info.url}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("exchange without the file-ACL capability is 401", noCap.status === 401);
  const browser = await fetch(`${info.url}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example", authorization: `Bearer ${info.cap}` },
    body: "{}",
  });
  check("browser-origin exchange is rejected (403)", browser.status === 403);

  // ---------- C. login + grant + USER-MODE send ----------
  console.log("C) device login + actor grant + user-mode `cotal send`");
  const { sub } = await establishIdpSession({
    dir: home, idpUrl: base, clientId: CLIENT_ID,
    onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode),
  });
  check("device login established (sub = the signed-up user)", sub === userId, { sub, userId });
  const grant = await cotal(["actor", "grant", "cli", "--sub", sub, "--label", "smoke human"]);
  check("actor grant cli succeeds", grant.status === 0 && grant.out.includes("granted"), grant.out);

  // The witness: a directly-minted static admin tap (pre-flip static+user coexist) on the chat wire.
  const auth = loadSpaceAuth(authDir(root))!;
  witnessNc = await connect({ servers: SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, newIdentity(), "admin"))) });
  const got: CotalMessage[] = [];
  witnessNc.subscribe(chatSubject(SPACE, "*", "*", "general"), {
    callback: (err, m) => { if (!err) try { got.push(m.json<CotalMessage>()); } catch { /* skip */ } },
  });
  await witnessNc.flush();

  const send = await cotal(["send", "msg", "general", "hello from user mode", "--space", SPACE]);
  check("user-mode send exits 0 (login → exchange → bearer → callout)", send.status === 0, send.out);
  const hasText = (g: CotalMessage, text: string) => g.parts?.some((pt) => (pt as { text?: string }).text === text);
  const arrived = await until(() => got.some((g) => hasText(g, "hello from user mode")));
  const frame = got.find((g) => hasText(g, "hello from user mode"));
  check("the witness receives it AS the derived u_….cli principal", arrived && /^u_[a-z2-7]{26}\.cli$/.test(frame?.from.id ?? ""), frame?.from);

  // ---------- D. the deny matrix at the operator surface ----------
  console.log("D) revoke → refused; logout → the exact login line");
  const revoke = await cotal(["actor", "revoke", "cli", "--sub", sub]);
  check("actor revoke succeeds", revoke.status === 0, revoke.out);
  const denied = await cotal(["send", "msg", "general", "should be refused", "--space", SPACE]);
  check("revoked actor's send is refused with the ledger reason", denied.status !== 0 && /refused|not granted/i.test(denied.out), denied.out);
  const regrant = await cotal(["actor", "grant", "cli", "--sub", sub]);
  check("re-grant succeeds (upsert)", regrant.status === 0);
  deleteIdpSession(home, base);
  const loggedOut = await cotal(["send", "msg", "general", "no session", "--space", SPACE]);
  check("logged-out send prints the exact login action", loggedOut.status !== 0 && loggedOut.out.includes(`cotal login --idp ${base}`), loggedOut.out);

  // ---------- E. crash → refresh heal + cross-mode refusal ----------
  console.log("E) auth-service crash → `cotal up` refresh heals it; cross-mode re-up refused");
  // D left the machine logged out — sign back in so the daemon-liveness failure (not the login
  // gate) is what the dead-service send exercises.
  await establishIdpSession({ dir: home, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode) });
  const openUp = await cotal(["up", "--open", "--server", SERVER, "--space", SPACE]);
  check("up --open on the running user mesh is refused (names cotal down)", openUp.status !== 0 && openUp.out.includes("cotal down"), openUp.out);
  // Crash the daemon (SIGKILL — no clean exit, so its stale discovery file survives too).
  const svcPidPath = join(root, ".cotal", `auth-service.${encodeURIComponent(SPACE)}.pid`);
  const svcPid = Number(readFileSync(svcPidPath, "utf8").trim());
  process.kill(svcPid, "SIGKILL");
  await until(() => { try { process.kill(svcPid, 0); return false; } catch { return true; } });
  const deadSend = await cotal(["send", "msg", "general", "service is dead", "--space", SPACE]);
  check("send with a dead auth service names the `cotal up` recovery", deadSend.status !== 0 && deadSend.out.includes("restart it with `cotal up`"), deadSend.out);
  const heal = await cotal(["up", "--server", SERVER, "--space", SPACE]);
  check("refresh `cotal up` on the running broker heals the auth service", heal.status === 0 && heal.out.includes("already running") && heal.out.includes("user-auth service up"), heal.out);
  const healedSend = await cotal(["send", "msg", "general", "healed", "--space", SPACE]);
  check("user-mode send works again after the heal", healedSend.status === 0, healedSend.out);

  // ---------- F. down + fail-closed re-up ----------
  console.log("F) down stops the auth service; re-up without --user-auth is refused");
  const down = await cotal(["down"]);
  check("down exits 0 and stops the user-auth service", down.status === 0 && down.out.includes("user-auth service"), down.out);
  check("auth-service pid file is gone", !existsSync(join(root, ".cotal", `auth-service.${encodeURIComponent(SPACE)}.pid`)));
  let brokerGone = false;
  for (let i = 0; i < 30 && !brokerGone; i++) { brokerGone = !(await isReachable(SERVER)); if (!brokerGone) await wait(200); }
  check("broker is gone", brokerGone);
  const reup = await cotal(["up", "--detach", "--server", SERVER, "--space", SPACE]);
  check("re-up WITHOUT --user-auth is refused fail-closed (names --user-auth)", reup.status !== 0 && reup.out.includes("--user-auth"), reup.out);

  console.log(`\nUSER-AUTH LAUNCH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await witnessNc?.close(); } catch { /* */ }
  await cotal(["down"], { timeoutMs: 30_000 }); // idempotent — kills by ITS OWN pid files only
  idpSrv.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);

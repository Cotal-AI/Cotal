/**
 * `cotal login` records a chat handle, against a REAL Better Auth instance: the device login caches
 * the first of the JWT's preferred_username, email local part and name that is a chat name beside the
 * session, and the provider's offline `userStatus` returns it with the login. When none is, or in a
 * cache an older build wrote, the login reads back with no name. Chat sessions take this name by
 * default. Better Auth mints no preferred_username, so its precedence is not exercised here.
 *
 * Loopback HTTP only; broker-free. Run: pnpm smoke:auth-login-name
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretStore } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { toNodeHandler } from "better-auth/node";
import { approveDevice, type DeviceApprover } from "./_device-approval.js";

const home = mkdtempSync(join(tmpdir(), "cotal-login-name-home-"));
const spaceDir = mkdtempSync(join(tmpdir(), "cotal-login-name-space-"));
process.env.COTAL_HOME = home;
const { cotalAuthProvider, ensurePinnedIdp, establishIdpSession, loadIdpSession, saveIdpSession } = await import("../src/index.js");

const { check, finish } = createSuite();
const CLIENT_ID = "cotal-cli";
const EMAIL = "human@example.test";

let handler: ReturnType<typeof toNodeHandler> | undefined;
const server = createServer((req, res) => handler!(req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const base = `${origin}/api/auth`;
const auth = betterAuth({
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
handler = toNodeHandler(auth);

const COTAL = ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts")];

/** Run the real `cotal login --idp <base> --plain` in its own home, approving its device code as
 *  `user`, after saving `saved` with `cotal config set name` when given. */
const cotalLogin = (user: DeviceApprover, saved?: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
  const own = mkdtempSync(join(tmpdir(), "cotal-login-name-cli-"));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: own, COTAL_HOME: own, XDG_CONFIG_HOME: join(own, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1" };
  if (saved !== undefined) {
    const set = spawnSync(process.execPath, [...COTAL, "config", "set", "name", saved], { env, encoding: "utf8" });
    if (set.status !== 0) throw new Error(`cotal config set name failed:\n${set.stdout}${set.stderr}`);
  }
  const child = spawn(process.execPath, [...COTAL, "login", "--idp", base, "--plain"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let approval: Promise<void> | undefined;
  child.stdout.on("data", (d: Buffer) => { stdout += d; });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d;
    const code = /Approval code\W+(\S+)/.exec(stderr)?.[1];
    if (code && !approval) approval = approveDevice(user, code).catch((e: unknown) => { stderr += `\napproval failed: ${String(e)}`; child.kill(); });
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  child.on("close", (status) => {
    clearTimeout(timer);
    rmSync(own, { recursive: true, force: true });
    done({ status, stdout, stderr: stderr.slice(-600) });
  });
});

try {
  const signup = await auth.api.signUpEmail({ body: { email: EMAIL, password: "correct-horse-battery", name: "Human 42" }, returnHeaders: true });
  const idp = { base, origin, cookie: signup.headers.get("set-cookie")!.split(";")[0]! };
  const userId = signup.response.user.id;
  ensurePinnedIdp(spaceDir, base);
  const status = () => cotalAuthProvider.userStatus({ store: { get: async () => undefined } as unknown as SecretStore, dir: spaceDir, space: "demo", actor: "cli" });

  const est = await establishIdpSession({ dir: home, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p) => approveDevice(idp, p.userCode) });
  check("login records the email's local part as the handle, since the name \"Human 42\" is not a chat name, and still shows the email",
    est.label === EMAIL && loadIdpSession(home, base)?.name === "human", { label: est.label, session: loadIdpSession(home, base) });
  const signedIn = await status();
  check("userStatus returns the recorded handle with the login", signedIn.login?.sub === userId && signedIn.login?.name === "human", signedIn);

  const cached = loadIdpSession(home, base)!;
  saveIdpSession(home, base, { token: cached.token, expiresAt: cached.expiresAt, sub: userId });
  const older = await status();
  check("a login an older build cached has no name, and userStatus reports none", older.login?.sub === userId && older.login.name === undefined, older);

  const other = await auth.api.signUpEmail({ body: { email: "a+b@example.test", password: "correct-horse-battery", name: "Human 42" }, returnHeaders: true });
  const otherIdp = { base, origin, cookie: other.headers.get("set-cookie")!.split(";")[0]! };
  const none = await establishIdpSession({ dir: home, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p) => approveDevice(otherIdp, p.userCode) });
  const unnamed = await status();
  check("a login whose local part and name are both not chat names records no handle",
    none.label === "a+b@example.test" && loadIdpSession(home, base)?.name === undefined && unnamed.login?.sub === other.response.user.id && unnamed.login.name === undefined, { label: none.label, unnamed });

  const named = await cotalLogin(idp);
  check("cotal login prints the chat name it recorded",
    named.status === 0 && /^\s*Chat name\b.*\bhuman$/m.test(named.stdout) && !named.stdout.includes("cotal config set name"), named);
  const nameless = await cotalLogin(otherIdp);
  check("cotal login says it recorded no chat name, and names saving one and --name",
    nameless.status === 0 && /^\s*Chat name\b.*\bnone$/m.test(nameless.stdout) && nameless.stdout.includes("cotal config set name <name>") && nameless.stdout.includes("--name <name>"), nameless);
  const savedNamed = await cotalLogin(idp, "ops-lead");
  check("cotal login with a chat name recorded and one saved says chat uses the saved name",
    savedNamed.status === 0 && /^\s*Chat name\b.*\bhuman$/m.test(savedNamed.stdout) && savedNamed.stdout.includes('your saved name "ops-lead"'), savedNamed);
  const saved = await cotalLogin(otherIdp, "ops-lead");
  check("cotal login with no chat name recorded but one saved says chat uses the saved name, and warns of no refusal",
    saved.status === 0 && /^\s*Chat name\b.*\bnone$/m.test(saved.stdout) && saved.stdout.includes("ops-lead") && !/refuse/.test(saved.stdout), saved);
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(spaceDir, { recursive: true, force: true });
  finish();
}

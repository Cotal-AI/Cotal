/**
 * `cotal login` records the account name, against a REAL Better Auth instance: the device login
 * caches the name the IdP's JWT carries (email, else name, else preferred_username) beside the
 * session, and the provider's offline `userStatus` returns it with the login. A cache an older build
 * wrote, with no name, reads back as a login with no name. Chat sessions take this name by default.
 *
 * Loopback HTTP only; broker-free. Run: pnpm smoke:auth-login-name
 */
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
import { approveDevice } from "./_device-approval.js";

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

try {
  const signup = await auth.api.signUpEmail({ body: { email: EMAIL, password: "correct-horse-battery", name: "Human 42" }, returnHeaders: true });
  const idp = { base, origin, cookie: signup.headers.get("set-cookie")!.split(";")[0]! };
  const userId = signup.response.user.id;
  ensurePinnedIdp(spaceDir, base);
  const status = () => cotalAuthProvider.userStatus({ store: { get: async () => undefined } as unknown as SecretStore, dir: spaceDir, space: "demo", actor: "cli" });

  const est = await establishIdpSession({ dir: home, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p) => approveDevice(idp, p.userCode) });
  check("login records the account name the IdP gave (its email) beside the session",
    est.label === EMAIL && loadIdpSession(home, base)?.name === EMAIL, loadIdpSession(home, base));
  const signedIn = await status();
  check("userStatus returns the recorded account name with the login", signedIn.login?.sub === userId && signedIn.login?.name === EMAIL, signedIn);

  const cached = loadIdpSession(home, base)!;
  saveIdpSession(home, base, { token: cached.token, expiresAt: cached.expiresAt, sub: userId });
  const older = await status();
  check("a login an older build cached has no name, and userStatus reports none", older.login?.sub === userId && older.login.name === undefined, older);
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(spaceDir, { recursive: true, force: true });
  finish();
}

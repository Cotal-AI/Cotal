/**
 * Local dev IdP for trying per-user auth BY HAND — the same Better Auth setup the live smoke
 * boots (`smoke/user-auth-launch.smoke.ts`), kept alive with an interactive approval prompt.
 * Better Auth is headless (no hosted verification page), so the "approve in a browser" step is
 * replaced by pasting the user code from `cotal login` into this terminal.
 *
 * Everything is in-memory: restarting this process forgets users, sessions, and signing keys —
 * you'd have to `cotal login` AND `cotal actor grant` again (the IdP subject changes). Keep it
 * running for the whole session.
 *
 * Run: cd implementations/auth && npx tsx dev-idp.ts     (Ctrl-C to stop)
 */
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { toNodeHandler } from "better-auth/node";

const PORT = Number(process.env.DEV_IDP_PORT ?? 4780);
const CLIENT_ID = "cotal-cli"; // the CLI's default --client-id
const origin = `http://127.0.0.1:${PORT}`;
const base = `${origin}/api/auth`;

let handler: ReturnType<typeof toNodeHandler> | undefined;
const srv = createServer((req, res) => handler!(req, res));
await new Promise<void>((resolve, reject) => {
  srv.once("error", reject);
  srv.listen(PORT, "127.0.0.1", resolve);
});

const ba = betterAuth({
  baseURL: origin,
  secret: "dev-only-better-auth-secret-0123456789",
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
  emailAndPassword: { enabled: true },
  plugins: [
    jwt({ jwt: { issuer: origin, audience: origin } }),
    deviceAuthorization({ expiresIn: "10m", interval: "1s", validateClient: (id) => id === CLIENT_ID }),
    bearer(),
  ],
});
handler = toNodeHandler(ba);

// Seed one human. The session cookie is what "being signed in on the verification page" means.
const signup = await ba.api.signUpEmail({
  body: { email: "david@example.test", password: "dev-only-password", name: "David" },
  returnHeaders: true,
});
const cookie = signup.headers.get("set-cookie")!.split(";")[0];
const sub = signup.response.user.id;

async function approve(userCode: string): Promise<void> {
  const claim = await fetch(`${base}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
  if (!claim.ok) throw new Error(`device claim failed: HTTP ${claim.status} (typo? expired? already used?)`);
  const res = await fetch(`${base}/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ userCode }),
  });
  if (!res.ok) throw new Error(`device approve failed: HTTP ${res.status}`);
}

console.log(`dev IdP up (in-memory, dies with this process)`);
console.log(`  base URL : ${base}`);
console.log(`  human    : david@example.test - IdP subject (sub): ${sub}`);
console.log(`\nUse it from another terminal:`);
console.log(`  cotal up --user-auth --idp ${base} …`);
console.log(`  cotal login --idp ${base}`);
console.log(`\nWhen \`cotal login\` shows a user code, paste it below to approve the sign-in.`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt("user code> ");
rl.prompt();
rl.on("line", (line) => {
  const code = line.trim();
  if (!code) return rl.prompt();
  approve(code)
    .then(() => console.log(`approved ✓ - \`cotal login\` should complete on its next poll (~1s)`))
    .catch((e) => console.error(e instanceof Error ? e.message : String(e)))
    .finally(() => rl.prompt());
});
rl.on("close", () => {
  srv.close();
  process.exit(0);
});

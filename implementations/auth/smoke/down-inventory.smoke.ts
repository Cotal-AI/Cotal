/** Real user-auth shutdown: a refused optional inventory must not print broker internals. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { toNodeHandler } from "better-auth/node";
import { establishIdpSession, loadActorLedger } from "../src/index.js";
import { userAuthStateDir } from "@cotal-ai/workspace";
import { pickFreePort } from "./_free-port.js";
import { approveDevice } from "./_device-approval.js";

const repo = join(import.meta.dirname, "..", "..", "..");
const fixture = mkdtempSync(join(tmpdir(), "cotal-down-inventory-"));
const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "NODE_OPTIONS"));
let passed = 0, failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (ok) passed++; else failed++;
};
let handler: ReturnType<typeof toNodeHandler>;
const server = createServer((req, res) => handler(req, res));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const base = `${origin}/api/auth`;
const auth = betterAuth({
  baseURL: origin,
  secret: "smoke-only-better-auth-secret-0123456789",
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
  emailAndPassword: { enabled: true },
  plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id) => id === "cotal-cli" }), bearer()],
});
handler = toNodeHandler(auth);
const signup = await auth.api.signUpEmail({ body: { email: "down@example.test", password: "correct-horse-battery", name: "Shutdown test" }, returnHeaders: true });
const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
try {
  for (const kind of ["member", "full", "admin"] as const) {
    const root = join(fixture, kind, "project"), home = join(fixture, kind, "home"), config = join(fixture, kind, "config");
    for (const dir of [root, home, config]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = { ...ambient, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
    const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: config });
    const port = await pickFreePort();
    const space = `down-${kind}-${port}`;
    const run = async (name: string, args: string[]) => {
      const options = { cwd: root, env };
      assertSmokeSandboxDown(sandbox, args, options);
      return await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
        const child = spawn(join(repo, "node_modules", ".bin", "tsx"), [join(repo, "bin", "cotal.ts"), ...args], options);
        let out = "";
        child.stdout.on("data", (data) => { out += String(data); });
        child.stderr.on("data", (data) => { out += String(data); });
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("close", (code) => {
          clearTimeout(timer);
          writeFileSync(join(fixture, kind, `${name}.log`), out, { mode: 0o600 });
          resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "") });
        });
      });
    };
    let stopped = false;
    try {
      const up = await run("up", ["up", "--user-auth", "--idp", base, "--auth-timeout", "3", "--detach", "--server", `nats://127.0.0.1:${port}`, "--space", space]);
      check(`${kind}: real stack starts`, up.code === 0 && up.out.includes("user-auth service"));
      if (up.code !== 0) throw new Error(`${kind}: setup failed; see retained fixture`);
      const { sub } = await establishIdpSession({ dir: home, idpUrl: base, clientId: "cotal-cli", onPrompt: (prompt) => approveDevice({ base, cookie, origin }, prompt.userCode) });
      check(`${kind}: real device login`, sub === signup.response.user.id);
      const scope = kind === "member" ? ["--scope", "role:default"] : kind === "admin" ? ["--scope", "admin"] : [];
      const grant = await run("grant", ["actor", "grant", "cli", "--sub", sub, "--full", ...scope]);
      check(`${kind}: fixture grant stored`, grant.code === 0);
      if (grant.code !== 0) throw new Error(`${kind}: grant setup failed; see retained fixture`);
      const before = JSON.stringify(loadActorLedger(userAuthStateDir(root, space)));
      const ps = await run("ps", ["ps", "--space", space]);
      check(`${kind}: inventory permission control`, kind === "member" ? ps.code !== 0 && /permission|refused|authorize/i.test(ps.out) : ps.code === 0);
      const down = await run("down", ["down", "--yes"]);
      stopped = down.code === 0;
      check(`${kind}: shutdown exits zero`, stopped);
      check(`${kind}: all four components report stopped`, ["stopped manager", "stopped delivery daemon", "stopped user-auth service", "stopped nats-server"].every((s) => down.out.includes(s)));
      check(`${kind}: inventory warning contains no broker internals`, !/REFUSED BY THE BROKER|ep\.v1\.inst|SPEC 13\.2/.test(down.out));
      check(`${kind}: inventory result is explained`, kind === "member" ? /could not list managed agents.*access denied/i.test(down.out) && down.out.includes("cotal ps") : !down.out.includes("could not list managed agents"));
      check(`${kind}: shutdown does not widen the actor grant`, JSON.stringify(loadActorLedger(userAuthStateDir(root, space))) === before);
    } finally {
      if (!stopped) await run("cleanup-down", ["down", "--yes"]);
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
console.log(`${passed} passed, ${failed} failed; fixtures retained at ${fixture}`);
process.exitCode = failed ? 1 : 0;

/** A malformed exchange bearer keeps the workspace recovery hint in component status.
 * Drives the built CLI through real loopback HTTP and private remote-registration files.
 * The broker address deliberately refuses connections; this tests client decoding, not auth issuance.
 * Run: pnpm smoke:status-bearer
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = process.argv[2] ?? join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
const { check, finish } = createSuite();
const root = mkdtempSync(join(tmpdir(), "cotal-status-bearer-"));
const home = join(root, "home"), config = join(root, "config"), project = join(root, "project");
for (const path of [home, config, project, join(project, ".cotal")]) mkdirSync(path, { recursive: true, mode: 0o700 });
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"].includes(key.toUpperCase())));
Object.assign(env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: config, TMPDIR: root, DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" });
process.env.COTAL_HOME = env.COTAL_HOME;
process.env.XDG_CONFIG_HOME = config;
const { recordMesh, setCurrent, userAuthStateDir } = await import("@cotal-ai/workspace");
const { saveIdpSession } = await import("../../auth/src/login.js");
const space = "status-bearer";
const compact = (payload: unknown) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture-signature`;
const valid = compact({ sub: "fixture-owner", act: { actor: "cli", lifecycleUid: "a".repeat(26) } });
let token = valid, exchanges = 0;
// Hold the address for the whole test so no foreign listener can receive a probe. It is not NATS.
const unavailable = createTcpServer(socket => socket.destroy());
const http = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/token") res.end(JSON.stringify({ token: compact({ sub: "fixture-human" }) }));
  else if (req.url === "/exchange") { exchanges++; res.end(JSON.stringify({ token })); }
  else { res.writeHead(404); res.end("{}"); }
});
const run = (args: string[]) => new Promise<{ code: number; text: string }>((resolve, reject) => {
  execFile(process.execPath, [BIN, ...args], { cwd: project, env, encoding: "utf8", timeout: 45_000 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") { reject(error); return; }
    resolve({ code: error?.code ?? 0, text: stdout + stderr });
  });
});
try {
  await new Promise<void>(resolve => unavailable.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const broker = `nats://127.0.0.1:${(unavailable.address() as { port: number }).port}`;
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`, idp = base + "/api/auth";
  const state = userAuthStateDir(project, space); mkdirSync(state, { recursive: true, mode: 0o700 });
  const sentinel = join(state, "sentinel.creds");
  // No real credential is needed: bad payloads refuse before a dial, and the valid control's
  // unavailable greeting precedes credential use. Only synthetic login/credential markers are stored.
  writeFileSync(sentinel, "synthetic-sentinel-not-used", { mode: 0o600 });
  recordMesh({ space, server: broker, root: project, mode: "user", origin: "manual", ts: new Date().toISOString(), userAuth: {
    provider: "cotal", remote: true, idp: { url: idp, issuer: idp, audience: idp }, endpoints: { url: base }, sentinelCredsPath: sentinel,
  } });
  setCurrent(space);
  saveIdpSession(env.COTAL_HOME!, idp, { token: "synthetic-login", expiresAt: Math.floor(Date.now() / 1000) + 600, sub: "fixture-human" });
  const status = () => run(["status", "--components", "--space", space]);
  const control = await status();
  check("valid principal reaches the unavailable broker instead of a login refusal", control.code === 3 && /manager\s+refused.*serve probe refused/.test(control.text) && !control.text.includes("probe needs the signed-in login"), control.text);
  for (const [label, bearer, reason] of [
    ["invalid JSON", `e30.${Buffer.from("not-json").toString("base64url")}.fixture-signature`, "not-json"],
    ["missing lifecycle", compact({ sub: "fixture-owner", act: { actor: "cli" } }), "missing act.lifecycleUid"],
  ] as const) {
    token = bearer;
    const before = exchanges;
    const result = await status();
    check(`${label}: status reached the actual exchange`, exchanges > before);
    check(`${label}: component status refuses the principal`, result.code === 3 && /manager\s+refused.*probe needs the signed-in login/.test(result.text) && result.text.includes(reason), result.text);
    check(`${label}: status retains the shared stale-service and restart guidance`, result.text.includes("could not read the principal from the minted bearer") && result.text.includes("auth service's build may be stale") && result.text.includes("cotal up"), result.text);
  }
  token = valid;
  const restored = await status();
  check("restoring the valid bearer removes the login refusal", restored.code === control.code && /manager\s+refused.*serve probe refused/.test(restored.text) && !restored.text.includes("probe needs the signed-in login"), restored.text);
} finally {
  await new Promise<void>(resolve => http.close(() => resolve()));
  await new Promise<void>(resolve => unavailable.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
finish();

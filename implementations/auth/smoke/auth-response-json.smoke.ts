/** Real HTTP responses through the built auth provider, shipped bearer CLI, and actor command.
 * Run: pnpm smoke:auth-response-json */
import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { createSpaceAuth, registry, type Command, type SecretStore } from "@cotal-ai/core";
import { isCommandFailure, recordMesh, recordPreparedSpace, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { cotalAuthProvider, ensureCalloutAuth, ensureOwnerSecret, ensurePinnedIdp, findInteractiveActor, grantActor, saveAuthServiceInfo, saveIdpSession } from "../dist/index.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = mkdtempSync(join(tmpdir(), "cotal-auth-json-"));
const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_HOME: process.env.COTAL_HOME };
const cwd = process.cwd();
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.COTAL_HOME = join(root, "home", ".cotal");
mkdirSync(join(root, ".cotal"));
process.chdir(root);
let status = 200, answer = "{}";
const server = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  if (req.url === "/api/auth/token") { res.setHeader("content-type", "application/json"); res.end('{"token":"fixture-idp-proof"}'); return; }
  res.writeHead(status, { "content-type": answer.startsWith("<") ? "text/html" : "application/json" });
  res.end(answer === "retired" ? JSON.stringify({ retired: true, lifecycleUid: JSON.parse(raw).lifecycleUid }) : answer);
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
const idpUrl = `${origin}/api/auth`, space = "json-local", actor = "probe_agent", owner = `u_${"a".repeat(26)}`;
const dir = userAuthStateDir(root, space), store = workspaceSecretStore(root);
const emptyStore: SecretStore = { identity: { kind: "injected", coordinate: "auth-json-empty" }, get: async () => undefined, put: async () => {}, create: async () => true, delete: async () => {} };
const tokenFile = join(root, "actor-token"), healthFile = join(root, "health");
writeFileSync(tokenFile, "fixture-actor-secret", { mode: 0o600 });
const set = (code: number, body: unknown) => { status = code; answer = typeof body === "string" ? body : JSON.stringify(body); };
const unreadable = (code: number, face = "exchange") => new RegExp(`${face}.*answered HTTP ${code} with a body that could not be read as JSON`);
const decodeFailure = (code: number, face: string) => (error: unknown) => error instanceof Error && unreadable(code, face).test(error.message) && !error.message.includes("private gateway text");

async function bearer(local: boolean): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, ["--import", join(repo, "node_modules/tsx/dist/loader.mjs"), join(repo, "bin/cotal.ts"), "agent-bearer",
    ...(local ? ["--dir", dir] : ["--exchange-url", origin]), "--space", space, "--owner", owner, "--actor", actor, "--token-file", tokenFile, "--health-file", healthFile],
    { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_HOME: process.env.COTAL_HOME, COTAL_NO_PROMPT: "1" }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000, killSignal: "SIGKILL" });
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
  const code = await new Promise<number | null>((done, reject) => { child.on("error", reject); child.on("close", done); });
  return { code, out, err };
}

try {
  const auth = await createSpaceAuth(space);
  const callout = await ensureCalloutAuth(store, { space, operatorSeed: auth.operator.seed!, accountPub: auth.account.pub });
  await ensureOwnerSecret(store, space);
  ensurePinnedIdp(dir, idpUrl);
  saveAuthServiceInfo(dir, { url: origin, cap: "fixture-loopback-cap", pid: process.pid });
  saveIdpSession(process.env.COTAL_HOME!, idpUrl, { token: "fixture-session", expiresAt: Date.now() / 1000 + 600 });
  recordPreparedSpace({ space, root, ts: new Date().toISOString() });
  const remoteSpace = "json-remote", remoteDir = userAuthStateDir(root, remoteSpace), sentinel = join(remoteDir, "sentinel.creds");
  mkdirSync(remoteDir, { recursive: true }); writeFileSync(sentinel, "fixture-remote-sentinel", { mode: 0o600 });
  recordMesh({ space: remoteSpace, root, server: "nats://127.0.0.1:1", mode: "user", origin: "manual", ts: new Date().toISOString(), userAuth: {
    provider: "cotal", idp: { url: idpUrl, issuer: origin, audience: origin }, remote: true, endpoints: { url: origin }, sentinelCredsPath: sentinel,
  } });
  const provision = () => cotalAuthProvider.postAgentProvisioning!({ url: `${origin}/provision`, idpUrl, actor });
  const material = { actor, actorToken: "fixture-material", sentinelCreds: "fixture-sentinel" };
  set(200, material); assert.deepEqual(await provision(), material, "provisioning preserves valid material");
  set(200, {}); assert.deepEqual(await provision(), {}, "provisioning leaves valid JSON shape checking to its caller");
  for (const code of [200, 401, 500]) {
    set(code, "<html>private gateway text</html>");
    await assert.rejects(provision(), decodeFailure(code, "agent-provisioning endpoint"), "provisioning reports unreadable JSON with face and status");
  }
  set(401, { error: "fixture-denial" }); await assert.rejects(provision(), /fixture-denial.*session may have expired/, "provisioning preserves login refusal remedy");
  set(500, {}); await assert.rejects(provision(), /HTTP 500/, "provisioning preserves readable refusal without reason");

  for (const local of [true, false]) {
    const credentials = () => cotalAuthProvider.userCredentials({ store: local ? store : emptyStore, dir: local ? dir : remoteDir, space: local ? space : remoteSpace, actor });
    const face = local ? "local exchange" : "remote exchange";
    set(200, { token: "fixture-bearer" });
    assert.deepEqual(await credentials(), { bearer: "fixture-bearer", sentinelCreds: local ? callout.sentinelCreds : "fixture-remote-sentinel" }, `${face} preserves valid credentials`);
    set(200, {}); await assert.rejects(credentials(), /returned no token/, `${face} keeps the valid JSON token check`);
    for (const code of [200, 403]) {
      set(code, "<html>private gateway text</html>");
      await assert.rejects(credentials(), decodeFailure(code, local ? "auth service.s exchange" : "the exchange"), `${face} reports unreadable JSON with face and status`);
    }
    set(403, { error: "fixture-denial" });
    await assert.rejects(credentials(), (error: unknown) => error instanceof Error && error.message.includes("fixture-denial") && (error as { code?: string }).code === "refused", `${face} preserves authenticated refusal classification`);
    set(403, {}); await assert.rejects(credentials(), local ? /HTTP 403/ : /withheld the reason \(HTTP 403\)/, `${face} preserves readable refusal without reason`);
  }

  for (const local of [true, false]) {
    const face = local ? "local bearer CLI" : "remote bearer CLI";
    set(200, { token: "fixture-bearer" });
    const ok = await bearer(local); assert.equal(ok.code, 0, `${face} accepts a valid token`); assert.equal(ok.out, "fixture-bearer\n", `${face} prints token only`);
    assert.equal(JSON.parse(readFileSync(healthFile, "utf8")).state, "ok", `${face} records healthy token exchange`);
    set(200, {}); assert.match((await bearer(local)).err, /returned no token/, `${face} keeps the valid JSON token check`);
    for (const code of [200, 403]) {
      set(code, "<html>private gateway text</html>"); const result = await bearer(local);
      assert.equal(result.code, 1, `${face} refuses unreadable JSON`);
      assert.match(result.err, unreadable(code), `${face} reports unreadable JSON with face and status`);
      assert.doesNotMatch(result.err, /private gateway text|returned no token/, `${face} does not leak body or infer missing token`);
      const health = JSON.parse(readFileSync(healthFile, "utf8")); assert.equal(health.state, "failed", `${face} records failure`); assert.match(health.reason, unreadable(code), `${face} records decode reason`);
    }
    set(403, { error: "fixture-denial" }); assert.match((await bearer(local)).err, /exchange refused: fixture-denial/, `${face} preserves readable refusal`);
  }

  const command = registry.all<Command>("command").find(c => c.name === "actor")!;
  for (const verb of ["grant", "revoke"] as const) {
    const row = grantActor(dir, { owner, actor, scope: ["spawn"], allowSubscribe: [">"], allowPublish: [">"] });
    const run = () => command.run({ values: { space, owner, ...(verb === "grant" ? { full: true } : {}) }, positionals: [verb, actor], raw: [] });
    for (const code of [200, 403]) {
      set(code, "<html>private gateway text</html>");
      await assert.rejects(run(), (error: unknown) => isCommandFailure(error) && error.outcome === "unknown" && error.code === "OPERATION_UNKNOWN" && unreadable(code, "lifecycle retirement endpoint").test(error.message) && !error.message.includes("private gateway text"), "actor retirement preserves unknown outcome and reports unreadable JSON");
      assert.deepEqual(findInteractiveActor(dir, owner, actor), row, "unreadable retirement never changes the actor row");
    }
    set(403, { error: "fixture-denial", outcome: "not-executed" });
    await assert.rejects(run(), (error: unknown) => isCommandFailure(error) && error.outcome === "refused" && error.code === "PERMISSION_DENIED" && error.message.includes("fixture-denial"), "readable retirement denial remains refused");
    set(200, {}); await assert.rejects(run(), (error: unknown) => isCommandFailure(error) && error.outcome === "unknown", "valid JSON without retirement result remains unknown");
  }
  set(200, "retired");
  await command.run({ values: { space, owner }, positionals: ["revoke", actor], raw: [] });
  assert.equal(findInteractiveActor(dir, owner, actor), undefined, "readable successful retirement allows revoke");
  console.log("auth-response-json smoke: passed");
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally {
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  process.chdir(cwd);
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}

/**
 * The auth-service preset must refuse an unprepared hosting root before saving a definition.
 * Runs the built CLI in private static-auth and prepared user-auth sandboxes, with no broker.
 * Run: pnpm smoke:auth-service-prerequisite
 */
import nodeAssert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const bin = join(import.meta.dirname, "../../../bin/dist/cotal.js");
assert.ok(existsSync(bin), "build the CLI first");
const scratch = mkdtempSync(join(tmpdir(), "cotal-auth-service-prerequisite-"));
const home = join(scratch, "home"), root = join(scratch, "root");
for (const dir of [home, join(root, ".cotal")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !key.startsWith("NATS_")));
Object.assign(env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1" });
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_") || key.startsWith("NATS_")) delete process.env[key];
Object.assign(process.env, env);
process.env.COTAL_HOME = join(home, "cotal");
const { createSpaceAuth } = await import("@cotal-ai/core");
const { assertUserAuthInfo, authDir, hasUserAuthState, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { cotalAuthProvider } = await import("@cotal-ai/auth");
const space = "auth_prerequisite";
const server = "nats://127.0.0.1:4999";
const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(root), auth);
const userAuth = assertUserAuthInfo({ provider: "cotal", idp: { url: "http://127.0.0.1:4998/api/auth", issuer: "http://127.0.0.1:4998/api/auth", audience: "cotal" } });
const register = (mode: "auth" | "user") => recordMesh({ space, server, root, mode, ...(mode === "user" ? { userAuth } : {}), policy: { events: "required" }, ts: new Date().toISOString() });
register("auth");
function run(args: string[]) {
  const result = spawnSync(process.execPath, [bin, "service", ...args, "--space", space, "--no-input"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  return result;
}
function inventory() {
  const result = run(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).result as { definitions: { name: string }[]; instances: unknown[] };
}
// The reported static-auth add must refuse before any definition or instance is saved.
const added = run(["add", "aus", "--preset", "auth-service", "--json"]);
console.log("static-auth add", JSON.stringify({ exit: added.status, envelope: JSON.parse(added.stdout) }));
assert.equal(added.status, 2, "static-auth add must refuse, rather than save a definition whose start cannot succeed");
const refusal = JSON.parse(added.stdout);
assert.equal(refusal.outcome, "refused");
assert.equal(refusal.error.code, "UNSUPPORTED");
assert.match(refusal.error.remedy, /cotal up --user-auth --idp <url>/);
assert.equal(hasUserAuthState(root, space, { readOnly: true }), false);
assert.deepEqual(inventory().definitions, []);
assert.deepEqual(inventory().instances, []);
const text = run(["add", "aus", "--preset", "auth-service"]);
assert.equal(text.status, 2);
assert.match(text.stderr, /cotal up --user-auth --idp <url>/);
assert.doesNotMatch(text.stdout, /Service definition saved/);
const direct = run(["start", "auth-service", "--json"]);
assert.equal(direct.status, 2);
assert.match(JSON.parse(direct.stdout).error.remedy, /cotal up --user-auth --idp <url>/);
assert.deepEqual(inventory().definitions, []);
assert.deepEqual(inventory().instances, []);
// A user-mode registration alone does not prepare the host's native state.
register("user");
const noMarker = run(["add", "aus", "--preset", "auth-service", "--json"]);
assert.equal(noMarker.status, 2);
assert.match(JSON.parse(noMarker.stdout).error.remedy, /cotal up --user-auth --idp <url>/);
// Prepare with the real provider, rather than manufacturing a marker or inspecting key files.
const { publicKey } = generateKeyPairSync("ed25519");
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "prerequisite", alg: "EdDSA" };
const idp = createServer((_req, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const address = idp.address();
assert.ok(address && typeof address !== "string");
const prepared = await (async () => {
  try {
    return await cotalAuthProvider.prepareServer({ space, operatorSeed: auth.operator.seed, account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, store: workspaceSecretStore(root), dir: userAuthStateDir(root, space), idpUrl: `http://127.0.0.1:${address.port}/api/auth` });
  } finally { await new Promise<void>((resolve, reject) => idp.close((error) => error ? reject(error) : resolve())); }
})();
recordMesh({ space, server, root, mode: "user", policy: { events: "required" }, userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
const ready = run(["add", "aus", "--preset", "auth-service", "--json"]);
assert.equal(ready.status, 0, ready.stderr || ready.stdout);
assert.equal(JSON.parse(ready.stdout).result.kind, "service-definition-added");
assert.deepEqual(inventory().definitions.map((row) => row.name), ["aus"]);
assert.deepEqual(inventory().instances, []);
// A supplied root must carry this space's state, not merely the default hosting root's state.
const emptyRoot = join(scratch, "empty-root");
mkdirSync(emptyRoot, { mode: 0o700 });
const otherRoot = run(["add", "other", "--preset", "auth-service", "--root", emptyRoot, "--json"]);
assert.equal(otherRoot.status, 2);
assert.match(JSON.parse(otherRoot.stdout).error.remedy, /cotal up --user-auth --idp <url>/);
assert.deepEqual(inventory().definitions.map((row) => row.name), ["aus"]);
console.log("PASS: static-auth and unprepared user-auth add refuse with setup guidance, prepared user-auth add saves without launching");
emitSentinel({ passed: counted.cells(), failed: 0 });

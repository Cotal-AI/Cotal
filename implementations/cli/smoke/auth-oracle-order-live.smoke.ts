/** Actual installed CLI startup/refresh and crash repair. Takes an npm prefix and a new evidence
 *  directory: pnpm smoke:auth-oracle-order:live <prefix> <evidence>. No seed bypass or broker mock.
 *  The JWKS-only fixture has no user session, so cleanup stops only its attributed OS processes;
 *  it does not bypass authenticated logical teardown. The private fixture stays in the evidence directory. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createPortHolder, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AUTH_PIDFILE, DELIVERY_PIDFILE, canonicalLocalProcessPath, parsePid, probeLiveness } from "@cotal-ai/workspace";
import { skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("auth-oracle-order uses Linux process birth/cwd/environment evidence");
const [prefix, evidence] = process.argv.slice(2);
assert.ok(prefix && evidence && isAbsolute(prefix) && isAbsolute(evidence), "provide an absolute installed npm prefix and a new evidence directory");
const cli = join(prefix, "node_modules/cotal-ai/dist/cotal.js");
assert.ok(existsSync(cli), "the installed CLI entry exists");
mkdirSync(evidence, { mode: 0o700 });
const root = join(evidence, "project"), home = join(evidence, "home"), temp = join(evidence, "tmp");
for (const dir of [root, home, temp, join(root, ".cotal")]) mkdirSync(dir, { mode: 0o700 });
const space = "auth-oracle-order";
const env: NodeJS.ProcessEnv = {
  HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_HOME: join(home, ".cotal"), COTAL_ROOT: root,
  TMPDIR: temp, PATH: process.env.PATH, LANG: "C.UTF-8", CI: "1", DO_NOT_TRACK: "1", NO_COLOR: "1",
};
const publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" });
const idp = createServer((req, res) => {
  if (req.url !== "/jwks") { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ ...publicKey, kid: "fixture", use: "sig", alg: "RS256" }] }));
});
await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
const idpUrl = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
const holder = createPortHolder();
await new Promise<void>(resolve => holder.listen(0, "127.0.0.1", resolve));
const server = `nats://127.0.0.1:${(holder.address() as AddressInfo).port}`;
await new Promise<void>((resolve, reject) => holder.close(error => error ? reject(error) : resolve()));
const up = ["up", "--space", space, "--server", server, "--host", "127.0.0.1", "--user-auth", "--idp", idpUrl, "--no-manager", "--detach"];
type Role = "broker" | "auth" | "delivery";
type Identity = { pid: number; start: string };
const roles: Role[] = ["broker", "auth", "delivery"];
const paths: Record<Role, string> = {
  broker: join(root, ".cotal/nats.pid"),
  auth: canonicalLocalProcessPath(AUTH_PIDFILE, { root, space }),
  delivery: canonicalLocalProcessPath(DELIVERY_PIDFILE, { root, space }),
};
const observations: Record<string, unknown> = {};
let passed = 0, failed = 0;
function check(name: string, value: boolean): void {
  if (value) passed++; else failed++;
  console.log(`${value ? "PASS" : "FAIL"} ${name}`);
}
function identity(pid: number): Identity {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  assert.ok(start, "process birth identity is present");
  const cwd = readlinkSync(`/proc/${pid}/cwd`);
  assert.ok(cwd === root || cwd.startsWith(root + "/"), "process belongs to the fixture root");
  assert.ok(readFileSync(`/proc/${pid}/environ`).toString().split("\0").includes(`COTAL_HOME=${env.COTAL_HOME}`), "process belongs to the fixture private home");
  return { pid, start };
}
function snapshot(): Partial<Record<Role, Identity>> {
  const result: Partial<Record<Role, Identity>> = {};
  for (const role of roles) {
    if (!existsSync(paths[role])) continue;
    const pid = parsePid(readFileSync(paths[role], "utf8"));
    assert.ok(pid, "pid record is attributable");
    const state = probeLiveness(pid);
    assert.notEqual(state, "unknown", "unknown process liveness never authorizes a signal");
    if (state === "alive") result[role] = identity(pid);
  }
  return result;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function stopOwned(held: Identity, signal: NodeJS.Signals): Promise<void> {
  assert.equal(identity(held.pid).start, held.start, "the original process still owns the pid");
  process.kill(held.pid, signal);
  for (const end = Date.now() + 15000; probeLiveness(held.pid) !== "dead" && Date.now() < end;) await sleep(100);
  assert.equal(probeLiveness(held.pid), "dead", "the original process actually stopped");
}
async function call(label: string): Promise<number | null> {
  assert.equal(realpathSync(root), root);
  assert.ok(existsSync(join(root, ".cotal")));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...up], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    child.once("error", reject);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 240000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      writeFileSync(join(evidence, `${label}.stdout`), out, { flag: "wx", mode: 0o600 });
      writeFileSync(join(evidence, `${label}.stderr`), err, { flag: "wx", mode: 0o600 });
      try {
        observations[label] = { code, signal, timedOut, processes: snapshot() };
        if (timedOut) reject(new Error(`${label} timed out`)); else resolve(code);
      } catch (error) { reject(error); }
    });
  });
}
try {
  check("fresh user-auth startup succeeds", await call("initial") === 0);
  const original = snapshot();
  assert.ok(original.broker && original.auth && original.delivery, "all three owned processes are live");
  check("delivery starts before auth", BigInt(original.delivery.start) < BigInt(original.auth.start));
  check("healthy refresh succeeds", await call("refresh") === 0);
  const refreshed = snapshot();
  check("healthy refresh preserves all process identities", roles.every(role => refreshed[role]?.pid === original[role]?.pid && refreshed[role]?.start === original[role]?.start));
  for (const role of ["auth", "delivery", "broker"] as const) await stopOwned(original[role]!, "SIGKILL");
  check("all original fixture processes stopped", Object.keys(snapshot()).length === 0);
  // Let the unchanged delivery lease expire; never edit a lease/claim or force takeover.
  await sleep(35000);
  check("one repair invocation succeeds", await call("repair") === 0);
  const repaired = snapshot();
  check("first repair restores all three components", roles.every(role => repaired[role] !== undefined));
  check("follow-up refresh succeeds", await call("followup") === 0);
  const final = snapshot();
  check("follow-up preserves repaired live processes", roles.every(role => !repaired[role] || (final[role]?.pid === repaired[role]?.pid && final[role]?.start === repaired[role]?.start)));
} catch (error) {
  failed++;
  observations.error = error instanceof Error ? { name: error.name, message: error.message } : String(error);
  console.error("FAIL fixture operation", observations.error);
} finally {
  const live = snapshot();
  for (const role of ["auth", "delivery", "broker"] as const) if (live[role]) await stopOwned(live[role]!, "SIGTERM");
  check("owned process cleanup is complete", Object.keys(snapshot()).length === 0);
  await new Promise<void>(resolve => idp.close(() => resolve()));
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed, failed, observations, logicalDownAttempted: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
console.log(`auth-oracle-order: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0);

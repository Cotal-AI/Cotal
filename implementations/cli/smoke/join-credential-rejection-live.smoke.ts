/** Shipped-entry coverage for rejected credential joins, using isolated local stacks. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, killAndAwaitExit, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { clean, nodePty, wait, type Pty } from "./_console-pty.js";

const tree = resolve(import.meta.dirname, "../../..");
const entry = join(tree, "bin/dist/cotal.js");
const dir = mkdtempSync(join(tmpdir(), "join-credential-rejection-"));
const home = join(dir, "home"), alpha = join(dir, "alpha"), beta = join(dir, "beta"), keys = join(dir, "keys");
const config = join(dir, "config"), runtime = join(dir, "runtime"), cotal = join(dir, "cotal");
for (const path of [home, alpha, beta, keys, config, runtime, cotal]) mkdirSync(path, { mode: 0o700 });
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined && !row[0].startsWith("COTAL_")));
Object.assign(env, { HOME: home, COTAL_HOME: cotal, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" });
const { check, finish } = createSuite();
const anchors = new Map<string, SmokeSandboxAnchor>();
const terminals = new Set<Pty>();
const children = new Set<ChildProcess>();
type Envelope = { result?: { lifecycleUid?: string }; error?: { code?: string; message?: string; remedy?: string }; target?: { space?: string; path?: string } };
function cli(cwd: string, ...args: string[]) {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  const run = spawnSync(process.execPath, [entry, ...args], options);
  assert.ifError(run.error);
  assert.equal(run.signal, null, "CLI must exit without a signal");
  const envelope = args.includes("--json") ? JSON.parse(run.stdout) as Envelope : undefined;
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, envelope };
}
function ok(cwd: string, ...args: string[]) {
  const run = cli(cwd, ...args);
  assert.equal(run.status, 0, `${args[0]} failed: ${run.stderr || run.stdout}`);
  return run;
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 45_000;
  while (!test() && Date.now() < deadline) await wait(50);
  assert.ok(test(), "terminal did not reach its expected state");
}
function mint(root: string, space: string, name: string) {
  const file = join(keys, `${name}.creds`);
  const run = ok(root, "auth", "mint", name, "--space", space, "--provision", "--allow-subscribe", "general", "--allow-publish", "general", "--role", "reviewer", "--out", file, "--json");
  const uid = run.envelope?.result?.lifecycleUid;
  assert.ok(uid, "provisioning mint must report its lifecycle UID");
  return { file, uid };
}
async function rejected(label: string, credential: { file: string; uid: string }, diagnosis: string, ...flags: string[]) {
  const run = cli(alpha, "join", "--space", "alpha", "--name", "alice", "--channel", "general", "--creds", credential.file, "--lifecycle-uid", credential.uid, ...flags);
  console.log(`OBSERVED ${label}: exit ${run.status}\n${run.stderr}`);
  check(`${label}: refused under PERMISSION_DENIED`, run.status === 2 && /Code: +PERMISSION_DENIED/.test(run.stderr), run);
  check(`${label}: names target space and recorded diagnosis`, /Space: +alpha/.test(run.stderr) && run.stderr.includes(diagnosis), run.stderr);
  check(`${label}: replacement mint provisions a new lifecycle`, /cotal auth mint <label>[^`]*--provision/.test(run.stderr) && /lifecycle UID.*mint reports/.test(run.stderr), run.stderr);
  check(`${label}: replacement keeps read, post and role grants`, run.stderr.includes("--allow-subscribe general --allow-publish general --role reviewer --no-persona"), run.stderr);
  check(`${label}: no raw broker stack`, !/at Object\.|Authorization Violation|Permissions Violation/.test(run.stderr), run.stderr);
  const control = cli(alpha, "send", "-c", "general", "control", "--space", "alpha", "--creds", credential.file, "--json", ...flags);
  check(`${label}: one-shot control already diagnoses the same rejection`, control.status === 2 && control.envelope?.error?.code === "PERMISSION_DENIED" && control.envelope.error.message?.includes(diagnosis) === true && control.envelope.target?.space === "alpha", control.envelope?.error);
  const command = /`cotal auth mint ([^`]+)`/.exec(run.stderr)?.[1];
  if (command) {
    const file = join(keys, `repair-${label}.creds`);
    const args = command.replace("<label>", `repair_${label.replaceAll("-", "_")}`).replace(/<new file>|<file>/, file).split(" ");
    const repair = ok(alpha, "auth", "mint", ...args, "--json");
    const uid = repair.envelope?.result?.lifecycleUid;
    assert.ok(uid, "the suggested mint must report a lifecycle UID");
    await valid({ file, uid });
  }
}
async function valid(credential: { file: string; uid: string }) {
  const proc = nodePty([entry, "join", "--space", "alpha", "--name", "alice", "--channel", "general", "--creds", credential.file, "--lifecycle-uid", credential.uid], { cwd: alpha, env, cols: 240 });
  terminals.add(proc);
  let out = "", code: number | undefined;
  proc.onData((chunk) => { out += chunk; });
  proc.onExit((result) => { code = result.exitCode; terminals.delete(proc); });
  await until(() => clean(out).includes("Joined alpha as alice on #general.") || code !== undefined);
  assert.ok(clean(out).includes("Joined alpha as alice on #general."), clean(out));
  proc.write("/quit\r");
  await until(() => code !== undefined);
  check("valid provisioned credential joins and quits successfully", code === 0, clean(out));
}
async function running(credential: { file: string; uid: string }) {
  const proc = spawn(process.execPath, [entry, "join", "--space", "alpha", "--creds", credential.file, "--lifecycle-uid", credential.uid, "--name", "live"], { cwd: alpha, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(proc);
  let out = "";
  proc.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  proc.stderr.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => { children.delete(proc); resolve(code); });
  });
  await until(() => out.includes("holding presence") || proc.exitCode !== null);
  assert.ok(out.includes("holding presence"), out);
  return { proc, exited, output: () => out };
}
const alphaServer = `nats://127.0.0.1:${await freePort()}`;
const betaServer = `nats://127.0.0.1:${await freePort()}`;
try {
  for (const [space, root] of [["alpha", alpha], ["beta", beta]] as const) {
    ok(home, "space", "create", space, "--root", root, "--json");
    anchors.set(root, recordSmokeSandbox({ root, cotalHome: cotal, xdgConfigHome: config }));
  }
  ok(beta, "up", "--no-manager", "--server", betaServer, "--json");
  const foreign = mint(beta, "beta", "foreign");
  ok(beta, "down", "--yes", "--json");
  ok(alpha, "up", "--no-manager", "--server", alphaServer, "--json");
  await rejected("cross-space", foreign, 'is a credential for space "beta", not "alpha"');
  await valid(mint(alpha, "alpha", "valid"));
  const revoked = mint(alpha, "alpha", "revoked");
  const live = await running(revoked);
  ok(alpha, "down", "--yes", "--json");
  ok(alpha, "auth", "revoke-credential", revoked.file, "--yes", "--json");
  ok(alpha, "up", "--no-manager", "--json");
  await rejected("revoked", revoked, "with auth revoke-credential");
  await until(() => live.proc.exitCode !== null);
  check("running join ends with its recorded revocation and provisioned recovery", await live.exited === 2 && /Space: +alpha/.test(live.output()) && live.output().includes("with auth revoke-credential") && /cotal auth mint <label>[^`]*--provision/.test(live.output()), live.output());
  const stale = mint(alpha, "alpha", "stale");
  ok(alpha, "down", "--yes", "--json");
  ok(alpha, "reset", "space", "alpha", "--yes", "--json");
  ok(alpha, "up", "--no-manager", "--json");
  await rejected("reset", stale, 'space "alpha" has a different local identity');
  await valid(mint(alpha, "alpha", "fresh"));
} finally {
  for (const terminal of terminals) terminal.kill();
  await until(() => terminals.size === 0);
  for (const child of children) await killAndAwaitExit(child);
  for (const root of [alpha, beta]) if (anchors.has(root)) ok(root, "down", "--yes", "--json");
  console.log(`Retained stopped credential-join sandbox: ${dir}`);
}
finish();

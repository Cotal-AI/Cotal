/** Shipped-entrypoint regression for rejected join credentials (#7534).
 * Uses isolated local stacks and real provisioned credentials. The broker rejects each file
 * before the shared diagnostic reads its space or local revocation record. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { clean, ptySpawn } from "./_console-pty.js";

const tree = resolve(import.meta.dirname, "../../..");
const binary = join(tree, "bin/dist/cotal.js");
// Kept on failure and success for diagnosis. Nothing under the host's real home is used.
const dir = mkdtempSync(join(tmpdir(), "join-creds-rejection-"));
const home = join(dir, "home"), config = join(dir, "config"), runtime = join(dir, "runtime"), scratch = join(dir, "tmp");
for (const path of [home, config, runtime, scratch, join(dir, "creds")]) mkdirSync(path, { mode: 0o700 });
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("COTAL_") && value !== undefined) env[key] = value;
Object.assign(env, { HOME: home, COTAL_HOME: join(dir, "cotal"), XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, TMPDIR: scratch, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" });
const anchors = new Map<string, SmokeSandboxAnchor>();
const stacks = new Set<string>();
let passed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
  passed++;
  console.log(`  ✓ ${name}`);
}
function cli(root: string, ...args: string[]) {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 90_000 };
  assertSmokeSandboxDown(anchors.get(root), args, options);
  const run = spawnSync(process.execPath, [binary, ...args], options);
  assert.ifError(run.error);
  assert.equal(run.signal, null, "CLI must exit normally");
  return { status: run.status, text: clean(`${run.stdout}${run.stderr}`), stdout: run.stdout };
}
function ok(root: string, ...args: string[]) {
  const result = cli(root, ...args);
  assert.equal(result.status, 0, result.text);
  return result;
}
async function prepare(space: string) {
  const root = join(dir, space);
  mkdirSync(root, { mode: 0o700 });
  ok(home, "space", "create", space, "--root", root, "--json");
  anchors.set(root, recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: config }));
  return { root, space, server: `nats://127.0.0.1:${await freePort()}` };
}
function up(target: Awaited<ReturnType<typeof prepare>>) {
  stacks.add(target.root);
  ok(target.root, "up", "--no-manager", "--server", target.server, "--json");
}
function down(root: string) {
  ok(root, "down", "--yes", "--json");
  stacks.delete(root);
}
function mint(target: Awaited<ReturnType<typeof prepare>>, label: string) {
  const path = join(dir, "creds", `${label}.creds`);
  const result = ok(target.root, "auth", "mint", label, "--space", target.space, "--provision", "--allow-subscribe", "general", "--allow-publish", "general", "--role", "reviewer", "--out", path, "--json");
  const data = JSON.parse(result.stdout) as { result: { lifecycleUid: string } };
  assert.equal(typeof data.result.lifecycleUid, "string");
  return { path, uid: data.result.lifecycleUid };
}
function rejected(target: Awaited<ReturnType<typeof prepare>>, credential: ReturnType<typeof mint>, reason: string, mintFlags: string) {
  const result = cli(target.root, "join", "--space", target.space, "--name", "alice", "--channel", "general", "--creds", credential.path, "--lifecycle-uid", credential.uid);
  check(`${reason}: join refuses under PERMISSION_DENIED with space and reason`, result.status === 2 && /Code: +PERMISSION_DENIED/.test(result.text) && result.text.includes(`Space:   ${target.space}`) && result.text.includes(reason), result);
  check(`${reason}: replacement provisions a fresh lifecycle`, result.text.includes(`cotal auth mint <label> --space ${target.space} --provision${mintFlags}`) && result.text.includes("join with the lifecycle UID that mint reports") && !result.text.includes("check your creds"), result);
  const control = cli(target.root, "send", "-c", "general", "control", "--space", target.space, "--creds", credential.path);
  check(`${reason}: send retains its diagnosis without a provisioning requirement`, control.status === 2 && control.text.includes(reason) && control.text.includes("cotal auth mint") && !control.text.includes("--provision"), control);
}
async function validJoin(target: Awaited<ReturnType<typeof prepare>>, credential: ReturnType<typeof mint>) {
  const proc = ptySpawn(process.execPath, [binary, "join", "--space", target.space, "--name", "alice", "--creds", credential.path, "--lifecycle-uid", credential.uid], { name: "xterm-256color", cols: 160, rows: 30, cwd: target.root, env });
  let output = "", quit = false;
  const exit = new Promise<number>((resolve) => proc.onExit(({ exitCode }) => resolve(exitCode)));
  const timer = setTimeout(() => proc.kill(), 30_000);
  proc.onData((data) => {
    output += clean(data);
    if (!quit && output.includes(`Joined ${target.space} as alice on #general.`)) {
      quit = true;
      proc.write("/quit\r");
    }
  });
  try {
    const code = await exit;
    check("fresh provisioned credential joins and quits cleanly", quit && code === 0, { code, output });
  } finally { clearTimeout(timer); }
}

try {
  const beta = await prepare("beta");
  up(beta);
  const foreign = mint(beta, "beta_agent");
  down(beta.root);
  const alpha = await prepare("alpha");
  up(alpha);
  rejected(alpha, foreign, 'is a credential for space "beta", not "alpha"', " --out <file>");
  await validJoin(alpha, mint(alpha, "valid"));
  const revoked = mint(alpha, "revoked");
  down(alpha.root);
  ok(alpha.root, "auth", "revoke-credential", revoked.path, "--yes", "--json");
  up(alpha);
  const grants = " --allow-subscribe general --allow-publish general --role reviewer --no-persona --out <new file>";
  rejected(alpha, revoked, "with auth revoke-credential", grants);
  const old = mint(alpha, "before_reset");
  down(alpha.root);
  ok(alpha.root, "reset", "space", "alpha", "--yes", "--json");
  up(alpha);
  rejected(alpha, old, 'space "alpha" has a different local identity', grants);
  // After identity rotation a new provisioned file still works against that same broker.
  await validJoin(alpha, mint(alpha, "after_reset"));
} finally {
  for (const root of [...stacks]) down(root);
}
console.log(`Evidence retained at ${dir}`);
emitSentinel({ passed, failed: 0 });

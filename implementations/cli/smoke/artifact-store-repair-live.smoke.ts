/** The artifact store binding survives a controller repair, through the real
 * CLI. A prepared root starts its controller-owned stack with `cotal up --serve artifacts` and no
 * binding. The test then writes the binding into the root's own secret store, where an issuer writes
 * the endpoint's material, kills the delivery member, and runs a bare `cotal up`: the stopped-member
 * repair, which rebuilds the delivery definition from its allowlist and restarts the member: the same
 * instance record at a new revision, in a new process. That attempt's lines in the instance log name
 * the store it took; the line can only come from it, because the binding did not exist before. A
 * binding nobody registered then makes the next repair fail at the child, by name, and nothing serves
 * `artifacts`.
 *
 * Uses a private home and root on an allocated loopback port, starts no agents (`--no-manager`), and
 * retains the sandbox and logs. Needs nats-server on PATH. Run: pnpm smoke:artifact-store-repair:live */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ARTIFACTS_ENDPOINT, CotalEndpoint, mintCreds, newIdentity } from "@cotal-ai/core";
import { ARTIFACT_STORE_BINDING_KIND, canonicalLocalProcessPath, daemonEndpointKey, DELIVERY_PIDFILE, getSpaceAuth, parsePid, workspaceSecretStore } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { foregroundCliProbe } from "./_foreground-cli-probe.js";

const EXPECTED = 6;
const wt = resolve(import.meta.dirname, "../../..");
const cliEntry = join(wt, "bin/cotal.ts");
const tsx = import.meta.resolve("tsx");
const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-store-repair-")));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COTAL_|CLAUDE_|ANTHROPIC_|OPENAI_|JCODE_)/i.test(k)));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let passed = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  assert.ok(ok, `${name}${detail === undefined ? "" : `\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`}`);
  passed++;
  console.log(`  ✓ ${name}`);
};

const home = join(base, "home"), root = join(base, "controller");
for (const p of [home, root, join(home, "xdg"), join(home, "runtime"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
const sandbox = recordSmokeSandbox({ root, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
const port = await freePort();
assert.notEqual(port, 4222);
const space = "store-repair";
const server = `nats://127.0.0.1:${port}`;
const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_RUNTIME_DIR: join(home, "runtime"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
process.env.COTAL_HOME = env.COTAL_HOME;
const logs: Record<string, { code: number | null; out: string; err: string }> = {};
const cli = async (name: string, args: string[], ms = 120_000) => (logs[name] = await foregroundCliProbe(cliEntry, tsx, root, env, args, ms));
const daemonPid = () => { try { return parsePid(readFileSync(canonicalLocalProcessPath(DELIVERY_PIDFILE, { root, space }), "utf8")); } catch { return undefined; } };
const bindingKey = daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_STORE_BINDING_KIND);

/** The delivery member's record, as `service --json` reports it: the stack keeps one. */
async function deliveryInstance(name: string): Promise<{ instanceId: string; revision: string; observedProcess: string } | undefined> {
  const r = await cli(name, ["service", "--space", space, "--json"], 30_000);
  try {
    const rows = ((JSON.parse(r.out) as { result?: { instances?: { definition: string; instanceId: string; revision: string; observedProcess: string }[] } }).result?.instances ?? [])
      .filter((row) => row.definition === "stack-delivery");
    return rows.length === 1 ? rows[0] : undefined;
  } catch { return undefined; }
}
/** One instance's own log, as `service logs --instance` reads it. */
async function instanceLog(name: string, instanceId: string): Promise<string> {
  const r = await cli(name, ["service", "logs", "stack-delivery", "--space", space, "--instance", instanceId, "--tail", "200"], 30_000);
  return `${r.out}\n${r.err}`;
}
/** Ask the running daemon what it serves, on a scoped evictor credential minted from the root's signer. */
async function serveState(): Promise<{ bound?: boolean }> {
  const auth = (await getSpaceAuth(workspaceSecretStore(root), space))!;
  const id = newIdentity();
  const ep = new CotalEndpoint({ space, servers: server, creds: await mintCreds(auth, id, "endpoint-evictor", { expiresInSeconds: 120 }),
    card: { id: id.id, name: "store-repair-probe", kind: "endpoint" }, channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false });
  ep.on("error", () => {});
  try {
    await ep.start();
    const r = await ep.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000);
    return r.ok ? r.data as { bound?: boolean } : {};
  } catch { return {}; } finally { await ep.stop().catch(() => {}); }
}
/** Kill the running delivery member and wait until its process is gone. */
async function killDelivery(): Promise<number> {
  const pid = daemonPid();
  assert.ok(pid !== undefined && alive(pid), "a running delivery member to kill");
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 100 && alive(pid); i++) await wait(50);
  return pid;
}

console.log(`store-repair retained evidence: ${base}`);
let started = false;
try {
  const prepared = await cli("prepared", ["space", "create", space, "--root", root], 60_000);
  assert.equal(prepared.code, 0, prepared.err);
  const up = await cli("up", ["up", "--detach", "--no-manager", "--server", server, "--space", space, "--serve", "artifacts"], 180_000);
  started = true;
  const first = await deliveryInstance("list-first");
  const firstPid = daemonPid();
  const firstLog = first ? await instanceLog("log-first", first.instanceId) : "";
  check("the controller-owned stack starts with no binding, and its delivery member logs the default store",
    up.code === 0 && first !== undefined && firstPid !== undefined && /artifacts: artifact store "jetstream" \(no binding: the default\)/.test(firstLog)
      && !/bound for this space/.test(firstLog), { err: up.err.slice(-800), first });

  // ---- a binding written into the root's store survives the stopped-member repair ----
  await workspaceSecretStore(root).put(bindingKey, "jetstream");
  await killDelivery();
  const repaired = await cli("repair", ["up", "--detach", "--no-manager", "--server", server, "--space", space], 180_000);
  const second = await deliveryInstance("list-second");
  const secondPid = daemonPid();
  const secondLog = second ? await instanceLog("log-second", second.instanceId) : "";
  check("a bare cotal up after the member died restarts it: a new process, and the record at a new revision",
    repaired.code === 0 && second !== undefined && second.observedProcess === "running" && second.revision !== first!.revision
      && secondPid !== undefined && secondPid !== firstPid && alive(secondPid), { err: repaired.err.slice(-800), first, second, firstPid, secondPid });
  check("the new instance's own log names the bound store, read from the root's store across the definition rebuild",
    /artifacts: artifact store "jetstream" \(bound for this space\)/.test(secondLog), secondLog.split("\n").filter((l) => l.includes("artifact store")));
  check("the repaired member binds artifacts", (await serveState()).bound === true);

  // ---- a binding nobody registered fails the next repair at the child ----
  await workspaceSecretStore(root).put(bindingKey, "nowhere");
  await killDelivery();
  const refused = await cli("refused", ["up", "--detach", "--no-manager", "--server", server, "--space", space], 180_000);
  const third = await deliveryInstance("list-third");
  const thirdLog = third ? await instanceLog("log-third", third.instanceId) : "";
  check("with an unregistered binding the repair fails, and the new instance's log names the store",
    refused.code !== 0 && third !== undefined && third.revision !== second!.revision && third.observedProcess !== "running"
      && /no artifact store "nowhere" is registered; nothing was started/.test(thirdLog),
    { code: refused.code, err: refused.err.slice(-800), third, log: thirdLog.split("\n").filter((l) => l.includes("artifact")) });
  check("nothing serves artifacts after that refusal", (await serveState()).bound !== true);
} finally {
  try {
    if (started) {
      await workspaceSecretStore(root).delete(bindingKey).catch(() => {});
      assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: root, env });
      logs.down = await foregroundCliProbe(cliEntry, tsx, root, env, ["down", "--yes"], 60_000);
    }
  } finally {
    for (const [name, log] of Object.entries(logs)) writeFileSync(join(base, `${name}.json`), JSON.stringify(log), { mode: 0o600 });
  }
}
if (passed !== EXPECTED) throw new Error(`expected ${EXPECTED} cells, ran ${passed}`);
console.log(`artifact-store-repair: ${passed} passed, 0 failed`);
emitSentinel({ cells: passed, passed, failed: 0 });

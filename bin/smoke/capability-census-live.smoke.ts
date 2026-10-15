/**
 * Capability census, execution half: a mapped command, run as the real `cotal` binary against a
 * real broker and manager, issues the native requests its owner rows say it does.
 *
 * The offline half can only check that an owner names a registered command and flag. Here the
 * command runs, an observer on the same broker records every endpoint request it publishes, and
 * the requests are compared with the owner map. The self-test replays the same observation against
 * a map whose row names another command, which must fail. Each CLI redesign change adds the cases
 * for the commands it ships.
 *
 * A REAL broker in open mode and a REAL Manager in this process; COTAL_HOME and XDG_CONFIG_HOME are
 * sandboxed. Needs nats-server on PATH. Kills only the processes it starts.
 *
 * Run: pnpm smoke:capability-census:live
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, createSuite, freePort, recordSmokeSandbox, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { executionProblems, observeRequests } from "./census/execute.js";
import { readOwnerMap } from "./census/owners.js";

const home = mkdtempSync(join(tmpdir(), "cotal-census-home-"));
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}census-root-`));
const xdg = join(home, "xdg");
mkdirSync(join(root, ".cotal"), { recursive: true });
recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = xdg;
const { probeConnect } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const { Manager } = await import("@cotal-ai/manager");

const SPACE = "census";
const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const TSX = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");
const BIN = join(import.meta.dirname, "..", "cotal.ts");
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { COTAL_HOME: home, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run the real binary without blocking this process, which hosts the manager that must answer. */
function cotal(...args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProc(TSX, [BIN, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`cotal ${args.join(" ")} timed out`)); }, 60_000);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("exit", (status) => { clearTimeout(timer); resolve({ status, output }); });
  });
}

const { check, finish } = createSuite();
const map = readOwnerMap();
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}census-js-`));
const broker: ChildProcess = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", store], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
let mgr: InstanceType<typeof Manager> | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  let serving = false;
  for (let i = 0; i < 50 && !serving; i++) {
    serving = (await probeConnect(SERVER, { timeoutMs: 400 })).ok;
    if (!serving) await sleep(100);
  }
  if (!serving) throw new Error(`broker never served at ${SERVER}`);
  recordMesh({ space: SPACE, server: SERVER, root, mode: "open", ts: new Date().toISOString() });
  mgr = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root });
  await mgr.start();
  nc = await connect({ servers: SERVER });

  let ps: { status: number | null; output: string } | undefined;
  const observed = await observeRequests(nc, SPACE, async () => { ps = await cotal("ps", "--space", SPACE); });
  check("cotal ps exits 0 against the live manager", ps?.status === 0, ps?.output);
  check("the observer saw cotal ps issue manager ps", observed.some((r) => r.endpoint === "manager" && r.command === "ps"), observed);
  const problems = executionProblems({ command: "ps", flags: [] }, observed, map);
  check("every request cotal ps issued matches its owner rows", problems.length === 0, problems);

  const wrong = { ...map, owners: { ...map.owners, "ep:manager:ps": "current:models" } };
  check("a row that names another command for manager ps fails on the same observation",
    executionProblems({ command: "ps", flags: [] }, observed, wrong).includes("cotal ps issued manager ps, whose owner is current:models"));
} catch (e) {
  check(`suite ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  await nc?.close().catch(() => {});
  await Promise.race([mgr?.stop({ withAgents: true }).catch(() => {}) ?? Promise.resolve(), sleep(10_000)]);
  broker.kill("SIGKILL");
  release();
  finish();
  process.exit(process.exitCode ?? 0);
}

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
import { executionProblems, invocationOf, observeRequests, type ObservedRequest } from "./census/execute.js";
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
// tsx's own loader, by file URL, so the child resolves it from any working directory on any platform.
const TSX_LOADER = import.meta.resolve("tsx");
const BIN = join(import.meta.dirname, "..", "cotal.ts");
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { COTAL_HOME: home, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run the real binary without blocking this process, which hosts the manager that must answer. */
function cotal(...args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProc(process.execPath, ["--import", TSX_LOADER, BIN, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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

  // Each case is an argv the census maps, plus the endpoint commands it issues only as resolution.
  // The census grades what a command issues, so a native refusal (an open manager has no static
  // slots, and no connector is installed here) is still a complete observation.
  const cases: { argv: string[]; steps?: string[] }[] = [
    { argv: ["ps"] },
    { argv: ["ps", "--slots"] },
    { argv: ["models", "--agent", "claude", "--refresh"] },
    { argv: ["spawn", "scout", "--detach", "--agent", "claude", "--opt", "effort=high"] },
  ];
  const observations = new Map<string, ObservedRequest[]>();
  const statuses = new Map<string, number | null | undefined>();
  for (const { argv, steps } of cases) {
    let result: { status: number | null; output: string } | undefined;
    const observed = await observeRequests(nc, SPACE, async () => { result = await cotal(...argv, "--space", SPACE); });
    const label = `cotal ${argv.join(" ")}`;
    observations.set(argv.join(" "), observed);
    statuses.set(argv.join(" "), result?.status);
    check(`${label} issued a manager command`, observed.some((r) => r.endpoint === "manager" && r.command !== "describe"), { observed, output: result?.output });
    const problems = executionProblems(invocationOf(argv, map), observed, map, steps);
    check(`every request ${label} issued matches its owner rows`, problems.length === 0, problems);
  }
  check("cotal ps against the live manager exits 0", statuses.get("ps") === 0, statuses.get("ps"));
  const models = observations.get("models --agent claude --refresh") ?? [];
  check("the models case compared the input fields it sent",
    models.some((r) => r.command === "models" && r.fields.includes("agent") && r.fields.includes("refresh")), models);
  const psObserved = observations.get("ps") ?? [];
  const spawned = observations.get("spawn scout --detach --agent claude --opt effort=high") ?? [];
  check("the spawn case sent a key under its options map",
    spawned.some((r) => r.command === "spawn" && r.fields.includes("launchOptions.effort")), spawned);
  check("an undeclared key under a field whose contract lists its properties still fails",
    executionProblems(invocationOf(["spawn", "scout", "--detach"], map), [{ endpoint: "manager", command: "spawn", fields: ["supervise.bogus"] }], map)
      .includes("cotal spawn --detach sent manager spawn field supervise.bogus, whose owner is missing"));

  const wrongField = { ...map, owners: { ...map.owners, "ep:manager:models.agent": "current:ps" } };
  check("a field row that names another command fails on the models observation",
    executionProblems(invocationOf(["models", "--agent", "claude", "--refresh"], map), models, wrongField)
      .includes("cotal models --agent --refresh sent manager models field agent, whose owner is current:ps"));
  const wrong = { ...map, owners: { ...map.owners, "ep:manager:ps": "current:models" } };
  check("a row that names another command for manager ps fails on the same observation",
    executionProblems(invocationOf(["ps"], map), psObserved, wrong).includes("cotal ps issued manager ps, whose owner is current:models"));
  check("a models run that issued nothing fails on the row it should have issued",
    executionProblems(invocationOf(["models", "--agent", "claude", "--refresh"], map), [], map)
      .includes("ep:manager:models is owned by current:models but cotal models --agent --refresh did not issue it"));
  check("positional values after a mode are not mode words", invocationOf(["send", "dm", "alice", "hi"], map).words.join(" ") === "dm");
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

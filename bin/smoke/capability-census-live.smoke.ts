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
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { executionProblems, invocationOf, observeRequests, type Expectation, type ObservedRequest } from "./census/execute.js";
import { readOwnerMap } from "./census/owners.js";

const home = mkdtempSync(join(tmpdir(), "cotal-census-home-"));
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}census-root-`));
const xdg = join(home, "xdg");
mkdirSync(join(root, ".cotal"), { recursive: true });
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
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
    assertSmokeSandboxDown(anchor, args, { cwd: root, env });
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

  // Each case is an argv the census maps and the endpoint commands it issues. The census grades
  // what a command issues, so a native refusal (an open manager has no static slots, and no
  // connector is installed here) is still a complete observation.
  const cases: { argv: string[]; expect: Expectation }[] = [
    { argv: ["ps"], expect: { issues: ["ep:manager:ps"] } },
    { argv: ["ps", "--slots"], expect: { issues: ["ep:manager:slots"] } },
    { argv: ["models", "--harness", "claude", "--refresh"], expect: { issues: ["ep:manager:models"] } },
    { argv: ["spawn", "scout", "--detach", "--agent", "claude", "--opt", "effort=high"], expect: { issues: ["ep:manager:spawn"] } },
  ];
  const observations = new Map<string, ObservedRequest[]>();
  const statuses = new Map<string, number | null | undefined>();
  for (const { argv, expect } of cases) {
    let result: { status: number | null; output: string } | undefined;
    const observed = await observeRequests(nc, SPACE, async () => { result = await cotal(...argv, "--space", SPACE); });
    const label = `cotal ${argv.join(" ")}`;
    observations.set(argv.join(" "), observed);
    statuses.set(argv.join(" "), result?.status);
    check(`${label} issued a manager command`, observed.some((r) => r.endpoint === "manager" && r.command !== "describe"), { observed, output: result?.output });
    const problems = executionProblems(invocationOf(argv, map), observed, map, expect);
    check(`every request ${label} issued matches its owner rows and its case`, problems.length === 0, problems);
  }
  // The kernel's own commands answer from local metadata, so against a live mesh they issue nothing.
  for (const argv of [["help"], ["help", "--all"], ["version"], ["version", "--json"]]) {
    let result: { status: number | null; output: string } | undefined;
    const observed = await observeRequests(nc, SPACE, async () => { result = await cotal(...argv); });
    const label = `cotal ${argv.join(" ")}`;
    check(`${label} exits 0 and issues no endpoint request`, result?.status === 0 && observed.length === 0, { observed, output: result?.output.slice(0, 300) });
    const problems = executionProblems(invocationOf(argv, map), observed, map, { issues: [] });
    check(`every request ${label} issued matches its owner rows and its case`, problems.length === 0, problems);
  }
  check("cotal ps against the live manager exits 0", statuses.get("ps") === 0, statuses.get("ps"));
  const models = observations.get("models --harness claude --refresh") ?? [];
  check("the models case compared the input fields it sent",
    models.some((r) => r.command === "models" && r.fields.includes("agent") && r.fields.includes("refresh")), models);
  const psObserved = observations.get("ps") ?? [];
  const spawned = observations.get("spawn scout --detach --agent claude --opt effort=high") ?? [];
  check("the spawn case sent a key under its options map",
    spawned.some((r) => r.command === "spawn" && r.fields.includes("launchOptions.effort")), spawned);

  // Self-tests: fixed observations against the real map, or against a map with one row changed.
  const req = (command: string, fields: string[] = [], endpoint = "manager"): ObservedRequest => ({ endpoint, command, fields });
  const problemsOf = (argv: string[], observed: ObservedRequest[], issues: string[], against = map) =>
    executionProblems(invocationOf(argv, against), observed, against, { issues });
  const passes = (name: string, argv: string[], observed: ObservedRequest[], issues: string[]) => {
    const problems = problemsOf(argv, observed, issues);
    check(name, problems.length === 0, problems);
  };
  const reports = (name: string, problems: string[], expected: string) => check(name, problems.includes(expected), problems);
  reports("an undeclared key under a field whose contract lists its properties still fails",
    problemsOf(["spawn", "scout", "--detach"], [req("spawn", ["supervise.bogus"])], ["ep:manager:spawn"]),
    "cotal spawn --detach sent manager spawn field supervise.bogus, whose owner is missing");
  reports("a field row that names another command fails on the models observation",
    problemsOf(["models", "--harness", "claude", "--refresh"], models, ["ep:manager:models"], { ...map, owners: { ...map.owners, "ep:manager:models.agent": "current:ps" } }),
    "cotal models --harness --refresh sent manager models field agent, whose owner is current:ps");
  reports("a row that names another command for manager ps fails on the same observation",
    problemsOf(["ps"], psObserved, [], { ...map, owners: { ...map.owners, "ep:manager:ps": "current:models" } }),
    "cotal ps issued manager ps, whose owner is current:models");
  reports("a models run that issued nothing fails on the row its case expects",
    problemsOf(["models", "--harness", "claude", "--refresh"], [], ["ep:manager:models"]),
    "cotal models --harness --refresh did not issue ep:manager:models");
  reports("a command the case does not expect fails",
    problemsOf(["down", "--preserve-state"], [req("prepare-preservation"), req("abort-preservation")], ["ep:manager:prepare-preservation"]),
    "cotal down --preserve-state issued ep:manager:abort-preservation, which its case does not expect");
  reports("a case cannot expect a row whose owner needs a flag the run does not pass",
    problemsOf(["ps"], [req("slots")], ["ep:manager:slots"]),
    "cotal ps expects ep:manager:slots, whose owner is current:ps --slots");
  reports("a case cannot expect a row another mode owns",
    problemsOf(["run", "show", "r"], [req("run-start")], ["ep:manager:run-start"]),
    "cotal run show expects ep:manager:run-start, whose owner is current:run start");
  reports("a case cannot expect a row another command owns",
    problemsOf(["ps"], [req("models")], ["ep:manager:models"]),
    "cotal ps expects ep:manager:models, whose owner is current:models");
  passes("an invoke that issued the endpoint command its arguments name passes",
    ["invoke", "linear", "inventory"], [req("inventory", [], "linear")], ["ep:linear:inventory"]);
  passes("a preserving down that succeeded without its abort step passes",
    ["down", "--preserve-state"], [req("prepare-preservation"), req("commit-preservation")], ["ep:manager:prepare-preservation", "ep:manager:commit-preservation"]);
  passes("an amend that issued the row it shares with answer passes",
    ["run", "amend", "r", "s", "--value", "x"], [req("run-answer", ["amend", "runId", "stepKey", "value"])], ["ep:manager:run-answer"]);
  passes("a local start that drove a turn passes",
    ["run", "start", "--local", "--file", "p"], [req("turn")], ["ep:manager:turn"]);
  passes("a local start whose program relays nothing passes",
    ["run", "start", "--local", "--file", "p"], [], []);
  const stepped = executionProblems(invocationOf(["ps"], map), [req("models"), req("ps")], map, { issues: ["ep:manager:ps"], steps: ["ep:manager:models"] });
  check("a resolution step the case declares is neither expected nor graded", stepped.length === 0, stepped);
  passes("a local read, which issues no endpoint command, passes",
    ["run", "--local"], [], []);
  passes("a detached resume that names its agent passes on spawn and the transcript it receives",
    ["spawn", "scout", "--detach", "--resume", "sid", "--agent", "claude", "--on", "inst"],
    [req("transcript-receive"), req("spawn")], ["ep:manager:transcript-receive", "ep:manager:spawn"]);
  reports("a detached resume observed resolving its agent without spawning fails",
    problemsOf(["spawn", "scout", "--detach", "--resume", "sid"], [req("resolve-agent")], ["ep:manager:resolve-agent", "ep:manager:spawn"]),
    "cotal spawn --detach --resume did not issue ep:manager:spawn");
  let refused = "";
  try { invocationOf(["spawn", "-f", "cotal.yaml"], map); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
  check("a case written with a short flag is refused", refused.includes("write -f in its long form"), refused);
  check("positional values after a mode are not mode words", invocationOf(["run", "answer", "r", "s"], map).words.join(" ") === "answer");
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

/**
 * `cotal down web` from any directory — a target-addressed component (`rootedAt: "target"`) is
 * stopped under the SAME mesh root its start side resolved (registry current mesh first,
 * `--space` to name one), not the cwd's `.cotal`. Regression for the start/stop asymmetry where
 * `cotal web` (target-resolved) claimed `<mesh-root>/.cotal/web.pid` but `cotal down web` only
 * looked under the folder it ran in and reported "Nothing running for web".
 *
 * Hermetic (no broker): COTAL_HOME and the temp root are sandboxed, meshes are recorded straight
 * into the registry, and the dashboard is a real SIGTERM-able child whose pid sits in the mesh
 * root's web.pid. The same public `down()` surface also proves both no-token manager policy branches
 * and the pinned-mismatch refusal. This existing CI-selected suite remains the integration owner.
 * Run: pnpm smoke:down-target
 */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeScratch } from "../../../bin/smoke/_scratch.js";
import {
  canonicalLocalProcessPath,
  defaultStartToken,
  MANAGER_PIDFILE,
  probeLiveness,
  type LocalProcess,
  writeIdentityPin,
} from "@cotal-ai/workspace";

// Isolate BOTH the machine-home AND the temp root. `findCotalRoot` walks to `/` with no boundary,
// so a `.cotal` above the temp base (observed: `/tmp/.cotal` on CI; a home-dir `.cotal` when the
// scratch sat under the monorepo) captures every "neutral" dir.
const scratch = makeScratch();
// SETUP TRANSACTION covering the WHOLE post-scratch window: the home mkdtemp and every dynamic
// import. An import failure here used to exit with the scratch on disk just as a failed mkdtemp did.
const cleanScratch = (e: unknown): never => {
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`fixture setup failed (scratch removed): ${(e as Error).message}`, { cause: e });
};
let home!: string;
let registry!: typeof import("@cotal-ai/core").registry;
let cacheLocalProcess!: typeof import("@cotal-ai/workspace").cacheLocalProcess;
let extensionLocalProcesses!: typeof import("@cotal-ai/workspace").extensionLocalProcesses;
let findCotalRoot!: typeof import("@cotal-ai/workspace").findCotalRoot;
let recordMesh!: typeof import("@cotal-ai/workspace").recordMesh;
let setCurrent!: typeof import("@cotal-ai/workspace").setCurrent;
let down!: typeof import("../src/commands/down.js").down;
let stopLocalProcess!: typeof import("../src/commands/down.js").stopLocalProcess;
let webProcess!: typeof import("../../web/src/web.js").webProcess;
try {
  home = mkdtempSync(join(scratch, "home-"));
  process.env.COTAL_HOME = home;
  ({ registry } = await import("@cotal-ai/core"));
  ({ cacheLocalProcess, extensionLocalProcesses, findCotalRoot, recordMesh, setCurrent } = await import("@cotal-ai/workspace"));
  ({ down, stopLocalProcess } = await import("../src/commands/down.js"));
  ({ webProcess } = await import("../../web/src/web.js"));
} catch (e) { cleanScratch(e); }

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// Only ESRCH proves death. The previous two-state form mapped ANY other errno - EPERM, EIO,
// unknown - to "dead", which let cleanup skip a live child and then delete its pid evidence.
const alive = (pid: number): boolean => probeLiveness(pid) !== "dead";

// OWNERSHIP IS PUBLISHED AT THE SPAWN, not by a `return` that may never happen. Every child goes in
// here the instant it exists, so a throw between the spawn and the return still leaves `finally` a
// reference to something alive. The caller cannot own a resource whose creating function threw
// before returning; only the spawner can.
const spawnedChildren: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A registered mesh root with a live "dashboard" child recorded in its web.pid. */
function meshWithDashboard(label: string): { root: string; child: ChildProcess; pidPath: string } {
  const root = mkdtempSync(join(tmpdir(), `cotal-${label}-`));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000);"], { detached: true, stdio: "ignore" });
  spawnedChildren.push(child);   // <- before ANY fallible work below
  child.unref();
  // TRANSACTIONAL FROM THE SPAWN, because ownership cannot be published by a `return` that never
  // happens. Moving the call inside the caller's `try` was not enough: a throw between the spawn and
  // the return — the pidfile write — leaves the assignment undefined, so the caller's `finally` has
  // no record to clean and the child survives with PPID 1. Measured exactly that way: PID alive,
  // reparented, and its pid evidence gone.
  const pidPath = join(root, ".cotal", "web.pid");
  writeFileSync(pidPath, String(child.pid), { mode: 0o600 });
  // #969: the real `cotal web` pins its pidfile to the process start; the planted record must
  // match that shape or the identity gate correctly refuses it as a legacy record.
  writeFileSync(`${pidPath}.identity`, `${child.pid} ${defaultStartToken(child.pid ?? 0)}`, { mode: 0o600 });
  return { root, child, pidPath };
}

const run = (positionals: string[], values: Record<string, string | boolean> = {}) =>
  down({ values, positionals, raw: [] });

type LegacyManagerStop = {
  managerAlive: boolean;
  agentAlive: boolean;
  pidfilePreserved: boolean;
  pinPreserved?: boolean;
  managerDecision?: string;
  warning: string;
  output: string;
};

/** Drive the public bare-down manager branch with a live planted process record. */
async function stopPlantedManager(
  withAgents: boolean,
  pin: "legacy" | "mismatch",
  handler: "intent-aware" | "historical-destructive" = "intent-aware",
): Promise<LegacyManagerStop> {
  const root = mkdtempSync(join(tmpdir(), `cotal-${pin}-manager-${withAgents ? "reap" : "spare"}-`));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  const agent = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{}, 1000);"],
    { stdio: "ignore" },
  );
  spawnedChildren.push(agent);
  assert.ok(agent.pid, "legacy manager fixture must have an agent pid");
  const managerProgram = [
    "import {writeFileSync} from 'node:fs';",
    "let stopping=false;",
    "process.on('SIGTERM',async()=>{",
    " if(stopping)return; stopping=true;",
    " try {",
    "  if(process.env.HISTORICAL_DESTRUCTIVE==='1'){process.kill(Number(process.env.AGENT_PID),'SIGTERM');setTimeout(()=>process.exit(0),100);return;}",
    "  const {consumeManagerShutdownIntent}=await import(process.env.WORKSPACE_ENTRY);",
    "  const decision=consumeManagerShutdownIntent({root:process.env.FIXTURE_ROOT,space:'main'});",
    "  writeFileSync(process.env.DECISION_PATH,JSON.stringify(decision));",
    "  if(decision.withAgents)process.kill(Number(process.env.AGENT_PID),'SIGTERM');",
    "  setTimeout(()=>process.exit(0),100);",
    " } catch(error) { writeFileSync(process.env.DECISION_PATH,String(error?.stack??error)); process.exit(2); }",
    "});",
    "setInterval(()=>{},1000);",
  ].join("");
  const decisionPath = join(root, "manager-decision.json");
  const workspaceEntry = new URL("../../../packages/workspace/dist/index.js", import.meta.url).href;
  const managerEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    FIXTURE_ROOT: root,
    AGENT_PID: String(agent.pid),
    DECISION_PATH: decisionPath,
    WORKSPACE_ENTRY: workspaceEntry,
    HISTORICAL_DESTRUCTIVE: handler === "historical-destructive" ? "1" : "0",
  };
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", managerProgram, "supervise"],
    { cwd: prevCwd, env: managerEnv, stdio: "ignore" },
  );
  spawnedChildren.push(child);
  assert.ok(child.pid, "legacy manager fixture must have a manager pid");
  const context = { root, space: "main" };
  const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, context);
  writeFileSync(pidPath, String(child.pid), { mode: 0o600 });
  const pinPath = `${pidPath}.identity`;
  if (pin === "mismatch") writeFileSync(pinPath, `${child.pid} 1`, { mode: 0o600 });
  else writeIdentityPin(pidPath, child.pid, () => undefined); // Windows/ps-less host: honest no-pin shape

  let warning = "";
  let output = "";
  const originalError = console.error;
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  const cwd = process.cwd();
  try {
    process.exitCode = undefined;
    process.chdir(root);
    console.error = (...args: unknown[]) => { warning += `${args.join(" ")}\n`; };
    console.log = (...args: unknown[]) => { output += `${args.join(" ")}\n`; };
    await sleep(100); // the child must install its SIGTERM handler before down can signal it
    try { await run([], withAgents ? { "with-agents": true } : {}); }
    catch (error) { warning += `${(error as Error).message}\n`; }
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.chdir(cwd);
  }

  for (let i = 0; i < 100 && alive(child.pid); i++) await sleep(20);
  if (withAgents || handler === "historical-destructive")
    for (let i = 0; i < 100 && alive(agent.pid); i++) await sleep(20);

  const result = {
    managerAlive: alive(child.pid),
    agentAlive: alive(agent.pid),
    pidfilePreserved: existsSync(pidPath),
    pinPreserved: pin === "mismatch" ? existsSync(pinPath) : undefined,
    managerDecision: existsSync(decisionPath) ? readFileSync(decisionPath, "utf8") : undefined,
    warning,
    output,
  };
  process.exitCode = originalExitCode;
  if (result.managerAlive) {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* raced to exit */ }
    for (let i = 0; i < 100 && alive(child.pid); i++) await sleep(20);
  }
  if (alive(agent.pid)) {
    try { process.kill(agent.pid, "SIGKILL"); } catch { /* raced to exit */ }
    for (let i = 0; i < 100 && alive(agent.pid); i++) await sleep(20);
  }
  for (const ownedChild of [child, agent]) {
    if (ownedChild.pid && !alive(ownedChild.pid)) {
      const owned = spawnedChildren.indexOf(ownedChild);
      if (owned !== -1) spawnedChildren.splice(owned, 1);
    }
  }
  rmSync(root, { recursive: true, force: true });
  return result;
}

const entry = (space: string, root: string) =>
  ({ space, server: "nats://127.0.0.1:4222", root, mode: "open" as const, ts: "2026-07-27T00:00:00.000Z" });

const prevCwd = process.cwd();
// Declared here, CREATED inside the try. Spawning detached children before the try meant a throw in
// between — the second mkdtemp, the neutral dir, the second mesh — exited with them still running
// and no `finally` to reach them. An exit-time scratch sweep is NOT a fix for that: it deletes
// `.cotal/web.pid`, which is the only thing that could have identified the orphan, turning a
// recoverable leak into an anonymous one. Cleanup has to own the children, not just their directory.
let neutral: string | undefined;
let meshA: { root: string; child: ChildProcess; pidPath: string } | undefined;
let meshB: { root: string; child: ChildProcess; pidPath: string } | undefined;

try {
  neutral = mkdtempSync(join(tmpdir(), "cotal-neutral-")); // no .cotal up-tree (enforced by scratch)
  meshA = meshWithDashboard("meshA");
  meshB = meshWithDashboard("meshB");
  check("scratch has no .cotal ancestor", findCotalRoot(neutral) === neutral, findCotalRoot(neutral));

  // The real web descriptor must declare target rooting, and down must see it on the surface.
  check('web descriptor declares rootedAt: "target"', webProcess.rootedAt === "target");
  // The installed path never imports package code: the descriptor rides the extensions manifest as
  // JSON. The cache must carry rootedAt through a full serialize/parse round trip.
  const cached = extensionLocalProcesses({
    pkg: "@cotal-ai/web", version: "0.0.0", spec: "@cotal-ai/web", commands: [],
    ...JSON.parse(JSON.stringify({ localProcesses: [cacheLocalProcess(webProcess)] })),
  });
  check("manifest cache round-trips rootedAt", cached.length === 1 && cached[0].rootedAt === "target");
  registry.register(webProcess);
  const managerProcess: LocalProcess = { kind: "local-process", name: "manager", label: "manager", pidFile: MANAGER_PIDFILE, order: 10 };
  registry.register(managerProcess);
  const fixtured: LocalProcess = { kind: "local-process", name: "fixtured", label: "fixture daemon", pidFile: "fixture.pid" };
  registry.register(fixtured);

  process.chdir(neutral);

  // No meshes recorded anywhere → a target-addressed stop fails loud, it does not probe the cwd.
  await assert.rejects(run(["web"]), /no mesh running/);
  check("no meshes: `down web` fails loud with 'no mesh running'", true);

  // Current mesh set → `down web` from an unrelated directory stops THAT mesh's dashboard.
  recordMesh(entry("teamA", meshA.root));
  recordMesh(entry("teamB", meshB.root));
  setCurrent("teamA");
  await run(["web"]);
  for (let i = 0; i < 100 && alive(meshA.child.pid!); i++) await sleep(50);
  check("current mesh: `down web` from elsewhere stops the dashboard", !alive(meshA.child.pid!));
  check("current mesh: the mesh root's web.pid is removed", !existsSync(meshA.pidPath));
  check("current mesh: the OTHER mesh's dashboard is untouched", alive(meshB.child.pid!));

  // `--space` names the mesh explicitly, exactly like `cotal web --space`.
  await run(["web"], { space: "teamB" });
  for (let i = 0; i < 100 && alive(meshB.child.pid!); i++) await sleep(50);
  check("--space: `down web --space teamB` stops that mesh's dashboard", !alive(meshB.child.pid!));
  check("--space: teamB's web.pid is removed", !existsSync(meshB.pidPath));

  // Guardrails: --space never applies to folder-rooted components or bare `down`.
  await assert.rejects(run(["fixtured"], { space: "teamA" }), /--space only applies to target-addressed components/);
  check("--space with a folder-rooted component is refused", true);
  await assert.rejects(run([], { space: "teamA" }), /bare `cotal down` always stops this folder's stack/);
  check("--space without components is refused", true);
  await assert.rejects(run(["web"], { space: "nosuch" }), /no mesh named/);
  check("--space with an unknown mesh fails loud", true);

  await assert.rejects(
    run([], { "preserve-state": true, "with-agents": true }),
    /--preserve-state cannot be combined with --with-agents/,
  );
  check("--preserve-state with --with-agents is refused", true);
  await assert.rejects(run(["web"], { "with-agents": true }), /--with-agents is bare-whole-stack only/);
  check("--with-agents with a component is refused", true);
  await assert.rejects(run([], { "with-agents": true, file: "cotal.yaml" }), /--with-agents is bare-whole-stack only/);
  check("--with-agents with --file is refused", true);
  await assert.rejects(run([], { "with-agents": true, run: "abc" }), /--with-agents is bare-whole-stack only/);
  check("--with-agents with --run is refused", true);
  await assert.rejects(run([], { "with-agents": true, space: "teamA" }), /--with-agents is bare-whole-stack only/);
  check("--with-agents with --space is refused", true);

  // Pre-pin managers remain common on upgraded operator boxes. The shared identity seam already
  // emits its reduced-guarantee warning. Both policy branches must still reach SIGTERM and remove
  // the proven-dead pidfile: bare down warns that sparing cannot be verified, while --with-agents
  // does not require an impossible identity-bound intent from a manager launched before pinning.
  const legacyBare = await stopPlantedManager(false, "legacy");
  const legacyWithAgents = await stopPlantedManager(true, "legacy");
  const historicalBare = await stopPlantedManager(false, "legacy", "historical-destructive");
  check(
    "a legacy unpinned manager reaches SIGTERM on bare down and its pidfile is removed",
    !legacyBare.managerAlive && legacyBare.agentAlive && !legacyBare.pidfilePreserved &&
      /predates process identity pinning/.test(legacyBare.warning) &&
      /could not verify that this legacy manager can spare/.test(legacyBare.warning),
    legacyBare,
  );
  check(
    "a legacy unpinned manager reaches SIGTERM on --with-agents and its pidfile is removed",
    !legacyWithAgents.managerAlive && !legacyWithAgents.agentAlive && !legacyWithAgents.pidfilePreserved &&
      /predates process identity pinning/.test(legacyWithAgents.warning) &&
      /"withAgents":true/.test(legacyWithAgents.managerDecision ?? "") &&
      !/manager version could not be verified/.test(legacyWithAgents.output),
    legacyWithAgents,
  );
  check(
    "bare down never reports a historical destructive manager's reaped agent as spared",
    !historicalBare.managerAlive && !historicalBare.agentAlive && !historicalBare.pidfilePreserved &&
      /manager version could not be verified; an older destructive SIGTERM handler may have reaped managed agents/.test(historicalBare.output) &&
      !/left \d+ managed agents? running/.test(historicalBare.output) &&
      !/agents will still be spared/.test(`${historicalBare.warning}\n${historicalBare.output}`),
    historicalBare,
  );
  const mismatched = await stopPlantedManager(false, "mismatch");
  check(
    "a pinned manager identity mismatch is refused before SIGTERM and preserves both records",
    mismatched.managerAlive && mismatched.agentAlive && mismatched.pidfilePreserved && mismatched.pinPreserved === true &&
      /pid has been reused/.test(mismatched.warning),
    mismatched,
  );

  // A pinned record can become ESRCH-dead before the manager policy hook runs. That path performs
  // no signal and therefore needs neither spare capability nor destructive intent. It must clear the
  // stale pid + identity pair without invoking the hook.
  const deadChild = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  spawnedChildren.push(deadChild);
  await new Promise<void>((resolve) => deadChild.once("exit", () => resolve()));
  const deadRoot = mkdtempSync(join(tmpdir(), "cotal-dead-manager-record-"));
  mkdirSync(join(deadRoot, ".cotal"), { recursive: true });
  const deadPidPath = join(deadRoot, ".cotal", "manager.pid");
  writeFileSync(deadPidPath, String(deadChild.pid), { mode: 0o600 });
  writeFileSync(`${deadPidPath}.identity`, `${deadChild.pid} dead-token`, { mode: 0o600 });
  let hookCalled = false;
  await stopLocalProcess(
    { kind: "local-process", name: "manager", label: "manager", pidFile: "manager.pid" },
    { root: deadRoot, space: "main" },
    { beforeSignal: () => { hookCalled = true; throw new Error("dead records must not reach beforeSignal"); } },
  );
  check("a dead pinned manager record bypasses the pre-signal policy hook", !hookCalled);
  check("a dead pinned manager record clears both pid and identity files", !existsSync(deadPidPath) && !existsSync(`${deadPidPath}.identity`));
  rmSync(deadRoot, { recursive: true, force: true });

  console.log(`\ndown target-addressed smoke: ${pass} checks passed`);
} finally {
  process.chdir(prevCwd);
  // Only the ones that were actually created — a throw partway through leaves the rest undefined,
  // and `finally` has to cope with a half-built fixture rather than assume a complete one.
  let stranded = 0;
  const survivors: number[] = [];
  for (const child of spawnedChildren) {
    if (!child.pid) continue;
    if (!alive(child.pid)) continue;
    try {
      process.kill(child.pid, "SIGKILL");
    } catch (e) {
      stranded++;
      survivors.push(child.pid);
      console.error(`  ! could not kill dashboard child ${child.pid} (${(e as Error).message})`);
    }
  }
  // EVIDENCE MUST EXIST, not merely be preserved. On partial construction the pidfile write is
  // exactly what threw, so "the scratch holds the pidfiles" was false in the one case that needs
  // them. Write the survivors down where they can be found, and if even that fails, put the PIDs on
  // stderr — an operator can act on a printed PID, but not on a claim that a file exists.
  if (stranded > 0) {
    process.exitCode = 1;
    const record = join(scratch, "STRANDED-PIDS.txt");
    try {
      writeFileSync(record, survivors.join("\n") + "\n", { mode: 0o600 });
      console.error(`  ! PRESERVING ${scratch}: ${stranded} child(ren) still alive; PIDs recorded in ${record}`);
    } catch (e) {
      console.error(`  ! ${stranded} child(ren) still alive and the record could not be written (${(e as Error).message}). PIDs: ${survivors.join(", ")}`);
    }
  } else {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// No `process.exit(0)`: it overrode the exitCode a stranded child sets, turning a leak green.

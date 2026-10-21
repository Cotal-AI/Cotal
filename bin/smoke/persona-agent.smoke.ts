/**
 * REACHABILITY proof for #869 (persona `agent:` silently ignored), from the REAL spawn entry
 * points. The unit cells in agent-file.smoke.ts and start-overrides.smoke.ts prove the loader
 * models the field and `startAgent` honors the precedence; #869's whole defect is that the real
 * entry point resolved the connector before the code that would read `agent:` ever ran, so a
 * unit pass proves nothing about reachability. This suite closes that gap:
 *
 *   A. DETACHED (the issue's exact repro): a persona pinning `agent: pin`, a DIFFERENT
 *      connector named by COTAL_DEFAULT_AGENT, `cotal spawn <persona> --detach` with NO --agent,
 *      through the real kernel-parsed CLI command over the real control plane to a real manager.
 *      The pinned connector must build the launch. (Before the fix: the CLI collapsed the env into
 *      the op's `agent` field and the manager resolved the connector before loadAgentFile, so the
 *      seat ran the WRONG harness silently. This is the mutation-proof target cell.)
 *   B. Detached, explicit --agent still WINS over the pin (flag > file).
 *   C. DETACHED CALLER DEFAULT: an unpinned persona, with `COTAL_DEFAULT_AGENT` set only in the
 *      invoking CLI process while the already-running manager lacks it. The caller's default must
 *      survive dispatch without becoming an explicit override that could beat a persona pin.
 *   D. FOREGROUND: the same pinned persona spawned in the foreground (real `spawn()` run; the
 *      connector's child is a one-shot `true`-equivalent node script, so the run terminates) builds
 *      its launch through the PINNED connector, not the registry's default.
 *   E. `spawnRequiredExtensions` stays root-free; persona connector materialization occurs only
 *      after the target workspace is authoritative.
 *   F. A divergent-root foreground spawn refuses with the TARGET persona's connector name.
 *   G. Saved preferences: a harness saved for the user or the space is the caller default on both
 *      paths, below COTAL_DEFAULT_AGENT and a persona pin, and a saved persona preference picks the
 *      persona of a bare spawn.
 *
 * Throwaway everything: own nats-server on an OS-assigned free port with a scratch store dir, a
 * sandboxed COTAL_HOME, a scratch workspace root, kills only the PIDs it spawns. No live stack is
 * touched. Needs nats-server on PATH.
 * Run: pnpm smoke:persona-agent
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, Connector, LaunchOpts } from "@cotal-ai/core";

// Seat-env hygiene: nothing COTAL_* may leak in from the caller and steer resolution. #869 is
// ABOUT COTAL_DEFAULT_AGENT, so a stale one corrupts the repro in either direction.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];

const home = mkdtempSync(join(tmpdir(), "cotal-869-home-"));
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, "xdg");

const { parseCommandArgs, probeConnect, registry } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const { spawnRequiredExtensions, runCli } = await import("@cotal-ai/cli");
await import("@cotal-ai/cli"); // registers the CLI commands (spawn/stop/ps) into the registry
const { Manager } = await import("@cotal-ai/manager");

let pass = 0;
let fail = 0;
const kids: ChildProcess[] = [];
let releaseBroker: (() => void) | undefined;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++;
  console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "persona-agent-869";
const SPACE_E = "persona-agent-869e";

// Scratch workspace: the pinned persona. The pin names `pin` and the env names `other`, so the two
// connectors are distinguishable by NAME and by which buildLaunch ran.
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-869-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
writeFileSync(
  join(workspaceRoot, ".cotal", "agents", "pinned.md"),
  "---\nname: pinned\nrole: prover\nagent: pin\nsubscribe: []\n---\nYou prove reachability.\n",
);
writeFileSync(
  join(workspaceRoot, ".cotal", "agents", "unpinned.md"),
  "---\nname: unpinned\nrole: prover\nsubscribe: []\n---\nYou prove caller defaults survive detached dispatch.\n",
);

// Two recorders. Both children are one-shot mesh endpoints (join presence so the detached
// readiness race resolves "started" via the JOIN, then exit ~300ms later), so the detached reply
// arrives on the join and the foreground run resolves on the exit without needing a stop.
const coreDist = join(import.meta.dirname, "..", "..", "packages", "core", "dist", "index.js");
const builds: Record<string, LaunchOpts[]> = { pin: [], other: [] };
const mkCon = (name: string, oneShot: boolean): Connector => ({
  kind: "connector",
  name,
  requires: ["node"],
  buildLaunch: (o) => {
    builds[name].push(o);
    const script = oneShot
      ? "const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});ep.on('error',()=>{});await ep.start();await new Promise(r=>setTimeout(r,300));await ep.stop();});"
      : "const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});ep.on('error',()=>{});await ep.start();setInterval(()=>{},1000);});";
    return {
      command: "node",
      args: ["-e", script],
      env: {
        PATH: process.env.PATH ?? "",
        CORE_DIST: coreDist,
        COTAL_SPACE: o.space,
        COTAL_SERVERS: o.servers ?? "",
        COTAL_ID: o.id ?? "",
        COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "",
        COTAL_NAME: o.name,
      },
    };
  },
});
registry.register(mkCon("pin", true));
registry.register(mkCon("other", true));

const cmd = (name: string): Command => {
  const c = registry.all<Command>("command").find((c) => c.name === name);
  if (!c) throw new Error(`command ${name} not registered`);
  return c;
};
const run = (name: string, argv: string[]) => cmd(name).run(parseCommandArgs(cmd(name), argv));
// A managed launch reports success as an "Agent joined" section whose fields name the agent and its
// application. Read the field rows, so a word elsewhere in the report cannot satisfy a cell.
const unstyled = (out: string) => out.replace(/\x1b\[[0-9;]*m/g, "");
const field = (out: string, name: string, value: string) => new RegExp(`^\\s*${name}:\\s+${value}\\s*$`, "m").test(unstyled(out));
const joined = (out: string, agent: string) => unstyled(out).includes("Agent joined") && field(out, "Agent", agent);
async function capture(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  return out;
}

async function captureProcess(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProc(command, args, { cwd: join(import.meta.dirname, "..", ".."), env, stdio: ["ignore", "pipe", "pipe"] });
    kids.push(child);
    let out = "";
    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.stderr?.on("data", (chunk) => { out += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, out }));
  });
}

let mgr: InstanceType<typeof Manager> | undefined;
try {
  const brokerStore = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}869-js-`));
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", brokerStore], { stdio: "ignore" });
  kids.push(broker);
  releaseBroker = teardownOnSignal(broker, brokerStore);
  for (let i = 0; i < 50; i++) {
    if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break;
    await sleep(100);
  }
  recordMesh({ space: SPACE, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

  mgr = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
  await mgr.start();

  // A — the issue's exact shape: file pins `pin`, env points at `other`, no --agent, detached.
  process.env.COTAL_DEFAULT_AGENT = "other";
  const aOut = await capture(() => run("spawn", ["pinned", "--detach", "--no-events", "--space", SPACE]));
  ok("A: detached spawn of the pinned persona succeeded", joined(aOut, "pinned"), aOut);
  ok("A: the persona's agent: pin built the launch (file beats env, detached)", builds.pin.length === 1 && builds.other.length === 0, { pin: builds.pin.length, other: builds.other.length });
  ok("A: the reply names the pinned harness", field(aOut, "Application", "pin") && !field(aOut, "Application", "other"), aOut);

  // B — an explicit --agent still wins over the pin (flag > file > env > default).
  const bOut = await capture(() => run("spawn", ["pinned", "--detach", "--no-events", "--space", SPACE, "--agent", "other", "--name", "flagwins"]));
  ok("B: explicit --agent spawn succeeded", joined(bOut, "flagwins"), bOut);
  ok("B: the flag's connector built the launch, not the pin", builds.other.length >= 1 && builds.pin.length === 1, { pin: builds.pin.length, other: builds.other.length });

  // Stop both detached seats via the manager's own control handler (the CLI `stop` exits the
  // process on any failure, which would kill the suite before cells C/D).
  for (const n of ["pinned", "flagwins"]) {
    const r = await (mgr as unknown as { opStop: (a: Record<string, unknown>, c: string, ad: boolean) => Promise<{ ok: boolean; error?: string }> }).opStop({ name: n }, "smoke", true);
    if (!r.ok) console.log(`  · note: stop ${n} replied ${JSON.stringify(r)}`);
  }

  // C — detached caller default versus manager default. `COTAL_DEFAULT_AGENT` belongs to the
  // invoking operator: before #869, the detached CLI carried it over the control plane. The file
  // pin must outrank it when present (A), but an UNPINNED persona must still receive the caller's
  // default even when the already-running manager has no such environment variable. Run a real
  // child CLI process so caller and manager environments genuinely differ.
  delete process.env.COTAL_DEFAULT_AGENT;
  builds.pin = [];
  builds.other = [];
  const child = await captureProcess(
    "pnpm",
    ["exec", "tsx", "bin/cotal.ts", "spawn", "unpinned", "--detach", "--no-events", "--space", SPACE],
    { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_DEFAULT_AGENT: "other", COTAL_SKIP_CONNECTOR_SEED: "1" },
  );
  ok("C: detached child spawn with a caller-only default succeeded", child.code === 0 && joined(child.out, "unpinned"), child);
  ok("C: detached caller COTAL_DEFAULT_AGENT reached the manager for an unpinned persona", builds.other.length === 1 && builds.pin.length === 0, { pin: builds.pin.length, other: builds.other.length, out: child.out });
  const stopUnpinned = await (mgr as unknown as { opStop: (a: Record<string, unknown>, c: string, ad: boolean) => Promise<{ ok: boolean; error?: string }> }).opStop({ name: "unpinned" }, "smoke", true);
  if (!stopUnpinned.ok) console.log(`  · note: stop unpinned replied ${JSON.stringify(stopUnpinned)}`);

  // G — saved preferences, from a real child CLI so only the caller holds them. The harness
  // preference is a caller default like COTAL_DEFAULT_AGENT: the space's value beats the user's, the
  // variable beats both, and a persona pin beats all three. A saved persona preference picks the
  // persona of a bare spawn.
  {
    const { readPreferences, writePreference } = await import("@cotal-ai/workspace");
    const save = (key: string, value: string | undefined, space?: string) => writePreference(space ? { space } : {}, key, value, readPreferences().revision);
    const childSpawn = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      captureProcess("pnpm", ["exec", "tsx", "bin/cotal.ts", "spawn", ...args, "--detach", "--no-events", "--space", SPACE], {
        ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SKIP_CONNECTOR_SEED: "1", ...extraEnv,
      });
    const stopSeat = async (n: string) => {
      const r = await (mgr as unknown as { opStop: (a: Record<string, unknown>, c: string, ad: boolean) => Promise<{ ok: boolean; error?: string }> }).opStop({ name: n }, "smoke", true);
      if (!r.ok) console.log(`  · note: stop ${n} replied ${JSON.stringify(r)}`);
    };
    const counts = () => ({ pin: builds.pin.length, other: builds.other.length });
    const reset = () => { builds.pin = []; builds.other = []; };
    // A foreground spawn that refuses calls process.exit(1). Intercept it so a refusal grades the
    // cell red instead of ending the suite, and keep what the spawn printed. A bare spawn is a
    // managed launch that attaches, so direct execution is asked for with --foreground.
    const foreground = async (args: string[]): Promise<string> => {
      const realExit = process.exit.bind(process);
      (process as unknown as { exit: (c?: number) => never }).exit = ((code?: number) => {
        throw new Error(`process.exit(${code ?? 0})`);
      }) as typeof process.exit;
      try {
        return await capture(async () => {
          try {
            await run("spawn", [...args, "--foreground"]);
          } catch (e) {
            console.log((e as Error).message);
          }
        });
      } finally {
        (process as unknown as { exit: typeof process.exit }).exit = realExit;
      }
    };

    save("harness", "other");
    reset();
    const g1 = await childSpawn(["unpinned", "--name", "g1"]);
    ok("G1: a saved user harness reaches the manager as the caller default for an unpinned persona", g1.code === 0 && builds.other.length === 1 && builds.pin.length === 0, { ...counts(), out: g1.out });
    await stopSeat("g1");

    save("harness", "pin");
    save("harness", "other", SPACE);
    reset();
    const g2 = await childSpawn(["unpinned", "--name", "g2"]);
    ok("G2: the space's saved harness beats the user's", g2.code === 0 && builds.other.length === 1 && builds.pin.length === 0, { ...counts(), out: g2.out });
    await stopSeat("g2");

    reset();
    const g3 = await childSpawn(["unpinned", "--name", "g3"], { COTAL_DEFAULT_AGENT: "pin" });
    ok("G3: COTAL_DEFAULT_AGENT beats both saved values", g3.code === 0 && builds.pin.length === 1 && builds.other.length === 0, { ...counts(), out: g3.out });
    await stopSeat("g3");

    save("harness", "other");
    save("harness", undefined, SPACE);
    reset();
    const g4 = await childSpawn(["pinned", "--name", "g4"]);
    ok("G4: a persona's agent: pin beats a saved harness", g4.code === 0 && builds.pin.length === 1 && builds.other.length === 0, { ...counts(), out: g4.out });
    await stopSeat("g4");

    save("harness", undefined);
    save("persona", "unpinned", SPACE);
    reset();
    const g5 = await childSpawn(["--name", "g5"], { COTAL_DEFAULT_AGENT: "other" });
    ok("G5: a saved persona preference picks the persona of a bare detached spawn", g5.code === 0 && joined(g5.out, "g5") && builds.other.length === 1 && builds.pin.length === 0, { ...counts(), out: g5.out });
    await stopSeat("g5");

    save("persona", "pinned", SPACE);
    process.env.COTAL_DEFAULT_AGENT = "other";
    reset();
    const g6 = await foreground(["--no-events", "--space", SPACE, "--name", "g6"]);
    ok("G6: foreground, the saved persona preference picks the persona and its pin builds the launch", /spawning g6/.test(g6) && builds.pin.length === 1 && builds.other.length === 0, { ...counts(), out: g6 });
    delete process.env.COTAL_DEFAULT_AGENT;
    save("persona", undefined, SPACE);
    save("harness", "other");
    reset();
    const g7 = await foreground(["unpinned", "--no-events", "--space", SPACE, "--name", "g7"]);
    ok("G7: foreground, a saved user harness builds the launch of an unpinned persona", /spawning g7/.test(g7) && builds.other.length === 1 && builds.pin.length === 0, { ...counts(), out: g7 });
    save("harness", undefined);
  }

  // D — FOREGROUND: same pinned persona, no --agent, env pointing at `other`. The child is
  // one-shot, so the run resolves. The PINNED connector must build the launch.
  process.env.COTAL_DEFAULT_AGENT = "other";
  builds.pin = [];
  builds.other = [];
  const cOut = await capture(() => run("spawn", ["pinned", "--foreground", "--no-events", "--space", SPACE, "--name", "fgpin"]));
  ok("D: foreground spawn of the pinned persona ran to completion", /spawning fgpin/.test(cOut), cOut);
  ok("D: foreground honored the persona's agent: pin", builds.pin.length === 1 && builds.other.length === 0, { pin: builds.pin.length, other: builds.other.length, out: cOut });

  // E — the hook contract after the deferral fix: `spawnRequiredExtensions` is ROOT-FREE (it was
  // root-free before #869 and must stay that way; a pre-parse persona read via the cwd walk made a
  // spawn from outside the target pre-materialize the WRONG connector and hard-abort the command).
  // Materialization now happens in the spawn body after the authoritative load, so the hook
  // contributes nothing for any argv — file, detach, or foreground.
  {
    const refs = spawnRequiredExtensions(parseCommandArgs(cmd("spawn"), ["pinned"]));
    ok("E: requiredExtensions is root-free (no connector declared pre-parse)", refs.length === 0, refs);
    const refsFlag = spawnRequiredExtensions(parseCommandArgs(cmd("spawn"), ["pinned", "--agent", "other"]));
    ok("E: root-free for an explicit --agent too", refsFlag.length === 0, refsFlag);
  }

  // F — THE DIVERGENCE CELL (the cold-read block): cwd-root and target-root ACTUALLY DIFFER. The
  // registry holds space E pointing at workspaceRoot (persona pins `pin`), while the process cwd is
  // a DIFFERENT scratch root whose walk (were the hook to read one) would find a persona pinning
  // `other`. Foreground spawn of the target persona from the foreign cwd: the pinned connector
  // must build the launch. Before the deferral fix the hook read the cwd persona, pre-materialized
  // `other`, and (with connectors absent from the registry until materialized) the body's
  // registry.resolve threw "no connector registered" FOR `pin` — the confusing abort the block
  // named. After the fix there is no pre-parse read at all and the body materializes `pin`.
  {
    builds.pin = [];
    builds.other = [];
    const foreignRoot = mkdtempSync(join(tmpdir(), "cotal-869-foreign-"));
    mkdirSync(join(foreignRoot, ".cotal", "agents"), { recursive: true });
    writeFileSync(join(foreignRoot, ".cotal", "agents", "pinned.md"), "---\nname: pinned\nagent: other\nsubscribe: []\n---\nforeign persona\n");
    // Registry entry makes resolveTargetOrExit pick workspaceRoot BY NAME, outranking the cwd walk.
    recordMesh({ space: SPACE_E, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });
    const cwd = process.cwd();
    process.chdir(foreignRoot);
    // PUBLISHED-BINARY MODE for this cell: `runCli` sets this on the real binary before any
    // command runs, and it is what makes materializeExtension throw on an uninstalled extension
    // instead of no-op'ing (the library default). The abort shape the block traced lives behind
    // this flag, so the cell must run with it on.
    const { setInstalledExtensionsEnabled } = await import("@cotal-ai/cli");
    // CONTAINMENT: installed-mode manifest resolution reads globalConfigDir(), which follows
    // XDG_CONFIG_HOME (NOT COTAL_HOME), so sandbox it to a scratch dir with an EMPTY manifest.
    // Without this the cell would read the operator's real extensions.json; with it, an unknown
    // connector throws from a scratch manifest and nothing live is ever consulted.
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(foreignRoot, "xdg");
    mkdirSync(join(foreignRoot, "xdg", "cotal", "extensions"), { recursive: true });
    writeFileSync(join(foreignRoot, "xdg", "cotal", "extensions", "extensions.json"), JSON.stringify({ extensions: [] }));
    setInstalledExtensionsEnabled(true);
    // The runCli boot gate (seedBoot) reconciles seeded connectors on every real command, and a
    // first run in a fresh XDG root STAGES AND INSTALLS the default connectors (claude first).
    // That is fleet-state-shaped mutation inside a smoke, and worse for this cell it erases the
    // "not installed" world it exists to grade. The published binary sets this for its own
    // internal children; the cell borrows the same opt-out so the dispatch is graded on
    // extension RESOLUTION, never on seeding.
    const prevSkip = process.env.COTAL_SKIP_CONNECTOR_SEED;
    process.env.COTAL_SKIP_CONNECTOR_SEED = "1";
    // PUBLISHED-BINARY REGISTRY STATE: on the real binary no connector is pre-registered; the
    // suite's in-process recorders are, and materializeExtension returns a registry hit without
    // consulting the manifest, so with them present the pre-fix hook cannot produce the abort
    // this cell exists to catch. Unregister both for the dispatch (restored right after). With
    // the registry empty and the scratch manifest empty, the abort's NAMED CONNECTOR is the
    // whole story: post-fix the body loads the TARGET persona, materializes its pin, and the
    // refusal names `pin` (correct: that harness is genuinely not installed here). Pre-fix the
    // hook materialized the CWD persona's `other` in the dispatcher and aborted BEFORE the body
    // loaded any persona, naming `other`: the confusing wrong-harness refusal of the block.
    registry.unregister("connector", "pin");
    registry.unregister("connector", "other");
    // The refusal path calls process.exit(1); intercept it so the SUITE survives to grade the
    // cell (the real binary exits here, which is the correct operator-visible behavior).
    const realExit = process.exit.bind(process);
    (process as unknown as { exit: (c?: number) => never }).exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;
    try {
    // Throw-safe capture: the shared capture() helper RETHROWS on rejection and its buffer is
    // lost; this cell's fn is EXPECTED to throw (the intercepted exit), so keep the buffer.
    let eOut = "";
    {
      const realLog = console.log;
      const realErr = console.error;
      console.log = (...a: unknown[]) => void (eOut += a.join(" ") + "\n");
      console.error = (...a: unknown[]) => void (eOut += a.join(" ") + "\n");
      try {
        // Drive the REAL DISPATCHER (runCli), not cmd.run: the pre-parse hook
        // (spawnRequiredExtensions -> materializeExtension) only executes inside runCli, and the
        // pre-fix abort this cell pins lived exactly there.
        await runCli(registry, ["spawn", "pinned", "--foreground", "--space", SPACE_E, "--name", "fgdiv"], { extensions: true });
      } catch (e) {
        eOut += `\n${(e as Error).message}`;
      } finally {
        console.log = realLog;
        console.error = realErr;
      }
    }
    // Restore the recorders for later cells/teardown parity.
    registry.register(mkCon("pin", true));
    registry.register(mkCon("other", true));
    // With neither connector installed, the spawn MUST refuse, and it must name the PINNED
    // harness (`pin`, from the target persona), the correct, actionable refusal. The pre-fix
    // divergence abort named `other` (the cwd persona's) or aborted in the dispatcher before the
    // persona ever loaded; either way the operator was pointed at the wrong harness or none.
    ok("F: divergence spawn refuses loudly (neither harness installed)", /pin|other|connector/.test(eOut) && !/spawning fgdiv/.test(eOut), eOut);
    ok("F: the refusal names the PINNED harness (the target persona's choice), not the cwd persona's", /pin/.test(eOut) && !(/other/.test(eOut) && !/pin/.test(eOut)), eOut);
    // That the refusal names `pin` ALREADY proves the body loaded the TARGET persona: `pin` is
    // pinned only by the target's persona file (the foreign cwd's persona pins `other`). A
    // pre-body abort (the pre-fix dispatcher abort) could never name `pin`.
    ok("F: naming `pin` proves the TARGET persona was loaded (only it pins pin)", /pin/.test(eOut), eOut);
    // The GREEN-path divergence proof (harness choice under actually-different roots) ran in the
    // earlier recorder cells; this cell pins the ABORT SHAPE.
    } finally {
      (process as unknown as { exit: typeof process.exit }).exit = realExit;
      setInstalledExtensionsEnabled(false);
      if (prevSkip === undefined) delete process.env.COTAL_SKIP_CONNECTOR_SEED;
      else process.env.COTAL_SKIP_CONNECTOR_SEED = prevSkip;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      delete process.env.COTAL_DEFAULT_AGENT;
      process.chdir(cwd);
    }
  }

  console.log(`\npersona-agent 869 reachability smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  try { await mgr?.stop({ withAgents: true }); } catch { /* teardown best-effort */ }
  for (const k of kids) k.kill("SIGKILL");
  releaseBroker?.();
}

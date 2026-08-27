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
 *   C. FOREGROUND: the same pinned persona spawned in the foreground (real `spawn()` run; the
 *      connector's child is a one-shot `true`-equivalent node script, so the run terminates) builds
 *      its launch through the PINNED connector, not the registry's default.
 *   D. `spawnRequiredExtensions` declares the PINNED connector's extension for a foreground spawn
 *      (the preflight cell: if it demanded the wrong connector, the fix would be dead on arrival
 *      on the published binary, invisibly to the unit tests).
 *
 * Throwaway everything: own nats-server on an OS-assigned free port with a scratch store dir, a
 * sandboxed COTAL_HOME, a scratch workspace root, kills only the PIDs it spawns. No live stack is
 * touched. Needs nats-server on PATH.
 * Run: pnpm smoke:persona-agent
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, Connector, LaunchOpts } from "@cotal-ai/core";

// Seat-env hygiene: nothing COTAL_* may leak in from the caller and steer resolution. #869 is
// ABOUT COTAL_DEFAULT_AGENT, so a stale one corrupts the repro in either direction.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];

const home = mkdtempSync(join(tmpdir(), "cotal-869-home-"));
process.env.COTAL_HOME = home;

const { parseCommandArgs, probeConnect, registry } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const { spawnRequiredExtensions } = await import("@cotal-ai/cli");
await import("@cotal-ai/cli"); // registers the CLI commands (spawn/stop/ps) into the registry
const { Manager } = await import("@cotal-ai/manager");

let pass = 0;
let fail = 0;
const kids: ChildProcess[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++;
  console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });

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

let mgr: InstanceType<typeof Manager> | undefined;
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-869-js-"))], { stdio: "ignore" });
  kids.push(broker);
  for (let i = 0; i < 50; i++) {
    if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break;
    await sleep(100);
  }
  recordMesh({ space: SPACE, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

  mgr = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
  await mgr.start();

  // A — the issue's exact shape: file pins `pin`, env points at `other`, no --agent, detached.
  process.env.COTAL_DEFAULT_AGENT = "other";
  const aOut = await capture(() => run("spawn", ["pinned", "--detach", "--space", SPACE]));
  ok("A: detached spawn of the pinned persona succeeded", /spawned .*pinned/.test(aOut), aOut);
  ok("A: the persona's agent: pin built the launch (file beats env, detached)", builds.pin.length === 1 && builds.other.length === 0, { pin: builds.pin.length, other: builds.other.length });
  ok("A: the reply names the pinned harness", /pin /.test(aOut) && !/other /.test(aOut), aOut);

  // B — an explicit --agent still wins over the pin (flag > file > env > default).
  const bOut = await capture(() => run("spawn", ["pinned", "--detach", "--space", SPACE, "--agent", "other", "--name", "flagwins"]));
  ok("B: explicit --agent spawn succeeded", /spawned .*flagwins/.test(bOut), bOut);
  ok("B: the flag's connector built the launch, not the pin", builds.other.length >= 1 && builds.pin.length === 1, { pin: builds.pin.length, other: builds.other.length });

  // Stop both detached seats via the manager's own control handler (the CLI `stop` exits the
  // process on any failure, which would kill the suite before cells C/D).
  for (const n of ["pinned", "flagwins"]) {
    const r = await (mgr as unknown as { opStop: (a: Record<string, unknown>, c: string, ad: boolean) => Promise<{ ok: boolean; error?: string }> }).opStop({ name: n }, "smoke", true);
    if (!r.ok) console.log(`  · note: stop ${n} replied ${JSON.stringify(r)}`);
  }

  // C — FOREGROUND: same pinned persona, no --agent, env still pointing at `other`. The child is
  // one-shot, so the run resolves. The PINNED connector must build the launch.
  builds.pin = [];
  builds.other = [];
  const cOut = await capture(() => run("spawn", ["pinned", "--space", SPACE, "--name", "fgpin"]));
  ok("C: foreground spawn of the pinned persona ran to completion", /spawning fgpin/.test(cOut), cOut);
  ok("C: foreground honored the persona's agent: pin", builds.pin.length === 1 && builds.other.length === 0, { pin: builds.pin.length, other: builds.other.length, out: cOut });

  // D — the hook contract after the deferral fix: `spawnRequiredExtensions` is ROOT-FREE (it was
  // root-free before #869 and must stay that way; a pre-parse persona read via the cwd walk made a
  // spawn from outside the target pre-materialize the WRONG connector and hard-abort the command).
  // Materialization now happens in the spawn body after the authoritative load, so the hook
  // contributes nothing for any argv — file, detach, or foreground.
  {
    const refs = spawnRequiredExtensions(parseCommandArgs(cmd("spawn"), ["pinned"]));
    ok("D: requiredExtensions is root-free (no connector declared pre-parse)", refs.length === 0, refs);
    const refsFlag = spawnRequiredExtensions(parseCommandArgs(cmd("spawn"), ["pinned", "--agent", "other"]));
    ok("D: root-free for an explicit --agent too", refsFlag.length === 0, refsFlag);
  }

  // E — THE DIVERGENCE CELL (the cold-read block): cwd-root and target-root ACTUALLY DIFFER. The
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
    setInstalledExtensionsEnabled(true);
    try {
      process.env.COTAL_DEFAULT_AGENT = "other"; // env names the OTHER connector too
      const eOut = await capture(() => run("spawn", ["pinned", "--space", SPACE_E, "--name", "fgdiv"]));
      ok("E: divergence spawn ran to completion from the foreign cwd", /spawning fgdiv/.test(eOut), eOut);
      ok("E: the TARGET persona's pin built the launch, not the cwd persona's", builds.pin.length === 1 && builds.other.length === 0, { pin: builds.pin.length, other: builds.other.length, out: eOut });
      ok("E: no 'no connector registered' abort for the pinned harness", !/no connector registered for "pin"/.test(eOut), eOut);
    } finally {
      setInstalledExtensionsEnabled(false);
      delete process.env.COTAL_DEFAULT_AGENT;
      process.chdir(cwd);
    }
  }

  console.log(`\npersona-agent 869 reachability smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  try { await mgr?.stop(); } catch { /* teardown best-effort */ }
  for (const k of kids) k.kill("SIGKILL");
}

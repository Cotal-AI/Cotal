/**
 * `cotal down web` from any directory — a target-addressed component (`rootedAt: "target"`) is
 * stopped under the SAME mesh root its start side resolved (registry current mesh first,
 * `--space` to name one), not the cwd's `.cotal`. Regression for the start/stop asymmetry where
 * `cotal web` (target-resolved) claimed `<mesh-root>/.cotal/web.pid` but `cotal down web` only
 * looked under the folder it ran in and reported "Nothing running for web".
 *
 * Hermetic (no broker): COTAL_HOME and the temp root are sandboxed, meshes are recorded straight
 * into the registry, and the dashboard is a real SIGTERM-able child whose pid sits in the mesh
 * root's web.pid. Run: pnpm smoke:down-target
 */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeScratch } from "../../../bin/smoke/_scratch.js";

// Isolate BOTH the machine-home AND the temp root. `findCotalRoot` walks to `/` with no boundary,
// so a `.cotal` above the temp base (observed: `/tmp/.cotal` on CI; a home-dir `.cotal` when the
// scratch sat under the monorepo) captures every "neutral" dir.
const scratch = makeScratch();
const home = mkdtempSync(join(scratch, "home-"));
process.env.COTAL_HOME = home;

const { registry } = await import("@cotal-ai/core");
const { cacheLocalProcess, extensionLocalProcesses, findCotalRoot, recordMesh, setCurrent } = await import("@cotal-ai/workspace");
const { down } = await import("../src/commands/down.js");
const { webProcess } = await import("../../web/src/web.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A registered mesh root with a live "dashboard" child recorded in its web.pid. */
function meshWithDashboard(label: string): { root: string; child: ChildProcess; pidPath: string } {
  const root = mkdtempSync(join(tmpdir(), `cotal-${label}-`));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000);"], { detached: true, stdio: "ignore" });
  child.unref();
  // TRANSACTIONAL FROM THE SPAWN, because ownership cannot be published by a `return` that never
  // happens. Moving the call inside the caller's `try` was not enough: a throw between the spawn and
  // the return — the pidfile write — leaves the assignment undefined, so the caller's `finally` has
  // no record to clean and the child survives with PPID 1. Measured exactly that way: PID alive,
  // reparented, and its pid evidence gone.
  try {
    const pidPath = join(root, ".cotal", "web.pid");
    writeFileSync(pidPath, String(child.pid), { mode: 0o600 });
    return { root, child, pidPath };
  } catch (e) {
    if (child.pid) {
      try { process.kill(child.pid, "SIGKILL"); }
      catch (ke) { console.error(`  ! ${label}: spawned ${child.pid} then failed, and could not kill it: ${(ke as Error).message}`); }
    }
    throw e;
  }
}

const run = (positionals: string[], values: Record<string, string | boolean> = {}) =>
  down({ values, positionals, raw: [] });

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
  registry.register({ kind: "local-process", name: "fixtured", label: "fixture daemon", pidFile: "fixture.pid" });

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

  console.log(`\ndown target-addressed smoke: ${pass} checks passed`);
} finally {
  process.chdir(prevCwd);
  // Only the ones that were actually created — a throw partway through leaves the rest undefined,
  // and `finally` has to cope with a half-built fixture rather than assume a complete one.
  let stranded = 0;
  for (const m of [meshA, meshB]) {
    if (!m?.child.pid) continue;
    if (!alive(m.child.pid)) continue;
    try {
      process.kill(m.child.pid, "SIGKILL");
    } catch (e) {
      stranded++;
      console.error(`  ! could not kill dashboard child ${m.child.pid} (${(e as Error).message}) — it is still running`);
    }
  }
  // The scratch goes ONLY if nothing of ours is still alive in it. Its `.cotal/web.pid` is the sole
  // record that could identify a survivor, and deleting that makes a recoverable orphan anonymous.
  if (stranded > 0) {
    process.exitCode = 1;
    console.error(`  ! PRESERVING ${scratch}: ${stranded} child(ren) still alive; its web.pid files are the only way to find them.`);
  } else {
    rmSync(scratch, { recursive: true, force: true });
  }
}
process.exit(0);

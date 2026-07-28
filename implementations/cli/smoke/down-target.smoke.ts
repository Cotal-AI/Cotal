/**
 * `cotal down web` from any directory — a target-addressed component (`rootedAt: "target"`) is
 * stopped under the SAME mesh root its start side resolved (registry current mesh first,
 * `--space` to name one), not the cwd's `.cotal`. Regression for the start/stop asymmetry where
 * `cotal web` (target-resolved) claimed `<mesh-root>/.cotal/web.pid` but `cotal down web` only
 * looked under the folder it ran in and reported "Nothing running for web".
 *
 * Hermetic (no broker): COTAL_HOME is sandboxed, meshes are recorded straight into the registry,
 * and the dashboard is a real SIGTERM-able child whose pid sits in the mesh root's web.pid.
 * Run: pnpm smoke:down-target
 */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the machine-home BEFORE touching the registry — homeCotalDir() reads COTAL_HOME per call,
// so the real ~/.cotal is never touched.
const home = mkdtempSync(join(tmpdir(), "cotal-home-"));
process.env.COTAL_HOME = home;

const { registry } = await import("@cotal-ai/core");
const { cacheLocalProcess, extensionLocalProcesses, recordMesh, setCurrent } = await import("@cotal-ai/workspace");
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
  const pidPath = join(root, ".cotal", "web.pid");
  writeFileSync(pidPath, String(child.pid), { mode: 0o600 });
  return { root, child, pidPath };
}

const run = (positionals: string[], values: Record<string, string | boolean> = {}) =>
  down({ values, positionals, raw: [] });

const entry = (space: string, root: string) =>
  ({ space, server: "nats://127.0.0.1:4222", root, mode: "open" as const, ts: "2026-07-27T00:00:00.000Z" });

const neutral = mkdtempSync(join(tmpdir(), "cotal-neutral-")); // no .cotal up-tree, not a mesh root
const prevCwd = process.cwd();
const meshA = meshWithDashboard("meshA");
const meshB = meshWithDashboard("meshB");

try {
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
  for (const m of [meshA, meshB]) {
    if (m.child.pid && alive(m.child.pid)) {
      try { process.kill(m.child.pid, "SIGKILL"); } catch { /* gone */ }
    }
    rmSync(m.root, { recursive: true, force: true });
  }
  rmSync(neutral, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
process.exit(0);

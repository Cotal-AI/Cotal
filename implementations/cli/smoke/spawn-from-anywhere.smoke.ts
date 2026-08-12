/**
 * `cotal spawn` from any directory — the mesh registry + resolver + offline completion + the
 * connect preflight's stale-detection. Hermetic (no broker needed): COTAL_HOME is sandboxed to a
 * temp dir, "meshes" are recorded straight into the registry, and reachability is probed against a
 * closed port. Run: pnpm smoke:spawn-from-anywhere
 *
 * Covers every `resolveMeshTarget` source branch (0 / 1 / N+current / --space / local-project),
 * that completion lists the RESOLVED mesh's personas (not the cwd's) without opening the network,
 * that `current` wins inside another project, and that a dead registry entry probes `unreachable`
 * and is pruned.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the machine-home BEFORE touching the registry — homeCotalDir() reads COTAL_HOME per call,
// so the real ~/.cotal is never touched.
const home = mkdtempSync(join(tmpdir(), "cotal-home-"));
process.env.COTAL_HOME = home;

const { probeConnect, createSpaceAuth } = await import("@cotal-ai/core");
const {
  authDir,
  findCotalRoot,
  clearCurrent,
  isWorkspaceTargetError,
  loadMeshes,
  meshesDir,
  recordMesh,
  removeMesh,
  resolveMeshTarget,
  saveSpaceAuth,
  setCurrent,
} = await import("@cotal-ai/workspace");
const { spawnComplete, spawnPersonaRef } = await import("../src/commands/spawn.js");
const { listPersonas } = await import("../src/lib/personas.js");
const { pruneStaleMeshes } = await import("../src/lib/meshes.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** A project root with a `.cotal/agents/<persona>.md` catalog. */
function project(label: string, personas: string[]): string {
  const root = mkdtempSync(join(tmpdir(), `cotal-${label}-`));
  const dir = join(root, ".cotal", "agents");
  mkdirSync(dir, { recursive: true });
  for (const p of personas) writeFileSync(join(dir, `${p}.md`), `# ${p}\n`);
  return root;
}

const projA = project("projA", ["reviewer", "researcher"]);
const projB = project("projB", ["builder"]);
const neutral = mkdtempSync(join(tmpdir(), "cotal-neutral-")); // no .cotal up-tree
const SERVER = "nats://127.0.0.1:4222";
const DEAD = "nats://127.0.0.1:1"; // nothing listens here
const entry = (space: string, root: string, server = SERVER) =>
  ({ space, server, root, mode: "open" as const, ts: "2026-06-22T00:00:00.000Z" });

try {
  // PRECONDITION, stated because this suite cannot enforce it. It calls itself hermetic and is —
  // for COTAL_HOME. But `findCotalRoot` walks to `/` with no boundary, so ANY `.cotal` in an
  // ANCESTOR of `tmpdir()` captures `neutral`: resolution takes the local-project branch and
  // returns a `local-space` target rather than throwing, and the 0-mesh assertion below fails as
  // a bare "Missing expected exception" that names neither the cause nor the cure. Observed for
  // real: a machine with `/tmp/.cotal` fails every run while the identical tree passes under a tmp
  // root with clean ancestry. Fail here instead, naming the directory and the fix.
  const neutralRoot = findCotalRoot(neutral);
  assert.equal(
    neutralRoot,
    neutral,
    `this smoke needs a tmp dir with NO .cotal ancestor, but found one at ${join(neutralRoot, ".cotal")} `
      + `(tmpdir is ${tmpdir()}). Point TMPDIR at a directory whose ancestors hold no .cotal, or remove that one.`,
  );

  // 0 meshes → a bare resolve fails with one sentence, not a crash.
  assert.throws(() => resolveMeshTarget(neutral), /no mesh running/);
  check("0 meshes: resolve throws 'no mesh running'", true);

  // …but completion must FAIL CLOSED, never throw — offer nothing rather than crash the shell.
  const prevCwd0 = process.cwd();
  process.chdir(neutral);
  try {
    check("0 meshes: completion returns no items (no throw)", spawnComplete([""]).items.length === 0);
  } finally {
    process.chdir(prevCwd0);
  }

  // 1 mesh → used automatically (source 'registry'), with its root + personas.
  recordMesh(entry("teamA", projA));
  check("default persona: product fallback is default", spawnPersonaRef(undefined, [], {}) === "default");
  check("default persona: blank env is ignored", spawnPersonaRef(undefined, [], { COTAL_DEFAULT_PERSONA: "  " }) === "default");
  check("default persona: env overrides product fallback", spawnPersonaRef(undefined, [], { COTAL_DEFAULT_PERSONA: "reviewer" }) === "reviewer");
  check("default persona: positional wins over env", spawnPersonaRef(undefined, ["researcher"], { COTAL_DEFAULT_PERSONA: "reviewer" }) === "researcher");
  check("default persona: --config wins over positional/env", spawnPersonaRef("builder", ["researcher"], { COTAL_DEFAULT_PERSONA: "reviewer" }) === "builder");
  // Hardening: the registry dir is 0700 — its filenames are space names, so it must not be
  // world-traversable even though the file contents are already 0600.
  check(
    "registry dir is created 0700 (space names not world-readable)",
    (statSync(meshesDir()).mode & 0o777) === 0o700,
    (statSync(meshesDir()).mode & 0o777).toString(8),
  );
  const one = resolveMeshTarget(neutral);
  check("1 mesh: source is 'registry'", one.source === "registry", one.source);
  check("1 mesh: resolves to its root", one.root === projA, one.root);
  check(
    "1 mesh: personas come from the TARGET mesh",
    listPersonas(one.root).map((p) => p.name).join(",") === "researcher,reviewer",
    listPersonas(one.root).map((p) => p.name),
  );

  // `cotal use` is authoritative even with one recorded mesh and from inside another project.
  setCurrent("teamA");
  const oneSelected = resolveMeshTarget(projB);
  check("1 mesh + current: selection wins inside another project", oneSelected.source === "current" && oneSelected.root === projA, oneSelected);
  setCurrent("gone");
  const danglingLocal = resolveMeshTarget(projA);
  check("dangling current: local project remains the fallback", danglingLocal.source === "local-recorded" && danglingLocal.root === projA, danglingLocal);
  clearCurrent();

  // 2 meshes, no current → ambiguous: error names both spaces AND their roots.
  recordMesh(entry("teamB", projB));
  assert.throws(() => resolveMeshTarget(neutral), (e: Error) => /multiple meshes/.test(e.message) && e.message.includes(projA) && e.message.includes(projB));
  check("N meshes, no current: error names both meshes + roots", true);

  // …and completion still fails CLOSED in the ambiguous state, rather than throwing.
  const prevCwdN = process.cwd();
  process.chdir(neutral);
  try {
    check("N meshes, no current: completion returns no items (no throw)", spawnComplete([""]).items.length === 0);
  } finally {
    process.chdir(prevCwdN);
  }

  // --space picks one explicitly (source 'flag-space').
  const flagged = resolveMeshTarget(neutral, { space: "teamB" });
  check("--space: source is 'flag-space' on the right root", flagged.source === "flag-space" && flagged.root === projB, flagged);
  assert.throws(() => resolveMeshTarget(neutral, { space: "ghost" }), /no mesh named "ghost"/);
  check("--space ghost: errors with the unknown name", true);

  // current set → bare resolve uses it (source 'current').
  setCurrent("teamB");
  const cur = resolveMeshTarget(neutral);
  check("N meshes + current: source is 'current' on the chosen root", cur.source === "current" && cur.root === projB, cur);

  // An explicit current selection must also win from inside another mesh's project. This is the
  // contract exposed by `cotal use`: bare spawn no longer needs a matching `--space` flag.
  const sub = join(projA, "nested", "dir");
  mkdirSync(sub, { recursive: true });
  const selected = resolveMeshTarget(sub);
  check("current selection wins inside another local project", selected.source === "current" && selected.root === projB, selected);
  const explicitFromLocal = resolveMeshTarget(sub, { space: "teamA" });
  check("--space overrides current inside another local project", explicitFromLocal.source === "flag-space" && explicitFromLocal.root === projA, explicitFromLocal);

  // With no selected current mesh, a genuine local project remains the fallback.
  clearCurrent();
  const local = resolveMeshTarget(sub);
  check("without current, local project uses its recorded mesh", local.source === "local-recorded" && local.root === projA, local);

  // Registry `mode` is authoritative for auth: an OPEN mesh resolves credlessly EVEN IF its root
  // still has auth material on disk; an AUTH mesh loads it. Same root, opposite outcomes. The auth is
  // a REAL broker+account chain for "alpha" (a bare `{space}` stub no longer composes now that
  // `loadSpaceAuth` verifies the account was signed by the broker).
  saveSpaceAuth(authDir(projA), await createSpaceAuth("alpha"));
  recordMesh(entry("openmesh", projA, SERVER)); // entry() is mode:"open"
  check("open mesh resolves with NO auth despite auth files in its root", resolveMeshTarget(neutral, { space: "openmesh" }).auth === undefined);
  recordMesh({ ...entry("alpha", projA, SERVER), mode: "auth" }); // space matches projA's on-disk account
  check("auth mesh resolves WITH auth from its root", Boolean(resolveMeshTarget(neutral, { space: "alpha" }).auth));
  // Defense in depth (mitnick): an AUTH entry whose recorded space ≠ the root's on-disk auth.space is
  // stale — resolving it throws AND prunes the entry, rather than minting space-Y creds for space X.
  recordMesh({ ...entry("mismatch", projA, SERVER), mode: "auth" }); // projA's auth.json says "alpha"
  // Throws the TYPED contract (code, not prose — the `cotal …` copy is the renderer's job now).
  assert.throws(
    () => resolveMeshTarget(neutral, { space: "mismatch" }),
    (e: unknown) => isWorkspaceTargetError(e) && e.code === "stale-auth-root",
  );
  check("auth entry whose space ≠ root's auth.space throws + prunes", !loadMeshes().some((m) => m.space === "mismatch"));
  removeMesh("openmesh");
  removeMesh("alpha");

  // Fix A (HIGH): a local project whose mesh is in the registry resolves to the RECORDED server +
  // mode, not the hardcoded DEFAULT_SERVER — so `cotal up --server …:4333` then an in-project spawn
  // targets :4333, not :4222. And an open-recorded mesh mints NO creds even with auth files left on
  // its root's disk (closes the local-path mode gap truthium flagged).
  const ALT = "nats://127.0.0.1:4333";
  recordMesh({ ...entry("teamA", projA, ALT), mode: "open" });
  const localReg = resolveMeshTarget(join(projA, "nested", "dir"));
  check(
    "local project uses the RECORDED server, not DEFAULT_SERVER",
    localReg.server === ALT && localReg.source === "local-recorded",
    localReg,
  );
  check(
    "local project honors recorded OPEN mode despite auth files on disk",
    localReg.auth === undefined,
    localReg.auth,
  );
  recordMesh(entry("teamA", projA)); // restore (default server, open) for the remaining checks

  // A recorded local project resolves as `local-recorded`: registry-owned (so a stale entry prunes
  // on auth-required) yet quiet on the success line (the target is self-evident from cwd).
  check(
    "recorded local project → source 'local-recorded' (registry-owned for pruning, quiet UX)",
    resolveMeshTarget(join(projA, "nested", "dir")).source === "local-recorded",
  );
  // A target built by localTarget (flag-server with no registry hit) stays `flag-server` — a
  // non-registry escape hatch, so it is NOT pruned on failure.
  check(
    "localTarget (flag-server, no registry match) → source 'flag-server' (not registry-owned)",
    resolveMeshTarget(neutral, { server: "nats://127.0.0.1:9999" }).source === "flag-server",
  );
  // Silent-wrong-mesh guard: a genuine local project with NO entry of its own must NOT fall back
  // onto another mesh already recorded on DEFAULT_SERVER — it errors instead of joining it.
  const projC = project("projC", ["x"]);
  assert.throws(
    () => resolveMeshTarget(projC),
    (e: Error) => /another mesh/.test(e.message) && /is running at/.test(e.message),
  );
  check("local project w/o its own entry won't silently join a mesh on the default port", true);
  rmSync(projC, { recursive: true, force: true });

  // Offline completion: lists the RESOLVED mesh's personas (current=teamB → projB), and is
  // synchronous — it cannot have awaited a network probe.
  setCurrent("teamB");
  const prevCwd = process.cwd();
  process.chdir(neutral);
  try {
    const personas = spawnComplete([""]); // CompletionResult, not a Promise
    check("completion: lists the resolved mesh's personas (not cwd's)", personas.items.map((i) => i.value).join(",") === "builder", personas.items);
    const configFlag = spawnComplete(["--config", ""]);
    check("completion: --config lists the resolved mesh's personas", configFlag.items.map((i) => i.value).join(",") === "builder", configFlag.items);
    const spaces = spawnComplete(["--space", ""]);
    check("completion: --space lists the running spaces", spaces.items.map((i) => i.value).sort().join(",") === "teamA,teamB", spaces.items);
  } finally {
    process.chdir(prevCwd);
  }

  // Preflight probe: a closed port is 'unreachable' (distinct from an auth broker's 'auth-required').
  const dead = await probeConnect(DEAD, { timeoutMs: 500 });
  check("probeConnect(closed port) → unreachable", !dead.ok && dead.reason === "unreachable", dead);

  // Stale prune: an entry whose broker is gone is dropped; live-looking ones are left to their probe.
  clearCurrent();
  removeMesh("teamA");
  removeMesh("teamB");
  recordMesh(entry("ghost", projA, DEAD));
  await pruneStaleMeshes();
  check("pruneStaleMeshes drops the dead entry", loadMeshes().every((m) => m.space !== "ghost"), loadMeshes());

  console.log(`\nspawn-from-anywhere smoke: ${pass} checks passed`);
} finally {
  for (const d of [home, projA, projB, neutral]) rmSync(d, { recursive: true, force: true });
}
process.exit(0);

/**
 * LIVE e2e for `cotal ext` (CLI rework stage 3): fixture extension packages are built on the fly
 * and driven through the REAL binary as subprocesses (sandboxed XDG_CONFIG_HOME/COTAL_HOME):
 *
 *  A. add: installs into the cotal-owned prefix, links OUR core, imports once, verifies the
 *     registration LANDED, caches the command surface (+ provenance lines).
 *  B. cache-only surface: with the installed package's code made to THROW, `--help` and
 *     `__complete` still work (they never import); running the command fails LOUD.
 *  C. run: the real command executes with LIVE specs (flag + positional through the kernel);
 *     re-add is a clean refresh; a corrupt manifest is ONE red line, not a stack dump.
 *  D. version-skew: on-disk version ≠ manifest pin → loud error prescribing re-add.
 *  E. failed adds are loud AND rolled back: builtin name collision, ext-vs-ext name collision
 *     (checked against the manifest cache — the sibling is never imported), @cotal-ai/* as a
 *     regular dependency, missing core peerDep, an @cotal-ai/* peer the binary doesn't carry,
 *     zero registrations. A multi-peer extension gets BOTH core and workspace linked (E2).
 *  F. non-command providers: runtime-only install + lazy supervise resolution; a contributed
 *     local process is not a named `down` target, and only bare `down` stops it, with the stack.
 *  E3. aliases: an extension's alias runs its command; an alias or name a built-in or another
 *     installed extension already claims fails the add.
 *  G. remove: commands leave the surface; the manifest empties.
 * Run: pnpm smoke:ext:live   (needs npm on PATH)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recordMesh } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

// macOS commonly exposes tmpdir() through /var -> /private/var (and this harness may add another
// alias). The CLI canonicalizes cwd, so register the same physical root or extension removal sees
// two contexts and tries to reserve the same provider pidfile twice.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "cotal-ext-sb-")));
const configDir = join(sandbox, "xdg");
const home = join(sandbox, "home");
mkdirSync(configDir, { recursive: true });
mkdirSync(home, { recursive: true });
// The in-process registry write in F goes to the same sandboxed home as the CLI's; it is read per call.
process.env.COTAL_HOME = home;
// COTAL_HOME isolates only the registry; CLI project-root resolution still walks for `.cotal`.
mkdirSync(join(sandbox, ".cotal"), { recursive: true });
const sandboxAnchor = recordSmokeSandbox({ root: sandbox, cotalHome: home, xdgConfigHome: configDir });

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// Isolate this THIRD-PARTY extension suite from built-in-connector seeding (its own suite covers
// that): with the opt-out set, a fresh prefix stays empty so the add/remove/manifest assertions below
// speak only about the fixture packages.
const env = { ...process.env, XDG_CONFIG_HOME: configDir, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1" };
const realNode = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
const tsxCli = resolve(import.meta.dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const binCotal = resolve(import.meta.dirname, "..", "cotal.ts");
const cotal = (args: string[], timeout = 180_000) => {
  const options = { encoding: "utf8" as const, env, cwd: sandbox, timeout };
  assertSmokeSandboxDown(sandboxAnchor, args, options);
  return spawnSync(realNode, [tsxCli, binCotal, ...args], options);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `cotal ext add` installs the fixture from the real registry, so every refusal assertion below is
 *  also satisfiable by npm failing to RESOLVE a `@cotal-ai/*` package at the workspace version. The
 *  exit status is 1 either way, and only stderr tells the two apart.
 *
 *  That is not hypothetical. On 2026-10-01 the `live` job ran between the `chore(release): version
 *  packages` merge and the publish finishing, npm answered ETARGET for `@cotal-ai/core@0.58.0`, and
 *  the cell reddened against a refusal path the command never reached. 0.58.0 was on the registry as
 *  `latest` within the hour and a re-run was green, so the product was never in question; what cost
 *  time was a failure message pointing at `ext add`.
 *
 *  So name it. This still FAILS rather than passing, because the assertion genuinely was not
 *  measured and a green here would be a lie, but it fails saying which package could not be resolved
 *  and that the fix is to re-run after the release publishes.
 *
 *  ETARGET only, and the wording is measured off npm rather than recalled: `npm error notarget No
 *  matching version found for <pkg>@<version>.` A missing PACKAGE answers E404 instead, and that is
 *  deliberately NOT matched here. The versions under test belong to published packages, so an E404
 *  for one of them would mean it had been unpublished, which is a real finding and has to stay a
 *  plain loud failure. */
const UNPUBLISHED = /[Nn]o matching version found for (@cotal-ai\/[^@\s]+@[^\s"\\]+)/;
const refusedBecause = (name: string, r: { status: number | null; stderr: string }, reason: RegExp) => {
  const stderr = r.stderr ?? "";
  const miss = UNPUBLISHED.exec(stderr);
  if (miss !== null && !reason.test(stderr))
    throw new Error(
      `UNMEASURED: ${name}: npm could not resolve ${miss[1].replace(/\.$/, "")}, so the refusal `
      + `under test was never reached. That is the publish window after a version commit rather `
      + `than a product failure: re-run this job once the release has published. `
      + `stderr tail: ${stderr.slice(-200)}`,
    );
  ok(name, r.status === 1 && reason.test(stderr), stderr.slice(-300));
};

const target = cotal(["meshes", "add", "main", "--server", "nats://127.0.0.1:1", "--root", sandbox, "--mode", "open", "--force"]);
ok("fixture mesh target is registered", target.status === 0, target.stderr);

/** Build a fixture extension package on disk. `index` is its module body. */
function fixture(name: string, index: string, pkgJson: Record<string, unknown> = {}): string {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        type: "module",
        main: "index.js",
        peerDependencies: { "@cotal-ai/core": "*" },
        ...pkgJson,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "index.js"), index);
  return dir;
}

const GOOD = `import { registry } from "@cotal-ai/core";
registry.register({
  kind: "command",
  name: "hello-ext",
  group: "Extensions",
  summary: "fixture extension command",
  flags: [{ name: "shout", type: "boolean", description: "upper-case it" }],
  positionals: "[<who>]",
  run: async (args) => {
    const who = args.positionals[0] ?? "world";
    const msg = "hello " + who;
    console.log(args.values.shout ? msg.toUpperCase() : msg);
  },
});
`;

const extDir = join(configDir, "cotal", "extensions");
const manifestPath = join(extDir, "extensions.json");
const installedIndex = join(extDir, "node_modules", "cotal-ext-fixture", "index.js");
const installedPkg = join(extDir, "node_modules", "cotal-ext-fixture", "package.json");

// -- empty state ---------------------------------------------------------------------------------
ok("ext list starts empty", /No extensions installed\./.test(cotal(["ext", "list"]).stdout));

// -- A: add --------------------------------------------------------------------------------------
{
  const goodFixture = fixture("cotal-ext-fixture", GOOD, { bin: { "fixture-bin": "bin.js" } });
  writeFileSync(join(goodFixture, "bin.js"), "#!/usr/bin/env node\n");
  const r = cotal(["ext", "add", goodFixture]);
  ok("add exits 0", r.status === 0, r.stderr.slice(-400));
  ok("add names the contributed command", /hello-ext/.test(r.stdout), r.stdout);
  ok("manifest written + announced", existsSync(manifestPath) && /→ wrote extensions manifest/.test(r.stderr), r.stderr.slice(-300));
  ok("core is linked to OUR copy", /→ wrote @cotal-ai\/core link/.test(r.stderr));
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  ok("manifest pins name@version + caches flags and provider keys", m.extensions[0].version === "1.0.0" && m.extensions[0].commands[0].flags[0].name === "shout" && m.extensions[0].provides[0].kind === "command", m.extensions[0]);
}

// -- B: cache-only help/complete; run fails loud while broken -------------------------------------
{
  const good = readFileSync(installedIndex, "utf8");
  writeFileSync(installedIndex, 'throw new Error("BOOM — cache must not import me");\n');
  // The bare --help entry screen is curated; every command group, extensions included, is under help --all.
  const help = cotal(["help", "--all"]);
  ok("help --all lists the extension command WITHOUT importing it", help.status === 0 && /hello-ext/.test(help.stdout), help.stdout.slice(-400));
  const comp = cotal(["__complete", "hello-ext", "--"]);
  ok("<TAB> offers cached flags WITHOUT importing", comp.status === 0 && /--shout/.test(comp.stdout), comp.stdout);
  const run = cotal(["hello-ext"]);
  ok("running the broken extension fails loud, naming it", run.status === 1 && /cotal-ext-fixture/.test(run.stderr) && /BOOM/.test(run.stderr), run.stderr.slice(0, 300));
  writeFileSync(installedIndex, good);
}

// -- B2: a peer link left by another Cotal host is rebound before lazy import -----------------------
{
  const peer = join(extDir, "node_modules", "cotal-ext-fixture", "node_modules", "@cotal-ai", "core");
  const foreign = join(sandbox, "foreign-core");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "package.json"), JSON.stringify({ name: "@cotal-ai/core", version: "1.0.0", type: "module", exports: "./index.js" }));
  writeFileSync(join(foreign, "index.js"), "export const registry = { register() {} };\n");
  rmSync(peer, { recursive: true, force: true });
  symlinkSync(foreign, peer, "junction");
  const rebound = cotal(["hello-ext", "host-switch"]);
  const hostCore = realpathSync(resolve(import.meta.dirname, "..", "..", "packages", "core"));
  ok(
    "lazy load rebinds a peer link left by another Cotal host",
    rebound.status === 0 && /hello host-switch/.test(rebound.stdout) && realpathSync(peer) === hostCore,
    rebound.stdout + rebound.stderr,
  );
}

// -- B3: the cross-process lock covers rebind + complete module evaluation --------------------------
{
  const ready = join(sandbox, "materialize-ready");
  const release = join(sandbox, "materialize-release");
  const peer = join(extDir, "node_modules", "cotal-ext-fixture", "node_modules", "@cotal-ai", "core");
  const good = readFileSync(installedIndex, "utf8");
  writeFileSync(
    installedIndex,
    `import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { registry } from "@cotal-ai/core";
writeFileSync(${JSON.stringify(ready)}, "ready");
while (!existsSync(${JSON.stringify(release)})) await sleep(10);
registry.register({ kind: "command", name: "hello-ext", summary: "barrier", run: async () => console.log("barrier-ok") });
`,
  );
  let stdout = "";
  let stderr = "";
  const first = spawn(realNode, [tsxCli, binCotal, "hello-ext"], { env, cwd: sandbox });
  first.stdout.on("data", (data) => (stdout += data.toString()));
  first.stderr.on("data", (data) => (stderr += data.toString()));
  const firstDone = new Promise<number | null>((resolve) => first.on("close", resolve));
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready) && Date.now() < deadline) await sleep(20);
  try {
    ok("first materializer reaches top-level await while holding the prefix lock", existsSync(ready), stderr);
    const blocked = cotal(["hello-ext"]);
    ok(
      "a competing materializer fails before rebinding the active host's peer",
      blocked.status === 1 && /(install\/remove|update or mutation) is in progress/.test(blocked.stderr) && realpathSync(peer) === realpathSync(resolve(import.meta.dirname, "..", "..", "packages", "core")),
      blocked.stderr,
    );
  } finally {
    writeFileSync(release, "release");
  }
  const firstStatus = await firstDone;
  ok("the lock holder completes after its module evaluation barrier releases", firstStatus === 0 && /barrier-ok/.test(stdout), stdout + stderr);
  writeFileSync(installedIndex, good);
}

// -- C: run with LIVE specs ------------------------------------------------------------------------
{
  const r = cotal(["hello-ext", "bob", "--shout"]);
  ok("extension command runs through the kernel", r.status === 0 && r.stdout.includes("HELLO BOB"), r.stdout + r.stderr.slice(-200));
  const bad = cotal(["hello-ext", "--nope"]);
  ok("unknown flag on an extension command is a usage error (live specs)", bad.status === 1 && /Unknown option/.test(bad.stderr), bad.stderr.slice(0, 200));
}

// -- C2: re-adding an installed extension is a clean refresh (manifest keeps ONE entry) ------------
{
  const r = cotal(["ext", "add", join(sandbox, "cotal-ext-fixture")]);
  ok("re-add of the same extension exits 0", r.status === 0, r.stderr.slice(-300));
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  ok("re-add keeps one manifest entry at the same pin", m.extensions.length === 1 && m.extensions[0].version === "1.0.0", m.extensions);
  ok("successful re-add preserves npm relative bin symlinks", existsSync(join(extDir, "node_modules", ".bin", "fixture-bin")));
}

// -- C2b: old command-only manifests remain usable and still participate in collision checks -------
{
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete m.extensions[0].provides;
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const help = cotal(["--help"]);
  const completion = cotal(["__complete", "hello-ext", "--"]);
  const run = cotal(["hello-ext", "legacy"]);
  ok("legacy command-only manifest still renders, completes, and dispatches", help.status === 0 && /hello-ext/.test(help.stdout) && completion.status === 0 && /--shout/.test(completion.stdout) && run.status === 0 && /hello legacy/.test(run.stdout), help.stdout + completion.stdout + run.stdout + run.stderr);
}

// -- C3: a corrupt manifest is fatal-and-loud as ONE red line (never a stack dump, never a
//        silently-shrunk surface) ------------------------------------------------------------------
{
  const good = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, "{ not json");
  const r = cotal(["--help"]);
  ok("corrupt manifest fails every invocation", r.status === 1, r.status);
  ok("...as one red line naming the manifest + the fix", /corrupt extensions manifest/.test(r.stderr) && /ext add/.test(r.stderr), r.stderr.slice(0, 300));
  ok("...not an unhandled-rejection stack dump", !/ModuleJob|at async/.test(r.stderr), r.stderr.slice(0, 300));
  writeFileSync(manifestPath, good);
}

// -- D: version skew -------------------------------------------------------------------------------
{
  const meta = JSON.parse(readFileSync(installedPkg, "utf8"));
  writeFileSync(installedPkg, JSON.stringify({ ...meta, version: "9.9.9" }, null, 2));
  const r = cotal(["hello-ext"]);
  ok("version skew fails loud, prescribing re-add", r.status === 1 && /9\.9\.9/.test(r.stderr) && /ext add/.test(r.stderr), r.stderr.slice(0, 300));
  writeFileSync(installedPkg, JSON.stringify(meta, null, 2));
}

// -- E: failed adds are loud + rolled back ---------------------------------------------------------
{
  // The mutation lock is now a JSON owner FILE (the shared advisory-lock primitive), not a bare PID
  // string. A LIVE owner blocks (fail-fast: "mutation is in progress"); a dead owner is reclaimed; an
  // unreadable path (a stray directory) fails loud fast rather than busy-spinning.
  const mutationLock = join(configDir, "cotal", ".extensions.lock");
  const ownerFile = (pid: number) => JSON.stringify({ pid, nonce: "smoke", ts: 1 });
  writeFileSync(mutationLock, ownerFile(process.pid)); // a live owner (this process)
  const locked = cotal(["ext", "add", fixture("cotal-ext-locked", GOOD.replace('name: "hello-ext"', 'name: "locked-ext"'))]);
  ok("concurrent extension mutation fails loud", locked.status === 1 && /mutation is in progress/.test(locked.stderr), locked.stderr);
  const lockedRun = cotal(["hello-ext"]);
  ok("lazy extension import refuses a concurrent prefix mutation", lockedRun.status === 1 && /install\/remove is in progress/.test(lockedRun.stderr), lockedRun.stderr);
  rmSync(mutationLock, { force: true });

  const deadOwner = spawnSync(realNode, ["-e", ""], { encoding: "utf8" }).pid ?? 2147483646;
  writeFileSync(mutationLock, ownerFile(deadOwner));
  const staleRun = cotal(["hello-ext", "stale-lock"]);
  ok("lazy extension import ignores a dead owner's stale mutation lock", staleRun.status === 0 && /hello stale-lock/.test(staleRun.stdout), staleRun.stdout + staleRun.stderr);
  const staleClaim = cotal(["ext", "remove", "not-installed"]);
  ok("extension mutation reclaims a dead owner's stale lock", staleClaim.status === 1 && /no installed extension/.test(staleClaim.stderr) && !existsSync(mutationLock), staleClaim.stderr);

  mkdirSync(mutationLock); // a stray directory where the lock file belongs → unreadable
  const unreadableStarted = Date.now();
  const unreadable = cotal(["ext", "add", fixture("cotal-ext-unreadable-lock", GOOD.replace('name: "hello-ext"', 'name: "unreadable-lock"'))], 3_000);
  const unreadableElapsed = Date.now() - unreadableStarted;
  ok("an unreadable mutation lock fails loud instead of busy-spinning", unreadable.status === 1 && /unreadable/.test(unreadable.stderr) && unreadableElapsed < 3_000, unreadable.stderr + ` (${unreadableElapsed}ms)`);
  rmSync(mutationLock, { recursive: true, force: true });

  const priorManifest = readFileSync(manifestPath, "utf8");
  const badUpdate = fixture("cotal-ext-bad-update", GOOD, {
    name: "cotal-ext-fixture",
    dependencies: { "@cotal-ai/core": "*" },
    peerDependencies: undefined,
  });
  const update = cotal(["ext", "add", badUpdate]);
  const stillRuns = cotal(["hello-ext", "rollback"]);
  ok("failed same-name re-add restores the working package", update.status === 1 && stillRuns.status === 0 && /hello rollback/.test(stillRuns.stdout), update.stderr + stillRuns.stderr);
  ok("failed same-name re-add restores the prior manifest", readFileSync(manifestPath, "utf8") === priorManifest, readFileSync(manifestPath, "utf8"));

  const collide = fixture("cotal-ext-collide", GOOD.replace('name: "hello-ext"', 'name: "spawn"'));
  const r1 = cotal(["ext", "add", collide]);
  ok("builtin-name collision fails the add", r1.status === 1 && /cotal-ext-collide/.test(r1.stderr), r1.stderr.slice(-300));
  const r1b = cotal(["ext", "list"]);
  ok("collision add rolled back (not listed)", !/collide/.test(r1b.stdout), r1b.stdout);

  const dep = fixture("cotal-ext-dep", GOOD, { dependencies: { "@cotal-ai/core": "*" }, peerDependencies: undefined });
  const r2 = cotal(["ext", "add", dep]);
  refusedBecause("core-as-dependency fails with the exact reason", r2, /regular dependency/);

  const nopeer = fixture("cotal-ext-nopeer", GOOD, { peerDependencies: undefined });
  const r3 = cotal(["ext", "add", nopeer]);
  refusedBecause("missing core peerDep fails with the exact reason", r3, /peerDependency/);

  const empty = fixture("cotal-ext-empty", "export {};\n");
  const r4 = cotal(["ext", "add", empty]);
  ok("zero registrations fails the add", r4.status === 1 && /registered no extensions/.test(r4.stderr), r4.stderr.slice(-300));

  // ext-vs-ext: another package contributing the installed fixture's command name. The registry
  // can't see the installed (unimported) sibling, so add() must check the manifest cache.
  // Peer generalization (stage 4): ANY @cotal-ai/* regular dep fails; an @cotal-ai/* peer the
  // binary doesn't carry fails; a workspace peer is LINKED and importable.
  const wsdep = fixture("cotal-ext-wsdep", GOOD, { dependencies: { "@cotal-ai/workspace": "*" } });
  const r6 = cotal(["ext", "add", wsdep]);
  refusedBecause("@cotal-ai/* as a regular dependency fails with the exact reason", r6, /must be peerDependencies/);

  const alien = fixture("cotal-ext-alien", GOOD, { peerDependencies: { "@cotal-ai/core": "*", "@cotal-ai/nonexistent": "*" } });
  const r7 = cotal(["ext", "add", alien]);
  ok("an @cotal-ai/* peer the binary doesn't carry fails loud", r7.status === 1 && /@cotal-ai\/nonexistent/.test(r7.stderr) && /does not carry/.test(r7.stderr), r7.stderr.slice(-300));

  const sibling = fixture("cotal-ext-sibling", GOOD);
  const r5 = cotal(["ext", "add", sibling]);
  ok(
    "ext-vs-ext name collision fails the add, naming BOTH extensions",
    r5.status === 1 && /cotal-ext-sibling/.test(r5.stderr) && /cotal-ext-fixture/.test(r5.stderr) && /hello-ext/.test(r5.stderr),
    r5.stderr.slice(-400),
  );
  const r5b = cotal(["ext", "list"]);
  ok("ext-vs-ext collision rolled back (not listed)", !/sibling/.test(r5b.stdout), r5b.stdout);
}

// -- E3: aliases. An extension's alias runs its command, and a word another provider claims fails the
// add, whether a built-in or an installed extension (read from its manifest cache) holds it --------
{
  const aliased = (name: string, aliases: string[]) => `import { registry } from "@cotal-ai/core";
registry.register({
  kind: "command",
  name: "${name}",
  aliases: ${JSON.stringify(aliases)},
  group: "Extensions",
  summary: "fixture with an alias",
  positionals: "[<who>]",
  run: async (args) => { console.log("${name} " + (args.positionals[0] ?? "world")); },
});
`;
  const added = cotal(["ext", "add", fixture("cotal-ext-aliased", aliased("alias-ext", ["ax"]))]);
  ok("an extension that declares an alias installs", added.status === 0, added.stderr.slice(-400));
  const viaAlias = cotal(["ax", "there"]);
  ok("the alias runs the extension's command", viaAlias.status === 0 && viaAlias.stdout.includes("alias-ext there"), viaAlias.stdout + viaAlias.stderr.slice(-200));
  const help = cotal(["help"]);
  ok("help lists the alias beside its command", /alias-ext, ax/.test(help.stdout), help.stdout.slice(-600));
  const builtin = cotal(["ext", "add", fixture("cotal-ext-claims-sp", aliased("other-ext", ["sp"]))]);
  ok("an alias a built-in claims fails the add", builtin.status === 1 && /cotal-ext-claims-sp/.test(builtin.stderr) && /command:sp/.test(builtin.stderr), builtin.stderr.slice(-300));
  const sibling = cotal(["ext", "add", fixture("cotal-ext-claims-ax", aliased("third-ext", ["ax"]))]);
  ok(
    "an alias an installed extension claims fails the add, naming both",
    sibling.status === 1 && /cotal-ext-claims-ax/.test(sibling.stderr) && /cotal-ext-aliased/.test(sibling.stderr) && /"ax"/.test(sibling.stderr),
    sibling.stderr.slice(-400),
  );
  const nameOnAlias = cotal(["ext", "add", fixture("cotal-ext-name-ax", aliased("ax", []))]);
  ok("a name an installed extension claims as its alias fails the add", nameOnAlias.status === 1 && /cotal-ext-name-ax/.test(nameOnAlias.stderr) && /cotal-ext-aliased/.test(nameOnAlias.stderr), nameOnAlias.stderr.slice(-400));
  const listed = cotal(["ext", "list"]).stdout;
  ok("the refused adds rolled back", !/claims-sp|claims-ax|name-ax/.test(listed), listed);
  const removed = cotal(["ext", "remove", "cotal-ext-aliased"]);
  ok("the aliased extension removes", removed.status === 0, removed.stderr.slice(-200));
  const gone = cotal(["ax"]);
  ok("a removed extension's alias is unknown again", gone.status === 1 && /unknown command: ax/.test(gone.stderr), gone.stderr.slice(0, 200));
}

// -- E2: a multi-peer extension — the linked workspace peer is importable at run time -------------
{
  const GOODWS = `import { registry } from "@cotal-ai/core";
import { c } from "@cotal-ai/workspace";
registry.register({
  kind: "command",
  name: "ws-ext",
  group: "Extensions",
  summary: "fixture using a linked workspace peer",
  run: async () => { console.log(c.bold("WS-OK")); },
});
`;
  const wspeer = fixture("cotal-ext-wspeer", GOODWS, {
    peerDependencies: { "@cotal-ai/core": "*", "@cotal-ai/workspace": "*" },
  });
  const r = cotal(["ext", "add", wspeer]);
  ok("multi-peer add exits 0 (core + workspace linked)", r.status === 0 && /→ wrote @cotal-ai\/workspace link/.test(r.stderr), r.stderr.slice(-400));
  const run = cotal(["ws-ext"]);
  ok("the extension imports the LINKED workspace peer at run time", run.status === 0 && run.stdout.includes("WS-OK"), run.stdout + run.stderr.slice(-200));
  const failedSibling = cotal(["ext", "add", fixture("cotal-ext-peer-rollback", "export {};\n")]);
  ok("a failed sibling add rolls back", failedSibling.status === 1 && /registered no extensions/.test(failedSibling.stderr), failedSibling.stderr);
  const afterRollback = cotal(["ws-ext"]);
  ok("failed add rollback preserves older private peer links", afterRollback.status === 0 && afterRollback.stdout.includes("WS-OK"), afterRollback.stdout + afterRollback.stderr);
}

// -- F: non-command providers + whole-stack process shutdown ---------------------------------------
{
  const loaded = join(sandbox, "runtime-loaded");
  const PROVIDERS = `import { writeFileSync } from "node:fs";
import { registry } from "@cotal-ai/core";
writeFileSync(${JSON.stringify(loaded)}, "loaded");
registry.register(
  {
    kind: "runtime",
    name: "fixture-runtime",
    available: () => true,
    create: () => ({ kind: "fixture-runtime", spawn: () => { throw new Error("unused"); } }),
  },
  {
    kind: "runtime",
    name: "fixture-unavailable",
    available: () => false,
    create: () => ({ kind: "fixture-unavailable", spawn: () => { throw new Error("unused"); } }),
  },
  {
    kind: "local-process",
    name: "fixture-worker",
    label: "fixture worker",
    order: 35,
    pidFile: "fixture.pid",
    artifacts: ["fixture.secret"],
  },
);
`;
  const providers = fixture("cotal-ext-providers", PROVIDERS);
  const added = cotal(["ext", "add", providers]);
  ok("runtime-only extension add exits 0", added.status === 0, added.stderr.slice(-400));
  const retainedPeer = cotal(["ws-ext"]);
  ok("adding a core-only extension preserves older workspace peer links", retainedPeer.status === 0 && retainedPeer.stdout.includes("WS-OK"), retainedPeer.stdout + retainedPeer.stderr);
  ok("multi-peer extension still removes cleanly", cotal(["ext", "remove", "cotal-ext-wspeer"]).status === 0);
  ok("add reports every provider kind", /runtime:fixture-runtime/.test(added.stdout) && /local-process:fixture-worker/.test(added.stdout), added.stdout);
  const providerManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const providerEntry = providerManifest.extensions.find((entry: { pkg: string }) => entry.pkg === "cotal-ext-providers");
  ok("local-process metadata is cached declaratively", providerEntry.localProcesses[0].pidFile === "fixture.pid" && providerEntry.localProcesses[0].artifacts[0] === "fixture.secret", providerEntry);
  rmSync(loaded, { force: true });
  const downCompletion = cotal(["__complete", "down", ""]);
  ok("down completion offers saved services, never installed process providers, and imports nothing", downCompletion.status === 0 && !/fixture-worker/.test(downCompletion.stdout) && !existsSync(loaded), downCompletion.stdout + downCompletion.stderr);
  const supervise = cotal(["supervise", "--runtime", "fixture-runtime", "--server", "nats://127.0.0.1:1"]);
  ok("supervise lazy-loads an installed runtime provider", supervise.status === 1 && existsSync(loaded) && /Can't reach NATS/.test(supervise.stderr) && !/unknown runtime/.test(supervise.stderr), supervise.stderr.slice(-400));

  const unavailableManifest = join(sandbox, "unavailable.yaml");
  writeFileSync(unavailableManifest, `apiVersion: cotal/v1\nkind: Mesh\nspace: unavailable\nruntime: fixture-unavailable\nchannels: {}\n`);
  const unavailable = cotal(["up", "-f", unavailableManifest]);
  ok("up -f rejects an unavailable extension runtime before starting the broker", unavailable.status === 1 && /not reachable/.test(unavailable.stderr) && !existsSync(join(sandbox, ".cotal", "nats.pid")), unavailable.stderr.slice(-400));

  mkdirSync(join(sandbox, ".cotal"), { recursive: true });
  const daemon = (childCode = "setInterval(() => {}, 1000)"): number => {
    const code = `const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid);`;
    return Number(spawnSync(realNode, ["-e", code], { encoding: "utf8" }).stdout.trim());
  };
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  // A named `down` is a service stop. An installed provider's process, a core component and a typo
  // are all unknown saved services here, so each refuses before any process is signalled or any
  // artifact deleted.
  const fixturePid = daemon();
  writeFileSync(join(sandbox, ".cotal", "fixture.pid"), String(fixturePid));
  writeFileSync(join(sandbox, ".cotal", "fixture.secret"), "keep");
  for (const name of ["fixture-worker", "manager", "nats", "managre"]) {
    const named = cotal(["down", name]);
    ok(`named down ${name} refuses as an unknown saved service and signals nothing`,
      named.status === 2 && /no saved service definition resolves this name/.test(named.stderr) && alive(fixturePid) && existsSync(join(sandbox, ".cotal", "fixture.secret")),
      named.stdout + named.stderr);
  }

  // Only bare `down` reaches an extension's process, together with the stack, and it needs the
  // stack's own `up` registration. `meshes add` above recorded a manual one, so this replaces it.
  recordMesh({ space: "main", server: "nats://127.0.0.1:1", root: sandbox, mode: "open", origin: "up", ts: "2026-07-27T00:00:00.000Z" });

  // A refused component stops the sweep before the broker, and keeps its artifacts and the registration.
  const reservationOwner = daemon();
  writeFileSync(join(sandbox, ".cotal", "fixture.pid"), `removing:${reservationOwner}`);
  const reservedDown = cotal(["down"]);
  ok("bare down never signals a removal reservation or deletes its artifacts",
    reservedDown.status === 1 && /removal is in progress/.test(reservedDown.stderr) && alive(reservationOwner) && existsSync(join(sandbox, ".cotal", "fixture.secret")),
    reservedDown.stdout + reservedDown.stderr);
  try { process.kill(reservationOwner, "SIGTERM"); } catch { /* gone */ }

  writeFileSync(join(sandbox, ".cotal", "fixture.pid"), String(fixturePid));
  const whole = cotal(["down"]);
  ok("bare down stops an installed extension's process with the stack and clears its artifacts",
    whole.status === 0 && !alive(fixturePid) && !existsSync(join(sandbox, ".cotal", "fixture.pid")) && !existsSync(join(sandbox, ".cotal", "fixture.secret")),
    whole.stdout + whole.stderr);
  ok("provider extension removes cleanly", cotal(["ext", "remove", "cotal-ext-providers"]).status === 0);
}

// -- G: remove -------------------------------------------------------------------------------------
{
  const r = cotal(["ext", "remove", "cotal-ext-fixture"]);
  ok("remove exits 0", r.status === 0, r.stderr.slice(-200));
  const gone = cotal(["hello-ext"]);
  ok("removed command is unknown again", gone.status === 1 && /unknown command: hello-ext/.test(gone.stderr), gone.stderr.slice(0, 150));
  ok("ext list is empty again", /No extensions installed\./.test(cotal(["ext", "list"]).stdout));
}

console.log(`\next live e2e: ${pass} checks passed`);

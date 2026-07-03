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
 *     (checked against the manifest cache — the sibling is never imported), core as a regular
 *     dependency, missing core peerDep, zero registrations.
 *  F. remove: commands leave the surface; the manifest empties.
 * Run: pnpm smoke:ext:live   (needs npm on PATH)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "cotal-ext-sb-"));
const configDir = join(sandbox, "xdg");
const home = join(sandbox, "home");
mkdirSync(configDir, { recursive: true });
mkdirSync(home, { recursive: true });

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const env = { ...process.env, XDG_CONFIG_HOME: configDir, COTAL_HOME: home };
const realNode = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
const tsxCli = resolve(import.meta.dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const binCotal = resolve(import.meta.dirname, "..", "cotal.ts");
const cotal = (args: string[]) =>
  spawnSync(realNode, [tsxCli, binCotal, ...args], { encoding: "utf8", env, cwd: sandbox, timeout: 180_000 });

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
ok("ext list starts empty", /no extensions installed/.test(cotal(["ext", "list"]).stdout));

// -- A: add --------------------------------------------------------------------------------------
{
  const r = cotal(["ext", "add", fixture("cotal-ext-fixture", GOOD)]);
  ok("add exits 0", r.status === 0, r.stderr.slice(-400));
  ok("add names the contributed command", /hello-ext/.test(r.stdout), r.stdout);
  ok("manifest written + announced", existsSync(manifestPath) && /→ wrote extensions manifest/.test(r.stderr), r.stderr.slice(-300));
  ok("core is linked to OUR copy", /→ wrote core link/.test(r.stderr));
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  ok("manifest pins name@version + caches flags", m.extensions[0].version === "1.0.0" && m.extensions[0].commands[0].flags[0].name === "shout", m.extensions[0]);
}

// -- B: cache-only help/complete; run fails loud while broken -------------------------------------
{
  const good = readFileSync(installedIndex, "utf8");
  writeFileSync(installedIndex, 'throw new Error("BOOM — cache must not import me");\n');
  const help = cotal(["--help"]);
  ok("--help lists the extension command WITHOUT importing it", help.status === 0 && /hello-ext/.test(help.stdout), help.stdout.slice(-400));
  const comp = cotal(["__complete", "hello-ext", "--"]);
  ok("<TAB> offers cached flags WITHOUT importing", comp.status === 0 && /--shout/.test(comp.stdout), comp.stdout);
  const run = cotal(["hello-ext"]);
  ok("running the broken extension fails loud, naming it", run.status === 1 && /cotal-ext-fixture/.test(run.stderr) && /BOOM/.test(run.stderr), run.stderr.slice(0, 300));
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
  const collide = fixture("cotal-ext-collide", GOOD.replace('name: "hello-ext"', 'name: "spawn"'));
  const r1 = cotal(["ext", "add", collide]);
  ok("builtin-name collision fails the add", r1.status === 1 && /cotal-ext-collide/.test(r1.stderr), r1.stderr.slice(-300));
  const r1b = cotal(["ext", "list"]);
  ok("collision add rolled back (not listed)", !/collide/.test(r1b.stdout), r1b.stdout);

  const dep = fixture("cotal-ext-dep", GOOD, { dependencies: { "@cotal-ai/core": "*" }, peerDependencies: undefined });
  const r2 = cotal(["ext", "add", dep]);
  ok("core-as-dependency fails with the exact reason", r2.status === 1 && /regular dependency/.test(r2.stderr), r2.stderr.slice(-300));

  const nopeer = fixture("cotal-ext-nopeer", GOOD, { peerDependencies: undefined });
  const r3 = cotal(["ext", "add", nopeer]);
  ok("missing core peerDep fails with the exact reason", r3.status === 1 && /peerDependency/.test(r3.stderr), r3.stderr.slice(-300));

  const empty = fixture("cotal-ext-empty", "export {};\n");
  const r4 = cotal(["ext", "add", empty]);
  ok("zero registrations fails the add", r4.status === 1 && /registered no commands/.test(r4.stderr), r4.stderr.slice(-300));

  // ext-vs-ext: another package contributing the installed fixture's command name. The registry
  // can't see the installed (unimported) sibling, so add() must check the manifest cache.
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

// -- F: remove -------------------------------------------------------------------------------------
{
  const r = cotal(["ext", "remove", "cotal-ext-fixture"]);
  ok("remove exits 0", r.status === 0, r.stderr.slice(-200));
  const gone = cotal(["hello-ext"]);
  ok("removed command is unknown again", gone.status === 1 && /unknown command: hello-ext/.test(gone.stderr), gone.stderr.slice(0, 150));
  ok("ext list is empty again", /no extensions installed/.test(cotal(["ext", "list"]).stdout));
}

console.log(`\next live e2e: ${pass} checks passed`);

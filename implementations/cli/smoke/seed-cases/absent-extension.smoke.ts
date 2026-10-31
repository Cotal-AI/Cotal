import { bindExtensionPeers } from "@cotal-ai/workspace";
import { boot, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, tmpdir, join, check, cotal, freshCfg, seedDir, manifestPath, readJson, writeJson, track, finishScenario } from "./harness.js";

// A third-party extension recorded in the manifest whose package directory is gone: never installed
// there, or pruned by npm as extraneous because the prefix's package.json does not list it. Either
// one used to fail every seed, `--repair` included, and the failed seed then refused `ext remove`.
const PKG = "@fixture/cotal-absent-ext";
const BUILTINS = [
  "@cotal-ai/connector-claude-code",
  "@cotal-ai/connector-opencode",
  "@cotal-ai/connector-codex",
  "@cotal-ai/connector-hermes",
  "@cotal-ai/connector-jcode",
  "@cotal-ai/pi",
  "@cotal-ai/web",
];
const META = { name: PKG, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } };

/** A config whose manifest records PKG while the prefix's package.json lists no dependency. With
 *  `onDisk` the package directory is also present in the prefix, so npm finds it extraneous. */
function fixture(onDisk: boolean): { cfg: string; dir: string } {
  const cfg = track(freshCfg());
  const source = join(cfg, "fixture-source");
  mkdirSync(source);
  writeJson(join(source, "package.json"), META);
  writeFileSync(join(source, "index.js"), "export {};\n");
  const prefix = join(cfg, "cotal", "extensions");
  mkdirSync(prefix, { recursive: true });
  writeJson(join(prefix, "package.json"), { name: "cotal-extensions", private: true, dependencies: {} });
  writeJson(manifestPath(cfg), {
    extensions: [{
      pkg: PKG, version: "1.0.0", spec: source, commands: [],
      provides: [{ kind: "connector", name: "fixture-absent" }],
      connectors: [{ name: "fixture-absent", requires: [], eventPlane: false, setup: null }],
    }],
  });
  const dir = join(prefix, "node_modules", "@fixture", "cotal-absent-ext");
  if (onDisk) {
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, "package.json"), META);
    writeFileSync(join(dir, "index.js"), "export {};\n");
  }
  return { cfg, dir };
}
const recorded = (cfg: string): string[] => (readJson(manifestPath(cfg)) as { extensions: { pkg: string }[] }).extensions.map((e) => e.pkg);
const cursorPath = (cfg: string): string => join(seedDir(cfg), "reconcile.cursor.json");
const warned = (text: string, dir: string): boolean =>
  text.includes(`! ${PKG} is in the extensions manifest but not installed at ${dir}, so its shared peers were not linked`) &&
  text.includes(`\`cotal ext remove '${PKG}'\` drops the entry`);
const seededAll = (cfg: string): boolean => BUILTINS.every((pkg) => recorded(cfg).includes(pkg)) && !existsSync(cursorPath(cfg));

try {
  // ── a recorded package that was never in the prefix ──────────────────────────────────────────────
  {
    const { cfg, dir } = fixture(false);
    const reset = cotal(cfg, ["ext", "seed", "--reset"]);
    check("absent extension: --reset exits 0", reset.status === 0, reset.stderr);
    check("absent extension: --reset names the package, its path and both remedies", warned(reset.stderr, dir), reset.stderr);
    check("absent extension: --reset seeds all seven built-ins and clears its cursor", seededAll(cfg), recorded(cfg));
    check("absent extension: its manifest entry is kept", recorded(cfg).includes(PKG));
  }

  // ── a recorded package npm prunes as extraneous during the seed's own install ───────────────────
  {
    const { cfg, dir } = fixture(true);
    const reset = cotal(cfg, ["ext", "seed", "--reset"]);
    check("extraneous extension: --reset exits 0", reset.status === 0, reset.stderr);
    check("extraneous extension: npm pruned the package the prefix does not list", !existsSync(dir));
    check("extraneous extension: --reset names the package, its path and both remedies", warned(reset.stderr, dir), reset.stderr);
    check("extraneous extension: --reset seeds all seven built-ins and keeps its entry", seededAll(cfg) && recorded(cfg).includes(PKG), recorded(cfg));
  }

  // ── a failed seed beside an absent package: repair, remove, reset ────────────────────────────────
  {
    const { cfg, dir } = fixture(false);
    // `node` and nothing else on PATH, so the seed child's `npm install` cannot start.
    const bin = track(mkdtempSync(join(tmpdir(), "cotal-seed-no-npm-")));
    symlinkSync(process.execPath, join(bin, "node"));
    const failed = boot(cfg, { PATH: bin });
    check("absent extension recovery: a seed without npm fails and keeps its cursor", failed.status !== 0 && existsSync(cursorPath(cfg)), failed.stderr);
    const refused = cotal(cfg, ["ext", "remove", PKG]);
    check("absent extension recovery: remove is refused until the failed seed is repaired",
      refused.status !== 0 && /a previous connector seed failed \(package "claude", phase add\)/.test(refused.stderr) && /cotal ext seed --repair/.test(refused.stderr), refused.stderr);
    const repair = cotal(cfg, ["ext", "seed", "--repair"]);
    check("absent extension recovery: --repair exits 0 and names the absent package", repair.status === 0 && warned(repair.stderr, dir), repair.stderr);
    check("absent extension recovery: --repair seeds all seven built-ins and clears the cursor", seededAll(cfg), recorded(cfg));
    const remove = cotal(cfg, ["ext", "remove", PKG]);
    check("absent extension recovery: remove then drops the entry", remove.status === 0 && !recorded(cfg).includes(PKG), remove.stderr);
    const reset = cotal(cfg, ["ext", "seed", "--reset"]);
    check("absent extension recovery: a later --reset exits 0 with no absent-package warning", reset.status === 0 && !reset.stderr.includes(PKG) && seededAll(cfg), reset.stderr);
  }

  // ── a seeded built-in whose directory is gone is skipped by the others' adds, then reinstalled ───
  {
    const cfg = track(freshCfg());
    const first = cotal(cfg, ["ext", "seed", "--reset"]);
    const hermes = join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-hermes");
    rmSync(hermes, { recursive: true, force: true });
    const reset = cotal(cfg, ["ext", "seed", "--reset"]);
    check("absent built-in: --reset names the repair remedy, then reinstalls and verifies it",
      first.status === 0 && reset.status === 0 &&
        reset.stderr.includes(`! @cotal-ai/connector-hermes is in the extensions manifest but not installed at ${hermes}`) &&
        reset.stderr.includes("`cotal ext seed --repair` reinstalls it") &&
        existsSync(join(hermes, "dist", "index.js")) && seededAll(cfg), reset.stderr);
  }

  // ── the binder skips only a directory that does not exist, and only when asked ───────────────────
  {
    const cfg = track(freshCfg());
    const prior = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = cfg;
    try {
      const modules = join(cfg, "cotal", "extensions", "node_modules", "@fixture");
      const failure = (owners: string[], operation: string, onAbsent?: (owner: string) => void): string => {
        try {
          bindExtensionPeers(owners, operation, { force: true, onAbsent });
          return "";
        } catch (e) {
          return (e as Error).message;
        }
      };
      mkdirSync(join(modules, "present"), { recursive: true });
      writeJson(join(modules, "present", "package.json"), { ...META, name: "@fixture/present" });
      const skipped: string[] = [];
      const bound = bindExtensionPeers(["@fixture/gone", "@fixture/present"], "@fixture/op", { force: true, onAbsent: (owner) => skipped.push(owner) });
      check("binder: an absent owner is reported and the others still bound",
        skipped.join() === "@fixture/gone" && bound.some((link) => link.owner === "@fixture/present" && link.peer === "@cotal-ai/core"), { skipped, bound });
      check("binder: without onAbsent an absent owner still fails",
        /cannot preserve installed extension @fixture\/gone's shared peers: ENOENT/.test(failure(["@fixture/gone"], "@fixture/op")));
      check("binder: the operation's own absent package is never skipped",
        /cannot preserve installed extension @fixture\/gone's shared peers: ENOENT/.test(failure(["@fixture/gone"], "@fixture/gone", () => {})));
      mkdirSync(join(modules, "hollow"), { recursive: true });
      check("binder: a directory without package.json still fails",
        /cannot preserve installed extension @fixture\/hollow's shared peers: ENOENT/.test(failure(["@fixture/hollow"], "@fixture/op", () => {})));
      symlinkSync(join(cfg, "nowhere"), join(modules, "dangling"));
      check("binder: a dangling package link still fails",
        /cannot preserve installed extension @fixture\/dangling's shared peers: ENOENT/.test(failure(["@fixture/dangling"], "@fixture/op", () => {})));
      mkdirSync(join(modules, "corrupt"), { recursive: true });
      writeFileSync(join(modules, "corrupt", "package.json"), "{ not json");
      check("binder: a corrupt package.json still fails",
        /cannot preserve installed extension @fixture\/corrupt's shared peers: .*JSON/.test(failure(["@fixture/corrupt"], "@fixture/op", () => {})));
    } finally {
      if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prior;
    }
  }
} finally {
  finishScenario();
}

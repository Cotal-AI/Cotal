import { realpathSync } from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync, tmpdir, delimiter, join, REPO, HOST_ENV, check, cotal, freshCfg, readJson, track, finishScenario } from "./harness.js";

// An earlier seed run under a umask of 0002 left Cotal's config folder and its extension tree
// group-writable, and the web seed's protected-path check refused them, failing `cotal update`.
// The update removes that write from the folders Cotal owns, as it does for its install, and the
// check still refuses a folder above them. PATH holds only node and npm, so `getent` is missing and
// the private-group proof is unavailable on every host, as it is under SSSD.
try {
  const npmOnPath = (HOST_ENV.PATH ?? "").split(delimiter).map((dir) => join(dir, "npm")).find((path) => existsSync(path));
  if (!npmOnPath) throw new Error("npm is not on PATH");
  const bin = track(mkdtempSync(join(tmpdir(), "cotal-seed-modes-bin-")));
  symlinkSync(process.execPath, join(bin, "node"));
  // The registry's latest tag is this build, so the update has nothing to fetch.
  const version = readJson(join(REPO, "bin", "package.json")).version as string;
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nif [ "$1" = view ]; then printf '"%s"\\n' '${version}'; exit 0; fi\nexec '${realpathSync(npmOnPath)}' "$@"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const env = { PATH: bin };
  /** A config folder whose extension tree an earlier seed created under a umask of 0002. */
  const seededUnder0002 = (): { cfg: string; tree: string[] } => {
    const cfg = track(freshCfg());
    const tree = ["", "extensions", "extensions/node_modules", "extensions/node_modules/@cotal-ai"].map((path) => join(cfg, "cotal", path));
    const prior = process.umask(0o002);
    try { mkdirSync(tree.at(-1)!, { recursive: true }); } finally { process.umask(prior); }
    return { cfg, tree };
  };
  const mode = (path: string) => statSync(path).mode & 0o777;
  const repairLine = (cfg: string) => `✓ removed group and other write from 4 entries in Cotal's config at ${join(cfg, "cotal")}`;

  {
    const { cfg, tree } = seededUnder0002();
    const run = cotal(cfg, ["update"], env);
    check("config modes: update repairs Cotal's group-writable config folder and exits 0", run.status === 0 && !run.stderr.includes("not protected against other local writers"), run.stderr);
    check("config modes: the repair is reported as the install repair is", run.stdout.includes(repairLine(cfg)), run.stdout);
    check("config modes: the config folder and its extension tree are 0755 after the repair", tree.every((path) => mode(path) === 0o755), tree.map(mode));
    check("config modes: the web dashboard was seeded into the repaired tree", cotal(cfg, ["ext", "list"]).stdout.includes("service-preset:web"));
  }

  {
    const { cfg, tree } = seededUnder0002();
    // XDG_CONFIG_HOME itself is a folder the operator chose, not one Cotal manages.
    chmodSync(cfg, 0o775);
    const run = cotal(cfg, ["update"], env);
    check("config modes: update still fails when a folder above the config folder is group-writable", run.status === 1 && run.stderr.includes(`✗ built-in connectors: failed to seed connector "web"`), run.stderr);
    check("config modes: Cotal's own folders below it are still repaired", run.stdout.includes(repairLine(cfg)) && tree.every((path) => mode(path) === 0o755), run.stdout);
    check("config modes: the folder Cotal does not manage stays group-writable", mode(cfg) === 0o775, mode(cfg));
    // The check reads the physical path, and the reason after the colon names what this host lacks.
    const physical = realpathSync(cfg);
    check("config modes: the refusal names that folder alone, with chmod g-w as its next step",
      run.stderr.includes(`the path is not protected against other local writers: ${physical} is group-writable and the private-group proof is unavailable: `) && run.stderr.includes(`Next\n  chmod g-w ${physical}\n`),
      run.stderr);
  }
} finally {
  finishScenario();
}

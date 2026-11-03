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
    check("config modes: update refuses a group-writable folder above the config folder before replacing the binary", run.status === 1 && run.stderr.includes("✗ config folder protection:") && run.stderr.includes(`Next\n  chmod g-w ${realpathSync(cfg)}`), run.stderr);
    check("config modes: the refusal does not seed or repair after the binary would have moved", !run.stderr.includes("failed to seed") && !run.stdout.includes(repairLine(cfg)), run.stdout + run.stderr);
    check("config modes: the folder Cotal does not manage stays group-writable", mode(cfg) === 0o775, mode(cfg));
    // The check reads the physical path. The ancestor is outside the folders update repairs.
    const physical = realpathSync(cfg);
    check("config modes: the refusal names that folder, with chmod g-w as its next step",
      run.stderr.includes(`the Cotal config folder is not protected against other local writers: ${physical} is group-writable`) && run.stderr.includes(`Next\n  chmod g-w ${physical}`),
      run.stderr);
  }

  {
    // An owned private config root may be reached through a symlink. The seed resolves that
    // physical directory before its protection walk, and update follows the same path.
    const real = track(freshCfg());
    chmodSync(real, 0o700);
    const link = track(join(tmpdir(), `cotal-seed-xdg-link-${real.split("/").at(-1)}`));
    symlinkSync(real, link);
    const run = cotal(link, ["update"], env);
    check("config modes: update accepts an owned private config root reached through a symlink", run.status === 0 && !run.stderr.includes("symbolic link"), run.stderr);
    check("config modes: the web dashboard was seeded through the symlinked config root", cotal(link, ["ext", "list"]).stdout.includes("service-preset:web"));
  }
} finally {
  finishScenario();
}

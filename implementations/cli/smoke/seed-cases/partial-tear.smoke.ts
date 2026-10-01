import { existsSync, rmSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 2b. a `{}` cursor with a missing on-disk package is repaired, not falsely reported success ────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    // PARTIAL tear: keep the manifest entry AND package.json, delete only the built entry (dist/index.js),
    // and leave an unactionable `{}` cursor. --repair must conservatively reinstall+verify every seeded
    // built-in (a surviving package.json is NOT proof of integrity) — never clear the cursor + succeed.
    const pkgDir = join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-hermes");
    const mainEntry = join(pkgDir, "dist", "index.js");
    if (existsSync(mainEntry)) {
      rmSync(mainEntry, { force: true }); // package.json survives; the built entry does not
      writeJson(join(seedDir(cfg), "reconcile.cursor.json"), {}); // parses, but names no package
      const rep = cotal(cfg, ["ext", "seed", "--repair"]);
      check("partial tear: --repair exits 0", rep.status === 0, rep.stderr);
      check("partial tear: the torn connector's entry file is actually restored", existsSync(mainEntry));
    } else {
      check("partial tear: hermes main entry present to tear", false, mainEntry);
    }
  }
} finally {
  finishScenario();
}

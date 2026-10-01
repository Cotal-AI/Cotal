import { existsSync, rmSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 4e. a malformed ({}) recovery journal + a damaged NON-main artifact recovers conservatively ──
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    // Delete a required non-main artifact (main survives, so a main-only check would miss it) and leave
    // a malformed `{}` recovery marker. A `{}` must be treated as CORRUPT (not an empty obligation), so
    // --repair reinstalls conservatively and restores the artifact rather than clearing over damage.
    const bundle = join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-opencode", "dist", "plugin", "index.js");
    if (existsSync(bundle)) {
      rmSync(bundle, { force: true });
      writeJson(join(seedDir(cfg), "reconcile.recovery.json"), {}); // parses, but names no obligation
      const auto = cotal(cfg, ["ext", "list"]);
      check("malformed recovery: an auto boot fails loud (a marker exists)", auto.status !== 0 && /interrupted/i.test(auto.stderr), auto.stderr);
      const rep = cotal(cfg, ["ext", "seed", "--repair"]);
      check("malformed recovery: --repair recovers conservatively and restores the non-main artifact", rep.status === 0 && existsSync(bundle), rep.stderr);
      check("malformed recovery: marker cleared only after success", !existsSync(join(seedDir(cfg), "reconcile.recovery.json")));
    } else {
      check("malformed recovery: opencode bundle present to damage", false, bundle);
    }
  }
} finally {
  finishScenario();
}

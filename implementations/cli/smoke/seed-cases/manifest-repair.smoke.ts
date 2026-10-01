import { writeFileSync, check, cotal, freshCfg, manifestPath, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 4. corrupt manifest with connectors still on disk → --repair rebuilds (not "kept removed") ────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    writeFileSync(manifestPath(cfg), "{ broken");
    const rep = cotal(cfg, ["ext", "seed", "--repair"]);
    check("on-disk rebuild: --repair exits 0 over a corrupt manifest", rep.status === 0, rep.stderr);
    check("on-disk rebuild: connectors still on disk are rebuilt, not reported removed", listNames(cfg).length === 6);
  }
} finally {
  finishScenario();
}

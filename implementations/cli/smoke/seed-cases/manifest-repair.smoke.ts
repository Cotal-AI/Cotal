import { dirname, join, readFileSync, readdirSync, writeFileSync, check, cotal, freshCfg, manifestPath, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 4. corrupt manifest with connectors still on disk → --repair rebuilds (not "kept removed") ────
  for (const args of [["ext", "seed", "--repair"], ["ext", "--repair", "seed"]]) {
    const cfg = track(freshCfg());
    listNames(cfg);
    writeFileSync(manifestPath(cfg), "{ broken");
    const rep = cotal(cfg, args);
    const label = args.join(" ");
    check(`on-disk rebuild: ${label} exits 0 over a corrupt manifest`, rep.status === 0, rep.stderr);
    check(`on-disk rebuild: ${label} rebuilds connectors still on disk, not reported removed`, listNames(cfg).length === 6);
    const dir = dirname(manifestPath(cfg));
    const quarantined = readdirSync(dir).filter((name) => name.startsWith("extensions.json.corrupt."));
    check(`on-disk rebuild: ${label} preserves the corrupt manifest in quarantine`, quarantined.length === 1 && readFileSync(join(dir, quarantined[0]!), "utf8") === "{ broken");
  }
} finally {
  finishScenario();
}

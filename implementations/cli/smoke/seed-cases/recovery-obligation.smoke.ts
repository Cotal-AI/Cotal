import { existsSync, rmSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 4d. a durable recovery obligation (repair SIGKILL'd after quarantine) is honored, not forgotten ─
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    // Simulate a --repair that recorded its obligation, quarantined state, then died before reinstalling:
    // a torn connector on disk + a durable recovery marker. The obligation must survive to the next run.
    const mainEntry = join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-hermes", "dist", "index.js");
    if (existsSync(mainEntry)) {
      rmSync(mainEntry, { force: true });
      writeJson(join(seedDir(cfg), "reconcile.recovery.json"), { rebuildFromDisk: true, repairAllSeeded: true });
      const auto = cotal(cfg, ["ext", "list"]);
      check("recovery obligation: an auto boot fails loud (does not stamp success over it)", auto.status !== 0 && /interrupted/i.test(auto.stderr), auto.stderr);
      const rep = cotal(cfg, ["ext", "seed", "--repair"]);
      check("recovery obligation: --repair honors it and restores the torn connector", rep.status === 0 && existsSync(mainEntry), rep.stderr);
      check("recovery obligation: the marker is cleared only after a successful commit", !existsSync(join(seedDir(cfg), "reconcile.recovery.json")));
    } else {
      check("recovery obligation: hermes main entry present to tear", false, mainEntry);
    }
  }
} finally {
  finishScenario();
}

import { rmSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 8. truncated authority never resurrects a removed connector ──────────────────────────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    cotal(cfg, ["ext", "remove", "@cotal-ai/connector-hermes"]);
    writeJson(join(seedDir(cfg), "authority.json"), { everSeeded: ["claude", "opencode", "pi"] }); // drop hermes
    rmSync(join(seedDir(cfg), "stamp.json"), { force: true }); // force a real reconcile
    cotal(cfg, ["ext", "seed"]);
    check("authority union: a truncated authority does not resurrect a removed connector", !listNames(cfg).includes("hermes"));
  }
} finally {
  finishScenario();
}

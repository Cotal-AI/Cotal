import { join, check, cotal, freshCfg, seedDir, readJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 3. removability + removed-stays-removed ──────────────────────────────────────────────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    const bad = cotal(cfg, ["ext", "remove", "connector:hermes"]);
    check("remove rejects a bad ref (provides-id) loudly", bad.status !== 0 && /no installed extension/i.test(bad.stderr), bad.stderr);
    cotal(cfg, ["ext", "remove", "@cotal-ai/connector-hermes"]);
    check("remove drops the connector", !listNames(cfg).includes("hermes"));
    listNames(cfg); // reconcile again
    check("removed connector stays removed across reconcile", !listNames(cfg).includes("hermes"));
    const ever = readJson(join(seedDir(cfg), "authority.json")).everSeeded;
    check("authority still records the removed connector as ever-seeded", ever.includes("hermes"));
  }
} finally {
  finishScenario();
}

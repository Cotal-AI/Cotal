import { join, check, cotal, freshCfg, seedDir, readJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 3. removability + removed-stays-removed ──────────────────────────────────────────────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    const bad = cotal(cfg, ["ext", "remove", "connector:hermes"]);
    check("remove rejects a bad ref (provides-id) loudly", bad.status === 1 && /invalid extension package name/i.test(bad.stderr), bad.stderr);
    const args = ["ext", "remove", "@cotal-ai/connector-hermes"];
    const removed = cotal(cfg, args);
    check("remove succeeds for an installed connector", removed.status === 0, removed.stderr);
    check("remove drops the connector", !listNames(cfg).includes("hermes"));
    const repeated = cotal(cfg, args);
    check("removing the same connector again exits 0 with a no-change receipt",
      repeated.status === 0 && repeated.stdout === "@cotal-ai/connector-hermes is already absent. Nothing was removed.\n", repeated.stdout + repeated.stderr);
    listNames(cfg); // reconcile again
    check("removed connector stays removed across reconcile", !listNames(cfg).includes("hermes"));
    const ever = readJson(join(seedDir(cfg), "authority.json")).everSeeded;
    check("authority still records the removed connector as ever-seeded", ever.includes("hermes"));
  }
} finally {
  finishScenario();
}

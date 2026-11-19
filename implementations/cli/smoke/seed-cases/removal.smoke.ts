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
    const repaired = cotal(cfg, ["ext", "seed", "--repair"]);
    check("repair keeps the removed connector", repaired.status === 0 && /kept removed hermes/.test(repaired.stdout), repaired);
    const before = cotal(cfg, ["ext", "list", "--plain"]);
    for (const flags of [["--repair", "--reset"], ["--repair", "--force"], ["--reset", "--force"]]) {
      const conflict = cotal(cfg, ["ext", "seed", ...flags]);
      const after = cotal(cfg, ["ext", "list", "--plain"]);
      check(`seed ${flags.join(" ")} refuses without changing the inventory`, conflict.status === 1 && conflict.stdout === "" && /only one of --repair, --reset, or --force/.test(conflict.stderr) &&
        before.status === 0 && after.status === 0 && after.stdout === before.stdout && !after.stdout.includes("connector:hermes"), conflict);
    }
    const reset = cotal(cfg, ["ext", "seed", "--reset"]);
    check("standalone reset restores the removed connector", reset.status === 0 && listNames(cfg).includes("hermes"), reset);
  }
} finally {
  finishScenario();
}

import { existsSync, join, check, cotal, freshCfg, seedDir, manifestPath, readJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 2. forged COTAL_EXT_SEEDING gets no seed-child treatment ──────────────────────────────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    const gen = readJson(join(seedDir(cfg), "stamp.json")).generation;
    cotal(cfg, ["ext", "remove", "@cotal-ai/connector-opencode"]);
    const store = join(seedDir(cfg), "store", gen, "opencode");
    if (existsSync(store)) {
      cotal(cfg, ["ext", "add", store], { COTAL_EXT_SEEDING: "1", COTAL_EXT_SEEDING_PARENT: "1" });
      const src = readJson(manifestPath(cfg)).extensions.find((e: { pkg: string }) => e.pkg === "@cotal-ai/connector-opencode")?.source;
      check("forged env: a forged marker yields a normal operator add (no source:seeded)", src === undefined, src);
    } else {
      check("forged env: store payload present", false, store);
    }
  }
} finally {
  finishScenario();
}

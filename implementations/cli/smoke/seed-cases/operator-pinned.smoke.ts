import { rmSync, join, check, cotal, freshCfg, seedDir, manifestPath, readJson, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 9. operator-pinned official entry not auto-refreshed on upgrade (source-aware) ───────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    const mp = manifestPath(cfg);
    const m = readJson(mp);
    for (const e of m.extensions) if (e.pkg === "@cotal-ai/connector-hermes") { delete e.source; e.version = "9.9.9"; e.spec = "@cotal-ai/connector-hermes@9.9.9"; }
    writeJson(mp, m);
    rmSync(join(seedDir(cfg), "stamp.json"), { force: true }); // simulate an upgrade → a refresh pass
    cotal(cfg, ["ext", "seed"]);
    const hv = readJson(mp).extensions.find((e: { pkg: string }) => e.pkg === "@cotal-ai/connector-hermes")?.version;
    check("source-aware: operator-pinned official version preserved (not auto-refreshed)", hv === "9.9.9", hv);
  }
} finally {
  finishScenario();
}

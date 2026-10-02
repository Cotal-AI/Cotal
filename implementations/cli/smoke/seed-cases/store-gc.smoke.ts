import { existsSync, mkdirSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 8c. the store's DESTRUCTIVE step is announced too (#593) ─────────────────────────────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg); // seed once, so a live generation exists beside the one we plant
    const sd = seedDir(cfg);
    const storeRoot = join(sd, "store");
    // Plant an unreferenced older generation: no manifest entry installs from it, which is exactly the
    // condition gcSeedStore removes on. It is a directory with a payload in it, not an empty shell, so
    // the removal is a real recursive delete of operator-global bytes.
    const stale = join(storeRoot, "0.0.1-stale", "opencode");
    mkdirSync(stale, { recursive: true });
    writeJson(join(stale, "package.json"), { name: "@cotal-ai/connector-opencode", version: "0.0.1-stale" });
    const forced = cotal(cfg, ["ext", "seed", "--force"]);
    check("gc: the unreferenced generation is actually removed", forced.status === 0 && !existsSync(join(storeRoot, "0.0.1-stale")), forced.stderr);
    check("provenance: the machine-wide seed-store DELETE is announced with its path (not silent)",
      forced.stderr.includes("removed operator-global seed store generation (0.0.1-stale)") &&
        forced.stderr.includes(join(storeRoot, "0.0.1-stale")),
      forced.stderr);
  }
} finally {
  finishScenario();
}

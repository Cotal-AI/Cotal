import { chmodSync, existsSync, mkdirSync, readFileSync, readJson, statSync, symlinkSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";
import { gcSeedStore } from "../../src/seed/store.js";

try {
  // ── 8c. the store's DESTRUCTIVE step is announced too (#593) ─────────────────────────────────────
  {
    const cfg = track(freshCfg());
    check("gc: fresh-store seed succeeds before planting an older generation", listNames(cfg).length === 6);
    const sd = seedDir(cfg);
    const currentGeneration: string = readJson(join(sd, "stamp.json")).generation;
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

    // An older release could leave a read-only staging tree after its seed failed (#7257).
    // Repair must remove that generation, not just reconcile the current connectors successfully.
    const oldGeneration = join(storeRoot, "0.165.4");
    const staging = join(oldGeneration, "claude.staging");
    const dist = join(staging, "dist");
    mkdirSync(dist, { recursive: true });
    const metadata = join(dist, "leftover.json");
    writeJson(metadata, { name: "@cotal-ai/connector-claude-code", version: "0.165.4" });
    const outside = join(cfg, "outside-store");
    mkdirSync(outside);
    writeJson(join(outside, "preserved.json"), { preserved: true });
    if (process.platform !== "win32") {
      symlinkSync(outside, join(staging, "outside-link"));
      chmodSync(outside, 0o555);
      chmodSync(metadata, 0o444);
      for (const dir of [dist, staging, oldGeneration]) chmodSync(dir, 0o555);
    }
    try {
      const repaired = cotal(cfg, ["ext", "seed", "--repair"]);
      check("gc: repair removes an older read-only staging generation", repaired.status === 0 && !existsSync(oldGeneration), repaired.stderr);
      check("gc: repair retains the current generation", existsSync(join(storeRoot, currentGeneration, "claude", "package.json")));
      check("gc: cleanup leaves a symlink target untouched", readJson(join(outside, "preserved.json")).preserved === true &&
        (process.platform === "win32" || (statSync(outside).mode & 0o777) === 0o555));
    } finally {
      for (const dir of [oldGeneration, staging, dist, outside]) if (existsSync(dir)) chmodSync(dir, 0o755);
    }

    // Reference and current-generation guards must run before chmod, not only before removal.
    const retained = join(storeRoot, "0.165.5", "claude");
    mkdirSync(retained, { recursive: true });
    const retainedMetadata = join(retained, "package.json");
    writeJson(retainedMetadata, { retained: true });
    const before = readFileSync(retainedMetadata, "utf8");
    const currentDir = join(storeRoot, currentGeneration);
    if (process.platform !== "win32") {
      chmodSync(retained, 0o555);
      chmodSync(currentDir, 0o555);
    }
    const priorXdg = process.env.XDG_CONFIG_HOME;
    const priorAllow = process.env.COTAL_ALLOW_CHECKOUT_SEED;
    try {
      process.env.XDG_CONFIG_HOME = cfg;
      process.env.COTAL_ALLOW_CHECKOUT_SEED = "1";
      gcSeedStore(currentGeneration, [retained]);
      check("gc: a referenced older generation keeps its bytes", readFileSync(retainedMetadata, "utf8") === before);
      check("gc: retained generations keep their directory modes", process.platform === "win32" ||
        ((statSync(retained).mode & 0o777) === 0o555 && (statSync(currentDir).mode & 0o777) === 0o555));
    } finally {
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorXdg;
      if (priorAllow === undefined) delete process.env.COTAL_ALLOW_CHECKOUT_SEED;
      else process.env.COTAL_ALLOW_CHECKOUT_SEED = priorAllow;
      chmodSync(retained, 0o755);
      chmodSync(currentDir, 0o755);
    }
  }
} finally {
  finishScenario();
}

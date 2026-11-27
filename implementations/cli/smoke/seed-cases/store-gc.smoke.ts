import { chmodSync, existsSync, mkdirSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";

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
    const generation = join(storeRoot, "0.0.1-stale");
    const stale = join(generation, "opencode");
    const staging = join(generation, "claude.staging");
    const dist = join(staging, "dist");
    mkdirSync(stale, { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeJson(join(stale, "package.json"), { name: "@cotal-ai/connector-opencode", version: "0.0.1-stale" });
    writeJson(join(dist, "partial.json"), { interrupted: true });
    // Older releases left read-only staging trees after a failed seed (#7257).
    const directories = [generation, stale, staging, dist];
    try {
      for (const file of [join(stale, "package.json"), join(dist, "partial.json")]) chmodSync(file, 0o444);
      for (const dir of directories) chmodSync(dir, 0o555);
      const repaired = cotal(cfg, ["ext", "seed", "--repair"]);
      check("gc: the unreferenced generation is actually removed", repaired.status === 0 && !existsSync(generation), repaired.stderr);
      check("provenance: the machine-wide seed-store DELETE is announced with its path (not silent)",
        repaired.stderr.includes("removed operator-global seed store generation (0.0.1-stale)") &&
          repaired.stderr.includes(generation),
        repaired.stderr);
    } finally {
      // Leave a failed regression removable without hiding its original assertions.
      for (const dir of directories) if (existsSync(dir)) chmodSync(dir, 0o700);
    }
    if (process.getuid && process.getuid() !== 0) {
      const blocked = join(storeRoot, "0.0.1-blocked");
      mkdirSync(blocked);
      // The generation's own permissions can be repaired, but removal requires a writable parent.
      chmodSync(storeRoot, 0o555);
      try {
        const updated = cotal(cfg, ["update"]);
        const warnings = updated.stderr.split("\n").filter(line => line.includes("could not remove old seed-store generation"));
        check("update continues past an old seed-store generation that cannot be removed",
          updated.status === 0 && existsSync(blocked) && warnings.length === 1 &&
            warnings[0]!.includes(blocked) && /EACCES|EPERM/.test(warnings[0]!) && warnings[0]!.includes("left in place") &&
            updated.stdout.includes("connector integrations refreshed") && updated.stdout.includes("operator extensions: none installed"),
          updated.stdout + updated.stderr);
      } finally {
        chmodSync(storeRoot, 0o700);
      }
    }
  }
} finally {
  finishScenario();
}

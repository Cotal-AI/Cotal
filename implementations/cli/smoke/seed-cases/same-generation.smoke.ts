import { existsSync, rmSync, join, check, cotal, freshCfg, seedDir, manifestPath, readJson, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 8b. a built-in added at an UNCHANGED generation still seeds (fast-path coverage) ─────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    // Simulate a prefix stamped BEFORE codex joined the built-in set: strip codex from the manifest,
    // its installed files, and BOTH authority records (never-seeded, not removed) — while the stamp
    // stays at the CURRENT generation. The old generation-only fast path NOOPed forever here.
    const mp = manifestPath(cfg);
    const m = readJson(mp);
    m.extensions = m.extensions.filter((e: { pkg: string }) => e.pkg !== "@cotal-ai/connector-codex");
    writeJson(mp, m);
    rmSync(join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-codex"), { recursive: true, force: true });
    for (const f of ["authority.json", "authority.bak.json"]) {
      const p2 = join(seedDir(cfg), f);
      if (existsSync(p2)) {
        const a = readJson(p2);
        a.everSeeded = (a.everSeeded as string[]).filter((n) => n !== "codex");
        writeJson(p2, a);
      }
    }
    // Drive it through `cotal` directly rather than listNames(), because this block is the one place a
    // command reaches the stager with an INTACT payload already in the store: codex was stripped from
    // the manifest and from disk but never from `store/<generation>/codex`, so the re-seed takes the
    // stager's idempotent early return. That path copies nothing, so it must announce nothing, and the
    // only way to see that is to read this command's stderr.
    const reseed = cotal(cfg, ["ext", "list"]); // any auto command must notice the unaccounted built-in and seed it
    const names = ["claude", "opencode", "codex", "hermes", "pi"].filter((n) => reseed.stdout.includes(`connector:${n}`));
    check("same-generation built-in add: auto reconcile seeds the missing built-in", names.includes("codex"), names);
    check("provenance: a re-seed that reuses an intact payload announces no seed-store write",
      !reseed.stderr.includes("seed store payload"), reseed.stderr);
  }
} finally {
  finishScenario();
}

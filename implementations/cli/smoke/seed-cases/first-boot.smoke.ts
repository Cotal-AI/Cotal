import { existsSync, statSync, join, boot, check, cotal, freshCfg, seedDir, readJson, track, finishScenario } from "./harness.js";

try {
  // ── 1. first-run auto-seed + state files ─────────────────────────────────────────────────────────
  {
    const cfg = track(freshCfg());
    const first = boot(cfg); // the auto-seed boot; surface its output if it fails
    const listed = cotal(cfg, ["ext", "list"]).stdout;
    const names = ["claude", "opencode", "codex", "hermes", "jcode", "pi"].filter((n) => listed.includes(`connector:${n}`));
    if (names.length !== 6) console.log(`[diag] auto-seed status=${first.status}\n--stdout--\n${listed}\n--stderr--\n${first.stderr}`);
    check("auto-seed: all six connectors seeded on first command", names.length === 6, names);
    check("auto-seed: the web dashboard seeded on first command (service-preset:web)", listed.includes("service-preset:web"), listed);
    const sd = seedDir(cfg);
    check("auto-seed: authority/witness/stamp written", ["authority.json", "witness.json", "stamp.json"].every((f) => existsSync(join(sd, f))));
    const ever = readJson(join(sd, "authority.json")).everSeeded.slice().sort();
    check("auto-seed: authority records all seven first-party exts", ever.join(",") === "claude,codex,hermes,jcode,opencode,pi,web", ever);

    const storeRoot = join(cfg, "cotal", "seed", "store");
    const generation = readJson(join(sd, "stamp.json")).generation;
    const openCodePayload = join(storeRoot, generation, "opencode");
    check("automatic seeding keeps payload paths off the screen", existsSync(join(openCodePayload, "package.json")) &&
      !`${first.stdout}${first.stderr}`.includes(storeRoot), first.stderr);

    const explicitCfg = track(freshCfg());
    const explicit = cotal(explicitCfg, ["ext", "seed"]);
    const explicitRoot = join(seedDir(explicitCfg), "store");
    const explicitPayload = join(explicitRoot, generation, "opencode");
    check("provenance: the machine-wide seed-store write is announced with its path (not silent)",
      explicit.status === 0 && explicit.stderr.includes("wrote operator-global seed store payload") && explicit.stderr.includes(explicitRoot),
      explicit.stderr);
    check("provenance: the announced destination is the payload directory itself, not just the store root",
      explicit.stderr.includes(`operator-global seed store payload (opencode): ${explicitPayload}`) && existsSync(join(explicitPayload, "package.json")),
      explicit.stderr);

    // 2. idempotent no-op: stamp untouched on a second boot, and NO seed-store write is announced, since
    // the announce tracks a real materialization, not every boot (the fast path copies nothing).
    const m1 = statSync(join(sd, "stamp.json")).mtimeMs;
    const second = boot(cfg);
    const m2 = statSync(join(sd, "stamp.json")).mtimeMs;
    check("idempotent: stamp untouched across boots (fast-path, no re-seed)", m1 === m2);
    check("provenance: the idempotent no-op boot announces no seed-store write (announce tracks writes, not boots)",
      !second.stderr.includes("seed store payload"), second.stderr);
  }
} finally {
  finishScenario();
}

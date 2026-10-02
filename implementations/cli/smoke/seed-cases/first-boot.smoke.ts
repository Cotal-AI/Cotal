import { existsSync, statSync, join, check, cotal, freshCfg, seedDir, readJson, track, finishScenario } from "./harness.js";

try {
  // ── 1. first-run auto-seed + state files ─────────────────────────────────────────────────────────
  {
    const cfg = track(freshCfg());
    const first = cotal(cfg, ["ext", "list"]); // the auto-seed boot; surface its output if it fails
    const names = ["claude", "opencode", "codex", "hermes", "jcode", "pi"].filter((n) => first.stdout.includes(`connector:${n}`));
    if (names.length !== 6) console.log(`[diag] auto-seed status=${first.status}\n--stdout--\n${first.stdout}\n--stderr--\n${first.stderr}`);
    check("auto-seed: all six connectors seeded on first command", names.length === 6, names);
    check("auto-seed: the web dashboard seeded on first command (command:web)", first.stdout.includes("command:web"), first.stdout);
    const sd = seedDir(cfg);
    check("auto-seed: authority/witness/stamp written", ["authority.json", "witness.json", "stamp.json"].every((f) => existsSync(join(sd, f))));
    const ever = readJson(join(sd, "authority.json")).everSeeded.slice().sort();
    check("auto-seed: authority records all seven first-party exts", ever.join(",") === "claude,codex,hermes,jcode,opencode,pi,web", ever);

    // The operator-global seed-store write must not be silent (#593): re-seeding `~/.config/cotal/seed/store`
    // from a non-released checkout makes those bytes the machine-wide payload for the version key, so the
    // reconcile announces each materialization with its path on the provenance channel (stderr).
    const storeRoot = join(cfg, "cotal", "seed", "store");
    // The EXACT destination, not merely the store root: a line naming the root, or a sibling under it,
    // would satisfy a substring check while no longer naming the directory that was actually written.
    const generation = readJson(join(sd, "stamp.json")).generation;
    const openCodePayload = join(storeRoot, generation, "opencode");
    check("provenance: the machine-wide seed-store write is announced with its path (not silent)",
      first.stderr.includes("wrote operator-global seed store payload") && first.stderr.includes(storeRoot),
      first.stderr);
    check("provenance: the announced destination is the payload directory itself, not just the store root",
      first.stderr.includes(`operator-global seed store payload (opencode): ${openCodePayload}`) && existsSync(join(openCodePayload, "package.json")),
      first.stderr);

    // 2. idempotent no-op: stamp untouched on a second boot, and NO seed-store write is announced, since
    // the announce tracks a real materialization, not every boot (the fast path copies nothing).
    const m1 = statSync(join(sd, "stamp.json")).mtimeMs;
    const second = cotal(cfg, ["ext", "list"]);
    const m2 = statSync(join(sd, "stamp.json")).mtimeMs;
    check("idempotent: stamp untouched across boots (fast-path, no re-seed)", m1 === m2);
    check("provenance: the idempotent no-op boot announces no seed-store write (announce tracks writes, not boots)",
      !second.stderr.includes("seed store payload"), second.stderr);
  }
} finally {
  finishScenario();
}

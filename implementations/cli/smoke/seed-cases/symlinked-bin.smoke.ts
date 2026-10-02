import { spawnSync, existsSync, mkdtempSync, symlinkSync, tmpdir, join, REPO, BIN, check, HOST_ENV, freshCfg, seedDir, readJson, track, finishScenario } from "./harness.js";

try {
  // ── the GLOBAL-INSTALL shape: the binary reached through a bin SYMLINK ────────────────────────────
  // `npm i -g cotal-ai` publishes `<prefix>/bin/cotal` as a symlink INTO the package, and Node leaves
  // `process.argv[1]` pointing at the symlink, whose own parents hold no `package.json` and no
  // `seeded-connectors/`. Every other case here spawns the real `dist/cotal.js` (an entry that happens to
  // sit inside the package), so this is the only one that covers how an installed binary is actually run.
  // Skipped on Windows: npm publishes `.cmd`/`.ps1` shims there that exec the real path, so the symlink
  // shape does not exist, and unprivileged `symlinkSync` is EPERM regardless.
  if (process.platform !== "win32") {
    const cfg = track(freshCfg());
    const linkDir = track(mkdtempSync(join(tmpdir(), "cotal-seed-binlink-")));
    const link = join(linkDir, "cotal");
    symlinkSync(BIN, link);
    const r = spawnSync("node", [link, "ext", "list"], {
      encoding: "utf8",
      env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1" },
    });
    const out = r.stdout ?? "";
    const names = ["claude", "opencode", "codex", "hermes", "jcode", "pi"].filter((n) => out.includes(`connector:${n}`));
    if (names.length !== 6) console.log(`[diag] symlinked boot status=${r.status}\n--stdout--\n${out}\n--stderr--\n${r.stderr}`);
    check("symlinked bin: boot resolves the generation (no 'cannot determine' fail)", !/cannot determine the seed generation/.test(r.stderr ?? ""), r.stderr);
    check("symlinked bin: all six built-ins seeded", names.length === 6, names);
    // The generation must be the cotal-ai VERSION, i.e. resolved through the link into the package —
    // not some unrelated `package.json` found by walking up out of the link's own directory.
    const version = readJson(join(REPO, "bin", "package.json")).version;
    check("symlinked bin: generation is the cotal-ai version (walked from the real path)", readJson(join(seedDir(cfg), "stamp.json")).generation === version, version);
    check("symlinked bin: payloads copied into that generation's durable store", existsSync(join(seedDir(cfg), "store", version)));
  }
} finally {
  finishScenario();
}

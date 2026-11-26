import { boot, existsSync, mkdirSync, rmSync, writeFileSync, join, check, cotal, freshCfg, seedDir, manifestPath, readJson, writeJson, listNames, seedGeneration, track, finishScenario } from "./harness.js";

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
    const reseed = boot(cfg); // any command that is not a read must notice the unaccounted built-in and seed it
    const listed = cotal(cfg, ["ext", "list"]).stdout;
    const names = ["claude", "opencode", "codex", "hermes", "pi"].filter((n) => listed.includes(`connector:${n}`));
    check("same-generation built-in add: auto reconcile seeds the missing built-in", names.includes("codex"), names);
    check("provenance: a re-seed that reuses an intact payload announces no seed-store write",
      !reseed.stderr.includes("seed store payload"), reseed.stderr);
  }
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    const pkg = "@cotal-ai/spec-less-fixture";
    const version = seedGeneration();
    const fixture = join(cfg, "fixture");
    mkdirSync(fixture);
    writeJson(join(fixture, "package.json"), { name: pkg, version, type: "module", peerDependencies: { "@cotal-ai/core": "*" } });
    writeFileSync(join(fixture, "index.js"), `import { registry } from "@cotal-ai/core";
registry.register({ kind: "command", name: "spec-less-fixture", summary: "Test extension", run() {} });
`);
    const offline = { npm_config_offline: "true" };
    const added = cotal(cfg, ["ext", "add", fixture], offline);
    check("install spec fixture: real npm installs the operator package", added.status === 0, added.stderr);
    const mp = manifestPath(cfg);
    const manifest = readJson(mp);
    const operator = manifest.extensions.find((entry: { pkg: string }) => entry.pkg === pkg);
    delete operator.spec;
    writeJson(mp, manifest);
    const oldStore = join(seedDir(cfg), "store", "0.0.1-retained");
    mkdirSync(oldStore);

    const listed = cotal(cfg, ["ext", "list", "--json"], offline);
    const row = listed.status === 0 && JSON.parse(listed.stdout).result.items.find((entry: { pkg: string }) => entry.pkg === pkg);
    check("extension inventory lists the installed version without inventing a recorded spec",
      row?.version === version && !Object.hasOwn(row, "spec"), listed.stdout + listed.stderr);
    const updated = cotal(cfg, ["update"], offline);
    check("update verifies the installed first-party operator package without its spec",
      updated.status === 0 && updated.stdout.includes(`verified ${pkg}@${version}`), updated.stdout + updated.stderr);
    check("a missing spec does not prove an older seed store is unreferenced", existsSync(oldStore));

    const after = readJson(mp);
    const builtin = after.extensions.find((entry: { pkg: string }) => entry.pkg === "@cotal-ai/connector-claude-code");
    delete builtin.spec;
    writeJson(mp, after);
    const repaired = cotal(cfg, ["update"], offline);
    const restored = readJson(mp).extensions.find((entry: { pkg: string }) => entry.pkg === builtin.pkg);
    check("update repairs a missing built-in spec from the shipped payload",
      repaired.status === 0 && restored?.spec === join(seedDir(cfg), "store", version, "claude"), repaired.stdout + repaired.stderr);
  }
} finally {
  finishScenario();
}

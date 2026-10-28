import { existsSync, mkdirSync, rmSync, writeFileSync, join, check, cotal, freshCfg, manifestPath, readJson, seedDir, listNames, track, finishScenario } from "./harness.js";

/**
 * A readable manifest entry whose package directory is gone must not fail `ext seed --reset`.
 * The entry is either already missing, or present but absent from the prefix dependencies so
 * npm removes it while installing the first built-in. Both used to die while linking that
 * package's peers, leave an add-phase cursor, and keep the entry. Reset reports the package,
 * removes the entry, seeds the built-ins and leaves no cursor. Repair of the same shape does too.
 */
try {
  const fake = "@fixture/gone-connector";
  const plant = (cfg: string, present: boolean): void => {
    listNames(cfg);
    const manifest = readJson(manifestPath(cfg));
    manifest.extensions.push({ pkg: fake, version: "1.0.0", spec: `${fake}@1.0.0`, commands: [] });
    writeFileSync(manifestPath(cfg), JSON.stringify(manifest));
    if (!present) return;
    const dir = join(cfg, "cotal", "extensions", "node_modules", fake);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: fake, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
    writeFileSync(join(dir, "index.js"), "export {};\n");
  };
  const pkgs = (cfg: string): string[] => readJson(manifestPath(cfg)).extensions.map((entry: { pkg: string }) => entry.pkg);

  {
    const cfg = track(freshCfg());
    plant(cfg, false);
    const reset = cotal(cfg, ["ext", "seed", "--reset"]);
    check("missing package: reset exits 0", reset.status === 0, reset.stderr);
    check("missing package: reset names the entry and removes it", reset.stderr.includes(`removed ${fake} from the extensions manifest`) && !pkgs(cfg).includes(fake), reset.stderr);
    check("missing package: reset leaves no cursor and the built-ins", !existsSync(join(seedDir(cfg), "reconcile.cursor.json")) && listNames(cfg).length === 6);
    const again = cotal(cfg, ["sync"]);
    check("missing package: a later seeding command is not refused", again.status === 0 && !/connector seed/.test(again.stderr), again.stderr);
  }

  {
    const cfg = track(freshCfg());
    plant(cfg, true);
    const before = join(cfg, "cotal", "extensions", "node_modules", fake, "package.json");
    check("pruned package: the fixture package exists before reset and is not a prefix dependency", existsSync(before) && !JSON.stringify(readJson(join(cfg, "cotal", "extensions", "package.json")).dependencies ?? {}).includes(fake));
    const reset = cotal(cfg, ["ext", "seed", "--reset"]);
    check("pruned package: reset exits 0", reset.status === 0, reset.stderr);
    check("pruned package: reset removes the entry and leaves no package and no cursor", reset.stderr.includes(`removed ${fake} from the extensions manifest`) && !pkgs(cfg).includes(fake) && !existsSync(before) && !existsSync(join(seedDir(cfg), "reconcile.cursor.json")), reset.stderr);
    check("pruned package: the built-ins are seeded", listNames(cfg).length === 6);
  }

  {
    const cfg = track(freshCfg());
    plant(cfg, false);
    const repair = cotal(cfg, ["ext", "seed", "--repair"]);
    check("missing package: repair exits 0 and removes the entry", repair.status === 0 && repair.stderr.includes(`removed ${fake} from the extensions manifest`) && !pkgs(cfg).includes(fake) && !existsSync(join(seedDir(cfg), "reconcile.cursor.json")), repair.stderr);
  }

  {
    // A seeded built-in whose package directory is gone is reinstalled by repair. The absence was
    // observed before that reinstall, and the cleanup must not delete the entry it just restored.
    const cfg = track(freshCfg());
    listNames(cfg);
    const hermes = "@cotal-ai/connector-hermes";
    const dir = join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-hermes");
    rmSync(dir, { recursive: true, force: true });
    const repair = cotal(cfg, ["ext", "seed", "--repair"]);
    check("missing seeded built-in: repair exits 0 and keeps the restored entry", repair.status === 0 && pkgs(cfg).includes(hermes) && existsSync(join(dir, "package.json")) && !existsSync(join(seedDir(cfg), "reconcile.cursor.json")), repair.stderr);
    check("missing seeded built-in: a later boot still lists the connector", listNames(cfg).includes("hermes"));
  }
} finally {
  finishScenario();
}

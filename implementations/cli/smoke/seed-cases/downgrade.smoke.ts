import { readFileSync, readdirSync, join, REPO, boot, check, cotal, freshCfg, seedDir, readJson, writeJson, listNames, manifestPath, track, finishScenario } from "./harness.js";

try {
  // This binary can protect its own writes, not change a pre-guard released executable.
  const cfg = track(freshCfg());
  boot(cfg);
  const stamp = join(seedDir(cfg), "stamp.json");
  const currentStamp = readFileSync(stamp);
  writeJson(stamp, { generation: "99.0.0" });
  const before = readFileSync(stamp);
  const manifestBefore = readFileSync(manifestPath(cfg));
  const storeBefore = readdirSync(join(seedDir(cfg), "store")).sort().join(",");

  const r = boot(cfg);
  const said = `${r.stdout}${r.stderr}`;
  check("downgrade: an older binary REFUSES a store stamped newer", r.status !== 0, r.status);
  check("downgrade: the refusal names both generations", /is older than the seed store's generation 99\.0\.0/.test(said), said.slice(0, 300));
  check("downgrade: the refusal names the way out", /run the newer cotal/.test(said) && !/ext seed --(?:force|reset)/.test(said), said.slice(0, 300));
  check("downgrade: stamp.json is byte-identical after the refusal", readFileSync(stamp).equals(before));
  check("downgrade: no store generation added or removed", readdirSync(join(seedDir(cfg), "store")).sort().join(",") === storeBefore, storeBefore);

  for (const mode of ["--force", "--reset", "--repair"]) {
    const refused = cotal(cfg, ["ext", "seed", mode]);
    check(`downgrade: ${mode} cannot replace a newer shared generation`, refused.status !== 0 && /is older than the seed store's generation/.test(refused.stderr), refused.stderr.slice(0, 300));
    check(`downgrade: ${mode} preserves the stamp and extension manifest`, readFileSync(stamp).equals(before) && readFileSync(manifestPath(cfg)).equals(manifestBefore));
    check(`downgrade: ${mode} preserves every store generation`, readdirSync(join(seedDir(cfg), "store")).sort().join(",") === storeBefore);
  }

  // Put back this fixture's actual stamp, then retain same-generation maintenance controls.
  writeJson(stamp, JSON.parse(currentStamp.toString()));
  const force = cotal(cfg, ["ext", "seed", "--force"]);
  check("downgrade: same-generation force remains supported", force.status === 0, force.stderr.slice(0, 300));
  check("downgrade: same-generation maintenance keeps this binary's generation", readJson(stamp).generation === readJson(join(REPO, "bin", "package.json")).version);
  check("downgrade: ordinary commands work after same-generation maintenance", listNames(cfg).length === 6);
} finally {
  finishScenario();
}

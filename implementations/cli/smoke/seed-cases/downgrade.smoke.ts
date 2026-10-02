import { readFileSync, readdirSync, join, REPO, check, cotal, freshCfg, seedDir, readJson, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── an OLDER binary must refuse a store stamped NEWER, and write nothing ─────────────────────────
  // Without the refusal an older cotal misses the stamp fast path, refreshes nothing (the refresh
  // fires only when the running binary is strictly newer), and then writes its own older generation
  // over the stamp at the commit. The store ends up claiming a generation whose payloads are not the
  // ones installed, and the next command from the newer binary reinstalls every connector to stamp it
  // back, so two binaries alternating flap the store and pay a full reseed each way.
  //
  // The store is stamped 99.0.0 rather than running an actually-old build: a released older binary
  // does not carry this guard and never will, so pointing one at a newer store proves nothing about
  // the fix. 99.0.0 is newer than any binary that will ever run this suite, which is the same
  // comparison from the side the guard can actually defend.
  {
    const cfg = track(freshCfg());
    cotal(cfg, ["ext", "list"]); // seed it normally first
    const stamp = join(seedDir(cfg), "stamp.json");
    writeJson(stamp, { generation: "99.0.0" });
    const before = readFileSync(stamp);
    const storeBefore = readdirSync(join(seedDir(cfg), "store")).sort().join(",");

    const r = cotal(cfg, ["ext", "list"]);
    const said = `${r.stdout}${r.stderr}`;
    check("downgrade: an older binary REFUSES a store stamped newer", r.status !== 0, r.status);
    check("downgrade: the refusal names both generations", /is older than the seed store's generation 99\.0\.0/.test(said), said.slice(0, 300));
    check(
      "downgrade: the refusal names the way out",
      /ext seed --force/.test(said) && !/ext seed --reset/.test(said),
      said.slice(0, 300),
    );
    // The point of the guard is that it writes NOTHING, so assert the bytes, not just the exit code.
    check("downgrade: stamp.json is byte-identical after the refusal", readFileSync(stamp).equals(before));
    check("downgrade: no store generation added or removed", readdirSync(join(seedDir(cfg), "store")).sort().join(",") === storeBefore, storeBefore);

    // A refusal that prescribes a fix has to have a working fix, or it is a wedge with instructions.
    const force = cotal(cfg, ["ext", "seed", "--force"]);
    check("downgrade: `ext seed --force` recovers the store", force.status === 0, force.stderr.slice(0, 300));
    check("downgrade: the stamp is this binary's generation again", readJson(stamp).generation === readJson(join(REPO, "bin", "package.json")).version);
    check("downgrade: ordinary commands work after the force rebuild", listNames(cfg).length === 6);
  }
} finally {
  finishScenario();
}

import { join, check, cotal, freshCfg, seedDir, readJson, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 4b. an invalid version stamp does not make --repair loop forever (semver fail-loud + recover) ─
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    writeJson(join(seedDir(cfg), "stamp.json"), { generation: "0.bad.0" }); // parses as JSON, not as semver
    const auto = cotal(cfg, ["ext", "list"]);
    check("invalid stamp: auto boot fails loud (prescribes --repair)", auto.status !== 0 && /repair/i.test(auto.stderr), auto.stderr);
    const rep = cotal(cfg, ["ext", "seed", "--repair"]);
    check("invalid stamp: --repair recovers instead of re-emitting the same error (no loop)", rep.status === 0, rep.stderr);
    const gen = readJson(join(seedDir(cfg), "stamp.json")).generation;
    check("invalid stamp: --repair wrote a valid stamp", /^\d+\.\d+\.\d+/.test(gen), gen);
  }
} finally {
  finishScenario();
}

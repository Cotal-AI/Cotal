import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 2b. a `{}` cursor with a missing on-disk package is repaired, not falsely reported success ────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    // PARTIAL tear: keep the manifest entry AND package.json, delete only the built entry (dist/index.js),
    // and leave an unactionable `{}` cursor. --repair must conservatively reinstall+verify every seeded
    // built-in (a surviving package.json is NOT proof of integrity) — never clear the cursor + succeed.
    const pkgDir = join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-hermes");
    const mainEntry = join(pkgDir, "dist", "index.js");
    if (existsSync(mainEntry)) {
      rmSync(mainEntry, { force: true }); // package.json survives; the built entry does not
      writeJson(join(seedDir(cfg), "reconcile.cursor.json"), {}); // parses, but names no package
      const rep = cotal(cfg, ["ext", "seed", "--repair"]);
      check("partial tear: --repair exits 0", rep.status === 0, rep.stderr);
      check("partial tear: the torn connector's entry file is actually restored", existsSync(mainEntry));
    } else {
      check("partial tear: hermes main entry present to tear", false, mainEntry);
    }
  }

  // ── 2c. a check reads package.json once, so a failed read surfaces instead of reading as torn ─────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    const pkgJson = join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-hermes", "package.json");
    // The entry check used to parse package.json a second time and answer "torn" for any failure of
    // that read (#3698). The hook fails the repair's second read of this file with EACCES, so a second
    // read reinstalls a healthy connector while a single read never meets the fault.
    const hook = join(cfg, "read-hook.cjs");
    const reads = join(cfg, "reads.log");
    writeFileSync(
      hook,
      [
        'const fs = require("node:fs");',
        'if (process.argv.slice(2).join(" ") === "ext seed --repair") {',
        "  const read = fs.readFileSync;",
        "  let n = 0;",
        "  fs.readFileSync = function (path, ...rest) {",
        "    if (String(path) === process.env.READ_HOOK_TARGET) {",
        "      fs.appendFileSync(process.env.READ_HOOK_LOG, `${++n}\\n`);",
        '      if (n === 2) throw Object.assign(new Error(`EACCES: permission denied, open \'${path}\'`), { code: "EACCES" });',
        "    }",
        "    return read.call(fs, path, ...rest);",
        "  };",
        '  require("node:module").syncBuiltinESMExports();',
        "}",
      ].join("\n"),
    );
    const rep = cotal(cfg, ["ext", "seed", "--repair"], { NODE_OPTIONS: `--require ${hook}`, READ_HOOK_TARGET: pkgJson, READ_HOOK_LOG: reads });
    const count = existsSync(reads) ? readFileSync(reads, "utf8").split("\n").filter(Boolean).length : 0;
    check("one read: --repair reads a seeded built-in's package.json once per check", rep.status === 0 && count === 1, { count, stderr: rep.stderr });
    check("one read: a failed later read never reinstalls a healthy connector", !`${rep.stdout}${rep.stderr}`.includes("refreshed"), rep.stderr);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      chmodSync(pkgJson, 0o000);
      const unreadable = cotal(cfg, ["ext", "seed", "--repair"]);
      chmodSync(pkgJson, 0o644);
      const out = `${unreadable.stdout}${unreadable.stderr}`;
      check("one read: an unreadable package.json surfaces EACCES, never a torn install", unreadable.status !== 0 && out.includes("EACCES") && !out.includes("torn install"), out);
    }
  }
} finally {
  finishScenario();
}

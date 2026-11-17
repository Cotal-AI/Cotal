import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(manifest.scripts.preinstall, "node ./preinstall.mjs");
assert(manifest.files.includes("preinstall.mjs"), "the install hook must ship outside dist");
const source = readFileSync(new URL("../preinstall.mjs", import.meta.url), "utf8");

for (const [platform, header, refused] of [
  ["linux", {}, true],
  ["linux", { glibcVersionCompiler: "2.39" }, true],
  ["linux", { glibcVersionRuntime: "2.39" }, false],
  ["darwin", {}, false],
  ["win32", {}, false],
] as const) {
  const errors: string[] = [];
  let reports = 0;
  const process = {
    platform,
    exitCode: 0,
    report: {
      excludeNetwork: false,
      getReport() {
        reports++;
        assert.equal(platform, "linux", "other platforms must not need libc detection");
        assert.equal(process.report.excludeNetwork, true);
        return { header };
      },
    },
  };
  runInNewContext(source, { process, console: { error: (message: string) => errors.push(message) } });
  assert.equal(process.exitCode, refused ? 1 : 0);
  assert.equal(reports, platform === "linux" ? 1 : 0);
  if (refused) {
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Cotal requires glibc on Linux/);
    assert.match(errors[0]!, /Alpine and other musl distributions are not supported/);
    assert.match(errors[0]!, /Use a glibc distribution or container/);
  } else {
    assert.deepEqual(errors, []);
  }
  console.log(`PASS: ${platform} ${JSON.stringify(header)} ${refused ? "refused" : "allowed"}`);
}

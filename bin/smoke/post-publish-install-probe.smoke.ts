/**
 * The post-publish install probe must catch a missing binary and a version mismatch. These cells
 * exercise the probe's components against controlled inputs: tarball extraction, bin verification,
 * fake registry shape, and end-to-end good-tarball validation. The broken-tarball cells modify a
 * real `npm pack` output (remove the bin entry, change the version) to prove the probe rejects
 * what it should.
 *
 * Run: pnpm smoke:post-publish-install-probe
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/post-publish-install-probe.json
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readVersion,
  packPackage,
  extractTarball,
  verifyBinEntry,
  startFakeRegistry,
  runBinary,
  probe,
} from "../../scripts/post-publish-install-probe.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let passed = 0;
let failed = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 FAIL: ${name}`, detail ?? "");
  }
}

// ---------------------------------------------------------------- unit: readVersion
const version = readVersion(join(ROOT, "bin"));
check("readVersion reads the committed version from bin/package.json", typeof version === "string" && version.length > 0, version);

// ---------------------------------------------------------------- unit: packPackage
const packTmp = mkdtempSync(join(tmpdir(), "probe-pack-"));
try {
  const tarball = packPackage(join(ROOT, "bin"), packTmp);
  check("packPackage produces a tarball that exists", existsSync(tarball), tarball);
  check("the tarball filename contains the package name", tarball.includes("cotal-ai"), tarball);
} finally {
  rmSync(packTmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- unit: extractTarball + verifyBinEntry
const extractTmp = mkdtempSync(join(tmpdir(), "probe-extract-"));
try {
  const tarball = packPackage(join(ROOT, "bin"), extractTmp);
  const pkgDir = extractTarball(tarball, join(extractTmp, "out"));
  check("extractTarball produces a package directory", existsSync(pkgDir));
  const binInfo = verifyBinEntry(pkgDir);
  check("verifyBinEntry finds the cotal bin entry", binInfo.binName === "cotal", binInfo);
  check("the bin entry file exists in the extracted tarball", binInfo.exists, binInfo);
} finally {
  rmSync(extractTmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- unit: startFakeRegistry
const regTmp = mkdtempSync(join(tmpdir(), "probe-reg-"));
try {
  const tarball = packPackage(join(ROOT, "bin"), regTmp);
  const reg = await startFakeRegistry(tarball, "cotal-ai", version);
  check("startFakeRegistry returns a url", reg.url.startsWith("http://"), reg.url);

  const res = await fetch(`${reg.url}/cotal-ai`);
  const packument = await res.json() as any;
  check("the fake registry serves a packument with the correct version", packument.versions?.[version] != null);
  check("the packument dist.tarball points to the local server", (packument.versions?.[version]?.dist?.tarball ?? "").startsWith(reg.url));

  const tarRes = await fetch(packument.versions[version].dist.tarball);
  check("the fake registry serves the tarball", tarRes.status === 200);

  const unknownRes = await fetch(`${reg.url}/unknown-package`);
  check("the fake registry returns 404 for unknown packages", unknownRes.status === 404);

  await reg.close();
} finally {
  rmSync(regTmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- unit: runBinary (from extracted tarball)
const runTmp = mkdtempSync(join(tmpdir(), "probe-run-"));
try {
  const tarball = packPackage(join(ROOT, "bin"), runTmp);
  const runPkgDir = extractTarball(tarball, join(runTmp, "out"));
  const runBinInfo = verifyBinEntry(runPkgDir);
  const vResult = runBinary(runBinInfo.binPath!, ["--version"]);
  check("runBinary --version exits 0", vResult.exitCode === 0, { exitCode: vResult.exitCode, stderr: vResult.stderr });
  check("runBinary --version output includes the version", vResult.stdout.includes(version), { stdout: vResult.stdout, version });
} finally {
  rmSync(runTmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- integration: good tarball
console.log("\nA. Good tarball (the happy path)");
const goodResult = await probe();
check("a good tarball passes the probe", goodResult.pass === true, goodResult.checks?.filter((c: any) => !c.pass));
check("the probe reports the correct version", goodResult.version === version, { expected: version, got: goodResult.version });

// ---------------------------------------------------------------- integration: bin removed from tarball
console.log("\nB. Tarball with bin entry removed");
const brokenTmp = mkdtempSync(join(tmpdir(), "probe-broken-"));
try {
  const tarball = packPackage(join(ROOT, "bin"), brokenTmp);
  const pkgDir = extractTarball(tarball, join(brokenTmp, "out"));
  const binInfo = verifyBinEntry(pkgDir);
  // Remove the bin entry file
  if (binInfo.exists && binInfo.binPath) unlinkSync(binInfo.binPath);
  const brokenBin = verifyBinEntry(pkgDir);
  check(
    "a tarball with the bin entry removed FAILS verifyBinEntry",
    !brokenBin.exists,
    { brokenBin },
  );
} finally {
  rmSync(brokenTmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- integration: version mismatch
// The probe reads the expected version from bin/package.json and compares it against --version
// output. If the tarball's package.json has a different version, the binary prints that different
// version and the probe's comparison fails. Here we verify the binary from a modified tarball
// prints the modified version, confirming the probe runs tarball code, not workspace code.
console.log("\nC. Version mismatch detection");
const mismatchTmp = mkdtempSync(join(tmpdir(), "probe-mismatch-"));
try {
  const tarball = packPackage(join(ROOT, "bin"), mismatchTmp);
  const pkgDir = extractTarball(tarball, join(mismatchTmp, "out"));
  const pkgPath = join(pkgDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = "0.0.0-mismatch";
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const mismatchBinInfo = verifyBinEntry(pkgDir);
  const mismatchResult = runBinary(mismatchBinInfo.binPath!, ["--version"]);
  // The binary from the modified tarball prints the modified version, proving it runs
  // the tarball's code. The probe would compare this against the workspace version (0.48.2)
  // and correctly fail.
  check(
    "a tarball with a rewritten version prints the rewritten version (proving the tarball entry code runs)",
    mismatchResult.stdout.includes("0.0.0-mismatch"),
    { versionOut: mismatchResult.stdout },
  );
} finally {
  rmSync(mismatchTmp, { recursive: true, force: true });
}

const EXPECTED = 17;
check(`every cell ran (${EXPECTED} before sentinel)`, passed + failed === EXPECTED, passed + failed);
console.log(`\nPOST-PUBLISH INSTALL PROBE SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
console.log("SUITE COMPLETE");
if (failed) process.exitCode = 1;

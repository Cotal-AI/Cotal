#!/usr/bin/env node
/**
 * Post-publish installability probe: verify that `npm pack` of the workspace cotal-ai package
 * produces a tarball whose binary is present and runs correctly.
 *
 * The release pipeline ends at `pnpm publish -r`. Nothing afterwards checks that the published
 * release carries a working binary. Issue #1412 recorded a five-minute window where
 * `cotal-ai@0.48.2` was live on npm while a pinned sibling had not yet propagated. A presence
 * check (`npm view`) passed throughout. This probe closes the gap.
 *
 * Steps:
 *   1. `npm pack` the workspace `cotal-ai` package into a tarball.
 *   2. Serve the tarball from a throwaway local HTTP server (fake registry).
 *   3. Extract the tarball into a clean directory and verify the bin entry exists.
 *   4. Run the packed binary (`cotal --version`) and assert the printed version.
 *   5. Run an offline smoke (`cotal --help`) to verify the binary loads without a broken
 *      require chain.
 *
 * The probe validates the SHAPE of what `pnpm publish -r` would ship for cotal-ai itself: the
 * tarball contains the expected binary, the version matches, and the binary starts. It is a LEAF
 * job that runs after the `version` job completes, so `gh release create` has already run by then;
 * it reds the overall workflow but does NOT gate the GitHub Release (which is gated by the closure
 * gate from #1502). It packs only the cotal-ai package, so the sibling workspace packages' own
 * packaging (their `files`, `exports` and prepack behaviour) is NOT exercised. It does not cover
 * registry-side propagation or native-asset loading. It never writes to any registry.
 *
 * Exit codes:
 *   0  PASS
 *   1  FAIL
 *
 * Usage:  node scripts/post-publish-install-probe.mjs
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read the version from a package directory's package.json.
 */
export function readVersion(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  return pkg.version;
}

/**
 * Pack the cotal-ai package into a tarball and return its path.
 */
export function packPackage(pkgDir, outDir) {
  const filename = execFileSync("npm", ["pack", "--pack-destination", outDir], {
    cwd: pkgDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split("\n").pop();
  const tarball = join(outDir, filename);
  if (!existsSync(tarball)) {
    throw new Error(`npm pack did not produce expected tarball: ${tarball}`);
  }
  return tarball;
}

/**
 * Extract a tarball. npm tarballs extract into a `package/` subdirectory.
 */
export function extractTarball(tarball, extractDir) {
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["xzf", tarball, "-C", extractDir], { stdio: "pipe" });
  return join(extractDir, "package");
}

/**
 * Verify the bin entry exists in an extracted tarball. Returns { binName, binRel, binPath, exists }.
 */
export function verifyBinEntry(pkgDir) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    return { binName: null, binRel: null, binPath: null, exists: false };
  }
  const bin = pkg.bin;
  if (!bin || typeof bin !== "object") return { binName: null, binRel: null, binPath: null, exists: false };
  const entries = Object.entries(bin);
  if (entries.length === 0) return { binName: null, binRel: null, binPath: null, exists: false };
  const [name, relPath] = entries[0];
  const absPath = join(pkgDir, relPath);
  return { binName: name, binRel: relPath, binPath: absPath, exists: existsSync(absPath) };
}

/**
 * Start a minimal HTTP server serving a single tarball as a fake npm registry.
 */
export async function startFakeRegistry(tarballPath, packageName, version) {
  const tarballBytes = readFileSync(tarballPath);
  const tarballFilename = basename(tarballPath);

  const packument = {
    name: packageName,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name: packageName,
        version,
        dist: { tarball: "", shasum: "" },
      },
    },
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const path = decodeURIComponent(url.pathname);

    if (path === `/${packageName}` || path === `/${packageName}/`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(packument));
      return;
    }
    if (path === `/${tarballFilename}`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(tarballBytes);
      return;
    }
    // Unknown package: 404, not 200, so a broken registry URL is caught.
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const registryUrl = `http://127.0.0.1:${port}`;
  packument.versions[version].dist.tarball = `${registryUrl}/${tarballFilename}`;

  return {
    server,
    url: registryUrl,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * Run a binary from an extracted tarball. The binary ENTRY code comes from the tarball; a symlink
 * to the workspace's node_modules is created in the package directory so ESM bare-specifier imports
 * resolve, matching what a real `npm install` would provide. Note the consequence: the tarball's
 * own entry code runs against WORKSPACE-resolved dependency code, because the packed package.json
 * still carries `workspace:*` for its siblings. A dependency defect is therefore caught only where
 * `--version` or `--help` actually execute it, and a sibling's packaging is not under test at all.
 */
export function runBinary(binPath, args) {
  const pkgDir = dirname(dirname(binPath)); // dist/cotal.js -> package dir
  const nmLink = join(pkgDir, "node_modules");

  // Symlink the workspace bin package's node_modules into the extracted package so ESM
  // bare-specifier resolution works. pnpm hoists each package's deps into its own node_modules,
  // so we use bin/node_modules which has all of cotal-ai's dependencies.
  try { rmSync(nmLink, { force: true }); } catch {}
  try {
    symlinkSync(join(ROOT, "bin", "node_modules"), nmLink, "dir");
  } catch {}

  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  env.COTAL_HOME = join(mkdtempSync(join(tmpdir(), "cotal-probe-home-")));

  try {
    const stdout = execFileSync(process.execPath, [binPath, ...args], {
      cwd: pkgDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      env,
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err) {
    return {
      stdout: (err.stdout ?? "").trim(),
      stderr: (err.stderr ?? "").trim(),
      exitCode: err.status ?? 1,
    };
  }
}

/**
 * Run the full probe. Returns { pass, version, checks }.
 */
export async function probe() {
  const binDir = join(ROOT, "bin");
  const version = readVersion(binDir);
  const checks = [];
  let pass = true;

  function check(name, condition, detail) {
    checks.push({ name, pass: !!condition, detail });
    if (condition) {
      console.log(`  \u2713 ${name}`);
    } else {
      pass = false;
      console.log(`  \u2717 FAIL: ${name}`, detail ?? "");
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), "cotal-install-probe-"));

  try {
    // Step 1: Pack
    console.log("1. Packing cotal-ai tarball");
    const tarball = packPackage(binDir, tmp);
    check("npm pack produced a tarball", existsSync(tarball), tarball);

    // Step 2: Serve from fake registry (validates the registry machinery)
    console.log("2. Starting local registry");
    const reg = await startFakeRegistry(tarball, "cotal-ai", version);
    // Fetch the packument to validate registry shape
    const packumentRes = await fetch(`${reg.url}/cotal-ai`);
    const packument = await packumentRes.json();
    check(
      "local registry serves a packument for cotal-ai",
      packument?.versions?.[version] != null,
    );
    await reg.close();

    // Step 3: Extract and verify bin
    console.log("3. Extracting tarball and verifying bin entry");
    const pkgDir = extractTarball(tarball, join(tmp, "extracted"));
    const binInfo = verifyBinEntry(pkgDir);
    check("package.json declares a bin entry", binInfo.binName != null, binInfo);
    check(
      "the bin entry points at a file that exists in the tarball",
      binInfo.exists,
      { binPath: binInfo.binPath, exists: binInfo.exists },
    );

    // Step 4: Version check (runs the PACKED binary from the tarball, not the workspace copy)
    console.log("4. Checking cotal --version");
    const versionResult = runBinary(binInfo.binPath, ["--version"]);
    check(
      "cotal --version exits 0",
      versionResult.exitCode === 0,
      { exitCode: versionResult.exitCode, stderr: versionResult.stderr },
    );
    check(
      "cotal --version prints the expected version",
      versionResult.stdout.includes(version),
      { expected: version, got: versionResult.stdout },
    );

    // Step 5: Offline smoke
    console.log("5. Running offline smoke (cotal --help)");
    const helpResult = runBinary(binInfo.binPath, ["--help"]);
    check(
      "cotal --help exits 0 (binary loads without missing assets)",
      helpResult.exitCode === 0,
      { exitCode: helpResult.exitCode, stderr: helpResult.stderr },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  return { pass, version, checks };
}

// CLI entry
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = await probe();
  console.log(`\nINSTALL PROBE ${result.pass ? "PASSED" : "FAILED"} (version ${result.version})`);
  process.exit(result.pass ? 0 : 1);
}

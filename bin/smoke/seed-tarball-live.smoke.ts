/**
 * LIVE published-path smoke for built-in-connector seeding. Packs the REAL `cotal-ai` closure
 * (pnpm pack, which replaces `workspace:*` with concrete versions), installs it into a clean npm
 * prefix with no repo on the resolution path, and proves the PUBLISHED seed path:
 *
 *  - the `cotal-ai` tarball ships the `seeded-connectors/<name>` payloads (prepack) with concrete deps
 *  - a first command on the installed binary seeds all four built-ins from those bundled payloads
 *    (`shippedSourceDir` published branch), installing each from the durable store under the isolated
 *    config (never a repo path). Driven through the `.bin/cotal` SYMLINK npm publishes, the way a user
 *    reaches an installed binary: `process.argv[1]` is then the link, whose parents hold no
 *    `package.json` and no `seeded-connectors/`, so only resolving it reaches the payloads
 *  - each connector registers into THE BINARY'S single `@cotal-ai/core` (ext add asserts this; a
 *    dual-core install would fail it), recorded `source:"seeded"`
 *
 * Broker-free and deterministic. Needs `npm` + `pnpm` on PATH and network for third-party deps.
 * Run: pnpm smoke:seed-tarball:live
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const base = mkdtempSync(join(tmpdir(), "cotal-tarball-smoke-"));
const tgz = join(base, "tgz");
const prefix = join(base, "prefix");
const cfg = join(base, "cfg");
mkdirSync(tgz, { recursive: true });
mkdirSync(prefix, { recursive: true });
mkdirSync(cfg, { recursive: true });

try {
  console.log("packing the cotal-ai closure …");
  const dirs = [
    "bin",
    "packages/core",
    "packages/workspace",
    "implementations/cli",
    "implementations/manager",
    "implementations/delivery",
    "implementations/auth",
    "extensions/connector-core",
  ];
  for (const d of dirs) {
    execFileSync("pnpm", ["-C", join(REPO, d), "pack", "--pack-destination", tgz], { stdio: ["ignore", "ignore", "inherit"] });
  }
  const tarballs = readdirSync(tgz).filter((f) => f.endsWith(".tgz"));
  check("packed the full @cotal-ai closure", tarballs.length === dirs.length, tarballs.length);

  const cotalTgz = join(tgz, tarballs.find((f) => /^cotal-ai-\d/.test(f)) ?? "");
  const listing = execFileSync("tar", ["tzf", cotalTgz], { encoding: "utf8" });
  check("cotal-ai tarball ships seeded-connectors/ payloads", listing.includes("package/seeded-connectors/hermes/package.json"));
  check("cotal-ai tarball bundles the web dashboard payload", listing.includes("package/seeded-connectors/web/package.json"));
  check(
    "bundled web payload is self-contained (marked/dompurify shipped in dist, no runtime deps)",
    listing.includes("package/seeded-connectors/web/dist/web/vendor/marked.umd.js") &&
      listing.includes("package/seeded-connectors/web/dist/web/vendor/purify.min.js"),
  );
  const packedPkg = execFileSync("tar", ["xzf", cotalTgz, "-O", "package/package.json"], { encoding: "utf8" });
  check("cotal-ai tarball has concrete dep versions (workspace: replaced)", !packedPkg.includes("workspace:"));

  // Every bundled payload must carry the umbrella's exact version — the reconcile stamps that version
  // as the generation, so a skewed payload would be installed and treated as current (F1). The prepack
  // asserts this too; the tarball is the last place to catch it before a customer install.
  const umbrellaVersion = (JSON.parse(packedPkg) as { version: string }).version;
  for (const n of ["claude", "opencode", "hermes", "pi", "web"]) {
    const seededPkg = JSON.parse(
      execFileSync("tar", ["xzf", cotalTgz, "-O", `package/seeded-connectors/${n}/package.json`], { encoding: "utf8" }),
    ) as { version: string };
    check(`bundled ${n} payload is version-locked to the umbrella (${umbrellaVersion})`, seededPkg.version === umbrellaVersion, seededPkg.version);
  }

  // The web dashboard ships marked/DOMPurify as opaque browser bytes in dist (not runtime deps), so
  // its vendor-manifest.json is the auditable SBOM surface. Assert it lists both libs with a concrete
  // version + license + sha512, and that each recorded hash matches the ACTUAL shipped bytes (F2) — so
  // a drifted or tampered vendored lib can never pass unnoticed into a published binary.
  const vendorBase = "package/seeded-connectors/web/dist/web/vendor";
  const vendorManifest = JSON.parse(
    execFileSync("tar", ["xzf", cotalTgz, "-O", `${vendorBase}/vendor-manifest.json`], { encoding: "utf8" }),
  ) as { vendored: { file: string; package: string; version: string; license: string; sha512: string }[] };
  const libs = new Map(vendorManifest.vendored.map((e) => [e.package, e]));
  check(
    "web vendor manifest lists marked + dompurify with version, license and sha512",
    ["marked", "dompurify"].every((p) => {
      const e = libs.get(p);
      return Boolean(e && e.version && e.license && /^[0-9a-f]{128}$/.test(e.sha512));
    }),
    [...libs.keys()].join(","),
  );
  for (const e of vendorManifest.vendored) {
    const bytes = execFileSync("tar", ["xzf", cotalTgz, "-O", `${vendorBase}/${e.file}`], { maxBuffer: 1 << 26 });
    const actual = createHash("sha512").update(bytes).digest("hex");
    check(`vendor manifest sha512 matches the shipped ${e.file}`, actual === e.sha512, `${actual.slice(0, 12)} vs ${e.sha512.slice(0, 12)}`);
  }

  console.log("installing the tarball closure into a clean prefix …");
  writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "tb-host", private: true }));
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", ...tarballs.map((f) => join(tgz, f))], {
    cwd: prefix,
    encoding: "utf8",
  });
  check("npm install of the tarball closure succeeded", install.status === 0, install.stderr?.split("\n").slice(-6).join("\n"));

  const packageBin = join(prefix, "node_modules", "cotal-ai", "dist", "cotal.js");
  check("installed binary present", existsSync(packageBin));
  check("seeded-connectors present in the installed package", existsSync(join(prefix, "node_modules", "cotal-ai", "seeded-connectors")));
  check("single @cotal-ai/core hoisted in the prefix", existsSync(join(prefix, "node_modules", "@cotal-ai", "core")));

  console.log("seeding from the published layout …");
  const npmBin = join(prefix, "node_modules", ".bin", "cotal");
  const invokedBin = process.platform === "win32" ? packageBin : npmBin;
  if (process.platform !== "win32") {
    check("npm installed cotal through a bin symlink", existsSync(npmBin) && lstatSync(npmBin).isSymbolicLink());
  }
  const list = spawnSync("node", [invokedBin, "ext", "list"], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: cfg } });
  const out = list.stdout ?? "";
  for (const n of ["claude", "opencode", "hermes", "pi"]) {
    check(`seeded connector:${n} from the tarball binary`, out.includes(`connector:${n}`), list.stderr);
  }
  check("seeded command:web (the dashboard) from the bundled payload", out.includes("command:web"), list.stderr);

  const manifest = JSON.parse(readFileSync(join(cfg, "cotal", "extensions", "extensions.json"), "utf8")) as {
    extensions: { pkg: string; spec: string; source?: string }[];
  };
  const hermes = manifest.extensions.find((e) => e.pkg === "@cotal-ai/connector-hermes");
  check("connector installed from the durable store under the isolated config (pubDir branch)", Boolean(hermes && hermes.spec.startsWith(cfg)), hermes?.spec);
  const firstParty = ["@cotal-ai/connector-claude-code", "@cotal-ai/connector-opencode", "@cotal-ai/connector-hermes", "@cotal-ai/pi", "@cotal-ai/web"];
  const seededEntries = manifest.extensions.filter((e) => firstParty.includes(e.pkg));
  const allSeeded = seededEntries.every((e) => e.source === "seeded");
  check("all five first-party exts recorded source:seeded (registered into the binary's single core)", allSeeded && seededEntries.length === 5);
  const webEntry = manifest.extensions.find((e) => e.pkg === "@cotal-ai/web");
  check("web installed from the durable store under the isolated config (bundled, not npm-fetched)", Boolean(webEntry && webEntry.spec.startsWith(cfg)), webEntry?.spec);

  // The launcher shim a connector's buildLaunch runs (`node dist/serve.js` / `dist/launch.js`) must be
  // PACKAGED — a build that emits only declarations for it passes install + import + materialize but
  // fails at LAUNCH with MODULE_NOT_FOUND. Assert those buildLaunch targets exist in the installed
  // payload (a self-contained esbuild bundle each), so a dropped shim can never ship again.
  const extRoot = join(cfg, "cotal", "extensions", "node_modules");
  const launchShims: Record<string, string> = {
    "@cotal-ai/connector-opencode": "dist/serve.js",
    "@cotal-ai/connector-hermes": "dist/launch.js",
  };
  for (const [pkg, shim] of Object.entries(launchShims)) {
    check(`${pkg} launcher shim ${shim} is packaged (buildLaunch target exists)`, existsSync(join(extRoot, ...pkg.split("/"), ...shim.split("/"))));
  }
  const hermesLaunch = readFileSync(join(extRoot, "@cotal-ai", "connector-hermes", "dist", "launch.js"), "utf8");
  check("Hermes launcher is self-contained (no late host-core import)", !/^\s*import\b[^\n]* from ["']@cotal-ai\/core["'];?\s*$/m.test(hermesLaunch));
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nseed-tarball smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

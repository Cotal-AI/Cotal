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
 *  - the docs data every connector reads ships once, in `seeded-connectors/_shared`; the seed puts it
 *    back in each installed connector, and `cotal update` verifies those copies against it
 *
 * Broker-free and deterministic. Needs `npm` + `pnpm` on PATH and network for third-party deps.
 * Run: pnpm smoke:seed-tarball:live
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

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
    "packages/seat",
    "packages/workspace",
    "implementations/cli",
    "implementations/manager",
    "implementations/delivery",
    "implementations/auth",
    "extensions/connector-core",
  ];
  // seat's prepack refuses a tree without both Linux helpers, and the build above is a host-only dev
  // build. So seat packs from a clone under `base`: the host helper that build made, plus a 20-byte
  // ELF header for each other shipped arch. The real packages/seat/build/Release is never written,
  // because a stand-in helper left there would ship on a later genuine pack.
  const seatSource = join(base, "seat-source");
  const seatClone = join(seatSource, "packages", "seat");
  cpSync(join(REPO, "packages", "seat"), seatClone, { recursive: true, filter: (src) => !src.split(sep).includes("node_modules") });
  for (const name of ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json"]) cpSync(join(REPO, name), join(seatSource, name));
  symlinkSync(join(REPO, "node_modules"), join(seatSource, "node_modules"), "dir");
  symlinkSync(join(REPO, "packages", "seat", "node_modules"), join(seatClone, "node_modules"), "dir");
  for (const [arch, machine] of [["x64", 62], ["arm64", 183]] as const) {
    if (process.platform === "linux" && process.arch === arch) continue;
    const helper = join(seatClone, "build", "Release", `linux-${arch}`, "peercred.node");
    mkdirSync(dirname(helper), { recursive: true });
    const header = Buffer.alloc(20);
    header[0] = 0x7f;
    header.write("ELF", 1);
    header.writeUInt16LE(machine, 18);
    writeFileSync(helper, header);
  }
  // workspace's prepack refuses without its Windows and macOS identity bindings, which only the native
  // builder jobs produce and a Linux install never loads, so it packs without that check.
  for (const d of dirs) {
    const root = d === "packages/seat" ? seatClone : join(REPO, d);
    const skipPrepack = d === "packages/workspace" ? ["--config.ignore-scripts=true"] : [];
    execFileSync("pnpm", ["-C", root, "pack", ...skipPrepack, "--pack-destination", tgz], { stdio: ["ignore", "ignore", "inherit"] });
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
  // Every connector bundle reads the same docs data from beside itself; the tarball carries it once.
  const docsEntries = listing.split("\n").filter((line) => /\/docs-(bundle|index)\.bin$/.test(line)).sort();
  check(
    "cotal-ai tarball ships each docs file once, in seeded-connectors/_shared",
    docsEntries.join(" ") === "package/seeded-connectors/_shared/docs-bundle.bin package/seeded-connectors/_shared/docs-index.bin",
    docsEntries,
  );
  check("cotal-ai tarball ships the shared-file placements", listing.includes("package/seeded-connectors/_shared/placements.json"));
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
  // A read no longer seeds, so seed explicitly; the listing after it is a read.
  const seed = spawnSync("node", [invokedBin, "ext", "seed"], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: cfg } });
  check("ext seed from the published layout succeeded", seed.status === 0, `${seed.stdout}${seed.stderr}`.split("\n").slice(-12).join("\n"));
  const list = spawnSync("node", [invokedBin, "ext", "list"], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: cfg } });
  const out = list.stdout ?? "";
  for (const n of ["claude", "opencode", "codex", "hermes", "jcode", "pi"]) {
    check(`seeded connector:${n} from the tarball binary`, out.includes(`connector:${n}`), list.stderr);
  }
  check("seeded service-preset:web (the dashboard) from the bundled payload", out.includes("service-preset:web"), list.stderr);

  const manifest = JSON.parse(readFileSync(join(cfg, "cotal", "extensions", "extensions.json"), "utf8")) as {
    extensions: { pkg: string; spec: string; source?: string }[];
  };
  const hermes = manifest.extensions.find((e) => e.pkg === "@cotal-ai/connector-hermes");
  check("connector installed from the durable store under the isolated config (pubDir branch)", Boolean(hermes && hermes.spec.startsWith(cfg)), hermes?.spec);
  const firstParty = ["@cotal-ai/connector-claude-code", "@cotal-ai/connector-opencode", "@cotal-ai/connector-codex", "@cotal-ai/connector-hermes", "@cotal-ai/connector-jcode", "@cotal-ai/pi", "@cotal-ai/web"];
  const seededEntries = manifest.extensions.filter((e) => firstParty.includes(e.pkg));
  const allSeeded = seededEntries.every((e) => e.source === "seeded");
  check("all seven first-party exts recorded source:seeded (registered into the binary's single core)", allSeeded && seededEntries.length === 7);
  const webEntry = manifest.extensions.find((e) => e.pkg === "@cotal-ai/web");
  check("web installed from the durable store under the isolated config (bundled, not npm-fetched)", Boolean(webEntry && webEntry.spec.startsWith(cfg)), webEntry?.spec);

  // The launcher shim a connector's buildLaunch runs (`node dist/serve.js` / `dist/launch.js`) must be
  // PACKAGED — a build that emits only declarations for it passes install + import + materialize but
  // fails at LAUNCH with MODULE_NOT_FOUND. Assert those buildLaunch targets exist in the installed
  // payload (a self-contained esbuild bundle each), so a dropped shim can never ship again.
  const extRoot = join(cfg, "cotal", "extensions", "node_modules");
  const launchShims: Record<string, string> = {
    "@cotal-ai/connector-opencode": "dist/serve.js",
    "@cotal-ai/connector-codex": "dist/host.js",
    "@cotal-ai/connector-hermes": "dist/launch.js",
    "@cotal-ai/connector-jcode": "dist/host.js",
  };
  for (const [pkg, shim] of Object.entries(launchShims)) {
    check(`${pkg} launcher shim ${shim} is packaged (buildLaunch target exists)`, existsSync(join(extRoot, ...pkg.split("/"), ...shim.split("/"))));
  }
  const hermesLaunch = readFileSync(join(extRoot, "@cotal-ai", "connector-hermes", "dist", "launch.js"), "utf8");
  check("Hermes launcher is self-contained (no late host-core import)", !/^\s*import\b[^\n]* from ["']@cotal-ai\/core["'];?\s*$/m.test(hermesLaunch));

  // The seed store put the shared docs data back at every path the prepack took it from, so each
  // installed connector holds the files it was packed with.
  const seededPkgs: Record<string, string> = {
    claude: "@cotal-ai/connector-claude-code", opencode: "@cotal-ai/connector-opencode", codex: "@cotal-ai/connector-codex",
    hermes: "@cotal-ai/connector-hermes", jcode: "@cotal-ai/connector-jcode", pi: "@cotal-ai/pi", web: "@cotal-ai/web",
  };
  const sharedDir = join(prefix, "node_modules", "cotal-ai", "seeded-connectors", "_shared");
  const placements = (JSON.parse(readFileSync(join(sharedDir, "placements.json"), "utf8")) as { placements: Record<string, string[]> }).placements;
  // Every connector bundles the docs data; the web dashboard does not.
  const connectors = Object.keys(seededPkgs).filter((name) => name !== "web");
  check("every connector, and only a connector, shipped its docs data in the shared copy", Object.keys(placements).sort().join(" ") === [...connectors].sort().join(" "), Object.keys(placements));
  const installedAt = (name: string, rel: string) => join(extRoot, ...seededPkgs[name].split("/"), ...rel.split("/"));
  const sharedCopy = (rel: string) => readFileSync(join(sharedDir, rel.slice(rel.lastIndexOf("/") + 1)));
  let restored = 0;
  for (const name of connectors) {
    for (const rel of placements[name] ?? []) {
      const at = installedAt(name, rel);
      if (existsSync(at) && readFileSync(at).equals(sharedCopy(rel))) restored++;
      else check(`installed ${name} holds ${rel}, byte-equal to the shared copy`, false);
    }
  }
  const placed = Object.values(placements).flat().length;
  check(`every placement is restored byte-equal in the installed connectors (${restored}/${placed})`, restored === placed && placed > 0);

  // `cotal update` keeps a seeded built-in only when its store and installed copies are byte-equal to
  // the shipped payload, which for a restored file is the shared copy. A tampered copy is reinstalled.
  const updateEnv = { ...process.env, HOME: join(base, "home"), XDG_CONFIG_HOME: cfg };
  mkdirSync(updateEnv.HOME, { recursive: true });
  const update = () => {
    const run = spawnSync("node", [invokedBin, "update"], { cwd: prefix, encoding: "utf8", env: updateEnv });
    return `${run.stdout ?? ""}${run.stderr ?? ""}`;
  };
  const reconciled = (out: string) => out.split("\n").find((line) => line.includes("connectors reconciled")) ?? "";
  const kept = reconciled(update());
  check(
    "cotal update verifies all seven built-ins against the shipped payload and reinstalls none",
    Object.keys(seededPkgs).every((name) => new RegExp(`verified [^;]*\\b${name}\\b`).test(kept)) && !kept.includes("refreshed"),
    kept,
  );
  const tamperedRel = placements.claude?.[0] ?? "";
  writeFileSync(installedAt("claude", tamperedRel), Buffer.concat([sharedCopy(tamperedRel), Buffer.from([0])]));
  const repairOut = update();
  check(
    "cotal update reinstalls a built-in whose restored docs file differs from the shared copy",
    repairOut.includes(`claude: the installed copy differs at ${join(...tamperedRel.split("/"))}; reinstalling`) && /refreshed claude\b/.test(reconciled(repairOut)),
    repairOut.split("\n").filter((line) => line.includes("claude")).join("\n"),
  );
  check("the reinstall restores the shared copy", readFileSync(installedAt("claude", tamperedRel)).equals(sharedCopy(tamperedRel)));
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nseed-tarball smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

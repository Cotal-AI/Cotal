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
  const webBase = "package/seeded-connectors/web/dist/web";
  check(
    "bundled web payload ships the client page and its bundle manifest in dist",
    listing.includes(`${webBase}/index.html`) && listing.includes(`${webBase}/bundle-licenses.json`),
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

  // The web dashboard's client is one Vite build: third-party code is compiled into its hashed
  // assets rather than shipped as runtime deps, so bundle-licenses.json is the auditable SBOM
  // surface. Assert that every bundled package carries a concrete version and license, that it names
  // the React runtime the page is built on, and that every file the shipped page references is in
  // the tarball, so a payload whose page points at a missing asset cannot pass into a published
  // binary. marked and DOMPurify are bundled too, because the message rows render bodies as
  // sanitized Markdown, and d3-force, d3-selection and d3-zoom lay out and pan the topology graph.
  const licenses = JSON.parse(
    execFileSync("tar", ["xzf", cotalTgz, "-O", `${webBase}/bundle-licenses.json`], { encoding: "utf8" }),
  ) as { bundled: { package: string; version: string; license: string }[] };
  const libs = new Map(licenses.bundled.map((e) => [e.package, e]));
  check(
    "web bundle-licenses.json gives every bundled package a version and a license",
    licenses.bundled.length > 0 && licenses.bundled.every((e) => Boolean(e.version && e.license)),
    licenses.bundled,
  );
  check("web bundle-licenses.json names react and react-dom", ["react", "react-dom"].every((p) => libs.has(p)), [...libs.keys()].join(","));
  check("web bundle-licenses.json names marked and dompurify", ["marked", "dompurify"].every((p) => libs.has(p)), [...libs.keys()].join(","));
  check("web bundle-licenses.json names d3-force, d3-selection and d3-zoom", ["d3-force", "d3-selection", "d3-zoom"].every((p) => libs.has(p)), [...libs.keys()].join(","));
  const page = execFileSync("tar", ["xzf", cotalTgz, "-O", `${webBase}/index.html`], { encoding: "utf8" });
  const refs = [...page.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((m) => m[1]);
  check("the shipped web page references its script and stylesheet", refs.some((r) => r.endsWith(".js")) && refs.some((r) => r.endsWith(".css")), refs);
  for (const r of refs) check(`the shipped web page's reference /${r} is in the tarball`, listing.includes(`${webBase}/${r}`));
  // The same payload, packed from the web package directly, the way prepack packs it and the way
  // `@cotal-ai/web` publishes on its own: the umbrella must carry that package's manifest byte for
  // byte, not a copy from some other build.
  //
  // This pack is also what gives the mutation coverage gate its reach into the web package: the
  // gate cannot follow the umbrella's prepack, but it can follow an `npm pack` this suite runs over
  // `implementations/web`. It is NOT the witness for the fixture's mutation. That mutation (the
  // build stops recording bundled packages) is killed by the "names react and react-dom" cell
  // above, which reads the umbrella's own tarball.
  const webTgzDir = join(base, "web-tgz");
  mkdirSync(webTgzDir, { recursive: true });
  execFileSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", webTgzDir, join(REPO, "implementations", "web")], { stdio: ["ignore", "ignore", "inherit"] });
  const webTgz = join(webTgzDir, readdirSync(webTgzDir).find((f) => f.endsWith(".tgz")) ?? "");
  const standalone = execFileSync("tar", ["xzf", webTgz, "-O", "package/dist/web/bundle-licenses.json"], { encoding: "utf8" });
  check("the umbrella's web manifest is the one the web package itself packs",
    standalone === execFileSync("tar", ["xzf", cotalTgz, "-O", `${webBase}/bundle-licenses.json`], { encoding: "utf8" }));

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

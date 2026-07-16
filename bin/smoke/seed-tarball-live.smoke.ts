/**
 * LIVE published-path smoke for built-in-connector seeding. Packs the REAL `cotal-ai` closure
 * (pnpm pack, which replaces `workspace:*` with concrete versions), installs it into a clean npm
 * prefix with no repo on the resolution path, and proves the PUBLISHED seed path:
 *
 *  - the `cotal-ai` tarball ships the `seeded-connectors/<name>` payloads (prepack) with concrete deps
 *  - a first command on the installed binary seeds all four built-ins from those bundled payloads
 *    (`shippedSourceDir` published branch), installing each from the durable store under the isolated
 *    config (never a repo path)
 *  - each connector registers into THE BINARY'S single `@cotal-ai/core` (ext add asserts this; a
 *    dual-core install would fail it), recorded `source:"seeded"`
 *
 * Broker-free and deterministic. Needs `npm` + `pnpm` on PATH and network for third-party deps.
 * Run: pnpm smoke:seed-tarball:live
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  const packedPkg = execFileSync("tar", ["xzf", cotalTgz, "-O", "package/package.json"], { encoding: "utf8" });
  check("cotal-ai tarball has concrete dep versions (workspace: replaced)", !packedPkg.includes("workspace:"));

  console.log("installing the tarball closure into a clean prefix …");
  writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "tb-host", private: true }));
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", ...tarballs.map((f) => join(tgz, f))], {
    cwd: prefix,
    encoding: "utf8",
  });
  check("npm install of the tarball closure succeeded", install.status === 0, install.stderr?.split("\n").slice(-6).join("\n"));

  const bin = join(prefix, "node_modules", "cotal-ai", "dist", "cotal.js");
  check("installed binary present", existsSync(bin));
  check("seeded-connectors present in the installed package", existsSync(join(prefix, "node_modules", "cotal-ai", "seeded-connectors")));
  check("single @cotal-ai/core hoisted in the prefix", existsSync(join(prefix, "node_modules", "@cotal-ai", "core")));

  console.log("seeding from the published layout …");
  const list = spawnSync("node", [bin, "ext", "list"], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: cfg } });
  const out = list.stdout ?? "";
  for (const n of ["claude", "opencode", "hermes", "pi"]) {
    check(`seeded connector:${n} from the tarball binary`, out.includes(`connector:${n}`), list.stderr);
  }

  const manifest = JSON.parse(readFileSync(join(cfg, "cotal", "extensions", "extensions.json"), "utf8")) as {
    extensions: { pkg: string; spec: string; source?: string }[];
  };
  const hermes = manifest.extensions.find((e) => e.pkg === "@cotal-ai/connector-hermes");
  check("connector installed from the durable store under the isolated config (pubDir branch)", Boolean(hermes && hermes.spec.startsWith(cfg)), hermes?.spec);
  const officials = ["@cotal-ai/connector-claude-code", "@cotal-ai/connector-opencode", "@cotal-ai/connector-hermes", "@cotal-ai/pi"];
  const allSeeded = manifest.extensions.filter((e) => officials.includes(e.pkg)).every((e) => e.source === "seeded");
  check("all four recorded source:seeded (registered into the binary's single core)", allSeeded && manifest.extensions.filter((e) => officials.includes(e.pkg)).length === 4);
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nseed-tarball smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * `cotal update` keeps a built-in only when the extensions prefix is the tree its lock records
 * (`prefixLockDiffers`). An optional package that is absent is excused only under npm's own platform
 * rule: npm-install-checks `checkPlatform`, with negated `os`/`cpu` entries, `any`, bare strings and
 * `libc`. The first cut read `["!darwin"]` as excluding Linux and excused a package npm had actually
 * installed and that had since gone missing.
 *
 * The lock entries here are written by the real `npm install --install-links` over file: packages in
 * a private prefix, never by hand, so the suite proves the reader against what npm records.
 * Broker-free; needs `npm` on PATH and no network. Run: pnpm smoke:seed-verify-platform
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { admits, platformExcludesHost, prefixLockDiffers } from "../src/seed/verify.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
}

const here = process.platform;
const elsewhere = here === "darwin" ? "linux" : "darwin";
const otherArch = process.arch === "arm64" ? "x64" : "arm64";

// ── admits: npm-install-checks checkList, entry by entry ──────────────────────────────────────────
check("admits: a plain match", admits(here, [here]));
check("admits: a plain mismatch is left out", !admits(here, [elsewhere]));
check("admits: a negated other platform admits this one", admits(here, [`!${elsewhere}`]));
check("admits: a negated own platform leaves it out", !admits(here, [`!${here}`]));
check("admits: mixed list needs a plain match and no negated hit", admits(here, [`!${elsewhere}`, here]) && !admits(here, [`!${elsewhere}`, elsewhere]));
check("admits: any admits everything", admits(here, ["any"]));
check("admits: a bare string is a one-entry list", admits(here, here) && !admits(here, elsewhere));
check("admits: an empty list admits (nothing required, nothing negated)", admits(here, []));
check("admits: an unreadable list admits, so an absent package is reported, not excused", admits(here, 42) && admits(here, [1, 2]));

// ── platformExcludesHost: os, cpu, libc together ─────────────────────────────────────────────────
const host = { platform: here, arch: process.arch, libc: () => "glibc" as string | undefined };
check("platform: negated other os does not exclude", !platformExcludesHost({ os: [`!${elsewhere}`] }, host));
check("platform: other os excludes", platformExcludesHost({ os: [elsewhere] }, host));
check("platform: other cpu excludes even when os admits", platformExcludesHost({ os: [here], cpu: [otherArch] }, host));
check("platform: libc mismatch excludes", platformExcludesHost({ libc: ["musl"] }, host));
check("platform: libc requirement on a host with no libc excludes", platformExcludesHost({ libc: ["glibc"] }, { ...host, libc: () => undefined }));
check("platform: libc match admits", !platformExcludesHost({ os: ["linux"], libc: ["glibc"] }, { ...host, platform: "linux" }));
check("platform: no lists, nothing excluded", !platformExcludesHost({}, host));

// ── prefixLockDiffers over a lock the real npm wrote ─────────────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), "cotal-seed-verify-platform-"));
const savedXdg = process.env.XDG_CONFIG_HOME;
try {
  const prefix = join(base, "xdg", "cotal", "extensions");
  const fixtures = join(base, "fixtures");
  mkdirSync(prefix, { recursive: true });
  const fixture = (name: string, platform: Record<string, unknown>): string => {
    const dir = join(fixtures, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...platform }));
    writeFileSync(join(dir, "index.js"), "");
    return dir;
  };
  const optional = {
    "probe-negated-other": fixture("probe-negated-other", { os: [`!${elsewhere}`] }), // npm installs it here
    "probe-other-os": fixture("probe-other-os", { os: [elsewhere] }), // npm leaves it out here
    "probe-any": fixture("probe-any", { os: ["any"] }),
    "probe-other-cpu": fixture("probe-other-cpu", { cpu: [otherArch] }),
  };
  writeFileSync(join(prefix, "package.json"), JSON.stringify({
    name: "cotal-extensions", private: true,
    dependencies: { "probe-plain": fixture("probe-plain", {}) },
    optionalDependencies: Object.fromEntries(Object.entries(optional).map(([name, dir]) => [name, `file:${dir}`])),
  }));
  for (const file of ["user.npmrc", "global.npmrc"]) writeFileSync(join(base, file), "");
  const env = {
    PATH: process.env.PATH ?? "", HOME: join(base, "home"), npm_config_cache: join(base, "npm-cache"),
    npm_config_userconfig: join(base, "user.npmrc"), npm_config_globalconfig: join(base, "global.npmrc"),
    npm_config_update_notifier: "false", DO_NOT_TRACK: "1",
  };
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--install-links"], { cwd: prefix, env, encoding: "utf8" });
  check("real npm installs the prefix", install.status === 0, install.stderr.slice(-600));
  const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8")) as { packages: Record<string, { optional?: boolean; os?: string[]; cpu?: string[] }> };
  const entry = (name: string) => lock.packages[`node_modules/${name}`];
  check("npm recorded the negated os list on the optional entry", entry("probe-negated-other")?.optional === true && JSON.stringify(entry("probe-negated-other")?.os) === JSON.stringify([`!${elsewhere}`]), entry("probe-negated-other"));
  check("npm installed the negated-other-os package here", existsSync(join(prefix, "node_modules", "probe-negated-other", "package.json")));
  check("npm left the other-os and other-cpu packages out here", !existsSync(join(prefix, "node_modules", "probe-other-os")) && !existsSync(join(prefix, "node_modules", "probe-other-cpu")));
  check("npm recorded the other-os and other-cpu entries anyway", entry("probe-other-os")?.os?.[0] === elsewhere && entry("probe-other-cpu")?.cpu?.[0] === otherArch);

  process.env.XDG_CONFIG_HOME = join(base, "xdg");
  check("intact prefix: platform-excluded absences are not differences", prefixLockDiffers() === undefined, prefixLockDiffers());

  const negated = join(prefix, "node_modules", "probe-negated-other");
  renameSync(negated, `${negated}.aside`);
  const missingNegated = prefixLockDiffers();
  check("a missing package npm installed under a negated os list is a difference", missingNegated === "node_modules/probe-negated-other is recorded in the prefix lock but not installed", missingNegated);
  renameSync(`${negated}.aside`, negated);

  const any = join(prefix, "node_modules", "probe-any");
  renameSync(any, `${any}.aside`);
  const missingAny = prefixLockDiffers();
  check("a missing package under os any is a difference", missingAny === "node_modules/probe-any is recorded in the prefix lock but not installed", missingAny);
  renameSync(`${any}.aside`, any);

  const plain = join(prefix, "node_modules", "probe-plain", "package.json");
  writeFileSync(plain, JSON.stringify({ name: "probe-plain", version: "1.0.1" }));
  const skewed = prefixLockDiffers();
  check("a version other than the lock's is a difference", skewed === "node_modules/probe-plain is 1.0.1 on disk and 1.0.0 in the prefix lock", skewed);

  rmSync(join(prefix, "package-lock.json"));
  check("no lock at all is a difference", prefixLockDiffers()?.startsWith("the prefix lock is unreadable") === true, prefixLockDiffers());
} finally {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nseed-verify-platform smoke: ${pass} passed, ${fail} failed`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail ? 1 : 0);

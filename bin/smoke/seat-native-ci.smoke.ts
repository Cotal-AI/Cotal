/**
 * The ARM load job consumes one packed tarball. Native linux-x64 and linux-arm64
 * builder jobs must stay wired into the PR pack path and the cold candidate used
 * by normal and snapshot publication. A deleted dependency or artifact download
 * silently ships one arch, and the assembler/runtime smokes cannot see that edit.
 *
 * This file reads the workflow text. It does not run GitHub's engine. Indentation
 * is the reader, because `bin/` has no YAML dependency. A job or step shape this
 * reader cannot resolve is a FAILURE, not a skip.
 *
 * Run: pnpm smoke:seat-native-ci
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/seat-native-ci.json
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI = join(ROOT, ".github", "workflows", "ci.yml");
const CHANGESETS = join(ROOT, ".github", "workflows", "changesets.yml");
const PKG = join(ROOT, "package.json");

const BUILDERS = ["seat-native-linux-x64", "seat-native-linux-arm64"] as const;

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

function jobs(text: string): Map<string, string> {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const out = new Map<string, string>();
  if (start < 0) return out;
  let current: string | undefined;
  const buf: string[] = [];
  const flush = (): void => {
    if (current) out.set(current, buf.join("\n"));
    buf.length = 0;
  };
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l) && l.trim() !== "") break;
    const m = l.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (m) {
      flush();
      current = m[1];
      continue;
    }
    if (current) buf.push(l);
  }
  flush();
  return out;
}

function needsList(body: string): string[] {
  const inline = body.match(/^\s+needs:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const lines = body.split("\n");
  const idx = lines.findIndex((l) => /^\s+needs:\s*$/.test(l));
  if (idx < 0) return [];
  const found: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const item = lines[i].match(/^\s+-\s+(\S+)\s*$/);
    if (!item) break;
    found.push(item[1]);
  }
  return found;
}

function downloaded(body: string): string[] {
  const names: string[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*actions\/download-artifact@/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      if (/^\s+-\s+uses:/.test(lines[j]) || /^\s+-\s+name:/.test(lines[j])) break;
      const n = lines[j].match(/^\s+name:\s*(\S+)\s*$/);
      if (n) {
        names.push(n[1]);
        break;
      }
    }
  }
  return names;
}

function hasBoth(got: string[], label: string, extra?: unknown): void {
  check(
    label,
    BUILDERS.every((name) => got.includes(name)),
    extra ?? { got },
  );
}

const ciText = readFileSync(CI, "utf8");
const csText = readFileSync(CHANGESETS, "utf8");
const ciJobs = jobs(ciText);
const csJobs = jobs(csText);
const pack = ciJobs.get("seat-pack") ?? "";
const version = csJobs.get("version") ?? "";
const rootPkg = JSON.parse(readFileSync(PKG, "utf8")) as { scripts?: Record<string, string> };
const ciPublish = rootPkg.scripts?.["ci:publish"] ?? "";

console.log("A. PR pack path in ci.yml");
check("ci.yml declares job seat-pack", pack.length > 0);
hasBoth(needsList(pack), "ci.yml seat-pack needs both native linux builders");
hasBoth(downloaded(pack), "ci.yml seat-pack downloads both native linux artifacts");
check(
  "ci.yml seat-pack runs the shared seat pack assembler",
  /scripts\/ci-seat-pack\.sh/.test(pack),
  pack.slice(0, 200),
);

console.log("\nB. Native candidate before qualification");
const coldText = readFileSync(join(ROOT, ".github/workflows/cold-setup.yml"), "utf8");
const coldJobs = jobs(coldText);
const native = coldJobs.get("native") ?? "";
const candidate = coldJobs.get("candidate") ?? "";
const packer = readFileSync(join(ROOT, "scripts/pack-cold-candidate.mjs"), "utf8");
const publisher = readFileSync(join(ROOT, "scripts/publish-cold-candidate.mjs"), "utf8");
check("cold candidate needs the native builder matrix", needsList(candidate).includes("native"));
check("cold native matrix builds x64 and arm64 on native Linux", /arch: x64\s+runner: ubuntu-latest/.test(native) && /arch: arm64\s+runner: ubuntu-24.04-arm/.test(native));
check("cold candidate downloads both native artifacts", ["cold-native-x64", "cold-native-arm64"].every((name) => downloaded(candidate).includes(name)));
check("cold candidate assembles natives before packing", candidate.indexOf("seat-assemble-natives.mjs") >= 0 && candidate.indexOf("seat-assemble-natives.mjs") < candidate.indexOf("pack-cold-candidate.mjs"));
check("cold candidate runs prepublish guards before packing", packer.includes('"run", "prepublishOnly"') && packer.indexOf('"run", "prepublishOnly"') < packer.indexOf('"pack", "--pack-destination"'));
const windowsNative = coldJobs.get("workspace-native") ?? "";
const windowsRecipe = readFileSync(join(ROOT, ".github/workflows/workspace-native.yml"), "utf8");
check("cold candidate needs the Windows native builder", needsList(candidate).includes("workspace-native"));
check("cold Windows builder uses the shared dual-architecture recipe", /^\s+uses:\s*\.\/.github\/workflows\/workspace-native\.yml\s*$/m.test(windowsNative) && !/architectures:/.test(windowsNative) && /default:\s*'\["x64",\s*"arm64"\]'/.test(windowsRecipe));
check("cold candidate downloads both Windows native artifacts", ["workspace-native-x64", "workspace-native-arm64"].every((name) => downloaded(candidate).includes(name)));
check("cold candidate assembles Windows natives before packing", candidate.indexOf("workspace-assemble-natives.mjs") >= 0 && candidate.indexOf("workspace-assemble-natives.mjs") < candidate.indexOf("pack-cold-candidate.mjs"));

console.log("\nC. Qualified archive publication");
check("publication verifies completed cross-run qualification before writing", version.indexOf("release-qualification.mjs verify") >= 0 && version.indexOf("release-qualification.mjs verify") < version.indexOf("publish-cold-candidate.mjs"));
check("publication downloads pinned immutable artifact IDs from the selected run", /artifact-ids:.*steps\.qualification\.outputs\.artifact-ids/.test(version) && /run-id:.*inputs\.qualification_run/.test(version));
check("normal and snapshot publication share the npm-publish Environment", /^\s+environment:\s*npm-publish\s*$/m.test(version) && !csJobs.has("snapshot"));
check("normal publication invokes the qualified archive publisher", /run: node scripts\/publish-cold-candidate\.mjs/.test(version) && ciPublish === "node scripts/publish-cold-candidate.mjs");
check("snapshot publication replays qualified versions before the shared publisher", version.indexOf("apply-cold-versions.mjs") >= 0 && version.indexOf("apply-cold-versions.mjs") < version.indexOf("publish-cold-candidate.mjs"));
check("archive publisher reaches the secure preflight before publication", publisher.indexOf("await preflight({ root, env, exec, deadline, tag })") >= 0 && publisher.indexOf("await preflight({ root, env, exec, deadline, tag })") < publisher.indexOf('await publish("pnpm", ["publish"'));
check("archive publisher does not rebuild or rerun package hooks", publisher.includes('["publish", pkg.archive, "--provenance", "--access=public", "--no-git-checks", "--ignore-scripts"') && !/"build"|"seat-assemble-natives"|"-r"/.test(publisher));
check("pre-publication package probe uses the original Windows native assembly",
  ["workspace-native-x64", "workspace-native-arm64"].every((name) => downloaded(candidate).includes(name)) &&
  candidate.indexOf("workspace-assemble-natives.mjs") >= 0 &&
  candidate.indexOf("workspace-assemble-natives.mjs") < candidate.indexOf("post-publish-install-probe.mjs"));

console.log(`\n${fail === 0 ? "SEAT NATIVE CI SMOKE OK" : "SEAT NATIVE CI SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

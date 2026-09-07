/**
 * The ARM load job consumes one packed tarball. Native linux-x64 and linux-arm64
 * builder jobs must stay wired into the PR pack path and into Changesets version
 * and snapshot. A deleted `needs` edge or a removed `download-artifact` step
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
const snapshot = csJobs.get("snapshot") ?? "";
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

console.log("\nB. Changesets version path");
check("changesets.yml declares job version", version.length > 0);
hasBoth(needsList(version), "changesets.yml version needs both native linux builders");
hasBoth(downloaded(version), "changesets.yml version downloads both native linux artifacts");
check(
  "changesets.yml version publish path runs the shared assembler",
  /pnpm ci:publish/.test(version) && /seat-assemble-natives\.mjs/.test(ciPublish),
  { versionHasCiPublish: /pnpm ci:publish/.test(version), ciPublish },
);

console.log("\nC. Changesets snapshot path");
check("changesets.yml declares job snapshot", snapshot.length > 0);
hasBoth(needsList(snapshot), "changesets.yml snapshot needs both native linux builders");
hasBoth(downloaded(snapshot), "changesets.yml snapshot downloads both native linux artifacts");
check(
  "changesets.yml snapshot runs the shared assembler",
  /scripts\/seat-assemble-natives\.mjs/.test(snapshot),
);

console.log(`\n${fail === 0 ? "SEAT NATIVE CI SMOKE OK" : "SEAT NATIVE CI SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

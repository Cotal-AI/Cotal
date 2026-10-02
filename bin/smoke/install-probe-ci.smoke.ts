/**
 * The install-probe job must exist in changesets.yml and must depend on the version job.
 * The version job must contain the closure gate and the GitHub Release step. This file reads
 * the workflow text and checks structural invariants.
 *
 * Run: pnpm smoke:install-probe-ci
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/install-probe-ci.json
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHANGESETS = join(ROOT, ".github", "workflows", "changesets.yml");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 FAIL: ${name}`, extra ?? ""); }
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
    return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

const csText = readFileSync(CHANGESETS, "utf8");
const csJobs = jobs(csText);

// A. The install-probe job exists
const probeBody = csJobs.get("install-probe") ?? "";
check("changesets.yml declares job install-probe", probeBody.length > 0);

// B. install-probe depends on version
const probeNeeds = needsList(probeBody);
check(
  "install-probe needs the version job",
  probeNeeds.includes("version"),
  { probeNeeds },
);

// C. install-probe runs the probe script
check(
  "install-probe runs the post-publish-install-probe script",
  /post-publish-install-probe\.mjs/.test(probeBody),
  probeBody.slice(0, 200),
);

// D. install-probe builds before probing
check(
  "install-probe runs pnpm build before the probe",
  probeBody.indexOf("pnpm build") >= 0 &&
    probeBody.indexOf("pnpm build") < probeBody.indexOf("post-publish-install-probe"),
  "build must come before probe",
);

// E. The version job cuts the GitHub Release
const versionBody = csJobs.get("version") ?? "";
check(
  "the version job cuts the GitHub Release",
  /gh release create/.test(versionBody),
  versionBody.slice(0, 200),
);

// F. The version job has a closure gate that invokes verify-publish-closure.mjs
check(
  "the version job verifies publish closure before the Release",
  /node scripts\/verify-publish-closure\.mjs/.test(versionBody) &&
    versionBody.indexOf("node scripts/verify-publish-closure") < versionBody.indexOf("gh release create"),
  "closure gate must come before release",
);

const EXPECTED = 6;
check(`every cell ran (${EXPECTED} before sentinel)`, pass + fail === EXPECTED, pass + fail);
console.log(`\nINSTALL PROBE CI SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
console.log("SUITE COMPLETE");
if (fail) process.exitCode = 1;

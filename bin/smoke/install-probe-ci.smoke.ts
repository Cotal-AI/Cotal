/**
 * The package-shape probe runs during preparation, before native lifecycle qualification.
 * The publication job retains its registry closure gate and GitHub Release step.
 * This file reads the workflow text and checks structural invariants.
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

const csText = readFileSync(CHANGESETS, "utf8");
const csJobs = jobs(csText);

const coldJobs = jobs(readFileSync(join(ROOT, ".github/workflows/cold-setup.yml"), "utf8"));
const probeBody = coldJobs.get("candidate") ?? "";
check("cold setup owns the pre-publication package-shape probe", probeBody.length > 0 && !csJobs.has("install-probe"));

const lifecycleNeeds = (coldJobs.get("lifecycle") ?? "").match(/^\s+needs:\s*(\S+)/m)?.[1];
check("native qualification depends on the probed candidate", lifecycleNeeds === "candidate", { lifecycleNeeds });

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

const publishBody = csJobs.get("publish") ?? "";
check(
  "the maintained publisher creates the GitHub Release",
  /uses: changesets\/action\/publish@/.test(publishBody) && /create-github-releases: true/.test(publishBody),
  publishBody.slice(0, 200),
);
check(
  "a successful publication is followed by a fresh install check",
  /if: steps\.publish\.outputs\.published == 'true'/.test(publishBody) &&
    publishBody.indexOf("verify-release-installable.mjs") > publishBody.indexOf("changesets/action/publish@"),
  "the install observation must follow publication",
);

const EXPECTED = 6;
check(`every cell ran (${EXPECTED} before sentinel)`, pass + fail === EXPECTED, pass + fail);
console.log(`\nINSTALL PROBE CI SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
console.log("SUITE COMPLETE");
if (fail) process.exitCode = 1;

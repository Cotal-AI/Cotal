/**
 * The package-shape probe runs during preparation, before native lifecycle qualification.
 * The publication job cuts one GitHub Release per version, and a job of its own then checks that the
 * published CLI installs.
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

// The maintained action pushes the per-package tags and creates no releases; the publish job cuts
// none either, so nothing is announced from inside the publish queue.
const publishBody = csJobs.get("publish") ?? "";
check(
  "the publisher pushes the tags and cuts no GitHub Release itself",
  /uses: changesets\/action\/publish@/.test(publishBody) &&
    /create-github-releases: false/.test(publishBody) &&
    !publishBody.includes("gh release create"),
  publishBody.slice(0, 200),
);
// The public release job follows successful, serialized verification and latest promotion.
// No announcement is cut by the upload action itself.
const verifyBody = csJobs.get("verify-install") ?? "";
check(
  "a successful publication is followed by a fresh install check, then the GitHub Release",
  /^\s+published: \$\{\{ steps\.publish\.outputs\.published \}\}\s*$/m.test(publishBody) &&
    /^\s+needs: publish\s*$/m.test(verifyBody) &&
    /if: needs\.publish\.outputs\.published == 'true'/.test(verifyBody) &&
    /verify-release-installable\.mjs/.test(publishBody) &&
    publishBody.indexOf("npm dist-tag add") > publishBody.indexOf("verify-release-installable.mjs") &&
    verifyBody.includes("gh release create"),
  "the install observation must follow publication and precede the Release",
);

const closureAt = publishBody.indexOf("verify-publish-closure.mjs");
const installAt = publishBody.indexOf("verify-release-installable.mjs");
const promoteAt = publishBody.indexOf("npm dist-tag add");
check(
  "latest promotion follows closure and real install verification inside the serialized publisher",
  closureAt >= 0 && installAt > closureAt && promoteAt > installAt &&
    /group:.*-publish/.test(publishBody) && !/continue-on-error: true|if:.*always\(/.test(publishBody),
  { closureAt, installAt, promoteAt },
);

check("the selected complete plan is staged before the maintained pack action", /stage-release-plan\.mjs stage/.test(csJobs.get("select") ?? "") && /steps\.staged-plan\.outputs\.artifact-id/.test(csJobs.get("select") ?? "") && /publish-plan-artifact-id:.*needs\.select\.outputs\.plan/.test(csJobs.get("pack") ?? ""));
check("packing retains public builds and native assembly without repeated seat TypeScript compilation", /pnpm --filter '!\.\/examples\/\*\*' -r build/.test(csJobs.get("pack") ?? "") && /@cotal-ai\/seat build:native/.test(csJobs.get("native") ?? ""));
check("the publisher installs frozen root tooling and consumes packed bytes without rebuilding", /pnpm --filter cotal-monorepo install --frozen-lockfile --ignore-scripts/.test(publishBody) && /cache: true/.test(publishBody) && !/pnpm (?:-r )?build/.test(publishBody));

check("direct publishing is default and staging requires explicit opt-in without settings-read authority", /steps\.staged-plan\.outputs\.artifact-id \|\| steps\.select\.outputs\.publish-plan-artifact-id/.test(csJobs.get("select") ?? "") && /if: steps\.publish\.outputs\.published == 'true' && vars\.COTAL_STAGED_RELEASE == 'true'/.test(publishBody) && !publishBody.includes("preflight-npm-publish.mjs"));

const EXPECTED = 11;
check(`every cell ran (${EXPECTED} before sentinel)`, pass + fail === EXPECTED, pass + fail);
console.log(`\nINSTALL PROBE CI SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
console.log("SUITE COMPLETE");
if (fail) process.exitCode = 1;

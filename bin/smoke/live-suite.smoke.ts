/**
 * Issue #1430: the live-suite guard must classify by source-level declarations, not by a
 * `-live` / `:live` script-name suffix. A rename of the public script must not change the
 * answer while the source still declares the three infrastructure properties, and a
 * non-infrastructure suite must not become live just because it is named `:live`.
 *
 * Broker-free. The production classifier is imported and graded on fixtures plus the six
 * unsuffixed scripts whose headers already declare the property.
 *
 * Run: pnpm smoke:live-suite
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyLiveSmokeScript,
  classifyLiveSuiteFile,
  classifyLiveSuiteSource,
  leadingSuiteHeader,
  suiteSourceFromScript,
} from "./live-suite.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const scripts = pkg.scripts ?? {};

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

const headerOf = (source: string) => leadingSuiteHeader(source);

console.log("live-suite: source-level infrastructure classification");

check(
  "a leading block comment is the header and later body comments are not",
  headerOf("/** REAL Manager */\nimport x from 'y';\n// REAL pty children\n") === "/** REAL Manager */\n" &&
    !headerOf("/** REAL Manager */\nimport x from 'y';\n// REAL pty children\n").includes("REAL pty children"),
);

check(
  "a REAL Manager header is live",
  classifyLiveSuiteSource("/** a REAL Manager on a real JWT broker */\nexport {}\n").live === true,
);

check(
  "REAL agent processes without a live suffix is live",
  classifyLiveSuiteSource("/** REAL agent processes (e2e-stub.mjs) */\nexport {}\n").live === true,
);

check(
  "REAL pty children without a live suffix is live",
  classifyLiveSuiteSource("/** REAL pty children, graded on the child */\nexport {}\n").live === true,
);

check(
  "a REAL broker header alone is not live",
  classifyLiveSuiteSource("/** against a REAL JWT broker */\nexport {}\n").live === false &&
    classifyLiveSuiteSource("/** against a REAL broker */\nexport {}\n").live === false,
);

check(
  "a non-infrastructure suite is not live regardless of name",
  classifyLiveSuiteSource("/** shard stability: frozen indices */\nexport {}\n").live === false,
);

check(
  "a body mention of REAL Manager after the first statement is not a declaration",
  classifyLiveSuiteSource("export {}\n/** later: REAL Manager */\n").live === false,
);

const fixtureRoot = mkdtempSync(join(tmpdir(), "cotal-live-suite-"));
try {
  mkdirSync(join(fixtureRoot, "smoke"), { recursive: true });
  writeFileSync(
    join(fixtureRoot, "smoke", "seat-input-live.smoke.ts"),
    "/** over a REAL Manager, a REAL JWT broker and REAL pty children */\nexport {}\n",
  );
  writeFileSync(join(fixtureRoot, "smoke", "ordinary.smoke.ts"), "/** frozen list parser */\nexport {}\n");
  const liveFile = classifyLiveSuiteFile(fixtureRoot, "smoke/seat-input-live.smoke.ts");
  const ordinaryFile = classifyLiveSuiteFile(fixtureRoot, "smoke/ordinary.smoke.ts");
  check(
    "a file named *-live whose header declares REAL Manager and REAL pty children is live",
    liveFile.live === true &&
      liveFile.declarations.includes("REAL Manager") &&
      liveFile.declarations.includes("REAL pty children"),
    liveFile,
  );
  check("an ordinary suite file is not live", ordinaryFile.live === false, ordinaryFile);

  const liveByHonestName = classifyLiveSmokeScript(fixtureRoot, "smoke:seat-input", {
    "smoke:seat-input": "tsx smoke/seat-input-live.smoke.ts",
  });
  const liveByRenamedScript = classifyLiveSmokeScript(fixtureRoot, "smoke:renamed-harmless", {
    "smoke:renamed-harmless": "tsx smoke/seat-input-live.smoke.ts",
  });
  check(
    "renaming a script does not change classification when the source still declares real infrastructure",
    liveByHonestName.live === true &&
      liveByRenamedScript.live === true &&
      JSON.stringify(liveByHonestName.declarations) === JSON.stringify(liveByRenamedScript.declarations),
    { liveByHonestName, liveByRenamedScript },
  );

  const namedLiveOrdinary = classifyLiveSmokeScript(fixtureRoot, "smoke:ordinary:live", {
    "smoke:ordinary:live": "tsx smoke/ordinary.smoke.ts",
  });
  const namedLiveDash = classifyLiveSmokeScript(fixtureRoot, "smoke:ordinary-live", {
    "smoke:ordinary-live": "tsx smoke/ordinary.smoke.ts",
  });
  check(
    "a :live script name does not classify a non-infrastructure suite as live",
    namedLiveOrdinary.live === false && namedLiveOrdinary.source === "smoke/ordinary.smoke.ts",
    namedLiveOrdinary,
  );
  check(
    "a -live script name does not classify a non-infrastructure suite as live",
    namedLiveDash.live === false,
    namedLiveDash,
  );

  check(
    "tsx path resolution ignores a live suffix on the public script name",
    suiteSourceFromScript("pnpm --filter cotal-ai... build && tsx smoke/seat-input-live.smoke.ts") ===
      "smoke/seat-input-live.smoke.ts",
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

const expectedLive = [
  "smoke:manager-service",
  "smoke:manager-service-ops",
  "smoke:manager-service-invoke",
  "smoke:manager-spawn-action",
  "smoke:persona-announce",
  "smoke:seat-input",
] as const;

for (const name of expectedLive) {
  const classified = classifyLiveSmokeScript(ROOT, name, scripts);
  check(
    `${name} is live from its source declarations, not from a -live suffix`,
    classified.live === true && !/:(?:live)$/.test(name) && !/-live$/.test(name),
    classified,
  );
}

check(
  "smoke:seat-input stays live even though the public script drops the file's -live suffix",
  classifyLiveSmokeScript(ROOT, "smoke:seat-input", scripts).source ===
    "implementations/manager/smoke/seat-input-live.smoke.ts" &&
    classifyLiveSmokeScript(ROOT, "smoke:seat-input", scripts).live === true,
);

check(
  "this classifier's own suite is not live",
  classifyLiveSmokeScript(ROOT, "smoke:live-suite", {
    ...scripts,
    "smoke:live-suite": "tsx bin/smoke/live-suite.smoke.ts",
  }).live === false,
);

const EXPECTED = 21;
check(
  `every cell ran - ${EXPECTED} expected, so a cell that stops existing is not mistaken for one that passed`,
  pass + fail === EXPECTED,
  `${pass + fail} cells reported`,
);

console.log(`LIVE SUITE SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;

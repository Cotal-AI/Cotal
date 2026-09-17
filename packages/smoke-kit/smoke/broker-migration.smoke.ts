/**
 * THE MIGRATION GATE for #1008: every place this repo starts a `nats-server` must be claimable by
 * the reaper and killable by the teardown helper.
 *
 * Run: pnpm smoke:broker-migration   (no broker needed: this reads source, not `ps`)
 *
 * WHY THIS SUITE EXISTS AT ALL, given that #1008's five suites are already migrated. The five were
 * fixed and nothing was left behind to keep them fixed. The reaper's header states the standing
 * condition plainly: it "is only ever as complete as the migration that mints the token". So the
 * durable defect was never those five files, it was that the repo had no way to notice a SIXTH. A
 * gate naming filenames has that same blind spot by construction, so this one names none: it walks
 * `git ls-files` through {@link enumerateSpawnSites} and grades whatever it finds.
 *
 * THE CENTRAL CELL IS A CENSUS, NOT A LIST. `every spawn site is adopted` fails on a count and
 * prints the offenders it found. Add an untokened broker anywhere in the repo, in a file nobody here
 * has heard of, and this goes red on the commit that adds it.
 *
 * WHY A SELF-CHECK CELL SITS NEXT TO IT. A census over source is only as good as its parser, and a
 * parser that silently stopped recognizing spawn sites would report zero violations and read exactly
 * like a clean repo. That failure is invisible from the outside, so the detector is exercised
 * DIRECTLY against a synthesized untokened spawn: if the enumerator cannot see a planted violation,
 * the census above is worthless and this says so rather than passing quietly.
 *
 * WHAT THIS DOES NOT CLAIM. It proves argv carries the token and the handle is owned, which is what
 * the reaper and the helper each need. It does not prove a suite's normal-path `finally` is correct,
 * which is defect 1 in the helper's taxonomy and is not visible in a spawn site's shape.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EXEMPT_MARKER, SMOKE_BROKER_PREFIX, SMOKE_BROKER_TOKEN, enumerateSpawnSites, inScope, isAdopted } from "@cotal-ai/smoke-kit";

const repo = join(import.meta.dirname, "..", "..", "..");
const failures: string[] = [];
let passed = 0;

function cell(name: string, run: () => void): void {
  try {
    run();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sites = enumerateSpawnSites(repo);
const scoped = sites.filter(inScope);
const unadopted = scoped.filter((s) => !isAdopted(s));

console.log(
  `  · enumerated ${sites.length} nats-server spawn sites in ${new Set(sites.map((s) => s.file)).size} files` +
    ` (${sites.filter((s) => s.shipped).length} shipped, ${sites.filter((s) => s.exempt).length} exempt, ${scoped.length} in scope)`,
);

// The population has to be non-trivial, or every cell below passes vacuously. A parser that matched
// nothing would report a perfectly clean repo, which is the one failure a census cannot survive.
cell("the enumerator finds the repo's spawn sites at all", () => {
  assert.ok(sites.length >= 100, `expected a three-figure population, saw ${sites.length}`);
  assert.ok(scoped.length >= 100, `expected most sites in scope, saw ${scoped.length}`);
});

// THE GATE. No filenames: whatever `git ls-files` currently holds.
cell("every spawn site is adopted: tokened argv and an owned handle", () => {
  const detail = unadopted
    .map((s) => `    ${s.file}:${s.line} [${s.argvPath}] ${s.tokened ? "" : "UNTOKENED "}${s.owned ? "" : "UNOWNED "}path=${s.pathExpr ?? "(none in argv)"}`)
    .join("\n");
  assert.equal(
    unadopted.length,
    0,
    `${unadopted.length} spawn site(s) start a broker the reaper cannot claim or the helper cannot kill:\n${detail}\n` +
      `  Fix: mint the argv path through SMOKE_BROKER_TOKEN and pass the child to teardownOnSignal,\n` +
      `  or mark a deliberate negative control with ${EXEMPT_MARKER}.`,
  );
});

// THE PARSER IS GRADED AGAINST HAND-READ SOURCE, not only against a synthetic fixture. A planted
// file exercises the shapes this suite chose to plant; real suites use shapes nobody thought to
// plant, and the detector has already been wrong about one of them: a `const port = ..., conf =
// join(dir, "x.conf")` declarator list read a correctly tokened suite as UNTOKENED until the
// resolver learned to split declarators. A false positive is not a harmless over-report here,
// because the cure for it is to relax the parser, and a parser relaxed in the wrong place stops
// seeing real violations. So both verdicts are pinned on sites whose source was read by hand.
const VERIFIED: ReadonlyArray<readonly [string, number, boolean, string]> = [
  ["bin/smoke/persona-announce.smoke.ts", 139, true, "conf path inside a token-minted dir, owned"],
  ["bin/smoke/persona-agent.smoke.ts", 158, true, "store dir minted from the token, owned"],
  ["packages/core/smoke/channels.smoke.ts", 60, true, "store dir under a token-minted dir"],
  ["packages/core/smoke/channels-auth.smoke.ts", 45, true, "conf bound in a declarator LIST under a tokened dir"],
  ["extensions/connector-core/smoke/transport-liveness-broker.smoke.ts", 50, true, "spawn inside a FACTORY whose callers own the handle"],
  ["implementations/manager/smoke/hosted-retirement-native.acceptance.ts", 588, true, "handle assigned THROUGH a tracker wrapper, then owned"],
  ["packages/core/smoke/endpoint-session.smoke.ts", 465, true, "non-JetStream broker given a tokened -sd purely as argv evidence"],
  // The repo is fully migrated, so a still-unadopted REAL site no longer exists to pin. The
  // negative direction is held by the planted-fixture cell below, which builds one on demand, and
  // by the exempt site here: the marker must suppress the verdict, not the enumeration.
  ["bin/smoke/reaper.smoke.ts", 510, false, "deliberate negative control, exempt by marker"],
];

cell("the enumerator's verdict matches source read by hand, in both directions", () => {
  const wrong: string[] = [];
  for (const [file, line, want, why] of VERIFIED) {
    const s = sites.find((x) => x.file === file && Math.abs(x.line - line) <= 3);
    if (s === undefined) {
      // A moved line is fine; a site that vanished means the parser stopped seeing a spawn it used
      // to see, which is precisely the silent-blindness failure this cell exists to catch.
      if (sites.some((x) => x.file === file)) continue;
      wrong.push(`${file}:${line} is no longer enumerated at all (${why})`);
      continue;
    }
    if (isAdopted(s) !== want) wrong.push(`${file}:${s.line} read as adopted=${isAdopted(s)}, hand-read says ${want} (${why}); tokened=${s.tokened} owned=${s.owned} argv=${s.argvPath}`);
  }
  assert.deepEqual(wrong, [], `the enumerator disagrees with hand-read source:\n    ${wrong.join("\n    ")}`);
});

// THE DETECTOR'S OWN PROOF. Synthesize a suite that spawns an untokened broker and require the
// enumerator to see it. Without this, a parser that stopped matching would report zero violations.
cell("the enumerator detects a newly added untokened spawn site", () => {
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-selfcheck-`));
  try {
    execFileSync("git", ["init", "-q", scratch], { encoding: "utf8" });
    const planted = join(scratch, "smoke", "planted.smoke.ts");
    execFileSync("mkdir", ["-p", join(scratch, "smoke")]);
    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `const sd = mkdtempSync(join(tmpdir(), "cotal-sixth-suite-js-"));\n` +
        `const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", "4222", "-js", "-sd", sd], { stdio: "ignore" });\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });

    const found = enumerateSpawnSites(scratch);
    assert.equal(found.length, 1, `expected the planted spawn to be enumerated, saw ${found.length}`);
    assert.equal(found[0]!.tokened, false, "the planted spawn mints no token, so it must read as untokened");
    assert.equal(found[0]!.owned, false, "the planted spawn takes no ownership, so it must read as unowned");
    assert.equal(isAdopted(found[0]!), false, "an untokened, unowned spawn must not read as adopted");
    assert.equal(found.filter(inScope).length, 1, "a planted test-file spawn must be in scope");

    // And the same site, once migrated, must read as CLEAN. A detector that called everything a
    // violation would also pass the cell above while being useless.
    writeFileSync(
      planted,
      `import { spawn } from "node:child_process";\n` +
        `import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";\n` +
        `const sd = mkdtempSync(join(tmpdir(), \`\${SMOKE_BROKER_TOKEN}sixth-js-\`));\n` +
        `const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", "4222", "-js", "-sd", sd], { stdio: "ignore" });\n` +
        `const release = teardownOnSignal(broker, sd);\n`,
    );
    execFileSync("git", ["-C", scratch, "add", "-A"], { encoding: "utf8" });
    const fixed = enumerateSpawnSites(scratch);
    assert.equal(fixed.length, 1, "the migrated spawn is still one enumerated site");
    assert.equal(isAdopted(fixed[0]!), true, "a tokened, owned spawn must read as adopted");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The token the gate requires must be the one the reaper matches. Two literals that drift apart
// would leave every suite "migrated" against a prefix nothing reaps.
cell("the required token is the prefix the reaper matches", async () => {
  assert.ok(SMOKE_BROKER_TOKEN.startsWith(SMOKE_BROKER_PREFIX), "the minted token must carry the reaper's prefix");
  assert.match(SMOKE_BROKER_TOKEN, new RegExp(`^${SMOKE_BROKER_PREFIX}\\d+-$`), "the token must carry the owner pid the reaper parses");
});

console.log(`\n${failures.length === 0 ? "BROKER MIGRATION CHECKS PASSED" : "BROKER MIGRATION CHECKS FAILED"} (${passed} passed, ${failures.length} failed)`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  failed: ${f}`);
  process.exit(1);
}

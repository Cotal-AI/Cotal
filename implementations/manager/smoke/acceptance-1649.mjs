// Acceptance harness for issue #1649: does a seat SUBMIT the text the call delivered, or the text
// the PREVIOUS call delivered?
//
// This is deliberately not a unit test. It drives a real `jcode` TUI under a real pty and reads what
// the seat actually submitted from the seat's OWN prompt-history.jsonl, so it can only pass if the
// bytes reached the child AND the child treated the return as a submit key. The manager's own
// receipt is exactly what cannot be trusted here: with the defect present the call still reports
// `bytes: <full length>` and exit 0 while nothing was submitted.
//
// Runnable as published, from the worktree root:
//   node implementations/manager/smoke/acceptance-1649.mjs
// Exit 0 = the seat submitted every text on the call that sent it. Exit 1 = one call behind (#1649).
// Exit 2 = could not be measured here (no `jcode`, no pty binding, or the TUI was never observed),
// so a missing prerequisite or a loaded host can never be mistaken for the defect.
//
// RUN THIS ON A QUIET HOST. It drives a real TUI under a real pty and is load-sensitive: measured
// 4/4 aligned at 1-minute load ~7, but 2 failures in 3 at load ~42, always by losing submissions
// entirely rather than by submitting the wrong ones. Those losses are reported as exit 2, not 1.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Whatever runs this file may be a managed agent session, so the inherited environment can carry
// a live credential and a live broker URL, and `run` spreads that environment into the pty child
// below. Drop the COTAL_ keys here, at module scope: a scrub inside the function would be a
// promise that it runs before every spread rather than a fact about what the child can inherit.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const JCODE = spawnSync("command", ["-v", "jcode"], { shell: true, encoding: "utf8" }).stdout.trim();
if (!JCODE) {
  console.error("SKIP: no `jcode` on PATH; this harness needs a real TUI to drive.");
  process.exit(2);
}
// Resolve the pty binding against the MANAGER package, which is what declares the dependency.
// Importing it bare only works when cwd is already inside that package, so a verifier running this
// from the worktree root (as published) would otherwise get ERR_MODULE_NOT_FOUND.
let pty;
try {
  const { createRequire } = await import("node:module");
  const requireFrom = createRequire(new URL("../package.json", import.meta.url));
  pty = await import(pathToFileURL(requireFrom.resolve("@lydell/node-pty")).href);
} catch (error) {
  console.error(`SKIP: cannot load @lydell/node-pty (${error.code ?? error.message}).`);
  process.exit(2);
}

// The two texts from the issue: a short one and one comfortably over the pty's 4096-byte input
// buffer, so both the fused-write and the oversized-write halves of the defect are exercised.
const TEXTS = ["x".repeat(231), "y".repeat(1986)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fix under test, in the two shapes the manager can write. `split` mirrors inputAuthorized after
// the fix (slices under the buffer, then the return alone); `fused` is the pre-fix `${text}\r`.
async function deliver(child, text, mode) {
  if (mode === "fused") {
    child.write(`${text}\r`);
    return;
  }
  const SLICE = 2048;
  for (let i = 0; i < text.length; i += SLICE) {
    child.write(text.slice(i, i + SLICE));
    await new Promise((r) => setImmediate(r));
  }
  child.write("\r");
}

async function run(mode) {
  // A FRESH home per mode. Sharing one home let the second run read the FIRST run's submissions:
  // fused reported [231,1986,231] because the leading two were split's, so the comparison passed
  // for the wrong reason. Each mode must be measured against an empty history.
  const HOME = mkdtempSync(join(tmpdir(), "acc1649-"));
  const child = pty.spawn(JCODE, [], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: HOME,
    env: { ...process.env, HOME, JCODE_HOME: join(HOME, ".jcode"), CI: "1" },
  });
  child.onData(() => {});
  await sleep(6000);
  child.write("\x1b"); // skip onboarding
  await sleep(1500);
  for (const t of TEXTS) {
    await deliver(child, t, mode);
    await sleep(4000);
  }
  await sleep(2000);
  try { child.kill(); } catch {}
  await sleep(500);

  const hist = join(HOME, ".jcode", "prompt-history.jsonl");
  if (!existsSync(hist)) { rmSync(HOME, { recursive: true, force: true }); return []; }
  // Each line is a BARE JSON STRING (e.g. "hello"), not an object. An earlier version of this
  // harness read `entry.text ?? entry.prompt`, which is undefined for a string and scored every
  // real submission as length 0 - making both the fixed and reverted runs report [] and "fail"
  // identically, which proves nothing. Accept an object shape too in case the format gains fields.
  const lengths = readFileSync(hist, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .map((e) => (typeof e === "string" ? e : (e?.text ?? e?.prompt ?? "")))
    .map((s) => s.length)
    .filter((n) => n > 0);
  rmSync(HOME, { recursive: true, force: true });
  return lengths;
}

const want = TEXTS.map((t) => t.length);
const split = await run("split");
const fused = await run("fused");

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
console.log(`want submitted     : [${want}]`);
console.log(`SPLIT   (with fix) : [${split}]  aligned=${eq(split, want)}`);
console.log(`FUSED   (pre-fix)  : [${fused}]  aligned=${eq(fused, want)}`);

// A run where the fixed shape submitted NOTHING, or fewer texts than the fused shape managed, means
// the TUI never got far enough to be observed - not that the fix failed. This harness imports no
// repo code (it reimplements both write shapes), so it CANNOT be sensitive to the fix; a run that
// cannot see the child is a no-result. Measured: 4/4 aligned at 1-minute load ~7, but 2 failures in
// 3 at load ~42, always by losing submissions entirely. Exit 2 (environment) rather than 1 (defect)
// so a loaded host can never be misread as a regression.
if (split.length === 0 || split.length < fused.length) {
  console.error("\nNO RESULT: the fixed write shape recorded fewer submissions than the pre-fix one,");
  console.error("which means the TUI was not observed, not that the fix regressed. Re-run when the");
  console.error("host is quiet (1-minute load under ~15).");
  process.exit(2);
}
if (!eq(split, want)) {
  console.error("\nFAIL: with the fix's write shape the seat did NOT submit every text on the call that sent it.");
  process.exit(1);
}
if (eq(fused, want)) {
  console.error("\nFAIL: the pre-fix fused write ALSO submitted everything, so this harness is not");
  console.error("discriminating the defect and proves nothing. Check the TUI actually started.");
  process.exit(1);
}
console.log("\nOK: split submits on the call that sends it; fused is one call behind (#1649).");
process.exit(0);

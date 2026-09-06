/**
 * Ambient-environment census over the SUITES themselves - the cell for a class this repo's runtime
 * cells structurally cannot see.
 *
 * WHAT KEEPS HAPPENING. A suite builds a child process env as `{ ...process.env, ...somethingOurs }`.
 * Whatever runs that suite may itself be a managed agent session, whose environment carries a live
 * credential path, a live broker URL and a control token. The spread hands all of it to the child.
 * Two suites were doing exactly this and both were GREEN: the connector env layered on top used to
 * overwrite precisely the variables that would have made the inheritance visible, so the child got a
 * working identity and nothing anywhere recorded where it came from.
 *
 * WHY A RUNTIME CELL CANNOT CATCH IT. `seat-env-scope` watches what a connector's launch spec hands
 * a real descendant. It has no view of what ANOTHER suite's harness inherits from ITS runner. The
 * only shape that can fail a future suite which reintroduces the spread is a static census over the
 * suite sources, which is what this is. The idea is a reviewer's, not mine.
 *
 * THE RULE. Every `...process.env` spread into a child environment must either strip the `COTAL_`
 * variables from that copy first, or the file must appear in {@link REVIEWED} with a measured
 * reason. A strip on a different child in the same file does not clear an unstripped spread.
 * Exempt is not "we looked away": each entry names why that file's child cannot capture an
 * identity, and adding one is a conscious edit in a file a reviewer reads.
 *
 * Run: `pnpm smoke:suite-ambient-env`
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", "dist", ".git", ".pnpm-store", "coverage", "reserved"]);

/** Every tracked source file under a smoke path. Keyed on CONTENT and location, not on one
 *  directory: the suites live under `bin/smoke`, under a package's own `smoke` directory, and as
 *  bare `*.smoke.ts` files beside their package. A census that knew only the first would miss the
 *  other two silently. */
function* suiteSources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* suiteSources(p);
    else if (/\.(ts|mts|cts|mjs|js)$/.test(e.name) && statSync(p).size < 2_000_000) {
      const rel = relative(repoRoot, p).split("\\").join("/");
      if (/(^|\/)smoke(\/|\.)/.test(rel) || /\.smoke\.[a-z]+$/.test(rel)) yield p;
    }
  }
}

/** The spread, written the way people write it. */
const SPREAD = /\.\.\.process\.env\b/g;
/** A strip: a loop that deletes the `COTAL_` keys from a copy before the copy is spread. Matched on
 *  the two halves together, so a file that merely MENTIONS the prefix does not pass. */
const STRIP = /startsWith\(["']COTAL_["']\)/;
const DELETE = /\bdelete\b/;
/** A file that mutates `process.env` itself, then later spreads it, has already dropped the ambient
 *  keys from what the child will inherit. The mutation has to be a keys-loop that deletes `COTAL_`,
 *  not a mention of those tokens in a comment or a different object. */
const PROCESS_ENV_STRIP =
  /for\s*\(\s*const\s+\w+\s+of\s+Object\.keys\(\s*process\.env\s*\)\)[\s\S]{0,160}?startsWith\(\s*["']COTAL_["']\s*\)[\s\S]{0,80}?delete\s+process\.env/;

/** Comments are not child env. The census used to treat a `delete` in prose plus a `startsWith("COTAL_")`
 *  on a different child as a strip of every spread in the file. */
function codeWithoutComments(src: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "sq" | "dq" | "bt" | "line" | "block" = "code";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else out += " ";
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    if (state === "sq" || state === "dq") {
      if (c === "\\") {
        out += c + (n ?? "");
        i += 2;
        continue;
      }
      out += c;
      if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) state = "code";
      i++;
      continue;
    }
    if (state === "bt") {
      if (c === "\\") {
        out += c + (n ?? "");
        i += 2;
        continue;
      }
      if (c === "`") state = "code";
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      state = "line";
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "/" && n === "*") {
      state = "block";
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "'") state = "sq";
    else if (c === '"') state = "dq";
    else if (c === "`") state = "bt";
    out += c;
    i++;
  }
  return out;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

function windowAfter(src: string, index: number, lines: number): string {
  let end = index;
  for (let n = 0; n < lines; n++) {
    const nl = src.indexOf("\n", end + 1);
    if (nl < 0) return src.slice(index);
    end = nl;
  }
  return src.slice(index, end);
}

function spreadIndexes(code: string): number[] {
  return [...code.matchAll(SPREAD)].map((m) => m.index ?? -1).filter((i) => i >= 0);
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when THIS spread is assigned to a copy which is then scrubbed, or `process.env` was already
 *  stripped in this file. Matching the copied variable prevents a later child's strip from clearing
 *  an earlier unstripped spread. */
function spreadStripped(code: string, index: number): boolean {
  if (PROCESS_ENV_STRIP.test(code.slice(0, index))) return true;
  const before = code.slice(Math.max(0, index - 320), index);
  const assignment = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=;\n]+)?\s*=\s*\{[^{}]*$/.exec(before);
  if (!assignment) return false;
  const name = regexEscape(assignment[1]);
  const after = windowAfter(code, index, 12);
  const copyStrip = new RegExp(
    `^\\.\\.\\.process\\.env\\b[^}]*}\\s*;[\\s\\S]{0,240}?Object\\.keys\\(\\s*${name}\\s*\\)[\\s\\S]{0,160}?startsWith\\(\\s*["']COTAL_["']\\s*\\)[\\s\\S]{0,80}?delete\\s+${name}\\s*\\[`,
  );
  return copyStrip.test(after);
}

function unstrippedSpreadLines(src: string): number[] {
  const code = codeWithoutComments(src);
  return spreadIndexes(code).filter((index) => !spreadStripped(code, index)).map((index) => lineOf(code, index));
}

// Regression cell: one stripped child cannot clear another unstripped child, and a comment that says
// `delete` is not a mechanism. Put the unsafe child first so the following child's real strip is also
// inside the matching window. The same file shape passes when every spread is followed by its strip.
assert.deepEqual(
  unstrippedSpreadLines(`
const first = { ...process.env };
// delete is prose, not a stripping mechanism.
spawn("first", { env: first });
const second = { ...process.env };
for (const key of Object.keys(second)) if (key.startsWith("COTAL_")) delete second[key];
spawn("second", { env: second });
`),
  [2],
  "a mixed file must fail when one child spread is unstripped",
);
assert.deepEqual(
  unstrippedSpreadLines(`
const first = { ...process.env };
for (const key of Object.keys(first)) if (key.startsWith("COTAL_")) delete first[key];
spawn("first", { env: first });
const second = { ...process.env };
for (const key of Object.keys(second)) if (key.startsWith("COTAL_")) delete second[key];
spawn("second", { env: second });
`),
  [],
  "a file must pass when every child spread is stripped",
);

/**
 * Files that spread the ambient environment and are graded SAFE, each with the measurement.
 *
 * Every reason here is about the CHILD: a child that never reads Cotal connection material cannot
 * capture an identity from what it inherited, however much it inherited. A file whose child changes
 * shape has to be re-measured, which is why the reason and not just the path is recorded.
 */
const REVIEWED: Record<string, string> = {
  "bin/smoke/suite-ambient-env.smoke.ts": "this census itself: its ambient spreads occur only in fixture strings and it spawns nothing",
  "implementations/cli/smoke/command-kernel.smoke.ts":
    "spawns the cotal CLI for an ext-update path; the child consumes COTAL_UPDATE_* and COTAL_SKIP_CONNECTOR_SEED and never calls configFromEnv/controlFromEnv",
  "implementations/cli/smoke/update-concurrency.smoke.ts":
    "same ext-update shape: self-reentered node helpers reading COTAL_UPDATE_* / XDG_CONFIG_HOME, no connection material read",
  "bin/smoke/herdr-e2e-live.smoke.ts":
    "spawns herdr-e2e-manager-child.mjs, which builds its OWN stub identity from HE2E_* and sets the COTAL_ vars itself rather than reading the inherited ones",
};

/**
 * THE RATCHET, and read the next sentence before you read the list.
 *
 * IT IS A TRACKED DEFERRAL, NOT A WAIVER: the 44 are owned by issue #619, which carries the names,
 * which of them spawn the CLI, and what "done" looks like for each. A frozen baseline pointing at an
 * open issue is a deferral; one pointing at nothing is a waiver that outlives everyone who agreed to
 * it. If #619 is closed and this list is not empty, this comment is the lie and the list is the
 * truth.
 *
 * THESE FILES ARE NOT CLEARED. Nobody has measured whether their children read connection material,
 * and this suite does not claim they are safe. They are the ambient spreads that already existed
 * when this census was written, frozen so that the SET CANNOT GROW. A new suite that spreads without
 * stripping fails here; an old one keeps doing what it was already doing until somebody audits it.
 *
 * Saying that plainly matters more than the list. A frozen baseline presented as a clean bill of
 * health is worse than no baseline, because the next reader stops looking. Several of these spawn the
 * `cotal` CLI, which DOES read connection material, so some of them are very likely real instances of
 * the same defect that was found twice on this branch. Auditing them is its own piece of work and
 * does not belong in a credential change.
 *
 * The ratchet also TIGHTENS: an entry that no longer spreads must be deleted from this list, so the
 * baseline shrinks as files are fixed and can never quietly become a permanent waiver.
 */
const FROZEN: readonly string[] = [
  "bin/smoke/backup-conservation-live.smoke.ts",
  "bin/smoke/backup-faults-live.smoke.ts",
  "bin/smoke/backup-restore-live.smoke.ts",
  "bin/smoke/backup-usermode-live.smoke.ts",
  "bin/smoke/dogfood-live.smoke.ts",
  "bin/smoke/ext-live.smoke.ts",
  "bin/smoke/orca-extension-live.smoke.ts",
  "bin/smoke/seed-tarball-live.smoke.ts",
  "bin/smoke/setup-pure-live.smoke.ts",
  "bin/smoke/spawn-detach-live.smoke.ts",
  "bin/smoke/up-stack-live.smoke.ts",
  "bin/smoke/up-tls-routes-live.smoke.ts",
  "extensions/connector-core/smoke/feedback.smoke.ts",
  "implementations/auth/smoke/down-manifest-usermode.smoke.ts",
  "implementations/auth/smoke/freeslot-respawn-barrier.smoke.ts",
  "implementations/auth/smoke/int2-revoke-hold.smoke.ts",
  "implementations/auth/smoke/_ps-arm2.smoke.ts",
  "implementations/auth/smoke/ps-operator-path.smoke.ts",
  "implementations/auth/smoke/ps-user-mode.smoke.ts",
  "implementations/cli/smoke/bind-fence-live.smoke.ts",
  "implementations/cli/smoke/ext-seed-help.smoke.ts",
  "implementations/cli/smoke/join-creds-pairing.smoke.ts",
  "implementations/cli/smoke/manager-singleton-live.smoke.ts",
  "implementations/cli/smoke/spawn-manifest-live.smoke.ts",
  "implementations/cli/smoke/sys-rotation-e2e.smoke.ts",
  "implementations/cli/smoke/up-manifest-live.smoke.ts",
  "implementations/delivery/smoke/adoption-doctor-e2e.smoke.ts",
  "implementations/delivery/smoke/adoption-false-green.smoke.ts",
  "implementations/delivery/smoke/adoption-passive-preflight.smoke.ts",
  "implementations/delivery/smoke/delivery-broker-coupling.smoke.ts",
  "implementations/delivery/smoke/delivery-cred-renewal.smoke.ts",
  "implementations/manager/smoke/attach-reconnect.smoke.ts",
  "implementations/manager/smoke/cli-on-instance-live.smoke.ts",
  "implementations/manager/smoke/cli-seat-locality.smoke.ts",
  "implementations/manager/smoke/gate-reconcile-cli-e2e.smoke.ts",
  "implementations/manager/smoke/_probe-attach-reconnect.ts",
  "implementations/manager/smoke/_probe-cellj-timing.ts",
  "implementations/manager/smoke/_probe-session-leak.ts",
  "implementations/manager/smoke/seat-input-live.smoke.ts",
  "implementations/manager/smoke/windows-launch.smoke.ts",
  "packages/core/smoke/presence-ttl-refresh-cli.smoke.ts",
];

const offenders: string[] = [];
const frozen: string[] = [];
const stripped: string[] = [];
const exempted: string[] = [];

for (const file of suiteSources(repoRoot)) {
  const rel = relative(repoRoot, file).split("\\").join("/");
  const body = readFileSync(file, "utf8");
  const code = codeWithoutComments(body);
  const spreads = spreadIndexes(code);
  if (spreads.length === 0) continue;
  if (rel in REVIEWED) {
    exempted.push(rel);
    continue;
  }
  const unstripped = spreads.filter((index) => !spreadStripped(code, index));
  if (unstripped.length === 0) {
    stripped.push(rel);
    continue;
  }
  if (FROZEN.includes(rel)) {
    frozen.push(rel);
    continue;
  }
  offenders.push(
    `${rel} (unstripped spread at line ${unstripped.map((i) => lineOf(code, i)).join(", ")})`,
  );
}

console.log(
  `• census: ${stripped.length + exempted.length + frozen.length + offenders.length} suite file(s) spread the ambient environment ` +
    `(${stripped.length} strip, ${exempted.length} reviewed-safe, ${frozen.length} frozen and UNAUDITED)`,
);
for (const f of stripped) console.log(`  ✓ ${f} - strips COTAL_ before the spread`);
for (const f of exempted) console.log(`  · ${f} - reviewed safe: ${REVIEWED[f]}`);

// A census that found nothing is not a pass. The spread is a normal thing for a suite to do, so a
// zero here means the scan stopped seeing files, not that the tree got clean.
assert.ok(
  stripped.length + exempted.length + frozen.length + offenders.length > 0,
  "the census matched no suite files at all, which means the scan is broken rather than the tree being clean",
);
// Every exemption must correspond to a file that still exists and still spreads; a stale entry is a
// waiver nobody is checking.
for (const path of Object.keys(REVIEWED))
  assert.ok(
    exempted.includes(path),
    `REVIEWED lists ${path}, but the census did not find an ambient spread there - remove the stale entry rather than leaving a waiver in place`,
  );
// The ratchet tightens: a frozen entry that stopped spreading (or was stripped) must leave the list,
// or the baseline becomes a permanent waiver that outlives the thing it waived.
const staleFrozen = FROZEN.filter((f) => !frozen.includes(f));
assert.deepEqual(
  staleFrozen,
  [],
  `FROZEN still lists file(s) that no longer spread the ambient environment:\n  ${staleFrozen.join("\n  ")}\nDelete them from the list; the baseline is only allowed to shrink.`,
);

assert.deepEqual(
  offenders,
  [],
  `these suite files spread the ambient environment into a child without stripping COTAL_ first:\n  ${offenders.join(
    "\n  ",
  )}\nWhatever runs a suite may be a managed agent session, so that spread hands the child a live credential and a live broker URL. Strip the COTAL_ keys from the copy first, or add the file to REVIEWED with the measured reason its child cannot read connection material. Do NOT add it to FROZEN: that list is a frozen baseline, not a place to put new ones.`,
);

console.log("\nsuite-ambient-env: PASS");

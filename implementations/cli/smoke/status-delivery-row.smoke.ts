/**
 * `cotal status` RENDERS A DELIVERY ROW — driven through the real command function.
 *
 * WHY THIS EXISTS. Every other cell in this lane drives `deliveryRow(...)` directly with the caller
 * injected. A killed mutation there proves those tests DEPEND on the row; it does not prove any
 * command REACHES it. That gap was not hypothetical: the row was first wired only into `readyCard`,
 * whose sole call site is the end of `cotal setup`, so the question "is delivery actually working
 * right now" stayed unanswerable from `cotal status` while every suite was green. The suites could
 * not have caught it, because none of them entered through a command.
 *
 * WHAT THIS PROVES, EXACTLY: the real exported `status()` emits a non-empty `delivery` row that names
 * why health could not be established. It enters through the command function, not through the row.
 *
 * WHAT IT DOES NOT PROVE, NAMED RATHER THAN IMPLIED: it exercises the path where preflight FAILS, so
 * it never reaches `deliveryStatusRow` → `mintDeliveryCaller` → `deliveryRow`. Reaching those needs a
 * broker that answers preflight, which is the owed live cell on this lane's list. This
 * cell closes "does the command print a delivery line at all", which nothing previously proved, and
 * it does not close "does the command reach the health assessment".
 *
 * Run: pnpm exec tsx implementations/cli/smoke/status-delivery-row.smoke.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCotalRoot, recordMesh } from "@cotal-ai/workspace";
import { status } from "../src/commands/status.js";
import { evidenceComesOnlyFrom, mustNotSay, nothingMatches, rowLabel } from "./_output-invariant.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` — ${String(detail)}`}`); }
};

// ---- FIRST ACTION: the broker this cell names must not be the live host. A dead loopback port is
// the point of the cell, but the assertion is unconditional so it cannot be silently edited away.
const DEAD = "nats://127.0.0.1:1";
const LIVE = "nats://broker.cotal.ai:4222";
if (DEAD === LIVE || DEAD.includes("broker.cotal.ai")) {
  console.error("REFUSING: this smoke names the live broker");
  process.exit(2);
}
console.log(`\nstatus-delivery-row — driving the real status() against ${DEAD}\n`);
check("FIRST ACTION: the target broker is not the live host", !DEAD.includes("broker.cotal.ai"));

// ---- `.cotal` ANCHOR FIRST, then a NEGATIVE CONTROL that the anchor is what resolution follows.
const scratch = mkdtempSync(join(tmpdir(), "fmh-status-"));
const anchored = join(scratch, "anchored");
const bare = join(scratch, "bare");
mkdirSync(anchored, { recursive: true });
mkdirSync(bare, { recursive: true });
mkdirSync(join(anchored, ".cotal"), { recursive: true });
writeFileSync(join(anchored, ".cotal", "space"), "smoke\n");

const rootOfAnchored = findCotalRoot(anchored);
check("the .cotal anchor resolves to the anchored dir", rootOfAnchored === anchored, rootOfAnchored);
// NEGATIVE CONTROL: an UNANCHORED sibling must not resolve to my anchored root. Without this, a
// findCotalRoot that returned its argument unconditionally would satisfy the assertion above, and an
// unanchored tree walking up to a shared root is a live hazard on this box.
const rootOfBare = findCotalRoot(bare);
check("NEGATIVE CONTROL: an unanchored sibling does NOT resolve to the anchored root",
  rootOfBare !== anchored, rootOfBare);

// ---- SANDBOX THE REGISTRY TOO. `COTAL_HOME` redirects the mesh registry; the project root is
// separately sandboxed by the `.cotal` anchor above and the chdir below. The registry module's own
// note is explicit that setting only one of the two sandboxes the label and not the launch surface,
// so both are set. Without this the cell would register a mesh in the OPERATOR's real registry.
process.env.COTAL_HOME = join(scratch, "home");
mkdirSync(process.env.COTAL_HOME, { recursive: true });
recordMesh({ space: "smoke", server: DEAD, root: anchored, mode: "open" });

// ---- Drive the REAL command, capturing what it writes.
const lines: string[] = [];
const realLog = console.log;
const prevCwd = process.cwd();
process.chdir(anchored);
console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
let threw: Error | undefined;
try {
  await status({ values: { server: DEAD, space: "smoke" }, positionals: [] } as never);
} catch (e) {
  threw = e as Error;
} finally {
  console.log = realLog;
  process.chdir(prevCwd);
}

check("the real status() completed without throwing", threw === undefined, threw?.message);
check("it produced output at all — a silent command would satisfy every 'does not say X' below",
  lines.length > 0, lines.length);

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");
const plain = lines.map(strip);
const deliveryLines = plain.filter((l) => /^\s*delivery-health\b/.test(l));

check("STATUS PRINTS A DELIVERY ROW — the gap this cell exists to close", deliveryLines.length >= 1,
  plain.join(" | ").slice(0, 400));

// `>= 1` and then `[0]` is the shape that let this cell assert about the WRONG row: `cotal status`
// also renders a row labelled `delivery` from the local-process section (`status.ts:174` prints the
// registry key), emitted before this one, and `\b` treats `-` as a boundary so the old pattern
// matched both. The rename removed that trigger, but taking the first match is the MECHANISM and it
// outlives the trigger. Without this check the property is believed, not proven.
check("EXACTLY ONE row carries this label — otherwise `[0]` silently picks whichever row came first and every assertion below is about a row this cell never meant to test",
  deliveryLines.length === 1, `${deliveryLines.length} row(s): ${deliveryLines.join(" | ").slice(0, 300)}`);

const dl = deliveryLines[0] ?? "";
const value = dl.replace(/^\s*delivery-health\s*/, "").trim();
// THE THIRD STATE IS THE POINT. #445's defect is a health clause rendered as the empty string, which
// a reader cannot tell from "delivery health does not apply here".
check("the delivery row's VALUE is non-empty — never the empty-string rendering of #445",
  value.length > 0, JSON.stringify(value));
check("it says health could not be established, by name", /cannot establish health/i.test(value), value);
check("it names the PREFLIGHT as what failed", /preflight failed/i.test(value), value);
// REGRESSION GUARD, with its severity stated accurately rather than dramatically.
// `up-tls-routes-live` asserts its SECURITY verdict with `/connection\s+.*unreachable/` over this
// command's entire output, at TWO sites in that file — grep the pattern, not a line number. The
// first draft of this row read "the mesh connection failed above (unreachable)" and matches that
// regex by itself.
//
// IT WAS NOT, HOWEVER, EXPLOITABLE ON THIS PATH, and the first write-up said otherwise. The row only
// matched when `preflight.kind` was "unreachable", which is precisely when the `connection` row
// legitimately renders the same match. Measured across every PreflightFailure kind: the set where
// the old row matched and the connection row did not is EMPTY. The guard stays because duplicate
// evidence for a security assertion is worth removing and because the coincidence that saved it is
// one interpolation edit away from ending — not because a gate was ever greened by it.
check("the delivery row does NOT satisfy the TLS suite's security regex on its own",
  !/connection\s+.*unreachable/.test(value), value);
check("POSITIVE CONTROL: that regex DOES match the phrasing this row used to have",
  /connection\s+.*unreachable/.test("connection failed above (unreachable)"));
check("it disclaims any statement about the daemon — absence of evidence is not a verdict",
  /says nothing about delivery/i.test(value), value);
// INVERSE CONTROL on the message's content: a connection failure must NOT be described as a
// credential problem. That exact collapse was a reproduced defect in this lane.
// GUARDED ON A NON-EMPTY VALUE ON PURPOSE. An earlier run of this cell had the row missing entirely,
// and this assertion PASSED — `!/credential/` is trivially true of the empty string. A "does not say
// X" cell is satisfied by a surface that says nothing at all, which is the same vacuity this suite
// polices elsewhere, committed here by me.
// NOW DRIVEN THROUGH `mustNotSay`, WHICH REFUSES ON AN ABSENT SUBJECT BY CONSTRUCTION. The hand
// guard `value.length > 0 && …` that used to sit here was correct, and correct-by-remembering is the
// thing this lane has established does not hold across authors. The helper cannot be satisfied by an
// empty subject at all.
const noCred = mustNotSay(value, /credential/i);
check("INVERSE CONTROL: it does NOT blame a credential for a connection failure",
  noCred.ok, noCred.ok ? "" : noCred.detail);
// CONTROLS ON THE MATCHER ITSELF, run against crafted strings rather than against the row, so they
// prove the regex discriminates whether or not the row is present.
check("POSITIVE CONTROL: the matcher matches a message of the expected shape",
  /cannot establish health/i.test("cannot establish health — the mesh connection failed above (unreachable)"));
check("NEGATIVE CONTROL: the matcher rejects a healthy-sounding message",
  !/cannot establish health/i.test("durable backstop active"));
check("no row claims a healthy daemon on an unreachable broker",
  !plain.some((l) => /delivery/.test(l) && /durable backstop active/i.test(l)));

// ---- THE ITEM-0 INVARIANT, exercised on constructed output.
// The live cell that feeds this real `cotal status` output on the preflight-OK path needs a broker
// and is owed. What can be settled WITHOUT one is whether the checker itself discriminates, and that
// is worth settling first: a live cell built on an unexercised checker would report the checker's
// bugs as findings about the code under test.
const CONN_RX = /connection\s+.*unreachable/;
const conforming = ["  connection      [31munreachable[0m", "  delivery        cannot establish health — the mesh preflight failed above (unreachable)"];
const violating = ["  connection      [32mok[0m", "  delivery        the mesh connection to the broker is unreachable"];

const vc = evidenceComesOnlyFrom(conforming, CONN_RX, "connection");
check("INVARIANT: output whose only match is the connection row is CONFORMING", vc.ok && vc.kind === "conforming", vc.kind);
const vv = evidenceComesOnlyFrom(violating, CONN_RX, "connection");
check("INVARIANT: a non-connection row supplying the match is a VIOLATION",
  !vv.ok && vv.kind === "violated", vv.kind);
check("…and it names the offending line rather than only failing",
  vv.kind === "violated" && vv.offenders.length === 1 && /delivery/.test(vv.offenders[0] ?? ""), vv.kind);
// THE VACUITY CELL. This is the one that matters most: "every matching line is the connection row"
// is trivially true when nothing matches, and that is the same empty-set trap this lane has now hit
// twice. An output with no match must REFUSE, never pass.
const vn = evidenceComesOnlyFrom(["  connection      [32mok[0m"], CONN_RX, "connection");
check("INVARIANT: no matching line at all is a REFUSAL, not a vacuous pass",
  !vn.ok && vn.kind === "no-match", vn.kind);
check("…and the refusal says why an empty match set is not a pass",
  vn.kind === "no-match" && /vacuous/.test(vn.detail), vn.kind);
// The negative-polarity twin has the OPPOSITE vacuity behaviour, which is why it is a separate
// function: here an empty match set IS the property, not an absence of evidence for it.
check("NEGATIVE TWIN: an output with no `connection ok` line passes",
  nothingMatches(conforming, /connection\s+ok/).ok);
check("NEGATIVE TWIN: an output containing one does not",
  !nothingMatches(violating, /connection\s+ok/).ok);
check("rowLabel returns undefined for non-rows, so headers cannot be mistaken for a labelled row",
  rowLabel("Selected Mesh") === undefined && rowLabel("  connection   x") === "connection");

// ---- `mustNotSay`: the instrument for the one defect in this lane that was caught BY LUCK.
// The cell below reconstructs that defect exactly. Written as `!/credential/i.test("")` it passes;
// through the helper it refuses.
check("ABSENCE: an EMPTY subject REFUSES — this is the defect that shipped into this lane's cells",
  mustNotSay("", /credential/i).kind === "no-subject");
check("ABSENCE: a whitespace-only subject refuses too — trimming, not truthiness",
  mustNotSay("   ", /credential/i).kind === "no-subject");
check("…and the refusal explains why an empty subject is not a pass",
  (() => { const v = mustNotSay("", /credential/i); return v.kind === "no-subject" && /says nothing at all/.test(v.detail); })());
check("ABSENCE: a subject that DOES say it is a failure naming the term",
  (() => { const v = mustNotSay("no caller credential could be built", /credential/i); return v.kind === "present" && /credential/.test(v.detail); })());
check("ABSENCE: a real subject that does not say it PASSES", mustNotSay("the mesh preflight failed above (unreachable)", /credential/i).ok);
// POSITIVE CONTROL on the raw form, showing WHAT the helper is protecting against rather than
// asserting it abstractly: the naive expression is satisfied by the empty string.
check("POSITIVE CONTROL: the naive `!pattern.test(\"\")` really does pass — the helper is not solving a hypothetical",
  !/credential/i.test(""));

rmSync(scratch, { recursive: true, force: true });

console.log(
  fail === 0
    ? `\nSTATUS-DELIVERY-ROW SMOKE OK ✅  (${pass} passed, ${fail} failed)\n`
    : `\nSTATUS-DELIVERY-ROW SMOKE FAILED ❌  (${pass} passed, ${fail} failed)\n`,
);
if (fail > 0) process.exitCode = 1;
if (pass === 0) { console.log("REFUSING: no cell ran"); process.exitCode = 2; }

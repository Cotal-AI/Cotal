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
 * broker that answers preflight, which is the owed live cell in `.lane/broker-work-owed.md`. This
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
const deliveryLines = plain.filter((l) => /^\s*delivery\b/.test(l));

check("STATUS PRINTS A DELIVERY ROW — the gap this cell exists to close", deliveryLines.length >= 1,
  plain.join(" | ").slice(0, 400));

const dl = deliveryLines[0] ?? "";
const value = dl.replace(/^\s*delivery\s*/, "").trim();
// THE THIRD STATE IS THE POINT. #445's defect is a health clause rendered as the empty string, which
// a reader cannot tell from "delivery health does not apply here".
check("the delivery row's VALUE is non-empty — never the empty-string rendering of #445",
  value.length > 0, JSON.stringify(value));
check("it says health could not be established, by name", /cannot establish health/i.test(value), value);
check("it names the CONNECTION as what failed", /connection failed/i.test(value), value);
check("it disclaims any statement about the daemon — absence of evidence is not a verdict",
  /says nothing about delivery/i.test(value), value);
// INVERSE CONTROL on the message's content: a connection failure must NOT be described as a
// credential problem. That exact collapse was a reproduced defect in this lane.
// GUARDED ON A NON-EMPTY VALUE ON PURPOSE. An earlier run of this cell had the row missing entirely,
// and this assertion PASSED — `!/credential/` is trivially true of the empty string. A "does not say
// X" cell is satisfied by a surface that says nothing at all, which is the same vacuity this suite
// polices elsewhere, committed here by me.
check("INVERSE CONTROL: it does NOT blame a credential for a connection failure",
  value.length > 0 && !/credential/i.test(value), value);
// CONTROLS ON THE MATCHER ITSELF, run against crafted strings rather than against the row, so they
// prove the regex discriminates whether or not the row is present.
check("POSITIVE CONTROL: the matcher matches a message of the expected shape",
  /cannot establish health/i.test("cannot establish health — the mesh connection failed above (unreachable)"));
check("NEGATIVE CONTROL: the matcher rejects a healthy-sounding message",
  !/cannot establish health/i.test("durable backstop active"));
check("no row claims a healthy daemon on an unreachable broker",
  !plain.some((l) => /delivery/.test(l) && /durable backstop active/i.test(l)));

rmSync(scratch, { recursive: true, force: true });

console.log(
  fail === 0
    ? `\nSTATUS-DELIVERY-ROW SMOKE OK ✅  (${pass} passed, ${fail} failed)\n`
    : `\nSTATUS-DELIVERY-ROW SMOKE FAILED ❌  (${pass} passed, ${fail} failed)\n`,
);
if (fail > 0) process.exitCode = 1;
if (pass === 0) { console.log("REFUSING: no cell ran"); process.exitCode = 2; }

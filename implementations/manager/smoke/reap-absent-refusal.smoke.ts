/**
 * #1554: an `absent` reap outcome must REFUSE, never render as a disposal.
 *
 * `absent` says the custody record could not be read. That is a fact about ADDRESSABILITY, and two
 * of the three ways to reach it leave a LIVE seat: a custodian that dies after `pty.spawn` and
 * before `writeRecord` has a running child and no record, and a stale or wrong reference looks for a
 * record that exists at another path. Both of the manager's rendering sites used to turn that into
 * "already forgotten" and carry on, so an alias could be freed over a seat nobody proved gone.
 *
 * The refusal lives in `requireRuntimeReap` rather than at the callsites, which is what makes the
 * census exhaustive: `absent` never reaches a caller, so no caller can describe it as success.
 *
 * Deliberately broker-free and process-free. The property is about what one function returns versus
 * throws, and the heavy orphan-seat smokes cannot drive a missing record reliably.
 *
 * Run: pnpm smoke:reap-absent-refusal
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireRuntimeReap } from "../src/runtime/index.js";

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const reference = { kind: "pty", id: "seat-1554-abcdef" };
// Custodial by duck type (`reserve` + `reap` both functions), which is how isCustodialRuntime
// decides. Nothing else on Runtime is touched by the path under test.
const runtimeWith = (reap: () => Promise<unknown>) =>
  ({ kind: "pty", reserve: () => reference, reap }) as never;

// (a) the refusal itself
let threw: unknown;
let returned: unknown;
try {
  returned = await requireRuntimeReap(runtimeWith(async () => ({ outcome: "absent" })), reference as never);
} catch (e) { threw = e; }
check(
  "#1554: an ABSENT reap outcome REFUSES instead of returning an outcome a caller can render",
  threw !== undefined && returned === undefined,
  { threw: threw === undefined ? null : String(threw), returned },
);
check(
  "#1554: the refusal names the reference, so the operator knows what to go looking for",
  threw !== undefined && String((threw as Error).message).includes(reference.id),
  threw === undefined ? null : String((threw as Error).message),
);
check(
  "#1554: the refusal says the seat is NOT proved gone rather than describing a disposal",
  threw !== undefined && /not proved gone|NOT proved gone/.test(String((threw as Error).message)),
  threw === undefined ? null : String((threw as Error).message),
);

// (b) positive control: a real reap is unaffected
let reaped: unknown; let reapedThrew: unknown;
try {
  reaped = await requireRuntimeReap(
    runtimeWith(async () => ({ outcome: "reaped", detail: "custodian signalled, child gone" })),
    reference as never,
  );
} catch (e) { reapedThrew = e; }
check(
  "CONTROL: a REAPED outcome still returns and carries its detail",
  reapedThrew === undefined && (reaped as { detail?: string } | undefined)?.detail === "custodian signalled, child gone",
  { reapedThrew: reapedThrew === undefined ? null : String(reapedThrew), reaped },
);

// (c) negative control: the pre-existing non-custodial refusal is untouched
let nonCustodialThrew: unknown;
try {
  await requireRuntimeReap({ kind: "tmux" } as never, reference as never);
} catch (e) { nonCustodialThrew = e; }
check(
  "CONTROL: a non-custodial runtime still refuses by name (the older contract is unchanged)",
  nonCustodialThrew !== undefined && String((nonCustodialThrew as Error).message).includes("does not support reap"),
  nonCustodialThrew === undefined ? null : String((nonCustodialThrew as Error).message),
);

// (d) the census the issue asked for, stated before measuring: after the fix NO site renders an
// absent outcome, because absent cannot reach one. A sample would not have caught the second site.
const here = dirname(fileURLToPath(import.meta.url));
const managerSrc = readFileSync(resolve(here, "..", "src", "manager.ts"), "utf8");
const renderings = managerSrc.split('outcome === "absent"').length - 1;
const callsites = managerSrc.split("requireRuntimeReap(").length - 1;
check(
  "#1554: NO site in manager.ts renders an absent outcome as prose (expected 0)",
  renderings === 0,
  { renderings },
);
check(
  "CONTROL: the census can still see the reap callsites it is scoped to (expected 2)",
  callsites === 2,
  { callsites },
);

console.log(`\nREAP-ABSENT-REFUSAL ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

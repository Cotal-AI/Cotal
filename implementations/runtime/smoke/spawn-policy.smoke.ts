/**
 * `spawn`'s `supervise` policy: parse it as `{ restarts, window? }`, default the window to 10m,
 * refuse an unknown key or a malformed value before anything is submitted, and put `restarts` plus
 * `windowMs` on the manager spawn args.
 *
 * Run: pnpm smoke:runtime-spawn-policy
 */
import { readSupervise, spawnArgs } from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown): void => {
  if (v) ok++;
  else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};
const throws = (fn: () => unknown, re: RegExp, n: string): void => {
  try {
    fn();
    c(n, false, "did not throw");
  } catch (e) {
    c(n, re.test(String((e as Error).message)), (e as Error).message);
  }
};

throws(
  () => readSupervise("always", "builder"),
  /supervise must be a record of \{ restarts, window\? \}/,
  "a non-record supervise is refused",
);
throws(
  () => readSupervise({ restart: "always" }, "builder"),
  /supervise\.restart is not a restart policy this host enforces/,
  "an unknown supervise key is refused, never accepted and ignored",
);
throws(
  () => readSupervise({ restarts: 0 }, "builder"),
  /supervise\.restarts must be a positive integer/,
  "restarts of zero is refused",
);
throws(
  () => readSupervise({ restarts: 1.5 }, "builder"),
  /supervise\.restarts must be a positive integer/,
  "a non-integer restarts is refused",
);
throws(
  () => readSupervise({ restarts: 2, window: 10 }, "builder"),
  /supervise\.window must be a duration string/,
  "a numeric window is refused",
);
throws(
  () => readSupervise({}, "builder"),
  /supervise\.restarts must be a positive integer/,
  "a missing restarts is refused",
);

let def: { restarts: number; windowMs: number } | undefined;
try { def = readSupervise({ restarts: 3 }, "builder"); } catch (e) { console.log("  ✗ FAIL: default window threw", (e as Error).message); fail++; }
c("an omitted window defaults to 10m", def?.restarts === 3 && def?.windowMs === 600_000, def);

let custom: { restarts: number; windowMs: number } | undefined;
try { custom = readSupervise({ restarts: 2, window: "30s" }, "builder"); } catch (e) { console.log("  ✗ FAIL: custom window threw", (e as Error).message); fail++; }
c("window parses as a duration", custom?.restarts === 2 && custom?.windowMs === 30_000, custom);

const travelled = spawnArgs({ persona: "builder", supervise: { restarts: 2, window: "5m" } } as never);
c("spawnArgs names the persona as name", travelled.name === "builder");
c(
  "spawnArgs carries restarts and windowMs",
  JSON.stringify(travelled.supervise) === JSON.stringify({ restarts: 2, windowMs: 300_000 }),
  travelled.supervise,
);

const bare = spawnArgs({ persona: "builder" } as never);
c("absent supervise does not travel", !("supervise" in bare), bare);

const EXPECTED = 11;
const ran = ok + fail;
console.log(`spawn-policy.smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);

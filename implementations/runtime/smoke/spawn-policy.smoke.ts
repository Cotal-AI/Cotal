/**
 * `spawn`'s `supervise` policy: parse it as `{ restarts, window? }`, default the window to 10m,
 * refuse an unknown key or a malformed value before anything is submitted, and put `restarts` plus
 * `windowMs` on the manager spawn args.
 *
 * Run: pnpm smoke:runtime-spawn-policy
 */
import assert from "node:assert/strict";
import { readSupervise, spawnArgs } from "../src/index.js";

let checks = 0;
const check = (condition: unknown, message: string, detail?: unknown): void => {
  assert.ok(condition, `${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  checks++;
};

const throws = (fn: () => unknown, re: RegExp, message: string): void => {
  assert.throws(fn, re, message);
  checks++;
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

const def = readSupervise({ restarts: 3 }, "builder");
check(def.restarts === 3 && def.windowMs === 600_000, "an omitted window defaults to 10m", def);

const custom = readSupervise({ restarts: 2, window: "30s" }, "builder");
check(custom.restarts === 2 && custom.windowMs === 30_000, "window parses as a duration", custom);

const travelled = spawnArgs({ persona: "builder", supervise: { restarts: 2, window: "5m" } } as never);
check(travelled.name === "builder", "spawnArgs names the persona as name");
check(
  JSON.stringify(travelled.supervise) === JSON.stringify({ restarts: 2, windowMs: 300_000 }),
  "spawnArgs carries restarts and windowMs",
  travelled.supervise,
);

const bare = spawnArgs({ persona: "builder" } as never);
check(!("supervise" in bare), "absent supervise does not travel", bare);

console.log(`spawn-policy.smoke: ${checks} checks passed`);

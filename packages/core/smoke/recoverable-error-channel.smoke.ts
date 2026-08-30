/**
 * Recoverable endpoint conditions must not kill a host that omitted an `error` listener (#891).
 *
 * Node rethrows EventEmitter `error` when nothing is attached. CotalEndpoint used that channel
 * for retry notices whose own text says the connection is still running. The live reproduction
 * (issue comment 5467244165 at main b6c1428b) called the shipped `refreshBearer(false)` path
 * with a transient bearer-source failure, `errorListeners=0`, and the process exited 1.
 *
 * THE DISCRIMINATING CELL is a consumer with NO error listener surviving that retry. A test that
 * attaches a listener passes against the bug by construction. A default no-op `error` listener
 * would also go green, and that is the no-fallbacks collision: silent degradation. The control
 * below requires a listenerless `error` emit to still throw.
 *
 * No broker: construction plus the private refresh retry, imported from `../src/` so a mutation
 * on source is visible without a dist rebuild.
 *
 * Run: pnpm smoke:recoverable-error-channel
 * Prove: pnpm mutation-proof --config packages/core/smoke/fixtures/recoverable-error-channel.mutations.json
 */
import { CotalEndpoint } from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  x FAIL: ${n}`, extra ?? ""); }
};

type Refresh = { refreshBearer: (initial?: boolean) => Promise<void> };

const ep = new CotalEndpoint({
  space: "s891",
  card: { name: "probe", kind: "agent", owner: "local", actor: "probe" },
  bearer: async () => { throw new Error("auth blip"); },
  sentinelCreds: "creds",
  registerPresence: false,
  watchPresence: false,
  consume: false,
});

c("the probe attaches no error listener", ep.listenerCount("error") === 0, ep.listenerCount("error"));

const warnings: Error[] = [];
ep.on("warning", (err: Error) => { warnings.push(err); });

let threw: unknown;
try {
  await (ep as unknown as Refresh).refreshBearer(false);
} catch (e) {
  threw = e;
}

c("a consumer with NO error listener survives a recoverable bearer retry", threw === undefined, threw);

const notice = warnings[0]?.message ?? "";
c("the retry is observable on warning", notice.includes("bearer refresh failed") && notice.includes("retrying"), notice);

const fatal = new CotalEndpoint({
  space: "s891",
  card: { name: "fatal", kind: "agent" },
  registerPresence: false,
  watchPresence: false,
  consume: false,
});
c("the fatal probe also has no error listener (no default listener was installed)", fatal.listenerCount("error") === 0);
let errorThrew = false;
try {
  fatal.emit("error", new Error("terminal"));
} catch {
  errorThrew = true;
}
c("a genuine error with no listener still throws", errorThrew);

console.log(`\nRECOVERABLE-ERROR-CHANNEL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;

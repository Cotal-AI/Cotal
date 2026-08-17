/**
 * Child for `lease-renew-no-answer.smoke.ts`. A REAL manager on a REAL endpoint against the real
 * broker, so the observation is the process actually ending rather than a stubbed `process.exit`.
 * Nothing here injects a clock, patches the renew, or stubs the endpoint: the parent stalls the
 * network under it and this process reports what it was holding when it decided to die.
 *
 * Output is written with `writeSync(1, …)`, not `console.log`. The last line is emitted from an
 * `exit` listener, and `process.exit` does not drain an async pipe write — a buffered `console.log`
 * there is silently lost, which would read as "the manager never reported" rather than as the
 * plumbing bug it is.
 */
import { writeSync } from "node:fs";
import { Manager } from "../src/manager.js";

const [space, servers, workspaceRoot] = process.argv.slice(2);
const say = (line: string) => writeSync(1, `${line}\n`);

const mgr = new Manager({ space, servers, runtime: "pty", workspaceRoot, consolePort: 0 });
const held = mgr as unknown as { managerInstanceId: string; leaseRevision?: number };

// The revision the manager was holding at the instant it gave up. On the lease-loss path the failing
// renew throws, so this is the last renew that SUCCEEDED — which is what the parent needs to compare
// against what the broker actually stored.
process.on("exit", () => say(`HELD ${held.leaseRevision ?? "none"}`));

await mgr.start();
say(`UP ${held.managerInstanceId} ${process.pid}`);

// Report every revision change, so the parent can synchronise its stall with the manager's own renew
// clock instead of guessing at an offset from `start()` returning (which lands well after the lease
// timer was armed, and by a margin that varies with the rest of startup).
let last = held.leaseRevision;
setInterval(() => {
  if (held.leaseRevision !== last) { last = held.leaseRevision; say(`REV ${last} ${Date.now()}`); }
}, 50);

// Idle forever. The only thing that ends this process is the manager's own decision to fail closed.
await new Promise(() => {});

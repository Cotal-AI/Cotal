/**
 * The shipped Manager status contract must tell a browser whether each connector publishes the event
 * plane. This is the contract-level repro for #5227: revision 40 closes connector rows over agent,
 * state, binaries and reason, so neither a live registry row nor a declared inventory row can carry
 * the fact a launch dialog needs before spawn.
 *
 * Run: pnpm exec tsx implementations/manager/smoke/status-connector-event-plane.smoke.ts
 */
import { managerShippedSurface, MANAGER_STATUS_CONTRACT } from "../src/manager-service-contract.js";

let passed = 0;
let failed = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
  }
}

const shipped = managerShippedSurface();
const base = {
  instanceId: "a".repeat(26),
  execution: "runtime",
  runtime: "pty",
  custody: "legacy",
  runHosting: false,
  terminalSessions: true,
  agentCount: 0,
  uptimeMs: 1,
  classSpawn: true,
  staticReconciliation: { state: "idle", failures: [] },
};

const status = (eventPlane: boolean) => ({
  ...base,
  connectors: [{ agent: "probe", state: "available", binaries: {}, eventPlane }],
});

check("the Manager contract retains connector event-plane facts after the inline spawn persona advances it", shipped.revision === 44, shipped);
check("status accepts eventPlane true on a connector row", MANAGER_STATUS_CONTRACT.output.validate(status(true)) === true);
check("status accepts eventPlane false on a connector row", MANAGER_STATUS_CONTRACT.output.validate(status(false)) === true);
check("status requires an explicit eventPlane fact and never defaults it to true",
  MANAGER_STATUS_CONTRACT.output.validate({ ...base, connectors: [{ agent: "probe", state: "available", binaries: {} }] }) === false);
check("status keeps connector eventPlane typed as a boolean",
  MANAGER_STATUS_CONTRACT.output.validate({ ...base, connectors: [{ agent: "probe", state: "available", binaries: {}, eventPlane: "yes" }] }) === false);

console.log(`\n${passed} passed, ${failed} failed`);
const EXPECTED = 5;
if (passed + failed !== EXPECTED) {
  console.log(`FAIL expected ${EXPECTED} cells, ran ${passed + failed}`);
  failed++;
}
if (failed) process.exitCode = 1;

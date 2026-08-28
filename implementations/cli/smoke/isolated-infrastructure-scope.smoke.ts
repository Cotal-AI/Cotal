/** Exact authority for the restore-only infrastructure phase (no broker, no test runner). */
import { infrastructureMaintenancePermissions } from "../src/lib/isolated-broker.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const permissions = infrastructureMaintenancePermissions("SCOPE_TEST", ["EPJ_space", "KV_records_space", "EPJ_space"], ["KV_records_space", "KV_records_space"]);
const allow = ((permissions as { pub?: { allow?: string[] } }).pub?.allow ?? []);
const count = (subject: string) => allow.filter((entry) => entry === subject).length;

check("every named stream gets exactly one CREATE grant", count("$JS.API.STREAM.CREATE.EPJ_space") === 1 && count("$JS.API.STREAM.CREATE.KV_records_space") === 1, allow);
check("every named stream gets exactly one INFO grant", count("$JS.API.STREAM.INFO.EPJ_space") === 1 && count("$JS.API.STREAM.INFO.KV_records_space") === 1, allow);
check("the named update stream gets exactly one UPDATE grant", count("$JS.API.STREAM.UPDATE.KV_records_space") === 1, allow);
check("a non-update stream gets no UPDATE grant", count("$JS.API.STREAM.UPDATE.EPJ_space") === 0, allow);
check("the infrastructure principal gets no wildcard JetStream authority", !allow.some((entry) => entry.includes(">") || entry.includes("*")), allow);

let outside = "";
try {
  infrastructureMaintenancePermissions("SCOPE_TEST", ["EPJ_space"], ["KV_records_space"]);
} catch (error) {
  outside = (error as Error).message;
}
check("an update stream outside create/info scope is rejected", outside.includes("outside its create/info scope"), outside);

let invalid = "";
try {
  infrastructureMaintenancePermissions("SCOPE_TEST", ["EPJ.space"]);
} catch (error) {
  invalid = (error as Error).message;
}
check("an invalid maintenance stream name is rejected", invalid.includes("invalid maintenance stream name"), invalid);

console.log(`\nisolated infrastructure scope: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;

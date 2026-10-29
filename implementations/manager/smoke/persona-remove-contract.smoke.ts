/**
 * The shipped Manager browser contract must expose persona removal to a spawn-capable browser
 * client. This is a contract-level repro for #5230: revision 40 can define, list and show a
 * machine-local persona, but its generated browser source has no command that can remove one.
 *
 * Run: pnpm exec tsx implementations/manager/smoke/persona-remove-contract.smoke.ts
 */
import { managerBrowserContractSource, managerShippedSurface, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";

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
const source = managerBrowserContractSource();
const command = source.document.commands.find((row) => row.name === "remove-persona");
const contract = MANAGER_CONTRACTS["remove-persona"];

check("the Manager contract revision advances for persona removal", shipped.revision === 41, shipped);
check("the shipped browser contract declares remove-persona", command !== undefined, source.document.commands.map((row) => row.name));
check("remove-persona has its own generated input and output contracts",
  typeof command?.inputDigest === "string" && typeof command.outputDigest === "string",
  command);
check("remove-persona accepts a 69-character invalid spawn name so the catalog can be repaired",
  contract?.input.validate({ name: "x".repeat(69) }) === true);
check("remove-persona requires only a name and returns the removed name",
  contract?.input.validate({ name: "machine-template" }) === true
  && contract?.input.validate({}) === false
  && contract?.output.validate({ name: "machine-template" }) === true
  && contract?.output.validate({ name: "machine-template", path: "/secret/path" }) === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

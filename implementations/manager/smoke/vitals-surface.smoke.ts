import { MANAGER_READ_COMMANDS } from "../../../packages/core/src/endpoint-grants.js";
import {
  MANAGER_CONTRACTS,
  managerClusterDocument,
  managerShippedSurface,
} from "../src/manager-service-contract.js";

let passed = 0;
let failed = 0;
const cell = (name: string, ok: boolean, seen?: unknown) => {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
    return;
  }
  failed++;
  console.log(`FAIL ${name}${seen === undefined ? "" : ` - ${JSON.stringify(seen)}`}`);
};

const document = managerClusterDocument();
const surface = managerShippedSurface();
const vitalsCommands = document.commands.filter((command) => command.name === "vitals");
const vitalsCapabilities = document.commands.filter((command) => command.capability === "manager.vitals");
const compiledVitals = Object.keys(MANAGER_CONTRACTS).filter((name) => name === "vitals");
const managerReadVitals = MANAGER_READ_COMMANDS.filter((name) => String(name) === "vitals");

console.log(JSON.stringify({
  commandCount: surface.commandCount,
  compiledContractCount: Object.keys(MANAGER_CONTRACTS).length,
  capabilityLabelCount: new Set(document.commands.map((command) => command.capability)).size,
  vitalsCommandCount: vitalsCommands.length,
  vitalsCapabilityCount: vitalsCapabilities.length,
  compiledVitalsCount: compiledVitals.length,
  managerReadVitalsCount: managerReadVitals.length,
}));

cell("the shipped Manager surface declares one dedicated vitals command",
  vitalsCommands.length === 1 && vitalsCommands[0]?.targeted === false,
  vitalsCommands);
cell("the dedicated command uses the separate manager.vitals capability",
  vitalsCapabilities.length === 1 && vitalsCapabilities[0]?.name === "vitals",
  vitalsCapabilities);
cell("the generic caller contract table compiles the vitals command",
  compiledVitals.length === 1,
  compiledVitals);
cell("vitals does not change the existing manager.read command family",
  managerReadVitals.length === 0,
  managerReadVitals);

console.log(`manager vitals surface smoke: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed) process.exitCode = 1;

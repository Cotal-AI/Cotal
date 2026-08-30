import { type Connector } from "@cotal-ai/core";
import { setupConnectorCandidates } from "../src/commands/setup.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`  ok ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL: ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const launch = () => ({ command: "true", args: [] });
const connectors: Connector[] = [
  { kind: "connector", name: "claude", requires: ["claude"], pluginRoot: "/claude-plugin", buildLaunch: launch },
  { kind: "connector", name: "opencode", requires: ["opencode"], buildLaunch: launch },
  { kind: "connector", name: "never-heard-of", buildLaunch: launch },
  { kind: "connector", name: "not-claude-plugin", pluginRoot: "/other-plugin", buildLaunch: launch },
];
const EXPECTED_CONNECTORS = 4;

const candidates = setupConnectorCandidates(connectors, (bin) => bin !== "opencode");
check("every registered connector appears in setup candidates", candidates.length === EXPECTED_CONNECTORS, `${candidates.length} of ${EXPECTED_CONNECTORS}`);
check("an unknown capability-empty connector appears and is selectable", candidates.find((candidate) => candidate.value === "never-heard-of")?.hint === "ready at spawn");
check("a non-claude connector with pluginRoot gets the plugin hint", candidates.find((candidate) => candidate.value === "not-claude-plugin")?.hint === "installs a plugin");
check("missing requirements derive the PATH hint", candidates.find((candidate) => candidate.value === "opencode")?.hint === "opencode not on PATH");

const claudeWithoutPlugin = setupConnectorCandidates(
  [{ kind: "connector", name: "claude", requires: ["claude"], buildLaunch: launch }],
  () => true,
);
check("claude without pluginRoot does not get the plugin hint", claudeWithoutPlugin[0]?.hint === "ready at spawn");

const EXPECTED_CELLS = 5;
check("every generic connector cell ran", pass + fail === EXPECTED_CELLS, `${pass + fail} of ${EXPECTED_CELLS}`);
console.log(`SETUP CONNECTOR GENERICITY: ${candidates.length} of ${EXPECTED_CONNECTORS} registered connectors examined`);
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

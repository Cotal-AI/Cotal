import assert from "node:assert/strict";
import { type Connector } from "@cotal-ai/core";
import { setupConnectorCandidates } from "../src/commands/setup.js";

const launch = () => ({ command: "true", args: [] });
const connectors: Connector[] = [
  { kind: "connector", name: "claude", requires: ["claude"], pluginRoot: "/claude-plugin", buildLaunch: launch },
  { kind: "connector", name: "opencode", requires: ["opencode"], buildLaunch: launch },
  { kind: "connector", name: "never-heard-of", buildLaunch: launch },
  { kind: "connector", name: "not-claude-plugin", pluginRoot: "/other-plugin", buildLaunch: launch },
];
const EXPECTED_CONNECTORS = 4;

const candidates = setupConnectorCandidates(connectors, (bin) => bin !== "opencode");
assert.equal(candidates.length, EXPECTED_CONNECTORS, "every registered connector appears in setup candidates");
assert.equal(candidates.find((candidate) => candidate.value === "never-heard-of")?.hint, "ready at spawn", "an unknown capability-empty connector appears and is selectable");
assert.equal(candidates.find((candidate) => candidate.value === "not-claude-plugin")?.hint, "installs a plugin", "a non-claude connector with pluginRoot gets the plugin hint");
assert.equal(candidates.find((candidate) => candidate.value === "opencode")?.hint, "opencode not on PATH", "missing requirements derive the PATH hint");

const claudeWithoutPlugin = setupConnectorCandidates(
  [{ kind: "connector", name: "claude", requires: ["claude"], buildLaunch: launch }],
  () => true,
);
assert.equal(claudeWithoutPlugin[0]?.hint, "ready at spawn", "claude without pluginRoot does not get the plugin hint");

console.log(`SETUP CONNECTOR GENERICITY: ${candidates.length} of ${EXPECTED_CONNECTORS} registered connectors examined`);
console.log("setup-connectors.smoke: all assertions passed");

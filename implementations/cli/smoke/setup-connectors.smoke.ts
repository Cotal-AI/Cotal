/**
 * Genericity grade for guided setup's connector surface (#1036). Membership comes from the live
 * registry plus the installed manifest, and every hint comes from the connector's own declarations
 * (`requires`, `setup`, `pluginRoot`) — never from a name the CLI privileges. The fixtures include
 * connectors this CLI has never heard of, so a name-keyed implementation cannot pass.
 *
 * Run: pnpm smoke:setup-connectors
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, Registry, type Connector } from "@cotal-ai/core";
import { setupConnectorCandidates, setupConnectorSurface } from "../src/commands/setup.js";

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
const providerRef = (name: string) => ({ kind: "connector-setup" as const, name });
const connectors: Connector[] = [
  { kind: "connector", name: "claude", requires: ["claude"], setup: providerRef("claude"), pluginRoot: "/claude-plugin", buildLaunch: launch },
  { kind: "connector", name: "opencode", requires: ["opencode"], buildLaunch: launch },
  { kind: "connector", name: "never-heard-of", buildLaunch: launch },
  { kind: "connector", name: "not-claude-plugin", setup: providerRef("not-claude-plugin"), pluginRoot: "/other-plugin", buildLaunch: launch },
];
const EXPECTED_CONNECTORS = 4;
const testRegistry = new Registry();
testRegistry.register(...connectors);
check(
  "the fixture registered the pinned connector count",
  testRegistry.all<Connector>("connector").length === EXPECTED_CONNECTORS,
  `${testRegistry.all<Connector>("connector").length} of ${EXPECTED_CONNECTORS}`,
);

const candidates = setupConnectorCandidates(testRegistry.all<Connector>("connector"), (bin) => bin !== "opencode");
check("every registered connector appears in setup candidates", candidates.length === EXPECTED_CONNECTORS, `${candidates.length} of ${EXPECTED_CONNECTORS}`);
check("an unknown capability-empty connector appears and is selectable", candidates.find((candidate) => candidate.value === "never-heard-of")?.hint === "ready at spawn");
check("a non-claude connector with pluginRoot gets the plugin hint", candidates.find((candidate) => candidate.value === "not-claude-plugin")?.hint === "installs a plugin");
check("missing requirements derive the PATH hint", candidates.find((candidate) => candidate.value === "opencode")?.hint === "opencode not on PATH");

const claudeWithoutPlugin = setupConnectorCandidates(
  [{ kind: "connector", name: "claude", requires: ["claude"], setup: providerRef("claude"), buildLaunch: launch }],
  () => true,
);
check("claude without pluginRoot does not get the plugin hint", claudeWithoutPlugin[0]?.hint === "runs its own setup");

const claudeWithoutProvider = setupConnectorCandidates(
  [{ kind: "connector", name: "claude", requires: ["claude"], buildLaunch: launch }],
  () => true,
);
check("claude declaring no setup provider is not privileged into a setup step", claudeWithoutProvider[0]?.hint === "ready at spawn");

// Membership itself, through the surface guided setup derives it from: a connector this CLI has
// never heard of joins purely because it is registered. No installed manifest here, so the live
// registry is the whole surface — a literal name list would drop the fixture entirely.
const xdg = mkdtempSync(join(tmpdir(), "cotal-setup-connectors-"));
process.env.XDG_CONFIG_HOME = xdg;
const UNFAMILIAR = "zz-unfamiliar-harness";
registry.register({ kind: "connector", name: UNFAMILIAR, buildLaunch: launch } as Connector);
let surfaced: string[];
try {
  surfaced = (await setupConnectorSurface()).map((connector) => connector.name);
} catch (error) {
  surfaced = [`<threw: ${(error as Error).message}>`];
} finally {
  rmSync(xdg, { recursive: true, force: true });
}
check("registry-registered connectors join the derived setup membership", surfaced.includes(UNFAMILIAR), surfaced.join(", ") || "(empty surface)");

const EXPECTED_CELLS = 8;
check("every generic connector cell ran", pass + fail === EXPECTED_CELLS, `${pass + fail} of ${EXPECTED_CELLS}`);
console.log(`SETUP CONNECTOR GENERICITY: ${candidates.length} of ${EXPECTED_CONNECTORS} registered connectors examined`);
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

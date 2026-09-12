import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAgentSkills } from "../src/lib/agent-skills.js";
import { setupProviderAvailable } from "../src/commands/setup.js";

const { assert, cells } = countedAssert(nodeAssert);

const home = mkdtempSync(join(tmpdir(), "cotal-setup-provider-absent-"));
const priorHome = process.env.HOME;
const priorPath = process.env.PATH;
try {
  process.env.HOME = home;
  process.env.PATH = join(home, "empty-bin");
  assert.equal(setupProviderAvailable({ requires: ["missing-harness"] }), false, "an unavailable harness provider is skipped");
  const result = installAgentSkills();
  assert.ok(result.installed.includes("team-topology"), "cross-vendor skills still reconcile when a harness provider is unavailable");
  assert.equal(existsSync(join(home, ".agents", "skills", "team-topology", "SKILL.md")), true, "the .agents skill was written without the harness");
  console.log("setup-provider-absent.smoke: all assertions passed");
  emitSentinel({ passed: cells(), failed: 0 });
} finally {
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
  rmSync(home, { recursive: true, force: true });
}

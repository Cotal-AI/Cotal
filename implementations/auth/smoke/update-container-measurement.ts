/** Dedicated real published update measurement composed through the shared matrix harness. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareUpdateParticipant } from "./update-participant.fixture.js";

assert.equal(process.env.GITHUB_ACTIONS, "true", "container measurement runs only on a disposable hosted runner");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.platform, "linux");
const mode = process.argv[2];
assert(mode === "container" || mode === "control", "choose container or control");
assert(process.env.UPDATE_MATRIX_HARNESS, "shared harness path required");
const { matrixCell } = await import(pathToFileURL(resolve(process.env.UPDATE_MATRIX_HARNESS)).href);
const output = resolve(process.env.UPDATE_MEASUREMENT_OUT!);
const report = await matrixCell({
  source: "0.164.5", layout: "npm", state: "configured", method: "self", output,
  "expected-target": "0.164.6", "container-manager": mode === "container" ? "true" : "false",
  prepare: async (context: Parameters<typeof prepareUpdateParticipant>[0] & {
    cotal: (label: string, argv: string[]) => Promise<unknown>;
  }) => {
    assert(context.env.TMPDIR, "shared harness supplies private TMPDIR");
    mkdirSync(context.env.TMPDIR, { recursive: true, mode: 0o700 });
    const close = await prepareUpdateParticipant(context);
    return async () => {
      try { context.report.versionAfter = await context.cotal("detailed version after update", ["version"]); }
      finally { await close(); }
    };
  },
});
assert.equal(report.participant?.remote, true, "real remote user participant was configured");
assert.equal(report.participant?.selected, true, "remote participant was selected");
assert.equal(report.participant?.localManagerStarted, false, "host fixture started no Manager");
const update = report.update;
assert(update, `update action was reached: ${report.refusal}`);
const text = update.stdout + update.stderr;
if (mode === "container") {
  assert.notEqual(update.exit, 0, "unchanged published update refuses foreign container custody");
  assert.match(text, /a manager for this mesh runs on this machine; reading its custody/, "custody line captured");
  assert.match(text, /refused|no manager candidate|manager-caller|continuity/i, "actual continuity refusal captured");
} else {
  assert.equal(update.exit, 0, `no-container published control succeeds: ${text}`);
  assert.equal(report.result, "passed", report.refusal);
  assert(!text.includes("a manager for this mesh runs on this machine"), "control does not attribute local custody");
}
console.log(JSON.stringify({ measurement: mode, observedExpectedOutcome: true, updateExit: update.exit, result: report.result, participant: report.participant }));

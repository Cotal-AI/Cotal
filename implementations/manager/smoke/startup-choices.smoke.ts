/** Runs the production runtime gates with a terminal child standing in for the harness UI.
 * This checks final confirmation/timeout custody; claude-workspace-trust covers real native trust. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AgentHandle, Runtime } from "@cotal-ai/core";
import { LegacyPtyRuntime } from "../src/runtime/pty.js";
import { CustodialPtyRuntime } from "../src/runtime/custodial-pty.js";
import { TmuxRuntime } from "../../../extensions/tmux/src/runtime.js";
import { CLAUDE_WORKSPACE_TRUST_REPLIES } from "../../../extensions/connector-claude-code/src/trust.js";

const root = mkdtempSync(join(tmpdir(), "cotal-startup-choices-"));
const session = `choices-${process.pid}`;
const fixture = fileURLToPath(new URL("./fixtures/startup-choices.cjs", import.meta.url));
const handles: AgentHandle[] = [];
let ownsTmux = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = (path: string): { key: string; phase: string }[] => {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((r) => JSON.parse(r)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
};
const failures: string[] = [];
try {
  const runtimes: [string, Runtime][] = [
    ["pty", new LegacyPtyRuntime()], ["custody", new CustodialPtyRuntime(join(root, "seats"))],
    ["tmux", new TmuxRuntime(session)],
  ];
  const cases = runtimes.flatMap(([runtimeName, runtime]) => ["normal", "trusted", "missing"].map((mode) => {
    if (runtimeName === "tmux" && !ownsTmux) {
      assert.throws(() => execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }));
      ownsTmux = true;
    }
    const name = `${runtimeName}-${mode}`;
    const path = join(root, `${name}.jsonl`);
    const handle = runtime.spawn(name, {
      command: process.execPath, args: [fixture, path, mode], env: { PATH: process.env.PATH! },
      confirm: "WARNING: Loading development channels", confirmBefore: CLAUDE_WORKSPACE_TRUST_REPLIES,
    }, root);
    handles.push(handle);
    return { name, path, handle, mode };
  }));
  // The final-confirmation deadline is 15 s and graceful-stop escalation is 3 s. Check after both,
  // so a timer left armed kills a supposedly ready seat and a missing final cannot pass as ready.
  await sleep(20_000);
  for (const test of cases) {
    try {
      const observed = rows(test.path);
      if (test.mode === "missing") {
        assert.equal(test.handle.status(), "exited", `${test.name}: absent final prompt fails bounded`);
        assert.deepEqual(observed, [{ key: "Down", phase: "trust" }, { key: "Enter", phase: "trust" }], `${test.name}: no tool-approval key after trust`);
      } else {
        assert.equal(test.handle.status(), "running", `${test.name}: final confirmation disarms the deadline`);
        assert.deepEqual(observed, test.mode === "trusted" ? [{ key: "Enter", phase: "final" }] : [
          { key: "Down", phase: "trust" }, { key: "Enter", phase: "trust" }, { key: "Enter", phase: "final" },
        ], `${test.name}: exact startup responses and none after done`);
      }
      console.log(`PASS ${test.name}`);
    } catch (error) { const message = (error as Error).message; failures.push(message); console.error(`FAIL ${message}`); }
  }
  console.log("STARTUP CHOICES COMPLETE");
  assert.equal(failures.length, 0, failures.join("\n"));
} finally {
  for (const handle of handles) handle.stop({ graceful: false });
  await Promise.all(handles.map((h) => h.waitForExit?.()));
  if (ownsTmux) execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  rmSync(root, { recursive: true, force: true });
}

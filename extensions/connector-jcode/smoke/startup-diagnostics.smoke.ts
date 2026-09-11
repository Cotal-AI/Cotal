import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "@1jehuang/jcode-sdk";
import {
  JcodeEffortRefusal,
  JcodeEffortUnsupported,
  installJcodeDiagnosticLog,
  jcodeEffortRefusal,
  writeJcodeDiagnostic,
} from "../src/startup-diagnostics.js";

let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-diagnostics-"));
try {
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const log = installJcodeDiagnosticLog(home);
  writeJcodeDiagnostic("diagnostic-log-canary\n");
  check("connector diagnostic log directory is owner-only", (statSync(join(home, "logs")).mode & 0o777) === 0o700);
  check("connector diagnostic log file is owner-only", (statSync(log).mode & 0o777) === 0o600);

  const identity = { model: "model", provider: "profile", apiMethod: "openai-compatible:profile" };
  const exactCapability = new HarnessError(
    "invalid_request",
    "Reasoning effort is not supported by the current model/profile. It works for OpenRouter, DeepSeek-family and GPT-family reasoning models, and profiles with supports_reasoning_effort = true.",
  );
  check("the exact Harness invalid_request capability refusal is classified separately", jcodeEffortRefusal(exactCapability, "high", identity) instanceof JcodeEffortUnsupported);
  const copiedPlainError = new HarnessError("invalid_request", exactCapability.message.replace(/^invalid_request: /, ""));
  Object.setPrototypeOf(copiedPlainError, Error.prototype);
  check("a plain Error with copied capability text stays a generic refusal", jcodeEffortRefusal(copiedPlainError, "high", identity) instanceof JcodeEffortRefusal);
  const differentCode = new HarnessError("invalid_request", exactCapability.message.replace(/^invalid_request: /, ""));
  Object.defineProperty(differentCode, "code", { value: "internal" });
  check("a different Harness code with copied capability text stays a generic refusal", jcodeEffortRefusal(differentCode, "high", identity) instanceof JcodeEffortRefusal);
  check("a near-miss invalid_request message stays a generic refusal", jcodeEffortRefusal(new HarnessError("invalid_request", "Reasoning effort is not supported by this route."), "high", identity) instanceof JcodeEffortRefusal);

  if (process.platform === "win32") {
    check("connector diagnostic log symlink guard is unreachable on unsupported Windows", true);
  } else {
    const plantedHome = join(root, "planted-home");
    const outside = join(root, "outside");
    mkdirSync(plantedHome, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(plantedHome, "logs"), "dir");
    let refused = false;
    try {
      installJcodeDiagnosticLog(plantedHome);
    } catch (error) {
      refused = /refusing symlinked Jcode connector log directory/.test(String((error as Error).message));
    }
    check("connector diagnostic log refuses a pre-planted logs symlink", refused && readdirSync(outside).length === 0, readdirSync(outside));
  }

  console.log(`\n${pass} checks passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

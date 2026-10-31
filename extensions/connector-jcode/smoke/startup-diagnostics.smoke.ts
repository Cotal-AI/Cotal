import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "@1jehuang/jcode-sdk";
import { classifyReadinessFailure, classifyReadinessProviderRefusal, installJcodeDiagnosticLog, writeJcodeDiagnostic } from "../src/startup-diagnostics.js";

let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-diagnostics-"));
try {
  const envelope = 'OpenAI-compatible chat request failed\n  endpoint: http://127.0.0.1:12345/v1/chat/completions\n  model: owned-pin\n  auth: PRIVATE_CANARY\n  status: 404 Not Found\n  response: {"error":{"code":"model_not_found","param":"model","message":"PRIVATE_CANARY"}}\nLocal endpoint hint: PRIVATE_CANARY';
  const classified = classifyReadinessProviderRefusal(new HarnessError("internal", envelope), "owned-pin");
  check("wrapped refusal renders only the requested pin and fixed provider code",
    classified?.value === "owned-pin" && classified.providerCode === "model_not_found" && !classified.message.includes("PRIVATE_CANARY"));
  for (const [name, error, pin] of [
    ["plain error", new Error(envelope), "owned-pin"],
    ["unrelated internal", new HarnessError("internal", "unrelated model_not_found"), "owned-pin"],
    ["missing pin", new HarnessError("internal", envelope), undefined],
    ["unsafe pin", new HarnessError("internal", envelope), "owned-pin\nPRIVATE_CANARY"],
    ["wrong status", new HarnessError("internal", envelope.replace("404 Not Found", "500 Internal Server Error")), "owned-pin"],
    ["wrong parameter", new HarnessError("internal", envelope.replace('"param":"model"', '"param":"token"')), "owned-pin"],
    ["wrong code", new HarnessError("internal", envelope.replace('"code":"model_not_found"', '"code":"secret_text"')), "owned-pin"],
    ["malformed JSON", new HarnessError("internal", envelope.replace('"error":', '"error"')), "owned-pin"],
    ["null error", new HarnessError("internal", envelope.replace(/\{"error":.*\}\}/, '{"error":null}')), "owned-pin"],
  ] as const) {
    check(`wrapped refusal leaves ${name} scrubbed`, classifyReadinessProviderRefusal(error, pin) === undefined);
  }

  const authEnvelope = envelope.replace("404 Not Found", "401 Unauthorized");
  const sendEnvelope = "Failed to send OpenAI-compatible chat request\n  endpoint: PRIVATE_CANARY\n  model: PRIVATE_CANARY\n  auth: PRIVATE_CANARY\nLocal endpoint hint: PRIVATE_CANARY";
  for (const [name, message, expected] of [
    ["HTTP 401", authEnvelope, "provider_auth_refused"],
    ["failed provider send", sendEnvelope, "provider_request_failed"],
  ] as const) {
    const failure = classifyReadinessFailure(new HarnessError("internal", message));
    check(`${name} keeps only a fixed startup category`, failure?.code === expected && !failure.message.includes("PRIVATE_CANARY"));
  }
  for (const [name, error] of [
    ["plain error", new Error(authEnvelope)],
    ["other SDK code", new HarnessError("invalid_request", authEnvelope)],
    ["unrelated 401", new HarnessError("internal", "unrelated\n  status: 401 Unauthorized\nPRIVATE_CANARY")],
    ["HTTP 403", new HarnessError("internal", authEnvelope.replace("401 Unauthorized", "403 Forbidden"))],
    ["HTTP 500", new HarnessError("internal", authEnvelope.replace("401 Unauthorized", "500 Internal Server Error"))],
    ["wrong send prefix", new HarnessError("internal", `unrelated ${sendEnvelope}`)],
    ["model refusal", new HarnessError("internal", envelope)],
  ] as const) {
    check(`readiness failure leaves ${name} unchanged`, classifyReadinessFailure(error) === undefined);
  }

  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const log = installJcodeDiagnosticLog(home);
  writeJcodeDiagnostic("diagnostic-log-canary\n");
  check("connector diagnostic log directory is owner-only", (statSync(join(home, "logs")).mode & 0o777) === 0o700);
  check("connector diagnostic log file is owner-only", (statSync(log).mode & 0o777) === 0o600);

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

import { runJcodeHost } from "./host.js";
import { JcodeEffortRefusal, JcodeReadinessProviderRefusal } from "./startup-diagnostics.js";

const STARTUP_FAILURE_CODES = new Set([
  "project_mcp_config",
  "jcode_not_found",
  "startup_failed",
  "startup_timeout",
  "invalid_instance_home",
  "connect_failed",
  "handshake_failed",
  "unsupported_version",
]);

function startupFailureCode(error: unknown): string {
  // This refusal is emitted by our own project-config preflight. Expose its fixed code, never the
  // source message, because the message lists local filenames and arbitrary child errors do not.
  if (error instanceof Error && error.message.startsWith("jcode connector: project MCP configuration")) return "project_mcp_config";
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && STARTUP_FAILURE_CODES.has(code) ? code : "unknown";
}

function renderEffortRefusal(error: unknown): string | undefined {
  if (!(error instanceof JcodeEffortRefusal)) return undefined;
  const ladder = error.acceptedLadder.length ? `; accepted tiers: ${error.acceptedLadder.join(", ")}` : "";
  return `Jcode reasoning effort refused: requested tier ${JSON.stringify(error.requestedTier)}; effective model ${JSON.stringify(error.effectiveModel)}; provider code ${error.providerCode}${ladder}`;
}

runJcodeHost().catch((error) => {
  const effortRefusal = renderEffortRefusal(error);
  if (effortRefusal) {
    process.stderr.write(`[cotal-jcode] fatal: ${effortRefusal}\n`);
    process.exit(1);
  }
  // The SDK appends captured child stderr to startup errors. A Jcode auth failure can therefore
  // carry sensitive provider material. Keep the SDK's fixed error code for diagnosis, but never
  // render the caught message, stack, or child bytes. The one narrow exception is a classified
  // readiness-turn provider refusal: it contains only the provider code plus the rejected
  // model/effort value the connector parsed from that response (#828).
  if (error instanceof JcodeReadinessProviderRefusal) {
    process.stderr.write(
      `[cotal-jcode] fatal: Jcode readiness turn refused ${error.parameter} ${JSON.stringify(error.value)} (${error.providerCode}); inspect the private Jcode logs for other details.\n`,
    );
  } else {
    process.stderr.write(`[cotal-jcode] fatal: Jcode host startup failed (${startupFailureCode(error)}); inspect the private Jcode logs.\n`);
  }
  process.exit(1);
});

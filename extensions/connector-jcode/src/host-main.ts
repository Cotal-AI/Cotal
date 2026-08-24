import { runJcodeHost } from "./host.js";

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

/** True for refusals this host composes itself, whose text is safe to render in full.
 *
 * The redaction below exists because the SDK appends captured child stderr to startup errors. This
 * one is not such an error: every part of it is either a value the operator supplied (the requested
 * tier, the model) or Jcode's own static reason for rejecting it — which names the ladder the
 * provider WOULD accept. That list is the only thing that tells an operator what to ask for
 * instead, and a fixed code cannot carry it. */
function rendersOwnMessage(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("jcode connector: reasoning effort ");
}

runJcodeHost().catch((error) => {
  if (rendersOwnMessage(error)) {
    process.stderr.write(`[cotal-jcode] fatal: ${error.message}\n`);
    process.exit(1);
  }
  // The SDK appends captured child stderr to startup errors. A Jcode auth failure can therefore
  // carry sensitive provider material. Keep the SDK's fixed error code for diagnosis, but never
  // render the caught message, stack, or child bytes. The live smoke prints this controlled reason.
  process.stderr.write(`[cotal-jcode] fatal: Jcode host startup failed (${startupFailureCode(error)}); inspect the private Jcode logs.\n`);
  process.exit(1);
});

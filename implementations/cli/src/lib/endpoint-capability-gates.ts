import { assertCommandToken, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, presentationOf } from "@cotal-ai/workspace";
import { onInstance } from "./control.js";
import { validateEndpointSelector } from "./endpoint-selection.js";

export function isEndpointCapabilityMode(mode: string | undefined): boolean {
  return mode === "watch" || mode === "session" || mode === "work";
}

const usage = (message: string) => new CommandFailure("refused", "USAGE_INVALID", message);
const bounded = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Validate only the public invocation shape. No file, subscription, lease or session is opened. */
export function validateEndpointCapabilityArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode, ...rest] = args.positionals;
  if (!isEndpointCapabilityMode(mode)) throw usage("use endpoint watch, endpoint session or endpoint work lease/commit");
  if (args.values.on !== undefined) onInstance(String(args.values.on), `cotal endpoint ${mode}`);
  const work = mode === "work", action = work ? rest[0] : undefined;
  if (work && action !== "lease" && action !== "commit") throw usage("use endpoint work lease <target> <pool> or endpoint work commit <target> <pool> --lease <private-file> --result <JSON>");
  const operands = work ? rest.slice(1) : rest;
  if (operands.length !== 2) throw usage(mode === "session" ? "endpoint session needs a target and declared command" : work ? "endpoint work needs a target and declared pool" : "endpoint watch needs a target and declared record key or event topic");
  validateEndpointSelector(operands[0]!);
  if (!bounded(operands[1])) throw usage("the requested command, record/topic or pool must be bounded and contain no terminal controls");
  if (mode === "session") {
    try { assertCommandToken(operands[1]!); }
    catch { throw usage("endpoint session needs one native command token"); }
  }
  const allowed = new Set(["space", "server", "creds", "on", "json", "plain", ...(mode === "watch" ? ["since"] : action === "commit" ? ["lease", "result"] : [])]);
  if (Object.keys(args.values).some((name) => !allowed.has(name))) throw usage("that flag does not belong to the selected endpoint capability mode");
  if (args.values.since !== undefined && (typeof args.values.since !== "string" || !/^[0-9]{1,20}$/.test(args.values.since))) throw usage("--since needs one native decimal sequence coordinate; it is not converted to another cursor type");
  if (action === "commit") {
    if (!bounded(args.values.lease) || typeof args.values.result !== "string" || !args.values.result) throw usage("work commit needs the original --lease file reference and --result JSON; no lease content is inferred");
    try { JSON.parse(args.values.result); }
    catch { throw usage("--result must contain valid JSON; its body is not echoed"); }
  }
}

/** The current native resolver exposes command contracts, not a verified mapping for these
 *  application capabilities. Declare the grammar, but never guess subjects or spend authority. */
export function endpointCapabilityGate(args: ParsedArgs): never {
  validateEndpointCapabilityArguments(args);
  throw new CommandFailure("refused", "UNSUPPORTED", "this author CLI has no verified native declaration adapter for the requested endpoint watch, interactive-session or work-pool capability; no subscription, cursor, session, lease or commit was created", {
    target: { capability: args.positionals[0], ...(args.positionals[0] === "work" ? { operation: args.positionals[1] } : {}) },
    remedy: "read cotal endpoint describe <target> --json for its current command surface; this refusal does not claim that the endpoint itself lacks the capability, and no generic subject or remote-execution fallback was used",
  });
}

/** Presentation is not local verification or conferring-handle redemption. */
export function refuseUnmappedHandle(args: ParsedArgs): void {
  if (args.values.handle === undefined) return;
  if (!bounded(args.values.handle)) throw usage("--handle needs one bounded protected file reference without terminal controls");
  throw new CommandFailure("refused", "UNSUPPORTED", "this author invocation route has no verified native handle/auth-slot adapter; the private file was not opened, no handle was redeemed and no broader caller or unverified envelope context was substituted", {
    remedy: "cotal auth handle inspect <file> reads explicitly unverified metadata only; use a native holder-bound implementation that verifies the presented context before effect",
  });
}

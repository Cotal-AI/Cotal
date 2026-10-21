import { randomUUID } from "node:crypto";
import {
  BASELINE_LIFECYCLE_ENDPOINT, EpEnvelopeError, assertCommandToken,
  epCast, invokeCommand, invokeRepairingSplit, parsePrincipalKey, resolveService,
  type CompletionResult, type EpAttributedReply, type EpVerbTarget, type FlagSpec,
  type FlagValues, type ParsedArgs, type ResolvedService,
} from "@cotal-ai/core";
import { type NatsConnection } from "@nats-io/transport-node";
import {
  CommandFailure, commandFailureReport, exitCode, failureEnvelope, jsonFlag, plainFlag, presentationOf, renderReport, streamRecord, terminalWidth, writeEnvelope, writeResult, writeStreamRecord,
  loadMeshes, targetFlags, type Report,
  recordOperationSpace,
} from "@cotal-ai/workspace";
import { followEndpointAction, type AcceptedEndpointGoal } from "../lib/endpoint-goal.js";
import { endpointResolution, resolveEndpointSelection, validateEndpointSelector } from "../lib/endpoint-selection.js";
import { endpointFailure, NativeReplyError, withPairedCallerRemedy } from "../lib/endpoint-errors.js";
import { refuseUnmappedHandle } from "../lib/endpoint-capability-gates.js";
import { invokeEndpointScatter, writeEndpointScatter } from "../lib/endpoint-scatter.js";
import { onInstance, onFlag } from "../lib/control.js";
import { openEndpointConnection as epConnection, pairedCallerCommand } from "../lib/endpoint-client.js";

const endpointTargetFlags = targetFlags.map((flag) => flag.name === "creds" ? { ...flag, description: "explicit credential file; native calls require its paired standalone context and registered static root" } : flag);
export const describeFlags = [...endpointTargetFlags, onFlag, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];
export const invokeFlags = [
  ...endpointTargetFlags, onFlag, jsonFlag, plainFlag,
  { name: "args", type: "string", value: "<json>", description: "command arguments as a JSON object" },
  { name: "handle", type: "string", value: "<private-file>", description: "present a capability handle; unavailable until the verified native auth-slot adapter is connected" },
  { name: "name", type: "string", value: "<agent>", description: "targeted manager commands: resolve this managed name to its current incarnation" },
  { name: "self", type: "boolean", description: "targeted commands: address the authenticated caller itself" },
  { name: "admin", type: "boolean", description: "explicitly use the existing admin instrument for cross-agent reach" },
  { name: "timeout", type: "string", value: "<ms>", description: "reply deadline in milliseconds (default 10000)" },
  { name: "wait", type: "boolean", description: "follow a declared action through native goal-result observation; --json emits goal NDJSON" },
  { name: "cast", type: "boolean", description: "submit an ephemeral command without a reply; report broker flush, not execution" },
  { name: "all", type: "boolean", description: "scatter an untargeted command once to the frozen live class; report every native result bucket" },
] as const satisfies readonly FlagSpec[];

export function describeComplete(argv: string[]): CompletionResult {
  if (argv.some((a) => a === "--space")) return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  return { items: [{ value: BASELINE_LIFECYCLE_ENDPOINT }], directive: "nofiles" };
}

export function validateEndpointArguments(args: ParsedArgs, operation: "describe" | "invoke"): void {
  presentationOf(args.values);
  if (args.positionals.length !== (operation === "describe" ? 1 : 2)) throw new CommandFailure("refused", "USAGE_INVALID", operation === "describe" ? "describe needs one native endpoint class" : "invoke needs one native endpoint class and one command");
  try {
    validateEndpointSelector(args.positionals[0]!);
    if (operation === "invoke") assertCommandToken(args.positionals[1]!);
  } catch { throw new CommandFailure("refused", "USAGE_INVALID", "use a valid native endpoint class and command token"); }
  if (args.values.creds !== undefined && (typeof args.values.creds !== "string" || !args.values.creds || args.values.creds.length > 4096 || /[\u0000-\u001f\u007f]/u.test(args.values.creds))) throw new CommandFailure("refused", "USAGE_INVALID", "--creds needs one bounded protected file reference without terminal controls");
  if (args.values.on !== undefined) onInstance(String(args.values.on), `cotal ${operation}`);
  if (operation === "describe") return;
  const values = args.values as FlagValues<typeof invokeFlags>;
  if (values.all && (values.cast || values.wait || values.on !== undefined || values.self || values.name !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "--all is an untargeted class scatter and cannot combine with --on, --self, --name, --cast or --wait");
  if (values.cast && values.wait) throw new CommandFailure("refused", "USAGE_INVALID", "--cast expects no reply and cannot follow a goal with --wait");
  if (values.self && values.name !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "choose --self or --name, not both");
  if (values.name !== undefined && (!values.name.trim() || /[\u0000-\u001f\u007f]/u.test(values.name))) throw new CommandFailure("refused", "USAGE_INVALID", "--name needs one concrete managed name without terminal controls");
  if (values.timeout !== undefined && (!/^[1-9][0-9]*$/.test(values.timeout) || !Number.isSafeInteger(Number(values.timeout)) || Number(values.timeout) > 2_147_483_647)) throw new CommandFailure("refused", "USAGE_INVALID", "--timeout must be a positive integer no greater than 2147483647 milliseconds");
  parsedInput(values.args);
}

function parsedInput(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new CommandFailure("refused", "USAGE_INVALID", "--args must contain one JSON object; the input body is not echoed"); }
}



export async function describeCmd(args: ParsedArgs, commandName = "describe"): Promise<void> {
  validateEndpointArguments(args, "describe");
  const requestedInstance = args.values.on === undefined ? undefined : onInstance(String(args.values.on), "cotal endpoint describe");
  const selection = resolveEndpointSelection(args.positionals[0]!, args.values as { space?: string; server?: string; creds?: string }, requestedInstance);
  const { endpoint, instanceId: on } = selection;
  recordOperationSpace(selection.space);
  let connection: Awaited<ReturnType<typeof epConnection>> | undefined;
  const target = { space: selection.space, endpoint, requestedInstanceId: on ?? null, ...(selection.reference ? { reference: selection.reference } : {}) };
  let result;
  try {
    selection.check();
    connection = await epConnection({ ...args.values, space: selection.space, ...(selection.credentialRef ? { creds: selection.credentialRef.path } : {}) }, "control-caller-privileged", endpoint, on);
    const { nc, space, auth, callerCredential } = connection;
    if (on !== undefined && auth.managerInstanceId !== undefined && on !== auth.managerInstanceId) throw new CommandFailure("refused", "CONFLICT", "the explicit pin differs from this credential's instance authority", { target });
    const instanceId = on ?? auth.managerInstanceId;
    const service = await resolveService(nc, space, endpoint, auth.epCaller!, { deadlineMs: 10_000, ...(instanceId === undefined ? {} : { instanceId }) });
    result = { kind: "endpoint-contract", contractSource: "fresh-native-resolution", endpoint: service.endpoint, owner: service.owner, responder: service.responder,
      resolution: endpointResolution(selection, service.responder),
      ...(callerCredential ? { callerCredential: callerCredential } : {}),
      commands: [...service.commands.values()].sort((a, b) => a.command.localeCompare(b.command)).map((command) => ({ command: command.command, capability: command.capability, class: command.class, action: command.action === true, targeted: command.targeted, modes: command.modes,
        ...(callerCredential ? { callerFileScope: !callerCredential.commands.includes(command.command) ? "not-in-file-scope" : command.class !== "ephemeral" || command.targeted || command.action === true ? "unsupported-current-command-shape" : "native-synchronous-scope" } : {}),
        inputDigest: command.contract.input.closureDigest, outputDigest: command.contract.output.closureDigest,
        input: command.contract.input.validate.schema, output: command.contract.output.validate.schema,
      })),
    };
  } catch (error) { throw endpointFailure(error, target, false); }
  finally { try { if (connection) await connection.nc.close(); } finally { selection.release(); } }
  writeResult(presentationOf(args.values), { command: commandName, target, result }, (data): Report => ({ sections: [
    { title: "Verified endpoint contract", blocks: [{ kind: "fields", rows: [["Endpoint", data.endpoint], ["Owner", data.owner], ["Answering instance", data.responder.instanceId], ["Epoch", String(data.responder.epoch)]] }, data.commands.length ? { kind: "table", columns: [{ key: "command", label: "Command" }, { key: "capability", label: "Capability" }, { key: "class", label: "Class" }, { key: "target", label: "Target modes" }, ...(data.callerCredential ? [{ key: "scope", label: "File scope" }] : [])], rows: data.commands.map((command) => ({ command: { text: command.command, tone: "command" }, capability: command.capability, class: `${command.class}${command.action ? " · action" : ""}`, target: command.targeted ? command.modes.join(", ") : "untargeted", ...(command.callerFileScope ? { scope: command.callerFileScope === "native-synchronous-scope" ? "in file scope" : command.callerFileScope === "not-in-file-scope" ? "not in file" : "shape changed; unsupported" } : {}) })) } : { kind: "lines", lines: ["No commands in this caller's described surface."] }, { kind: "lines", lines: [{ text: "Contracts were fetched and digest-verified by the native resolver. Discovery grants no additional command authority and does not prove task completion.", tone: "hint" }] }] },
    ...(data.callerCredential ? [{ title: "Explicit caller", blocks: [{ kind: "fields" as const, rows: [["Private file", data.callerCredential.path], ["Caller", data.callerCredential.identity], ["Lifecycle", data.callerCredential.lifecycleUid], ["Broker admission", "connection established"], ["Local request", data.callerCredential.localRequestId], ["Scope", "native static out-of-band; class-one synchronous commands"]] as const }, { kind: "lines" as const, lines: ["The paired local intent supplies selection coordinates, not authority. Signed native permission rows and principal tags matched the native builder before connection. No generation, live lifecycle currency, operator identity or instance authority was inferred. Described methods can exceed this file's invocation scope."] }] }] : []),
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: data.callerCredential ? "cotal ep describe <target> --creds <same-private-file> --json" : "cotal ep describe <target> --json", description: "Read the returned contracts and their closure digests" }, { command: data.callerCredential ? "cotal ep invoke <target> <command> --creds <same-private-file> --args '<json>'" : "cotal ep invoke <target> <command> --args '<json>'", description: "Retain the same caller and native capability rules" }] }] },
  ] }));
}

export async function invokeCmd(args: ParsedArgs, commandName = "invoke"): Promise<void> {
  validateEndpointArguments(args, "invoke");
  refuseUnmappedHandle(args);
  const values = args.values as FlagValues<typeof invokeFlags>;
  const [selector, command] = args.positionals as [string, string];
  const input = parsedInput(values.args);
  const requestedInstance = values.on === undefined ? undefined : onInstance(values.on, "cotal endpoint invoke");
  const selection = resolveEndpointSelection(selector, values, requestedInstance);
  const { endpoint, instanceId: on } = selection;
  recordOperationSpace(selection.space);
  let connection: Awaited<ReturnType<typeof epConnection>> | undefined;
  const requestId = randomUUID();
  const target = { space: selection.space, endpoint, command, requestedInstanceId: on ?? null, requestId, ...(selection.reference ? { reference: selection.reference } : {}) };
  let mayHaveInvoked = false;
  let accepted: AcceptedEndpointGoal | undefined;
  let streamStarted = false;
  let pairedCaller = false;
  let interrupted: "SIGINT" | "SIGTERM" | undefined;
  const follow = new AbortController();
  const onInterrupt = () => { interrupted = "SIGINT"; follow.abort(); };
  const onTerminate = () => { interrupted = "SIGTERM"; follow.abort(); };
  let result;
  try {
    selection.check();
    connection = await epConnection({ ...args.values, space: selection.space, ...(selection.credentialRef ? { creds: selection.credentialRef.path } : {}) }, values.admin ? "control-caller-admin" : "control-caller-privileged", endpoint, on);
    const { nc, space, auth, callerCredential } = connection;
    if (on !== undefined && auth.managerInstanceId !== undefined && on !== auth.managerInstanceId) throw new CommandFailure("refused", "CONFLICT", "the explicit pin differs from this credential's instance authority", { target });
    const instanceId = on ?? auth.managerInstanceId;
    if (values.all && instanceId !== undefined) throw new CommandFailure("refused", "CONFLICT", "--all cannot widen a saved or credential-bound instance pin into class authority", { target });
    const service = await resolveService(nc, space, endpoint, auth.epCaller!, { deadlineMs: 10_000, ...(instanceId === undefined ? {} : { instanceId }) });
    const declaration = service.commands.get(command);
    if (!declaration) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "this command is not in the endpoint's authorized described surface", { target });
    if (callerCredential && (!callerCredential.commands.includes(command) || !pairedCallerCommand(declaration))) throw new CommandFailure("refused", "UNSUPPORTED", "this command is outside the file's native synchronous untargeted scope; no command was published and no operator, generation or broader authority was substituted", { target });
    if (values.cast && declaration.class !== "ephemeral") throw new CommandFailure("refused", "USAGE_INVALID", "journaled commands cannot be cast; no command was published", { target });
    if (values.wait && declaration.action !== true) throw new CommandFailure("refused", "USAGE_INVALID", "--wait belongs to a command declared as a native action; no command was submitted", { target });
    const nativeTarget = await resolveTarget(nc, space, service, values, selection.reference !== undefined);
    if (declaration.targeted !== (nativeTarget !== undefined) || nativeTarget && !declaration.modes.includes(nativeTarget.mode)) throw new CommandFailure("refused", "USAGE_INVALID", "the selected targeting mode does not match the endpoint's declared command", { target });
    const canonicalInput = input === undefined && !declaration.contract.input.validate(null) && declaration.contract.input.validate({}) ? {} : input ?? null;
    if (!declaration.contract.input.validate(canonicalInput)) throw new CommandFailure("refused", "SCHEMA_INVALID", "arguments do not match the fetched native input contract; no command was published", { target, remedy: "read describe --json for the declared schema; the argument body is not echoed" });
    // A static-root operator instrument can request only the manager. A paired caller file makes
    // this call to another endpoint when the call and the whole surface fit that file's mode.
    pairedCaller = connection.mode === "auth" && !callerCredential && !selection.reference && on === undefined && nativeTarget === undefined
      && !values.admin && !values.all && !values.cast && !values.wait && [...service.commands.values()].every(pairedCallerCommand);
    selection.check();
    const beforeSubmit = () => {
      selection.check();
      if (values.wait && values.json && !streamStarted) {
        streamStarted = true;
        writeStreamRecord(streamRecord("goal", "snapshot", target, { phase: "submitting", requestId, resolution: endpointResolution(selection, service.responder), progressDisplay: "acceptance and native terminal only" }));
      }
      mayHaveInvoked = true;
    };
    if (values.wait) { process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate); }
    const invoke = selection.reference || callerCredential ? invokeCommand : invokeRepairingSplit;
    const deadlineMs = values.timeout === undefined ? 10_000 : Number(values.timeout);
    if (values.all) {
      if (declaration.class !== "ephemeral") throw new CommandFailure("refused", "UNSUPPORTED", "the installed native scatter helper supports ephemeral commands only; no journaled command was published", { target });
      beforeSubmit();
      result = await invokeEndpointScatter(nc, space, service, command, input, requestId, deadlineMs);
    } else if (values.cast) {
      beforeSubmit();
      try {
        await epCast(nc, space, service.pinnedInstanceId === undefined ? { mode: "one" } : { mode: "inst", instanceId: service.pinnedInstanceId }, {
          endpoint, command, contract: declaration.contract, caller: service.caller, id: requestId,
          bind: { instanceId: service.responder.instanceId, epoch: service.responder.epoch },
          ...(nativeTarget ? { target: nativeTarget } : {}),
          ...(canonicalInput === null ? {} : { args: canonicalInput }),
        }, { deadlineMs });
      } catch (error) {
        if (error instanceof EpEnvelopeError && ["permission-denied", "bad-request"].includes(error.code)) throw new CommandFailure("refused", error.code === "permission-denied" ? "PERMISSION_DENIED" : "SCHEMA_INVALID", "the native cast was refused before execution; no cast retry was made", { target, native: { code: error.code, outcome: "not-executed" } });
        throw error;
      }
      result = { kind: "endpoint-cast" as const, endpoint, command, requestId, resolution: endpointResolution(selection, service.responder), ...(callerCredential ? { callerCredential: callerCredential } : {}), binding: service.responder, route: service.pinnedInstanceId === undefined ? "class" : "instance", brokerFlushed: true, replyExpected: false, execution: "not-confirmed" };
    } else {
      let response: EpAttributedReply;
      if (values.wait) response = await followEndpointAction(nc, space, service, command, input, { requestId, deadlineMs, ...(nativeTarget ? { target: nativeTarget } : {}), retainBinding: selection.reference !== undefined, signal: follow.signal, beforeSubmit, accepted: (value) => {
        accepted = value;
        if (streamStarted) {
          writeStreamRecord(streamRecord("goal", "event", target, { phase: "accepted", accepted: value }));
          writeStreamRecord(streamRecord("goal", "gap", target, { reason: "intermediate-progress-not-exported", omittedCount: null, message: "The native helper follows progress and canonical goal reads; this CLI stream exports acceptance and terminal outcome only." }));
        }
      } });
      else { beforeSubmit(); response = await invoke(nc, space, service, command, input, { ...(nativeTarget ? { target: nativeTarget } : {}), deadlineMs, id: requestId }); }
      if (!response.reply.ok) throw new NativeReplyError(response, "invocation");
      result = { kind: "endpoint-reply" as const, command, requestId: response.reply.id, responder: response.responder,
        resolution: endpointResolution(selection, response.responder),
        ...(callerCredential ? { callerCredential: callerCredential } : {}),
        dataPresent: response.reply.data !== undefined, data: response.reply.data ?? null, waited: values.wait === true, accepted: accepted ?? null,
      };
    }
  } catch (error) {
    const refused = endpointFailure(error, { ...target, accepted: accepted ?? null }, mayHaveInvoked);
    const failure = pairedCaller && mayHaveInvoked ? withPairedCallerRemedy(refused, endpoint) : refused;
    if (streamStarted) {
      writeStreamRecord(streamRecord("goal", "error", target, { outcome: failure.outcome, error: failure.detail(), accepted: accepted ?? null }));
      writeStreamRecord(streamRecord("goal", "end", target, { reason: interrupted ?? "observation-ended", outcome: failure.outcome, accepted: accepted ?? null, actionUnaffectedByViewClose: true }));
      process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : exitCode(failure.outcome, failure.code);
      return;
    }
    if (interrupted) {
      if (values.json) writeEnvelope(failureEnvelope(commandName, failure));
      process.stderr.write(`${renderReport(commandFailureReport(failure), values.plain ? "plain" : "rich", terminalWidth(process.stderr))}
`);
      process.exitCode = interrupted === "SIGINT" ? 130 : 143;
      return;
    }
    throw failure;
  }
  finally { process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate); try { if (connection) await connection.nc.close(); } finally { selection.release(); } }
  if (result.kind === "endpoint-scatter") { writeEndpointScatter(presentationOf(values), commandName, target, result); return; }
  if (result.kind === "endpoint-cast") {
    writeResult(presentationOf(values), { command: commandName, target, result }, (data): Report => ({ sections: [
      { title: "Cast flushed to broker", blocks: [{ kind: "fields", rows: [["Endpoint", data.endpoint], ["Command", data.command], ["Request", data.requestId], ["Route", data.route], ["Describe binding", data.binding.instanceId], ["Binding epoch", String(data.binding.epoch)], ["Execution", { text: "not confirmed", tone: "waiting" }], ...(data.callerCredential ? ([["Caller file", data.callerCredential.path], ["Caller lifecycle", data.callerCredential.lifecycleUid]] as const) : [])] }, { kind: "lines", lines: [{ text: "The native publisher observed the broker flush without a publish denial. No endpoint reply was requested. This proves neither handler execution nor task completion, and a class cast is not repaired or retried after a binding mismatch.", tone: "hint" }] }] },
    ] }));
    return;
  }
  if (streamStarted) {
    const dataBytes = Buffer.byteLength(JSON.stringify(result.data), "utf8");
    const streamed = dataBytes > 16_384 ? { ...result, data: null, dataOmitted: true, dataBytes } : result;
    if (dataBytes > 16_384) writeStreamRecord(streamRecord("goal", "gap", target, { reason: "result-byte-limit", omittedBytes: dataBytes, accepted: accepted ?? null, message: "The native terminal value exceeds this stream's 16384-byte result limit. Read the original goal result; do not resubmit the action." }));
    writeStreamRecord(streamRecord("goal", "event", target, { phase: "succeeded", result: streamed }));
    writeStreamRecord(streamRecord("goal", "end", target, { reason: "native-goal-succeeded", outcome: "ok", accepted: accepted ?? null }));
    return;
  }
  const output = result.dataPresent ? JSON.stringify(result.data, null, 2).split("\n") : ["No return value."];
  const shown = output.slice(0, 60);
  writeResult(presentationOf(values), { command: commandName, target, result }, (data): Report => ({ sections: [
    { title: data.waited ? "Native goal succeeded" : "Endpoint answered", blocks: [{ kind: "fields", rows: [["Endpoint", data.responder.endpoint], ["Command", data.command], ["Request", data.requestId], ["Answering instance", data.responder.instanceId], ["Epoch", String(data.responder.epoch)], ...(data.callerCredential ? ([["Caller file", data.callerCredential.path], ["Caller lifecycle", data.callerCredential.lifecycleUid]] as const) : [])] }, { kind: "lines", lines: [{ text: data.waited ? "The native helper observed the accepted goal succeed. Result content is endpoint-provided, not a secret-redacted log." : "The native command returned success. An action acceptance is not proof that its external work completed. Result content is endpoint-provided, not a secret-redacted log.", tone: "hint" }] }] },
    { title: "Native result", blocks: [{ kind: "lines", lines: shown }, ...(output.length > shown.length ? [{ kind: "lines" as const, lines: [`${output.length - shown.length} result lines are not shown in this report. Choose --json before invoking to retain the full value; do not resubmit a mutation just to view it.`] }] : [])] },
  ] }));
}

/** Name resolution is a native manager read; the wire target is the current principal triple. */
async function resolveTarget(nc: NatsConnection, space: string, service: ResolvedService, values: FlagValues<typeof invokeFlags>, pinResolvedInstance = false): Promise<EpVerbTarget | undefined> {
  if (values.self) return { mode: "self" };
  if (values.name === undefined) return undefined;
  if (service.endpoint !== BASELINE_LIFECYCLE_ENDPOINT) throw new CommandFailure("refused", "UNSUPPORTED", "--name uses the manager's native alias resolver; this endpoint does not declare one");
  const invoke = pinResolvedInstance ? invokeCommand : invokeRepairingSplit;
  const inspected = await invoke(nc, space, service, "inspect", { name: values.name }, { deadlineMs: 10_000 });
  if (!inspected.reply.ok) throw new NativeReplyError(inspected, "target-inspection");
  const row = inspected.reply.data as { id?: unknown; lifecycleUid?: unknown } | undefined;
  if (!row || typeof row.id !== "string" || !row.id || typeof row.lifecycleUid !== "string" || !row.lifecycleUid) throw new CommandFailure("refused", "SCHEMA_INVALID", "the inspected target has no usable native incarnation");
  const principal = parsePrincipalKey(row.id);
  if (!principal && row.id.includes(".")) throw new CommandFailure("refused", "SCHEMA_INVALID", "the inspected target principal is malformed; no caller was substituted");
  return { mode: values.admin ? "any" : "owner", owner: principal?.owner ?? service.caller.owner, actor: principal?.actor ?? row.id, lifecycleUid: row.lifecycleUid };
}

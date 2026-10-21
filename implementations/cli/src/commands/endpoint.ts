import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import type { FlagSpec, ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure, isConnectRefusal, isWorkspaceTargetError, oneLine, presentationOf, resolveMeshTarget, targetErrorCode, writeResult, type Report } from "@cotal-ai/workspace";
import { endpointDeregister, validateEndpointDeregisterArguments } from "./endpoint-deregister.js";
import { endpointAuthoring, validateEndpointAuthoringArguments } from "./endpoint-authoring.js";
import { readEndpointInventory } from "../lib/endpoint-inventory.js";
import { endpointCapabilityGate, isEndpointCapabilityMode, validateEndpointCapabilityArguments } from "../lib/endpoint-capability-gates.js";
import { describeCmd, invokeCmd, invokeFlags, validateEndpointArguments } from "./describe.js";
import { canPrompt } from "./meshes-wizard.js";
import { commitEndpointReference, importEndpointReference, listEndpointReferences, readEndpointReference, referenceName, validateEndpointReference, type EndpointReference, type ReferenceSnapshot } from "../lib/endpoint-references.js";

export const endpointFlags = [...invokeFlags,
  { name: "since", type: "string", value: "<native-sequence>", description: "watch: native sequence coordinate; declaration adapter remains required" },
  { name: "lease", type: "string", value: "<private-file>", description: "work commit: original native lease tuple reference; no file is opened on an unsupported route" },
  { name: "result", type: "string", value: "<JSON>", description: "work commit: result JSON; its body is not echoed on refusal" },
  { name: "dry-run", type: "boolean", description: "deregister: inspect the exact offline target and intended guard without connecting or deleting" },
  { name: "dir", type: "string", value: "<directory>", description: "init: create contract and handler files exclusively in this directory" },
  { name: "live", type: "boolean", description: "inventory: also read authorized native service registrations; process controls are not implied" },
  { name: "refresh", type: "boolean", description: "describe: refused; this CLI keeps no contract cache and every describe resolves fresh" },
  { name: "file", short: "f", type: "string", value: "<reference.json>", description: "add: import the version-1 reference object, not a registration" },
  { name: "yes", short: "y", type: "boolean", description: "remove/deregister: confirm only that subcommand's reviewed local or native target" },
] as const satisfies readonly FlagSpec[];

export function validateEndpointReferenceArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode = "list", name, ...extra] = args.positionals;
  if (isEndpointCapabilityMode(mode)) return validateEndpointCapabilityArguments(args);
  if (["since", "lease", "result"].some((flag) => args.values[flag] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "--since belongs to endpoint watch; --lease and --result belong to endpoint work commit");
  if (mode === "deregister") return validateEndpointDeregisterArguments(args);
  if (args.values["dry-run"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--dry-run belongs to endpoint deregister");
  if (mode === "init" || mode === "check") return validateEndpointAuthoringArguments(args);
  if (args.values.dir !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--dir belongs to endpoint init");
  if (mode === "describe" || mode === "invoke") {
    if (mode !== "describe" && args.values.refresh !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--refresh belongs to endpoint describe");
    if (args.values.file !== undefined || args.values.yes !== undefined || args.values.live !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--file and --yes belong to local reference changes, not native calls");
    if (mode === "describe" && ["args", "name", "self", "admin", "timeout", "wait", "cast", "all", "handle"].some((flag) => args.values[flag] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "invocation flags do not belong to endpoint describe");
    validateEndpointArguments({ ...args, positionals: args.positionals.slice(1) }, mode);
    if (mode === "describe" && args.values.refresh !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", "endpoint describe keeps no cached contract for --refresh to bypass: every describe already resolves and fetches the native contract; nothing was sent", { remedy: "run the same endpoint describe without --refresh" });
    return;
  }
  if (args.values.live !== undefined && mode !== "list") throw new CommandFailure("refused", "USAGE_INVALID", "--live belongs to the endpoint inventory");
  if ([...(mode === "list" && args.values.live ? [] : ["server", "creds"]), "on", "args", "name", "self", "admin", "timeout", "refresh", "wait", "cast", "all", "handle"].some((flag) => args.values[flag] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "local endpoint reference operations accept no broker, caller or invocation flags");
  if (!["list", "show", "add", "remove"].includes(mode) || extra.length || (mode === "list" ? name !== undefined : mode !== "add" && name === undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "use endpoint, endpoint show <name>, endpoint add [name] [--file <reference.json>], or endpoint remove <name>");
  if (name !== undefined) referenceName(name);
  if (args.values.file !== undefined && mode !== "add") throw new CommandFailure("refused", "USAGE_INVALID", "--file belongs to endpoint add");
  if (args.values.yes && mode !== "remove") throw new CommandFailure("refused", "USAGE_INVALID", "--yes belongs to endpoint remove");
  if (mode === "add" && (!name || args.values.file === undefined) && (!canPrompt() || args.values.json)) throw new CommandFailure("refused", "USAGE_INVALID", "scripted endpoint add needs a name and --file; guided input requires an interactive terminal");
}

function selectedSpace(values: { space?: string }): string {
  try { return resolveMeshTarget(process.cwd(), { ...values, readOnly: true }).space; }
  catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code === "not-started" && error.details.space) return error.details.space;
    throw new CommandFailure("refused", targetErrorCode(error.code), "the selected reference space could not be resolved; no different space was selected");
  }
}

const projection = (row: ReferenceSnapshot) => ({ name: row.name, revision: row.record.revision, reference: row.record.value, liveCompleteness: "not-checked" as const, credentialValidation: "not-checked" as const });

export async function endpoint(args: ParsedArgs): Promise<void> {
  validateEndpointReferenceArguments(args);
  const modeRequested = args.positionals[0];
  if (isEndpointCapabilityMode(modeRequested)) return endpointCapabilityGate(args);
  if (modeRequested === "deregister") return endpointDeregister(args);
  if (modeRequested === "init" || modeRequested === "check") return endpointAuthoring(args);
  if (modeRequested === "describe") return describeCmd({ ...args, positionals: args.positionals.slice(1) }, "endpoint");
  if (modeRequested === "invoke") return invokeCmd({ ...args, positionals: args.positionals.slice(1) }, "endpoint");
  const presentation = presentationOf(args.values);
  const space = selectedSpace(args.values as { space?: string });
  const [mode = "list", suppliedName] = args.positionals;
  if (mode === "list") {
    const items = listEndpointReferences(space).map(projection);
    let live: Awaited<ReturnType<typeof readEndpointInventory>> | undefined;
    let unavailable: { code: string; message: string } | undefined;
    if (args.values.live) {
      try { live = await readEndpointInventory({ ...args.values, space } as { space?: string; server?: string; creds?: string }); }
      catch (error) { unavailable = { code: isCommandFailure(error) ? error.code : isConnectRefusal(error) ? error.code : "TARGET_UNAVAILABLE", message: "Authorized native registration reads were unavailable. The live inventory is not an empty complete result." }; }
    }
    const warnings = [...(live?.warnings ?? []), ...(unavailable ? [{ ...unavailable, target: { space } }] : [])];
    const partial = warnings.length > 0;
    writeResult(presentation, { command: "endpoint", target: { space }, result: { kind: "endpoint-references", items, live: live ?? null, liveUnavailable: unavailable ?? null, liveCompleteness: args.values.live ? partial ? "partial" : "complete" : "not-checked" }, warnings, ...(partial ? { completeness: "partial", partial: { message: "Some requested native registration reads were unavailable or bounded; local references are retained, but the live inventory is incomplete." } } : {}) }, (result): Report => ({ sections: [
      { title: "Saved endpoint references", blocks: [{ kind: "fields", rows: [["Space", space], ["Native registration reads", result.liveCompleteness], ["Serving responses", "not checked"]] }, result.items.length ? { kind: "table", columns: [{ key: "name", label: "Reference" }, { key: "endpoint", label: "Native class" }, { key: "instance", label: "Instance pin" }, { key: "credential", label: "Caller reference" }], rows: result.items.map((row) => ({ name: { text: row.name, tone: "command" }, endpoint: row.reference.endpoint, instance: row.reference.instanceId ?? "class selection", credential: row.reference.credentialRef ? "file reference; not checked" : "normal resolved caller" })) } : { kind: "lines", lines: ["No saved references in this selected local space."] }, { kind: "lines", lines: [{ text: "Saving a reference creates no native registration or caller capability. Only an explicit --live requests native registration reads.", tone: "hint" }] }] },
      ...(result.live ? [{ title: "Native registrations", blocks: [{ kind: "fields" as const, rows: [["Observed", result.live.observedAt], ["Enumeration", "bounded-lag metadata list"], ["Coordinates", "leader-served reads"], ["Liveness and responses", "not checked"]] as const }, result.live.items.length ? { kind: "table" as const, columns: [{ key: "endpoint", label: "Native class" }, { key: "instance", label: "Full instance" }, { key: "owner", label: "Owner" }, { key: "state", label: "Reported state" }, { key: "projection", label: "Status projection" }], rows: result.live.items.map((row) => ({ endpoint: row.endpoint, instance: row.instanceId, owner: row.owner, state: row.reportedState ?? "not reported", projection: row.projection })) } : { kind: "lines" as const, lines: ["No readable registrations in this authorized snapshot. Consult the read completeness and warnings above."] }, { kind: "lines" as const, lines: ["Registration metadata is not process ownership or proof that an endpoint currently answers. No service was started or controlled."] }] }] : []),
      ...(result.liveUnavailable ? [{ title: "Live reads unavailable", blocks: [{ kind: "lines" as const, lines: [{ text: result.liveUnavailable.message, tone: "waiting" as const }] }] }] : []),
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal ep add <name> --file <reference.json>", description: "Save a validated local reference without launching anything" }, { command: "cotal ep show <name>", description: "Read its pinned space, class and local revision" }] }] },
    ] }));
    return;
  }
  if (mode === "show") {
    const row = readEndpointReference(space, suppliedName!);
    if (!row) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no saved reference has this full name in the selected space", { target: { space, name: suppliedName } });
    writeResult(presentation, { command: "endpoint", target: { space, name: row.name }, result: projection(row) }, (result): Report => ({ sections: [
      { title: "Saved endpoint reference", blocks: [{ kind: "fields", rows: [["Name", result.name], ["Space", result.reference.space], ["Native class", result.reference.endpoint], ["Instance pin", result.reference.instanceId ?? "none"], ["Revision", result.revision], ["Caller reference", result.reference.credentialRef ? "file reference; protection not checked" : "normal resolved caller"], ["Live state", "not checked"]] }, { kind: "lines", lines: [{ text: "The name is local metadata, not a wire registration, a process controller or an authority grant.", tone: "hint" }] }] },
    ] }));
    return;
  }
  if (mode === "remove") {
    const row = readEndpointReference(space, suppliedName!);
    if (!row) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no saved reference has this full name in the selected space");
    if (!args.values.yes) {
      if (!canPrompt() || presentation === "json") throw new CommandFailure("refused", "USAGE_INVALID", "forgetting a saved reference outside interactive input requires --yes", { target: { space, name: row.name } });
      const answer = await prompts.confirm({ message: `Forget ${oneLine(row.name)} in ${oneLine(space)}? No endpoint, process or credential will be removed.`, initialValue: false });
      if (prompts.isCancel(answer) || !answer) { writeResult(presentation, { command: "endpoint", target: { space, name: row.name }, result: { kind: "reference-removal", removed: false }, noOp: true }, () => ({ sections: [{ title: "Reference kept", blocks: [{ kind: "lines", lines: ["No local record or remote resource was changed."] }] }] })); return; }
    }
    commitEndpointReference(space, row.name, row, undefined);
    writeResult(presentation, { command: "endpoint", target: { space, name: row.name }, result: { kind: "reference-removal", removed: true, removedRevision: row.record.revision } }, () => ({ sections: [{ title: "Local reference forgotten", blocks: [{ kind: "fields", rows: [["Name", row.name], ["Space", space]] }, { kind: "lines", lines: [{ text: "No native registration was deleted, no process stopped and no credential or grant revoked.", tone: "hint" }] }] }] }));
    return;
  }
  let name = suppliedName;
  if (!name) {
    const answer = await prompts.text({ message: "Local reference name", validate: (value) => { try { referenceName(value ?? ""); } catch { return "Use 1 to 64 letters, digits, underscores or dashes, beginning with a letter or digit."; } } });
    if (prompts.isCancel(answer)) return cancelled();
    name = referenceName(answer);
  }
  if (readEndpointReference(space, name)) throw new CommandFailure("refused", "CONFLICT", "this local reference already exists; it was not overwritten", { target: { space, name }, remedy: "show the current reference before explicitly removing or changing it" });
  let reference: EndpointReference;
  if (typeof args.values.file === "string") reference = importEndpointReference(resolve(args.values.file), space);
  else {
    const nativeClass = await prompts.text({ message: "Native endpoint class", placeholder: "reviews" });
    if (prompts.isCancel(nativeClass)) return cancelled();
    const instance = await prompts.text({ message: "Full instance pin, or leave empty for class selection", defaultValue: "" });
    if (prompts.isCancel(instance)) return cancelled();
    const credential = await prompts.text({ message: "Protected caller credential file, or leave empty for the normal caller", defaultValue: "" });
    if (prompts.isCancel(credential)) return cancelled();
    reference = validateEndpointReference({ schemaVersion: 1, space, endpoint: nativeClass, ...(instance ? { instanceId: instance } : {}), ...(credential ? { credentialRef: { kind: "file", path: credential } } : {}) }, space);
  }
  const record = commitEndpointReference(space, name, undefined, reference)!;
  writeResult(presentation, { command: "endpoint", target: { space, name }, result: { kind: "reference-added", name, revision: record.revision, reference: record.value, liveCompleteness: "not-checked" } }, (result): Report => ({ sections: [
    { title: "Endpoint reference saved", blocks: [{ kind: "fields", rows: [["Name", result.name], ["Space", result.reference.space], ["Native class", result.reference.endpoint], ["Instance pin", result.reference.instanceId ?? "none"], ["Revision", result.revision], ["Live state", "not checked"]] }, { kind: "lines", lines: [{ text: "Only owner-private local metadata was written. Nothing was launched, registered or invoked; credential contents were not read and no authority was granted.", tone: "hint" }] }] },
  ] }));
  function cancelled(): void { writeResult(presentation, { command: "endpoint", target: { space }, result: { kind: "reference-added", added: false }, noOp: true }, () => ({ sections: [{ title: "Reference creation cancelled", blocks: [{ kind: "lines", lines: ["No reference was saved and no endpoint contacted."] }] }] })); }
}

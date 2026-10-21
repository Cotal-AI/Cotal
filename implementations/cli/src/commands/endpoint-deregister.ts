import * as prompts from "../lib/prompts.js";
import { assertLifecycleToken, endpointToken, registry, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, brokerAddressForDisplay, isCommandFailure, isWorkspaceTargetError, oneLine,
  presentationOf, resolveMeshTarget, targetErrorCode, writeResult,
  type EndpointDeregisterAction, type EndpointDeregisterRequest, type Report,
} from "@cotal-ai/workspace";
import { canPrompt } from "./meshes-wizard.js";

export function validateEndpointDeregisterArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode, endpoint, instanceId, ...extra] = args.positionals;
  if (mode !== "deregister" || !endpoint || !instanceId || extra.length) throw new CommandFailure("refused", "USAGE_INVALID", "use endpoint deregister <native-class> <full-instance-id> [--yes|--dry-run]");
  try { endpointToken(endpoint); assertLifecycleToken(instanceId, "instanceId"); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "deregistration needs one native class and full instance ID, never a saved reference, prefix or display name"); }
  const allowed = new Set(["space", "server", "yes", "dry-run", "json", "plain"]);
  if (Object.keys(args.values).some((flag) => !allowed.has(flag))) throw new CommandFailure("refused", "USAGE_INVALID", "deregistration accepts no caller file, class scatter, invocation, process or reference flags");
}

/** Review a single registration, then delegate to the provider's existing broker-gone guard. */
export async function endpointDeregister(args: ParsedArgs): Promise<void> {
  validateEndpointDeregisterArguments(args);
  const [, endpoint, instanceId] = args.positionals as [string, string, string];
  const presentation = presentationOf(args.values);
  let selected: ReturnType<typeof resolveMeshTarget>;
  try { selected = resolveMeshTarget(process.cwd(), { space: args.values.space as string | undefined, server: args.values.server as string | undefined, readOnly: true }); }
  catch (error) {
    if (isWorkspaceTargetError(error)) throw new CommandFailure("refused", targetErrorCode(error.code), "the selected deregistration target could not be resolved; no stale entry was pruned or different root selected");
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the selected native target or trust metadata could not be read; no delete was attempted");
  }
  const target = { space: selected.space, endpoint, instanceId, root: selected.root, server: brokerAddressForDisplay(selected.server) ?? "not displayable" };
  if (selected.mode !== "auth" || !selected.auth) throw new CommandFailure("refused", "UNSUPPORTED", "this native operator path requires the selected static space's signing authority; open and user-auth spaces do not receive a static-credential fallback", { target });
  if (!registry.has("endpoint-action", "deregister")) throw new CommandFailure("refused", "UNSUPPORTED", "this composition has no registered native guarded-deregistration provider; no raw KV deletion was substituted", { target });
  if (args.values["dry-run"]) {
    writeResult(presentation, { command: "endpoint deregister", target, result: { kind: "endpoint-deregister-preview", ...target, brokerContacted: false, liveness: "not-checked", governance: "not-checked", writes: false, intendedRemoval: ["the inspected svc status revision", "the inspected svc spec revision"], processStop: false, issuanceGateChange: false } }, (data): Report => ({ sections: [
      { title: "Deregistration plan", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Broker", data.server], ["Root", data.root], ["Native class", data.endpoint], ["Full instance", data.instanceId], ["Broker evidence", { text: "not checked", tone: "waiting" }], ["Governance and revisions", { text: "not checked", tone: "waiting" }]] }, { kind: "lines", lines: ["Apply first asks this exact instance and requires the broker to affirm its instance rail empty. An answer, silence without that affirmation, a failed probe or an in-flight registration refuses. Only then may the native revision-pinned status/spec deletion run.", "No connection or deletion was attempted by this preview. It does not establish that apply will be permitted. No process or service would be stopped and the issuance gate would stay unchanged."] }] },
    ] }));
    return;
  }
  if (!args.values.yes) {
    if (!canPrompt() || presentation === "json") throw new CommandFailure("refused", "USAGE_INVALID", "scripted deregistration requires --yes after reviewing the full class, instance, space and root", { target, remedy: "run the same exact target with --dry-run first" });
    const confirmed = await prompts.confirm({ message: `Deregister ${oneLine(endpoint)}/${oneLine(instanceId)} in ${oneLine(selected.space)} at ${oneLine(target.server)}? Root ${oneLine(selected.root)}. This removes registration metadata only if the broker affirms that instance gone; it does not stop a process.`, initialValue: false });
    if (prompts.isCancel(confirmed) || !confirmed) {
      writeResult(presentation, { command: "endpoint deregister", target, result: { kind: "endpoint-deregister-cancelled", removed: false }, noOp: true }, () => ({ sections: [{ title: "Registration kept", blocks: [{ kind: "lines", lines: ["No probe or deletion was requested."] }] }] }));
      return;
    }
  }
  const request: EndpointDeregisterRequest = { root: selected.root, space: selected.space, server: selected.server, tlsRequired: selected.tlsRequired, account: selected.auth.account.pub, endpoint, instanceId };
  const action = registry.resolve<EndpointDeregisterAction>("endpoint-action", "deregister");
  let result: Awaited<ReturnType<typeof action.run>>;
  try { result = await action.run(request); }
  catch (error) { if (isCommandFailure(error)) throw error; throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the deregistration provider did not return a classified result; the same operation was not retried", { target }); }
  writeResult(presentation, { command: "endpoint deregister", target, result, warnings: result.warnings }, (data): Report => ({ sections: [
    { title: "Native registration removed", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Native class", data.endpoint], ["Full instance", data.instanceId], ["Guard", "broker affirmed the instance rail empty"], ["Removed spec revision", String(data.removedSpecRevision)], ["Removed status revision", data.removedStatusRevision === null ? "no status key was present" : String(data.removedStatusRevision)], ["Process stopped", "no"], ["Issuance gate changed", "no"]] }, { kind: "lines", lines: [{ text: "The native guard deleted the observed status before spec, with revision and governance checks. No process, agent or grant was stopped or revoked. The same instance can register again on a later start. Broker absence is an observation, not a permanent ban or a host inventory.", tone: "hint" }] }] },
  ] }));
}

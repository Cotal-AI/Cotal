import { randomUUID } from "node:crypto";
import { readSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  BASELINE_LIFECYCLE_ENDPOINT, EpEnvelopeError, assertValidChannel, assertValidName, assertValidRole,
  invokeCommand, isConcreteChannel, isPublishPermissionDenied, parseLeadingPromptFrontmatter, resolveService,
  type EpAttributedReply, type ParsedArgs,
} from "@cotal-ai/core";
import {
  CommandFailure, canonicalRoot, isCommandFailure, isConnectRefusal, presentationOf,
  readLocalRecordSource, writeResult, type OutputWarning, type Report,
} from "@cotal-ai/workspace";
import { openEndpointConnection } from "../lib/endpoint-client.js";
import { nativeEndpointRefusal } from "../lib/endpoint-errors.js";
import { onInstance } from "../lib/control.js";
import { openTransient } from "../lib/transient.js";
import type { PersonaValues } from "./persona.js";

const INPUT_LIMIT = 1024 * 1024;
const CONTENT_FLAGS = ["file", "prompt", "from", "role", "model", "subscribe", "harness", "allow-subscribe", "allow-publish", "announce"] as const;
const csv = (text: string | undefined) => text?.split(",").map((part) => part.trim()).filter(Boolean);

export function validateRemotePersonaArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const values = args.values as PersonaValues;
  onInstance(values.on!, "cotal persona --on");
  const [mode, name, ...extra] = args.positionals;
  if (mode !== undefined && !["list", "show", "create"].includes(mode)) throw new CommandFailure("refused", "UNSUPPORTED", "remote persona operations support list, show and create only; no local edit or removal was substituted");
  if (extra.length || (mode === undefined || mode === "list" ? name !== undefined : !name)) throw new CommandFailure("refused", "USAGE_INVALID", "use persona --on <full-manager-instance>, persona show <name> --on <id>, or persona create <name> --on <id>");
  if (name !== undefined) {
    try { if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(); assertValidName(name); }
    catch { throw new CommandFailure("refused", "USAGE_INVALID", "use one persona name made of letters, digits, underscores or dashes"); }
  }
  if (values.yes !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--yes is not a remote persona write override; existing ownership rules remain in force");
  if (mode !== "create" && CONTENT_FLAGS.some((flag) => values[flag] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "definition and announcement inputs belong to persona create");
  if (mode === "create") {
    if ([values.file, values.prompt, values.from].filter((value) => value !== undefined).length !== 1) throw new CommandFailure("refused", "USAGE_INVALID", "remote persona creation needs one of --file, --prompt or --from");
    if (values.role !== undefined) {
      try { assertValidRole(values.role); } catch { throw new CommandFailure("refused", "USAGE_INVALID", "use a valid role token"); }
    }
    if ([values.model, values.harness].some((value) => value !== undefined && (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value)))) throw new CommandFailure("refused", "USAGE_INVALID", "model and application pins must be nonempty without terminal controls");
    try {
      for (const channel of [...(csv(values.subscribe) ?? []), ...(csv(values["allow-subscribe"]) ?? []), ...(csv(values["allow-publish"]) ?? [])]) assertValidChannel(channel);
      if (values.announce !== undefined) { assertValidChannel(values.announce); if (!isConcreteChannel(values.announce)) throw new Error(); }
    } catch { throw new CommandFailure("refused", "USAGE_INVALID", "use native channel ACLs and one concrete announcement channel without rewriting its name"); }
  }
}

function definitionInput(values: PersonaValues, name: string): string {
  let bytes: Buffer;
  if (values.prompt !== undefined) bytes = Buffer.from(values.prompt, "utf8");
  else if (values.from === "-") {
    if (process.stdin.isTTY) throw new CommandFailure("refused", "USAGE_INVALID", "pipe the explicit --from - input instead of reading an interactive terminal");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, INPUT_LIMIT + 1 - total));
      const size = readSync(0, chunk, 0, chunk.length, null);
      if (!size) break;
      total += size;
      if (total > INPUT_LIMIT) throw new CommandFailure("refused", "USAGE_INVALID", "the persona input exceeds the 1 MiB limit");
      chunks.push(chunk.subarray(0, size));
    }
    bytes = Buffer.concat(chunks);
  } else {
    const path = values.file ?? values.from!;
    const source = readLocalRecordSource(path, INPUT_LIMIT, false);
    if (!source) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the explicit persona input is absent");
    bytes = source;
  }
  if (bytes.length > INPUT_LIMIT) throw new CommandFailure("refused", "USAGE_INVALID", "the persona input exceeds the 1 MiB limit");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!source.trim()) throw new Error();
    const parsed = parseLeadingPromptFrontmatter(source, name);
    if (parsed.def) {
      const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n?/)!;
      const fields = parseYaml(frontmatter[1]!) as Record<string, unknown>;
      const allowed = new Set(["name", "role", "model", "agent", "subscribe", "allowSubscribe", "allowPublish"]);
      const unsupported = Object.keys(fields ?? {}).filter((field) => !allowed.has(field));
      if (unsupported.length) {
        const known = ["kind", "tags", "description", "quiet", "muted", "variant", "launchOptions", "capabilities", "owner", "meta"].filter((field) => unsupported.includes(field));
        throw new CommandFailure("refused", "UNSUPPORTED", `the remote persona wire has no slot for ${known.length ? known.join(", ") : "additional frontmatter fields"}; no supplied metadata or authority was dropped`);
      }
    }
  } catch (error) {
    if (isCommandFailure(error)) throw error;
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the persona is empty, invalid UTF-8 or has malformed leading frontmatter; its contents were not printed");
  }
  return source;
}

function failedReply(response: EpAttributedReply, target: unknown, mutation: boolean): CommandFailure {
  const error = response.reply.error;
  const code = nativeEndpointRefusal(error?.code);
  const native = { code: error?.code, outcome: error?.outcome, detail: { requestId: response.reply.id, responder: response.responder } };
  if ((!mutation || error?.outcome === "not-executed") && code) return new CommandFailure("refused", code, "the selected manager refused this persona operation; its message and input contents were not copied", { target, native });
  return new CommandFailure(mutation && error?.outcome !== "executed" ? "unknown" : "failed", mutation && error?.outcome !== "executed" ? "OPERATION_UNKNOWN" : "OPERATION_FAILED", "the native persona operation did not return success; it was not retried", { target, native });
}

/** Exact native manager routes only. No remote operation reads or writes the local catalog. */
export async function remotePersona(args: ParsedArgs): Promise<void> {
  validateRemotePersonaArguments(args);
  const values = args.values as PersonaValues;
  const [mode = "list", name] = args.positionals;
  const input = mode === "create" ? definitionInput(values, name!) : undefined;
  const instanceId = onInstance(values.on!, "cotal persona --on");
  const requestId = randomUUID();
  let connection: Awaited<ReturnType<typeof openEndpointConnection>> | undefined;
  let sender: Awaited<ReturnType<typeof openTransient>> | undefined;
  let submitted = false;
  let target: Record<string, unknown> = { requestedInstanceId: instanceId, name: name ?? null, requestId };
  let result: Record<string, unknown> | undefined;
  let operationFailure: CommandFailure | undefined;
  let fatal: unknown;
  const warnings: OutputWarning[] = [];
  try {
    connection = await openEndpointConnection(values, "control-caller-privileged", BASELINE_LIFECYCLE_ENDPOINT, instanceId);
    target = { ...target, space: connection.space, endpoint: BASELINE_LIFECYCLE_ENDPOINT };
    if (connection.auth.managerInstanceId !== undefined && connection.auth.managerInstanceId !== instanceId) throw new CommandFailure("refused", "CONFLICT", "the supplied manager pin differs from the caller's bound instance; no class fallback was used", { target });
    const service = await resolveService(connection.nc, connection.space, BASELINE_LIFECYCLE_ENDPOINT, connection.auth.epCaller!, { instanceId, deadlineMs: 10_000 });
    if (values.announce !== undefined) {
      sender = await openTransient({ space: connection.space, server: connection.server }, "persona announcement", { throwOnRefusal: true, report: () => { warnings.push({ code: "ANNOUNCEMENT_CONNECTION_WARNING", target, message: "The announcement sender reported a connection warning; only its publish acknowledgement establishes storage." }); } });
      const sameRoot = connection.root !== undefined && sender.connection.root !== undefined && canonicalRoot(sender.connection.root) === canonicalRoot(connection.root);
      if (sender.space !== connection.space || sender.connection.server !== connection.server || !sameRoot || sender.connection.mode !== connection.mode || connection.account !== undefined && sender.connection.auth?.account.pub !== connection.account) throw new CommandFailure("refused", "CONFLICT", "the announcement's resolved space, root or account differs from the selected manager target; no persona was saved", { target });
    }
    const command = mode === "create" ? "define-persona" : mode === "show" ? "show-persona" : "list-personas";
    const body = mode === "create" ? { name, persona: input, model: values.model, role: values.role, agent: values.harness, subscribe: csv(values.subscribe), allowSubscribe: csv(values["allow-subscribe"]), allowPublish: csv(values["allow-publish"]) } : mode === "show" ? { name } : undefined;
    if (!service.commands.has(command)) throw new CommandFailure("refused", "UNSUPPORTED", "the selected manager does not declare this native persona operation; no legacy or local path was substituted", { target });
    submitted = mode === "create";
    const response = await invokeCommand(connection.nc, connection.space, service, command, body, { deadlineMs: 10_000, id: requestId });
    if (!response.reply.ok) throw failedReply(response, target, mode === "create");
    const raw = response.reply.data as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("persona reply shape");
    if (mode === "create" && (raw.name !== name || typeof raw.path !== "string")) throw new Error("persona write reply identity");
    if (mode === "show" && raw.name !== name) throw new Error("persona read reply identity");
    const data = mode === "create" ? { name: raw.name, path: raw.path } : mode === "show" ? Object.fromEntries(["name", "role", "model", "description", "owner", "persona"].filter((key) => typeof raw[key] === "string").map((key) => [key, raw[key]])) : { personas: raw.personas };
    if (mode === "list" && (!Array.isArray(raw.personas) || raw.personas.some((row) => !row || typeof row !== "object" || typeof row.name !== "string"))) throw new Error("persona list reply");
    result = { kind: "remote-persona", operation: mode, space: connection.space, requestedInstanceId: instanceId, requestId: response.reply.id, responder: response.responder, data, saved: mode === "create", localFilesChanged: false, agentLaunched: false, announcement: null };
    if (sender && values.announce !== undefined) {
      try {
        const message = await sender.ep.multicast(`Defined persona ${name}; available in the selected manager's persona catalog.`, { channel: values.announce });
        result.announcement = { channel: values.announce, outcome: "stored", messageId: message.id, sendingPrincipal: sender.ep.card.id, delivery: "not-confirmed", taskCompletion: "not-confirmed" };
      } catch (error) {
        const outcome = isPublishPermissionDenied(error) ? "denied" : "unknown";
        result.announcement = { channel: values.announce, outcome, messageId: null, retried: false };
        operationFailure = new CommandFailure("partial", "OPERATION_PARTIAL", outcome === "denied" ? "the persona was saved, but the announcement publish was denied; do not repeat the definition" : "the persona was saved, but announcement storage is unconfirmed; inspect the channel before posting again", { target, changed: [{ kind: "remote-persona-saved", name, managerInstanceId: response.responder.instanceId, requestId: response.reply.id }] });
      }
    }
  } catch (error) {
    if (isCommandFailure(error)) fatal = error;
    else if (isConnectRefusal(error)) fatal = error.failure();
    else if (error instanceof EpEnvelopeError && (!submitted || error.outcome === "not-executed") && nativeEndpointRefusal(error.code)) fatal = new CommandFailure("refused", nativeEndpointRefusal(error.code)!, "the selected manager's native persona boundary refused the operation", { target, native: { code: error.code, outcome: error.outcome } });
    else fatal = new CommandFailure(submitted ? "unknown" : "failed", submitted ? "OPERATION_UNKNOWN" : "OPERATION_FAILED", submitted ? "the remote persona write outcome is unconfirmed; its original request was retained and not retried" : "the remote persona view or announcement preparation could not be established; no local catalog was used", { target });
  } finally {
    try { if (sender) await sender.ep.stop(); } catch { warnings.push({ code: "ANNOUNCEMENT_CLEANUP_UNCONFIRMED", target, message: "The transient sender's cleanup was not confirmed; this does not erase any recorded save or storage acknowledgement." }); }
    try { if (connection) await connection.nc.close(); } catch { warnings.push({ code: "PERSONA_CONNECTION_CLEANUP_UNCONFIRMED", target, message: "Control connection cleanup was not confirmed; its observed native result is retained." }); }
  }
  if (fatal) throw fatal;
  writeResult(presentationOf(values), { command: "persona", target, result: result!, warnings, failure: operationFailure }, remotePersonaView);
}

function remotePersonaView(result: Record<string, unknown>): Report {
  const responder = result.responder as { instanceId: string; epoch: number };
  const data = result.data as Record<string, unknown>;
  const rows = result.operation === "list" ? data.personas as Record<string, unknown>[] : [];
  const announcement = result.announcement as { channel: string; outcome: string; messageId?: string } | null;
  const instructions = typeof data.persona === "string" ? data.persona.split(/\r?\n/) : [];
  const pin = String(result.requestedInstanceId);
  const name = typeof data.name === "string" && /^[A-Za-z0-9_-]+$/.test(data.name) ? data.name : null;
  return { sections: [
    { title: result.saved ? "Persona saved on manager" : "Manager persona catalog", blocks: [
      { kind: "fields", rows: [["Space", String(result.space)], ["Requested manager", pin], ["Answering manager", responder.instanceId], ["Epoch", String(responder.epoch)], ["Original request", String(result.requestId)], ["Local files", "unchanged"], ["Agent launch", "not requested"]] },
      ...(result.operation === "list" ? [{ kind: "table" as const, columns: [{ key: "name", label: "Persona" }, { key: "role", label: "Disclosed role" }, { key: "model", label: "Disclosed model" }, { key: "details", label: "Visibility" }], rows: rows.slice(0, 100).map((row) => ({ name: String(row.name), role: typeof row.role === "string" ? row.role : "not disclosed", model: typeof row.model === "string" ? row.model : "not disclosed", details: row.owner === undefined ? "name may be all this caller can read" : "caller-visible metadata" })) }, ...(rows.length > 100 ? [{ kind: "lines" as const, lines: [`${rows.length - 100} persona rows are not shown; JSON retains the full authorized catalog.`] }] : [])] : [{ kind: "fields" as const, rows: Object.entries(data).filter(([key, value]) => key !== "persona" && typeof value === "string").map(([key, value]) => [key, String(value)] as [string, string]) }]),
      { kind: "lines", lines: [{ text: "The native manager enforces caller ownership. Listing a name confers no read, write or launch authority. No local catalog, wider manager or legacy control route was substituted.", tone: "hint" }] },
    ] },
    ...(instructions.length ? [{ title: "Authorized instructions", blocks: [{ kind: "lines" as const, lines: instructions.slice(0, 60) }, ...(instructions.length > 60 ? [{ kind: "lines" as const, lines: [`${instructions.length - 60} body lines are not shown; JSON retains the authorized result.`] }] : [])] }] : []),
    ...(announcement ? [{ title: "Announcement", blocks: [{ kind: "fields" as const, rows: [["Channel", announcement.channel], ["Storage", announcement.outcome], ["Message", announcement.messageId ?? "not confirmed"], ["Delivery and completion", "not confirmed"]] as [string, string][] }] }] : []),
    { title: "Next", blocks: [{ kind: "commands", items: name ? [
      { command: `cotal p show ${name} --on ${pin}`, description: "Read this manager's authorized definition" },
      { command: `cotal spawn ${name} --on ${pin}`, description: "Request a launch under the native caller grants" },
    ] : [{ command: `cotal p show <name> --on ${pin}`, description: "Read a named definition from this manager" }] }] },
  ] };
}

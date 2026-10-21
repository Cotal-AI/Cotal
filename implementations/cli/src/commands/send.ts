import { hostname, userInfo } from "node:os";
import { readFileSync } from "node:fs";
import {
  resolvePeer,
  assertValidChannel,
  assertValidRole,
  isConcreteChannel,
  effectiveDeliveryClass,
  effectiveReplay,
  readChannelRegistry,
  AmbiguousPeerError,
  type FlagSpec,
  type FlagValues,
  type Presence,
  type CompletionResult,
  type ParsedArgs,
} from "@cotal-ai/core";
import { CommandFailure, recordOperationSpace, jsonFlag, plainFlag, presentationOf, writeResult, loadMeshes, resolveMeshTarget, targetFlags, type OutputWarning } from "@cotal-ai/workspace";
import { completedFlagValue, completingFlagValue } from "../lib/completion.js";
import { openTransient } from "../lib/transient.js";
import { listDeclaredChannels, listDeclaredRoles } from "../lib/personas.js";
import { mentionsIn } from "../lib/mentions.js";
import { offlineRecipientNotice } from "../lib/offline-recipient.js";

/**
 * One explicit --to, --channel or --role chooses the native delivery mode. The command
 * publishes one body and exits; a stored message is not proof of delivery or completion.
 */

export const sendFlags = [
  ...targetFlags, jsonFlag, plainFlag,
  { name: "to", short: "t", type: "string", value: "<agent>", description: "send directly to one agent" },
  { name: "channel", short: "c", type: "string", value: "<channel>", description: "publish to one channel" },
  { name: "role", short: "r", type: "string", value: "<role>", description: "queue for one agent with this role" },
  { name: "file", short: "f", type: "string", value: "<path>", description: "read the message body from this UTF-8 file, instead of a positional body" },
  { name: "stdin", type: "boolean", description: "read the message body from explicit stdin, instead of a positional body" },
  { name: "mention", type: "string", multiple: true, value: "<agent>", description: "channel: wake this authorized peer; repeat for several peers" },
  { name: "reply-to", type: "string", value: "<message-id>", description: "direct send: name the message this body answers" },
  { name: "verbose", short: "v", type: "boolean", description: "include the actual sending principal in the receipt" },
] as const satisfies readonly FlagSpec[];

/** Derive the one-shot send's display name from the OS login and host, `<login>@<host>` — never
 *  from `COTAL_NAME` (#680). `userInfo()` throws on a system with no passwd entry for the uid;
 *  let it propagate. No fallback to a fixed literal (per AGENTS.md). */
function senderName(): string {
  const login = userInfo().username.trim();
  const host = hostname().trim();
  if (!login || !host)
    throw new Error("cotal send cannot derive a sender name: empty login or host from the OS");
  const name = `${login}@${host}`;
  if (name.length > 128)
    throw new Error(`cotal send cannot derive a sender name: "${name}" exceeds 128 characters`);
  if (/[/\\\r\n]/.test(name))
    throw new Error(`cotal send cannot derive a sender name: "${name}" contains a reserved character`);
  return name;
}

type Values = FlagValues<typeof sendFlags>;
interface SendInput {
  mode: "dm" | "msg" | "ask";
  target: string;
  source: "argument" | "file" | "stdin";
  text?: string;
}

/** Resolve the recipient and body-source grammar without reading stdin or opening a connection. */
export function sendArguments(args: ParsedArgs): SendInput {
  const values = args.values as Values;
  presentationOf(values);
  const destinations: { mode: SendInput["mode"]; target: string }[] = [];
  if (values.to !== undefined) destinations.push({ mode: "dm", target: values.to });
  if (values.channel !== undefined) destinations.push({ mode: "msg", target: values.channel });
  if (values.role !== undefined) destinations.push({ mode: "ask", target: values.role });
  if (destinations.length !== 1) throw new CommandFailure("refused", "USAGE_INVALID", "choose one destination: --to/-t, --channel/-c, or --role/-r");
  const destination = destinations[0]!;
  destination.target = destination.target.replace(destination.mode === "msg" ? /^#/ : /^@/, "");
  const bodies = Number(args.positionals.length === 1) + Number(values.file !== undefined) + Number(values.stdin === true);
  if (!destination.target.trim() || args.positionals.length > 1 || bodies !== 1 || (args.positionals.length === 1 && !args.positionals[0]?.trim()) || values.file === "")
    throw new CommandFailure("refused", "USAGE_INVALID", "choose exactly one body: a quoted message, --file/-f <path>, or --stdin", { remedy: 'run cotal send -t <agent> "<message>"' });
  try {
    if (destination.mode === "msg") {
      assertValidChannel(destination.target);
      if (!isConcreteChannel(destination.target)) throw new Error("wildcard publication");
    } else if (destination.mode === "ask") assertValidRole(destination.target);
    else if (/[\/\u0000-\u001f\u007f]/u.test(destination.target)) throw new Error("not an agent address");
  } catch {
    throw new CommandFailure("refused", "USAGE_INVALID", destination.mode === "msg" ? "name one concrete channel, without wildcards" : destination.mode === "ask" ? "name one native role token" : "use an agent name or full instance id, not a roster label");
  }
  if (values["reply-to"] !== undefined && (destination.mode !== "dm" || !values["reply-to"].trim() || /[\u0000-\u001f\u007f]/u.test(values["reply-to"])))
    throw new CommandFailure("refused", "USAGE_INVALID", "--reply-to takes a message identifier and requires --to");
  if (values.mention?.length && destination.mode !== "msg")
    throw new CommandFailure("refused", "UNSUPPORTED", "native mention hints belong to channel publications; they do not change a direct or role destination");
  if (values.mention?.some((name) => !name.replace(/^@/, "").trim() || /[\/\u0000-\u001f\u007f]/u.test(name)))
    throw new CommandFailure("refused", "USAGE_INVALID", "each --mention names one agent or full instance id");
  return { ...destination, source: values.file !== undefined ? "file" : values.stdin ? "stdin" : "argument", ...(args.positionals[0] === undefined ? {} : { text: args.positionals[0] }) };
}

function bodyOf(input: SendInput, values: Values): string {
  if (input.source === "argument") return input.text!;
  if (input.source === "stdin" && process.stdin.isTTY)
    throw new CommandFailure("refused", "USAGE_INVALID", "pipe the message to --stdin, or use a quoted body or --file");
  let bytes: Buffer;
  try { bytes = readFileSync(input.source === "file" ? values.file! : 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CommandFailure("refused", code === "EACCES" || code === "EPERM" ? "PERMISSION_DENIED" : code === "ENOENT" ? "TARGET_NOT_FOUND" : "USAGE_INVALID", "the explicit message input could not be read");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "the message input is not valid UTF-8"); }
  if (!text.trim()) throw new CommandFailure("refused", "USAGE_INVALID", "the explicit message input is empty");
  return text;
}

async function directPeer(ep: Awaited<ReturnType<typeof openTransient>>["ep"], space: string, name: string): Promise<Presence> {
  // Presence arrives asynchronously. Never turn a partial name into a fuzzy target.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const peer = resolvePeer(ep.getRoster(), name);
      if (peer) return peer;
    } catch (error) {
      if (!(error instanceof AmbiguousPeerError)) throw error;
      throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "several participants have this name; use a full identity", { target: { space, name, candidates: error.candidates } });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no matching participant was found in the authorized presence view", { target: { space, name } });
}

/** Read the explicit body once, send once, close the transient sender, then print one receipt. */
export async function send(args: ParsedArgs): Promise<void> {
  const input = sendArguments(args);
  const values = args.values as Values;
  const presentation = presentationOf(values);
  const text = bodyOf(input, values);
  const warnings: OutputWarning[] = [];
  const opened = await openTransient(values, senderName(), { throwOnRefusal: true, report: (level) => {
    warnings.push({ code: level === "error" ? "SENDER_CONNECTION_WARNING" : "SENDER_WARNING", target: { destination: input.target }, message: "The transient sender reported a connection or delivery warning; its receipt confirms only the stated storage outcome." });
  } });
  const { ep, space, connection } = opened;
  recordOperationSpace(space);
  const target = { space, mode: input.mode, destination: input.target };
  let receipt: {
    kind: "send"; messageId: string; sequence: number | null; destination: string;
    sender: { principal: string; kind: string }; stored: true; delivery: null; acceptance: null; completion: null;
    replyListener: false; replyTo: string | null; bodySource: string; mentions: string[];
    channelPolicy: { registered: boolean; replay: boolean; window: string | null; delivery: string } | null;
  } | undefined;
  let failure: unknown;
  try {
    let policy: NonNullable<typeof receipt>["channelPolicy"] = null;
    if (input.mode === "msg") {
      try {
        // One Direct Get with a static or open credential, as the transient endpoint reads: the
        // default scan's consumer outlives the send by five minutes (#4091). A user bearer has no
        // Direct Get row, so it keeps the scan.
        const registry = await readChannelRegistry({ servers: connection.server, space, ...(connection.bearer ? { bearer: connection.bearer, sentinelCreds: connection.sentinelCreds } : { creds: connection.creds }), directGet: !connection.bearer });
        const config = Object.hasOwn(registry.channels ?? {}, input.target) ? registry.channels![input.target] : undefined;
        policy = { registered: config !== undefined, replay: effectiveReplay(config, registry.defaults), window: config?.replayWindow ?? registry.defaults?.replayWindow ?? null, delivery: effectiveDeliveryClass(config, registry.defaults) };
        if (!policy.registered) warnings.push({ code: "CHANNEL_UNREGISTERED", target, message: "Unregistered channel: publication uses the native space policy and does not create channel metadata." });
      } catch {
        warnings.push({ code: "CHANNEL_METADATA_NOT_CHECKED", target, message: "Channel metadata could not be read. Only the native publish result establishes whether the post was accepted for storage." });
      }
    }
    const mentions = input.mode === "msg" ? [...mentionsIn(text)] : [];
    for (const name of values.mention ?? []) mentions.push((await directPeer(ep, space, name.replace(/^@/, ""))).card.id);
    const peer = input.mode === "dm" ? await directPeer(ep, space, input.target) : undefined;
    let messageId: string;
    let sequence: number | null = null;
    try {
      if (peer) {
        const { msg, ack } = await ep.unicastAttributed(peer.card.id, text, { replyTo: values["reply-to"] });
        messageId = msg.id; sequence = ack.seq;
        if (peer.status === "offline") warnings.push({ code: "RECIPIENT_OFFLINE", target, message: offlineRecipientNotice(peer.card.name) });
      } else if (input.mode === "ask") {
        const { msg, ack } = await ep.anycastAttributed(input.target, text);
        messageId = msg.id; sequence = ack.seq;
      } else messageId = (await ep.multicast(text, { channel: input.target, mentions })).id;
    } catch {
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "No storage acknowledgement was established. The message may have been stored; it was not retried.", { target, remedy: "Inspect the destination before sending again. The native publisher did not return a message identifier." });
    }
    receipt = { kind: "send", messageId, sequence, destination: peer?.card.id ?? input.target, sender: { principal: ep.card.id, kind: ep.card.kind }, stored: true, delivery: null, acceptance: null, completion: null, replyListener: false, replyTo: values["reply-to"] ?? null, bodySource: input.source, mentions: [...new Set(mentions)], channelPolicy: policy };
  } catch (error) { failure = error; }
  try { await ep.stop(); }
  catch { warnings.push({ code: "SENDER_CLEANUP_NOT_CONFIRMED", target, message: "Transient observer cleanup was not confirmed. This does not change the storage acknowledgement." }); }
  if (failure !== undefined) throw failure;
  writeResult(presentation, { command: "send", target, result: receipt!, warnings }, (result) => ({ sections: [
    { title: "Message stored", blocks: [{ kind: "fields", rows: [
      ["Space", space], ["To", input.mode === "msg" ? `#${input.target}` : input.mode === "ask" ? `role ${input.target}` : input.target],
      ["Message", result.messageId], ...(result.sequence === null ? [] : [["Stored sequence", String(result.sequence)]] as [string, string][]),
      ["Delivery", "not confirmed"], ...(values.verbose ? [["Sending principal", result.sender.principal], ["Sender kind", result.sender.kind]] as [string, string][] : []),
    ] }, { kind: "lines", lines: [{ text: "No active reply listener. Storage is not delivery, acceptance or completion.", tone: "hint" }] }] },
  ] }));
}

/** Complete the declared destination flags from local records only. */
export function sendComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, sendFlags);
  if (flag?.name === "creds" || flag?.name === "file") return { items: [], directive: "default" };
  if (flag?.name === "space") return { items: loadMeshes().map((mesh) => ({ value: mesh.space })), directive: "nofiles" };
  if (flag?.name === "channel") return { items: declaredFrom(argv, listDeclaredChannels).map((value) => ({ value })), directive: "nofiles" };
  if (flag?.name === "role") return { items: declaredFrom(argv, listDeclaredRoles).map((value) => ({ value })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

/** Channels/roles declared by the TARGET mesh's personas — `cotal send` and `cotal chat` act on the
 *  mesh `--space`/`--server` resolve to, so their completions must come from that mesh's catalog and
 *  not from whatever project the operator happens to be standing in. Offline (no probe: a <TAB> never
 *  opens the network) and FAIL CLOSED — with no single resolvable target, or a malformed persona
 *  file (see `declaredValues`), offer nothing rather than throw into the operator's shell. */
export function declaredFrom(argv: string[], list: (root: string) => string[]): string[] {
  try {
    return list(
      resolveMeshTarget(process.cwd(), {
        space: completedFlagValue(argv, targetFlags, "space"),
        server: completedFlagValue(argv, targetFlags, "server"),
      }).root,
    );
  } catch {
    return [];
  }
}

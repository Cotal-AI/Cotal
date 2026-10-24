import { hostname, userInfo } from "node:os";
import { closeSync, fstatSync, openSync, read } from "node:fs";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolvePeer,
  assertValidName,
  assertValidRole,
  isPublishPermissionDenied,
  parsePrincipalKey,
  resolveAuthProvider,
  effectiveDeliveryClass,
  effectiveReplay,
  readChannelRegistry,
  channelBucket,
  AmbiguousPeerError,
  CotalEndpoint,
  type FlagSpec,
  type FlagValues,
  type Presence,
  type CompletionResult,
  type ParsedArgs,
} from "@cotal-ai/core";
import { CLI_USER_ACTOR, CommandFailure, connectOrThrow, endpointAuth, recordOperationSpace, jsonFlag, plainFlag, presentationOf, writeResult, resolveMeshTarget, targetFlags, userAuthStateDir, workspaceSecretStore, type Connection, type ConnectFlags, type OutputWarning } from "@cotal-ai/workspace";
import { completedFlagValue, completingFlagValue } from "../lib/completion.js";
import { batchedRead, openTransient } from "../lib/transient.js";
import { concreteChannelProblem } from "../lib/concrete-channel.js";
import { listDeclaredChannels, listDeclaredRoles } from "../lib/personas.js";
import { brokerStoreWrite } from "../lib/broker-store-health.js";
import { mentionsIn } from "../lib/mentions.js";
import { offlineRecipientNotice } from "../lib/offline-recipient.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { UnusableFile } from "../lib/unusable-file.js";

/**
 * One explicit --to, --channel or --role chooses the native delivery mode. The command
 * publishes one body and exits; a stored message is not proof of delivery or completion.
 */

export const sendFlags = [
  ...targetFlags, jsonFlag, plainFlag,
  { name: "to", short: "t", type: "string", value: "<agent>", description: "send directly to one agent" },
  { name: "channel", short: "c", type: "string", value: "<channel>", description: "publish to one channel" },
  { name: "role", short: "r", type: "string", value: "<role>", description: "queue for one agent with this role" },
  { name: "file", short: "f", type: "string", value: "<path>", description: "read the message body from this UTF-8 file (- reads stdin), instead of a positional body" },
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
  // A remedy reruns the destination the caller gave.
  const flag = destination.mode === "msg" ? "-c" : destination.mode === "ask" ? "-r" : "-t";
  if (!destination.target.trim()) {
    const [option, what] = destination.mode === "msg" ? ["--channel/-c", "channel"] : destination.mode === "ask" ? ["--role/-r", "role"] : ["--to/-t", "agent"];
    throw new CommandFailure("refused", "USAGE_INVALID", `${option} is empty; name one ${what === "agent" ? "agent or full instance id" : what}`, { remedy: `run cotal send ${flag} <${what}> "<message>"` });
  }
  const again = (body: string) => `run cotal send ${flag} ${shellWord(destination.target)} ${body}`;
  if (args.positionals.length > 1 || bodies !== 1 || values.file === "")
    throw new CommandFailure("refused", "USAGE_INVALID", "choose exactly one body: a quoted message, --file/-f <path>, or --stdin", { remedy: again('"<message>"') });
  // Stdin is read only when asked for, so a lone `-` is refused rather than published.
  if (args.positionals[0] === "-")
    throw new CommandFailure("refused", "USAGE_INVALID", 'a lone "-" is not read as stdin; send stdin with --stdin or --file -', { remedy: again("--stdin") });
  if (args.positionals.length === 1 && !args.positionals[0]?.trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "the message is empty", { remedy: again('"<message>"') });
  // A channel or role name the subject rules refuse gets their reason, which names what is at fault.
  try {
    if (destination.mode === "msg") {
      const problem = concreteChannelProblem(destination.target);
      if (problem) throw new Error(problem);
    } else if (destination.mode === "ask") assertValidRole(destination.target);
    else if (/[\/\u0000-\u001f\u007f]/u.test(destination.target)) throw new Error("use an agent name or full instance id, not a roster label");
    // No participant can carry a name the endpoint refuses, so it is refused before the presence wait.
    // The lookup trims the name, and an instance id is not held to the name rule.
    else if (!parsePrincipalKey(destination.target)) assertValidName(destination.target.trim());
  } catch (error) {
    throw new CommandFailure("refused", "USAGE_INVALID", (error as Error).message);
  }
  if (values["reply-to"] !== undefined && (destination.mode !== "dm" || !values["reply-to"].trim() || /[\u0000-\u001f\u007f]/u.test(values["reply-to"])))
    throw new CommandFailure("refused", "USAGE_INVALID", "--reply-to takes a message identifier and requires --to");
  if (values.mention?.length && destination.mode !== "msg")
    throw new CommandFailure("refused", "UNSUPPORTED", "native mention hints belong to channel publications; they do not change a direct or role destination");
  if (values.mention?.some((name) => !name.replace(/^@/, "").trim() || /[\/\u0000-\u001f\u007f]/u.test(name)))
    throw new CommandFailure("refused", "USAGE_INVALID", "each --mention names one agent or full instance id");
  // `--file -` is stdin, as `persona create --from -` reads it.
  return { ...destination, source: values.file !== undefined ? (values.file === "-" ? "stdin" : "file") : values.stdin ? "stdin" : "argument", ...(args.positionals[0] === undefined ? {} : { text: args.positionals[0] }) };
}

/** NATS's default max_payload. A file or stdin body is read up to it, plus one byte, before
 *  connecting, so a usual message is checked with no dial. A longer one is read on only once the
 *  connected broker names its own limit, and never past one byte over that. */
const PREREAD_BYTES = 1024 * 1024;

/** An explicit body: the whole text, or an open input past the pre-read whose rest waits for the
 *  broker's limit. `size` is a regular file's length, known without reading it. */
type Body = { text: string } | { fd: number; file?: string; head: Buffer; size: number | null };

async function bodyOf(input: SendInput, values: Values): Promise<Body> {
  if (input.source === "argument") return { text: input.text! };
  if (input.source === "stdin" && process.stdin.isTTY)
    throw new CommandFailure("refused", "USAGE_INVALID", "pipe the message to --stdin, or use a quoted body or --file");
  const file = input.source === "file" ? values.file! : undefined;
  let fd: number | undefined;
  const head = Buffer.allocUnsafe(PREREAD_BYTES + 1);
  let held: number;
  let size: number | null;
  try {
    fd = file === undefined ? 0 : openSync(file, "r");
    const stat = fstatSync(fd);
    size = stat.isFile() ? stat.size : null;
    held = await fill(fd, head, 0);
  } catch (error) {
    if (file !== undefined && fd !== undefined) closeSync(fd);
    throw readFailure(error, file);
  }
  if (held > PREREAD_BYTES) return { fd, file, head, size };
  if (file !== undefined) closeSync(fd);
  return { text: decoded(head.subarray(0, held), file) };
}

/** Read the rest of a body past the pre-read, up to one byte over the broker's `limit` and no
 *  further. `over` refuses it: the regular file's size, or null when only the limit is known. */
async function bodyRest(body: Body, limit: number): Promise<{ text: string } | { over: number | null }> {
  if ("text" in body) return body;
  try {
    if (body.size !== null && body.size > limit) return { over: body.size };
    let bytes = body.head;
    let held = bytes.length;
    if (held <= limit) {
      bytes = Buffer.allocUnsafe(limit + 1);
      body.head.copy(bytes);
      try { held = await fill(body.fd, bytes, held); }
      catch (error) { throw readFailure(error, body.file); }
    }
    return held > limit ? { over: null } : { text: decoded(bytes.subarray(0, held), body.file) };
  } finally {
    if (body.file !== undefined) closeSync(body.fd);
  }
}

const readInto = promisify(read);

/** Read `fd` into `bytes` from `at` until it is full or the input ends; returns how many it holds.
 *  The reads are asynchronous, so a slow writer never stalls a connection that is already open.
 *  Loading `node:process` opens a piped stdin as a nonblocking stream, so a read that finds the
 *  pipe empty fails with EAGAIN; it waits a moment and reads again. */
async function fill(fd: number, bytes: Buffer, at: number): Promise<number> {
  while (at < bytes.length) {
    let bytesRead: number;
    try { ({ bytesRead } = await readInto(fd, bytes, at, bytes.length - at, null)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      await delay(10);
      continue;
    }
    if (bytesRead === 0) break;
    at += bytesRead;
  }
  return at;
}

function readFailure(error: unknown, file: string | undefined): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (file === undefined) return new CommandFailure("refused", "USAGE_INVALID", "the message on stdin could not be read");
  if (code === "EACCES" || code === "EPERM" || code === "ENOENT")
    return new CommandFailure("refused", code === "ENOENT" ? "TARGET_NOT_FOUND" : "PERMISSION_DENIED", `the message file ${JSON.stringify(file)} could not be read`, { target: { file } });
  return new UnusableFile(`the message file ${JSON.stringify(file)} ${code === "EISDIR" ? "is a directory; --file reads one file" : `could not be read (${code ?? "no error code"})`}`, file);
}

function decoded(bytes: Buffer, file: string | undefined): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch {
    if (file !== undefined) throw new UnusableFile(`the message file ${JSON.stringify(file)} is not valid UTF-8`, file);
    throw new CommandFailure("refused", "USAGE_INVALID", "the message input is not valid UTF-8");
  }
  if (!text.trim()) throw new CommandFailure("refused", "USAGE_INVALID", "the explicit message input is empty");
  return text;
}

/** A shared name's remedy names the full identities that carry it. A mention travels as the name, so
 *  only a direct send can reach one of them. */
function sharedNameRemedy(use: "to" | "mention", identities: readonly string[]): string {
  return use === "to"
    ? `send to one full identity instead: ${identities.join(", ")}`
    : `a mention carries the name, so it cannot single one of them out; send to one with --to <full identity> instead: ${identities.join(", ")}`;
}

/** A full identity with what tells it apart from another of the same name: its kind and, when its
 *  presence reports one, the local time its process started. */
function identityLabel(id: string, p: Presence | undefined): string {
  if (!p) return id;
  const kind = p.card.meta?.sessionKind === "chat" ? "chat session" : p.card.kind ?? "endpoint";
  return `${id} (${kind}${p.runtime ? `, started ${new Date(p.runtime.startedAt).toLocaleTimeString()}` : ""})`;
}

async function directPeer(ep: Awaited<ReturnType<typeof openTransient>>["ep"], space: string, name: string, use: "to" | "mention"): Promise<Presence> {
  // Presence arrives asynchronously. Never turn a partial name into a fuzzy target.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const peer = resolvePeer(ep.getRoster(), name);
      if (peer) return peer;
    } catch (error) {
      if (!(error instanceof AmbiguousPeerError)) throw error;
      const roster = ep.getRoster();
      throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "several participants have this name", { target: { space, name, candidates: error.candidates }, remedy: sharedNameRemedy(use, error.candidates.map((candidate) => identityLabel(candidate.id, roster.find((p) => p.card.id === candidate.id)))) });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no matching participant was found in the authorized presence view", { target: { space, name }, remedy: `list the participants with cotal who --all --space ${space}, then use one name or full identity` });
}

/** How long a role send waits for the presence snapshot before it says nothing about holders. */
const ROSTER_MS = 2_000;

/** A role send is stored whether or not anyone holds the role, so a mistyped role used to pass with
 *  no word. Warn when no present participant holds it, naming the closest role one does hold, or the
 *  roles present when none is close. A roster that is not current proves nothing, so it says nothing. */
async function unheldRole(ep: Awaited<ReturnType<typeof openTransient>>["ep"], role: string, target: { space: string }): Promise<OutputWarning | undefined> {
  await ep.waitForPresenceSnapshot(ROSTER_MS);
  if (ep.presenceView().state !== "current") return undefined;
  const held = [...new Set(ep.getRoster().flatMap((p) => p.status !== "offline" && p.card.role ? [p.card.role] : []))].sort();
  if (held.includes(role)) return undefined;
  const nearest = closestRole(role, held);
  const hint = nearest !== undefined ? `Did you mean ${nearest}? It is the closest role a present participant holds.`
    : held.length ? `Present participants hold ${held.join(", ")}.` : "No participant is present.";
  return { code: "ROLE_NOT_HELD", target: { ...target, heldRoles: held, nearest: nearest ?? null }, message: `No present participant holds role ${role}; the message waits on that role's queue until one takes it. ${hint}` };
}

/** The held role within a third of `role`'s length in edits (at least one), the closest first. */
function closestRole(role: string, held: readonly string[]): string | undefined {
  const limit = Math.max(1, Math.floor(role.length / 3));
  let best: { name: string; edits: number } | undefined;
  for (const name of held) {
    const edits = editDistance(role.toLowerCase(), name.toLowerCase());
    if (edits <= limit && (best === undefined || edits < best.edits)) best = { name, edits };
  }
  return best?.name;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** nats.js refuses a frame over the broker's `max_payload` before writing any of it. */
function payloadRefused(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) if (e.name === "InvalidArgumentError" && e.message.includes("max_payload")) return true;
  return false;
}

/** The broker refused a channel publication, so it was not stored. The remedy names what this
 *  identity may post to: its grant when this machine holds it, read as `cotal whoami` reads it, and
 *  otherwise the space's registered channels. */
async function channelDenied(channel: string, target: { space: string }, connection: Connection, registered: readonly string[]): Promise<CommandFailure> {
  let post: string[] | undefined;
  if (connection.mode === "user" && connection.root) {
    try {
      const status = await resolveAuthProvider().userStatus({ store: workspaceSecretStore(connection.root), dir: userAuthStateDir(connection.root, connection.space), space: connection.space, actor: CLI_USER_ACTOR });
      post = status.grant === "not-granted" ? [] : status.grant?.allowPublish;
    } catch { /* the grant stays unknown */ }
  }
  const list = (channels: readonly string[]) => channels.map((name) => `#${name}`).join(", ");
  const remedy = post === undefined
    ? `this machine cannot read this identity's post grant${registered.length ? `; the channels registered in ${target.space} are ${list(registered)}` : ""}`
    : post.length ? `post to a channel this identity may post to: ${list(post)}` : `this identity may post to no channel in ${target.space}`;
  return new CommandFailure("refused", "PERMISSION_DENIED", `#${channel} does not exist in ${target.space} or this identity may not post to it; the broker refused the message, so it was not stored`, { target: { ...target, post: post ?? null }, remedy });
}

/** The warning for a post to a channel with no registry entry. Whether the channel already holds
 *  retained messages tells a new channel, often a typo, from one in use, so it is read before the
 *  post. When that read is not possible here, the warning says it did not check. */
async function unregisteredChannel(values: Values, channel: string, target: object, registered: readonly string[]): Promise<OutputWarning> {
  const earlier = await earlierMessages(values, channel);
  const names = [...registered].sort();
  const known = names.length ? `Registered channels: ${names.map((name) => `#${name}`).join(", ")}.` : "This space registers no channels.";
  const said = earlier === false ? `#${channel} has no channel metadata and no earlier message, so this message starts it. Check the name if you meant another channel.`
    : earlier ? `Unregistered channel: #${channel} already has messages; publication uses the native space policy and does not create channel metadata.`
    : "Unregistered channel: publication uses the native space policy and does not create channel metadata. Whether it has earlier messages was not checked.";
  return { code: "CHANNEL_UNREGISTERED", target: { ...target, earlierMessages: earlier, registered: names }, message: `${said} ${known}` };
}

/** Whether a channel holds retained messages, read as `cotal history` lists channels: through a
 *  short-lived observer endpoint, because the sender's operator credential reads no channel. Null
 *  when that read is not possible here. `channel remove` asks the same before it removes a name. */
export async function earlierMessages(values: ConnectFlags, channel: string): Promise<boolean | null> {
  let reader: CotalEndpoint | undefined;
  try {
    const conn = await connectOrThrow(values, "observer");
    reader = new CotalEndpoint({
      space: conn.space, servers: conn.server, ...endpointAuth(conn), ...(conn.mode === "user" ? { lifecycleUid: conn.epCaller?.uid } : {}),
      channels: [], consume: false, registerPresence: false, watchPresence: false, card: { name: "send", kind: "endpoint" },
    });
    reader.on("error", () => {});
    await reader.start();
    return (await reader.listChannels()).some((row) => row.channel === channel && row.messages > 0);
  } catch {
    return null;
  } finally {
    await reader?.stop().catch(() => {});
  }
}

/** Read the explicit body once, send once, close the transient sender, then print one receipt. */
export async function send(args: ParsedArgs): Promise<void> {
  const input = sendArguments(args);
  const values = args.values as Values;
  const presentation = presentationOf(values);
  const body = await bodyOf(input, values);
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
  // The envelope only adds to the body. A body under the limit can still make a frame over it,
  // which the client refuses before writing any of it.
  const tooLarge = (bytes: number | null) => new CommandFailure("refused", "UNSUPPORTED", bytes === null
    ? `the message is longer than this broker's ${ep.maxPayload}-byte message limit; nothing was sent`
    : `the message is ${bytes} bytes, and with its envelope it exceeds this broker's ${ep.maxPayload}-byte message limit; nothing was sent`, { target, remedy: "shorten the message, or split it across several sends" });
  try {
    const rest = await bodyRest(body, ep.maxPayload);
    if ("over" in rest) throw tooLarge(rest.over);
    const { text } = rest;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > ep.maxPayload) throw tooLarge(bytes);
    let policy: NonNullable<typeof receipt>["channelPolicy"] = null;
    let registered: string[] = [];
    if (input.mode === "msg") {
      try {
        // One Direct Get where the credential may, as the transient endpoint reads: the default scan's
        // consumer outlives the send by five minutes (#4091). A user bearer, or a credential with no
        // Direct Get row, keeps the scan.
        const registry = await readChannelRegistry({ servers: connection.server, space, ...(connection.bearer ? { bearer: connection.bearer, sentinelCreds: connection.sentinelCreds } : { creds: connection.creds }), directGet: batchedRead(connection, channelBucket(space)) });
        registered = Object.keys(registry.channels ?? {});
        const config = Object.hasOwn(registry.channels ?? {}, input.target) ? registry.channels![input.target] : undefined;
        policy = { registered: config !== undefined, replay: effectiveReplay(config, registry.defaults), window: config?.replayWindow ?? registry.defaults?.replayWindow ?? null, delivery: effectiveDeliveryClass(config, registry.defaults) };
        if (!policy.registered) warnings.push(await unregisteredChannel(values, input.target, target, registered));
      } catch {
        warnings.push({ code: "CHANNEL_METADATA_NOT_CHECKED", target, message: "Channel metadata could not be read. Only the native publish result establishes whether the post was accepted for storage." });
      }
    }
    const mentions = input.mode === "msg" ? [...mentionsIn(text)] : [];
    for (const name of values.mention ?? []) {
      // A mention travels as the peer's name (SPEC §5), the value a receiver compares with its own.
      // An instance id is accepted only when its name resolves back to that same peer.
      const peer = await directPeer(ep, space, name.replace(/^@/, ""), "mention");
      let named: Presence | undefined;
      try { named = resolvePeer(ep.getRoster(), peer.card.name); } catch { named = undefined; }
      if (named?.card.id !== peer.card.id)
        throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "a mention carries the agent's name, and this name does not name only that participant", { target: { space, name: peer.card.name }, remedy: `send to that participant with cotal send -t ${peer.card.id} instead` });
      mentions.push(peer.card.name);
    }
    const peer = input.mode === "dm" ? await directPeer(ep, space, input.target, "to") : undefined;
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
        const unheld = await unheldRole(ep, input.target, target);
        if (unheld) warnings.push(unheld);
      } else messageId = (await ep.multicast(text, { channel: input.target, mentions })).id;
    } catch (error) {
      if (payloadRefused(error)) throw tooLarge(bytes);
      if (input.mode === "msg" && isPublishPermissionDenied(error)) throw await channelDenied(input.target, target, connection, registered);
      // A broker sends nothing back for a stream it cannot write, so its own log here may name why.
      const store = connection.root ? brokerStoreWrite(connection.root, space) : undefined;
      if (store?.state === "write-failed")
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `No storage acknowledgement was established, and the broker logged a store write failure at ${store.at}: ${store.cause}${store.path ? ` (${store.path})` : ""}. The message was probably not stored; it was not retried.`, { target, remedy: `Free space on the disk that holds ${store.path ?? "the broker's store"}, then restart the broker with cotal down and cotal up before sending again.` });
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
  if (flag?.name === "file") return { items: [], directive: "default" };
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

/**
 * `cotal chat [channel]`: one live session under its own admitted identity, in the terminal view,
 * `--plain` lines, or the `--stdio` NDJSON protocol. The mesh is resolved once, and the session is
 * admitted by that target's recorded auth mode only. Leaving ends the session; nothing outlives it.
 */
import { randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import {
  assertValidChannel, isConcreteChannel, oneLine, readChannelRegistry, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs,
} from "@cotal-ai/core";
import {
  CommandFailure, connectTargetOrThrow, credsFlag, isConnectRefusal, loadMeshes, plainFlag, preflightOrThrow, resolveTargetOrThrow, serverFlag, spaceFlag,
  type MeshTarget,
} from "@cotal-ai/workspace";
import { completingFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { listDeclaredChannels } from "../lib/personas.js";
import { declaredFrom } from "./send.js";
import { loadChatFrontEnd, selectFrontEnd, type FrontEnd } from "../chat/frontend.js";
import { openRoutingChatSession } from "../chat/open-session.js";
import { openStaticChatSession } from "../chat/static-session.js";
import { openUserChatSession } from "../chat/user-session.js";
import { closeSummary, type Recipient } from "../chat/view.js";
import type { AdmittedChatSession, CloseReport } from "../chat/session.js";

export const chatFlags = [
  spaceFlag, serverFlag, { ...credsFlag, description: "an explicit credential file (not available for chat yet)" }, plainFlag,
  { name: "stdio", type: "boolean", description: "exchange the NDJSON participant protocol on stdin and stdout instead of the terminal view" },
  { name: "name", type: "string", value: "<n>", description: "the session's display label (default: <login>@<host> and a short suffix)" },
  { name: "role", type: "string", value: "<r>", description: "a presence role (not available for chat yet)" },
  { name: "kind", type: "string", value: "<k>", description: "the session's presence kind; only endpoint, the default, is accepted" },
  { name: "link", type: "string", value: "<url>", description: "the space and auth from a join link (not available for chat yet)" },
  { name: "token", type: "string", value: "<t>", description: "the space and auth from a join token (not available for chat yet)" },
  { name: "lifecycle-uid", type: "string", value: "<uid>", description: "the lifecycle UID paired with --creds (not available for chat yet)" },
] as const satisfies readonly FlagSpec[];

type Values = FlagValues<typeof chatFlags>;

/** Declared flags no admission supports yet, each with the reason it refuses. */
const NOT_YET: readonly (readonly [keyof Values & string, string])[] = [
  ["role", "a role puts the session on that role's work queue, the chat view cannot yet answer a task's sender, and the static and user-mode admissions take no role"],
  ["link", "no admission opens a chat session from a join link; select the space with --space or cotal use"],
  ["token", "no admission opens a chat session from a join token; select the space with --space or cotal use"],
  ["creds", "a chat session gets its own identity from the space, and no admission accepts an explicit credential"],
  ["lifecycle-uid", "it pairs with --creds, which no chat admission accepts"],
];

/** A user-mode session asks for the auth service's whole lifetime cap, 8 hours, which it never
 *  extends. Each bearer within it still lasts at most 15 minutes. */
export const USER_CHAT_TTL_SEC = 8 * 60 * 60;

export interface ChatInput {
  readonly channel?: string;
  readonly label?: string;
  readonly frontEnd: FrontEnd;
}

/** Check the grammar and choose the front end, before any target, connector or connection. */
export function chatArguments(args: ParsedArgs): ChatInput {
  const values = args.values as Values;
  if (args.positionals.length > 1) throw new CommandFailure("refused", "USAGE_INVALID", "chat takes at most one channel", { remedy: "run cotal chat [<channel>]" });
  const raw = args.positionals[0];
  const channel = raw?.replace(/^#/, "");
  if (channel !== undefined) {
    try {
      assertValidChannel(channel);
      if (!isConcreteChannel(channel)) throw new Error("wildcard");
    } catch {
      throw new CommandFailure("refused", "USAGE_INVALID", "name one concrete channel, without wildcards");
    }
  }
  if (values.name !== undefined && (!values.name.trim() || values.name.length > 128 || /[\u0000-\u001f\u007f]/u.test(values.name)))
    throw new CommandFailure("refused", "USAGE_INVALID", "--name takes a label of 1 to 128 characters without control characters");
  // Every admission presents the session as an endpoint, so `--kind endpoint` changes nothing.
  if (values.kind !== undefined && values.kind !== "endpoint")
    throw new CommandFailure("refused", "USAGE_INVALID",
      values.kind === "agent" ? "--kind agent is refused because a chat session never presents as an agent" : "--kind accepts only endpoint",
      { remedy: "run cotal chat without --kind" });
  for (const [flag, reason] of NOT_YET)
    if (values[flag] !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", `--${flag} is not available for chat yet: ${reason}`, { remedy: `run cotal chat without --${flag}` });
  const picked = selectFrontEnd({ stdio: values.stdio, plain: values.plain });
  if (!picked.ok) throw new CommandFailure("refused", "USAGE_INVALID", picked.message);
  return { ...(channel === undefined ? {} : { channel }), ...(values.name === undefined ? {} : { label: values.name }), frontEnd: picked.frontEnd };
}

/** What one admission asks for, by the target's recorded mode. A named channel is the session's
 *  initial channel, read ceiling and post list. Without one, an authenticated session starts on no
 *  channel and can neither join nor post to one; an open session routes anywhere. */
export type ChatAdmission =
  | { readonly mode: "open"; readonly label: string; readonly channels: readonly string[] }
  | { readonly mode: "auth"; readonly label: string; readonly subscribe: readonly string[]; readonly allowPublish: readonly string[] }
  | { readonly mode: "user"; readonly label: string; readonly channels: readonly string[]; readonly read: readonly string[]; readonly post: readonly string[]; readonly ttlSec: number };

export function chatAdmission(mode: MeshTarget["mode"], label: string, channel: string | undefined): ChatAdmission {
  const channels = channel === undefined ? [] : [channel];
  if (mode === "open") return { mode, label, channels };
  if (mode === "auth") return { mode, label, subscribe: channels, allowPublish: channels };
  if (mode === "user") return { mode, label, channels, read: channels, post: channels, ttlSec: USER_CHAT_TTL_SEC };
  throw new CommandFailure("refused", "UNSUPPORTED", `chat has no admission for a mesh recorded in "${String(mode)}" mode; no other mode was tried`);
}

/** Admit through the one adapter the mode names. Each adapter refuses a target of another mode. */
function admit(target: MeshTarget, admission: ChatAdmission): Promise<AdmittedChatSession> {
  switch (admission.mode) {
    case "open": return openRoutingChatSession(target, admission);
    case "auth": return openStaticChatSession(target, admission);
    case "user": return openUserChatSession(target, admission);
  }
}

/** The exit code of a session that ended by leaving, end of input or expiry. Only a confirmed
 *  close is 0. Retirement asked for and not confirmed is 4. An unknown outcome, an unconfirmed
 *  connection close, or no close report is 3. */
export function closeExitCode(close: CloseReport | undefined): number {
  if (!close || close.retirement === "unknown" || close.connectionClosed !== "confirmed") return 3;
  return close.retirement === "requested" ? 4 : 0;
}

/** `<login>@<host>-<4 hex>`: readable, and distinct between two windows on one machine. A label is
 *  display only; the admitted principal is the session's authority. */
function defaultLabel(): string {
  let login = "";
  let host = "";
  try {
    login = userInfo().username.trim();
    host = hostname().trim();
  } catch { /* refused below */ }
  const label = `${login}@${host}-${randomBytes(2).toString("hex")}`;
  if (!login || !host || label.length > 128 || /[/\\\u0000-\u001f\u007f]/u.test(label))
    throw new CommandFailure("refused", "USAGE_INVALID", "chat cannot derive a label from the OS login and host", { remedy: "pass --name <n>" });
  return label;
}

/** The exit status each terminating signal sets. */
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

/** Hold SIGINT, SIGTERM and SIGHUP until a front end has installed its own handling, so no signal
 *  kills the process while a session is being admitted or is admitted. The first signal is kept and
 *  later ones are absorbed. */
export function holdSignals(): { readonly caught: () => number | undefined; readonly release: () => void } {
  let caught: number | undefined;
  const held = (Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[]).map((sig) => {
    const handler = (): void => { caught ??= SIGNAL_EXIT[sig]; };
    process.on(sig, handler);
    return () => { process.off(sig, handler); };
  });
  return { caught: () => caught, release: () => { for (const off of held) off(); } };
}

/** The line that discloses a named channel before admission. `registered` is undefined when the
 *  registry could not be read. */
export function channelDisclosure(channel: string, registered: boolean | undefined): string {
  if (registered === undefined) return `the registration of #${channel} could not be read; only the space's native policy decides whether a send is accepted`;
  return registered ? `#${channel} is a registered channel` : `Unregistered channel #${channel}: sends follow the space's native policy, and nothing creates its registration`;
}

/** Read whether `channel` is registered, on the resolved target, through the one-shot `operator`
 *  connection and the registry read `cotal send` uses. The connection is also the reachability
 *  check. Nothing is written, and a read the broker refuses is disclosed as not read. */
async function discloseChannel(target: MeshTarget, channel: string): Promise<string> {
  const connection = await connectTargetOrThrow(target, "operator");
  try {
    const registry = await readChannelRegistry({ servers: connection.server, space: target.space, ...(connection.bearer ? { bearer: connection.bearer, sentinelCreds: connection.sentinelCreds } : { creds: connection.creds }) });
    return channelDisclosure(channel, Object.hasOwn(registry.channels ?? {}, channel));
  } catch {
    return channelDisclosure(channel, undefined);
  }
}

/** Resolve the recorded mesh `--space`/`--server` select, once. Disclose the named channel, or
 *  check the target reachable when none is named. */
async function prepareChat(values: Values, channel: string | undefined): Promise<{ target: MeshTarget; notice?: string }> {
  try {
    const target = await resolveTargetOrThrow({ space: values.space, server: values.server });
    if (channel !== undefined) return { target, notice: await discloseChannel(target, channel) };
    await preflightOrThrow(target);
    return { target };
  } catch (e) {
    if (isConnectRefusal(e)) throw e.failure();
    throw e;
  }
}

export async function chat(args: ParsedArgs): Promise<void> {
  const input = chatArguments(args);
  const start = await loadChatFrontEnd(input.frontEnd);
  const signals = holdSignals();
  let target: MeshTarget;
  let notice: string | undefined;
  let session: AdmittedChatSession;
  try {
    ({ target, notice } = await prepareChat(args.values as Values, input.channel));
    if (notice) process.stderr.write(`cotal chat: ${notice}\n`);
    const before = signals.caught();
    if (before !== undefined) {
      signals.release();
      process.stderr.write("cotal chat: interrupted before admission; no session was opened\n");
      process.exitCode = before;
      return;
    }
    session = await admit(target, chatAdmission(target.mode, input.label ?? defaultLabel(), input.channel));
  } catch (e) {
    signals.release();
    throw e;
  }
  const during = signals.caught();
  if (during !== undefined) {
    // Interrupted while admitting: close what was admitted before a front end starts.
    const ended = await session.close().catch(() => undefined);
    signals.release();
    process.stderr.write(`cotal chat: interrupted during admission; ${ended ? oneLine(closeSummary(session.identity(), ended)) : "the session's close was not observed"}\n`);
    process.exitCode = during;
    return;
  }
  const initialRecipient: Recipient | undefined = input.channel === undefined ? undefined : { kind: "channel", channel: input.channel };
  let close: CloseReport | undefined;
  try {
    // The front end installs its signal handling before it first yields, so releasing here leaves no gap.
    const running = start({ session, initialRecipient, notice });
    signals.release();
    close = await running;
  } catch (e) {
    // A front end that threw still ends the session it was given. Closing is idempotent.
    const held = holdSignals();
    signals.release();
    const ended = await session.close().catch(() => undefined);
    held.release();
    const confirmed = closeExitCode(ended) === 0;
    throw new CommandFailure(confirmed ? "failed" : "unknown", confirmed ? "OPERATION_FAILED" : "OPERATION_UNKNOWN",
      `the chat front end stopped with an error (${e instanceof Error ? e.message : String(e)}); ${ended ? ended.message : "the session's close was not observed"}`,
      { target: { space: target.space, principal: session.identity().principal }, native: { detail: { close: ended ?? null } } });
  }
  // The terminal view leaves its screen with nothing on it; `--plain` and `--stdio` report their own end.
  if (input.frontEnd === "tui" && close) console.log(oneLine(closeSummary(session.identity(), close)));
  // A signal the front end handled already set 129, 130 or 143.
  process.exitCode ??= closeExitCode(close);
}

/** Complete `--space` from the registry and the channel from the target mesh's persona catalog,
 *  offline. Other values have nothing to offer. */
export function chatComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, chatFlags);
  if (flag?.name === "space") return { items: loadMeshes().map((mesh) => ({ value: mesh.space })), directive: "nofiles" };
  if (!flag && positionalsForCompletion(argv, chatFlags).length === 1)
    return { items: declaredFrom(argv, listDeclaredChannels).map((value) => ({ value })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

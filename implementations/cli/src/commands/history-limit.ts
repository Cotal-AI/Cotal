import * as prompts from "../lib/prompts.js";
import {
  ChatHistoryChanged, ChatHistoryUpdateUnknown, chatHistoryLimitOf, chatHistoryLimitProblem, chatStream, describeChatHistory, dialerFor, formatChatAge,
  isPrincipalOwnerToken, isPublishPermissionDenied, isStreamNotFound, mintCreds, newIdentity, parseDuration, parseSubject, requireBrokerFloor, setChatHistoryLimit, standaloneConnectOpts, validateCanonicalBackupStreamConfig,
  type ChatHistoryLimit,
} from "@cotal-ai/core";
import { JetStreamApiError, jetstreamManager, type StreamInfo } from "@nats-io/jetstream";
import { ConfirmationRequired, CommandFailure, authDir, brokerAddressForDisplay, getSpaceAuth, oneLine, presentationOf, recordOperationSpace, resolveMeshTarget, workspaceSecretStore, writeResult, type Report } from "@cotal-ai/workspace";
import { canPrompt } from "./meshes-wizard.js";
import { yesRequired } from "../lib/confirmation-required.js";
import { noticeOnInterrupt } from "../lib/interrupt-notice.js";

interface Values { space?: string; "max-age"?: string; "per-sender"?: string; yes?: boolean; json?: boolean; plain?: boolean }

/** What the posts a lower limit removes looked like when the stream was read. */
interface LoweringSnapshot {
  readAt: string;
  /** Per sender on a channel, the posts past the new count. Empty when the count does not drop. */
  overCount: { channel: string; sender: string; dropped: number }[];
  /** The age a lower limit removes posts older than, or null when the age does not drop. */
  olderThan: string | null;
  /** When the oldest retained post was stored, or null when the stream holds none. */
  oldestPostAt: string | null;
}

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);
const brokerLabel = (server: string): string => brokerAddressForDisplay(server) ?? "selected broker (address unavailable)";

/** The requested parts of the limit, refused as usage before any connection. */
export function historyLimitRequest(values: Values): Partial<ChatHistoryLimit> {
  if (values["max-age"] === undefined && values["per-sender"] === undefined) throw usage("history limit needs --max-age, --per-sender or both");
  const request: Partial<ChatHistoryLimit> = {};
  if (values["max-age"] !== undefined) {
    try { request.maxAgeMs = parseDuration(values["max-age"]); }
    catch { throw usage(`--max-age takes an age such as 30d, 12h or 90m, not "${values["max-age"]}"`); }
  }
  if (values["per-sender"] !== undefined) {
    if (!/^\d+$/.test(values["per-sender"])) throw usage(`--per-sender takes a whole number of at least 1, not "${values["per-sender"]}"`);
    request.perSender = Number(values["per-sender"]);
  }
  // Each given part is checked against a valid other half, so its own problem is the one named.
  const problem = chatHistoryLimitProblem({ maxAgeMs: request.maxAgeMs ?? 86_400_000, perSender: request.perSender ?? 1 });
  if (problem) throw usage(`history limit: ${problem}`);
  return request;
}

function lowering(from: ChatHistoryLimit, to: ChatHistoryLimit, info: StreamInfo, readAt: Date): LoweringSnapshot | undefined {
  const ageDrops = from.maxAgeMs === 0 || to.maxAgeMs < from.maxAgeMs;
  const countDrops = to.perSender < from.perSender;
  if (!ageDrops && !countDrops) return undefined;
  const overCount: LoweringSnapshot["overCount"] = [];
  if (countDrops) for (const [subject, count] of Object.entries(info.state.subjects ?? {})) {
    const p = parseSubject(subject);
    if (count > to.perSender && p?.kind === "chat" && isPrincipalOwnerToken(p.owner)) overCount.push({ channel: p.rest, sender: p.sender, dropped: count - to.perSender });
  }
  overCount.sort((a, b) => a.channel.localeCompare(b.channel) || a.sender.localeCompare(b.sender));
  return { readAt: readAt.toISOString(), overCount, olderThan: ageDrops ? formatChatAge(to.maxAgeMs) : null, oldestPostAt: info.state.messages > 0 ? info.state.first_ts : null };
}

function loweringLines(snapshot: LoweringSnapshot): string[] {
  const dropped = snapshot.overCount.reduce((sum, row) => sum + row.dropped, 0);
  return [
    `As read at ${snapshot.readAt}:`,
    ...(snapshot.olderThan !== null ? [`  every post older than ${snapshot.olderThan} (the oldest retained post is from ${snapshot.oldestPostAt ?? "no time; the stream holds no posts"})`] : []),
    ...(snapshot.overCount.length ? [`  ${dropped} posts past the new per-sender count:`, ...snapshot.overCount.map((row) => `    #${row.channel}: ${row.dropped} from ${row.sender}`)] : []),
  ];
}

/** `cotal history limit`: set how long the space's chat stream keeps channel posts. The space root's
 *  signing material mints a one-shot provisioner, so this runs on the broker host, from the root. */
export async function historyLimit(values: Values): Promise<void> {
  const presentation = presentationOf(values);
  const request = historyLimitRequest(values);
  if (!values.yes && (!canPrompt() || presentation === "json")) throw new ConfirmationRequired(yesRequired("history limit", presentation === "json"), { remedy: "add --yes to set the limit without a prompt; a lower limit deletes the posts it no longer keeps" });
  const selected = resolveMeshTarget(process.cwd(), { ...(values.space ? { space: values.space } : {}) });
  const stream = chatStream(selected.space);
  const target = { space: selected.space, broker: brokerLabel(selected.server), stream };
  recordOperationSpace(selected.space);
  let provisioner: string | undefined;
  if (selected.mode !== "open") {
    const auth = await getSpaceAuth(workspaceSecretStore(selected.root), selected.space);
    if (!auth) throw new CommandFailure("refused", "PERMISSION_DENIED", `space ${selected.space} has no trust material under ${authDir(selected.root)}; nothing was changed`, { target, remedy: "run this on the broker host, from the space's root" });
    provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  }
  let nc;
  try {
    nc = await dialerFor(selected.server)({ servers: selected.server, ...standaloneConnectOpts({ creds: provisioner, tls: selected.tlsRequired === true }), maxReconnectAttempts: 0 });
  } catch (error) {
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the broker did not accept the connection (${(error as Error).message}); nothing was changed`, { target });
  }
  let release: (() => void) | undefined;
  try {
    requireBrokerFloor(nc);
    const jsm = await jetstreamManager(nc, { checkAPI: false });
    let info: StreamInfo;
    try {
      info = await jsm.streams.info(stream, { subjects_filter: ">" });
    } catch (error) {
      if (isStreamNotFound(error)) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `space ${selected.space} has no chat stream; nothing was changed`, { target, remedy: "start the space with `cotal up`, which creates it" });
      if (isPublishPermissionDenied(error)) throw new CommandFailure("refused", "PERMISSION_DENIED", "the provisioner was refused a read of the chat stream; nothing was changed", { target });
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the chat stream could not be read (${(error as Error).message}); nothing was changed`, { target });
    }
    const readAt = new Date();
    try { validateCanonicalBackupStreamConfig(selected.space, stream, info.config as unknown as Record<string, unknown>); }
    catch (error) { throw new CommandFailure("refused", "CONFLICT", `the chat stream has settings this command does not manage (${(error as Error).message}); nothing was changed`, { target }); }
    const from = chatHistoryLimitOf(info.config as unknown as Record<string, unknown>);
    if (from.maxAgeMs === 0 && request.maxAgeMs === undefined) throw usage(`the chat stream of ${selected.space} keeps posts with no age limit, which this command does not set; pass --max-age as well`);
    const to: ChatHistoryLimit = { maxAgeMs: request.maxAgeMs ?? from.maxAgeMs, perSender: request.perSender ?? from.perSender };
    const problem = chatHistoryLimitProblem(to);
    if (problem) throw usage(`history limit: ${problem}`);
    if (from.maxAgeMs === to.maxAgeMs && from.perSender === to.perSender) {
      writeResult(presentation, { command: "history", target, result: { kind: "history-limit", from, to, changed: false }, noOp: true }, (): Report => ({ sections: [{ title: "History limit unchanged", blocks: [{ kind: "fields", rows: [["Space", selected.space], ["Limit", describeChatHistory(to)]] }, { kind: "lines", lines: ["The chat stream already holds this limit. Nothing was written."] }] }] }));
      return;
    }
    const snapshot = lowering(from, to, info, readAt);
    if (!values.yes && snapshot) {
      for (const line of loweringLines(snapshot)) process.stderr.write(`${line}\n`);
      const answer = await prompts.confirm({ message: `Lower the chat history limit of ${oneLine(selected.space)} from ${describeChatHistory(from)} to ${describeChatHistory(to)}? The broker deletes these posts at once.`, initialValue: false });
      if (prompts.isCancel(answer) || !answer) {
        writeResult(presentation, { command: "history", target, result: { kind: "history-limit", from, to: from, changed: false, confirmed: false }, noOp: true }, (): Report => ({ sections: [{ title: "History limit kept", blocks: [{ kind: "lines", lines: [`The chat stream keeps ${describeChatHistory(from)}. Nothing was written.`] }] }] }));
        return;
      }
    }
    release = noticeOnInterrupt(() => "Interrupted while the history limit update ran; it may or may not have taken effect. `cotal history` shows the limit the stream holds.");
    let change;
    try {
      change = await setChatHistoryLimit(jsm, selected.space, to, from);
    } catch (error) {
      if (error instanceof ChatHistoryChanged) throw new CommandFailure("refused", "CONFLICT", `${error.message}; nothing was changed`, { target, remedy: "run the command again to act on the limit the stream holds now" });
      if (error instanceof ChatHistoryUpdateUnknown) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `${error.message}; it was not retried`, { target, native: { outcome: "unknown" }, remedy: "read the limit with `cotal history` before another change; an unknown result does not mean nothing changed" });
      if (isPublishPermissionDenied(error)) throw new CommandFailure("refused", "PERMISSION_DENIED", "the broker refused the history limit update; nothing was changed", { target });
      if (error instanceof JetStreamApiError) throw new CommandFailure("refused", "CONFLICT", `the broker refused the history limit update (${error.message}); nothing was changed`, { target });
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the chat stream could not be read again before the update (${(error as Error).message}); nothing was changed`, { target });
    }
    const lines = [
      `The broker now deletes posts older than ${formatChatAge(to.maxAgeMs)}, and each sender's oldest posts on a channel past ${to.perSender}.`,
      "Posts it deleted under an earlier limit do not come back.",
    ];
    writeResult(presentation, { command: "history", target, result: { kind: "history-limit", from: change?.from ?? from, to, changed: change !== undefined, ...(snapshot ? { lowered: snapshot } : {}) } }, (): Report => ({ sections: [{ title: "History limit changed", blocks: [{ kind: "fields", rows: [["Space", selected.space], ["Broker", target.broker], ["Before", describeChatHistory(from)], ["Now", describeChatHistory(to)]] }, { kind: "lines", lines }] }] }));
  } finally {
    release?.();
    await nc.close();
  }
}

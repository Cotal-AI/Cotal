import * as prompts from "../lib/prompts.js";
import {
  HISTORY_NO_COUNT, HistoryLimitChanged, HistoryLimitUpdateUnknown, describeHistoryLimit, dialerFor, dlvDurable, formatChatAge, historyLimitOf, historyLimitProblem,
  historyLimitStreamName, isPrincipalOwnerToken, isPublishPermissionDenied, isStreamNotFound, mintCreds, newIdentity, parseDinboxPrincipal, parseDuration, parseSubject, requireBrokerFloor,
  setHistoryLimit, standaloneConnectOpts, validateCanonicalBackupStreamConfig,
  type HistoryLimit, type HistoryLimitStream,
} from "@cotal-ai/core";
import { JetStreamApiError, jetstreamManager, type JetStreamManager, type StreamInfo } from "@nats-io/jetstream";
import { ConfirmationRequired, CommandFailure, authDir, brokerAddressForDisplay, getSpaceAuth, oneLine, presentationOf, recordOperationSpace, resolveMeshTarget, workspaceSecretStore, writeResult, type Report } from "@cotal-ai/workspace";
import { canPrompt } from "./meshes-wizard.js";
import { yesRequired } from "../lib/confirmation-required.js";
import { noticeOnInterrupt } from "../lib/interrupt-notice.js";

interface Values {
  space?: string;
  "max-age"?: string; "per-sender"?: string;
  "inbox-max-age"?: string; "inbox-per-agent"?: string;
  "dm-max-age"?: string; "dm-per-sender"?: string;
  yes?: boolean; json?: boolean; plain?: boolean;
}

/** The flag pairs this command takes, and the streams each sets. One pair sets INBOX and DLV. */
const PAIRS = [
  { age: "max-age", count: "per-sender", streams: ["chat"] },
  { age: "inbox-max-age", count: "inbox-per-agent", streams: ["inbox", "dlv"] },
  { age: "dm-max-age", count: "dm-per-sender", streams: ["dm"] },
] as const;
/** Every limit flag, for the refusals that name them. */
export const HISTORY_LIMIT_FLAGS = PAIRS.flatMap((pair) => [pair.age, pair.count]);
/** The streams in the order a change writes them. */
const ORDER: readonly HistoryLimitStream[] = ["chat", "inbox", "dlv", "dm"];
const LABEL: Record<HistoryLimitStream, string> = { chat: "Channel posts", inbox: "Inbox", dlv: "Stored copies", dm: "DMs" };

/** A limit as the result shows it: null is no age or no count. */
interface LimitView { maxAgeMs: number | null; perSubject: number | null }
const view = (limit: HistoryLimit): LimitView => ({ maxAgeMs: limit.maxAgeMs === 0 ? null : limit.maxAgeMs, perSubject: limit.perSubject === HISTORY_NO_COUNT ? null : limit.perSubject });

/** What the entries a lower limit removes from one stream looked like when it was read. */
interface LoweringSnapshot {
  stream: string;
  readAt: string;
  /** Per subject, the entries past the new count. Empty when the count does not drop. */
  overCount: { subject: string; dropped: number; undelivered?: number | null }[];
  /** The age a lower limit removes entries older than, or null when the age does not drop. */
  olderThan: string | null;
  /** When the oldest retained entry was stored, or null when the stream holds none. */
  oldestAt: string | null;
}

type Outcome = "changed" | "unchanged" | "unknown" | "refused" | "not-attempted";

interface Row {
  kind: HistoryLimitStream;
  stream: string;
  info: StreamInfo;
  from: HistoryLimit;
  to: HistoryLimit;
  outcome?: Outcome;
}

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);
const brokerLabel = (server: string): string => brokerAddressForDisplay(server) ?? "selected broker (address unavailable)";

/** The requested parts of each stream's limit, refused as usage before any connection. Empty when no
 *  limit flag is given, which reads the limits instead. `none` is no age (0) or no count (-1). */
export function historyLimitRequest(values: Values): Map<HistoryLimitStream, Partial<HistoryLimit>> {
  const request = new Map<HistoryLimitStream, Partial<HistoryLimit>>();
  for (const pair of PAIRS) {
    const age = values[pair.age], count = values[pair.count];
    if (age === undefined && count === undefined) continue;
    const part: Partial<HistoryLimit> = {};
    if (age !== undefined) {
      if (age === "none") part.maxAgeMs = 0;
      else {
        try { part.maxAgeMs = parseDuration(age); }
        catch { throw usage(`--${pair.age} takes an age such as 30d, 12h or 90m, or none, not "${age}"`); }
      }
    }
    if (count !== undefined) {
      if (count === "none") part.perSubject = HISTORY_NO_COUNT;
      else if (/^\d+$/.test(count)) part.perSubject = Number(count);
      else throw usage(`--${pair.count} takes a whole number of at least 1, or none, not "${count}"`);
    }
    for (const stream of pair.streams) {
      // Each given part is checked with none for the other half, so its own problem is the one named.
      const ageProblem = part.maxAgeMs === undefined ? undefined : historyLimitProblem(stream, { maxAgeMs: part.maxAgeMs, perSubject: HISTORY_NO_COUNT });
      if (ageProblem) throw usage(`--${pair.age}: ${ageProblem}`);
      const countProblem = part.perSubject === undefined ? undefined : historyLimitProblem(stream, { maxAgeMs: 0, perSubject: part.perSubject });
      if (countProblem) throw usage(`--${pair.count}: ${countProblem}`);
      request.set(stream, part);
    }
  }
  return request;
}

const ageDrops = (from: HistoryLimit, to: HistoryLimit): boolean => to.maxAgeMs !== 0 && (from.maxAgeMs === 0 || to.maxAgeMs < from.maxAgeMs);
const countDrops = (from: HistoryLimit, to: HistoryLimit): boolean => to.perSubject !== HISTORY_NO_COUNT && (from.perSubject === HISTORY_NO_COUNT || to.perSubject < from.perSubject);

/** The lifecycle a dinbox or dlv subject is addressed to, or null. */
function lifecycleOf(subject: string, kind: "inbox" | "dlv"): { owner: string; actor: string; lifecycleUid: string } | null {
  if (kind === "inbox") return parseDinboxPrincipal(subject);
  const parts = subject.split(".");
  return parts.length === 6 && parts[2] === "dlv" ? { owner: parts[3]!, actor: parts[4]!, lifecycleUid: parts[5]! } : null;
}

/** Who one subject's entries belong to, as the preview names them. */
function subjectLabel(kind: HistoryLimitStream, subject: string): string | null {
  if (kind === "chat" || kind === "dm") {
    const p = parseSubject(subject);
    if (!p || !isPrincipalOwnerToken(p.owner)) return null;
    return kind === "chat" && p.kind === "chat" ? `#${p.rest} from ${p.sender}` : kind === "dm" && p.kind === "inst" ? `to ${p.rest} from ${p.sender}` : null;
  }
  const life = lifecycleOf(subject, kind);
  return life && `${life.owner}.${life.actor} (lifecycle ${life.lifecycleUid})`;
}

/** The DLV entries of one lifecycle its agent has not received or not acknowledged, from its own
 *  durable's info; null when that cannot be read. */
async function undeliveredOf(jsm: JetStreamManager, stream: string, subject: string): Promise<number | null> {
  const life = lifecycleOf(subject, "dlv");
  if (!life) return null;
  try {
    const info = await jsm.consumers.info(stream, dlvDurable(life.owner, life.actor, life.lifecycleUid));
    return info.num_pending + info.num_ack_pending;
  } catch { return null; }
}

async function lowering(jsm: JetStreamManager, row: Row, readAt: Date): Promise<LoweringSnapshot | undefined> {
  const age = ageDrops(row.from, row.to), count = countDrops(row.from, row.to);
  if (!age && !count) return undefined;
  const overCount: LoweringSnapshot["overCount"] = [];
  if (count) for (const [subject, held] of Object.entries(row.info.state.subjects ?? {})) {
    const label = subjectLabel(row.kind, subject);
    if (held <= row.to.perSubject || label === null) continue;
    const dropped = held - row.to.perSubject;
    // The agent's unacknowledged copies are its newest, so those among the oldest ones the count
    // removes are the ones past what the count keeps.
    const unacked = row.kind === "dlv" ? await undeliveredOf(jsm, row.stream, subject) : undefined;
    overCount.push({ subject: label, dropped, ...(unacked !== undefined ? { undelivered: unacked === null ? null : Math.min(dropped, Math.max(0, unacked - row.to.perSubject)) } : {}) });
  }
  overCount.sort((a, b) => a.subject.localeCompare(b.subject));
  return { stream: row.stream, readAt: readAt.toISOString(), overCount, olderThan: age ? formatChatAge(row.to.maxAgeMs) : null, oldestAt: row.info.state.messages > 0 ? row.info.state.first_ts : null };
}

const ENTRY: Record<HistoryLimitStream, string> = { chat: "post", inbox: "entry", dlv: "stored copy", dm: "DM" };
const ENTRIES: Record<HistoryLimitStream, string> = { chat: "posts", inbox: "entries", dlv: "stored copies", dm: "DMs" };

function loweringLines(row: Row, snapshot: LoweringSnapshot): string[] {
  const dropped = snapshot.overCount.reduce((sum, item) => sum + item.dropped, 0);
  const lost = {
    chat: [],
    inbox: ["  These may include entries the delivery daemon has not passed on to their agents yet."],
    dlv: ["  These may include copies their agents have not acknowledged yet."],
    dm: ["  These may include DMs their recipients have not read yet."],
  }[row.kind];
  return [
    `${LABEL[row.kind]} (${snapshot.stream}), as read at ${snapshot.readAt}:`,
    ...(snapshot.olderThan !== null ? [`  every ${ENTRY[row.kind]} older than ${snapshot.olderThan} (the oldest is from ${snapshot.oldestAt ?? "no time; the stream holds none"})`] : []),
    ...(snapshot.overCount.length ? [
      `  ${dropped} ${ENTRIES[row.kind]} past the new count:`,
      ...snapshot.overCount.map((item) => `    ${item.subject}: ${item.dropped}${item.undelivered === undefined ? "" : item.undelivered === null ? ", not acknowledged: unknown" : `, ${item.undelivered} not acknowledged`}`),
    ] : []),
    ...(snapshot.olderThan !== null || snapshot.overCount.length ? lost : []),
  ];
}

/** What a change left behind, named per stream, for a failure that changed some of them. */
function outcomeLines(rows: readonly Row[]): string {
  return rows.filter((row) => row.outcome !== "unchanged").map((row) => `${row.stream} ${row.outcome}`).join(", ");
}

const READ_REMEDY = "run `cotal history limit` with no limit flags to read the limits the streams hold";
const READ_HINT = "`cotal history limit` with no limit flags shows the limits the streams hold.";

/** `cotal history limit`: show or set how long the space keeps channel posts, the delivery daemon's
 *  inbox and stored copies, and DMs. The space root's signing material mints a one-shot provisioner,
 *  so this runs on the broker host, from the root. With no limit flag it only reads. */
export async function historyLimit(values: Values): Promise<void> {
  const presentation = presentationOf(values);
  const request = historyLimitRequest(values);
  const readOnly = request.size === 0;
  if (!readOnly && !values.yes && (!canPrompt() || presentation === "json")) throw new ConfirmationRequired(yesRequired("history limit", presentation === "json"), { remedy: "add --yes to set the limit without a prompt; a lower limit deletes the entries it no longer keeps" });
  const selected = resolveMeshTarget(process.cwd(), { ...(values.space ? { space: values.space } : {}) });
  const kinds = readOnly ? ORDER : ORDER.filter((kind) => request.has(kind));
  const target = { space: selected.space, broker: brokerLabel(selected.server), streams: kinds.map((kind) => historyLimitStreamName(selected.space, kind)) };
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
    // Every requested stream is read and checked before the first write, so a refusal on a later
    // stream never comes after an earlier one changed.
    const rows: Row[] = [];
    for (const kind of kinds) {
      const stream = historyLimitStreamName(selected.space, kind);
      const part = request.get(kind);
      let info: StreamInfo;
      try {
        // A subject listing only where a count may drop: it names every sender, agent or DM pair.
        info = await jsm.streams.info(stream, part?.perSubject !== undefined ? { subjects_filter: ">" } : undefined);
      } catch (error) {
        if (isStreamNotFound(error)) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `space ${selected.space} has no ${stream} stream; nothing was changed`, { target, remedy: "start the space with `cotal up`, which creates it" });
        if (isPublishPermissionDenied(error)) throw new CommandFailure("refused", "PERMISSION_DENIED", `the provisioner was refused a read of ${stream}; nothing was changed`, { target });
        throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `${stream} could not be read (${(error as Error).message}); nothing was changed`, { target });
      }
      try { validateCanonicalBackupStreamConfig(selected.space, stream, info.config as unknown as Record<string, unknown>); }
      catch (error) { throw new CommandFailure("refused", "CONFLICT", `${stream} has settings this command does not manage (${(error as Error).message}); nothing was changed`, { target }); }
      const from = historyLimitOf(info.config as unknown as Record<string, unknown>);
      rows.push({ kind, stream, info, from, to: { maxAgeMs: part?.maxAgeMs ?? from.maxAgeMs, perSubject: part?.perSubject ?? from.perSubject } });
    }
    const readAt = new Date();
    const limitRows = (rowsOf: readonly Row[], pick: (row: Row) => HistoryLimit): [string, string][] => rowsOf.map((row) => [LABEL[row.kind], describeHistoryLimit(row.kind, pick(row))]);
    if (readOnly) {
      writeResult(presentation, { command: "history", target, result: { kind: "history-limits", streams: rows.map((row) => ({ stream: row.stream, limit: row.kind, holds: view(row.from) })) } }, (): Report => ({ sections: [{ title: "History limits", blocks: [{ kind: "fields", rows: [["Space", selected.space], ...limitRows(rows, (row) => row.from)] }] }] }));
      return;
    }
    const resultOf = (changed: boolean, extra: Record<string, unknown> = {}) => ({ kind: "history-limit", changed, streams: rows.map((row) => ({ stream: row.stream, limit: row.kind, from: view(row.from), to: view(row.to), outcome: row.outcome ?? "unchanged" })), ...extra });
    const changing = rows.filter((row) => row.from.maxAgeMs !== row.to.maxAgeMs || row.from.perSubject !== row.to.perSubject);
    if (changing.length === 0) {
      writeResult(presentation, { command: "history", target, result: resultOf(false), noOp: true }, (): Report => ({ sections: [{ title: "History limits unchanged", blocks: [{ kind: "fields", rows: [["Space", selected.space], ...limitRows(rows, (row) => row.to)] }, { kind: "lines", lines: ["The streams already hold these limits. Nothing was written."] }] }] }));
      return;
    }
    const snapshots: LoweringSnapshot[] = [];
    for (const row of changing) {
      const snapshot = await lowering(jsm, row, readAt);
      if (snapshot) snapshots.push(snapshot);
    }
    if (!values.yes && snapshots.length) {
      if (snapshots.some((snapshot) => snapshot.stream !== historyLimitStreamName(selected.space, "chat")))
        process.stderr.write("As the space's operator you see every agent and DM pair these streams hold entries for.\n");
      for (const row of changing) {
        const snapshot = snapshots.find((item) => item.stream === row.stream);
        if (snapshot) for (const line of loweringLines(row, snapshot)) process.stderr.write(`${line}\n`);
      }
      const answer = await prompts.confirm({ message: `Change the history limits of ${oneLine(selected.space)}: ${changing.map((row) => `${row.stream} to ${describeHistoryLimit(row.kind, row.to)}`).join("; ")}? The broker deletes these entries at once.`, initialValue: false });
      if (prompts.isCancel(answer) || !answer) {
        for (const row of rows) row.to = row.from;
        writeResult(presentation, { command: "history", target, result: { ...resultOf(false), confirmed: false }, noOp: true }, (): Report => ({ sections: [{ title: "History limits kept", blocks: [{ kind: "fields", rows: [["Space", selected.space], ...limitRows(rows, (row) => row.from)] }, { kind: "lines", lines: ["Nothing was written."] }] }] }));
        return;
      }
    }
    release = noticeOnInterrupt(() => `Interrupted while the history limit updates ran; each may or may not have taken effect. ${READ_HINT}`);
    for (const row of rows) row.outcome = changing.includes(row) ? "not-attempted" : "unchanged";
    for (const row of changing) {
      try {
        const change = await setHistoryLimit(jsm, selected.space, row.kind, row.to, row.from);
        row.outcome = change ? "changed" : "unchanged";
      } catch (error) {
        const before = rows.filter((item) => item.outcome === "changed");
        if (error instanceof HistoryLimitUpdateUnknown) {
          row.outcome = "unknown";
          throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `${error.message}; it was not retried (${outcomeLines(rows)})`, { target, native: { outcome: "unknown" }, changed: before.map((item) => item.stream), remedy: `${READ_REMEDY}; an unknown result does not mean nothing changed` });
        }
        row.outcome = "refused";
        const reason = error instanceof HistoryLimitChanged ? error.message
          : isPublishPermissionDenied(error) ? `the broker refused the history limit update of ${row.stream}`
          : error instanceof JetStreamApiError ? `the broker refused the history limit update of ${row.stream} (${error.message})`
          : `${row.stream} could not be read again before the update (${(error as Error).message})`;
        if (before.length === 0) throw new CommandFailure("refused", error instanceof HistoryLimitChanged || error instanceof JetStreamApiError ? "CONFLICT" : isPublishPermissionDenied(error) ? "PERMISSION_DENIED" : "TARGET_UNAVAILABLE", `${reason}; nothing was changed`, { target, remedy: "run the command again to act on the limits the streams hold now" });
        throw new CommandFailure("partial", "OPERATION_PARTIAL", `${reason}; ${outcomeLines(rows)}`, { target, changed: before.map((item) => item.stream), remedy: READ_REMEDY });
      }
    }
    const lines = [
      ...changing.map((row) => `${row.stream} now keeps ${describeHistoryLimit(row.kind, row.to)}.`),
      ...(changing.some((row) => row.to.maxAgeMs === 0 && row.to.perSubject === HISTORY_NO_COUNT) ? ["With no age and no count limit, only the server's storage limit bounds a stream; a full store refuses new messages."] : []),
      "Entries the broker deleted under an earlier limit do not come back.",
    ];
    writeResult(presentation, { command: "history", target, result: resultOf(true, snapshots.length ? { lowered: snapshots } : {}) }, (): Report => ({ sections: [{ title: "History limits changed", blocks: [{ kind: "fields", rows: [["Space", selected.space], ["Broker", target.broker], ...changing.flatMap((row): [string, string][] => [[`${LABEL[row.kind]} before`, describeHistoryLimit(row.kind, row.from)], [`${LABEL[row.kind]} now`, describeHistoryLimit(row.kind, row.to)]])] }, { kind: "lines", lines }] }] }));
  } finally {
    release?.();
    await nc.close();
  }
}

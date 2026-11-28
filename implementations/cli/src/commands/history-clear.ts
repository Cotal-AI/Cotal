import * as prompts from "../lib/prompts.js";
import { chatStream, dmStream, dialerFor, isPublishPermissionDenied, isStreamNotFound, mintCreds, newIdentity, readPluginMaintenanceState, standaloneConnectOpts } from "@cotal-ai/core";
import { jetstreamManager } from "@nats-io/jetstream";
import { ConfirmationRequired, CommandFailure, recordOperationSpace, brokerAddressForDisplay, codeSpan, connectOrThrow, credentialRefusalMessage, findCotalRoot, findMesh, hasUserAuthState, isConnectRefusal, isWorkspaceTargetError, oneLine, presentationOf, resolveMeshTarget, userViewAuth, writeResult, type Connection, type Presentation, type Report } from "@cotal-ai/workspace";
import { canPrompt } from "./meshes-wizard.js";
import { targetWords, yesRequired } from "../lib/confirmation-required.js";
import { noticeOnInterrupt } from "../lib/interrupt-notice.js";
import { deniedWrite } from "../lib/denied-write.js";
import { readStackJournal } from "../lib/stack-journal.js";

interface Values { space?: string; server?: string; creds?: string; dms?: boolean; yes?: boolean; json?: boolean; plain?: boolean; "dry-run"?: boolean }
interface PurgeReceipt { stream: string; purged: number }

const brokerLabel = (server: string): string => brokerAddressForDisplay(server) ?? "selected broker (address unavailable)";

function clearRemedy(values: Values, presentation: Presentation): string {
  const command = `cotal history clear${targetWords(values)}${values.dms ? " --dms" : ""}`;
  if (presentation !== "json" && oneLine(command) !== command) {
    return "keep all arguments in your original command. Add `--dry-run` to preview the space-wide scope, then use `--yes` instead to confirm. Put the new flag before `--` if present";
  }
  const format = presentation === "rich" ? "" : ` --${presentation}`;
  return `preview the space-wide scope with ${codeSpan(`${command} --dry-run${format}`)}, then confirm it with ${codeSpan(`${command} --yes${format}`)}`;
}

/** The local operator reads state with a one-shot provisioner, not the chat-only purger. */
export async function hasLocalPluginHistory(conn: Connection): Promise<boolean> {
  if (!conn.auth || !conn.root) return false;
  const creds = await mintCreds(conn.auth, newIdentity(), "provisioner");
  const nc = await dialerFor(conn.server)({ servers: conn.server, ...standaloneConnectOpts({ creds, tls: conn.tls }), maxReconnectAttempts: 0 });
  try { return (await readPluginMaintenanceState(nc, conn.space)).state.enabled; }
  finally { await nc.close(); }
}

/** Explicit space-wide purge, using only the existing purger instrument or user purger view. */
export async function historyClear(values: Values): Promise<void> {
  const presentation = presentationOf(values);
  if (values["dry-run"]) {
    let selected: { space: string; server: string };
    try {
      const { space, server, creds } = values;
      selected = space && server && creds === undefined && !findMesh(space) && !hasUserAuthState(findCotalRoot(), space, { readOnly: true })
        ? { space, server }
        : resolveMeshTarget(process.cwd(), { ...values, readOnly: true });
    } catch (error) {
      if (!isWorkspaceTargetError(error) || error.code !== "not-started") throw error;
      const { root, space, stopped, lastRun, stackSpace, server, recordedRoot, home } = error.details;
      // A stopped direct `up` leaves no journal, but its retained configuration names the broker.
      if (lastRun && stackSpace && server && recordedRoot === undefined && home === undefined && (values.space === undefined || values.space === stackSpace)) {
        selected = { space: stackSpace, server: values.server ?? server };
      } else {
        // A completed down removes the live registration but keeps the broker address in its journal.
        if (!root || !space || !stopped) throw error;
        const journal = readStackJournal(root)?.journal;
        if (journal?.space !== space || journal.operation.kind !== "down" || journal.operation.phase !== "completed") throw error;
        selected = { space, server: values.server ?? journal.server };
      }
    }
    const streams = [chatStream(selected.space), ...(values.dms ? [dmStream(selected.space)] : [])];
    writeResult(presentation, { command: "history", target: { space: selected.space, broker: brokerLabel(selected.server) }, result: { kind: "history-clear-preview", dryRun: true, streams, includeDms: values.dms === true, authorization: "not-checked", retainedCounts: "not-checked", purged: false } }, (result): Report => ({ sections: [{ title: "History clear preview", blocks: [{ kind: "fields", rows: [["Space", selected.space], ["Broker", brokerLabel(selected.server)], ["Scope", "all retained channel history"], ["DM history", result.includeDms ? "included" : "not included"], ["Streams", result.streams.join(", ")], ["Authorization and counts", "not checked"]] }, { kind: "lines", lines: ["Offline target preview only. No connection, purge, agent stop, identity reset or caller issuance was attempted."] }] }] }));
    return;
  }
  if (!values.yes && (!canPrompt() || presentation === "json")) {
    throw new ConfirmationRequired(yesRequired("history clear", presentation === "json"), {
      remedy: clearRemedy(values, presentation),
    });
  }
  const acknowledged: PurgeReceipt[] = [];
  let submitted: string | undefined;
  // A signal from the confirmed clear on ends it where it is, and says what was purged.
  const interrupted = (): string => !acknowledged.length && submitted === undefined
    ? "Interrupted before any history purge was submitted; no history was cleared."
    : `Interrupted after ${acknowledged.length ? acknowledged.map((row) => `${row.stream} acknowledged ${row.purged} purged`).join(", ") : "no acknowledged purge"}${submitted ? `, with the purge of ${submitted} submitted and unconfirmed` : ""}; inspect retained history before another clear.`;
  let release = values.yes ? noticeOnInterrupt(interrupted) : undefined;
  try {
    const conn = await connectOrThrow(values, "purger");
    const pluginChannels = await hasLocalPluginHistory(conn);
    const scope = pluginChannels ? "retained chat history" : "all retained channel history";
    const target = { space: conn.space, broker: brokerLabel(conn.server), includeDms: values.dms === true };
    recordOperationSpace(conn.space);
    if (!values.yes) {
      const answer = await prompts.confirm({ message: `Permanently clear ${scope}${values.dms ? " and DM history" : " (DMs kept)"} in ${oneLine(conn.space)} at ${oneLine(target.broker)}?${pluginChannels ? " Plugin channel history is kept." : ""} Agents and identity are not reset.`, initialValue: false });
      if (prompts.isCancel(answer) || !answer) {
        writeResult(presentation, { command: "history", target, result: { kind: "history-clear", confirmed: false, purged: false }, noOp: true }, (): Report => ({ sections: [{ title: "History kept", blocks: [{ kind: "lines", lines: ["No stream was purged. Agents, identity and retained messages were left unchanged."] }] }] }));
        return;
      }
      release = noticeOnInterrupt(interrupted);
    }
    let user: Awaited<ReturnType<typeof userViewAuth>> | undefined;
    try { user = conn.bearer ? await userViewAuth(conn, "purger") : undefined; }
    catch (error) {
      if (isConnectRefusal(error)) throw error.failure();
      const remedy = credentialRefusalMessage(error);
      throw new CommandFailure("refused", "PERMISSION_DENIED", "the existing per-action purger view was not issued; no history purge was submitted", { target, ...(remedy ? { remedy } : {}) });
    }
    const material = user ? { bearer: user.bearer, sentinelCreds: user.sentinelCreds } : conn.creds ? { creds: conn.creds } : {};
    const nc = await dialerFor(conn.server)({ servers: conn.server, ...standaloneConnectOpts({ ...material, tls: conn.tls }), maxReconnectAttempts: 0 });
    const streams = [chatStream(conn.space), ...(values.dms ? [dmStream(conn.space)] : [])];
    const absent: string[] = [];
    try {
      const jsm = await jetstreamManager(nc, { checkAPI: false });
      for (const stream of streams) {
        submitted = stream;
        try {
          const reply = await jsm.streams.purge(stream);
          if (reply.success !== true || !Number.isSafeInteger(reply.purged) || reply.purged < 0) throw new Error("unconfirmed purge reply");
          acknowledged.push({ stream, purged: reply.purged });
          submitted = undefined;
        } catch (error) {
          // A missing stream has nothing left to purge. A permission denial stays a denial.
          if (!isStreamNotFound(error)) throw error;
          absent.push(stream);
          submitted = undefined;
        }
      }
    } catch (error) {
      if (submitted === undefined && !acknowledged.length) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the native purge client could not be prepared; no purge request was submitted", { target, native: { outcome: "not-executed" } });
      const api = error && typeof error === "object" && "api_error" in error ? (error as { api_error?: { code?: unknown; err_code?: unknown } }).api_error : undefined;
      // The client reports a refused publish as the cause of the request error it raises.
      const denied = isPublishPermissionDenied(error) || api?.code === 403;
      const detail = { acknowledged, unconfirmedStream: submitted ?? null, notSubmitted: streams.filter((stream) => !acknowledged.some((row) => row.stream === stream) && stream !== submitted) };
      if (denied && !acknowledged.length) throw deniedWrite(conn, values.creds !== undefined, "purge retained history", "purged", error, { target, native: { code: "permission-denied", outcome: "not-executed", detail } });
      if (denied) throw new CommandFailure("partial", "OPERATION_PARTIAL", "some history purges were acknowledged, but the next stream was refused; no retry was made", { target, changed: acknowledged, native: { outcome: "not-executed", detail } });
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "a history purge was submitted without a confirmed outcome; it was not retried", { target, changed: acknowledged, native: { outcome: "unknown", detail }, remedy: "inspect retained history on the original broker before another purge; an unknown result does not mean nothing changed" });
    } finally { await nc.close(); }
    const noOp = absent.length === streams.length;
    const warnings = absent.length === 0 ? undefined : [{ code: "HISTORY_STREAM_ABSENT", target, message: `these streams are not on the broker, so they were not purged: ${absent.join(", ")}` }];
    writeResult(presentation, { command: "history", target, warnings, noOp, result: { kind: "history-clear", acknowledged, includeDms: values.dms === true, agentsStopped: false, identityReset: false } }, (result): Report => ({
      sections: [{ title: noOp ? "No retained history to clear" : "History purge acknowledged", blocks: [
        { kind: "fields", rows: [["Space", conn.space], ["Broker", target.broker], ["Scope", scope], ["DM history", result.includeDms ? "included" : "not included"]] },
        ...(noOp ? [] : [
          { kind: "table" as const, columns: [{ key: "stream", label: "Native stream" }, { key: "purged", label: "Messages purged" }], rows: result.acknowledged.map((row) => ({ stream: row.stream, purged: String(row.purged) })) },
        ]),
        { kind: "lines", lines: [noOp ? "0 messages purged." : "These counts come from native purge acknowledgements. Agents were not stopped and identity was not reset. New messages may arrive after the purge.", ...(pluginChannels ? ["Plugin channel history was not purged."] : [])] },
      ] }],
    }));
  } finally { release?.(); }
}

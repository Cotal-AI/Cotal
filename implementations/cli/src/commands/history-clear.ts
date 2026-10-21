import * as prompts from "../lib/prompts.js";
import { chatStream, dmStream, dialerFor, standaloneConnectOpts } from "@cotal-ai/core";
import { jetstreamManager } from "@nats-io/jetstream";
import { PermissionViolationError } from "@nats-io/transport-node";
import { CommandFailure, recordOperationSpace, brokerAddressForDisplay, connectOrThrow, isConnectRefusal, oneLine, presentationOf, resolveMeshTarget, userViewAuth, writeResult, type Report } from "@cotal-ai/workspace";
import { canPrompt } from "./meshes-wizard.js";

interface Values { space?: string; server?: string; creds?: string; dms?: boolean; yes?: boolean; json?: boolean; plain?: boolean; "dry-run"?: boolean }
interface PurgeReceipt { stream: string; purged: number }

const brokerLabel = (server: string): string => brokerAddressForDisplay(server) ?? "selected broker (address unavailable)";

/** Explicit space-wide purge, using only the existing purger instrument or user purger view. */
export async function historyClear(values: Values): Promise<void> {
  const presentation = presentationOf(values);
  if (values["dry-run"]) {
    const selected = resolveMeshTarget(process.cwd(), { ...values, readOnly: true });
    const streams = [chatStream(selected.space), ...(values.dms ? [dmStream(selected.space)] : [])];
    writeResult(presentation, { command: "history", target: { space: selected.space, broker: brokerLabel(selected.server) }, result: { kind: "history-clear-preview", dryRun: true, streams, includeDms: values.dms === true, authorization: "not-checked", retainedCounts: "not-checked", purged: false } }, (result): Report => ({ sections: [{ title: "History clear preview", blocks: [{ kind: "fields", rows: [["Space", selected.space], ["Broker", brokerLabel(selected.server)], ["Scope", "all retained channel history"], ["DM history", result.includeDms ? "included" : "not included"], ["Streams", result.streams.join(", ")], ["Authorization and counts", "not checked"]] }, { kind: "lines", lines: ["Offline target preview only. No connection, purge, agent stop, identity reset or caller issuance was attempted."] }] }] }));
    return;
  }
  if (!values.yes && (!canPrompt() || presentation === "json")) throw new CommandFailure("refused", "USAGE_INVALID", "history clear requires --yes outside an interactive terminal", { remedy: "preview the space-wide scope with cotal history clear --dry-run before confirming it" });
  const conn = await connectOrThrow(values, "purger");
  const target = { space: conn.space, broker: brokerLabel(conn.server), includeDms: values.dms === true };
  recordOperationSpace(conn.space);
  if (!values.yes) {
    const answer = await prompts.confirm({ message: `Permanently clear all retained channel history${values.dms ? " and DM history" : " (DMs kept)"} in ${oneLine(conn.space)} at ${oneLine(target.broker)}? Agents and identity are not reset.`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) {
      writeResult(presentation, { command: "history", target, result: { kind: "history-clear", confirmed: false, purged: false }, noOp: true }, (): Report => ({ sections: [{ title: "History kept", blocks: [{ kind: "lines", lines: ["No stream was purged. Agents, identity and retained messages were left unchanged."] }] }] }));
      return;
    }
  }
  let user: Awaited<ReturnType<typeof userViewAuth>> | undefined;
  try { user = conn.bearer ? await userViewAuth(conn, "purger") : undefined; }
  catch (error) {
    if (isConnectRefusal(error)) throw error.failure();
    throw new CommandFailure("refused", "PERMISSION_DENIED", "the existing per-action purger view was not issued; no history purge was submitted", { target });
  }
  const material = user ? { bearer: user.bearer, sentinelCreds: user.sentinelCreds } : conn.creds ? { creds: conn.creds } : {};
  const nc = await dialerFor(conn.server)({ servers: conn.server, ...standaloneConnectOpts({ ...material, tls: conn.tls }), maxReconnectAttempts: 0 });
  const streams = [chatStream(conn.space), ...(values.dms ? [dmStream(conn.space)] : [])];
  const acknowledged: PurgeReceipt[] = [];
  let submitted: string | undefined;
  try {
    const jsm = await jetstreamManager(nc, { checkAPI: false });
    for (const stream of streams) {
      submitted = stream;
      const reply = await jsm.streams.purge(stream);
      if (reply.success !== true || !Number.isSafeInteger(reply.purged) || reply.purged < 0) throw new Error("unconfirmed purge reply");
      acknowledged.push({ stream, purged: reply.purged });
      submitted = undefined;
    }
  } catch (error) {
    if (submitted === undefined && !acknowledged.length) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the native purge client could not be prepared; no purge request was submitted", { target, native: { outcome: "not-executed" } });
    const api = error && typeof error === "object" && "api_error" in error ? (error as { api_error?: { code?: unknown; err_code?: unknown } }).api_error : undefined;
    const denied = error instanceof PermissionViolationError || api?.code === 403;
    const absent = api?.code === 404;
    const knownRefusal = denied || absent;
    const detail = { acknowledged, unconfirmedStream: submitted ?? null, notSubmitted: streams.filter((stream) => !acknowledged.some((row) => row.stream === stream) && stream !== submitted) };
    if (knownRefusal && !acknowledged.length) throw new CommandFailure("refused", denied ? "PERMISSION_DENIED" : "TARGET_NOT_FOUND", "the native broker refused the purge before executing it", { target, native: { code: denied ? "permission-denied" : "not-found", outcome: "not-executed", detail } });
    if (knownRefusal) throw new CommandFailure("partial", "OPERATION_PARTIAL", "some history purges were acknowledged, but the next stream was refused; no retry was made", { target, changed: acknowledged, native: { outcome: "not-executed", detail } });
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "a history purge was submitted without a confirmed outcome; it was not retried", { target, changed: acknowledged, native: { outcome: "unknown", detail }, remedy: "inspect retained history on the original broker before another purge; an unknown result does not mean nothing changed" });
  } finally { await nc.close(); }
  writeResult(presentation, { command: "history", target, result: { kind: "history-clear", acknowledged, includeDms: values.dms === true, agentsStopped: false, identityReset: false } }, (result): Report => ({ sections: [{ title: "History purge acknowledged", blocks: [{ kind: "fields", rows: [["Space", conn.space], ["Broker", target.broker], ["Scope", "all retained channel history"], ["DM history", result.includeDms ? "included" : "not included"]] }, { kind: "table", columns: [{ key: "stream", label: "Native stream" }, { key: "purged", label: "Messages purged" }], rows: result.acknowledged.map((row) => ({ stream: row.stream, purged: String(row.purged) })) }, { kind: "lines", lines: ["These counts come from native purge acknowledgements. Agents were not stopped and identity was not reset. New messages may arrive after the purge."] }] }] }));
}

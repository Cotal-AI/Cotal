import {
  CotalEndpoint, dialerFor, dmDurable, dmStream, isConsumerNotFound,
  parsePrincipalKey, standaloneConnectOpts, unicastSubject, type FlagSpec, type ParsedArgs, type Presence,
} from "@cotal-ai/core";
import { CommandFailure, connectOrThrow, isConnectRefusal, jsonFlag, plainFlag, presentationOf, writeResult, type Report } from "@cotal-ai/workspace";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { parseDmDurable } from "./pending.js";

export const pendingFlags = [jsonFlag, plainFlag,
  { name: "space", type: "string", value: "<space>", description: "registered mesh to inspect" },
  { name: "server", type: "string", value: "<url>", description: "broker address override" },
  { name: "creds", type: "string", value: "<private-file>", description: "off-registry admin credential" },
  { name: "limit", type: "string", value: "<1..100>", description: "maximum recent candidate message IDs (default 20)" },
  { name: "durable", type: "string", value: "<name>", description: "exact prior-lifecycle DM durable instead of resolving a live name" },
] as const satisfies readonly FlagSpec[];

export function validatePendingArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals.length !== 1 || !args.positionals[0]?.trim()) throw new CommandFailure("refused", "USAGE_INVALID", "use pending <agent> [--durable <exact-dm-durable>] [--limit <1..100>]");
  if (args.values.limit !== undefined && (!/^[1-9][0-9]*$/.test(String(args.values.limit)) || Number(args.values.limit) > 100)) throw new CommandFailure("refused", "USAGE_INVALID", "--limit needs an integer from 1 to 100");
  if (args.values.durable !== undefined && !parseDmDurable(String(args.values.durable))) throw new CommandFailure("refused", "USAGE_INVALID", "--durable needs the exact lifecycle-keyed DM durable printed by a native read");
}

async function uniquePresence(ep: CotalEndpoint, name: string): Promise<Presence> {
  for (let attempt = 0; attempt < 20; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  const roster = ep.getRoster();
  const byId = roster.filter((peer) => peer.card.id === name);
  if (byId.length === 1) return byId[0]!;
  const byName = roster.filter((peer) => peer.card.name === name);
  if (byName.length > 1 || byId.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "more than one roster entry matches the requested recipient; name its full principal ID or a previously printed durable");
  if (byName.length === 1) return byName[0]!;
  throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no recipient with this exact name or principal ID was observed in the bounded roster read; no empty durable was inferred");
}

/** One finite read receipt. It never acknowledges a DM or claims that candidate IDs prove a hole. */
export async function pendingView(args: ParsedArgs): Promise<void> {
  validatePendingArguments(args);
  const values = args.values as { space?: string; server?: string; creds?: string; durable?: string; limit?: string };
  const requested = args.positionals[0]!;
  const limit = values.limit === undefined ? 20 : Number(values.limit);
  let conn: Awaited<ReturnType<typeof connectOrThrow>>;
  try { conn = await connectOrThrow(values, "admin", { readOnly: true }); }
  catch (error) {
    if (isConnectRefusal(error)) throw new CommandFailure("refused", error.code, "the selected admin credential could not establish the requested broker read; no other identity or mesh was substituted", { target: { requested } });
    throw error;
  }
  const { space, server, tls } = conn;
  if (conn.mode === "user") throw new CommandFailure("refused", "UNSUPPORTED", "this pending durable reader has no user-auth admin view; no static credential, bare connection or alternate owner was substituted", { target: { space, requested } });
  let durable: string;
  let recipient: { owner: string; actor: string } | null;
  if (values.durable !== undefined) {
    durable = values.durable;
    recipient = parseDmDurable(durable);
  } else {
    const ep = new CotalEndpoint({ space, servers: server, creds: conn.creds, tls, channels: [], consume: false, registerPresence: false, watchPresence: true, card: { name: "pending-view", kind: "endpoint" } });
    ep.on("error", () => {});
    await ep.start();
    let peer: Presence;
    try { peer = await uniquePresence(ep, requested); }
    finally { await ep.stop(); }
    if (!peer.lifecycleUid) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the selected roster entry has no lifecycle UID; no DM durable was guessed", { target: { space, requested } });
    recipient = parsePrincipalKey(peer.card.id);
    if (!recipient) throw new CommandFailure("refused", "SCHEMA_INVALID", "the selected roster entry has no usable principal; no other recipient was substituted", { target: { space, requested } });
    durable = dmDurable(recipient.owner, recipient.actor, peer.lifecycleUid);
  }
  const stream = dmStream(space);
  const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ creds: conn.creds, tls }), maxReconnectAttempts: 0 });
  const warnings: Array<{ code: string; message: string; target: { space: string; durable: string } }> = [];
  let result: { kind: string; durable: string; pending: number; ackPending: number; delivered: number; ackFloor: number; created: string; frontier: number; maxAge: number; maxMsgsPerSubject: number; discard: string; candidates: Array<{ id: string; from: string; ts: number }>; candidateRead: string; candidateLimit: number };
  try {
    const jsm = await jetstreamManager(nc);
    let info: Awaited<ReturnType<typeof jsm.consumers.info>>;
    try { info = await jsm.consumers.info(stream, durable); }
    catch (error) {
      if (isConsumerNotFound(error)) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the exact selected DM durable is not present; pending zero was not inferred", { target: { space, durable } });
      throw error;
    }
    const streamInfo = await jsm.streams.info(stream);
    result = { kind: "pending-dm-durable", durable, pending: info.num_pending, ackPending: info.num_ack_pending,
      delivered: info.delivered.stream_seq, ackFloor: info.ack_floor.stream_seq, created: info.created,
      frontier: Math.max(0, (info.config.opt_start_seq ?? 1) - 1), maxAge: streamInfo.config.max_age,
      maxMsgsPerSubject: streamInfo.config.max_msgs_per_subject, discard: streamInfo.config.discard,
      candidates: [], candidateRead: "not-checked", candidateLimit: limit };
    if (recipient) {
      let consumer: Awaited<ReturnType<ReturnType<typeof jetstream>["consumers"]["get"]>> | undefined;
      try {
        const js = jetstream(nc);
        consumer = await js.consumers.get(stream, { filter_subjects: [unicastSubject(space, recipient.owner, recipient.actor, "*", "*")], opt_start_seq: result.ackFloor + 1 });
        const cinfo = await consumer.info(true);
        const count = Math.min(cinfo.num_pending, limit);
        if (count) {
          const batch = await consumer.fetch({ max_messages: count, expires: 2_000 });
          for await (const message of batch) {
            try {
              const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message.data)) as Record<string, unknown>;
              const sender = row.from as { id?: unknown } | null;
              if (typeof row.id !== "string" || typeof sender?.id !== "string" || typeof row.ts !== "number" || row.id.length > 256 || sender.id.length > 256 || !Number.isFinite(row.ts)) throw new Error();
              result.candidates.push({ id: row.id, from: sender.id, ts: row.ts });
            } catch {
              if (!warnings.some((warning) => warning.code === "CANDIDATE_UNREADABLE")) warnings.push({ code: "CANDIDATE_UNREADABLE", message: "At least one candidate message could not be decoded safely; its contents were withheld.", target: { space, durable } });
            }
          }
        }
        result.candidateRead = "bounded-from-ack-floor";
      } catch { warnings.push({ code: "CANDIDATE_READ_UNAVAILABLE", message: "The bounded candidate read did not complete; durable counts remain separate facts.", target: { space, durable } }); }
      finally {
        if (consumer) try { await consumer.delete(); }
        catch { warnings.push({ code: "EPHEMERAL_CLEANUP_UNCONFIRMED", message: "The transient read consumer's deletion was not confirmed; no DM was acknowledged.", target: { space, durable } }); }
      }
    } else result.candidateRead = "durable-name-unparseable";
  } finally {
    try { await nc.close(); }
    catch { warnings.push({ code: "READER_CLOSE_UNCONFIRMED", message: "The short-lived inspection connection did not confirm closure; no message was acknowledged.", target: { space, durable } }); }
  }
  writeResult(presentationOf(args.values), { command: "pending", target: { space, requested, durable }, result,
    ...(warnings.length || result.candidateRead !== "bounded-from-ack-floor" ? { completeness: "partial" as const, partial: { message: "Candidate message IDs are a bounded read, not proof of complete history, delivery or absence of a hole." } } : {}), warnings }, (data): Report => ({ sections: [
    { title: "Held DM durable", blocks: [{ kind: "fields", rows: [["Space", space], ["Durable", data.durable], ["Pending", String(data.pending)], ["Ack pending", String(data.ackPending)], ["Delivered sequence", String(data.delivered)], ["Ack floor", String(data.ackFloor)], ["Created", data.created], ["Frontier", String(data.frontier)], ["Retention max age", String(data.maxAge)], ["Per-subject maximum", String(data.maxMsgsPerSubject)], ["Discard", data.discard], ["Candidate read", data.candidateRead]] }, { kind: "lines", lines: ["Broker-reported consumer facts only. A held message is not proof it was delivered or read by the recipient."] }] },
    { title: "Recent candidate IDs", blocks: [{ kind: "lines", lines: data.candidates.length ? data.candidates.map((row) => `${row.id}  from=${row.from}  ts=${row.ts}`) : [data.candidateRead === "bounded-from-ack-floor" ? "No candidates in this bounded read; history completeness is not established." : "Candidate read unavailable or skipped."] }, { kind: "lines", lines: ["Candidates start after the ack floor and do not prove a hole. No DM was acknowledged or native durable deleted."] }] },
  ] }));
}

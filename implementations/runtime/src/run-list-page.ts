/** Bounded diagnostic pages over create-only run specs. No page establishes absence or ownership. */
import {
  EpEnvelopeError, assertIdToken, endpointNameOf, endpointToken, readRecordLeader,
  readRunRevocation, recordsBucket, recordStatusKey, RECORD_KINDS,
  type RunHostPlanes, type RunListPage, type RunListPageContext, type RunListPageOptions,
  type RunListPageRow, type RunListRequest, type RunStatusValue,
} from "@cotal-ai/core";
import type { MsgRequest } from "@nats-io/jetstream";

const BYTE_LIMIT = 65_536;
const READ_LIMIT = 64;
const STATES = new Set(["running", "released", "completed", "failed"]);
interface Cursor {
  v: 1;
  space: string;
  endpointFilter: string | null;
  instanceId: string;
  epoch: number;
  stream: string;
  cutSeq: number;
  nextSeq: number;
}
const CURSOR_KEYS = ["v", "space", "endpointFilter", "instanceId", "epoch", "stream", "cutSeq", "nextSeq"];
const integer = (x: unknown, minimum = 0): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= minimum;
const timestamp = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

function decodeCursor(text: string, expected: Omit<Cursor, "cutSeq" | "nextSeq">): Cursor {
  if (text.length > 3072 || !/^[A-Za-z0-9_-]+$/.test(text))
    throw new EpEnvelopeError("bad-request", "invalid inventory cursor encoding");
  try {
    const bytes = Buffer.from(text, "base64url");
    if (bytes.length > 2048 || bytes.toString("base64url") !== text) throw new Error();
    const c: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(c) || Object.keys(c).length !== CURSOR_KEYS.length || CURSOR_KEYS.some((key) => !Object.hasOwn(c, key))) throw new Error();
    for (const [key, value] of Object.entries(expected)) if (c[key] !== value) throw new Error();
    if (!integer(c.cutSeq) || c.cutSeq >= Number.MAX_SAFE_INTEGER || !integer(c.nextSeq, 1) || c.nextSeq > c.cutSeq + 1) throw new Error();
    return c as unknown as Cursor;
  } catch {
    throw new EpEnvelopeError("bad-request", "inventory cursor does not match this manager, filter or scan");
  }
}

function statusRow(value: unknown, revision: number, specRevision: number): RunListPageRow["status"] {
  if (!object(value) || value.v !== 1 || !integer(value.observedSpecRevision) || value.observedSpecRevision > specRevision ||
      typeof value.state !== "string" || !STATES.has(value.state) || typeof value.holder !== "string" ||
      !integer(value.epoch) || !integer(value.fencingToken) || !integer(value.journalHigh, -1) || !timestamp(value.at) || !integer(revision, 1))
    throw new EpEnvelopeError("failed-precondition", "invalid run status in diagnostic inventory");
  return {
    v: 1, observedSpecRevision: value.observedSpecRevision, state: value.state as RunStatusValue["state"],
    holder: value.holder, epoch: value.epoch, fencingToken: value.fencingToken,
    journalHigh: value.journalHigh, at: value.at, statusRevision: revision,
    staleProjection: value.observedSpecRevision < specRevision,
  };
}

export async function listRunPage(
  planes: RunHostPlanes,
  req: RunListRequest & { readonly page: RunListPageOptions },
  context: RunListPageContext,
): Promise<RunListPage> {
  const limit = req.page.limit ?? 8;
  if (!integer(limit, 1) || limit > 16) throw new EpEnvelopeError("bad-request", "inventory page limit must be between 1 and 16");
  const endpointFilter = req.endpoint ?? null;
  const bucket = recordsBucket(planes.space), stream = `KV_${bucket}`;
  const prefix = `$KV.${bucket}.`;
  const filter = `${prefix}run.${endpointFilter === null ? "*" : endpointToken(endpointFilter)}.*.spec`;
  const expected = { v: 1 as const, space: planes.space, endpointFilter, ...context.responder, stream };
  let cursor: Cursor = req.page.cursor === undefined ? { ...expected, cutSeq: 0, nextSeq: 1 } : decodeCursor(req.page.cursor, expected);
  let storageReads = 0;
  const items: RunListPageRow[] = [];
  const seen = new Set<string>();
  const canIssue = (count: number) => {
    if (planes.nc.isClosed()) throw new EpEnvelopeError("unavailable", "inventory connection closed");
    return storageReads + count <= READ_LIMIT && performance.now() < context.issueUntil;
  };
  const page = (stopReason: RunListPage["stopReason"], rows: readonly RunListPageRow[] = items, nextSeq = cursor.nextSeq): RunListPage => {
    const endObserved = stopReason === "end";
    return {
      v: 1, semantics: "diagnostic", space: planes.space, endpointFilter, responder: context.responder,
      cutSeq: cursor.cutSeq, nextSeq, items: rows, endObserved, stopReason, storageReads,
      ...(!endObserved ? { nextCursor: Buffer.from(JSON.stringify({ ...cursor, nextSeq })).toString("base64url") } : {}),
    };
  };
  const finish = (reason: RunListPage["stopReason"]): RunListPage => {
    const result = page(reason);
    if (!context.replyFits(result, BYTE_LIMIT)) throw new EpEnvelopeError("resource-exhausted", "inventory page exceeds the complete reply byte limit");
    return result;
  };
  // This also refuses an unavailable serving payload ceiling before reading any records.
  if (!context.replyFits(page("read-budget"), BYTE_LIMIT))
    throw new EpEnvelopeError("resource-exhausted", "inventory page metadata exceeds the reply byte limit");
  const getMessage = async (request: MsgRequest) => {
    storageReads++;
    try { return await planes.jsm.streams.getMessage(stream, request); }
    catch (e) { if ((e as { code?: unknown })?.code === 10037) return undefined; throw e; }
  };
  if (req.page.cursor === undefined) {
    if (!canIssue(1)) throw new EpEnvelopeError("deadline-exceeded", "inventory issuance budget expired before observing a cut");
    const last = await getMessage({ last_by_subj: filter });
    if (last === undefined || last === null) return finish("end");
    if (!integer(last.seq, 1) || last.seq >= Number.MAX_SAFE_INTEGER)
      throw new EpEnvelopeError("failed-precondition", "invalid inventory cut sequence");
    cursor = { ...cursor, cutSeq: last.seq };
  }
  while (cursor.nextSeq <= cursor.cutSeq) {
    if (items.length === limit) return finish("rows");
    if (!canIssue(3)) return finish("read-budget");
    // Ordinary MSG.GET accepts next_by_subj; the client types it only on Direct Get.
    const request = { seq: cursor.nextSeq, next_by_subj: filter };
    const message = await getMessage(request as unknown as MsgRequest);
    if (message === undefined || message === null || message.seq > cursor.cutSeq) {
      cursor = { ...cursor, nextSeq: cursor.cutSeq + 1 };
      return finish("end");
    }
    if (!integer(message.seq, cursor.nextSeq) || !message.subject.startsWith(prefix) || message.header?.get("KV-Operation"))
      throw new EpEnvelopeError("failed-precondition", "invalid or deleted run spec in diagnostic inventory");
    const parts = message.subject.slice(prefix.length).split(".");
    if (parts.length !== 4 || parts[0] !== "run" || parts[3] !== "spec")
      throw new EpEnvelopeError("failed-precondition", "unexpected run spec coordinate");
    const endpoint = endpointNameOf(parts[1]!), runId = assertIdToken(parts[2]!, "runId");
    if (endpointToken(endpoint) !== parts[1] || (endpointFilter !== null && endpoint !== endpointFilter) || seen.has(`${endpoint}/${runId}`))
      throw new EpEnvelopeError("failed-precondition", "inconsistent run spec coordinate");
    let spec: unknown;
    try { spec = JSON.parse(new TextDecoder().decode(message.data)); }
    catch { throw new EpEnvelopeError("failed-precondition", "run spec does not decode as JSON"); }
    if (!object(spec) || spec.v !== 1 || spec.run !== runId || !object(spec.pins) || !timestamp(spec.pins.startedAt))
      throw new EpEnvelopeError("failed-precondition", "invalid run spec in diagnostic inventory");
    cursor = { ...cursor, nextSeq: message.seq };
    if (!canIssue(2)) return finish("read-budget");
    storageReads++;
    const status = await readRecordLeader(planes.jsm, planes.space, recordStatusKey(RECORD_KINDS.run, [endpoint, runId]));
    if (!canIssue(1)) return finish("read-budget");
    storageReads++;
    const revoked = await readRunRevocation(planes.jsm, planes.space, endpoint, runId);
    const row: RunListPageRow = {
      endpoint, runId, specRevision: message.seq, startedAt: spec.pins.startedAt, observedAt: Date.now(),
      status: status === undefined ? null : statusRow(status.value, status.revision, message.seq),
      revocation: revoked === undefined ? "not-observed" : "present",
    };
    // Measure with the longest stop reason and continuation, even if this is the final row.
    if (!context.replyFits(page("read-budget", [...items, row], message.seq + 1), BYTE_LIMIT)) {
      if (items.length === 0) throw new EpEnvelopeError("resource-exhausted", "one inventory row exceeds the complete reply byte limit");
      return finish("bytes");
    }
    items.push(row);
    seen.add(`${endpoint}/${runId}`);
    cursor = { ...cursor, nextSeq: message.seq + 1 };
  }
  return finish("end");
}

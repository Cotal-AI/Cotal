/**
 * `cotal chat --stdio`: the versioned NDJSON participant protocol (spec "Program participants").
 *
 * Pure protocol. It parses and validates one request per line, dispatches a valid request to an
 * already admitted {@link AdmittedChatSession}, and serializes responses and unsolicited records
 * through an injected line writer. It opens no connection, admits nothing, reads no credential and
 * holds no authority of its own; a caller cannot name an owner, actor, UID, credential or scope.
 *
 * Wire shape, every record one JSON object on one line with `schemaVersion: 1`:
 *   request   {schemaVersion, id, type, ...fields}      (program -> stdin)
 *   result    {schemaVersion, type:"result", id, outcome, result?, error?}
 *   message   {schemaVersion, type:"message", message}
 *   presence  {schemaVersion, type:"presence", change, row}
 *   gap       {schemaVersion, type:"gap", scope, reason}
 *   error     {schemaVersion, type:"error", id:null, error}   (a line that names no usable id)
 *   end       {schemaVersion, type:"end", reason, close?}
 *
 * Requests run one at a time in arrival order, so results come back in request order. Unknown
 * types, unknown fields and malformed values refuse with USAGE_INVALID and never reach the session.
 */
import { assertValidChannel, assertValidRole, isConcreteChannel, MAX_NAME_LENGTH } from "@cotal-ai/core";
import type { AttentionMode, ChannelMode } from "@cotal-ai/core";
import type { AdmittedChatSession, CloseReport, PublishResult, Result, SessionEvent, SessionMessage } from "./session.js";

export const STDIO_SCHEMA_VERSION = 1;
/** Bound on one request line, in UTF-16 code units. Provisional; set at review. */
export const MAX_REQUEST_LINE = 1_048_576;
/** Bound on a caller-chosen request id. */
export const MAX_REQUEST_ID = 128;
/** Bound on a `replyTo` message id and a DM target (name or `<owner>.<actor>`). Provisional. */
export const MAX_MESSAGE_ID = 512;
export const MAX_DM_TARGET = 512;
/** Invoke bounds, the same as the agent tool's (`cotal_invoke`). */
export const INVOKE_DEFAULT_TIMEOUT_MS = 30_000;
export const INVOKE_MAX_TIMEOUT_MS = 120_000;

/** The closed request set. Seat-only requests (turn yield, spawn, despawn, run) are deliberately absent. */
export const REQUEST_TYPES = [
  "send", "dm", "anycast", "status", "attention", "channelMode", "join", "leave",
  "inbox", "roster", "channelInfo", "connection", "invoke",
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export type StdioRequest =
  | { readonly type: "send"; readonly id: string; readonly text: string; readonly channel: string; readonly mentions: readonly string[] }
  | { readonly type: "dm"; readonly id: string; readonly to: string; readonly text: string; readonly replyTo?: string }
  | { readonly type: "anycast"; readonly id: string; readonly role: string; readonly text: string }
  | { readonly type: "status"; readonly id: string; readonly status: "idle" | "working" | "waiting"; readonly activity?: string }
  | { readonly type: "attention"; readonly id: string; readonly mode: AttentionMode }
  | { readonly type: "channelMode"; readonly id: string; readonly channel: string; readonly mode: ChannelMode | "normal" }
  | { readonly type: "join"; readonly id: string; readonly channel: string }
  | { readonly type: "leave"; readonly id: string; readonly channel: string }
  | { readonly type: "inbox"; readonly id: string; readonly peek: boolean }
  | { readonly type: "roster"; readonly id: string }
  | { readonly type: "channelInfo"; readonly id: string; readonly channel: string }
  | { readonly type: "connection"; readonly id: string }
  | { readonly type: "invoke"; readonly id: string; readonly endpoint: string; readonly command: string; readonly args?: Readonly<Record<string, unknown>>; readonly timeoutMs: number };

export interface ProtocolError {
  readonly code: string;
  readonly message: string;
  readonly cause?: { readonly code?: string; readonly detail?: unknown };
}

/** A parsed line: a valid request, or a refusal carrying the id when one could be recovered. */
export type ParsedLine =
  | { readonly ok: true; readonly request: StdioRequest }
  | { readonly ok: false; readonly id: string | null; readonly error: ProtocolError };

const usage = (id: string | null, message: string): ParsedLine => ({ ok: false, id, error: { code: "USAGE_INVALID", message } });

const FIELDS: Readonly<Record<RequestType, { readonly required: readonly string[]; readonly optional: readonly string[] }>> = {
  send: { required: ["text", "channel"], optional: ["mentions"] },
  dm: { required: ["to", "text"], optional: ["replyTo"] },
  anycast: { required: ["role", "text"], optional: [] },
  status: { required: ["status"], optional: ["activity"] },
  attention: { required: ["mode"], optional: [] },
  channelMode: { required: ["channel", "mode"], optional: [] },
  join: { required: ["channel"], optional: [] },
  leave: { required: ["channel"], optional: [] },
  inbox: { required: [], optional: ["peek"] },
  roster: { required: [], optional: [] },
  channelInfo: { required: ["channel"], optional: [] },
  connection: { required: [], optional: [] },
  invoke: { required: ["endpoint", "command"], optional: ["args", "timeoutMs"] },
};

const ENVELOPE_FIELDS = ["schemaVersion", "id", "type"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function validId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_REQUEST_ID && /^[\x21-\x7e]+$/.test(v);
}

/** A concrete, policy-valid channel, or the reason it is not. */
function channelProblem(v: unknown): string | undefined {
  if (typeof v !== "string") return "must be a string";
  try {
    assertValidChannel(v);
  } catch (e) {
    return (e as Error).message;
  }
  return isConcreteChannel(v) ? undefined : "must be a concrete channel (no * or >)";
}

/** Parse and validate one request line. Never throws and never touches a session. */
export function parseRequestLine(line: string): ParsedLine {
  if (line.length > MAX_REQUEST_LINE) return usage(null, `request line exceeds ${MAX_REQUEST_LINE} characters`);
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return usage(null, "request is not valid JSON");
  }
  if (!isPlainObject(raw)) return usage(null, "request must be a JSON object");
  // JSON.parse yields own data properties only; a "__proto__" key is an own key and is refused
  // below as an unknown field, never applied as a prototype.
  const id = validId(raw.id) ? raw.id : null;
  if (id === null) return usage(null, `request id must be a string of 1-${MAX_REQUEST_ID} printable ASCII characters`);
  if (raw.schemaVersion !== STDIO_SCHEMA_VERSION) return usage(id, `schemaVersion must be ${STDIO_SCHEMA_VERSION}`);
  const type = raw.type;
  if (typeof type !== "string" || !(REQUEST_TYPES as readonly string[]).includes(type))
    return usage(id, `unknown request type ${JSON.stringify(type)}; supported: ${REQUEST_TYPES.join(", ")}`);
  const spec = FIELDS[type as RequestType];
  for (const key of Object.keys(raw))
    if (!ENVELOPE_FIELDS.includes(key) && !spec.required.includes(key) && !spec.optional.includes(key))
      return usage(id, `${type} does not accept the field "${key}"`);
  for (const key of spec.required) if (!Object.prototype.hasOwnProperty.call(raw, key)) return usage(id, `${type} requires the field "${key}"`);
  return validateFields(id, type as RequestType, raw);
}

function validateFields(id: string, type: RequestType, r: Record<string, unknown>): ParsedLine {
  const str = (key: string, max?: number): string | ParsedLine => {
    const v = r[key];
    if (typeof v !== "string") return usage(id, `${type}.${key} must be a string`);
    if (max !== undefined && (v.length === 0 || v.length > max)) return usage(id, `${type}.${key} must be 1-${max} characters`);
    return v;
  };
  const isErr = (v: unknown): v is ParsedLine => typeof v === "object" && v !== null && "ok" in v;
  const ok = (request: StdioRequest): ParsedLine => ({ ok: true, request });
  switch (type) {
    case "send": {
      const text = str("text");
      if (isErr(text)) return text;
      const problem = channelProblem(r.channel);
      if (problem) return usage(id, `send.channel ${problem}`);
      const mentions = r.mentions ?? [];
      if (!Array.isArray(mentions) || mentions.some((m) => typeof m !== "string" || m.length === 0 || m.length > MAX_NAME_LENGTH))
        return usage(id, `send.mentions must be an array of names of 1-${MAX_NAME_LENGTH} characters`);
      return ok({ type, id, text, channel: r.channel as string, mentions: mentions as string[] });
    }
    case "dm": {
      const to = str("to", MAX_DM_TARGET);
      if (isErr(to)) return to;
      const text = str("text");
      if (isErr(text)) return text;
      if (r.replyTo !== undefined) {
        const replyTo = str("replyTo", MAX_MESSAGE_ID);
        if (isErr(replyTo)) return replyTo;
        return ok({ type, id, to, text, replyTo });
      }
      return ok({ type, id, to, text });
    }
    case "anycast": {
      const role = str("role");
      if (isErr(role)) return role;
      try {
        assertValidRole(role);
      } catch (e) {
        return usage(id, (e as Error).message);
      }
      const text = str("text");
      if (isErr(text)) return text;
      return ok({ type, id, role, text });
    }
    case "status": {
      const status = r.status;
      if (status !== "idle" && status !== "working" && status !== "waiting")
        return usage(id, "status.status must be idle, working or waiting");
      const activity = r.activity;
      if (activity !== undefined && typeof activity !== "string") return usage(id, "status.activity must be a string");
      return ok({ type, id, status, ...(activity !== undefined ? { activity } : {}) });
    }
    case "attention": {
      const mode = r.mode;
      if (mode !== "open" && mode !== "dnd" && mode !== "focus") return usage(id, "attention.mode must be open, dnd or focus");
      return ok({ type, id, mode });
    }
    case "channelMode": {
      const problem = channelProblem(r.channel);
      if (problem) return usage(id, `channelMode.channel ${problem}`);
      const mode = r.mode;
      if (mode !== "normal" && mode !== "quiet" && mode !== "muted") return usage(id, "channelMode.mode must be normal, quiet or muted");
      return ok({ type, id, channel: r.channel as string, mode });
    }
    case "join":
    case "leave":
    case "channelInfo": {
      const problem = channelProblem(r.channel);
      if (problem) return usage(id, `${type}.channel ${problem}`);
      return ok({ type, id, channel: r.channel as string });
    }
    case "inbox": {
      if (r.peek !== undefined && typeof r.peek !== "boolean") return usage(id, "inbox.peek must be a boolean");
      return ok({ type, id, peek: r.peek === true });
    }
    case "roster":
    case "connection":
      return ok({ type, id });
    case "invoke": {
      const endpoint = str("endpoint", 200);
      if (isErr(endpoint)) return endpoint;
      const command = str("command", 128);
      if (isErr(command)) return command;
      if (r.args !== undefined && !isPlainObject(r.args)) return usage(id, "invoke.args must be a JSON object");
      const t = r.timeoutMs ?? INVOKE_DEFAULT_TIMEOUT_MS;
      if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > INVOKE_MAX_TIMEOUT_MS)
        return usage(id, `invoke.timeoutMs must be an integer of 1-${INVOKE_MAX_TIMEOUT_MS}`);
      return ok({ type, id, endpoint, command, ...(r.args !== undefined ? { args: r.args as Record<string, unknown> } : {}), timeoutMs: t });
    }
  }
}

// ---- output records -------------------------------------------------------------------------

export type ResultOutcome = "ok" | "stored" | "refused" | "unknown" | "failed";

export interface ResultRecord {
  readonly schemaVersion: 1;
  readonly type: "result";
  readonly id: string;
  readonly outcome: ResultOutcome;
  readonly result?: unknown;
  readonly error?: ProtocolError;
}

export type OutputRecord =
  | ResultRecord
  | { readonly schemaVersion: 1; readonly type: "message"; readonly message: MessageRecord }
  | { readonly schemaVersion: 1; readonly type: "presence"; readonly change: "joined" | "updated" | "left"; readonly row: unknown }
  | { readonly schemaVersion: 1; readonly type: "gap"; readonly scope: string; readonly reason: string }
  | { readonly schemaVersion: 1; readonly type: "error"; readonly id: null; readonly error: ProtocolError }
  | { readonly schemaVersion: 1; readonly type: "end"; readonly reason: string; readonly close?: CloseReport };

/** A received message as a program reads it. The delivery key is internal and never exported. */
export type MessageRecord = Omit<SessionMessage, "deliveryKey">;

export function messageRecord(m: SessionMessage): MessageRecord {
  const { deliveryKey: _key, ...rest } = m;
  return rest;
}

/** Serialize one record as one line. JSON escapes every control character, so a hostile message
 *  body can never start a second record. */
export function serializeRecord(record: OutputRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function fromPublish(id: string, r: PublishResult): ResultRecord {
  if (r.outcome === "stored") {
    const { outcome: _o, ...result } = r;
    return { schemaVersion: 1, type: "result", id, outcome: "stored", result };
  }
  if (r.outcome === "refused")
    return { schemaVersion: 1, type: "result", id, outcome: "refused", error: { code: r.code, message: r.message, ...(r.native ? { cause: r.native } : {}) } };
  return { schemaVersion: 1, type: "result", id, outcome: "unknown", error: { code: "OPERATION_UNKNOWN", message: r.message } };
}

function fromResult<T>(id: string, r: Result<T>, map: (v: T) => unknown = (v) => v): ResultRecord {
  switch (r.outcome) {
    case "ok":
      return { schemaVersion: 1, type: "result", id, outcome: "ok", result: map(r.value) ?? null };
    case "refused":
      return { schemaVersion: 1, type: "result", id, outcome: "refused", error: { code: r.code, message: r.message, ...(r.native ? { cause: r.native } : {}) } };
    case "unknown":
      return { schemaVersion: 1, type: "result", id, outcome: "unknown", error: { code: "OPERATION_UNKNOWN", message: r.message } };
    case "failed":
      return { schemaVersion: 1, type: "result", id, outcome: "failed", error: { code: "OPERATION_FAILED", message: r.message } };
  }
}

/** Run one validated request against the session and return its result record. */
export async function dispatch(session: AdmittedChatSession, req: StdioRequest): Promise<{ record: ResultRecord; surfaced: readonly string[] }> {
  const none: readonly string[] = [];
  switch (req.type) {
    case "send":
      return { record: fromPublish(req.id, await session.send(req.text, req.channel, req.mentions)), surfaced: none };
    case "dm":
      return { record: fromPublish(req.id, await session.dm(req.to, req.text, req.replyTo)), surfaced: none };
    case "anycast":
      return { record: fromPublish(req.id, await session.anycast(req.role, req.text)), surfaced: none };
    case "status":
      return { record: fromResult(req.id, await session.setStatus(req.status, req.activity)), surfaced: none };
    case "attention":
      return { record: fromResult(req.id, await session.setAttention(req.mode)), surfaced: none };
    case "channelMode":
      return { record: fromResult(req.id, await session.setChannelMode(req.channel, req.mode)), surfaced: none };
    case "join":
      return { record: fromResult(req.id, await session.join(req.channel)), surfaced: none };
    case "leave":
      return { record: fromResult(req.id, await session.leave(req.channel)), surfaced: none };
    case "inbox": {
      const r = await session.inbox(req.peek);
      // A drained (non-peek) read is acknowledged only after its record is written.
      const keys = r.outcome === "ok" && !req.peek ? r.value.map((m) => m.deliveryKey) : none;
      return { record: fromResult(req.id, r, (items) => ({ peek: req.peek, messages: items.map(messageRecord) })), surfaced: keys };
    }
    case "roster":
      return { record: fromResult(req.id, await session.roster()), surfaced: none };
    case "channelInfo":
      return { record: fromResult(req.id, await session.channelInfo(req.channel)), surfaced: none };
    case "connection":
      return { record: fromResult(req.id, await session.connection()), surfaced: none };
    case "invoke":
      return { record: fromResult(req.id, await session.invoke(req.endpoint, req.command, req.args, req.timeoutMs)), surfaced: none };
  }
}

// ---- the driver -----------------------------------------------------------------------------

/**
 * One `--stdio` run over one admitted session. The caller feeds complete lines (without the
 * trailing newline) and signals end of input; `write` puts one serialized record on stdout. All
 * other diagnostics belong on stderr, never through `write`.
 */
export class StdioParticipant {
  private chain: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<string>();
  private ended = false;
  /** Set the moment an end is decided, before close runs, so every later request is refused
   *  (with a result, before the end record) rather than queued behind the close. */
  private closing = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: AdmittedChatSession,
    private readonly write: (line: string) => void,
    /** Called once, after the `end` record is written, whatever ended the session. The stdin
     *  driver uses it to stop reading when the session ends on its own. */
    private readonly onEnd: (close: CloseReport) => void = () => {},
  ) {
    this.unsubscribe = session.subscribe((event) => this.onEvent(event));
  }

  /** Queue one input line. Blank lines are ignored. After the end record nothing is written. */
  acceptLine(line: string): void {
    if (this.ended || line.trim() === "") return;
    const parsed = parseRequestLine(line);
    if (!parsed.ok) {
      this.emitRefusal(parsed.id, parsed.error);
      return;
    }
    const req = parsed.request;
    if (this.closing) {
      this.emitRefusal(req.id, { code: "LIFECYCLE_BLOCKED", message: "the session is ending; no new requests are accepted" });
      return;
    }
    if (this.inFlight.has(req.id)) {
      this.emitRefusal(req.id, { code: "USAGE_INVALID", message: `request id ${JSON.stringify(req.id)} is already in flight` });
      return;
    }
    this.inFlight.add(req.id);
    this.chain = this.chain.then(async () => {
      try {
        const { record, surfaced } = await dispatch(this.session, req);
        this.emit(record);
        // Acknowledged once the record is handed to the stdout writer (the surfacing boundary).
        if (surfaced.length) this.session.surfaced(surfaced);
      } catch (e) {
        // An adapter must classify; a throw means the effect may or may not have happened.
        this.emit({ schemaVersion: 1, type: "result", id: req.id, outcome: "unknown", error: { code: "OPERATION_UNKNOWN", message: (e as Error).message } });
      } finally {
        this.inFlight.delete(req.id);
      }
    });
  }

  /** stdin closed: finish already accepted requests in order, close the session, then write the end record. */
  async endOfInput(): Promise<CloseReport | undefined> {
    this.closing = true;
    await this.chain;
    return this.finish("input closed");
  }

  private async finish(reason: string): Promise<CloseReport | undefined> {
    if (this.ended) return undefined;
    this.ended = true;
    this.unsubscribe();
    let close: CloseReport;
    try {
      close = await this.session.close();
    } catch (e) {
      close = { retirement: "unknown", connectionClosed: "not-confirmed", message: (e as Error).message };
    }
    this.emit({ schemaVersion: 1, type: "end", reason, close });
    this.onEnd(close);
    return close;
  }

  private onEvent(event: SessionEvent): void {
    if (this.ended) return;
    switch (event.type) {
      case "message":
        this.emit({ schemaVersion: 1, type: "message", message: messageRecord(event.message) });
        // Acknowledged once its record has been handed to stdout.
        this.session.surfaced([event.message.deliveryKey]);
        return;
      case "presence":
        this.emit({ schemaVersion: 1, type: "presence", change: event.change, row: event.row });
        return;
      case "gap":
        this.emit({ schemaVersion: 1, type: "gap", scope: event.scope, reason: event.reason });
        return;
      case "connection":
        if (event.state === "disconnected" || event.state === "reconnecting")
          this.emit({ schemaVersion: 1, type: "gap", scope: "live", reason: event.reason ?? `connection ${event.state}: live channel messages may be missed until it returns` });
        else if (event.state === "ended") {
          this.closing = true;
          void this.chain.then(() => this.finish(event.reason ?? "session ended"));
        }
        return;
    }
  }

  private emitRefusal(id: string | null, error: ProtocolError): void {
    if (id === null) this.emit({ schemaVersion: 1, type: "error", id: null, error });
    else this.emit({ schemaVersion: 1, type: "result", id, outcome: "refused", error });
  }

  private emit(record: OutputRecord): void {
    this.write(serializeRecord(record));
  }
}

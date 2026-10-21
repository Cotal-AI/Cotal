/**
 * The connector side of a service relay (SD2-P r4), as an INERT engine.
 *
 * NOTHING WIRES THIS IN YET. No production module imports it, the package barrel does not export it,
 * and it owns no timer, connection, configuration or host adapter. Every edge is a port a later
 * integration supplies, and each of those integrations is unfinished:
 * - the native self-mode request ({@link ServiceRelayHost.invoke});
 * - the authorized endpoint and its verified pin, from a caller-scoped describe this engine never
 *   performs: it does not enumerate endpoints, read a relay marker or decide a grant;
 * - the host's own frame verdict ({@link ServiceRelay.commit}), the only thing that makes an item
 *   delivered;
 * - the cadence: the existing turn-poll interval would call {@link ServiceRelay.poll}.
 *
 * The service holds the durable state, per caller lifecycle UID. This engine holds only what one
 * process needs between polls: the one data item it holds, one unreported outcome, and which control
 * items a frame verdict delivered. It claims no stop, yields nothing and knows no product.
 */
import { attributionSafe, fmtBody } from "./framing.js";

/** The longest a frame-path read may wait: the hook handler's budget (r4 §4.3). */
export const RELAY_HOOK_READ_MS = 3_000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A lone surrogate is not I-JSON, so text carrying one is refused rather than rendered. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const REQUEST_MAX = 4_096;
const CONTROL_ITEMS = 16;
const CONTROL_ITEM_MAX = 1_024;
const DATA_MAX = 65_536;
const HELD_MAX = 512;
const REASON_MAX = 256;
const REPLY_MAX = 98_304;
/** The stock hook rail's label for a delivery whose confirmation was lost, so both read the same. */
const REPEAT_NOTE = "(A previous delivery of one or more of these was not confirmed, so they may be a repeat.)";

const encoder = new TextEncoder();
/** Every relay bound is on the serialized JSON (r4 §2), so escaping cannot exceed it. */
const serialized = (v: unknown): number => encoder.encode(JSON.stringify(v)).length;

/**
 * The verified binding one relay runs under: the full caller identity and the grant and contract it
 * was discovered with. The identity is local only. It names whose relay this is so a reply or a
 * verdict for another binding can be recognized, and no relay body ever carries it: the broker fixes
 * the caller in the request subject.
 */
export interface RelayPin {
  readonly space: string;
  readonly owner: string;
  readonly actor: string;
  readonly lifecycleUid: string;
  readonly grantId: string;
  readonly approvalDigest: string;
  readonly endpoint: string;
  /** The endpoint's current contract digest, sent on every poll. */
  readonly contract: string;
  /** The endpoint's `relay.poll` command. */
  readonly poll: string;
  /** The endpoint's `relay.read` command. */
  readonly read: string;
}
const PIN_FIELDS = ["space", "owner", "actor", "lifecycleUid", "grantId", "approvalDigest", "endpoint", "contract", "poll", "read"] as const satisfies readonly (keyof RelayPin)[];

/** One relay request's outcome, normalized by the port. The port maps the wire refusal details to
 *  `reason`; this engine names no detail kind. */
export type RelayCall =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: string; readonly reason?: "contract" | "cursor" | "live"; readonly current?: string; readonly message: string };

/** One item a frame carried. The two sequences share one id grammar, so the sequence is part of the
 *  reference. */
export interface RelayRef {
  readonly seq: "control" | "data";
  readonly id: string;
}

/** What one {@link ServiceRelay.peek} surfaced. Its identity correlates the host's verdict to this
 *  frame, and its generation makes a verdict for a replaced pin a no-op. */
export interface RelayFrame {
  readonly generation: number;
  readonly refs: readonly RelayRef[];
}

export interface ServiceRelayHost {
  /** One native self-mode request on the pinned endpoint. `pin` and `generation` are the ones the
   *  request started under; a reply that returns after the pin changed is discarded unread. */
  invoke(call: { readonly pin: RelayPin; readonly generation: number; readonly command: string; readonly args: Record<string, unknown>; readonly deadlineMs: number }): Promise<RelayCall>;
  /** Ask for the host's next injectable frame. Called only when a poll brought something new. */
  wake(): void;
  /** A discovery trigger fired (r4 §3). Nothing is sent until the integration re-pins. */
  refresh(reason: "contract" | "permission"): void;
  log(line: string): void;
}

export interface ServiceRelayCounts {
  polls: number;
  /** Answered polls that brought nothing new, so woke nothing. */
  emptyPolls: number;
  wakes: number;
  /** Requests that did not complete and are sent again unchanged. */
  retries: number;
  readTimeouts: number;
  resyncs: number;
  staleReplies: number;
  staleCommits: number;
  malformed: number;
  refreshes: number;
  /** Answered polls that carried control items while a data item was held. */
  controlWhileHeld: number;
  repeatFrames: number;
}

export interface ServiceRelayStatus {
  readonly active: boolean;
  readonly inactive?: string;
  readonly paused: boolean;
  readonly refreshing: boolean;
  readonly generation: number;
  readonly held?: string;
  readonly unreported?: string;
  readonly controlWaiting: number;
}

type Resolution = { readonly item: string; readonly outcome: "delivered" | "skipped"; readonly reason?: string };
type DataArm = { readonly after: string | null } | { readonly resolved: Resolution };
interface PollRequest {
  readonly contract: string;
  readonly control: { readonly after: string | null };
  readonly data?: DataArm;
  readonly held?: string;
}
interface ControlItem { readonly id: string; readonly class: "priority" | "notice"; readonly text: string }
interface DataOffer { readonly id: string; readonly kind: "notice" | "deferred"; readonly text?: string; readonly repeat: boolean }
interface HeldState { readonly id: string; readonly state: "live" | "withdrawn"; readonly reason?: string }
interface PollReply { readonly control: readonly ControlItem[]; readonly data?: DataOffer; readonly held?: HeldState }

interface ControlEntry { readonly item: ControlItem; delivered: boolean; unconfirmed: boolean }
interface Head { readonly offer: DataOffer; body?: string; unconfirmed: boolean }

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const unknownField = (o: Record<string, unknown>, allowed: readonly string[]): string | undefined => Object.keys(o).find((k) => !allowed.includes(k));
const wellFormed = (v: unknown): v is string => typeof v === "string" && !LONE_SURROGATE.test(v);
const boundedReason = (v: unknown): v is string => wellFormed(v) && serialized(v) <= REASON_MAX;

function controlItem(v: unknown): ControlItem | string {
  if (!record(v)) return "a control item is not an object";
  const extra = unknownField(v, ["id", "class", "text"]);
  if (extra !== undefined) return `a control item carries unknown field ${extra}`;
  if (typeof v.id !== "string" || !ID.test(v.id)) return "a control item id is malformed";
  if (v.class !== "priority" && v.class !== "notice") return `control item ${v.id} has an unknown class`;
  if (!wellFormed(v.text)) return `control item ${v.id} has no well-formed text`;
  if (serialized(v) > CONTROL_ITEM_MAX) return `control item ${v.id} exceeds ${CONTROL_ITEM_MAX} bytes`;
  return { id: v.id, class: v.class, text: v.text };
}

function dataOffer(v: unknown): DataOffer | string {
  if (!record(v)) return "the data item is not an object";
  const extra = unknownField(v, ["id", "kind", "text", "repeat"]);
  if (extra !== undefined) return `the data item carries unknown field ${extra}`;
  if (typeof v.id !== "string" || !ID.test(v.id)) return "the data item id is malformed";
  if (typeof v.repeat !== "boolean") return `data item ${v.id} has no repeat flag`;
  const kind = v.kind;
  if (kind !== "notice" && kind !== "deferred") return `data item ${v.id} has an unknown kind`;
  // A notice carries its text; a deferred item is released only through relay.read.
  if (kind === "notice" ? !wellFormed(v.text) : v.text !== undefined) return `data item ${v.id} does not match its kind`;
  if (serialized(v) > DATA_MAX) return `data item ${v.id} exceeds ${DATA_MAX} bytes`;
  return { id: v.id, kind, ...(v.text !== undefined ? { text: v.text as string } : {}), repeat: v.repeat };
}

function heldState(v: unknown, held: string): HeldState | string {
  if (!record(v)) return "the held state is not an object";
  const extra = unknownField(v, ["id", "state", "reason"]);
  if (extra !== undefined) return `the held state carries unknown field ${extra}`;
  if (v.id !== held) return "the held state names another item than the one held";
  if (v.state !== "live" && v.state !== "withdrawn") return "the held state is neither live nor withdrawn";
  if (v.reason !== undefined && !boundedReason(v.reason)) return `the held reason exceeds ${REASON_MAX} bytes`;
  if (serialized(v) > HELD_MAX) return `the held state exceeds ${HELD_MAX} bytes`;
  return { id: held, state: v.state, ...(v.reason !== undefined ? { reason: v.reason as string } : {}) };
}

/** A closed, request-correlated reply: held state answers only a held request, a data item only a
 *  data request, and never both. Anything else is refused whole and applies nothing. */
function pollReply(raw: unknown, request: PollRequest): PollReply | string {
  if (!record(raw)) return "the reply is not an object";
  if (serialized(raw) > REPLY_MAX) return `the reply exceeds ${REPLY_MAX} bytes`;
  const extra = unknownField(raw, ["control", "data", "held"]);
  if (extra !== undefined) return `the reply carries unknown field ${extra}`;
  if (!Array.isArray(raw.control)) return "the reply has no control list";
  if (raw.control.length > CONTROL_ITEMS) return `the reply carries more than ${CONTROL_ITEMS} control items`;
  const control: ControlItem[] = [];
  for (const v of raw.control) {
    const item = controlItem(v);
    if (typeof item === "string") return item;
    if (control.some((c) => c.id === item.id)) return `control item ${item.id} appears twice`;
    control.push(item);
  }
  if (request.held !== undefined) {
    if (Object.hasOwn(raw, "data")) return "a data item answered a held request";
    if (!Object.hasOwn(raw, "held")) return "a held request was answered without its held state";
    const held = heldState(raw.held, request.held);
    return typeof held === "string" ? held : { control, held };
  }
  if (Object.hasOwn(raw, "held")) return "held state answered a request that held nothing";
  if (!Object.hasOwn(raw, "data")) return { control };
  const data = dataOffer(raw.data);
  return typeof data === "string" ? data : { control, data };
}

function readReply(raw: unknown): { text: string } | { withdrawn: string } | string {
  if (!record(raw)) return "the read reply is not an object";
  const keys = Object.keys(raw);
  if (keys.length !== 1) return "the read reply is neither text nor withdrawn";
  if (keys[0] === "text") {
    if (!wellFormed(raw.text)) return "the read text is not well-formed";
    return serialized(raw) > DATA_MAX ? `the read reply exceeds ${DATA_MAX} bytes` : { text: raw.text };
  }
  if (keys[0] === "withdrawn") return boundedReason(raw.withdrawn) ? { withdrawn: raw.withdrawn } : `the withdrawn reason exceeds ${REASON_MAX} bytes`;
  return `the read reply carries unknown field ${keys[0]}`;
}

function pinProblem(pin: RelayPin): string | undefined {
  for (const k of PIN_FIELDS) if (typeof pin[k] !== "string" || pin[k].length === 0) return `pin field ${k} is empty`;
  return pin.poll === pin.read ? "the poll and read commands are the same command" : undefined;
}

const samePin = (a: RelayPin, b: RelayPin): boolean => PIN_FIELDS.every((k) => a[k] === b[k]);

function finiteDeadline(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`a relay request needs a finite positive deadline, not ${ms}`);
}

export class ServiceRelay {
  private pin: RelayPin | undefined;
  private inactiveReason: string | undefined;
  private generation = 0;
  private paused = false;
  private refreshing = false;
  private control: ControlEntry[] = [];
  private controlResync = false;
  private head: Head | undefined;
  private resolution: Resolution | undefined;
  private dataAfter: string | null = null;
  private pollingGeneration: number | undefined;
  private readingGeneration: number | undefined;
  private issued = new WeakSet<RelayFrame>();
  private lastTrouble: string | undefined;
  private readonly tally: ServiceRelayCounts = {
    polls: 0, emptyPolls: 0, wakes: 0, retries: 0, readTimeouts: 0, resyncs: 0, staleReplies: 0,
    staleCommits: 0, malformed: 0, refreshes: 0, controlWhileHeld: 0, repeatFrames: 0,
  };

  constructor(private readonly host: ServiceRelayHost) {}

  /**
   * Bind, re-verify or deactivate. An IDENTICAL verified pin after a disconnect or a renewal keeps
   * everything held and answers a pending refresh. Any other pin, a missing one or an inactive
   * reason replaces the generation: the held item and every unreported outcome go without a report,
   * and the next poll resumes from the service's position. A half-provisioned binding is passed as
   * `{ inactive }` and refuses loudly.
   */
  setPin(next: RelayPin | { readonly inactive: string } | undefined): void {
    if (next !== undefined && !("inactive" in next)) {
      const problem = pinProblem(next);
      if (problem === undefined && this.pin !== undefined && samePin(this.pin, next)) {
        this.refreshing = false;
        return;
      }
      this.reset();
      if (problem !== undefined) return this.deactivate(problem);
      this.pin = Object.freeze(Object.fromEntries(PIN_FIELDS.map((k) => [k, next[k]])) as unknown as RelayPin);
      this.inactiveReason = undefined;
      return;
    }
    this.reset();
    this.deactivate(next === undefined ? "no relay pin" : next.inactive);
  }

  /** Transport lost: nothing is sent, surfaced or claimed, and nothing held is discarded. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /**
   * One `relay.poll`. The caller's existing cadence calls it; it schedules nothing. Control is
   * learned on every poll, whatever the data item's state. An answered poll that brought nothing new
   * wakes nothing.
   */
  async poll(deadlineMs: number): Promise<void> {
    finiteDeadline(deadlineMs);
    const pin = this.pin;
    if (pin === undefined || this.paused || this.refreshing || this.pollingGeneration === this.generation) return;
    const generation = this.generation;
    const request = this.request(pin);
    if (serialized(request) > REQUEST_MAX) return this.trouble(`a relay.poll request exceeds ${REQUEST_MAX} bytes`);
    this.pollingGeneration = generation;
    this.tally.polls += 1;
    try {
      const r = await this.call(pin, generation, pin.poll, request as unknown as Record<string, unknown>, deadlineMs);
      if (generation !== this.generation) {
        this.tally.staleReplies += 1;
        return;
      }
      if (!r.ok) return this.refused(r, "poll");
      const reply = pollReply(r.data, request);
      if (typeof reply === "string") {
        this.tally.malformed += 1;
        return this.trouble(`malformed relay.poll reply: ${reply}`);
      }
      this.apply(request, reply);
    } finally {
      if (this.pollingGeneration === generation) this.pollingGeneration = undefined;
    }
  }

  /**
   * Read the held deferred item with `relay.read`, bounded. On the hook path the bound is at most
   * {@link RELAY_HOOK_READ_MS}. A read that times out leaves the item held for a later frame, never
   * skipped, and its late reply is discarded; the next prepare reads again.
   */
  async prepare(deadlineMs: number, path: "hook" | "wake"): Promise<void> {
    finiteDeadline(deadlineMs);
    const ms = path === "hook" ? Math.min(deadlineMs, RELAY_HOOK_READ_MS) : deadlineMs;
    const pin = this.pin, head = this.head;
    if (pin === undefined || this.paused || this.refreshing || this.readingGeneration === this.generation) return;
    if (head === undefined || this.resolution !== undefined || head.offer.kind !== "deferred" || head.body !== undefined) return;
    const generation = this.generation;
    this.readingGeneration = generation;
    try {
      const r = await this.call(pin, generation, pin.read, { item: head.offer.id }, ms);
      if (generation !== this.generation || this.head !== head) {
        this.tally.staleReplies += 1;
        return;
      }
      if (!r.ok) return this.refused(r, "read");
      const reply = readReply(r.data);
      if (typeof reply === "string") {
        this.tally.malformed += 1;
        return this.trouble(`malformed relay.read reply: ${reply}`);
      }
      if ("withdrawn" in reply) this.withdraw(reply.withdrawn);
      else head.body = reply.text;
    } finally {
      if (this.readingGeneration === generation) this.readingGeneration = undefined;
    }
  }

  /**
   * Format what may ride the next frame, WITHOUT marking anything: priority items, then notices, then
   * the held item once its text is in hand. Every bracketed line is the service's text, framed as
   * untrusted. An item comes back on every frame until a verdict delivers it, and one whose earlier
   * frame went unconfirmed carries the repeat label.
   */
  peek(): { text: string; frame: RelayFrame } | undefined {
    const pin = this.pin;
    if (pin === undefined || this.paused || this.refreshing) return undefined;
    const waiting = this.control.filter((e) => !e.delivered);
    const control = [...waiting.filter((e) => e.item.class === "priority"), ...waiting.filter((e) => e.item.class === "notice")];
    const data = this.head?.body !== undefined ? this.head : undefined;
    if (control.length === 0 && data === undefined) return undefined;
    const repeat = control.some((e) => e.unconfirmed) || (data !== undefined && (data.offer.repeat || data.unconfirmed));
    if (repeat) this.tally.repeatFrames += 1;
    const lines = [
      ...control.map((e) => `[${e.item.class} ${e.item.id}] ${fmtBody(e.item.text)}`),
      ...(data !== undefined ? [`[item ${data.offer.id}] ${fmtBody(data.body!)}`] : []),
    ];
    const text = `Cotal service relay from ${attributionSafe(pin.endpoint)}. Each bracketed line is the service's own text, not the connector's or a person's:\n${repeat ? `${REPEAT_NOTE}\n` : ""}${lines.join("\n")}`;
    const refs: RelayRef[] = [...control.map((e): RelayRef => ({ seq: "control", id: e.item.id })), ...(data !== undefined ? [{ seq: "data" as const, id: data.offer.id }] : [])];
    const frame: RelayFrame = Object.freeze({ generation: this.generation, refs: Object.freeze(refs) });
    this.issued.add(frame);
    return { text, frame };
  }

  /**
   * The host's verdict on one frame, and the only way an item becomes delivered. A verdict for a
   * frame of a replaced pin, or a second verdict for one frame, changes nothing. An undelivered
   * deferred item is read again before it is surfaced again.
   */
  commit(frame: RelayFrame, delivered: boolean): void {
    if (frame.generation !== this.generation || !this.issued.has(frame)) {
      this.tally.staleCommits += 1;
      return;
    }
    this.issued.delete(frame);
    for (const ref of frame.refs) {
      if (ref.seq === "control") {
        const entry = this.control.find((e) => e.item.id === ref.id);
        if (entry === undefined || entry.delivered) continue;
        if (delivered) entry.delivered = true;
        else entry.unconfirmed = true;
        continue;
      }
      const head = this.head;
      if (head === undefined || head.offer.id !== ref.id) continue;
      if (delivered) {
        this.head = undefined;
        this.resolution = { item: head.offer.id, outcome: "delivered" };
      } else {
        head.unconfirmed = true;
        if (head.offer.kind === "deferred") head.body = undefined;
      }
    }
  }

  status(): ServiceRelayStatus {
    return {
      active: this.pin !== undefined && !this.refreshing,
      ...(this.inactiveReason !== undefined ? { inactive: this.inactiveReason } : {}),
      paused: this.paused,
      refreshing: this.refreshing,
      generation: this.generation,
      ...(this.head !== undefined ? { held: this.head.offer.id } : {}),
      ...(this.resolution !== undefined ? { unreported: this.resolution.item } : {}),
      controlWaiting: this.control.filter((e) => !e.delivered).length,
    };
  }

  counts(): Readonly<ServiceRelayCounts> {
    return { ...this.tally };
  }

  private request(pin: RelayPin): PollRequest {
    const control = { after: this.controlAfter() };
    if (this.resolution !== undefined) return { contract: pin.contract, control, data: { resolved: this.resolution } };
    if (this.head !== undefined) return { contract: pin.contract, control, held: this.head.offer.id };
    return { contract: pin.contract, control, data: { after: this.dataAfter } };
  }

  /** The acknowledgement this poll sends: the end of the CONTIGUOUS delivered prefix, in the order
   *  the service listed the items. A later delivered item never acknowledges an earlier one still
   *  waiting, and an id has no order of its own. `null` resumes from the service's position. */
  private controlAfter(): string | null {
    if (this.controlResync) return null;
    let after: string | null = null;
    for (const entry of this.control) {
      if (!entry.delivered) break;
      after = entry.item.id;
    }
    return after;
  }

  private apply(request: PollRequest, reply: PollReply): void {
    this.lastTrouble = undefined;
    this.controlResync = false;
    // The reply lists every unacknowledged control item, in the service's order. It replaces the
    // local list; what this process learned about an item it still lists is kept by id.
    const known = new Map(this.control.map((e) => [e.item.id, e]));
    let fresh = 0;
    this.control = reply.control.map((item) => {
      const kept = known.get(item.id);
      if (kept !== undefined) return kept;
      fresh += 1;
      return { item, delivered: false, unconfirmed: false };
    });
    if (request.held !== undefined && reply.control.length > 0) this.tally.controlWhileHeld += 1;
    if (request.data !== undefined) {
      if ("resolved" in request.data) {
        this.dataAfter = request.data.resolved.item;
        this.resolution = undefined;
      }
      if (reply.data !== undefined) {
        this.head = { offer: reply.data, unconfirmed: false, ...(reply.data.kind === "notice" ? { body: reply.data.text } : {}) };
        fresh += 1;
      }
    } else if (reply.held?.state === "withdrawn") this.withdraw(reply.held.reason ?? "withdrawn");
    if (fresh === 0) {
      this.tally.emptyPolls += 1;
      return;
    }
    this.tally.wakes += 1;
    this.host.wake();
  }

  /** The service ended this item's authority. It is never surfaced again, a verdict for a frame that
   *  already carried it changes nothing, and `skipped` is reported only for this withdrawn item. */
  private withdraw(reason: string): void {
    const head = this.head;
    if (head === undefined) return;
    this.head = undefined;
    this.resolution = { item: head.offer.id, outcome: "skipped", reason };
  }

  private refused(r: Extract<RelayCall, { ok: false }>, op: "poll" | "read"): void {
    if (r.code === "failed-precondition" && r.reason === "contract") return this.triggerRefresh("contract", r.message);
    if (r.code === "permission-denied") return this.triggerRefresh("permission", r.message);
    if (r.code === "conflict" || (r.code === "failed-precondition" && (r.reason === "cursor" || r.reason === "live"))) return this.resync(r);
    if (op === "read" && r.code === "deadline-exceeded") this.tally.readTimeouts += 1;
    else this.tally.retries += 1;
    this.trouble(`relay.${op} did not complete (${r.code}): ${r.message}`);
  }

  /**
   * The service's position is the truth. Both cursors resume from it, and the held item and any
   * unreported outcome are cleared, so a `skipped` the service refused is never treated as accepted.
   * This is how a service-side withdrawal that won the race against this process's `skipped`
   * recovers. Control verdicts are kept by id: the next reply lists those items again.
   */
  private resync(r: Extract<RelayCall, { ok: false }>): void {
    this.tally.resyncs += 1;
    this.dataAfter = null;
    this.head = undefined;
    this.resolution = undefined;
    this.controlResync = true;
    this.trouble(`relay cursor resync after ${r.code}${r.reason !== undefined ? ` (${r.reason})` : ""}`);
  }

  private triggerRefresh(reason: "contract" | "permission", message: string): void {
    this.refreshing = true;
    this.tally.refreshes += 1;
    this.trouble(`relay waits for discovery after a ${reason} refusal: ${message}`);
    this.host.refresh(reason);
  }

  private reset(): void {
    this.generation += 1;
    this.pin = undefined;
    this.refreshing = false;
    this.control = [];
    this.controlResync = false;
    this.head = undefined;
    this.resolution = undefined;
    this.dataAfter = null;
    this.issued = new WeakSet();
    this.lastTrouble = undefined;
  }

  private deactivate(reason: string): void {
    this.inactiveReason = reason;
    this.host.log(`relay inactive: ${reason}`);
  }

  /** Said once per distinct reason, as the turn pull does: the poll runs for the life of a session. */
  private trouble(reason: string): void {
    if (this.lastTrouble === reason) return;
    this.lastTrouble = reason;
    this.host.log(reason);
  }

  /** The port's own deadline is not trusted to end the wait: this one does, and a reply after it is
   *  discarded. */
  private async call(pin: RelayPin, generation: number, command: string, args: Record<string, unknown>, deadlineMs: number): Promise<RelayCall> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<RelayCall>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, code: "deadline-exceeded", message: `${command} did not answer within ${deadlineMs}ms` }), deadlineMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const answered = Promise.resolve()
      .then(() => this.host.invoke({ pin, generation, command, args, deadlineMs }))
      .catch((e: unknown): RelayCall => ({ ok: false, code: "unavailable", message: e instanceof Error ? e.message : String(e) }));
    try {
      return await Promise.race([answered, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}

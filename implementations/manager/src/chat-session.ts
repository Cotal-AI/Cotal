/**
 * Static chat sessions (S mode): the manager-mediated admission for a live human or program
 * session on a static-auth mesh. The manager draws the alias, mints the session's own leaf over the
 * native static activation and provisioning, and retires it through the native static terminal.
 * This module holds the pure rules those two handlers share, the sealed admission payload, and the
 * tracker that retires a session nobody retired; it reads and writes no store itself.
 *
 * The wire authority of a session is its incarnation-unique nkey (`actor`). The `chat_` alias is
 * routing only: it keys the durable slot row and is never a caller input at open.
 */
import { randomBytes } from "node:crypto";
import { assertValidChannel, isCurvePublicKey, resolveReadAcl, sealJson, type EpErrorCode, type StaticManagedSlotRow } from "@cotal-ai/core";

/** Every static chat alias starts with this. An ordinary spawn refuses any name that does. */
export const CHAT_ALIAS_PREFIX = "chat_";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const CHAT_ALIAS = /^chat_[a-z2-7]{26}$/;

/** Draw a fresh `chat_<26 base32>` alias (130 random bits). 256 is a multiple of 32, so masking each
 *  byte keeps every symbol uniform. */
export function drawChatAlias(): string {
  return CHAT_ALIAS_PREFIX + Array.from(randomBytes(26), (b) => BASE32[b & 31]).join("");
}

/** Whether `name` has the exact shape {@link drawChatAlias} produces. */
export function isChatAlias(name: string): boolean {
  return CHAT_ALIAS.test(name);
}

/** A `chat-session-open` request, as {@link readChatOpenInput} reads it. */
export interface ChatSessionOpenInput {
  subscribe?: string[];
  allowSubscribe?: string[];
  allowPublish?: string[];
  label: string;
  ttl: number;
  sealTo: string;
}

/** The bounds the served `chat-session-open` schema states. The pure smoke holds them equal. */
export const CHAT_OPEN_BOUNDS = { listItems: 64, labelLength: 128, ttlSec: 900 } as const;

const OPEN_FIELDS: readonly string[] = ["subscribe", "allowSubscribe", "allowPublish", "label", "ttl", "sealTo"];
const RETIRE_FIELDS: readonly string[] = ["alias", "actor", "lifecycleUid"];

/** The raw arguments as a plain object, or undefined. */
function argObject(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/** Read a `chat-session-open` request from its raw arguments, or the refusal. The ep door checks the
 *  served schema first; this reads every field the handler uses again, so no unchecked value reaches
 *  it. Channel validity, a blank label and the curve shape of `sealTo` are {@link chatOpenLists}'s. */
export function readChatOpenInput(raw: unknown): ChatSessionOpenInput | { error: string } {
  const bad = (why: string): { error: string } => ({ error: `chat-session-open: ${why}` });
  const a = argObject(raw);
  if (!a) return bad("the arguments must be an object");
  const extra = Object.keys(a).find((key) => !OPEN_FIELDS.includes(key));
  if (extra !== undefined) return bad(`unknown field "${extra}"`);
  const lists: Pick<ChatSessionOpenInput, "subscribe" | "allowSubscribe" | "allowPublish"> = {};
  for (const key of ["subscribe", "allowSubscribe", "allowPublish"] as const) {
    const list: unknown = a[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > CHAT_OPEN_BOUNDS.listItems || !list.every((c) => typeof c === "string" && c.length > 0) || new Set(list).size !== list.length)
      return bad(`${key} must be a list of at most ${CHAT_OPEN_BOUNDS.listItems} distinct, non-empty channel names`);
    lists[key] = [...(list as string[])];
  }
  const { label, ttl, sealTo } = a;
  if (typeof label !== "string" || label.length === 0 || label.length > CHAT_OPEN_BOUNDS.labelLength)
    return bad(`label must be a string of 1 to ${CHAT_OPEN_BOUNDS.labelLength} characters`);
  if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > CHAT_OPEN_BOUNDS.ttlSec)
    return bad(`ttl must be a whole number of seconds from 1 to ${CHAT_OPEN_BOUNDS.ttlSec}`);
  if (typeof sealTo !== "string") return bad("sealTo must be a string");
  return { ...lists, label, ttl, sealTo };
}

/** Read a `chat-session-retire` request from its raw arguments, or the refusal. The alias shape and
 *  the slot's ownership are {@link chatRetireRefusal}'s and the handler's. */
export function readChatRetireInput(raw: unknown): { alias: string; actor: string; lifecycleUid: string } | { error: string } {
  const bad = (why: string): { error: string } => ({ error: `chat-session-retire: ${why}` });
  const a = argObject(raw);
  if (!a) return bad("the arguments must be an object");
  const extra = Object.keys(a).find((key) => !RETIRE_FIELDS.includes(key));
  if (extra !== undefined) return bad(`unknown field "${extra}"`);
  const { alias, actor, lifecycleUid } = a;
  if (typeof alias !== "string" || alias.length === 0) return bad("alias must be a non-empty string");
  if (typeof actor !== "string" || actor.length === 0) return bad("actor must be a non-empty string");
  if (typeof lifecycleUid !== "string" || lifecycleUid.length === 0) return bad("lifecycleUid must be a non-empty string");
  return { alias, actor, lifecycleUid };
}

/** The three lists of an open request under a spawn's own rules, or the refusal. Every entry must
 *  be a valid channel, as the provisioner and the mint require; the initial channels must lie
 *  within the read ceiling, which falls back to them when empty (`resolveReadAcl`); the post list
 *  is default-deny. The foreign event-channel rule needs the drawn actor, so the handler applies
 *  it. {@link readChatOpenInput} bounds the label, each list and the ttl first. */
export function chatOpenLists(input: {
  subscribe?: readonly string[];
  allowSubscribe?: readonly string[];
  allowPublish?: readonly string[];
  label: string;
  sealTo: string;
}): { subscribe: string[]; allowSubscribe: string[]; allowPublish: string[] } | { error: string } {
  if (!input.label.trim()) return { error: "chat-session-open: label must not be blank" };
  if (!isCurvePublicKey(input.sealTo)) return { error: "chat-session-open: sealTo is not a curve public key" };
  const subscribe = [...(input.subscribe ?? [])];
  const allowPublish = [...(input.allowPublish ?? [])];
  try {
    for (const channel of [...subscribe, ...(input.allowSubscribe ?? []), ...allowPublish]) assertValidChannel(channel);
    return { subscribe, allowSubscribe: resolveReadAcl(subscribe, [...(input.allowSubscribe ?? [])]), allowPublish };
  } catch (e) {
    return { error: `chat-session-open: ${(e as Error).message}` };
  }
}

/** What `chat-session-open` seals to the caller's `sealTo`: the credential bound to the space,
 *  the admitting manager instance and every field of the reply. The client refuses any other key
 *  set and any field that differs from the reply or from what it asked. */
export interface SealedChatAdmission {
  readonly v: 1;
  readonly space: string;
  readonly managerInstanceId: string;
  readonly alias: string;
  readonly actor: string;
  readonly lifecycleUid: string;
  readonly expiresAt: number;
  readonly sealTo: string;
  readonly creds: string;
}

/** Seal one admission to its `sealTo` under a one-time sender key. */
export function sealChatAdmission(admission: Omit<SealedChatAdmission, "v">): { sealer: string; sealed: string } {
  const payload: SealedChatAdmission = { v: 1, ...admission };
  return sealJson(payload, admission.sealTo);
}

/** The ownership guard for `chat-session-retire`, or undefined when the slot may be retired. It
 *  ends only a slot `chat-session-open` admitted on THIS logical manager instance, at the
 *  requested incarnation: never an ordinary agent's slot, a sibling's, a legacy row with no
 *  recorded owner, or another incarnation of the alias. */
export function chatRetireRefusal(
  row: StaticManagedSlotRow | undefined,
  request: { alias: string; actor: string; lifecycleUid: string },
  managerInstanceId: string,
): { code: EpErrorCode; message: string } | undefined {
  if (!isChatAlias(request.alias))
    return { code: "permission-denied", message: `"${request.alias}" is not a chat session alias; chat-session-retire ends only sessions chat-session-open admitted` };
  if (row === undefined)
    return { code: "not-found", message: `no chat session slot exists for "${request.alias}"` };
  if (row.ownerInstanceId !== managerInstanceId)
    return { code: "failed-precondition", message: `the chat session slot "${request.alias}" belongs to manager instance ${row.ownerInstanceId ?? "<unrecorded>"}, not ${managerInstanceId}; only the instance that admitted it retires it` };
  if (row.lifecycleUid !== request.lifecycleUid)
    return { code: "failed-precondition", message: `the chat session slot "${request.alias}" is at uid ${row.lifecycleUid}, not ${request.lifecycleUid}; a retirement never addresses another incarnation` };
  if (row.actor !== request.actor)
    return { code: "failed-precondition", message: `the chat session slot "${request.alias}" names actor ${row.actor}, not ${request.actor}` };
  return undefined;
}

/** How many chat retirements one manager process runs at once, at expiry and at stop. Each is a
 *  full static terminal (KV round trips, a broker eviction scan and a deprovision), so a burst
 *  waits its turn instead of opening that many terminals together. It bounds work in flight, not
 *  sessions. */
export const CHAT_EXPIRY_CONCURRENCY = 4;

/** One session this manager process admitted, or is admitting, as its cleanup needs it. */
export interface ExpiringChatSession {
  readonly alias: string;
  readonly actor: string;
  readonly lifecycleUid: string;
  /** Its resolved read ceiling; the concrete channels in it name its membership rows for the
   *  teardown, and the delivery inventory finds the rest. */
  readonly channels: readonly string[];
  /** The leaf's expiry, epoch ms. */
  readonly expiresAt: number;
}

/** The clock the tracker runs on. Production uses the process clock; a smoke drives its own. */
export interface ChatExpiryTimers {
  readonly now: () => number;
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

/** Where one tracked session is. `opening`: registered before its first durable write, with no
 *  timer yet. `armed`: waiting for its expiry or a retry delay. `due`: queued behind the
 *  concurrency bound. `running`: its expiry retirement is in flight. `held`: not retired and not
 *  scheduled, because the retries were spent or the tracker stopped; a retire or the stop still
 *  ends it. */
type ChatTrackState = "opening" | "armed" | "due" | "running" | "held";

interface TrackedChatSession {
  readonly session: ExpiringChatSession;
  state: ChatTrackState;
  failures: number;
  timer?: unknown;
}

const PROCESS_TIMERS: ChatExpiryTimers = {
  now: () => Date.now(),
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The chat sessions this manager process admitted, from before each one's first durable write
 * until a retirement of it is confirmed. It retires each at its leaf's expiry, so a reply lost on
 * the way back or a client that never retires still ends then, and it names to the manager's
 * sweep and stop the exact alias, actor and UID of every session this process holds.
 *
 * It knows only what this process registered and never reads the slot store, so it cannot reach
 * an ordinary agent's slot, a sibling's, a legacy row or a session another process admitted.
 * `retire` runs the exact-owned retirement; a throw is a failure, retried after each of
 * `retryDelaysMs`. A session whose retries are spent stays tracked as `held`, for a later retire
 * or the stop.
 */
export class ChatSessionExpiry {
  private readonly sessions = new Map<string, TrackedChatSession>();
  private readonly due: string[] = [];
  private running = 0;
  private stopped = false;
  private readonly timers: ChatExpiryTimers;

  constructor(
    private readonly retire: (session: ExpiringChatSession) => Promise<void>,
    private readonly options: { readonly retryDelaysMs: readonly number[]; readonly concurrency: number; readonly log: (line: string) => void; readonly timers?: ChatExpiryTimers },
  ) {
    this.timers = options.timers ?? PROCESS_TIMERS;
  }

  /** Register a session the open handler is about to write, before its first durable write. It is
   *  not scheduled until {@link arm}. Throws once stopped and for a UID already registered. */
  register(session: ExpiringChatSession): void {
    if (this.stopped) throw new Error(`this manager is stopping, so chat session ${session.alias} was not admitted`);
    if (this.sessions.has(session.lifecycleUid)) throw new Error(`chat session uid ${session.lifecycleUid} is already registered`);
    this.sessions.set(session.lifecycleUid, { session, state: "opening", failures: 0 });
  }

  /** Schedule a registered session's retirement at its expiry: once its opening succeeded, or once
   *  a rollback of it did not complete. Throws once stopped, so an opening that finishes after a
   *  stop began is rolled back instead of being handed out; the session stays registered for the
   *  stop either way. */
  arm(lifecycleUid: string): void {
    const entry = this.sessions.get(lifecycleUid);
    if (!entry) throw new Error(`chat session uid ${lifecycleUid} is not registered`);
    if (this.stopped) throw new Error(`this manager is stopping, so chat session ${entry.session.alias} is not scheduled for its expiry`);
    if (entry.state !== "opening" && entry.state !== "held") return;
    this.schedule(entry, entry.session.expiresAt - this.timers.now());
  }

  /** Whether this process holds a session at this exact alias, actor and UID, in any state. */
  holdsExact(slot: { readonly alias: string; readonly actor: string; readonly lifecycleUid: string }): boolean {
    const entry = this.sessions.get(slot.lifecycleUid);
    return entry !== undefined && entry.session.alias === slot.alias && entry.session.actor === slot.actor;
  }

  /** The admitted channels of a tracked session, or undefined once it is not tracked. */
  channels(lifecycleUid: string): readonly string[] | undefined {
    return this.sessions.get(lifecycleUid)?.session.channels;
  }

  /** Stop tracking a session whose retirement was confirmed. A retirement of it already running
   *  finishes, and its outcome is dropped. */
  forget(lifecycleUid: string): void {
    const entry = this.sessions.get(lifecycleUid);
    if (!entry) return;
    if (entry.timer !== undefined) this.timers.clear(entry.timer);
    this.sessions.delete(lifecycleUid);
    const queued = this.due.indexOf(lifecycleUid);
    if (queued >= 0) this.due.splice(queued, 1);
  }

  /** Stop scheduling and refuse new sessions. Every tracked session stays tracked for the stop to
   *  retire or report, and each one not running becomes `held`. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.due.length = 0;
    for (const entry of this.sessions.values()) {
      if (entry.timer !== undefined) this.timers.clear(entry.timer);
      entry.timer = undefined;
      if (entry.state !== "running") entry.state = "held";
    }
  }

  /** Every tracked session. One whose expiry retirement is still settling is included: the
   *  manager runs one terminal per UID, so a second caller joins it rather than racing it. */
  remaining(): ExpiringChatSession[] {
    return [...this.sessions.values()].map((entry) => entry.session);
  }

  private schedule(entry: TrackedChatSession, delayMs: number): void {
    entry.state = "armed";
    const uid = entry.session.lifecycleUid;
    entry.timer = this.timers.set(() => {
      entry.timer = undefined;
      if (this.stopped || this.sessions.get(uid) !== entry) return;
      entry.state = "due";
      this.due.push(uid);
      this.pump();
    }, Math.max(0, delayMs));
  }

  private pump(): void {
    while (!this.stopped && this.running < this.options.concurrency && this.due.length > 0) {
      const uid = this.due.shift()!;
      const entry = this.sessions.get(uid);
      if (!entry) continue;
      this.running++;
      entry.state = "running";
      void Promise.resolve()
        .then(() => this.retire(entry.session))
        .then(
          () => {
            if (this.sessions.get(uid) === entry) this.sessions.delete(uid);
          },
          (e: unknown) => this.failed(entry, e),
        )
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private failed(entry: TrackedChatSession, e: unknown): void {
    const uid = entry.session.lifecycleUid;
    if (this.sessions.get(uid) !== entry) return;
    if (this.stopped) {
      entry.state = "held";
      return;
    }
    const delayMs = this.options.retryDelaysMs[entry.failures];
    entry.failures++;
    const why = e instanceof Error ? e.message : String(e);
    if (delayMs === undefined) {
      entry.state = "held";
      this.options.log(`! chat session ${entry.session.alias} (uid ${uid}) expired and its retirement failed ${entry.failures} time(s) (${why}); it stays held until a retire, this manager's stop, or the next start of this manager instance`);
      return;
    }
    this.options.log(`! chat session ${entry.session.alias} (uid ${uid}) expiry retirement failed (${why}); retrying in ${delayMs} ms`);
    this.schedule(entry, delayMs);
  }
}

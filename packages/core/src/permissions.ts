/**
 * Harness permission prompts, relayed to the agent's owner.
 *
 * The connector that holds a harness's permission hook writes one record per prompt under
 * `<owner>.<actor>.<id>` and is that record's only writer. Its owner's interactive principals read the
 * records and answer; the holder applies each event through {@link stepPermission}. `gone` is never
 * stored, because nothing is left to write it when an agent dies: every reader derives it from
 * presence with {@link holderLiveness}.
 *
 * Browser-safe, so a dashboard parses records with the code stock readers use.
 */
import { assertLifecycleToken, parsePrincipalKey, principalKey } from "./subjects.js";
import type { JsonValue } from "./types.js";

const principalIdBrand: unique symbol = Symbol("PrincipalId");
const requestIdBrand: unique symbol = Symbol("PermissionRequestId");

/** A principal's dot form `<owner>.<actor>`, both valid owner and actor tokens. */
export type PrincipalId = string & { readonly [principalIdBrand]: true };
/** One prompt's id: 26 lowercase base32 characters. */
export type PermissionRequestId = string & { readonly [requestIdBrand]: true };

/** The principal `<owner>.<actor>`. Throws on a token that is not a single NATS-safe token. */
export function principalId(owner: string, actor: string): PrincipalId {
  return principalKey(owner, actor).key as PrincipalId;
}

export const PERMISSION_RECORD_VERSION = 1;

/** The process holding the prompt: the `lifecycleUid` and `runtime.id` its presence row carries. */
export interface PermissionHolder {
  readonly lifecycleUid: string;
  readonly runtimeId: string;
}

/** The tool input as the harness passed it, or only its size when it is too large to store. */
export type PermissionInput =
  | { readonly kind: "shown"; readonly value: JsonValue }
  | { readonly kind: "withheld"; readonly bytes: number };

/** A stored state. `gone` is not one: {@link holderLiveness} derives it. */
export type PermissionState =
  | { readonly kind: "pending" }
  | { readonly kind: "approved"; readonly by: PrincipalId; readonly at: number }
  | { readonly kind: "denied"; readonly by: PrincipalId; readonly at: number; readonly note?: string }
  | { readonly kind: "answered-on-machine"; readonly at: number; readonly outcome: "allowed" | "withdrawn" }
  | { readonly kind: "expired"; readonly at: number };

/** One prompt. `agent` and `id` are the key it is stored under, and only `agent` writes it. The top
 *  level never carries `from`, `parts` or `space`, so stored bytes never read as a message. */
export interface PermissionRecord {
  readonly v: typeof PERMISSION_RECORD_VERSION;
  readonly id: PermissionRequestId;
  readonly agent: PrincipalId;
  readonly holder: PermissionHolder;
  readonly tool: string;
  readonly input: PermissionInput;
  readonly cwd?: string;
  readonly askedAt: number;
  /** Epoch ms. Absent means the prompt never expires. */
  readonly deadline?: number;
  readonly state: PermissionState;
}

/** An answer to a prompt. Only a denial carries a note, which the model reads as the reason. */
export type PermissionAnswer =
  | { readonly decision: "approve" }
  | { readonly decision: "deny"; readonly note?: string };

/**
 * What the holder observes about one prompt.
 *  - `answer`: from the answer rail. `by` is the request subject's sender, which the broker
 *    forge-locks, never a payload claim.
 *  - `tool-ran`: the harness ran the tool while the hook was still held.
 *  - `withdrawn`: the harness killed the hook (a native No or an interrupt).
 *  - `deadline`: the record's deadline passed.
 *  - `undelivered`: a decided verdict never reached the hook, so the harness answered first.
 */
export type PermissionEvent =
  | ({ readonly kind: "answer"; readonly by: PrincipalId; readonly at: number } & PermissionAnswer)
  | { readonly kind: "tool-ran"; readonly at: number }
  | { readonly kind: "withdrawn"; readonly at: number }
  | { readonly kind: "deadline"; readonly at: number }
  | { readonly kind: "undelivered"; readonly at: number };

export type PermissionRefusal = "answered" | "expired";

/** `repeat` is the same answerer sending the same answer again: report it accepted, write nothing. */
export type PermissionStep =
  | { readonly kind: "move"; readonly next: PermissionState }
  | { readonly kind: "repeat" }
  | { readonly kind: "ignore" }
  | { readonly kind: "refuse"; readonly code: PermissionRefusal };

type StateKind = PermissionState["kind"];
type EventKind = PermissionEvent["kind"];
type Cell<S extends StateKind, E extends EventKind> =
  (state: Extract<PermissionState, { kind: S }>, event: Extract<PermissionEvent, { kind: E }>) => PermissionStep;

const IGNORE: PermissionStep = Object.freeze({ kind: "ignore" });
const REPEAT: PermissionStep = Object.freeze({ kind: "repeat" });
const ignore = (): PermissionStep => IGNORE;
const refuse = (code: PermissionRefusal): PermissionStep => ({ kind: "refuse", code });
const move = (next: PermissionState): PermissionStep => ({ kind: "move", next });
const withdrawnOnMachine = (_: unknown, event: { readonly at: number }): PermissionStep =>
  move({ kind: "answered-on-machine", at: event.at, outcome: "withdrawn" });

const TABLE: { readonly [S in StateKind]: { readonly [E in EventKind]: Cell<S, E> } } = {
  pending: {
    answer: (_, e) => move(e.decision === "approve"
      ? { kind: "approved", by: e.by, at: e.at }
      : { kind: "denied", by: e.by, at: e.at, ...(e.note === undefined ? {} : { note: e.note }) }),
    "tool-ran": (_, e) => move({ kind: "answered-on-machine", at: e.at, outcome: "allowed" }),
    withdrawn: withdrawnOnMachine,
    deadline: (_, e) => move({ kind: "expired", at: e.at }),
    undelivered: ignore,
  },
  approved: {
    answer: (s, e) => (e.decision === "approve" && e.by === s.by ? REPEAT : refuse("answered")),
    "tool-ran": ignore, withdrawn: ignore, deadline: ignore,
    undelivered: withdrawnOnMachine,
  },
  denied: {
    answer: (s, e) => (e.decision === "deny" && e.by === s.by && e.note === s.note ? REPEAT : refuse("answered")),
    "tool-ran": ignore, withdrawn: ignore, deadline: ignore,
    undelivered: withdrawnOnMachine,
  },
  "answered-on-machine": { answer: () => refuse("answered"), "tool-ran": ignore, withdrawn: ignore, deadline: ignore, undelivered: ignore },
  expired: { answer: () => refuse("expired"), "tool-ran": ignore, withdrawn: ignore, deadline: ignore, undelivered: ignore },
};

/** The whole state machine: one pure cell per state and event. Only the holder runs it. */
export function stepPermission(state: PermissionState, event: PermissionEvent): PermissionStep {
  const cell = TABLE[state.kind][event.kind] as (state: PermissionState, event: PermissionEvent) => PermissionStep;
  return cell(state, event);
}

/** The KV key of one record: `<owner>.<actor>.<id>`. */
export function permissionKey(agent: PrincipalId, id: PermissionRequestId): string {
  return `${agent}.${id}`;
}

type Fields = Record<string, unknown>;

/** `value` as an object with every `required` key and no key outside `required` and `optional`. */
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): Fields | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (!required.every((k) => keys.includes(k)) || !keys.every((k) => required.includes(k) || optional.includes(k))) return undefined;
  return value as Fields;
}

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
/** A non-negative safe integer: an epoch-ms time or a byte count. */
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function principal(v: unknown): PrincipalId | undefined {
  return typeof v === "string" && parsePrincipalKey(v) !== null ? (v as PrincipalId) : undefined;
}

function requestId(v: unknown): PermissionRequestId | undefined {
  return typeof v === "string" && /^[a-z2-7]{26}$/.test(v) ? (v as PermissionRequestId) : undefined;
}

// The typeof check comes first: the token check is a RegExp test, which would coerce a JSON array.
function lifecycleToken(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    assertLifecycleToken(v);
    return true;
  } catch {
    return false;
  }
}

function holder(v: unknown): PermissionHolder | undefined {
  const h = closed(v, ["lifecycleUid", "runtimeId"]);
  return h && lifecycleToken(h.lifecycleUid) && text(h.runtimeId) ? { lifecycleUid: h.lifecycleUid, runtimeId: h.runtimeId } : undefined;
}

function input(v: unknown): PermissionInput | undefined {
  const shown = closed(v, ["kind", "value"]);
  if (shown?.kind === "shown") return { kind: "shown", value: shown.value as JsonValue };
  const withheld = closed(v, ["kind", "bytes"]);
  return withheld?.kind === "withheld" && whole(withheld.bytes) ? { kind: "withheld", bytes: withheld.bytes } : undefined;
}

function state(v: unknown): PermissionState | undefined {
  switch (closed(v, ["kind"], ["by", "at", "note", "outcome"])?.kind) {
    case "pending":
      return closed(v, ["kind"]) ? { kind: "pending" } : undefined;
    case "approved": {
      const s = closed(v, ["kind", "by", "at"]), by = principal(s?.by);
      return s && by && whole(s.at) ? { kind: "approved", by, at: s.at } : undefined;
    }
    case "denied": {
      const s = closed(v, ["kind", "by", "at"], ["note"]), by = principal(s?.by);
      if (!s || !by || !whole(s.at)) return undefined;
      if (!Object.hasOwn(s, "note")) return { kind: "denied", by, at: s.at };
      return typeof s.note === "string" ? { kind: "denied", by, at: s.at, note: s.note } : undefined;
    }
    case "answered-on-machine": {
      const s = closed(v, ["kind", "at", "outcome"]);
      return s && whole(s.at) && (s.outcome === "allowed" || s.outcome === "withdrawn")
        ? { kind: "answered-on-machine", at: s.at, outcome: s.outcome } : undefined;
    }
    case "expired": {
      const s = closed(v, ["kind", "at"]);
      return s && whole(s.at) ? { kind: "expired", at: s.at } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Parse one stored value read under `key`, or `undefined` for anything that is not a version 1
 * record whose `agent` and `id` are that key. The schema is closed at every level and nothing is
 * coerced, so a stored value that also carries a message envelope is refused.
 */
export function parsePermissionRecord(value: unknown, key: string): PermissionRecord | undefined {
  const r = closed(value, ["v", "id", "agent", "holder", "tool", "input", "askedAt", "state"], ["cwd", "deadline"]);
  if (!r || r.v !== PERMISSION_RECORD_VERSION) return undefined;
  const id = requestId(r.id), agent = principal(r.agent);
  if (!id || !agent || key !== permissionKey(agent, id)) return undefined;
  const h = holder(r.holder), i = input(r.input), s = state(r.state);
  if (!h || !i || !s || !text(r.tool) || !whole(r.askedAt)) return undefined;
  const cwd = Object.hasOwn(r, "cwd") ? r.cwd : undefined, deadline = Object.hasOwn(r, "deadline") ? r.deadline : undefined;
  if ((Object.hasOwn(r, "cwd") && !text(cwd)) || (Object.hasOwn(r, "deadline") && !whole(deadline))) return undefined;
  return {
    v: PERMISSION_RECORD_VERSION, id, agent, holder: h, tool: r.tool, input: i,
    ...(text(cwd) ? { cwd } : {}),
    askedAt: r.askedAt,
    ...(whole(deadline) ? { deadline } : {}),
    state: s,
  };
}

export type PermissionHolderLiveness = "live" | "gone" | "unknown";

/** A reader's view of the asking agent's presence row. `online` is the reader's own verdict: a fresh
 *  heartbeat and a status other than offline. `runtimeId` is absent when the row reports no runtime. */
export interface HolderObservation {
  readonly online: boolean;
  readonly lifecycleUid?: string;
  readonly runtimeId?: string;
}

/** The one `gone` rule, for every reader. A restarted connector publishes a new runtime id, so the
 *  records its predecessor held read `gone` with nothing left to sweep them. */
export function holderLiveness(holder: PermissionHolder, seen: HolderObservation | undefined | "unavailable"): PermissionHolderLiveness {
  if (seen === "unavailable") return "unknown";
  if (seen === undefined || !seen.online || seen.lifecycleUid !== holder.lifecycleUid) return "gone";
  if (seen.runtimeId === undefined) return "unknown";
  return seen.runtimeId === holder.runtimeId ? "live" : "gone";
}

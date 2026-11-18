/**
 * The prompt desk (SPEC 13.22): the agent's own server for the questions its harness stops to ask,
 * such as "Allow this command?", a multiple-choice question, a plan or a form. It holds the open
 * prompts, runs their state table, keeps the expiry and settle timers, and serves the `agent`
 * endpoint's `prompts`, `prompt` and `prompt-answer` commands on the principal route (SPEC 13.21)
 * through `CotalEndpoint.servePrincipal`. Nothing per prompt is stored on the broker: presence
 * carries a count and a counter, and the rest lives in this process.
 *
 * It knows no harness. An adapter opens a prompt for a native dialog, hands the one accepted answer
 * to its harness in `deliver`, reports what the harness was then seen to do with `settle`, and frees
 * what it holds in `end`, which comes exactly once per prompt.
 *
 * One rule orders everything. The desk is synchronous: every event is applied in one uninterrupted
 * step, in the order it reaches the desk, and no step waits for anything. An event that reaches the
 * desk while a step runs, such as an adapter report made from inside `check`, `deliver` or `end`, is
 * applied after that step. The first event applied wins, and each later one meets the state the
 * first one left.
 */
import { randomBytes } from "node:crypto";
import {
  AGENT_CLUSTER, AGENT_CONTRACTS, AGENT_ENDPOINT, AGENT_PROMPT_CONTENT_MAX_BYTES, AGENT_PROMPT_DIGEST_DETAIL,
  AGENT_PROMPT_LIST_MAX, AGENT_PROMPT_SIZE_DETAIL, AGENT_PROMPT_STATE_DETAIL, EpEnvelopeError,
  agentPromptDigest, canonicalJson, compileContractSchema, contractDigest, processRuntime,
  type AgentPrompt, type ContractValidator, type CotalEndpoint, type EpCaller, type EpPrincipalCommandDef,
  type EpPrincipalServeContext, type PrincipalServe, type PromptAnswerInput, type PromptAnswerRef, type PromptAnswerer,
  type PromptContent, type PromptEffect, type PromptOption, type PromptOutcome, type PromptSeen, type PromptState,
  type PromptSummary, type PromptsOutput,
} from "@cotal-ai/core";

/** The desk serves only on a connection whose `max_payload` is at least this many bytes, which covers
 *  the largest `prompts` and `prompt` replies with their envelopes. */
export const PROMPT_DESK_MIN_MAX_PAYLOAD = 524288;
/** A summary's JSON encoding is at most this many bytes of UTF-8, in every state its prompt can reach. */
export const PROMPT_SUMMARY_MAX_BYTES = 4096;
/** A `prompt-answer` reply waits at most this long for the delivery result of the answer it accepted. */
export const PROMPT_ANSWER_REPLY_MS = 10_000;
/** The range of {@link PromptSpec.openMs}: 1 s to 7 days. */
export const PROMPT_OPEN_MS = Object.freeze({ min: 1000, max: 7 * 24 * 60 * 60 * 1000 });
/** The range of {@link PromptSpec.settleMs}: 1 s to 24 h. */
export const PROMPT_SETTLE_MS = Object.freeze({ min: 1000, max: 24 * 60 * 60 * 1000 });

// ---- the adapter's interface ------------------------------------------------------------------

export interface PromptSpec {
  /** Set once and never changed: the digest covers all of it. */
  content: PromptContent;
  /** How long the prompt is offered while no answer was accepted, from 1 s to 7 days. `expiresAt` is
   *  `openedAt` plus this, and an `open` prompt closes `expired` there. */
  openMs: number;
  /** How long a `sent` prompt waits for evidence, from 1 s to 24 h after the accepted answer, before it
   *  closes `unconfirmed` with nothing seen. */
  settleMs: number;
}

/** The accepted answer, as the adapter hands it to its harness. `by` comes from the request subject. */
export interface PromptVerdict {
  option: string;
  note?: string;
  values?: NonNullable<PromptAnswerInput["values"]>;
  by: PromptAnswerer;
}

/** What `deliver` knows about the hand-over. */
export type Delivery =
  /** Handed over, and the harness confirmed it applied. */
  | { kind: "confirmed" }
  /** Handed over, with a receipt from the harness side. Whether it applied is not known yet. */
  | { kind: "delivered" }
  /** Positive evidence that nothing was handed over: the exchange had already ended. */
  | { kind: "gone" };

export interface PromptHooks {
  /** The adapter's own rules for an answer, run before it is accepted. Synchronous and pure: it
   *  returns a message to refuse the answer, or undefined. It does not touch the harness. A throw is a
   *  bug: the answer is refused `internal` and the prompt stays open. */
  check?(verdict: PromptVerdict): string | undefined;
  /** Hand the one accepted answer to the harness. Called at most once per prompt, in the step that
   *  accepted the answer. It never refuses an answer: that is `check`. While nothing is known the
   *  promise stays pending; a throw or a rejection proves nothing about the hand-over. */
  deliver(verdict: PromptVerdict): Promise<Delivery>;
  /** The prompt closed. Called exactly once per prompt, after its last state change. With
   *  `attempted: false`, `deliver` was never called and the adapter gives the dialog back to the
   *  harness if the harness still waits. With `attempted: true`, the adapter writes nothing more to
   *  the harness for this prompt and only frees what it holds. */
  end(info: { attempted: boolean }): void;
}

/** What the adapter has positive evidence for. The desk never upgrades a report. */
export type Evidence =
  /** The harness confirmed the accepted remote answer applied. */
  | { kind: "confirmed" }
  /** The harness reported an answer from its own dialog. */
  | { kind: "local"; seen: PromptSeen }
  /** Something was seen. Who answered is not known. */
  | { kind: "observed"; seen: PromptSeen }
  /** The harness stopped waiting. Nothing was seen. */
  | { kind: "withdrawn" };

export interface PromptHold {
  readonly id: string;
  /** Report evidence about this prompt. A report that meets a closed prompt is warned and ignored.
   *  Throws a TypeError on a value that is not an {@link Evidence}. */
  settle(evidence: Evidence): void;
}

export interface PromptDesk {
  /** Open a prompt. Throws {@link PromptRefused}, and then the adapter leaves that dialog to the
   *  harness. */
  open(spec: PromptSpec, hooks: PromptHooks): PromptHold;
  /** How many prompts are `open` or `sent`. */
  readonly waiting: number;
  /** Close every prompt (the event C), reply to every `prompt-answer` still waiting, clear the presence
   *  field and stop serving. Does not wait for a `deliver` call that has not ended. */
  close(): Promise<void>;
}

/** Why {@link PromptDesk.open} refused a prompt: 32 are `open` or `sent` (`full`), the content or a
 *  summary is over its limit (`too-large`), the spec or its content breaks a rule (`invalid`), or the
 *  desk has closed (`closed`). */
export class PromptRefused extends Error {
  constructor(readonly reason: "full" | "too-large" | "invalid" | "closed", message: string) {
    super(message);
    this.name = "PromptRefused";
  }
}

// ---- the state table (SPEC 13.22) -------------------------------------------------------------

/** An event the desk applies to one prompt. `accept` is A, `delivery` D, `settle` S, `expiry` X,
 *  `settle-time` T and `close` C. */
export type PromptEvent =
  | { kind: "accept"; answer: PromptAnswerRef }
  | { kind: "delivery"; result: "confirmed" | "delivered" | "gone" | "failed" }
  | { kind: "settle"; evidence: Evidence }
  | { kind: "expiry" }
  | { kind: "settle-time" }
  | { kind: "close" };

/** One row of the state table. `move` changes the state; `deliver` asks the desk to call `deliver`
 *  in the same step, and `end` to call `end` with `attempted`. `stay` changes nothing; `report` marks
 *  a report that met a closed prompt. The last two kinds are rows the desk never feeds the table: a
 *  `deliver` call has one result and the settle time starts at an accepted answer (`cannot-happen`),
 *  and an answer to a prompt that is not open is refused before it is an event (`never-reached`). */
export type PromptStep =
  | { kind: "move"; next: PromptState; deliver?: true; end?: { attempted: boolean } }
  | { kind: "stay"; warn?: string; report?: true }
  | { kind: "cannot-happen"; why: string }
  | { kind: "never-reached"; why: string };

const NONE: PromptSeen = { tie: "none" };

/** The state table, as a pure function: the step `event` takes from `state`, at `at`. */
export function stepPrompt(state: PromptState, event: PromptEvent, at: string): PromptStep {
  const close = (outcome: PromptOutcome, attempted: boolean): PromptStep =>
    ({ kind: "move", next: { kind: "closed", at, outcome }, end: { attempted } });
  if (state.kind === "open") {
    switch (event.kind) {
      case "accept":
        return { kind: "move", next: { kind: "sent", answer: event.answer, delivery: "unconfirmed" }, deliver: true };
      case "settle": {
        const e = event.evidence;
        if (e.kind === "local") return close({ kind: "local", seen: e.seen }, false);
        // An `open` prompt had no remote answer, so what the harness did with it, it did on its own.
        // A sighting tied only to the subject says nothing about this prompt.
        if (e.kind === "observed") return close(e.seen.tie === "prompt" ? { kind: "local", seen: e.seen } : { kind: "withdrawn", seen: e.seen }, false);
        if (e.kind === "withdrawn") return close({ kind: "withdrawn", seen: NONE }, false);
        return { kind: "stay", warn: "a confirmation came for a prompt with no accepted answer" };
      }
      case "expiry":
        return close({ kind: "expired" }, false);
      case "close":
        return close({ kind: "withdrawn", seen: NONE }, false);
      case "delivery":
        return { kind: "stay", warn: "a delivery result came for a prompt with no deliver call" };
      case "settle-time":
        return { kind: "cannot-happen", why: "the settle time starts at the accepted answer" };
    }
  }
  if (state.kind === "sent") {
    const answer = state.answer;
    switch (event.kind) {
      case "accept":
        return { kind: "never-reached", why: "an answer to a sent prompt meets check 3 or 4" };
      case "delivery":
        if (state.delivery === "delivered") return { kind: "cannot-happen", why: "deliver has one result" };
        if (event.result === "delivered") return { kind: "move", next: { kind: "sent", answer, delivery: "delivered" } };
        if (event.result === "confirmed") return close({ kind: "answered", answer }, true);
        if (event.result === "gone") return close({ kind: "undelivered", answer }, true);
        return { kind: "stay", warn: "deliver failed, which proves nothing about the hand-over" };
      case "settle": {
        const e = event.evidence;
        if (e.kind === "confirmed") return close({ kind: "answered", answer }, true);
        if (e.kind === "local") return close({ kind: "local", seen: e.seen, late: answer }, true);
        if (e.kind === "observed") return close({ kind: "unconfirmed", answer, seen: e.seen }, true);
        return close({ kind: "unconfirmed", answer, seen: NONE }, true);
      }
      case "expiry":
        return { kind: "stay" }; // the answer is already with the adapter
      case "settle-time":
      case "close":
        return close({ kind: "unconfirmed", answer, seen: NONE }, true);
    }
  }
  if (event.kind === "accept") return { kind: "never-reached", why: "an answer to a closed prompt meets check 3 or 4" };
  if (event.kind === "settle") return { kind: "stay", warn: "a report came for a closed prompt", report: true };
  return { kind: "stay" };
}

// ---- the desk ---------------------------------------------------------------------------------

interface Waiter {
  resolve(state: PromptState): void;
  timer: NodeJS.Timeout;
}

interface Held {
  readonly id: string;
  readonly hooks: PromptHooks;
  readonly settleMs: number;
  readonly expiresAtMs: number;
  /** Every summary field but `state`. */
  readonly base: Omit<PromptSummary, "state">;
  /** Kept while the prompt is open or sent, the only states served in full. */
  live?: { content: PromptContent; options: ReadonlyMap<string, PromptOption>; form?: ContractValidator };
  state: PromptState;
  /** The accepted answer's identity, kept while the prompt is in memory. */
  fingerprint?: string;
  /** Reports that met the prompt once it was closed. */
  reports: number;
  ended: boolean;
  expiry?: NodeJS.Timeout;
  settle?: NodeJS.Timeout;
  readonly waiters: Set<Waiter>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Text for any value, such as one a hook gave back. Never throws: `JSON.stringify` throws on `1n`,
 *  and `String` on an object with no primitive form. */
function describe(v: unknown): string {
  try {
    if (v instanceof Error) return v.message;
    const json = JSON.stringify(v);
    if (json !== undefined) return json.length > 200 ? `${json.slice(0, 200)}...` : json;
  } catch { /* not JSON */ }
  try {
    return typeof v === "bigint" ? `${v}n` : String(v);
  } catch {
    return `a ${typeof v} with no text form`;
  }
}

/** A hook that returns a thenable where it returns a plain value broke its contract, and a rejection
 *  of that thenable must not go unhandled: Node exits on one. Attaches a no-op rejection handler and
 *  says whether `v` was a thenable. */
function ignoreRejection(v: unknown): boolean {
  try {
    const then = (v as { then?: unknown } | null | undefined)?.then;
    if (typeof then !== "function") return false;
    then.call(v, undefined, () => {});
  } catch { /* a `then` that throws has nothing to attach to */ }
  return true;
}

/** `d.kind`, or undefined when reading it throws. */
function deliveryKind(d: unknown): unknown {
  try {
    return (d as { kind?: unknown } | null | undefined)?.kind;
  } catch {
    return undefined;
  }
}
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const EFFECTS = new Set(["proceed", "refuse", "cancel"]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function timer(ms: number, fn: () => void): NodeJS.Timeout {
  const t = setTimeout(fn, ms);
  t.unref();
  return t;
}

function refused(code: "permission-denied" | "not-found" | "conflict" | "failed-precondition" | "bad-request" | "expired" | "internal" | "resource-exhausted",
  message: string, details?: { kind: string; [k: string]: unknown }[]): EpEnvelopeError {
  return new EpEnvelopeError(code, message, details, "not-executed");
}

function parseSeen(s: unknown): PromptSeen {
  const o = s as Record<string, unknown> | null;
  if (o && typeof o === "object" && !Array.isArray(o)) {
    const keys = Object.keys(o).length;
    if (o.tie === "none" && keys === 1) return { tie: "none" };
    if ((o.tie === "prompt" || o.tie === "subject") && keys === 2 && EFFECTS.has(o.effect as string))
      return { tie: o.tie, effect: o.effect as PromptEffect };
  }
  throw new TypeError(`settle: ${describe(s)} is not a sighting ({ tie: "prompt" | "subject", effect } or { tie: "none" })`);
}

function parseEvidence(e: unknown): Evidence {
  const o = e as Record<string, unknown> | null;
  if (o && typeof o === "object" && !Array.isArray(o)) {
    const keys = Object.keys(o).length;
    if ((o.kind === "confirmed" || o.kind === "withdrawn") && keys === 1) return { kind: o.kind };
    if ((o.kind === "local" || o.kind === "observed") && keys === 2) return { kind: o.kind, seen: parseSeen(o.seen) };
  }
  throw new TypeError(`settle: ${describe(e)} is not an Evidence`);
}

/** The longest legal answerer: owner and actor at 64 characters, a 32-character lifecycle UID, and
 *  an authority word (both are five characters). */
const LONGEST_BY: PromptAnswerer = Object.freeze({ id: `${"w".repeat(64)}.${"w".repeat(64)}`, uid: "w".repeat(32), authority: "owner" });
/** Every timestamp has one 24-byte form. */
const ANY_AT = "2000-01-01T00:00:00.000Z";
/** The longest sighting: the longer tie word and the longest effect. */
const LONGEST_SEEN: PromptSeen = Object.freeze({ tie: "subject", effect: "proceed" });

/** The largest encoded summary over every state the prompt can reach, with every variable field at
 *  its longest legal value. */
function largestSummaryBytes(base: Omit<PromptSummary, "state">, options: readonly PromptOption[]): number {
  let max = 0;
  const measure = (state: PromptState) => { max = Math.max(max, Buffer.byteLength(JSON.stringify({ ...base, state }))); };
  const closed = (outcome: PromptOutcome): PromptState => ({ kind: "closed", at: ANY_AT, outcome });
  measure({ kind: "open" });
  measure(closed({ kind: "expired" }));
  measure(closed({ kind: "withdrawn", seen: LONGEST_SEEN }));
  measure(closed({ kind: "local", seen: LONGEST_SEEN }));
  for (const o of options) {
    const answer: PromptAnswerRef = { by: LONGEST_BY, option: o.id, effect: o.effect, at: ANY_AT };
    measure({ kind: "sent", answer, delivery: "unconfirmed" });
    measure({ kind: "sent", answer, delivery: "delivered" });
    measure(closed({ kind: "answered", answer }));
    measure(closed({ kind: "unconfirmed", answer, seen: LONGEST_SEEN }));
    measure(closed({ kind: "undelivered", answer }));
    measure(closed({ kind: "local", seen: LONGEST_SEEN, late: answer }));
  }
  return max;
}

class Desk implements PromptDesk {
  /** Every prompt in memory, in the order it opened. */
  private readonly held = new Map<string, Held>();
  /** The closed prompts in memory, in the order they closed. */
  private readonly closedOrder: string[] = [];
  private live = 0;
  /** Taken from the endpoint, which keeps the highest for this process's runtime id, so a desk opened
   *  again in the process goes on counting: a reader orders lists by `seq` within one `runtime.id`. */
  private seq = 0;
  private stepping = false;
  private readonly later: (() => void)[] = [];
  private presenceOwed = false;
  private closed = false;
  private closing?: Promise<void>;
  serve?: PrincipalServe;

  constructor(private readonly ep: CotalEndpoint, private readonly warn: (msg: string) => void) {
  }

  get waiting(): number {
    return this.live;
  }

  /** Serve the `agent` endpoint, and close on a refused subscription or a smaller payload limit. */
  start(): PrincipalServe {
    const handlers: EpPrincipalCommandDef[] = [
      { command: "prompts", contract: AGENT_CONTRACTS.prompts, handler: (ctx) => this.list(ctx) },
      { command: "prompt", contract: AGENT_CONTRACTS.prompt, handler: (ctx) => this.read(ctx) },
      { command: "prompt-answer", contract: AGENT_CONTRACTS["prompt-answer"], handler: (ctx) => this.answer(ctx) },
    ];
    const serve = this.ep.servePrincipal({ endpoint: AGENT_ENDPOINT, cluster: AGENT_CLUSTER, handlers });
    this.seq = this.ep.nextPromptsSeq();
    this.serve = serve;
    this.ep.on("transport", this.onTransport);
    void serve.failed.then((err) => {
      if (this.closed) return;
      this.warn(`the prompt desk closed: ${err.message}`);
      void this.close();
    });
    return serve;
  }

  /** The broker accepted the subscription: show this desk's counter. */
  announce(): void {
    this.presenceOwed = true;
    this.flushPresence();
  }

  /** Every replaced connection runs the payload check again. */
  private readonly onTransport = (t: { connected: boolean }): void => {
    if (!t.connected || this.closed) return;
    let max: number;
    try {
      max = this.ep.maxPayload;
    } catch {
      return; // not live after all; the next connection runs the check
    }
    if (max >= PROMPT_DESK_MIN_MAX_PAYLOAD) return;
    this.warn(`the prompt desk closed: the connection's max_payload is ${max} bytes, under the ${PROMPT_DESK_MIN_MAX_PAYLOAD} its largest replies need`);
    void this.close();
  };

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.ep.off("transport", this.onTransport);
    this.defer(() => {
      for (const h of [...this.held.values()]) if (h.state.kind !== "closed") this.apply(h, { kind: "close" });
    });
    this.closing = this.serve ? this.serve.stop() : Promise.resolve();
    return this.closing;
  }

  open(spec: PromptSpec, hooks: PromptHooks): PromptHold {
    if (this.closed) throw new PromptRefused("closed", "the prompt desk has closed; the harness answers this dialog");
    const invalid = (why: string) => new PromptRefused("invalid", why);
    if (!spec || typeof spec !== "object") throw invalid("a prompt spec is an object");
    if (!hooks || typeof hooks.deliver !== "function" || typeof hooks.end !== "function" || (hooks.check !== undefined && typeof hooks.check !== "function"))
      throw invalid("hooks need deliver and end, and check when given, as functions");
    for (const [name, value, range] of [["openMs", spec.openMs, PROMPT_OPEN_MS], ["settleMs", spec.settleMs, PROMPT_SETTLE_MS]] as const)
      if (!Number.isSafeInteger(value) || value < range.min || value > range.max)
        throw invalid(`${name} must be an integer from ${range.min} to ${range.max} ms, not ${String(value)}`);

    let canonical: string;
    try {
      canonical = canonicalJson(spec.content);
    } catch (e) {
      throw invalid(`the content is not interchangeable JSON: ${describe(e)}`);
    }
    const contentBytes = Buffer.byteLength(canonical);
    if (contentBytes > AGENT_PROMPT_CONTENT_MAX_BYTES)
      throw new PromptRefused("too-large", `the canonical content is ${contentBytes} bytes, over ${AGENT_PROMPT_CONTENT_MAX_BYTES}`);
    // The served content is exactly the bytes the digest covers, and nothing the adapter keeps can change it.
    const content = deepFreeze(JSON.parse(canonical) as PromptContent);
    let id: string;
    do id = Array.from(randomBytes(26), (b) => B32[b & 31]).join(""); while (this.held.has(id));
    const digest = agentPromptDigest(content);
    const now = Date.now();
    const openedAt = iso(now), expiresAtMs = now + spec.openMs, expiresAt = iso(expiresAtMs);
    const validate = AGENT_CONTRACTS.prompt.output.validate;
    if (!validate({ prompt: { id, digest, openedAt, expiresAt, state: { kind: "open" }, content } })) {
      const first = validate.errors?.[0];
      throw invalid(`the content does not match the prompt schema: ${first ? `${first.instancePath || "/"} ${first.message}` : "invalid"}`);
    }
    const options = new Map<string, PromptOption>();
    for (const o of content.options) {
      if (options.has(o.id)) throw invalid(`option id "${o.id}" is used twice`);
      options.set(o.id, o);
      if (o.form === "required" && content.form === undefined) throw invalid(`option "${o.id}" submits a form, and the content has none`);
    }
    if (content.form !== undefined && !content.options.some((o) => o.form === "required"))
      throw invalid("the content has a form, and no option submits it");
    const input = content.subject?.type === "tool" ? (content.subject as { input: { kind: string } }).input : undefined;
    if (input?.kind === "omitted" && content.options.some((o) => o.effect === "proceed"))
      throw invalid("a tool input that is omitted can be refused remotely, never approved: no option may proceed");
    let form: ContractValidator | undefined;
    if (content.form !== undefined) {
      const schema = content.form.schema as { properties: Record<string, unknown>; required?: string[] };
      for (const name of schema.required ?? [])
        if (!Object.hasOwn(schema.properties, name)) throw invalid(`form.schema.required names "${name}", which is not a property`);
      try {
        // Values carry the declared properties and nothing else.
        form = compileContractSchema({ root: { ...schema, additionalProperties: false } });
      } catch (e) {
        throw invalid(`form.schema does not compile: ${describe(e)}`);
      }
    }
    const base: Omit<PromptSummary, "state"> = {
      id, digest, openedAt, expiresAt, kind: content.kind, title: content.title, contentBytes,
      ...(content.source !== undefined ? { source: content.source } : {}),
    };
    const largest = largestSummaryBytes(base, content.options);
    if (largest > PROMPT_SUMMARY_MAX_BYTES)
      throw new PromptRefused("too-large", `the summary encodes to ${largest} bytes in its largest state, over ${PROMPT_SUMMARY_MAX_BYTES}`);
    if (this.live >= AGENT_PROMPT_LIST_MAX)
      throw new PromptRefused("full", `${AGENT_PROMPT_LIST_MAX} prompts are open or sent`);

    const h: Held = {
      id, hooks, settleMs: spec.settleMs, expiresAtMs, base: deepFreeze(base), live: { content, options, ...(form ? { form } : {}) },
      state: deepFreeze({ kind: "open" }), reports: 0, ended: false, waiters: new Set(),
    };
    this.held.set(id, h);
    this.live++;
    this.bump();
    h.expiry = timer(spec.openMs, () => this.expire(h));
    if (!this.stepping) this.flushPresence();
    return Object.freeze({
      id,
      settle: (evidence: Evidence) => {
        const e = parseEvidence(evidence);
        this.defer(() => this.apply(h, { kind: "settle", evidence: e }));
      },
    });
  }

  /** X fires at `expiresAt`. A timer that runs early arms itself again for what is left. */
  private expire(h: Held): void {
    const left = h.expiresAtMs - Date.now();
    if (left > 0) {
      h.expiry = timer(left, () => this.expire(h));
      return;
    }
    this.defer(() => this.apply(h, { kind: "expiry" }));
  }

  // ---- steps ----

  /** Run `fn` as one step. Events that reach the desk during it are applied after it, in order. */
  private run<T>(fn: () => T): T {
    if (this.stepping) throw new Error("prompt desk: a step started inside another step");
    this.stepping = true;
    try {
      return fn();
    } finally {
      try {
        for (let next = this.later.shift(); next; next = this.later.shift()) next();
      } finally {
        this.stepping = false;
        this.flushPresence();
      }
    }
  }

  private defer(fn: () => void): void {
    if (this.stepping) this.later.push(fn);
    else this.run(fn);
  }

  /** Apply one event to one prompt: the table's row, then the waiting replies, then `end`. */
  private apply(h: Held, event: PromptEvent, why?: string): void {
    const step = stepPrompt(h.state, event, iso(Date.now()));
    if (step.kind === "cannot-happen" || step.kind === "never-reached") {
      this.warn(`prompt desk bug: event ${event.kind} met prompt ${h.id} in state ${h.state.kind}, a row that ${step.kind === "cannot-happen" ? "cannot happen" : "is never reached"}: ${step.why}`);
      return;
    }
    if (step.kind === "stay") {
      if (step.report) this.warn(`prompt ${h.id} is closed, so a "${(event as { evidence: Evidence }).evidence.kind}" report is ignored (${++h.reports} so far)`);
      else if (step.warn) this.warn(`prompt ${h.id}: ${step.warn}${why ? `: ${why}` : ""}`);
      // A failed call ends the reply's wait: the state it reads is still `sent`, `unconfirmed`.
      if (event.kind === "delivery" && event.result === "failed") this.answerWaiters(h);
      return;
    }
    h.state = deepFreeze(step.next);
    this.bump();
    if (h.state.kind === "closed") this.retire(h);
    if (!(h.state.kind === "sent" && h.state.delivery === "unconfirmed")) this.answerWaiters(h);
    if (step.end) this.end(h, step.end.attempted);
  }

  /** Reply to every `prompt-answer` waiting on `h`, each with the state read now. */
  private answerWaiters(h: Held): void {
    for (const w of h.waiters) {
      clearTimeout(w.timer);
      w.resolve(h.state);
    }
    h.waiters.clear();
  }

  /** A prompt closed: stop its timers, free its content, and keep it in the closed memory. */
  private retire(h: Held): void {
    clearTimeout(h.expiry);
    clearTimeout(h.settle);
    h.live = undefined;
    this.live--;
    this.closedOrder.push(h.id);
    while (this.closedOrder.length > AGENT_PROMPT_LIST_MAX) this.held.delete(this.closedOrder.shift()!);
  }

  private end(h: Held, attempted: boolean): void {
    if (h.ended) {
      this.warn(`prompt desk bug: prompt ${h.id} ended twice`);
      return;
    }
    h.ended = true;
    try {
      ignoreRejection(h.hooks.end({ attempted }));
    } catch (e) {
      this.warn(`prompt ${h.id}: the adapter's end threw: ${describe(e)}`);
    }
  }

  private bump(): void {
    this.seq = this.ep.nextPromptsSeq();
    this.presenceOwed = true;
  }

  private flushPresence(): void {
    if (!this.presenceOwed || this.closed || !this.serve) return;
    this.presenceOwed = false;
    this.ep.setPromptsPresence({ open: this.live, seq: this.seq }).catch((e) => {
      if (!this.closed) this.warn(`the prompts presence field was not written: ${describe(e)}`);
    });
  }

  // ---- the commands ----

  /** Fit a reply to the connection's `max_payload`, or refuse it with its size. */
  private fit<T>(ctx: EpPrincipalServeContext, data: T): T {
    if (ctx.replyFits(data, Number.MAX_SAFE_INTEGER)) return data;
    const bytes = Buffer.byteLength(JSON.stringify({ v: 1, id: ctx.request.id, ok: true, data }));
    const limit = this.ep.maxPayload;
    throw refused("resource-exhausted", `the reply is ${bytes} bytes, over this connection's max_payload of ${limit}`, [{ kind: AGENT_PROMPT_SIZE_DETAIL, bytes, limit }]);
  }

  private summary(h: Held): PromptSummary {
    return { ...h.base, state: h.state };
  }

  private list(ctx: EpPrincipalServeContext): PromptsOutput {
    const open: PromptSummary[] = [];
    for (const h of this.held.values()) if (h.state.kind !== "closed") open.push(this.summary(h));
    const closed = this.closedOrder.map((id) => this.summary(this.held.get(id)!));
    const runtime = { id: ctx.principal.runtimeId, startedAt: processRuntime(ctx.principal.uid).startedAt };
    return this.fit(ctx, { runtime, seq: this.seq, open, closed });
  }

  private read(ctx: EpPrincipalServeContext): { prompt: AgentPrompt } {
    const { id } = ctx.request.args as { id: string };
    const h = this.held.get(id);
    if (h === undefined) throw refused("not-found", `prompt ${id} is not known to this runtime`);
    if (h.live === undefined)
      throw refused("failed-precondition", `prompt ${id} is closed`, [{ kind: AGENT_PROMPT_STATE_DETAIL, state: h.state }]);
    const { digest, openedAt, expiresAt } = h.base;
    return this.fit(ctx, { prompt: { id, digest, openedAt, expiresAt, state: h.state, content: h.live.content } });
  }

  private answer(ctx: EpPrincipalServeContext): { state: PromptState } | Promise<{ state: PromptState }> {
    const got = this.run(() => this.decide(ctx));
    return got instanceof Promise ? got.then((state) => ({ state })) : { state: got };
  }

  /** The `prompt-answer` checks, in order, and the accept, as one step. Returns the state for a reply
   *  sent at once, or the wait of an accepted answer. Throws the refusal. */
  private decide(ctx: EpPrincipalServeContext): PromptState | Promise<PromptState> {
    const a = ctx.request.args as unknown as PromptAnswerInput;
    try {
      canonicalJson(a);
    } catch (e) {
      throw refused("bad-request", `the answer is not interchangeable JSON: ${describe(e)}`);
    }
    // 1. An agent never answers its own prompt, whatever its row.
    if (ctx.caller.owner === ctx.principal.owner && ctx.caller.actor === ctx.principal.actor)
      throw refused("permission-denied", "an agent never answers its own prompt");
    // 2.
    const h = this.held.get(a.id);
    if (h === undefined) throw refused("not-found", `prompt ${a.id} is not known to this runtime`);
    // 3. The same answer again gets the state it has now, and nothing is handed over twice.
    const fingerprint = answerFingerprint(a, ctx.caller);
    if (h.fingerprint === fingerprint) return h.state;
    // 4.
    if (h.state.kind !== "open" || h.live === undefined)
      throw refused("conflict", `prompt ${a.id} is not open`, [{ kind: AGENT_PROMPT_STATE_DETAIL, state: h.state }]);
    // 5.
    if (a.digest !== h.base.digest)
      throw refused("failed-precondition", `the digest is not prompt ${a.id}'s`, [{ kind: AGENT_PROMPT_DIGEST_DETAIL, digest: h.base.digest }]);
    // 6.
    const option = h.live.options.get(a.option);
    if (option === undefined) throw refused("bad-request", `option "${a.option}" is not one of the prompt's`);
    // 7.
    if (option.note === "required" && (a.note === undefined || a.note === "")) throw refused("bad-request", `option "${option.id}" needs a note`);
    if (option.note === undefined && a.note !== undefined) throw refused("bad-request", `option "${option.id}" takes no note`);
    if (option.form === "required" && a.values === undefined) throw refused("bad-request", `option "${option.id}" submits the form and needs values`);
    if (option.form === undefined && a.values !== undefined) throw refused("bad-request", `option "${option.id}" takes no values`);
    // 8.
    if (a.values !== undefined && !h.live.form!(a.values)) {
      const first = h.live.form!.errors?.[0];
      throw refused("bad-request", `the values do not match the form: ${first ? `${first.instancePath || "/"} ${first.message}` : "invalid"}`);
    }
    const by: PromptAnswerer = { id: `${ctx.caller.owner}.${ctx.caller.actor}`, uid: ctx.caller.uid, authority: ctx.authority };
    const verdict: PromptVerdict = deepFreeze({
      option: option.id,
      ...(a.note !== undefined ? { note: a.note } : {}),
      ...(a.values !== undefined ? { values: structuredClone(a.values) } : {}),
      by,
    });
    // 9. The adapter's own rules.
    let refusal: unknown;
    try {
      refusal = h.hooks.check?.(verdict);
    } catch (e) {
      this.warn(`prompt ${h.id}: the adapter's check threw: ${describe(e)}`);
      throw refused("internal", `the agent could not check this answer: ${describe(e)}`);
    }
    if (refusal !== undefined) {
      if (typeof refusal !== "string") {
        this.warn(`prompt ${h.id}: the adapter's check returned ${ignoreRejection(refusal) ? "a promise, and check is synchronous" : `${typeof refusal}, not a message or undefined`}`);
        throw refused("internal", "the agent could not check this answer");
      }
      throw refused("bad-request", refusal || "the agent refused this answer");
    }
    // 10.
    if (Date.now() >= h.expiresAtMs) throw refused("expired", `prompt ${h.id} expired at ${h.base.expiresAt}`);
    // 11. Accept: event A. The state, the fingerprint, the settle time and the `deliver` call are one step.
    const answer: PromptAnswerRef = { by, option: option.id, effect: option.effect, at: iso(Date.now()) };
    const step = stepPrompt(h.state, { kind: "accept", answer }, answer.at);
    if (step.kind !== "move" || !step.deliver) throw refused("internal", "prompt desk bug: an open prompt did not accept");
    h.state = deepFreeze(step.next);
    h.fingerprint = fingerprint;
    this.bump();
    h.settle = timer(h.settleMs, () => this.defer(() => this.apply(h, { kind: "settle-time" })));
    const wait = new Promise<PromptState>((resolve) => {
      const w: Waiter = {
        resolve,
        timer: timer(PROMPT_ANSWER_REPLY_MS, () => this.defer(() => {
          if (h.waiters.delete(w)) resolve(h.state);
        })),
      };
      h.waiters.add(w);
    });
    this.deliver(h, verdict);
    return wait;
  }

  /** Call `deliver` once, and apply its one result as event D when it ends: anything that is not a
   *  Delivery is one `failed` event, and nothing it holds escapes as an unhandled rejection. */
  private deliver(h: Held, verdict: PromptVerdict): void {
    let result: Promise<Delivery>;
    try {
      result = Promise.resolve(h.hooks.deliver(verdict));
    } catch (e) {
      result = Promise.reject(e);
    }
    const failed = (why: string) => this.defer(() => this.apply(h, { kind: "delivery", result: "failed" }, why));
    result.then(
      (d) => {
        const kind = deliveryKind(d);
        if (kind === "confirmed" || kind === "delivered" || kind === "gone") this.defer(() => this.apply(h, { kind: "delivery", result: kind }));
        else failed(`deliver resolved with ${describe(d)}, which is not a Delivery`);
      },
      (e) => failed(describe(e)),
    ).catch((e) => this.warn(`prompt desk bug: applying prompt ${h.id}'s delivery result threw: ${describe(e)}`));
  }
}

/** The identity of an answer: SHA-256 over the RFC 8785 form of what it says and who said it. */
function answerFingerprint(a: PromptAnswerInput, caller: EpCaller): string {
  return contractDigest({
    id: a.id, digest: a.digest, option: a.option, note: a.note ?? null, values: a.values ?? null,
    caller: `${caller.owner}.${caller.actor}.${caller.uid}`,
  });
}

/**
 * Open this process's prompt desk on `ep`: serve the `agent` endpoint on the principal route and show
 * the `prompts` presence field. Resolves once the broker accepted the subscription.
 *
 * Rejects on an open mesh, under a static credential and without a lifecycle UID, when the broker
 * refuses the subscription (a credential minted before the rows existed), and when the connection's
 * `max_payload` is under {@link PROMPT_DESK_MIN_MAX_PAYLOAD}. Then the connector leaves every dialog to
 * the harness, and presence shows no `prompts` field. The same checks run on every replaced
 * connection, and a failure there closes the desk and warns. Stopping `ep` ends the serve and not the
 * prompts, so call `close()` first: it ends every prompt and gives each open dialog back.
 */
export async function openPromptDesk(ep: CotalEndpoint, opts: { warn(msg: string): void }): Promise<PromptDesk> {
  if (typeof opts?.warn !== "function") throw new TypeError("openPromptDesk needs opts.warn");
  const max = ep.maxPayload;
  if (max < PROMPT_DESK_MIN_MAX_PAYLOAD)
    throw new Error(`the prompt desk needs a connection whose max_payload is at least ${PROMPT_DESK_MIN_MAX_PAYLOAD} bytes, and this one is ${max}`);
  const desk = new Desk(ep, opts.warn);
  const serve = desk.start();
  try {
    await serve.ready;
  } catch (e) {
    void desk.close();
    throw e;
  }
  desk.announce();
  return desk;
}

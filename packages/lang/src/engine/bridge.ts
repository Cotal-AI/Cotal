/**
 * The effect bridge: a run in the worker, its effects and its durable journal in the host.
 *
 * The module-named handler in `worker.ts` builds the whole effect path inside the thread, which is
 * right when a handler CAN be built from cloneable config. A driver's handler cannot: it is a live
 * object holding sockets, a mesh client and a lease-bound journal appender, and shipping any of
 * that into the isolate that also holds the hostile program would put credentials one Compartment
 * escape away from the code they exist to confine. This module is the other route: the handler and
 * the durable store STAY IN THE HOST, and the thread forwards the seam over a MessagePort.
 *
 * WHY THIS IS SOUND, measured against the contracts rather than assumed: the durable half of the
 * journal is `JournalStore.append(entry): Promise<void>`, awaited by `Journal.persist` before a
 * key joins `order` and before any effect fires — an async contract, which a port hop preserves
 * with the awaits lining up exactly as they line up over a PubAck today. Every `EffectHandler`
 * member except `now()` is async for the same reason. What is genuinely synchronous is `now()`
 * (a journal stamp) and the stop flag, and both go over shared memory: the stop buffer as it
 * always has, the clock over a dedicated SharedArrayBuffer this module owns — post the request,
 * `Atomics.wait`, read the answer. The handler's clock is injectable, so the bridge may not
 * shortcut it with the thread's own `Date.now()`: a simulated clock bridged that way would run a
 * program under two disagreeing times.
 *
 * WHAT CROSSES, and why every crossing is already fenced: effect requests, effect results, journal
 * entries, a failure's `code`/`kind`/`message`/`detail`, and a bind's `external` — exactly the
 * values the journal records, which the crossing rule (values.ts) fences at their write sites.
 * Errors cross with their DOMAIN, because perform.ts grades the two domains differently: the host
 * side stamps `"effect"` for an `EffectError` and `"host"` for anything else, and the thread
 * rehydrates the real class so a bridged failure journals byte-for-byte as an in-process one.
 *
 * TWO CALLS RUN AGAINST THE ARROW, and both are part of the handler's contract rather than
 * optional extras: `ctx.bind(external)` (the handler declaring the resource it just created —
 * host → thread, because the journal it must reach lives in the thread; its durable append then
 * comes straight back out to the host's store) and `signal.onCancel` (a race loser's cancellation
 * — thread → host, fired at the mirror the host handler was given). The host never blocks its
 * loop, which is what makes the one blocking wait in the thread safe: a `now()` posted while the
 * host is mid-effect is answered by the port handler immediately, from a synchronous clock.
 */

import type { MessagePort } from "node:worker_threads";
import type { EffectContext, EffectHandler } from "../effects.js";
import { EffectError } from "../effects.js";
import type { JournalEntry, JournalStore } from "../journal.js";
import type { StepKey } from "../keys.js";

/** One 16-byte SharedArrayBuffer: an Int32 answer flag at 0, the Float64 clock value at 8. */
export const CLOCK_BYTES = 16;

/** The ten async members of {@link EffectHandler}, the only methods the bridge will forward. */
const METHODS = [
  "spawn",
  "turn",
  "ask",
  "checkpoint",
  "sleep",
  "wait",
  "notify",
  "monitor",
  "openConclave",
  "closeConclave",
] as const;
type Method = (typeof METHODS)[number];

/** An error, flattened for the port with the fields both failure domains are graded on. */
interface WireError {
  readonly domain: "effect" | "host";
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly kind?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Preserved for append failures: `JournalAppendRejected` reads it off the store's throw. */
  readonly indeterminate?: boolean;
}

/** The plain-data half of an {@link EffectContext}; `signal` and `bind` are rebuilt per side. */
interface WireCtx {
  readonly key: StepKey;
  readonly requestId: string;
  readonly attempt: number;
  readonly resume?: Readonly<Record<string, unknown>>;
}

type ToHost =
  | { readonly kind: "effect"; readonly seq: number; readonly method: Method; readonly req: unknown; readonly ctx: WireCtx }
  | { readonly kind: "append"; readonly seq: number; readonly entry: JournalEntry }
  | { readonly kind: "cancel"; readonly seq: number; readonly reason: string }
  | { readonly kind: "bind-answer"; readonly bseq: number; readonly error?: WireError }
  | { readonly kind: "now" };

type ToThread =
  | { readonly kind: "answer"; readonly seq: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: "answer"; readonly seq: number; readonly ok: false; readonly error: WireError }
  | { readonly kind: "bind"; readonly bseq: number; readonly seq: number; readonly external: Readonly<Record<string, unknown>> };

function flatten(e: unknown): WireError {
  if (e instanceof EffectError) {
    return {
      domain: "effect",
      name: e.name,
      message: e.message,
      code: e.code,
      kind: e.kind,
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
    };
  }
  const err = e as { name?: unknown; message?: unknown; code?: unknown; indeterminate?: unknown };
  return {
    domain: "host",
    name: typeof err?.name === "string" ? err.name : "Error",
    message: typeof err?.message === "string" ? err.message : String(e),
    ...(typeof err?.code === "string" ? { code: err.code } : {}),
    ...(err?.indeterminate === true ? { indeterminate: true } : {}),
  };
}

/**
 * The thread's side of a flattened error, as the class the grading site expects.
 *
 * An `"effect"` failure becomes the real `EffectError`, because perform.ts records it as the
 * step's outcome; a `"host"` failure becomes a plain Error carrying whatever identifying fields
 * crossed, because the host domain is graded on shape, not class, and `indeterminate` must survive
 * for the journal's L5010 text to say the honest thing about an append nobody saw land.
 */
function rehydrate(w: WireError): Error {
  if (w.domain === "effect") return new EffectError(w.code ?? "L4000", w.kind ?? "handler-fault", w.message, w.detail);
  const e = new Error(w.message);
  e.name = w.name;
  if (w.code !== undefined) (e as Error & { code?: string }).code = w.code;
  if (w.indeterminate === true) (e as Error & { indeterminate?: boolean }).indeterminate = true;
  return e;
}

/**
 * THE THREAD'S HALF: an {@link EffectHandler} and a {@link JournalStore} over the port.
 *
 * Owned by the worker entry. The live `EffectContext` of every in-flight effect is kept by `seq`
 * so a host-initiated `bind` reaches the real context (and through it, the real journal), and so
 * a cancellation fires at the host the moment the thread's signal fires.
 */
export function bridgedSeam(port: MessagePort, clock: SharedArrayBuffer): { handler: EffectHandler; store: JournalStore } {
  const flag = new Int32Array(clock, 0, 1);
  const value = new Float64Array(clock, 8, 1);
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const live = new Map<number, EffectContext>();

  port.on("message", (m: ToThread) => {
    if (m.kind === "answer") {
      const p = pending.get(m.seq);
      // An answer nobody is waiting for is a protocol disagreement, not a value to drop quietly.
      if (p === undefined) throw new Error(`cotal-lang effect bridge: the host answered seq ${m.seq}, which this thread never asked`);
      pending.delete(m.seq);
      live.delete(m.seq);
      if (m.ok) p.resolve(m.value);
      else p.reject(rehydrate(m.error));
      return;
    }
    if (m.kind === "bind") {
      const ctx = live.get(m.seq);
      if (ctx === undefined) {
        // The effect settled between the handler's bind and this message arriving. The handler's
        // own await of `bind` is what carries the refusal; answering is all this side can do.
        port.postMessage({ kind: "bind-answer", bseq: m.bseq, error: { domain: "host", name: "Error", message: `effect ${m.seq} is no longer in flight; its bind cannot reach the journal` } } satisfies ToHost);
        return;
      }
      void ctx.bind(m.external).then(
        () => port.postMessage({ kind: "bind-answer", bseq: m.bseq } satisfies ToHost),
        (e: unknown) => port.postMessage({ kind: "bind-answer", bseq: m.bseq, error: flatten(e) } satisfies ToHost),
      );
      return;
    }
    throw new Error(`cotal-lang effect bridge: the host sent a message kind this thread does not know (${String((m as { kind?: unknown }).kind)})`);
  });

  const call = (method: Method, req: unknown, ctx: EffectContext): Promise<unknown> => {
    const s = seq++;
    live.set(s, ctx);
    ctx.signal.onCancel((reason) => port.postMessage({ kind: "cancel", seq: s, reason } satisfies ToHost));
    const answer = new Promise<unknown>((resolve, reject) => pending.set(s, { resolve, reject }));
    port.postMessage({
      kind: "effect",
      seq: s,
      method,
      req,
      ctx: {
        key: ctx.key,
        requestId: ctx.requestId,
        attempt: ctx.attempt,
        ...(ctx.resume !== undefined ? { resume: ctx.resume } : {}),
      },
    } satisfies ToHost);
    return answer;
  };

  const handler = {
    // The flag is cleared BEFORE the request is posted, so a host that answers before this thread
    // reaches the wait leaves the flag already flipped and the wait returns "not-equal" at once.
    now(): number {
      Atomics.store(flag, 0, 0);
      port.postMessage({ kind: "now" } satisfies ToHost);
      Atomics.wait(flag, 0, 0);
      return value[0] as number;
    },
  } as EffectHandler;
  for (const m of METHODS) {
    (handler as Record<Method, (req: unknown, ctx: EffectContext) => Promise<unknown>>)[m] = (req, ctx) => call(m, req, ctx);
  }

  const store: JournalStore = {
    append(entry: JournalEntry): Promise<void> {
      const s = seq++;
      const answer = new Promise<void>((resolve, reject) => pending.set(s, { resolve: () => resolve(), reject }));
      port.postMessage({ kind: "append", seq: s, entry } satisfies ToHost);
      return answer;
    },
  };

  return { handler, store };
}

export interface BridgeHost {
  /** The buffer the thread's `now()` blocks on; hand it to the worker beside the port. */
  readonly clock: SharedArrayBuffer;
  /** Stop servicing. Called once the run has answered; a message after that has no run behind it. */
  close(): void;
}

/**
 * THE HOST'S HALF: service the thread's seam from a live handler and a live store.
 *
 * The context handed to the handler is rebuilt around the wire's plain data: `bind` forwards to
 * the thread (where the journal lives) and its durable append comes back through `store.append`
 * on this side; `signal` is a mirror the thread's cancellations flip. The host never blocks —
 * every branch here either answers from a synchronous clock or awaits work it already owns.
 */
export function serviceBridge(port: MessagePort, seam: { readonly handler: EffectHandler; readonly store: JournalStore }): BridgeHost {
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  const flag = new Int32Array(clock, 0, 1);
  const value = new Float64Array(clock, 8, 1);
  let bseq = 0;
  const binds = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  const cancels = new Map<number, { fire: (reason: string) => void }>();

  port.on("message", (m: ToHost) => {
    if (m.kind === "now") {
      value[0] = seam.handler.now();
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
      return;
    }
    if (m.kind === "append") {
      void seam.store.append(m.entry).then(
        () => port.postMessage({ kind: "answer", seq: m.seq, ok: true, value: undefined } satisfies ToThread),
        (e: unknown) => port.postMessage({ kind: "answer", seq: m.seq, ok: false, error: flatten(e) } satisfies ToThread),
      );
      return;
    }
    if (m.kind === "effect") {
      const seqHere = m.seq;
      let cancelled = false;
      let reason: string | undefined;
      const listeners: ((reason: string) => void)[] = [];
      cancels.set(seqHere, {
        fire: (r) => {
          cancelled = true;
          reason = r;
          for (const fn of listeners) fn(r);
        },
      });
      const ctx: EffectContext = {
        key: m.ctx.key,
        requestId: m.ctx.requestId,
        attempt: m.ctx.attempt,
        ...(m.ctx.resume !== undefined ? { resume: m.ctx.resume } : {}),
        signal: {
          get cancelled() {
            return cancelled;
          },
          get reason() {
            return reason;
          },
          onCancel(fn: (reason: string) => void) {
            listeners.push(fn);
          },
        },
        bind: (external) => {
          const b = bseq++;
          const answer = new Promise<void>((resolve, reject) => binds.set(b, { resolve, reject }));
          port.postMessage({ kind: "bind", bseq: b, seq: seqHere, external } satisfies ToThread);
          return answer;
        },
      };
      const method = seam.handler[m.method];
      // The method set is this module's own constant, so an unknown name is the two sides
      // disagreeing about the protocol — refused as an answer, never dispatched dynamically.
      if (!METHODS.includes(m.method) || typeof method !== "function") {
        port.postMessage({ kind: "answer", seq: seqHere, ok: false, error: { domain: "host", name: "Error", message: `the effect bridge does not forward "${String(m.method)}"` } } satisfies ToThread);
        cancels.delete(seqHere);
        return;
      }
      void (method as (req: unknown, ctx: EffectContext) => Promise<unknown>).call(seam.handler, m.req, ctx).then(
        (v: unknown) => {
          cancels.delete(seqHere);
          port.postMessage({ kind: "answer", seq: seqHere, ok: true, value: v } satisfies ToThread);
        },
        (e: unknown) => {
          cancels.delete(seqHere);
          port.postMessage({ kind: "answer", seq: seqHere, ok: false, error: flatten(e) } satisfies ToThread);
        },
      );
      return;
    }
    if (m.kind === "cancel") {
      // A cancel finds its mirror only while the effect is in flight: the answer deletes the
      // mirror, so the walker's post-settle blanket cancellations (aimed at arms that already
      // returned) do not cross. Deliberate, and pinned by the engine suite's parked-loser cells:
      // the host handler hears a cancel exactly when its effect is still open, which is the only
      // time it can act on one.
      cancels.get(m.seq)?.fire(m.reason);
      return;
    }
    if (m.kind === "bind-answer") {
      const b = binds.get(m.bseq);
      if (b === undefined) throw new Error(`cotal-lang effect bridge: the thread answered bind ${m.bseq}, which this host never asked`);
      binds.delete(m.bseq);
      if (m.error === undefined) b.resolve();
      else b.reject(rehydrate(m.error));
      return;
    }
    throw new Error(`cotal-lang effect bridge: the thread sent a message kind this host does not know (${String((m as { kind?: unknown }).kind)})`);
  });

  return { clock, close: () => port.close() };
}

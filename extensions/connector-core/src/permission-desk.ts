/**
 * The permission desk: one seat's holder of its harness's permission prompts (SPEC §8.2).
 *
 * While a prompt is held its owner can answer it from another session, and the harness's own dialog
 * still works; the first answer applies. The desk writes one record per prompt and is that record's
 * only writer. Every event about one prompt runs on that prompt's own chain and moves the record
 * only through `stepPermission`. An answer is written before its verdict reaches the hook, and is
 * accepted only once the hook confirms the verdict reached the harness. A signal from the machine
 * (its tool ran, its hook went away, its deadline passed) is applied first and written after,
 * because the harness has already acted on it.
 */
import {
  canonicalJson,
  mintPermissionRequestId,
  permissionInput,
  stepPermission,
  type CotalEndpoint,
  type IncomingPermissionAnswer,
  type JsonValue,
  type PermissionAnswerReply,
  type PermissionEvent,
  type PermissionHolderPort,
  type PermissionRecord,
  type PermissionRequestId,
  type PermissionState,
} from "@cotal-ai/core";

/** One prompt, as the hook parsed it from the harness. */
export interface PermissionAsk {
  readonly tool: string;
  readonly input: JsonValue;
  readonly cwd?: string;
}

/** What the hook hands the harness. `release` hands it nothing, so the harness keeps, or has
 *  already taken, its own answer. */
export type PermissionVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly message: string }
  | { readonly kind: "release" };

export interface PermissionHold {
  readonly verdict: Promise<PermissionVerdict>;
  /** Whether the hook confirmed that the verdict reached the harness. */
  confirm(delivered: boolean): void;
}

export interface PermissionDesk {
  /** Hold one prompt. `hookGone` aborts when the hook's connection closes before its verdict. */
  hold(ask: PermissionAsk, hookGone: AbortSignal): PermissionHold;
  /** The harness ran these tool calls: a prompt still held for one of them was allowed at the terminal. */
  toolsRan(calls: readonly { readonly tool: string; readonly input: unknown }[]): void;
  /** The turn ended: every prompt still held was allowed at the terminal. */
  turnEnded(): void;
  /** The newest prompt still waiting for an answer. */
  waiting(): PermissionRequestId | undefined;
  /** Stop serving and give every held prompt back to the terminal, writing nothing: readers see
   *  the holder gone. */
  close(): void;
}

export interface PermissionDeskOptions {
  /** Each prompt expires this long after it was asked, and is then denied. Unset, it never expires. */
  readonly deadlineMs?: number;
  /** How long a withdrawn hook waits before the record says so, so that a session ending, which
   *  closes the desk, reads as the holder gone and not as an answer at the terminal. */
  readonly withdrawSettleMs?: number;
  /** Told why a prompt stays with the terminal only. */
  readonly warn?: (message: string) => void;
}

/** The control server confirms or refuses a handoff within 5 s; this only bounds a hook that never
 *  reports at all. */
const HANDOFF_BOUND_MS = 10_000;
const RETRY_MS = 1_000;
/** Settled prompts remembered, so a late answer reads `answered` rather than `gone`. */
const SETTLED_MEMORY = 256;
const RELEASE: PermissionVerdict = { kind: "release" };

export const denyMessage = (note: string | undefined): string => (note ? `Denied from Cotal: ${note}` : "Denied from Cotal.");
export const expiryMessage = (deadline: number): string => `No answer before ${new Date(deadline).toISOString()}.`;

function verdictFor(state: PermissionState, deadline: number | undefined): PermissionVerdict {
  switch (state.kind) {
    case "approved":
      return { kind: "allow" };
    case "denied":
      return { kind: "deny", message: denyMessage(state.note) };
    case "expired":
      return { kind: "deny", message: expiryMessage(deadline ?? state.at) };
    default:
      return RELEASE;
  }
}

/** A tool call's identity across the harness's hooks: the prompt names no call id, the batch does
 *  not repeat the prompt, and both carry the tool and its input. */
function callKey(tool: string, input: unknown): string | undefined {
  try {
    return canonicalJson([tool, input]);
  } catch {
    return undefined;
  }
}

interface Held {
  record: PermissionRecord;
  /** The revision this desk last wrote, or `absent` until the create lands. */
  revision: number | "absent";
  /** The msg-id step of the next write. */
  step: number;
  chain: Promise<unknown>;
  /** waiting: the hook is connected with no verdict. gone: it closed first. answered: it has its verdict. */
  hook: "waiting" | "gone" | "answered";
  /** Something else wrote the record, or the store refused it: the desk stops writing it. */
  tainted: boolean;
  readonly call: string | undefined;
  readonly delivered: Promise<boolean>;
  readonly timers: ReturnType<typeof setTimeout>[];
  give(verdict: PermissionVerdict): void;
}

/** Open the desk for the seat `ep` serves. Throws where no prompt can be relayed: an open mesh, or
 *  an endpoint with no lifecycle UID. */
export function openPermissionDesk(ep: CotalEndpoint, opts: PermissionDeskOptions = {}): PermissionDesk {
  const settleMs = opts.withdrawSettleMs ?? 1_000;
  const prompts = new Map<PermissionRequestId, Held>();
  const settled: PermissionRequestId[] = [];
  let closed = false;
  const port: PermissionHolderPort = ep.openPermissionHolder((a) => answer(a));

  const enqueue = <T>(h: Held, task: () => Promise<T>): Promise<T> => {
    const run = h.chain.then(task);
    h.chain = run.catch(() => {});
    return run;
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());
  const later = (h: Held, ms: number, fn: () => void): void => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    h.timers.push(t);
  };

  /** Write `record` as the prompt's next revision. An unknown outcome is retried until it lands; a
   *  conflict or a refusal taints the prompt and gives it back to the terminal. */
  async function project(h: Held, record: PermissionRecord): Promise<boolean> {
    let expected: number | "absent" | "retry" = h.revision;
    for (;;) {
      if (closed || h.tainted) return false;
      const w = await port.write(record, h.step, expected);
      if (w.kind === "written") {
        h.revision = w.revision;
        h.step++;
        return true;
      }
      if (w.kind !== "unavailable") {
        h.tainted = true;
        h.give(RELEASE);
        remember(h);
        opts.warn?.(w.kind === "conflict"
          ? `permission prompt ${record.id} has another writer, so it stays with the terminal`
          : `permission prompt ${record.id} stays with the terminal: the record store refused it (${w.reason})`);
        return false;
      }
      expected = "retry";
      await sleep(RETRY_MS);
    }
  }

  const remember = (h: Held): void => {
    settled.push(h.record.id);
    if (settled.length > SETTLED_MEMORY) prompts.delete(settled.shift()!);
  };

  /** A signal from the machine, already acted on by the harness: apply it, then write it. */
  async function apply(h: Held, event: PermissionEvent): Promise<void> {
    if (h.tainted) return;
    const step = stepPermission(h.record.state, event);
    if (step.kind !== "move") return;
    h.record = { ...h.record, state: step.next };
    h.give(verdictFor(step.next, h.record.deadline));
    if (await project(h, h.record)) remember(h);
  }
  const signal = (h: Held, event: PermissionEvent): void => void enqueue(h, () => apply(h, event));

  function answer(a: IncomingPermissionAnswer): Promise<PermissionAnswerReply> {
    const h = prompts.get(a.id);
    if (!h) return Promise.resolve({ v: 1, ok: false, code: "unknown" });
    return enqueue(h, async (): Promise<PermissionAnswerReply> => {
      if (h.tainted) return { v: 1, ok: false, code: "conflict" };
      if (a.answer.decision === "approve" && h.record.input.kind === "withheld") return { v: 1, ok: false, code: "withheld" };
      const step = stepPermission(h.record.state, { kind: "answer", by: a.by, at: Date.now(), ...a.answer });
      if (step.kind === "refuse") return { v: 1, ok: false, code: step.code, state: h.record.state };
      if (step.kind !== "move") return { v: 1, ok: true, state: h.record.state };
      const next = { ...h.record, state: step.next };
      if (!(await project(h, next))) return { v: 1, ok: false, code: closed ? "unknown" : "conflict" };
      h.record = next;
      h.give(verdictFor(next.state, next.deadline));
      const delivered = await Promise.race([h.delivered, sleep(HANDOFF_BOUND_MS).then(() => false)]);
      if (delivered) {
        remember(h);
        return { v: 1, ok: true, state: h.record.state };
      }
      await apply(h, { kind: "undelivered", at: Date.now() });
      return { v: 1, ok: false, code: "answered", state: h.record.state };
    });
  }

  return {
    hold(ask, hookGone) {
      if (closed) return { verdict: Promise.resolve(RELEASE), confirm: () => {} };
      const askedAt = Date.now();
      const base = {
        v: 1 as const, id: mintPermissionRequestId(), agent: port.agent, holder: port.holder, tool: ask.tool,
        ...(ask.cwd ? { cwd: ask.cwd } : {}), askedAt,
        ...(opts.deadlineMs !== undefined ? { deadline: askedAt + opts.deadlineMs } : {}),
        state: { kind: "pending" } as const,
      };
      const record: PermissionRecord = { ...base, input: permissionInput(base, ask.input) };
      let settle!: (verdict: PermissionVerdict) => void;
      const verdict = new Promise<PermissionVerdict>((resolve) => (settle = resolve));
      let confirm!: (delivered: boolean) => void;
      const delivered = new Promise<boolean>((resolve) => (confirm = resolve));
      const h: Held = {
        record, revision: "absent", step: 0, chain: Promise.resolve(), hook: "waiting", tainted: false,
        call: callKey(ask.tool, ask.input), delivered, timers: [],
        give(v) {
          if (h.hook === "answered") return;
          h.hook = "answered";
          settle(v);
        },
      };
      prompts.set(record.id, h);
      void enqueue(h, () => project(h, record));
      const withdraw = (): void => {
        if (h.hook === "waiting") h.hook = "gone";
        later(h, settleMs, () => { if (!closed) signal(h, { kind: "withdrawn", at: Date.now() }); });
      };
      if (hookGone.aborted) withdraw();
      else hookGone.addEventListener("abort", withdraw, { once: true });
      if (record.deadline !== undefined) later(h, record.deadline - askedAt, () => signal(h, { kind: "deadline", at: Date.now() }));
      return { verdict, confirm: (d) => confirm(d) };
    },
    toolsRan(calls) {
      const ran = new Set(calls.map((c) => callKey(c.tool, c.input)));
      for (const h of prompts.values())
        if (h.hook === "waiting" && h.call !== undefined && ran.has(h.call)) signal(h, { kind: "tool-ran", at: Date.now() });
    },
    turnEnded() {
      for (const h of prompts.values()) if (h.hook === "waiting") signal(h, { kind: "tool-ran", at: Date.now() });
    },
    waiting() {
      let newest: Held | undefined;
      for (const h of prompts.values())
        if (h.hook === "waiting" && h.record.state.kind === "pending" && (!newest || h.record.askedAt >= newest.record.askedAt)) newest = h;
      return newest?.record.id;
    },
    close() {
      if (closed) return;
      closed = true;
      port.close();
      for (const h of prompts.values()) {
        for (const t of h.timers) clearTimeout(t);
        h.give(RELEASE);
      }
    },
  };
}

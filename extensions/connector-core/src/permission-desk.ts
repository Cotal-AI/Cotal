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
  PERMISSION_HANDOFF_BOUND_MS,
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
  /** The harness scope that asked, such as a subagent's id. Absent means the main thread. */
  readonly scope?: string;
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
  /** The harness ran these tool calls in `scope`. Each run settles one prompt still held in that scope
   *  for the same tool and input, the oldest first, as allowed at the terminal. */
  toolsRan(calls: readonly { readonly tool: string; readonly input: unknown }[], scope?: string): void;
  /** `scope` ended its turn: every prompt still held in it was allowed at the terminal. Absent means
   *  the main thread. */
  turnEnded(scope?: string): void;
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
  /** The harness ran its tool, or its scope ended, and that signal is queued: no later run matches it. */
  ran: boolean;
  /** Something else wrote the record, or the store refused it: the desk stops writing it. */
  tainted: boolean;
  readonly call: string | undefined;
  readonly scope: string | undefined;
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
  /** The harness ran the prompt's tool. Marked now, so a second run of the same call settles another
   *  prompt rather than this one again. */
  const ran = (h: Held): void => {
    h.ran = true;
    signal(h, { kind: "tool-ran", at: Date.now() });
  };

  /** An answer from the rail. A prompt this desk does not hold gets no reply: an answer is addressed
   *  to the process its record names, so silence here leaves the reply to that process. */
  function answer(a: IncomingPermissionAnswer): Promise<PermissionAnswerReply | undefined> {
    const h = prompts.get(a.id);
    if (!h) return Promise.resolve(undefined);
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
      // The control server confirms or refuses a handoff within 5 s; the bound only covers a hook that
      // never reports at all. An answerer waits longer, so it reads the outcome below.
      const delivered = await Promise.race([h.delivered, sleep(PERMISSION_HANDOFF_BOUND_MS).then(() => false)]);
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
        record, revision: "absent", step: 0, chain: Promise.resolve(), hook: "waiting", ran: false, tainted: false,
        call: callKey(ask.tool, ask.input), scope: ask.scope, delivered, timers: [],
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
    toolsRan(calls, scope) {
      // The prompt names no call id, so a run matches by scope, tool and input, one run to one prompt.
      // `prompts` keeps hold order, so the oldest matching prompt settles first.
      for (const c of calls) {
        const call = callKey(c.tool, c.input);
        if (call === undefined) continue;
        for (const h of prompts.values())
          if (h.hook === "waiting" && !h.ran && h.scope === scope && h.call === call) {
            ran(h);
            break;
          }
      }
    },
    turnEnded(scope) {
      for (const h of prompts.values()) if (h.hook === "waiting" && !h.ran && h.scope === scope) ran(h);
    },
    waiting() {
      let newest: Held | undefined;
      for (const h of prompts.values())
        if (h.hook === "waiting" && !h.ran && h.record.state.kind === "pending" && (!newest || h.record.askedAt >= newest.record.askedAt)) newest = h;
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

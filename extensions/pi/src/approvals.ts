/**
 * Pi's tool calls behind the agent's prompt desk (SPEC 13.22), for a seat launched with
 * `askPermissions`.
 *
 * Pi has no permission dialog of its own: an extension's `tool_call` handler runs before each call
 * and may block it, and Pi waits for the handler. So every call that is not read-only opens a
 * prompt, and the handler answers with what the owner chose. There is one path: a call the desk
 * cannot hold is blocked with a reason that names why, and Pi's own UI is never asked.
 */
import { AGENT_PROMPT_CONTENT_MAX_BYTES, canonicalJson, type PromptContent, type PromptInput, type PromptOption } from "@cotal-ai/core";
import type { PromptDesk, PromptHold, PromptVerdict } from "@cotal-ai/connector-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi's read-only tools run without asking, as do the seat's own Cotal tools. */
const UNASKED = new Set(["read", "grep", "find", "ls"]);
/** How long a prompt is offered: Pi waits for the handler without a limit. */
const OPEN_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an answered prompt waits for Pi to finish the call, which an allowed tool can take long. */
const SETTLE_MS = 24 * 60 * 60 * 1000;

const ALLOW: PromptOption = { id: "allow", label: "Allow", effect: "proceed" };
const DENY: PromptOption = { id: "deny", label: "Deny", effect: "refuse", note: "optional" };
const DENIED = "The user denied this tool call.";

/** The fields of Pi's `tool_call` event a prompt is built from. */
export interface PiToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** What the `tool_call` handler returns: nothing lets the call run. */
export type PiToolCallAnswer = { block: true; reason: string } | undefined;

export interface PiApprovals {
  /** The `tool_call` handler. `signal` aborts when the turn is stopped. */
  ask(call: PiToolCall, signal: AbortSignal | undefined, cwd: string | undefined): Promise<PiToolCallAnswer>;
  /** Pi finished a call, the answered ones included: the answer applied. */
  ended(toolCallId: string): void;
}

function content(call: PiToolCall, input: PromptInput, options: PromptOption[], cwd: string | undefined): PromptContent {
  return {
    kind: "permission",
    title: `Allow ${call.toolName}?`,
    subject: { type: "tool", name: call.toolName, input, ...(cwd ? { cwd } : {}) },
    options,
    source: { harness: "pi", toolCallId: call.toolCallId },
  };
}

/** The prompt for a call. Its input shows in full or not at all: a content over the size limit
 *  says how large the input is and offers only Deny. */
function callContent(call: PiToolCall, cwd: string | undefined): PromptContent {
  const full = content(call, { kind: "shown", value: call.input }, [ALLOW, DENY], cwd);
  if (Buffer.byteLength(canonicalJson(full)) <= AGENT_PROMPT_CONTENT_MAX_BYTES) return full;
  return content(call, { kind: "omitted", bytes: Buffer.byteLength(canonicalJson(call.input)) }, [DENY], cwd);
}

const block = (reason: string): PiToolCallAnswer => ({ block: true, reason });
const answerOf = (verdict: PromptVerdict): PiToolCallAnswer => (verdict.option === ALLOW.id ? undefined : block(verdict.note || DENIED));

export function createPiApprovals(opts: { desk(): PromptDesk | undefined; warn(msg: string): void }): PiApprovals {
  /** Answered prompts waiting for Pi to finish their call. */
  const answered = new Map<string, PromptHold>();
  const refuse = (call: PiToolCall, cause: string): PiToolCallAnswer => {
    const reason = `Cotal could not ask the agent's owner to approve ${call.toolName}: ${cause}. The call was not run.`;
    opts.warn(reason);
    return block(reason);
  };
  return {
    ask(call, signal, cwd) {
      if (UNASKED.has(call.toolName) || call.toolName.startsWith("cotal_")) return Promise.resolve(undefined);
      const desk = opts.desk();
      if (!desk) return Promise.resolve(refuse(call, "the agent endpoint does not serve its prompt desk"));
      if (signal?.aborted) return Promise.resolve(block("The turn was stopped before the call was approved."));
      return new Promise<PiToolCallAnswer>((resolve) => {
        let hold: PromptHold;
        let done = false;
        const finish = (answer: () => PiToolCallAnswer): void => {
          if (done) return;
          done = true;
          signal?.removeEventListener("abort", stopped);
          resolve(answer());
        };
        const stopped = (): void => {
          finish(() => block("The turn was stopped before the call was approved."));
          hold.settle({ kind: "withdrawn" });
        };
        try {
          hold = desk.open({ content: callContent(call, cwd), openMs: OPEN_MS, settleMs: SETTLE_MS }, {
            deliver: (verdict) => {
              answered.set(call.toolCallId, hold);
              finish(() => answerOf(verdict));
              return Promise.resolve({ kind: "delivered" });
            },
            end: ({ attempted }) => {
              answered.delete(call.toolCallId);
              if (!attempted) finish(() => refuse(call, "the prompt closed without an answer"));
            },
          });
        } catch (e) {
          finish(() => refuse(call, (e as Error).message));
          return;
        }
        signal?.addEventListener("abort", stopped, { once: true });
      });
    },
    ended(toolCallId) {
      answered.get(toolCallId)?.settle({ kind: "confirmed" });
      answered.delete(toolCallId);
    },
  };
}

/** Put this load's tool calls behind the desk `desk()` reads, which is undefined while the agent
 *  endpoint does not serve it. */
export function askBeforeTools(pi: ExtensionAPI, desk: () => PromptDesk | undefined): void {
  const approvals = createPiApprovals({ desk, warn: (msg) => console.error(`Pi ${msg}`) });
  pi.on("tool_call", (event, context) => approvals.ask(event, context.signal, context.cwd));
  pi.on("tool_execution_end", (event) => approvals.ended(event.toolCallId));
}

/**
 * Claude Code's tool permissions on the agent's prompt desk (SPEC 13.22).
 *
 * A `PermissionRequest` opens a prompt that an authorized person or agent can answer over the
 * agent's `agent` endpoint, while Claude's own dialog stays open in the terminal. The module takes
 * four inputs and reads nothing else of a hook event:
 *
 * - hold: a tool permission and the held exchange of its hook (one write, its receipt, a close signal);
 * - batch: the calls a scope ran, each as its tool name and the digest of its input;
 * - turn end: a scope's turn ended;
 * - session end: every scope ended.
 *
 * Claude names no tool call in a `PermissionRequest`, so nothing Claude sends later can be tied to one
 * prompt. The module keeps a match key per prompt (the scope, the tool name and the SHA-256 of the RFC
 * 8785 canonical JSON of the tool input) and reports only what that key can show: a batch with the key
 * is a sighting tied to the subject, a turn end and a closed hook connection show nothing. It never
 * reports `confirmed`, `local` or a sighting tied to the prompt.
 *
 * {@link launchedSessionHooks} is the hook transport of a session Cotal launched: the control server's
 * held exchange, and every other event handed on, whole and once, to the existing consumer.
 */
import { createHash } from "node:crypto";
import { AGENT_PROMPT_CONTENT_MAX_BYTES, canonicalJson, type PromptContent, type PromptInput, type PromptOption } from "@cotal-ai/core";
import type { Delivery, HookEvent, HookHandle, MeshAgent, PromptDesk, PromptHold, PromptVerdict } from "@cotal-ai/connector-core";

/** How long a prompt is offered: a prompt left on a Friday can still be answered on Monday. */
const OPEN_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an answered prompt waits for a batch or a turn end before it closes with nothing seen. */
const SETTLE_MS = 15 * 60 * 1000;
/** Dialogs the terminal keeps: a question and a plan need more than allow and deny. */
const LEFT_TO_TERMINAL: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** The hook's `agent_id`: a subagent's id, or undefined for the main thread. */
export type Scope = string | undefined;

/** One tool permission Claude asks for. */
export interface ToolPermission {
  scope: Scope;
  tool: string;
  input: unknown;
  cwd?: string;
  /** The MCP server that serves the tool, for an `mcp__*` tool. */
  server?: string;
}

/** One call a batch ran: its tool name and the digest of its input. */
export interface ToolCallKey {
  tool: string;
  digest: string;
}

/** The held hook connection of one tool permission. */
export interface HeldExchange {
  /** Aborts when the hook's connection closes. */
  readonly closed: AbortSignal;
  /** Write the one hook output. Resolves on the hook's receipt for it and stays pending without one. */
  write(output: Record<string, unknown>): Promise<void>;
}

/** The module's four inputs. */
export interface ClaudePrompts {
  hold(permission: ToolPermission, exchange: HeldExchange): void;
  batch(scope: Scope, calls: readonly ToolCallKey[]): void;
  turnEnd(scope: Scope): void;
  sessionEnd(): void;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The SHA-256 of the RFC 8785 canonical JSON of a tool input, or undefined for a value that is not
 *  interchangeable JSON. */
function inputDigest(input: unknown): string | undefined {
  try {
    return sha256(canonicalJson(input));
  } catch {
    return undefined;
  }
}

const ALLOW: PromptOption = { id: "allow", label: "Allow", effect: "proceed" };
const DENY: PromptOption = { id: "deny", label: "Deny", effect: "refuse", note: "optional" };

function permissionContent(p: ToolPermission, input: PromptInput, options: PromptOption[]): PromptContent {
  return {
    kind: "permission",
    title: `Allow ${p.tool}?`,
    subject: { type: "tool", name: p.tool, input, ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.server ? { server: p.server } : {}) },
    options,
    source: { harness: "claude-code", ...(p.scope !== undefined ? { scope: p.scope } : {}) },
  };
}

/** The hook output that hands an accepted answer to Claude. */
function decision(verdict: PromptVerdict): Record<string, unknown> {
  const d = verdict.option === ALLOW.id
    ? { behavior: "allow" }
    : { behavior: "deny", ...(verdict.note ? { message: verdict.note } : {}) };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } };
}

/** One prompt the module holds, from `open` to the desk's `end`. */
interface Live {
  readonly scope: Scope;
  /** The tool name and the input digest. The scope is compared on its own. */
  readonly key: string;
  /** `deliver` ran: the prompt is `sent`, and what its connection does next shows nothing. */
  answered: boolean;
}

const keyOf = (tool: string, digest: string): string => `${tool}\0${digest}`;

/**
 * The prompt module over `desk`, which reads the agent's desk when a permission arrives: undefined
 * while it is not served. On Windows it opens no prompts and says why once, here: serving them there
 * is its own work, and the hook answers a permission itself before it reaches this module.
 */
export function createClaudePrompts(opts: {
  desk(): PromptDesk | undefined;
  warn(msg: string): void;
  platform?: NodeJS.Platform;
}): ClaudePrompts {
  const gated = (opts.platform ?? process.platform) === "win32";
  if (gated)
    opts.warn("tool permissions are not served on the agent endpoint on Windows yet, so Claude's own dialog answers each one");
  const live = new Map<Live, PromptHold>();
  /** Report to every live prompt of `scope` (of every scope for `null`): a sighting tied to the
   *  subject for each whose key is in `ran`, or, with no `ran`, that the scope's turn ended. */
  const report = (scope: Scope | null, ran?: ReadonlySet<string>): void => {
    for (const [p, hold] of [...live]) {
      if (scope !== null && p.scope !== scope) continue;
      if (ran) {
        if (ran.has(p.key)) hold.settle({ kind: "observed", seen: { tie: "subject", effect: "proceed" } });
      } else {
        hold.settle(p.answered ? { kind: "observed", seen: { tie: "none" } } : { kind: "withdrawn" });
      }
    }
  };
  return {
    hold(permission, exchange) {
      const leave = (): void => {
        if (!exchange.closed.aborted) void exchange.write({});
      };
      if (gated || LEFT_TO_TERMINAL.has(permission.tool) || exchange.closed.aborted) return leave();
      const desk = opts.desk();
      if (!desk) return leave();
      let p: Live;
      let hold: PromptHold;
      try {
        const input = canonicalJson(permission.input);
        p = { scope: permission.scope, key: keyOf(permission.tool, sha256(input)), answered: false };
        let content = permissionContent(permission, { kind: "shown", value: permission.input }, [ALLOW, DENY]);
        if (Buffer.byteLength(canonicalJson(content)) > AGENT_PROMPT_CONTENT_MAX_BYTES)
          content = permissionContent(permission, { kind: "omitted", bytes: Buffer.byteLength(input) }, [DENY]);
        hold = desk.open({ content, openMs: OPEN_MS, settleMs: SETTLE_MS }, {
          deliver: (verdict): Promise<Delivery> => {
            if (exchange.closed.aborted) return Promise.resolve({ kind: "gone" });
            p.answered = true;
            return exchange.write(decision(verdict)).then(() => ({ kind: "delivered" }));
          },
          end: ({ attempted }) => {
            live.delete(p);
            if (!attempted) leave();
          },
        });
      } catch (e) {
        opts.warn(`Claude's own dialog answers this ${permission.tool} permission: ${(e as Error).message}`);
        return leave();
      }
      live.set(p, hold);
      exchange.closed.addEventListener("abort", () => {
        if (live.has(p) && !p.answered) hold.settle({ kind: "withdrawn" });
      }, { once: true });
    },
    batch(scope, calls) {
      report(scope, new Set(calls.map((c) => keyOf(c.tool, c.digest))));
    },
    turnEnd(scope) {
      report(scope);
    },
    sessionEnd() {
      report(null);
    },
  };
}

// ---- the launched session's hook transport ----------------------------------------------------

const scopeOf = (ev: HookEvent): Scope => (typeof ev.agent_id === "string" && ev.agent_id ? ev.agent_id : undefined);

/** A `PostToolBatch`'s calls: one per element of `tool_calls` with a string `tool_name` and an input
 *  that is interchangeable JSON. */
function toolCalls(ev: HookEvent): ToolCallKey[] {
  if (!Array.isArray(ev.tool_calls)) return [];
  return ev.tool_calls.flatMap((c: { tool_name?: unknown; tool_input?: unknown } | null) => {
    if (typeof c?.tool_name !== "string") return [];
    const digest = inputDigest(c.tool_input);
    return digest === undefined ? [] : [{ tool: c.tool_name, digest }];
  });
}

/** The hook consumer the session had before prompts: it sees every event but `PermissionRequest`. */
export interface HookConsumer {
  handle(agent: MeshAgent, ev: HookEvent): Promise<Record<string, unknown>>;
  onReply(ev: HookEvent, delivered: boolean, handoff?: boolean): void;
}

/**
 * The control server's handler and reply observer for a session Cotal launched. A
 * `PermissionRequest` is held until the module writes its output, or until its hook's connection
 * closes, and the relay's receipt for that output is the exchange's receipt. Every other event goes to
 * the module's inputs first and then to `next`, whole and once, which replies to it.
 */
export function launchedSessionHooks(prompts: ClaudePrompts, next: HookConsumer, warn: (msg: string) => void): {
  handle: HookHandle;
  onReply(ev: HookEvent, delivered: boolean, handoff: boolean): void;
} {
  const receipts = new WeakMap<HookEvent, () => void>();
  const held = (ev: HookEvent, closed: AbortSignal): Promise<Record<string, unknown>> => new Promise((resolve) => {
    const tool = ev.tool_name;
    if (typeof tool !== "string" || !tool || closed.aborted) return resolve({});
    // Nothing written can reach a closed hook, and the server waits on this handler until it returns.
    closed.addEventListener("abort", () => resolve({}), { once: true });
    const server = (ev.mcp_server as { name?: unknown } | null | undefined)?.name;
    try {
      prompts.hold({
        scope: scopeOf(ev), tool, input: ev.tool_input,
        ...(typeof ev.cwd === "string" && ev.cwd ? { cwd: ev.cwd } : {}),
        ...(typeof server === "string" && server ? { server } : {}),
      }, {
        closed,
        write: (output) => {
          resolve(output);
          return new Promise<void>((confirmed) => receipts.set(ev, confirmed));
        },
      });
    } catch (e) {
      warn(`a tool permission was left to Claude's dialog: ${(e as Error).message}`);
      resolve({});
    }
  });
  const observe = (ev: HookEvent): void => {
    switch (ev.hook_event_name) {
      case "PostToolBatch":
        return prompts.batch(scopeOf(ev), toolCalls(ev));
      case "Stop":
      case "StopFailure":
      case "SubagentStop":
        return prompts.turnEnd(scopeOf(ev));
      case "SessionEnd":
        return prompts.sessionEnd();
    }
  };
  return {
    handle: (agent, ev, ctx) => {
      if (ev.hook_event_name === "PermissionRequest") return held(ev, ctx.signal);
      try {
        observe(ev);
      } catch (e) {
        warn(`the prompt desk missed a ${ev.hook_event_name} event: ${(e as Error).message}`);
      }
      return next.handle(agent, ev);
    },
    onReply: (ev, delivered, handoff) => {
      if (ev.hook_event_name !== "PermissionRequest") return next.onReply(ev, delivered, handoff);
      const confirmed = receipts.get(ev);
      receipts.delete(ev);
      if (delivered && handoff) confirmed?.();
    },
  };
}

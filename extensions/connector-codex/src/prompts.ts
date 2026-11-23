/**
 * Codex's approval requests and questions on the agent's prompt desk (SPEC 13.22).
 *
 * When the thread's approval policy asks, the app-server sends this host a request before a command
 * runs or a file change applies; when the model calls `request_user_input`, it sends the questions.
 * Each request opens a prompt that an authorized person or agent answers over the agent's `agent`
 * endpoint, and the answer goes back as the request's JSON-RPC result. A Codex TUI attached to the
 * thread shows the same request and may answer it first.
 *
 * The module reports only what the app-server shows: `serverRequest/resolved` says it stopped
 * waiting, and says nothing of who answered. So a prompt the app-server resolved is `withdrawn`, and
 * a remote answer closes unconfirmed. A request the module does not take is declined by the driver,
 * as a request that reaches the host while no prompt desk is served.
 */
import { AGENT_PROMPT_CONTENT_MAX_BYTES, canonicalJson, type PromptContent, type PromptOption } from "@cotal-ai/core";
import type { Delivery, PromptDesk, PromptHold, PromptVerdict } from "@cotal-ai/connector-core";
import type { AppServerDriver, ServerRequest, ThreadItem } from "./app-server.js";

/** How long a prompt is offered: a prompt left on a Friday can still be answered on Monday. */
const OPEN_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an answered prompt waits for the app-server to resolve the request. */
const SETTLE_MS = 15 * 60 * 1000;

const COMMAND = "item/commandExecution/requestApproval";
const FILE_CHANGE = "item/fileChange/requestApproval";
const QUESTIONS = "item/tool/requestUserInput";

/** The decisions both v2 approval requests take, in the order Codex's own dialog offers them, each
 *  under an option id SPEC 13.22 admits. */
const DECISIONS: readonly (PromptOption & { decision: string })[] = [
  { id: "accept", decision: "accept", label: "Allow", effect: "proceed" },
  { id: "accept-for-session", decision: "acceptForSession", label: "Allow for this session", effect: "proceed", persists: "Codex stops asking for the same approval until its session ends" },
  { id: "decline", decision: "decline", label: "Deny", effect: "refuse" },
  { id: "cancel", decision: "cancel", label: "Deny and stop the turn", effect: "cancel" },
];
const SUBMIT: PromptOption = { id: "submit", label: "Submit", effect: "proceed", form: "required" };
const SKIP: PromptOption = { id: "decline", label: "Don't answer", effect: "refuse" };

/** The module's inputs, from the driver and the thread's item stream. */
export interface CodexPrompts {
  /** Open a prompt for `request`. False when it is not one the module takes, or no desk serves it:
   *  the driver then declines it. */
  hold(request: ServerRequest): boolean;
  /** The app-server stopped waiting on a request. True when the module held it. */
  resolved(id: number | string): boolean;
  /** A thread item started. A file change's proposed changes come only on its item. */
  itemStarted(item: ThreadItem): void;
  itemCompleted(item: ThreadItem): void;
  /** The app-server exited: every request it sent is gone. */
  closed(): void;
}

interface Held {
  readonly request: ServerRequest;
  /** The request still waits for an answer. */
  pending: boolean;
  hold?: PromptHold;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function body(lines: (string | undefined)[]): PromptContent["body"] {
  const text = lines.filter((l): l is string => l !== undefined).join("\n\n");
  return text ? { format: "text", text } : undefined;
}

/** The decisions a request offers. A server that lists `availableDecisions` gets only those. */
function decisions(params: Record<string, unknown>): PromptOption[] {
  const listed = Array.isArray(params.availableDecisions) ? new Set(params.availableDecisions.filter((d) => typeof d === "string")) : undefined;
  return DECISIONS.filter((o) => listed === undefined || listed.has(o.decision)).map(({ decision: _, ...option }) => option);
}

/** An approval prompt whose subject is the tool call it gates. When the content would pass the
 *  desk's limit, the input is left out and only the decisions that refuse are offered: an input
 *  nobody can read may be refused remotely, never approved. Codex's own TUI can still approve it. */
function approval(title: string, tool: string, input: Record<string, unknown>, params: Record<string, unknown>, notes: (string | undefined)[]): PromptContent {
  const cwd = asString(params.cwd);
  const make = (shown: boolean): PromptContent => ({
    kind: "permission",
    title,
    ...(body(notes) ? { body: body(notes) } : {}),
    subject: { type: "tool", name: tool, input: shown ? { kind: "shown", value: input } : { kind: "omitted", bytes: Buffer.byteLength(canonicalJson(input)) }, ...(cwd ? { cwd } : {}) },
    options: shown ? decisions(params) : decisions(params).filter((o) => o.effect !== "proceed"),
    source: { harness: "codex", toolCallId: String(params.itemId) },
  });
  const full = make(true);
  return Buffer.byteLength(canonicalJson(full)) > AGENT_PROMPT_CONTENT_MAX_BYTES ? make(false) : full;
}

interface Question {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  options: { label: string; description: string }[];
}

function questions(params: Record<string, unknown>): Question[] | undefined {
  if (!Array.isArray(params.questions) || params.questions.length === 0) return undefined;
  const out: Question[] = [];
  for (const q of params.questions as Record<string, unknown>[]) {
    const id = asString(q?.id);
    // SPEC 13.22: a form never asks for a secret.
    if (id === undefined || q.isSecret === true) return undefined;
    const options = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]).flatMap((o) => (asString(o?.label) ? [{ label: o.label as string, description: String(o.description ?? "") }] : [])) : [];
    out.push({ id, header: asString(q.header) ?? id, question: asString(q.question) ?? "", isOther: q.isOther === true, options });
  }
  return out;
}

/** A question with choices and no free answer is a single choice; any other is a string. */
function property(q: Question): Record<string, unknown> {
  if (q.options.length > 0 && !q.isOther)
    return { type: "string", title: q.header, description: q.question, oneOf: q.options.map((o) => ({ const: o.label, title: o.label, ...(o.description ? { description: o.description } : {}) })) };
  const choices = q.options.length > 0 ? ` Choices: ${q.options.map((o) => o.label).join(", ")}, or your own answer.` : "";
  return { type: "string", title: q.header, description: `${q.question}${choices}` };
}

function questionContent(qs: Question[], params: Record<string, unknown>): PromptContent {
  return {
    kind: "question",
    title: qs.length === 1 ? qs[0]!.header : `Codex asks ${qs.length} questions`,
    ...(body(qs.map((q) => q.question)) ? { body: body(qs.map((q) => q.question)) } : {}),
    options: [SUBMIT, SKIP],
    form: { schema: { type: "object", properties: Object.fromEntries(qs.map((q) => [q.id, property(q)])), required: qs.map((q) => q.id) } },
    source: { harness: "codex", toolCallId: String(params.itemId) },
  };
}

/** The prompt content for a request, or undefined for one the module does not take. */
function contentFor(request: ServerRequest, changes: ReadonlyMap<string, unknown[]>): PromptContent | undefined {
  const { method, params } = request;
  if (typeof params.itemId !== "string") return undefined;
  if (method === COMMAND) {
    const command = asString(params.command);
    const stdin = params.kind === "writeStdin";
    return approval(stdin ? "Send input to the running command?" : "Run this command?", stdin ? "write_stdin" : "exec_command", command ? { cmd: command } : {}, params, [asString(params.reason)]);
  }
  if (method === FILE_CHANGE) {
    const root = asString(params.grantRoot);
    return approval("Apply these file changes?", "apply_patch", { changes: changes.get(params.itemId) ?? [] }, params,
      [asString(params.reason), root ? `Codex also asks to write under ${root} for the rest of the session.` : undefined]);
  }
  if (method === QUESTIONS) {
    const qs = questions(params);
    return qs ? questionContent(qs, params) : undefined;
  }
  return undefined;
}

/** The JSON-RPC result that hands `verdict` to Codex. */
function result(method: string, verdict: PromptVerdict): unknown {
  if (method !== QUESTIONS) return { decision: DECISIONS.find((o) => o.id === verdict.option)!.decision };
  if (verdict.option !== SUBMIT.id) return { answers: {} };
  const answers = Object.entries(verdict.values ?? {}).map(([id, v]) => [id, { answers: (Array.isArray(v) ? v : [v]).map(String) }]);
  return { answers: Object.fromEntries(answers) };
}

/** The answer a request gets when nobody answered it: Codex goes on without the action. */
const declined = (method: string): unknown => (method === QUESTIONS ? { answers: {} } : { decision: "decline" });

/**
 * The prompt module over `desk`, which reads the agent's desk when a request arrives: undefined while
 * it is not served.
 */
export function createCodexPrompts(opts: {
  desk(): PromptDesk | undefined;
  respond(request: ServerRequest, result: unknown): boolean;
  warn(msg: string): void;
}): CodexPrompts {
  const held = new Map<number | string, Held>();
  const changes = new Map<string, unknown[]>();
  const settle = (h: Held): void => {
    h.pending = false;
    h.hold?.settle({ kind: "withdrawn" });
  };
  return {
    hold(request) {
      const desk = opts.desk();
      const content = desk ? contentFor(request, changes) : undefined;
      if (!desk || !content) return false;
      const h: Held = { request, pending: true };
      try {
        h.hold = desk.open({ content, openMs: OPEN_MS, settleMs: SETTLE_MS }, {
          deliver: (verdict): Promise<Delivery> => {
            if (!h.pending) return Promise.resolve({ kind: "gone" });
            return Promise.resolve(opts.respond(request, result(request.method, verdict)) ? { kind: "delivered" } : { kind: "gone" });
          },
          end: ({ attempted }) => {
            held.delete(request.id);
            if (!attempted && h.pending) opts.respond(request, declined(request.method));
          },
        });
      } catch (e) {
        opts.warn(`declined Codex's ${request.method} request: the prompt desk refused it: ${(e as Error).message}`);
        return false;
      }
      held.set(request.id, h);
      return true;
    },
    resolved(id) {
      const h = held.get(id);
      if (!h) return false;
      settle(h);
      return true;
    },
    itemStarted(item) {
      // Codex lists them as `{ path, kind, diff }`.
      if (item.type === "fileChange" && typeof item.id === "string" && Array.isArray(item.changes)) changes.set(item.id, item.changes);
    },
    itemCompleted(item) {
      if (typeof item.id === "string") changes.delete(item.id);
    },
    closed() {
      changes.clear();
      for (const h of [...held.values()]) settle(h);
    },
  };
}

/** Feeds `prompts` the driver's events. `resumed` runs when the app-server stopped waiting on a
 *  request the module held. */
export function followDriver(driver: AppServerDriver, prompts: CodexPrompts, resumed: () => void): void {
  driver.on("resolved", (id: number | string) => {
    if (prompts.resolved(id)) resumed();
  });
  driver.on("itemStarted", (item: ThreadItem) => prompts.itemStarted(item));
  driver.on("itemCompleted", (item: ThreadItem) => prompts.itemCompleted(item));
  driver.on("closed", () => prompts.closed());
}

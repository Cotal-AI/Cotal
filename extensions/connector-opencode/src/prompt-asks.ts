/**
 * Each OpenCode line's asks, read from its events and replied to over its HTTP API (prompts.ts holds
 * the desk side). The shapes are the ones the servers emit: 1.x as `@opencode-ai/sdk`'s v2 types
 * name them, 2.x as measured on 2.0.24.
 *
 * - 1.x: `permission.asked` is replied to on `POST /permission/:id/reply` with `once`, `always` or
 *   `reject`, and "always" allows its patterns for the rest of the OpenCode session. `question.asked`
 *   is replied to on `POST /question/:id/reply` with one list of chosen labels per question, or
 *   dismissed on `POST /question/:id/reject`.
 * - 2.x: `permission.asked` is replied to on `POST /api/session/:sid/permission/:id/reply`, and
 *   "always" saves an allow rule for the project. A question is a form (`form.created`), replied to
 *   on `POST /api/session/:sid/form/:id/reply` with an answer per field key, or cancelled with
 *   `DELETE /api/session/:sid/form/:id`.
 *
 * A reject's note goes to OpenCode as its message, which OpenCode hands the model. A permission ask
 * names the tool call it gates, and the plugin's `execute.before` hook, which OpenCode runs before the
 * tool checks its permission, has handed that call over by then.
 */
import type { PromptDesk, PromptVerdict } from "@cotal-ai/connector-core";
import { createOpenCodePrompts, formContent, permissionContent, type FormField, type OpenCodeAsk, type OpenCodePrompts, type PermissionAsk } from "./prompts.js";

/** Sends one request to OpenCode: true once OpenCode applied it, false when OpenCode answered that it
 *  does not hold the ask. */
export type Send = (path: string, init: RequestInit) => Promise<boolean>;

const enc = encodeURIComponent;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const message = (v: PromptVerdict) => (v.note ? { message: v.note } : {});

interface Permission1 { id: string; sessionID: string; permission: string; patterns: string[]; always: string[]; tool?: { callID?: string } }

function permission1Ask(p: Permission1, send: Send, tool: PermissionAsk["tool"], scope?: string): OpenCodeAsk {
  return {
    id: p.id,
    content: permissionContent({
      action: p.permission,
      patterns: p.patterns,
      ...(p.always.length ? { always: `Allows ${p.permission} ${p.always.join(", ")} for the rest of this OpenCode session` } : {}),
      toolCallId: p.tool?.callID,
      tool,
      scope,
    }),
    reply: (v) => send(`/permission/${enc(p.id)}/reply`, post({ reply: v.option, ...message(v) })),
  };
}

interface Question1 {
  id: string;
  sessionID: string;
  questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiple?: boolean }>;
  tool?: { callID?: string };
}

/** A 1.x question request as one form, a field per question, or why the form profile cannot carry it. */
function question1Ask(q: Question1, send: Send, scope?: string): OpenCodeAsk | string {
  const fields: FormField[] = q.questions.map((x, i) => ({
    key: `q${i}`,
    type: x.multiple ? "multiselect" : "string",
    title: x.header,
    description: x.question,
    options: x.options.map((o) => ({ value: o.label, label: o.label, ...(o.description ? { description: o.description } : {}) })),
  }));
  const content = formContent({ kind: "question", title: q.questions.length === 1 ? q.questions[0]!.header : "Questions", fields, toolCallId: q.tool?.callID, scope });
  if (typeof content === "string") return content;
  const answers = (v: PromptVerdict) => fields.map((f) => {
    const value = v.values?.[f.key];
    return value === undefined ? [] : Array.isArray(value) ? value : [String(value)];
  });
  return {
    id: q.id,
    content,
    reply: (v) => (v.option === "submit" ? send(`/question/${enc(q.id)}/reply`, post({ answers: answers(v) })) : send(`/question/${enc(q.id)}/reject`, post({}))),
  };
}

interface Permission2 { id: string; sessionID: string; action: string; resources: string[]; save?: string[]; source?: { id?: string } }

function permission2Ask(p: Permission2, send: Send, tool: PermissionAsk["tool"], scope?: string): OpenCodeAsk {
  const save = p.save ?? [];
  return {
    id: p.id,
    content: permissionContent({
      action: p.action,
      patterns: p.resources,
      ...(save.length ? { always: `Saves an allow rule for this project: ${p.action} ${save.join(", ")}` } : {}),
      toolCallId: p.source?.id,
      tool,
      scope,
    }),
    reply: (v) => send(`/api/session/${enc(p.sessionID)}/permission/${enc(p.id)}/reply`, post({ decision: v.option, ...message(v) })),
  };
}

interface Form2 { id: string; sessionID: string; title: string; metadata?: { kind?: unknown; tool?: { id?: unknown } }; fields: FormField[] }

/** A 2.x form as a prompt, or why the form profile cannot carry it. The question tool marks its form
 *  `metadata.kind: "question"` and names its call in `metadata.tool`. */
function form2Ask(form: Form2, send: Send, scope?: string): OpenCodeAsk | string {
  const tool = form.metadata?.tool?.id;
  const content = formContent({
    kind: form.metadata?.kind === "question" ? "question" : "form",
    title: form.title,
    fields: form.fields,
    toolCallId: typeof tool === "string" ? tool : undefined,
    scope,
  });
  if (typeof content === "string") return content;
  const path = `/api/session/${enc(form.sessionID)}/form/${enc(form.id)}`;
  return {
    id: form.id,
    content,
    reply: (v) => (v.option === "submit" ? send(`${path}/reply`, post({ answer: v.values ?? {} })) : send(path, { method: "DELETE" })),
  };
}

/** The asks one plugin serves: its own session's and those of the subagent sessions under it. */
export interface OpenCodeAsks {
  /** Every event the plugin sees, by its type and payload. */
  event(type: string, data: Record<string, unknown>): void;
  /** A tool call started, from the plugin's `execute.before` hook. */
  toolStarted(callID: string, call: ToolCallSeen): void;
  /** The session's turn ended, so OpenCode waits on no ask of it any more. */
  turnEnded(): void;
}

/** A started tool call. Its input is read when an ask names the call, so an input that a later
 *  `execute.before` hook repaired is the one shown. */
export interface ToolCallSeen {
  name: string;
  input(): unknown;
}

/** The turn's started tool calls, by call id, for the permission asks that name them. */
function toolCalls(warn: (msg: string) => void) {
  const calls = new Map<string, ToolCallSeen>();
  return {
    started: (id: string, call: ToolCallSeen) => void calls.set(id, call),
    gated(id: string | undefined): PermissionAsk["tool"] {
      if (id === undefined) return undefined;
      const call = calls.get(id);
      const input = call?.input();
      if (input !== undefined) return { name: call!.name, input };
      warn(`OpenCode asked permission for tool call ${id}, whose input this plugin did not see; the prompt shows what the call would touch`);
      return undefined;
    },
    clear: () => calls.clear(),
  };
}

interface AsksOptions {
  desk(): PromptDesk | undefined;
  warn(msg: string): void;
  send: Send;
  /** The session the plugin drives now. */
  session(): string | undefined;
}

/** Whose asks are served: the driven session's, with no scope, and its subagents', scoped to theirs. */
function scopes(session: () => string | undefined) {
  const children = new Set<string>();
  const of = (id: unknown): { scope?: string } | undefined =>
    typeof id !== "string" ? undefined : id === session() ? {} : children.has(id) ? { scope: id } : undefined;
  return { of, child: (id: unknown, parent: unknown) => { if (typeof id === "string" && of(parent)) children.add(id); } };
}

/** Open an ask, or leave it to OpenCode's own dialog when the form profile cannot carry it. */
function open(prompts: OpenCodePrompts, warn: (msg: string) => void, id: string, ask: OpenCodeAsk | string): void {
  if (typeof ask === "string") warn(`OpenCode's own dialog answers ask ${id}: ${ask}`);
  else prompts.asked(ask);
}

export function opencode1Asks(opts: AsksOptions): OpenCodeAsks {
  const prompts = createOpenCodePrompts(opts);
  const scope = scopes(opts.session);
  const calls = toolCalls(opts.warn);
  return {
    event(type, p) {
      const info = p.info as { id?: unknown; parentID?: unknown } | undefined;
      if (type === "session.created") scope.child(info?.id, info?.parentID);
      else if (type === "permission.asked") {
        const who = scope.of(p.sessionID);
        const ask = p as unknown as Permission1;
        if (who) prompts.asked(permission1Ask(ask, opts.send, calls.gated(ask.tool?.callID), who.scope));
      } else if (type === "question.asked") {
        const who = scope.of(p.sessionID);
        if (who) open(prompts, opts.warn, String(p.id), question1Ask(p as unknown as Question1, opts.send, who.scope));
      } else if (type === "permission.replied") prompts.replied(String(p.requestID), p.reply === "reject" ? "refuse" : "proceed");
      else if (type === "question.replied") prompts.replied(String(p.requestID), "proceed");
      else if (type === "question.rejected") prompts.replied(String(p.requestID), "cancel");
    },
    toolStarted: calls.started,
    turnEnded: () => {
      prompts.turnEnded();
      calls.clear();
    },
  };
}

export function opencode2Asks(opts: AsksOptions): OpenCodeAsks {
  const prompts = createOpenCodePrompts(opts);
  const scope = scopes(opts.session);
  const calls = toolCalls(opts.warn);
  return {
    event(type, d) {
      const form = d.form as Form2 | undefined;
      if (type === "session.created") scope.child(d.sessionID, d.parentID);
      else if (type === "permission.asked") {
        const who = scope.of(d.sessionID);
        const ask = d as unknown as Permission2;
        if (who) prompts.asked(permission2Ask(ask, opts.send, calls.gated(ask.source?.id), who.scope));
      } else if (type === "form.created" && form) {
        const who = scope.of(form.sessionID);
        if (who) open(prompts, opts.warn, form.id, form2Ask(form, opts.send, who.scope));
      } else if (type === "permission.replied") prompts.replied(String(d.requestID), d.reply === "reject" ? "refuse" : "proceed");
      else if (type === "form.replied") prompts.replied(String(d.id), "proceed");
      else if (type === "form.cancelled") prompts.replied(String(d.id), "cancel");
    },
    toolStarted: calls.started,
    turnEnded: () => {
      prompts.turnEnded();
      calls.clear();
    },
  };
}

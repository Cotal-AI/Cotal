/**
 * OpenCode's permission asks and questions on the agent's prompt desk (SPEC 13.22), for both
 * OpenCode lines.
 *
 * OpenCode raises an ask as an event, waits for a reply on its HTTP API, and announces every reply
 * as an event, whoever gave it. So an ask opens a prompt, an accepted answer is a reply over that
 * API, and the reply event of an ask nobody answered here closes its prompt as answered at the
 * terminal. OpenCode's own dialog stays open meanwhile, the first reply wins, and the API refuses a
 * reply to an ask it does not hold.
 *
 * The adapters build each ask from their line's event shapes; this module holds the desk side and
 * the content both lines share.
 */
import { AGENT_PROMPT_CONTENT_MAX_BYTES, canonicalJson, type PromptContent, type PromptEffect, type PromptOption, type PromptSubject } from "@cotal-ai/core";
import type { PromptDesk, PromptHold, PromptVerdict } from "@cotal-ai/connector-core";

/** How long a prompt is offered: OpenCode waits for its reply without a limit. */
const OPEN_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an answer whose reply did not come back waits before it closes with nothing seen. */
const SETTLE_MS = 15 * 60 * 1000;
const TITLE_MAX = 200;

/** One ask OpenCode waits on. */
export interface OpenCodeAsk {
  /** OpenCode's request id, which its reply event names. */
  id: string;
  content: PromptContent;
  /** Hand the accepted answer to OpenCode: true once OpenCode applied it, false when it does not
   *  hold the ask. Any other failure throws. */
  reply(verdict: PromptVerdict): Promise<boolean>;
}

export interface OpenCodePrompts {
  /** OpenCode raised an ask. One the desk refuses stays with OpenCode's own dialog. */
  asked(ask: OpenCodeAsk): void;
  /** OpenCode announced the reply to an ask, with what the reply did. */
  replied(id: string, effect: PromptEffect): void;
  /** The turn ended, so OpenCode waits on no ask of it any more. */
  turnEnded(): void;
}

export function createOpenCodePrompts(opts: { desk(): PromptDesk | undefined; warn(msg: string): void }): OpenCodePrompts {
  const live = new Map<string, { hold: PromptHold; answered: boolean }>();
  return {
    asked(ask) {
      const desk = opts.desk();
      if (!desk || live.has(ask.id)) return;
      const entry = { answered: false } as { hold: PromptHold; answered: boolean };
      try {
        entry.hold = desk.open({ content: ask.content, openMs: OPEN_MS, settleMs: SETTLE_MS }, {
          deliver: async (verdict) => {
            entry.answered = true;
            return (await ask.reply(verdict)) ? { kind: "confirmed" } : { kind: "gone" };
          },
          end: () => {
            live.delete(ask.id);
          },
        });
      } catch (e) {
        opts.warn(`OpenCode's own dialog answers this ${ask.content.kind}: ${(e as Error).message}`);
        return;
      }
      live.set(ask.id, entry);
    },
    replied(id, effect) {
      const entry = live.get(id);
      // The reply to an answer given here is reported by `deliver`, from OpenCode's own answer.
      if (entry && !entry.answered) entry.hold.settle({ kind: "local", seen: { tie: "prompt", effect } });
    },
    turnEnded() {
      for (const entry of live.values()) if (!entry.answered) entry.hold.settle({ kind: "withdrawn" });
    },
  };
}

const title = (text: string): string => {
  const line = text.replace(/[\r\n]+/g, " ").trim() || "OpenCode asks";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

/** What a permission ask carries, in either line's words. */
export interface PermissionAsk {
  /** The permission asked for, such as `bash`, `shell`, `edit` or `read`. */
  action: string;
  /** What the call would touch: commands, paths or URLs. */
  patterns: string[];
  /** What "always" allows from then on, beside this call. */
  always?: string;
  toolCallId?: string;
  /** The tool call the ask gates, as the plugin saw it start. */
  tool?: { name: string; input: unknown };
  /** The child session that asked, when it is not the agent's own. */
  scope?: string;
}

const ONCE: PromptOption = { id: "once", label: "Allow once", effect: "proceed" };
const REJECT: PromptOption = { id: "reject", label: "Reject", effect: "refuse", note: "optional" };

/** The prompt for a permission ask. Its subject is the gated tool call; with no call seen, it is what
 *  the call would touch. A content over the desk's limit leaves the input out, or says how large the
 *  patterns are, and then offers only Reject: the desk lets nobody approve an input it cannot show. */
export function permissionContent(p: PermissionAsk): PromptContent {
  const options = [ONCE, ...(p.always ? [{ id: "always", label: "Allow always", effect: "proceed" as const, persists: p.always }] : []), REJECT];
  const content = (subject: PromptSubject, opts: PromptOption[], body?: string): PromptContent => ({
    kind: "permission",
    title: title(`Allow ${p.action}?`),
    ...(body ? { body: { format: "text" as const, text: body } } : {}),
    subject,
    options: opts,
    source: { harness: "opencode", ...(p.scope ? { scope: p.scope } : {}), ...(p.toolCallId ? { toolCallId: p.toolCallId } : {}) },
  });
  const fits = (c: PromptContent) => Buffer.byteLength(canonicalJson(c)) <= AGENT_PROMPT_CONTENT_MAX_BYTES;
  const body = p.patterns.join("\n");
  const tool = p.tool;
  const shown = content(tool ? { type: "tool", name: tool.name, input: { kind: "shown", value: tool.input } } : { type: "ai.cotal.opencode.permission", data: { action: p.action, patterns: p.patterns } }, options, body);
  if (fits(shown)) return shown;
  const omitted = tool && content({ type: "tool", name: tool.name, input: { kind: "omitted", bytes: Buffer.byteLength(canonicalJson(tool.input)) } }, [REJECT], body);
  if (omitted && fits(omitted)) return omitted;
  return content({ type: "ai.cotal.opencode.permission", data: { action: p.action, omittedBytes: Buffer.byteLength(canonicalJson(p.patterns)) } }, [REJECT]);
}

/** One field of an OpenCode form, in 2.x's `Form.Field` shape. 1.x questions are read into it. */
export interface FormField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: unknown[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
  default?: unknown;
  options?: Array<{ value: string; label: string; description?: string }>;
  custom?: boolean;
  minimum?: unknown;
  maximum?: unknown;
  minItems?: number;
  maxItems?: number;
}

const SUBMIT: PromptOption = { id: "submit", label: "Submit", effect: "proceed", form: "required" };
const DISMISS: PromptOption = { id: "dismiss", label: "Dismiss", effect: "cancel" };

/** The prompt for a form or a question, or the reason the form profile cannot carry it. A field's
 *  listed choices are offered as a choice; typing an answer of one's own stays at the terminal. */
export function formContent(f: { kind: "question" | "form"; title: string; fields: FormField[]; toolCallId?: string; scope?: string }): PromptContent | string {
  const properties: Record<string, unknown> = {};
  for (const field of f.fields) {
    const property = fieldSchema(field);
    if (typeof property === "string") return `field "${field.key}" ${property}`;
    properties[field.key] = property;
  }
  const required = f.fields.filter((field) => field.required).map((field) => field.key);
  return {
    kind: f.kind,
    title: title(f.title),
    options: [SUBMIT, DISMISS],
    form: { schema: { type: "object", properties, ...(required.length ? { required } : {}) } },
    source: { harness: "opencode", ...(f.scope ? { scope: f.scope } : {}), ...(f.toolCallId ? { toolCallId: f.toolCallId } : {}) },
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One field as a form-profile property, or why it cannot be one. */
function fieldSchema(f: FormField): Record<string, unknown> | string {
  if (f.hidden || f.when?.length) return "shows only under conditions the form profile has no words for";
  if (f.pattern !== undefined) return "has a pattern the form profile has no words for";
  const notes = { ...(f.title ? { title: f.title } : {}), ...(f.description ? { description: f.description } : {}) };
  const choices = f.options?.map((o) => ({ const: o.value, title: o.label, ...(o.description ? { description: o.description } : {}) }));
  const pick = <K extends keyof FormField>(...keys: K[]) => Object.fromEntries(keys.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));
  switch (f.type) {
    case "string":
      if (choices?.length) return { type: "string", ...notes, oneOf: choices, ...pick("default") };
      return { type: "string", ...notes, ...pick("minLength", "maxLength", "format", "default") };
    case "number":
    case "integer":
      return { type: f.type, ...notes, ...(finite(f.minimum) ? { minimum: f.minimum } : {}), ...(finite(f.maximum) ? { maximum: f.maximum } : {}), ...(finite(f.default) ? { default: f.default } : {}) };
    case "boolean":
      return { type: "boolean", ...notes, ...pick("default") };
    case "multiselect":
      if (!choices?.length) return "is a multiple choice with no choices";
      return { type: "array", ...notes, items: { anyOf: choices }, ...pick("minItems", "maxItems", "default") };
    default:
      return `is a ${f.type} field, which the form profile has no words for`;
  }
}

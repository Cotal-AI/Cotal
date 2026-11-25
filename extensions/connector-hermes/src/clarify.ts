/**
 * Hermes's clarify questions on the agent's prompt desk (SPEC 13.22): a question the model asks in
 * the operator chat, where the owner's own turns run. The gateway half is plugin/cotal/clarify.py.
 *
 * Hermes's clarify tool waits for an answer or for its clarify timeout. Each wait is one `question`
 * prompt, open a little longer than Hermes waits. Its form has one field: the question's choices,
 * with an answer of one's own beside them, or free text when it offers none. A submitted form sends
 * the answer, which Hermes hands the model as the user's reply, and a dismissed one sends a notice
 * that the user did not answer. The plugin reports whether Hermes was still waiting (`clarify_end`),
 * which settles the prompt. A question no prompt can hold is answered at once with the cause, so the
 * model can ask it in its reply instead.
 */
import type { PromptContent, PromptOption } from "@cotal-ai/core";
import { PROMPT_OPEN_MS, type Delivery, type PromptDesk, type PromptHold, type PromptVerdict } from "@cotal-ai/connector-core";

const SUBMIT: PromptOption = { id: "submit", label: "Submit", effect: "proceed", form: "required" };
const DISMISS: PromptOption = { id: "dismiss", label: "Dismiss", effect: "cancel" };
/** What Hermes hands the model for a dismissed question, in the bracketed form of its own notices. */
export const DISMISSED = "[the user dismissed the question without answering]";
/** The answer of one's own beside the choices: the companion name ACP clients such as T3 Code fold
 *  into the choice as its "Other" entry. */
const OTHER = "answer__other";
const TITLE_MAX = 200;
/** How much longer a prompt stays open than Hermes waits, so Hermes's end of the wait settles it. */
const OPEN_MARGIN_MS = 5_000;
/** How long an answered prompt waits for the plugin to report how Hermes took it. */
const SETTLE_MS = 60_000;

/** One `clarify` frame from the plugin. */
interface ClarifyAsk {
  id: string;
  question: string;
  choices: string[];
  /** Hermes takes any number of the choices, as a JSON array of their labels (0.21). */
  multiple: boolean;
  timeoutMs: number;
}

interface Entry {
  hold?: PromptHold;
  /** Settles the hand-over of the answer sent, once the plugin reports how Hermes took it. */
  delivered?: (delivery: Delivery) => void;
}

export interface HermesClarify {
  /** A `clarify` frame: open its prompt. */
  request(frame: Record<string, unknown>): void;
  /** A `clarify_end` frame: settle that question's prompt. */
  ended(frame: Record<string, unknown>): void;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parse(frame: Record<string, unknown>): ClarifyAsk | string {
  const choices = Array.isArray(frame.choices) ? frame.choices : undefined;
  if (!str(frame.id) || !str(frame.question)) return "it names no question";
  if (!choices || !choices.every((c) => typeof c === "string" && c !== "")) return `its choices ${JSON.stringify(frame.choices)} are not labels`;
  if (typeof frame.timeoutMs !== "number" || !(frame.timeoutMs > 0)) return "it carries no clarify timeout";
  return { id: str(frame.id), question: str(frame.question), choices: choices as string[], multiple: frame.multiple === true && choices.length > 0, timeoutMs: frame.timeoutMs };
}

function content(ask: ClarifyAsk): PromptContent {
  const line = ask.question.replace(/[\r\n]+/g, " ").trim();
  const notes = { title: "Answer", description: ask.question };
  const choices = ask.choices.map((c) => ({ const: c, title: c }));
  const properties: Record<string, unknown> = !choices.length
    ? { answer: { type: "string", ...notes } }
    : {
        answer: ask.multiple ? { type: "array", ...notes, items: { anyOf: choices } } : { type: "string", ...notes, oneOf: choices },
        [OTHER]: { type: "string", title: "Other", description: `An answer of your own to: ${ask.question}` },
      };
  return {
    kind: "question",
    title: line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line,
    options: [SUBMIT, DISMISS],
    form: { schema: { type: "object", properties, ...(choices.length ? {} : { required: ["answer"] }) } },
    source: { harness: "hermes" },
  };
}

/** The reply a verdict hands Hermes: the choice, the choices as a JSON array, or the answer of one's
 *  own, in that order; empty when the form gave none. */
function response(ask: ClarifyAsk, verdict: PromptVerdict): string {
  if (verdict.option !== SUBMIT.id) return DISMISSED;
  const chosen = verdict.values?.answer;
  const own = verdict.values?.[OTHER];
  if (Array.isArray(chosen) && chosen.length) return JSON.stringify(chosen);
  if (typeof chosen === "string" && chosen.trim()) return ask.multiple ? JSON.stringify([chosen]) : chosen.trim();
  return typeof own === "string" ? own.trim() : "";
}

export function createHermesClarify(opts: {
  desk(): PromptDesk | undefined;
  send(answer: { id: string; response: string }): boolean;
  warn(msg: string): void;
}): HermesClarify {
  const open = new Map<string, Entry>();

  /** Answer at once a question no prompt can hold, naming why. */
  const refuse = (id: string, cause: string): void => {
    opts.warn(`a clarify question was not put on the prompt desk: ${cause}`);
    opts.send({ id, response: `[Cotal could not put this question on the agent's prompt desk: ${cause}. Ask it in your reply instead.]` });
  };

  return {
    request(frame) {
      const ask = parse(frame);
      if (typeof ask === "string") return opts.warn(`Hermes clarify frame ignored: ${ask}`);
      const desk = opts.desk();
      if (!desk) return refuse(ask.id, "the agent endpoint does not serve its prompt desk");
      const entry: Entry = {};
      open.set(ask.id, entry);
      try {
        entry.hold = desk.open(
          { content: content(ask), openMs: Math.min(ask.timeoutMs + OPEN_MARGIN_MS, PROMPT_OPEN_MS.max), settleMs: SETTLE_MS },
          {
            check: (verdict) => (response(ask, verdict) ? undefined : "pick a choice or give an answer of your own"),
            deliver: (verdict) =>
              new Promise<Delivery>((resolve) => {
                entry.delivered = resolve;
                if (!opts.send({ id: ask.id, response: response(ask, verdict) })) resolve({ kind: "gone" });
              }),
            end: () => open.delete(ask.id),
          },
        );
      } catch (e) {
        open.delete(ask.id);
        refuse(ask.id, (e as Error).message);
      }
    },
    ended(frame) {
      const entry = open.get(str(frame.id));
      if (!entry) return;
      open.delete(str(frame.id));
      if (entry.delivered) entry.delivered(frame.resolved === true ? { kind: "confirmed" } : { kind: "gone" });
      else entry.hold?.settle({ kind: "withdrawn" });
    },
  };
}

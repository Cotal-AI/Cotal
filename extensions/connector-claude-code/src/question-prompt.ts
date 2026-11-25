/**
 * Claude's `AskUserQuestion` on the agent's prompt desk (SPEC 13.22): one `question` prompt with a
 * form, a field per question, while Claude's own dialog stays open in the terminal.
 *
 * A submitted form allows the call with its input plus `answers`, as Claude's hook contract asks of a
 * hook that answers the tool: each question's text maps to the label chosen, a multiple choice's
 * labels joined with ", ", or the answer of one's own typed beside a single choice. A question left
 * unanswered is left out. A dismissed form denies the call.
 */
import type { PromptContent, PromptOption } from "@cotal-ai/core";
import type { PromptVerdict } from "@cotal-ai/connector-core";

const SUBMIT: PromptOption = { id: "submit", label: "Submit", effect: "proceed", form: "required" };
const DISMISS: PromptOption = { id: "dismiss", label: "Dismiss", effect: "cancel" };
/** The message Claude gets for a dismissed question, and later gives the refused call as its result. */
export const DISMISSED = "The user dismissed the question without answering.";
/** The key of an answer of one's own beside field `key`: the companion name ACP clients such as T3
 *  Code fold into the choice as its "Other" entry. */
const OTHER = "__other";

interface Question {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** The tool's questions, or why the form cannot carry them. */
function questionsOf(input: unknown): Question[] | string {
  const questions = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return "it names no questions";
  for (const q of questions as Question[]) {
    if (typeof q?.question !== "string" || typeof q.header !== "string" || !Array.isArray(q.options)) return "a question is not text with a header and choices";
    if (q.options.length === 0 || q.options.some((o) => typeof o?.label !== "string")) return `"${q.header}" has no labelled choices`;
  }
  return questions as Question[];
}

/** The question prompt for an `AskUserQuestion` input, or why the form cannot carry it. */
export function questionContent(input: unknown, scope: string | undefined): PromptContent | string {
  const questions = questionsOf(input);
  if (typeof questions === "string") return questions;
  const properties: Record<string, unknown> = {};
  questions.forEach((q, i) => {
    const choices = q.options.map((o) => ({ const: o.label, title: o.label, ...(o.description ? { description: o.description } : {}) }));
    const notes = { title: q.header, description: q.question };
    if (q.multiSelect) {
      properties[`q${i}`] = { type: "array", ...notes, items: { anyOf: choices } };
      return;
    }
    properties[`q${i}`] = { type: "string", ...notes, oneOf: choices };
    properties[`q${i}${OTHER}`] = { type: "string", title: "Other", description: `An answer of your own to: ${q.question}` };
  });
  return {
    kind: "question",
    title: questions.length === 1 ? questions[0]!.header : `Claude asks ${questions.length} questions`,
    options: [SUBMIT, DISMISS],
    form: { schema: { type: "object", properties } },
    source: { harness: "claude-code", ...(scope !== undefined ? { scope } : {}) },
  };
}

/** The input a submitted form allows the call with: the tool's input plus the answers given. */
export function answeredInput(input: unknown, verdict: PromptVerdict): Record<string, unknown> {
  const questions = questionsOf(input) as Question[];
  const values = verdict.values ?? {};
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const chosen = values[`q${i}`];
    const own = values[`q${i}${OTHER}`];
    if (Array.isArray(chosen) && chosen.length > 0) answers[q.question] = chosen.join(", ");
    else if (typeof chosen === "string" && chosen !== "") answers[q.question] = chosen;
    else if (typeof own === "string" && own.trim() !== "") answers[q.question] = own.trim();
  });
  return { ...(input as Record<string, unknown>), answers };
}

/** Whether `verdict` submitted the question's form. */
export const submitted = (verdict: PromptVerdict): boolean => verdict.option === SUBMIT.id;

/**
 * Hermes's command approvals behind the agent's prompt desk (SPEC 13.22), for a seat launched with
 * `askPermissions`. The gateway half is plugin/cotal/approvals.py.
 *
 * Hermes stops a command its approval rules flag and waits for an answer or for its approval
 * timeout. Each wait is one prompt offering the choices Hermes offers, open a little longer than
 * Hermes waits so that Hermes's own end of the wait settles it. Hermes resolves the oldest waiting
 * approval of a session, so a session's answers go to the gateway in the order its prompts opened,
 * and an answer to a later prompt waits for the earlier ones. When a wait ends (`approval_end`), the
 * session's oldest prompt settles with what Hermes reports: the answer it was sent, another choice
 * made at the gateway (a stop denies), or a timeout. A prompt that closes unanswered sends nothing,
 * and Hermes's timeout refuses the command.
 */
import { AGENT_PROMPT_CONTENT_MAX_BYTES, canonicalJson, type PromptContent, type PromptInput, type PromptOption } from "@cotal-ai/core";
import { PROMPT_OPEN_MS, type Delivery, type Evidence, type PromptDesk, type PromptHold, type PromptVerdict } from "@cotal-ai/connector-core";

type Choice = "once" | "session" | "always" | "deny";

const OPTIONS: Record<Choice, PromptOption> = {
  once: { id: "once", label: "Allow once", effect: "proceed" },
  session: { id: "session", label: "Allow for this session", effect: "proceed", persists: "Hermes runs commands that match this pattern without asking for the rest of the session." },
  always: { id: "always", label: "Allow always", effect: "proceed", persists: "Hermes adds this pattern to its permanent allowlist and no longer asks for it." },
  deny: { id: "deny", label: "Deny", effect: "refuse" },
};
const CHOICES = new Set<string>(Object.keys(OPTIONS));
/** How much longer a prompt stays open than Hermes waits, so Hermes's end of the wait settles it. */
const OPEN_MARGIN_MS = 5_000;
/** How long an answered prompt waits for Hermes to report that its wait ended. */
const SETTLE_MS = 60_000;

/** One `approval` frame from the plugin. */
interface ApprovalAsk {
  id: string;
  session: string;
  command: string;
  description: string;
  tool: string;
  toolCallId?: string;
  choices: Choice[];
  /** Hermes takes a deny reason, so Deny offers a note. */
  note: boolean;
  timeoutMs: number;
}

interface Entry {
  id: string;
  hold?: PromptHold;
  answer?: { choice: Choice; reason?: string };
  sent: boolean;
  delivered?: (delivery: Delivery) => void;
}

export interface HermesApprovals {
  /** An `approval` frame: open its prompt. */
  request(frame: Record<string, unknown>): void;
  /** An `approval_end` frame: settle the session's oldest prompt. */
  ended(frame: Record<string, unknown>): void;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parse(frame: Record<string, unknown>): ApprovalAsk | string {
  const choices = Array.isArray(frame.choices) ? frame.choices : [];
  if (!str(frame.id) || !str(frame.session)) return "it names no approval or session";
  if (!choices.includes("deny") || !choices.every((c) => CHOICES.has(c as string))) return `its choices ${JSON.stringify(frame.choices)} are not Hermes's`;
  if (typeof frame.timeoutMs !== "number" || !(frame.timeoutMs > 0)) return "it carries no approval timeout";
  return {
    id: str(frame.id), session: str(frame.session), command: str(frame.command), description: str(frame.description),
    tool: str(frame.tool) || "terminal", ...(str(frame.toolCallId) ? { toolCallId: str(frame.toolCallId) } : {}),
    choices: choices as Choice[], note: frame.note === true, timeoutMs: frame.timeoutMs,
  };
}

function content(ask: ApprovalAsk, input: PromptInput, options: PromptOption[]): PromptContent {
  return {
    kind: "permission",
    title: `Allow ${ask.tool}?`,
    ...(ask.description ? { body: { format: "text" as const, text: ask.description } } : {}),
    subject: { type: "tool", name: ask.tool, input },
    options,
    source: { harness: "hermes", ...(ask.toolCallId ? { toolCallId: ask.toolCallId } : {}) },
  };
}

/** The prompt for an approval. The command shows in full or not at all: a content over the size
 *  limit says how large the command is and offers only Deny. */
function askContent(ask: ApprovalAsk): PromptContent {
  const options = ask.choices.map((c) => (c === "deny" && ask.note ? { ...OPTIONS.deny, note: "optional" as const } : OPTIONS[c]));
  const full = content(ask, { kind: "shown", value: { command: ask.command } }, options);
  if (Buffer.byteLength(canonicalJson(full)) <= AGENT_PROMPT_CONTENT_MAX_BYTES) return full;
  return content(ask, { kind: "omitted", bytes: Buffer.byteLength(ask.command) }, [options.at(-1)!]);
}

/** What Hermes's end of a wait shows about its prompt: the answer it was sent applied, another
 *  choice was made at the gateway (as a stop denies), or Hermes stopped waiting with none. */
function evidence(entry: Entry, outcome: unknown): Evidence {
  if (typeof outcome !== "string" || !CHOICES.has(outcome)) return { kind: "withdrawn" };
  if (entry.sent && entry.answer?.choice === outcome) return { kind: "confirmed" };
  return { kind: "observed", seen: { tie: "prompt", effect: outcome === "deny" ? "refuse" : "proceed" } };
}

const answerOf = (verdict: PromptVerdict): Entry["answer"] =>
  ({ choice: verdict.option as Choice, ...(verdict.option === "deny" && verdict.note ? { reason: verdict.note } : {}) });

export function createHermesApprovals(opts: {
  desk(): PromptDesk | undefined;
  send(answer: { id: string; choice: Choice; reason?: string }): boolean;
  warn(msg: string): void;
}): HermesApprovals {
  const sessions = new Map<string, Entry[]>();

  /** Send the answers at the head of a session's queue, in order, up to its first unanswered one. */
  const pump = (session: string): void => {
    for (const entry of sessions.get(session) ?? []) {
      if (entry.sent) continue;
      if (!entry.answer) return;
      entry.sent = true;
      const handed = opts.send({ id: entry.id, ...entry.answer });
      entry.delivered?.(handed ? { kind: "delivered" } : { kind: "gone" });
    }
  };
  /** Deny at once an approval no prompt can hold, naming why. */
  const refuse = (session: string, entry: Entry, cause: string): void => {
    const reason = `Cotal could not ask the agent's owner to approve this command: ${cause}.`;
    opts.warn(reason);
    entry.answer = { choice: "deny", reason };
    pump(session);
  };

  return {
    request(frame) {
      const ask = parse(frame);
      if (typeof ask === "string") return opts.warn(`Hermes approval frame ignored: ${ask}`);
      const entry: Entry = { id: ask.id, sent: false };
      sessions.set(ask.session, [...(sessions.get(ask.session) ?? []), entry]);
      const desk = opts.desk();
      if (!desk) return refuse(ask.session, entry, "the agent endpoint does not serve its prompt desk");
      try {
        entry.hold = desk.open(
          { content: askContent(ask), openMs: Math.min(ask.timeoutMs + OPEN_MARGIN_MS, PROMPT_OPEN_MS.max), settleMs: SETTLE_MS },
          {
            deliver: (verdict) =>
              new Promise<Delivery>((resolve) => {
                entry.answer = answerOf(verdict);
                entry.delivered = resolve;
                pump(ask.session);
              }),
            end: () => {},
          },
        );
      } catch (e) {
        refuse(ask.session, entry, (e as Error).message);
      }
    },
    ended(frame) {
      const session = str(frame.session);
      const queue = sessions.get(session);
      const entry = queue?.shift();
      if (!entry) return;
      if (queue!.length === 0) sessions.delete(session);
      entry.hold?.settle(evidence(entry, frame.outcome));
      pump(session);
    },
  };
}

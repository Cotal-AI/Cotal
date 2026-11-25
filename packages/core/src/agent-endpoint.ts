/**
 * The `agent` endpoint, revision 6 (SPEC 13.22): the fixed command set an agent serves about itself
 * on the principal route (SPEC 13.21). `prompts`, `prompt` and `prompt-answer` serve the questions
 * an agent's harness stops to ask: a tool permission, a question, a plan, a form. `commands` lists
 * the harness commands and skills the agent runs, `command` queues one, `command-cancel` cancels a
 * queued one and `command-state` reads how far one got. `turn` queues the owner's own words as a
 * turn on the same queue. `interrupt` stops the turn the agent is running. `usage` reads what the
 * harness reports about its context window and cost. `set-model` switches the model or the variant
 * the harness runs from its next turn. `set-name` changes the agent's display name.
 *
 * The contract is a core constant, like the registry's: every agent serves the same cluster, a
 * caller embeds these artifacts and pins their digests, and nothing is published to the contract
 * store. Every schema is closed and frozen.
 */
import { contractDigest } from "./canonical.js";
import { buildClusterArtifacts, buildClusterDocument, type ClusterDocument } from "./endpoint-cluster.js";
import type { ContractClosureManifest } from "./contract-manifest.js";
import { serviceContractTable } from "./schema-profile.js";
import { MAX_NAME_LENGTH } from "./resolve.js";
import type { PrincipalAuthority } from "./endpoint-subjects.js";

export const AGENT_ENDPOINT = "agent";
export const AGENT_CLUSTER_URN = "ai.cotal.agent";
export const AGENT_CLUSTER_REVISION = 6;

export const AGENT_CMD_PROMPTS = "prompts";
export const AGENT_CMD_PROMPT = "prompt";
export const AGENT_CMD_PROMPT_ANSWER = "prompt-answer";
export const AGENT_CMD_COMMANDS = "commands";
export const AGENT_CMD_COMMAND = "command";
export const AGENT_CMD_COMMAND_CANCEL = "command-cancel";
export const AGENT_CMD_COMMAND_STATE = "command-state";
export const AGENT_CMD_INTERRUPT = "interrupt";
export const AGENT_CMD_SET_NAME = "set-name";
export const AGENT_CMD_TURN = "turn";
export const AGENT_CMD_USAGE = "usage";
export const AGENT_CMD_SET_MODEL = "set-model";

/** The canonical `content` of one prompt is at most this many bytes (SPEC 13.22). */
export const AGENT_PROMPT_CONTENT_MAX_BYTES = 262144;
/** A `prompts` reply lists at most this many prompts in `open` and this many in `closed`. */
export const AGENT_PROMPT_LIST_MAX = 32;
/** A prompt offers between 1 and this many options. */
export const AGENT_PROMPT_OPTIONS_MAX = 16;

/** A `commands` reply lists at most this many commands and skills. */
export const AGENT_COMMAND_LIST_MAX = 512;
/** A listed description is at most this many characters. */
export const AGENT_COMMAND_DESCRIPTION_MAX = 1024;
/** A listed input hint is at most this many characters. */
export const AGENT_COMMAND_INPUT_HINT_MAX = 256;
/** The `message` of a command state is at most this many characters. */
export const AGENT_COMMAND_MESSAGE_MAX = 2048;
/** A `turn`'s text is at most this many characters. */
export const AGENT_TURN_TEXT_MAX = 262144;
/** A `turn` carries at most this many images. */
export const AGENT_TURN_IMAGES_MAX = 16;
/** A `set-model` model id is at most this many characters. */
export const AGENT_MODEL_ID_MAX = 256;
/** A `set-model` variant is at most this many characters. */
export const AGENT_MODEL_VARIANT_MAX = 64;
/** The image types a `turn` carries. */
export const AGENT_TURN_IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"] as const);

/** `details[].kind` on a `conflict`, and on a `failed-precondition` for a closed prompt: `{ state }`. */
export const AGENT_PROMPT_STATE_DETAIL = "ai.cotal.agent.prompt-state";
/** `details[].kind` on a `failed-precondition` for a digest that differs: `{ digest }`. */
export const AGENT_PROMPT_DIGEST_DETAIL = "ai.cotal.agent.prompt-digest";
/** `details[].kind` on a `resource-exhausted` reply: `{ bytes, limit }`. */
export const AGENT_PROMPT_SIZE_DETAIL = "ai.cotal.agent.prompt-size";
/** `details[].kind` on a `command-cancel` `conflict`: `{ state }`. */
export const AGENT_COMMAND_STATE_DETAIL = "ai.cotal.agent.command-state";
/** `details[].kind` on a refused `set-name`: `{ reason }`, one of {@link AgentNameRefusal}. */
export const AGENT_NAME_REFUSED_DETAIL = "ai.cotal.agent.name-refused";

/** The `AgentCard.meta` key an agent shows while it labels itself from its first message: `pending`
 *  from launch until naming settles, then absent, whether it took a label or not (SPEC 13.22). */
export const AGENT_NAMING_META_KEY = "ai.cotal.naming";

/** The `AgentCard.meta` key that carries the label an agent took from its first message: one line
 *  of at most 40 code points, written only by the agent's own connector (SPEC 13.22). A reader shows
 *  it in place of `name`, which stays the address that mentions, DMs and name lookups resolve. */
export const AGENT_LABEL_META_KEY = "ai.cotal.label";

/** The `AgentCard.meta` key an agent's own connector writes when an owner's `set-model` switched its
 *  harness: `{ model, variant? }`, as `set-model` answered (SPEC 13.22). A launcher that starts the
 *  same lifecycle again launches it on that model in place of its launch model. */
export const AGENT_MODEL_SET_META_KEY = "ai.cotal.model-set";

/** Why `set-name` refused a name: `name-invalid` (`bad-request`) fails the shared name rule, and
 *  `name-taken` (`already-exists`) is the name of another live agent in the space. */
export type AgentNameRefusal = "name-invalid" | "name-taken";

// ---- the prompt (SPEC 13.22) ------------------------------------------------------------------

export type PromptEffect = "proceed" | "refuse" | "cancel";

/** Who answered, from the request subject only: the caller principal, its lifecycle UID and the
 *  authority word it called with. */
export interface PromptAnswerer {
  id: string;
  uid: string;
  authority: PrincipalAuthority;
}

export interface PromptAnswerRef {
  by: PromptAnswerer;
  option: string;
  effect: PromptEffect;
  at: string;
}

/** What the harness was seen to do, and how firmly that is tied to this prompt. */
export type PromptSeen =
  | { tie: "prompt"; effect: PromptEffect }
  | { tie: "subject"; effect: PromptEffect }
  | { tie: "none" };

export type PromptOutcome =
  | { kind: "answered"; answer: PromptAnswerRef }
  | { kind: "unconfirmed"; answer: PromptAnswerRef; seen: PromptSeen }
  | { kind: "undelivered"; answer: PromptAnswerRef }
  | { kind: "local"; seen: PromptSeen; late?: PromptAnswerRef }
  | { kind: "withdrawn"; seen: PromptSeen }
  | { kind: "expired" };

/** A prompt only moves forward: `open`, then `sent` (`unconfirmed`, then `delivered`), then
 *  `closed`, and a closed state is final. */
export type PromptState =
  | { kind: "open" }
  | { kind: "sent"; answer: PromptAnswerRef; delivery: "unconfirmed" | "delivered" }
  | { kind: "closed"; at: string; outcome: PromptOutcome };

export interface PromptSource {
  harness: string;
  scope?: string;
  toolCallId?: string;
}

export type PromptInput =
  | { kind: "shown"; value: unknown }
  | { kind: "omitted"; bytes: number };

export type PromptSubject =
  | { type: "tool"; name: string; input: PromptInput; cwd?: string; server?: string }
  | { type: "url"; url: string }
  | { type: string; data: unknown };

export interface PromptOption {
  id: string;
  label: string;
  effect: PromptEffect;
  description?: string;
  /** What choosing this option changes beyond this prompt. Absent: nothing. */
  persists?: string;
  note?: "optional" | "required";
  /** This option submits `values` for `content.form`. */
  form?: "required";
}

/** Set once when the prompt opens and never changed: the digest covers all of it. */
export interface PromptContent {
  /** A rendering hint: `permission`, `question`, `plan`, `form`, or a reverse-DNS name. */
  kind: string;
  title: string;
  body?: { format: "text" | "markdown"; text: string };
  subject?: PromptSubject;
  options: PromptOption[];
  /** A flat object of primitive properties, in the form profile of SPEC 13.22. */
  form?: { schema: Record<string, unknown> };
  source?: PromptSource;
}

/** The full prompt `prompt` returns while the prompt is `open` or `sent`. */
export interface AgentPrompt {
  id: string;
  digest: string;
  openedAt: string;
  expiresAt: string;
  state: PromptState;
  content: PromptContent;
}

/** One entry of a `prompts` list: the digest and no content. */
export interface PromptSummary {
  id: string;
  digest: string;
  openedAt: string;
  expiresAt: string;
  state: PromptState;
  kind: string;
  title: string;
  contentBytes: number;
  source?: PromptSource;
}

export interface PromptsOutput {
  runtime: { id: string; startedAt: number };
  seq: number;
  open: PromptSummary[];
  closed: PromptSummary[];
}

export interface PromptAnswerInput {
  id: string;
  digest: string;
  option: string;
  note?: string;
  values?: Record<string, string | number | boolean | string[]>;
}

// ---- the commands (SPEC 13.22) ----------------------------------------------------------------

/** A harness command (`/review`) or a harness skill. */
export type CommandTarget = "command" | "skill";

/** One command or skill an agent runs: `command` with this `target` and `name` runs it. `inputHint`
 *  says what its `args` take, when the harness says. */
export interface CommandEntry {
  name: string;
  target: CommandTarget;
  description?: string;
  inputHint?: string;
}

/** `supported: false`: the agent's connector runs no commands. `supported: true` with no entries: it
 *  runs commands and has none. */
export type CommandsOutput = { supported: false } | { supported: true; commands: CommandEntry[] };

export interface CommandInput {
  target: CommandTarget;
  name: string;
  /** What the command or skill is given. Absent: nothing. */
  args?: string;
}

/** `command` queued the command under this id: `[a-z2-7]{26}`, random, never reused. */
export interface CommandOutput {
  id: string;
}

/** What `command-cancel` and `command-state` take. */
export interface CommandIdInput {
  id: string;
}

/** A command only moves forward: `queued`, then `taken` or a final state, and `taken` only to a final
 *  state. `started` says the harness accepted the command, and its turn may still run. */
export type CommandState =
  | { kind: "queued" }
  | { kind: "taken" }
  | { kind: "started" }
  | { kind: "cancelled" }
  | { kind: "refused"; code: "not-found" | "failed-precondition" | "unavailable"; message: string }
  | { kind: "unknown"; code: "internal"; message: string };

export interface CommandStateOutput {
  state: CommandState;
}

/** What `interrupt` did: `interrupted` stopped the turn the agent was running, and `idle` found no
 *  turn running and changed nothing. */
export interface InterruptOutput {
  state: "interrupted" | "idle";
}

/** One image a `turn` carries: its type and its bytes in standard base64. */
export interface TurnImage {
  mimeType: (typeof AGENT_TURN_IMAGE_TYPES)[number];
  data: string;
}

/** What `turn` takes: the owner's own words, and the images they attached. `text` is empty only
 *  when there are images. */
export interface TurnInput {
  text: string;
  images?: TurnImage[];
}

/** What `usage` answers. `supported: false`: the agent's connector reports no usage. `context` is
 *  the tokens in the model's context window and the window's size, and `cost` the session's cost so
 *  far, each present once the harness reported it. */
export type UsageOutput =
  | { supported: false }
  | { supported: true; context?: { used: number; size: number }; cost?: { amount: number; currency: string } };

/** What `set-model` takes: the model the harness runs from its next turn, absent for the one it runs
 *  now, and its variant, absent to leave the variant to the harness. */
export interface SetModelInput {
  model?: string;
  variant?: string;
}

/** What `set-model` answers: the model the harness runs from its next turn, as the harness names it,
 *  and the variant it runs, absent when the harness names none. */
export interface SetModelOutput {
  model: string;
  variant?: string;
}

/** What `set-name` takes and answers: the display name, which the answer gives as the card now
 *  carries it. */
export interface SetNameIO {
  name: string;
}

const COMMAND_NAME_PATTERN = "^[^\\s\\p{C}]{1,128}$";
const COMMAND_NAME_RE = new RegExp(COMMAND_NAME_PATTERN, "u");

/** Whether `command` can name this command or skill (SPEC 13.22). */
export function isAgentCommandName(name: unknown): name is string {
  return typeof name === "string" && COMMAND_NAME_RE.test(name);
}

/** The digest of a prompt's content: `sha256:<hex>` over its RFC 8785 canonical JSON. A reader
 *  recomputes it over the content it received, and renders or answers nothing on a mismatch. */
export function agentPromptDigest(content: PromptContent): string {
  return contractDigest(content);
}

// ---- the schemas ------------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const closed = (required: string[], properties: Record<string, unknown>) =>
  ({ type: "object", additionalProperties: false, ...(required.length ? { required } : {}), properties });
const text = (max: number) => ({ type: "string", minLength: 1, maxLength: max });
const anyString = { type: "string" };
const uint = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
/** The one timestamp form: UTC, millisecond precision, 24 bytes. */
const TIMESTAMP = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" };
const PROMPT_ID = { type: "string", pattern: "^[a-z2-7]{26}$" };
const DIGEST = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
const OPTION_ID = { type: "string", pattern: "^[a-z0-9-]{1,32}$" };
const REVERSE_DNS = { type: "string", maxLength: 64, pattern: "^[a-z0-9-]{1,63}\\.[a-z0-9.-]{1,63}$" };
const EFFECT = { enum: ["proceed", "refuse", "cancel"] };
const KIND = { anyOf: [{ enum: ["permission", "question", "plan", "form"] }, REVERSE_DNS] };
const TITLE = { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\r\\n]*$" };

const ANSWERER = closed(["id", "uid", "authority"], {
  id: { type: "string", pattern: "^[A-Za-z0-9_]{1,64}\\.[A-Za-z0-9_]{1,64}$" },
  uid: { type: "string", pattern: "^[a-z0-9]{26,32}$" },
  authority: { enum: ["owner", "grant"] },
});
const ANSWER_REF = closed(["by", "option", "effect", "at"], { by: ANSWERER, option: OPTION_ID, effect: EFFECT, at: TIMESTAMP });
const SEEN = {
  oneOf: [
    closed(["tie", "effect"], { tie: { const: "prompt" }, effect: EFFECT }),
    closed(["tie", "effect"], { tie: { const: "subject" }, effect: EFFECT }),
    closed(["tie"], { tie: { const: "none" } }),
  ],
};
const OUTCOME = {
  oneOf: [
    closed(["kind", "answer"], { kind: { const: "answered" }, answer: ANSWER_REF }),
    closed(["kind", "answer", "seen"], { kind: { const: "unconfirmed" }, answer: ANSWER_REF, seen: SEEN }),
    closed(["kind", "answer"], { kind: { const: "undelivered" }, answer: ANSWER_REF }),
    closed(["kind", "seen"], { kind: { const: "local" }, seen: SEEN, late: ANSWER_REF }),
    closed(["kind", "seen"], { kind: { const: "withdrawn" }, seen: SEEN }),
    closed(["kind"], { kind: { const: "expired" } }),
  ],
};
const OPEN_STATE = closed(["kind"], { kind: { const: "open" } });
const SENT_STATE = closed(["kind", "answer", "delivery"], { kind: { const: "sent" }, answer: ANSWER_REF, delivery: { enum: ["unconfirmed", "delivered"] } });
const CLOSED_STATE = closed(["kind", "at", "outcome"], { kind: { const: "closed" }, at: TIMESTAMP, outcome: OUTCOME });
/** `open` or `sent`: what `prompt` returns and what `prompts` lists in `open`. */
const LIVE_STATE = { oneOf: [OPEN_STATE, SENT_STATE] };
const STATE = { oneOf: [OPEN_STATE, SENT_STATE, CLOSED_STATE] };
const SOURCE = closed(["harness"], { harness: text(128), scope: text(128), toolCallId: text(128) });

// The form profile: the MCP elicitation `requestedSchema` profile, a flat object of primitive
// properties, with `description` admitted on a choice entry.
const ANNOTATIONS = { title: anyString, description: anyString };
const CHOICE = closed(["const", "title"], { const: anyString, title: anyString, description: anyString });
const STRINGS = { type: "array", minItems: 1, items: anyString };
const FORM_PROPERTY = {
  anyOf: [
    closed(["type"], { type: { const: "string" }, ...ANNOTATIONS, minLength: uint, maxLength: uint, format: { enum: ["email", "uri", "date", "date-time"] }, default: anyString }),
    closed(["type"], { type: { enum: ["number", "integer"] }, ...ANNOTATIONS, minimum: { type: "number" }, maximum: { type: "number" }, default: { type: "number" } }),
    closed(["type"], { type: { const: "boolean" }, ...ANNOTATIONS, default: { type: "boolean" } }),
    closed(["type", "enum"], { type: { const: "string" }, ...ANNOTATIONS, enum: STRINGS, default: anyString }),
    closed(["type", "oneOf"], { type: { const: "string" }, ...ANNOTATIONS, oneOf: { type: "array", minItems: 1, items: CHOICE }, default: anyString }),
    closed(["type", "items"], {
      type: { const: "array" }, ...ANNOTATIONS, minItems: uint, maxItems: uint,
      items: {
        oneOf: [
          closed(["type", "enum"], { type: { const: "string" }, enum: STRINGS }),
          closed(["anyOf"], { anyOf: { type: "array", minItems: 1, items: CHOICE } }),
        ],
      },
      default: { type: "array", items: anyString },
    }),
  ],
};
const FORM_SCHEMA = closed(["type", "properties"], {
  type: { const: "object" },
  properties: { type: "object", additionalProperties: FORM_PROPERTY },
  required: { type: "array", items: anyString },
});

const INPUT = {
  oneOf: [
    closed(["kind", "value"], { kind: { const: "shown" }, value: {} }),
    closed(["kind", "bytes"], { kind: { const: "omitted" }, bytes: uint }),
  ],
};
const SUBJECT = {
  oneOf: [
    closed(["type", "name", "input"], { type: { const: "tool" }, name: { type: "string", minLength: 1 }, input: INPUT, cwd: anyString, server: anyString }),
    closed(["type", "url"], { type: { const: "url" }, url: { type: "string", minLength: 1 } }),
    closed(["type", "data"], { type: REVERSE_DNS, data: {} }),
  ],
};
const OPTION = closed(["id", "label", "effect"], {
  id: OPTION_ID, label: text(80), effect: EFFECT, description: text(500), persists: text(500),
  note: { enum: ["optional", "required"] }, form: { const: "required" },
});
const CONTENT = closed(["kind", "title", "options"], {
  kind: KIND, title: TITLE,
  body: closed(["format", "text"], { format: { enum: ["text", "markdown"] }, text: anyString }),
  subject: SUBJECT,
  options: { type: "array", minItems: 1, maxItems: AGENT_PROMPT_OPTIONS_MAX, items: OPTION },
  form: closed(["schema"], { schema: FORM_SCHEMA }),
  source: SOURCE,
});
const summary = (state: unknown) => closed(["id", "digest", "openedAt", "expiresAt", "state", "kind", "title", "contentBytes"], {
  id: PROMPT_ID, digest: DIGEST, openedAt: TIMESTAMP, expiresAt: TIMESTAMP, state, kind: KIND, title: TITLE,
  contentBytes: { type: "integer", minimum: 0, maximum: AGENT_PROMPT_CONTENT_MAX_BYTES }, source: SOURCE,
});
const PROMPT = closed(["id", "digest", "openedAt", "expiresAt", "state", "content"], {
  id: PROMPT_ID, digest: DIGEST, openedAt: TIMESTAMP, expiresAt: TIMESTAMP, state: LIVE_STATE, content: CONTENT,
});
const VALUES = {
  type: "object",
  additionalProperties: { anyOf: [anyString, { type: "number" }, { type: "boolean" }, { type: "array", items: anyString }] },
};

export const AGENT_PROMPTS_INPUT_SCHEMA = deepFreeze(closed([], {}));
export const AGENT_PROMPTS_OUTPUT_SCHEMA = deepFreeze(closed(["runtime", "seq", "open", "closed"], {
  runtime: closed(["id", "startedAt"], { id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, startedAt: uint }),
  seq: uint,
  open: { type: "array", maxItems: AGENT_PROMPT_LIST_MAX, items: summary(LIVE_STATE) },
  closed: { type: "array", maxItems: AGENT_PROMPT_LIST_MAX, items: summary(CLOSED_STATE) },
}));
export const AGENT_PROMPT_INPUT_SCHEMA = deepFreeze(closed(["id"], { id: PROMPT_ID }));
export const AGENT_PROMPT_OUTPUT_SCHEMA = deepFreeze(closed(["prompt"], { prompt: PROMPT }));
export const AGENT_PROMPT_ANSWER_INPUT_SCHEMA = deepFreeze(closed(["id", "digest", "option"], {
  id: PROMPT_ID, digest: DIGEST, option: OPTION_ID, note: { type: "string", maxLength: 2000 }, values: VALUES,
}));
export const AGENT_PROMPT_ANSWER_OUTPUT_SCHEMA = deepFreeze(closed(["state"], { state: STATE }));

const COMMAND_NAME = { type: "string", pattern: COMMAND_NAME_PATTERN };
const TARGET = { enum: ["command", "skill"] };
const ENTRY = closed(["name", "target"], {
  name: COMMAND_NAME, target: TARGET, description: text(AGENT_COMMAND_DESCRIPTION_MAX), inputHint: text(AGENT_COMMAND_INPUT_HINT_MAX),
});
/** One listed command or skill, as `commands` and the manager's `harness-commands` list it. */
export const AGENT_COMMAND_ENTRY_SCHEMA = deepFreeze(ENTRY);

export const AGENT_COMMANDS_INPUT_SCHEMA = deepFreeze(closed([], {}));
export const AGENT_COMMANDS_OUTPUT_SCHEMA = deepFreeze({
  oneOf: [
    closed(["supported"], { supported: { const: false } }),
    closed(["supported", "commands"], { supported: { const: true }, commands: { type: "array", maxItems: AGENT_COMMAND_LIST_MAX, items: ENTRY } }),
  ],
});
const COMMAND_ID = { type: "string", pattern: "^[a-z2-7]{26}$" };
const COMMAND_MESSAGE = { type: "string", maxLength: AGENT_COMMAND_MESSAGE_MAX };
const COMMAND_STATE = {
  oneOf: [
    closed(["kind"], { kind: { const: "queued" } }),
    closed(["kind"], { kind: { const: "taken" } }),
    closed(["kind"], { kind: { const: "started" } }),
    closed(["kind"], { kind: { const: "cancelled" } }),
    closed(["kind", "code", "message"], { kind: { const: "refused" }, code: { enum: ["not-found", "failed-precondition", "unavailable"] }, message: COMMAND_MESSAGE }),
    closed(["kind", "code", "message"], { kind: { const: "unknown" }, code: { const: "internal" }, message: COMMAND_MESSAGE }),
  ],
};

export const AGENT_COMMAND_INPUT_SCHEMA = deepFreeze(closed(["target", "name"], { target: TARGET, name: COMMAND_NAME, args: anyString }));
export const AGENT_COMMAND_OUTPUT_SCHEMA = deepFreeze(closed(["id"], { id: COMMAND_ID }));
export const AGENT_COMMAND_CANCEL_INPUT_SCHEMA = deepFreeze(closed(["id"], { id: COMMAND_ID }));
export const AGENT_COMMAND_CANCEL_OUTPUT_SCHEMA = deepFreeze(closed(["state"], { state: COMMAND_STATE }));
export const AGENT_COMMAND_STATE_INPUT_SCHEMA = deepFreeze(closed(["id"], { id: COMMAND_ID }));
export const AGENT_COMMAND_STATE_OUTPUT_SCHEMA = deepFreeze(closed(["state"], { state: COMMAND_STATE }));
export const AGENT_INTERRUPT_INPUT_SCHEMA = deepFreeze(closed([], {}));
export const AGENT_INTERRUPT_OUTPUT_SCHEMA = deepFreeze(closed(["state"], { state: { enum: ["interrupted", "idle"] } }));
// The input takes any string so that every name the shared rule refuses gets the same typed
// `name-invalid` refusal from the agent, a long one included.
export const AGENT_SET_NAME_INPUT_SCHEMA = deepFreeze(closed(["name"], { name: anyString }));
export const AGENT_SET_NAME_OUTPUT_SCHEMA = deepFreeze(closed(["name"], { name: { type: "string", minLength: 1, maxLength: MAX_NAME_LENGTH } }));
const IMAGE = closed(["mimeType", "data"], {
  mimeType: { enum: [...AGENT_TURN_IMAGE_TYPES] },
  data: { type: "string", minLength: 4, pattern: "^[A-Za-z0-9+/]+={0,2}$" },
});
export const AGENT_TURN_INPUT_SCHEMA = deepFreeze(closed(["text"], {
  text: { type: "string", maxLength: AGENT_TURN_TEXT_MAX },
  images: { type: "array", minItems: 1, maxItems: AGENT_TURN_IMAGES_MAX, items: IMAGE },
}));
export const AGENT_TURN_OUTPUT_SCHEMA = deepFreeze(closed(["id"], { id: COMMAND_ID }));
const MODEL_ID = { type: "string", pattern: `^[^\\s\\p{C}]{1,${AGENT_MODEL_ID_MAX}}$` };
const MODEL_VARIANT = { type: "string", pattern: `^[^\\s\\p{C}]{1,${AGENT_MODEL_VARIANT_MAX}}$` };
export const AGENT_SET_MODEL_INPUT_SCHEMA = deepFreeze(closed([], { model: MODEL_ID, variant: MODEL_VARIANT }));
export const AGENT_SET_MODEL_OUTPUT_SCHEMA = deepFreeze(closed(["model"], { model: MODEL_ID, variant: MODEL_VARIANT }));
export const AGENT_USAGE_INPUT_SCHEMA = deepFreeze(closed([], {}));
export const AGENT_USAGE_OUTPUT_SCHEMA = deepFreeze({
  oneOf: [
    closed(["supported"], { supported: { const: false } }),
    closed(["supported"], {
      supported: { const: true },
      context: closed(["used", "size"], { used: uint, size: uint }),
      cost: closed(["amount", "currency"], { amount: { type: "number", minimum: 0 }, currency: { type: "string", pattern: "^[A-Z]{3}$" } }),
    }),
  ],
});

/** The command rows of revision 6. Every command is untargeted. The prompt commands admit both
 *  authority words; `commands`, `command`, `command-cancel`, `command-state`, `interrupt`,
 *  `set-name`, `turn`, `usage` and `set-model` admit `owner` only, so only the owner's interactive
 *  session runs an agent's commands, gives it a turn, stops its turn, reads its usage, switches its
 *  model or renames it. */
export const AGENT_COMMANDS = deepFreeze([
  { name: AGENT_CMD_PROMPTS, capability: "agent.prompts.read", authorities: ["owner", "grant"], input: AGENT_PROMPTS_INPUT_SCHEMA, output: AGENT_PROMPTS_OUTPUT_SCHEMA },
  { name: AGENT_CMD_PROMPT, capability: "agent.prompts.read", authorities: ["owner", "grant"], input: AGENT_PROMPT_INPUT_SCHEMA, output: AGENT_PROMPT_OUTPUT_SCHEMA },
  { name: AGENT_CMD_PROMPT_ANSWER, capability: "agent.prompts.answer", authorities: ["owner", "grant"], input: AGENT_PROMPT_ANSWER_INPUT_SCHEMA, output: AGENT_PROMPT_ANSWER_OUTPUT_SCHEMA },
  { name: AGENT_CMD_COMMANDS, capability: "agent.commands.read", authorities: ["owner"], input: AGENT_COMMANDS_INPUT_SCHEMA, output: AGENT_COMMANDS_OUTPUT_SCHEMA },
  { name: AGENT_CMD_COMMAND, capability: "agent.commands.run", authorities: ["owner"], input: AGENT_COMMAND_INPUT_SCHEMA, output: AGENT_COMMAND_OUTPUT_SCHEMA },
  { name: AGENT_CMD_COMMAND_CANCEL, capability: "agent.commands.run", authorities: ["owner"], input: AGENT_COMMAND_CANCEL_INPUT_SCHEMA, output: AGENT_COMMAND_CANCEL_OUTPUT_SCHEMA },
  { name: AGENT_CMD_COMMAND_STATE, capability: "agent.commands.read", authorities: ["owner"], input: AGENT_COMMAND_STATE_INPUT_SCHEMA, output: AGENT_COMMAND_STATE_OUTPUT_SCHEMA },
  { name: AGENT_CMD_INTERRUPT, capability: "agent.turn.interrupt", authorities: ["owner"], input: AGENT_INTERRUPT_INPUT_SCHEMA, output: AGENT_INTERRUPT_OUTPUT_SCHEMA },
  { name: AGENT_CMD_SET_NAME, capability: "agent.profile.write", authorities: ["owner"], input: AGENT_SET_NAME_INPUT_SCHEMA, output: AGENT_SET_NAME_OUTPUT_SCHEMA },
  { name: AGENT_CMD_TURN, capability: "agent.turn.start", authorities: ["owner"], input: AGENT_TURN_INPUT_SCHEMA, output: AGENT_TURN_OUTPUT_SCHEMA },
  { name: AGENT_CMD_USAGE, capability: "agent.usage.read", authorities: ["owner"], input: AGENT_USAGE_INPUT_SCHEMA, output: AGENT_USAGE_OUTPUT_SCHEMA },
  { name: AGENT_CMD_SET_MODEL, capability: "agent.model.write", authorities: ["owner"], input: AGENT_SET_MODEL_INPUT_SCHEMA, output: AGENT_SET_MODEL_OUTPUT_SCHEMA },
].map((row) => ({ ...row, targeted: false, authorities: row.authorities as PrincipalAuthority[] })));

const TABLE = serviceContractTable(AGENT_COMMANDS);

/** The compiled input and output pair per command, compiled on first access. */
export const AGENT_CONTRACTS = TABLE.contracts;

/** The cluster document of revision 6, deep-frozen. */
export const AGENT_CLUSTER: Readonly<ClusterDocument> = deepFreeze(buildClusterDocument(AGENT_CLUSTER_URN, AGENT_CLUSTER_REVISION, AGENT_COMMANDS));

/** The cluster document's two digests: the root artifact and the closure manifest a caller pins
 *  and `describe` names. */
export function agentClusterArtifacts(): { document: ClusterDocument; rootDigest: string; manifest: ContractClosureManifest; closureDigest: string } {
  return buildClusterArtifacts(structuredClone(AGENT_CLUSTER) as ClusterDocument);
}

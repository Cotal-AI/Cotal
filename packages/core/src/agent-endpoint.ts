/**
 * The `agent` endpoint, revision 1 (SPEC 13.22): the fixed command set an agent serves about itself
 * on the principal route (SPEC 13.21). Revision 1 has `prompts`, `prompt` and `prompt-answer`, for
 * the questions an agent's harness stops to ask: a tool permission, a question, a plan, a form.
 *
 * The contract is a core constant, like the registry's: every agent serves the same cluster, a
 * caller embeds these artifacts and pins their digests, and nothing is published to the contract
 * store. Every schema is closed and frozen. This module declares the wire; it serves nothing and
 * holds no prompt. The prompt desk that does is separate work.
 */
import { contractDigest } from "./canonical.js";
import { buildClusterArtifacts, buildClusterDocument, type ClusterDocument } from "./endpoint-cluster.js";
import type { ContractClosureManifest } from "./contract-manifest.js";
import { serviceContractTable } from "./schema-profile.js";
import type { PrincipalAuthority } from "./endpoint-subjects.js";

export const AGENT_ENDPOINT = "agent";
export const AGENT_CLUSTER_URN = "ai.cotal.agent";
export const AGENT_CLUSTER_REVISION = 1;

export const AGENT_CMD_PROMPTS = "prompts";
export const AGENT_CMD_PROMPT = "prompt";
export const AGENT_CMD_PROMPT_ANSWER = "prompt-answer";

/** The canonical `content` of one prompt is at most this many bytes (SPEC 13.22). */
export const AGENT_PROMPT_CONTENT_MAX_BYTES = 262144;
/** A `prompts` reply lists at most this many prompts in `open` and this many in `closed`. */
export const AGENT_PROMPT_LIST_MAX = 32;
/** A prompt offers between 1 and this many options. */
export const AGENT_PROMPT_OPTIONS_MAX = 16;

/** `details[].kind` on a `conflict`, and on a `failed-precondition` for a closed prompt: `{ state }`. */
export const AGENT_PROMPT_STATE_DETAIL = "ai.cotal.agent.prompt-state";
/** `details[].kind` on a `failed-precondition` for a digest that differs: `{ digest }`. */
export const AGENT_PROMPT_DIGEST_DETAIL = "ai.cotal.agent.prompt-digest";
/** `details[].kind` on a `resource-exhausted` reply: `{ bytes, limit }`. */
export const AGENT_PROMPT_SIZE_DETAIL = "ai.cotal.agent.prompt-size";

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

/** The command rows of revision 1. Every command is untargeted and admits both authority words. */
export const AGENT_COMMANDS = deepFreeze([
  { name: AGENT_CMD_PROMPTS, capability: "agent.prompts.read", input: AGENT_PROMPTS_INPUT_SCHEMA, output: AGENT_PROMPTS_OUTPUT_SCHEMA },
  { name: AGENT_CMD_PROMPT, capability: "agent.prompts.read", input: AGENT_PROMPT_INPUT_SCHEMA, output: AGENT_PROMPT_OUTPUT_SCHEMA },
  { name: AGENT_CMD_PROMPT_ANSWER, capability: "agent.prompts.answer", input: AGENT_PROMPT_ANSWER_INPUT_SCHEMA, output: AGENT_PROMPT_ANSWER_OUTPUT_SCHEMA },
].map((row) => ({ ...row, targeted: false, authorities: ["owner", "grant"] as PrincipalAuthority[] })));

const TABLE = serviceContractTable(AGENT_COMMANDS);

/** The compiled input and output pair per command, compiled on first access. */
export const AGENT_CONTRACTS = TABLE.contracts;

/** The cluster document of revision 1, deep-frozen. */
export const AGENT_CLUSTER: Readonly<ClusterDocument> = deepFreeze(buildClusterDocument(AGENT_CLUSTER_URN, AGENT_CLUSTER_REVISION, AGENT_COMMANDS));

/** The cluster document's two digests: the root artifact and the closure manifest a caller pins
 *  and `describe` names. */
export function agentClusterArtifacts(): { document: ClusterDocument; rootDigest: string; manifest: ContractClosureManifest; closureDigest: string } {
  return buildClusterArtifacts(structuredClone(AGENT_CLUSTER) as ClusterDocument);
}

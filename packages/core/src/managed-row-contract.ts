import { canonicalJson } from "./canonical.js";
import {
  EpEnvelopeError,
  assertArgsValid,
  parseEndpointReply,
  parseEndpointRequest,
  type EndpointReply,
  type EndpointRequest,
  type EpError,
  type EpEffectOutcome,
} from "./endpoint-envelope.js";
import { hasDuplicateNames } from "./endpoint-journal.js";
import {
  managedRowWireId,
  validateManagedRowAttemptAuthority,
  validateManagedRowIntent,
  type ManagedRowAttempt,
  type ManagedRowAttemptAuthority,
  type ManagedRowIntent,
} from "./managed-row-request.js";
import { compileContract, type CompiledContract } from "./schema-profile.js";

export const MANAGED_ROW_ENDPOINT = "auth" as const;

const AUTHORITY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["kind", "instanceId", "processEpoch"],
  properties: {
    kind: { const: "local-manager" }, instanceId: { type: "string", minLength: 1, maxLength: 64 },
    processEpoch: { type: "integer", minimum: 0 },
  },
} as const;

/** Shape is deliberately broad at `intent`: the closed command-specific semantic validator remains
 * the single source of truth, while the fixed §13.7 digest prevents an alternate payload contract. */
export const MANAGED_ROW_INPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["intent"],
  properties: { intent: { type: "object" }, authority: AUTHORITY_SCHEMA },
} as const);

export const MANAGED_ROW_OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["ver", "command", "requestId", "operationId", "target", "state", "targetDigest", "historyHead"],
  properties: {
    ver: { const: 1 },
    command: { enum: ["create-managed-row", "revoke-managed-row"] },
    requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" },
    operationId: { type: "string", pattern: "^[A-Za-z0-9_:-]{16,192}$" },
    target: {
      type: "object", additionalProperties: false, required: ["owner", "actor", "lifecycleUid"],
      properties: {
        owner: { type: "string", minLength: 1, maxLength: 64 }, actor: { type: "string", minLength: 1, maxLength: 64 },
        lifecycleUid: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    state: { enum: ["live", "tombstone"] },
    targetDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    historyHead: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
} as const);

export const MANAGED_ROW_INPUT_CONTRACT: CompiledContract = compileContract({ root: MANAGED_ROW_INPUT_SCHEMA });
export const MANAGED_ROW_OUTPUT_CONTRACT: CompiledContract = compileContract({ root: MANAGED_ROW_OUTPUT_SCHEMA });
export const MANAGED_ROW_INPUT_DIGEST = MANAGED_ROW_INPUT_CONTRACT.closureDigest;
export const MANAGED_ROW_OUTPUT_DIGEST = MANAGED_ROW_OUTPUT_CONTRACT.closureDigest;

export interface ManagedRowArgs { intent: ManagedRowIntent; authority?: ManagedRowAttemptAuthority }
export interface ManagedRowResult {
  ver: 1;
  command: ManagedRowIntent["command"];
  requestId: string;
  operationId: string;
  target: ManagedRowIntent["target"];
  state: "live" | "tombstone";
  targetDigest: string;
  historyHead: string;
}

export function managedRowEndpointRequest(attempt: ManagedRowAttempt, deadlineMs: number): EndpointRequest {
  const intent = validateManagedRowIntent(attempt.intent);
  if (attempt.ver !== 1 || attempt.command !== intent.command) throw new Error("managed-row transport attempt command mismatch");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("managed-row deadlineMs must be a positive safe integer");
  return {
    v: 1, id: managedRowWireId(intent),
    op: { endpoint: MANAGED_ROW_ENDPOINT, command: intent.command, inputDigest: MANAGED_ROW_INPUT_DIGEST, outputDigest: MANAGED_ROW_OUTPUT_DIGEST },
    class: "ephemeral", replyExpected: true, deadlineMs,
    args: { intent, ...(attempt.authority !== undefined ? { authority: validateManagedRowAttemptAuthority(attempt.authority) } : {}) },
    from: { id: `${attempt.caller.owner}.${attempt.caller.actor}`, name: attempt.caller.actor },
    ...(intent.command === "revoke-managed-row" ? { target: { ...intent.target, ...(attempt.mappingRevision !== undefined ? { mappingRevision: attempt.mappingRevision } : {}) } } : {}),
    ...(attempt.bind !== undefined ? { bind: attempt.bind } : {}),
  };
}

export function parseManagedRowEndpointRequest(raw: unknown): { envelope: EndpointRequest; args: ManagedRowArgs } {
  const envelope = parseEndpointRequest(raw);
  if (envelope.op.endpoint !== MANAGED_ROW_ENDPOINT || (envelope.op.command !== "create-managed-row" && envelope.op.command !== "revoke-managed-row"))
    throw new EpEnvelopeError("op-mismatch", "the endpoint envelope does not name a managed-row auth command", undefined, "not-executed");
  if (envelope.op.inputDigest !== MANAGED_ROW_INPUT_DIGEST || envelope.op.outputDigest !== MANAGED_ROW_OUTPUT_DIGEST)
    throw new EpEnvelopeError("contract-mismatch", "managed-row request does not pin the fixed input/output contract digests", undefined, "not-executed");
  if (envelope.class !== "ephemeral") throw new EpEnvelopeError("class-mismatch", "managed-row commands are ephemeral", undefined, "not-executed");
  if (!envelope.replyExpected) throw new EpEnvelopeError("bad-request", "managed-row requests are calls and require replyExpected: true", undefined, "not-executed");
  if (envelope.auth !== undefined) throw new EpEnvelopeError("bad-request", "managed-row requests do not support the auth slot", undefined, "not-executed");
  if (envelope.goalId !== undefined) throw new EpEnvelopeError("bad-request", "managed-row requests do not support goalId", undefined, "not-executed");
  if (envelope.correlation !== undefined) throw new EpEnvelopeError("bad-request", "managed-row requests do not support correlation", undefined, "not-executed");
  assertArgsValid(MANAGED_ROW_INPUT_CONTRACT.validate, envelope.args);
  const rawArgs = envelope.args as Record<string, unknown>;
  let intent: ManagedRowIntent;
  let authority: ManagedRowAttemptAuthority | undefined;
  try {
    intent = validateManagedRowIntent(rawArgs.intent);
    authority = validateManagedRowAttemptAuthority(rawArgs.authority as ManagedRowAttemptAuthority | undefined);
  } catch (error) {
    throw new EpEnvelopeError("bad-request", `managed-row args fail semantic validation: ${(error as Error).message}`, undefined, "not-executed");
  }
  if (intent.command !== envelope.op.command) throw new EpEnvelopeError("op-mismatch", "managed-row intent command disagrees with envelope op.command", undefined, "not-executed");
  if (envelope.id !== managedRowWireId(intent)) throw new EpEnvelopeError("failed-precondition", "managed-row request id does not match its canonical immutable intent", undefined, "not-executed");
  return { envelope, args: { intent, ...(authority !== undefined ? { authority } : {}) } };
}

export function managedRowSuccessReply(id: string, data: ManagedRowResult): EndpointReply {
  if (!MANAGED_ROW_OUTPUT_CONTRACT.validate(data)) throw new Error(`managed-row output violates its fixed contract: ${MANAGED_ROW_OUTPUT_CONTRACT.validate.errors?.[0]?.message ?? "invalid output"}`);
  const expectedState = data.command === "create-managed-row" ? "live" : "tombstone";
  if (data.state !== expectedState) throw new Error(`managed-row ${data.command} cannot return state ${data.state}`);
  return { v: 1, id, ok: true, data };
}

export function endpointErrorReply(id: string, error: unknown, fallbackOutcome: EpEffectOutcome = "unknown"): EndpointReply {
  const ep: EpError = error instanceof EpEnvelopeError
    ? error.toEpError()
    : { code: "internal", message: (error as Error)?.message ?? String(error), outcome: fallbackOutcome };
  return { v: 1, id, ok: false, error: ep.outcome === undefined ? { ...ep, outcome: fallbackOutcome } : ep };
}

function decodeJson(bytes: Uint8Array, what: string): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new EpEnvelopeError("bad-request", `${what} is not valid UTF-8`); }
  const dup = hasDuplicateNames(text);
  if (dup.duplicate) throw new EpEnvelopeError("bad-request", `${what} has duplicate object name ${JSON.stringify(dup.name)}`);
  try { return JSON.parse(text); }
  catch { throw new EpEnvelopeError("bad-request", `${what} is not valid JSON`); }
}

export function parseManagedRowRequestBytes(bytes: Uint8Array): { envelope: EndpointRequest; args: ManagedRowArgs } {
  return parseManagedRowEndpointRequest(decodeJson(bytes, "managed-row request"));
}

export function parseManagedRowReplyBytes(bytes: Uint8Array, id: string, intent: ManagedRowIntent):
  | (EndpointReply & { ok: false; data?: never })
  | (EndpointReply & { ok: true; data: ManagedRowResult }) {
  const reply = parseEndpointReply(decodeJson(bytes, "managed-row reply"));
  if (reply.id !== id) throw new EpEnvelopeError("failed-precondition", "managed-row reply does not echo the stable request id");
  if (!reply.ok) return {
    v: reply.v, id: reply.id, ok: false,
    ...(reply.error !== undefined ? { error: reply.error } : {}),
    ...(reply.receipt !== undefined ? { receipt: reply.receipt } : {}),
  };
  if (!MANAGED_ROW_OUTPUT_CONTRACT.validate(reply.data))
    throw new EpEnvelopeError("failed-precondition", `managed-row reply violates its fixed output contract: ${MANAGED_ROW_OUTPUT_CONTRACT.validate.errors?.[0]?.message ?? "invalid output"}`);
  const data = reply.data as ManagedRowResult;
  const expectedState = intent.command === "create-managed-row" ? "live" : "tombstone";
  if (data.command !== intent.command || data.requestId !== intent.requestId || data.operationId !== intent.operationId ||
      data.state !== expectedState || canonicalJson(data.target) !== canonicalJson(intent.target))
    throw new EpEnvelopeError("failed-precondition", "managed-row reply does not bind all immutable operation coordinates");
  return { ...reply, ok: true, data };
}

export type ManagedRowCallerKnowledge = "not-executed" | "executed" | "unknown";
export class ManagedRowAttemptError extends Error {
  readonly name = "ManagedRowAttemptError";
  constructor(message: string, readonly knowledge: ManagedRowCallerKnowledge, readonly reply?: EndpointReply, options?: ErrorOptions) {
    super(message, options);
  }
}

export function managedRowReplyKnowledge(reply: EndpointReply): ManagedRowCallerKnowledge {
  if (reply.ok) return "executed";
  return reply.error?.outcome === "not-executed" ? "not-executed" : reply.error?.outcome === "executed" ? "executed" : "unknown";
}

/** Caller-local facts are not wire outcome. In particular, publish-return followed by silence proves
 * neither broker acceptance nor non-execution; only a held reply or the reserved broker sentinel
 * strengthens the verdict. */
export function managedRowFailureKnowledge(facts: {
  published: boolean;
  prePublicationRefusal?: boolean;
  noRespondersSentinel?: boolean;
  reply?: EndpointReply;
  timedOut?: boolean;
}): ManagedRowCallerKnowledge {
  if (facts.reply !== undefined) return managedRowReplyKnowledge(facts.reply);
  if (!facts.published && facts.prePublicationRefusal === true) return "not-executed";
  if (facts.noRespondersSentinel === true) return "not-executed";
  return "unknown";
}

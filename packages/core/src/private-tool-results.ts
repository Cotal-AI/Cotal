import { fromPublic } from "@nats-io/nkeys";
import { canonicalJson } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { isAccountNkey } from "./identity.js";
import { compileContractSchema, singleDocumentClosure } from "./schema-profile.js";
import { resolveAnchorForUse, assertAnchorScopeCovers, type AnchorResolver, type SignerAnchor } from "./endpoint-signing.js";

/** Declaration-only contracts for SPEC §13.19. Parsing is not signature verification,
 *  current-state authorization, issuance, registration or permission to serve. */
export const TOOL_RESULTS_ENDPOINT = "tool-results";
export const TOOL_RESULT_MAX_CONTENT_BYTES = 64 * 1024;
export const TOOL_RESULT_MAX_ENTRIES = 256;
export const TOOL_RESULT_MAX_RETENTION_MS = 60 * 60 * 1000;
export const TOOL_RESULT_CONSENT_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export interface ToolResultTarget { owner: string; actor: string; lifecycleUid: string; }
export interface ToolResultConsent {
  v: 1;
  kind: "tool-result-consent";
  id: string;
  space: string;
  target: ToolResultTarget;
  holder: { owner: string; actor: string };
  /** Milliseconds since the Unix epoch, as for other §13.10 timed artifacts. */
  iat: number;
  exp: number;
  issuer: { keyId: string };
  sig: string;
}

/** A create-only marker's value. Retention and monotonic writes belong to the auth store. */
export interface ToolResultRevocation {
  v: 1;
  kind: "tool-result-revocation";
  space: string;
  consentId: string;
  target: ToolResultTarget;
  revokedAt: number;
}

/** Wire coordinates, not a branded EpServeGrant. No consuming authority accepts this shape
 *  alone. The host must register and authorize the real grant before material can be installed. */
export interface ToolResultServingMaterial {
  v: 1;
  kind: "tool-result-serving-material";
  space: string;
  accountPublicKey: string;
  target: ToolResultTarget;
  grant: { endpoint: "tool-results"; instanceId: string; epoch: number; registrationRevision: number };
  credential: string;
  snapshot: { t0: number; watermark: number; watermarkTakenAt: number; revokedConsentIds: string[] };
  /** Unix seconds; fixed from snapshot.t0, not from delivery or installation. */
  expiresAt: number;
}

export type ToolResultAnswer =
  | { state: "available"; threadId: string; toolCallId: string; content: string; truncated: boolean; byteCount: number; error: boolean; capturedAt: number }
  | { state: "pending"; threadId: string; toolCallId: string }
  | { state: "not-shared" | "missing" | "expired" };
export type ToolResultRevocationOutcome = { state: "known" | "refused" | "unknown"; consentId: string };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const text = { type: "string", minLength: 1 };
const id = { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" };
const actor = { type: "string", minLength: 1, pattern: "^[A-Za-z0-9_]+$" };
const owner = { type: "string", pattern: "^u_[a-z2-7]{26}$" };
const uid = { type: "string", pattern: "^[a-z0-9]{26,32}$" };
const space = { type: "string", minLength: 1, pattern: "^[A-Za-z0-9_-]+$" };
const uint = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const bool = { type: "boolean" };
const closed = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const target = closed({ owner, actor, lifecycleUid: uid });
const pair = { threadId: text, toolCallId: text };
const status = (state: string, fields: Record<string, unknown> = {}) => closed({ state: { const: state }, ...fields });

export const TOOL_RESULT_CONSENT_SCHEMA = deepFreeze(closed({
  v: { const: 1 }, kind: { const: "tool-result-consent" }, id, space, target,
  holder: closed({ owner, actor }), iat: uint, exp: uint,
  issuer: closed({ keyId: id }), sig: { type: "string", pattern: "^[A-Za-z0-9_-]{86}$" },
}));
export const TOOL_RESULT_REVOCATION_SCHEMA = deepFreeze(closed({
  v: { const: 1 }, kind: { const: "tool-result-revocation" }, space, consentId: id, target, revokedAt: uint,
}));
export const TOOL_RESULT_SERVING_MATERIAL_SCHEMA = deepFreeze(closed({
  v: { const: 1 }, kind: { const: "tool-result-serving-material" }, space,
  accountPublicKey: { type: "string", pattern: "^A[A-Z2-7]{55}$" }, target,
  grant: closed({ endpoint: { const: TOOL_RESULTS_ENDPOINT }, instanceId: uid, epoch: uint, registrationRevision: { ...uint, minimum: 1 } }),
  credential: { type: "string", minLength: 1, maxLength: 16384 },
  snapshot: closed({ t0: uint, watermark: uint, watermarkTakenAt: uint, revokedConsentIds: { type: "array", uniqueItems: true, items: id } }),
  expiresAt: uint,
}));
export const TOOL_RESULT_INPUT_SCHEMA = deepFreeze(closed(pair));
export const TOOL_RESULT_ANSWER_SCHEMAS = deepFreeze({
  available: status("available", { ...pair, content: { type: "string", maxLength: TOOL_RESULT_MAX_CONTENT_BYTES }, truncated: bool, byteCount: { ...uint, maximum: TOOL_RESULT_MAX_CONTENT_BYTES }, error: bool, capturedAt: uint }),
  pending: status("pending", pair),
  "not-shared": status("not-shared"),
  missing: status("missing"),
  expired: status("expired"),
});
export const TOOL_RESULT_OUTPUT_SCHEMA = deepFreeze({ oneOf: Object.values(TOOL_RESULT_ANSWER_SCHEMAS) });
export const TOOL_RESULT_CONSENT_INPUT_SCHEMA = deepFreeze(closed({ consent: TOOL_RESULT_CONSENT_SCHEMA }));
export const TOOL_RESULT_CONSENT_OUTPUT_SCHEMA = deepFreeze(status("active", { consentId: id }));
export const TOOL_RESULT_REVOKE_INPUT_SCHEMA = deepFreeze(closed({ consentId: id }));
export const TOOL_RESULT_REVOKE_ANSWER_SCHEMAS = deepFreeze({
  known: status("known", { consentId: id }),
  refused: status("refused", { consentId: id }),
  unknown: status("unknown", { consentId: id }),
});
export const TOOL_RESULT_REVOKE_OUTPUT_SCHEMA = deepFreeze({ oneOf: Object.values(TOOL_RESULT_REVOKE_ANSWER_SCHEMAS) });

/** Frozen declarations only. No service registration, handler, grant or profile is installed. */
export const TOOL_RESULTS_COMMANDS = deepFreeze([
  { name: "tool-result", capability: "tool-results.read", input: TOOL_RESULT_INPUT_SCHEMA, output: TOOL_RESULT_OUTPUT_SCHEMA },
  { name: "tool-result-consent", capability: "tool-results.consent", input: TOOL_RESULT_CONSENT_INPUT_SCHEMA, output: TOOL_RESULT_CONSENT_OUTPUT_SCHEMA },
  { name: "tool-result-revoke", capability: "tool-results.revoke", input: TOOL_RESULT_REVOKE_INPUT_SCHEMA, output: TOOL_RESULT_REVOKE_OUTPUT_SCHEMA },
]);
export const TOOL_RESULTS_CLUSTER = deepFreeze({
  urn: "ai.cotal.tool-results", revision: 1, attributes: [], events: [],
  commands: TOOL_RESULTS_COMMANDS.map(row => ({
    name: row.name, class: "ephemeral", targeted: true, modes: ["handle"], capability: row.capability,
    inputDigest: singleDocumentClosure(row.input).closureDigest,
    outputDigest: singleDocumentClosure(row.output).closureDigest,
  })),
});

const validators = new WeakMap<object, ReturnType<typeof compileContractSchema>>();
function bad(what: string): never {
  throw new EpEnvelopeError("bad-request", `private tool-result ${what} does not match its closed contract`, undefined, "not-executed");
}
function parse<T>(schema: object, raw: unknown, what: string): T {
  let copy: unknown;
  try { copy = JSON.parse(canonicalJson(raw)); } catch { bad(what); }
  let validate = validators.get(schema);
  if (!validate) {
    validate = compileContractSchema({ root: schema });
    validators.set(schema, validate);
  }
  if (!validate(copy)) bad(what);
  return deepFreeze(copy) as T;
}

/** Parse shape and static bindings only; verify signatures and current authority separately. */
export function parseToolResultConsent(raw: unknown): ToolResultConsent {
  const c = parse<ToolResultConsent>(TOOL_RESULT_CONSENT_SCHEMA, raw, "consent");
  if (c.holder.owner !== c.target.owner || c.holder.actor === c.target.actor || c.exp <= c.iat || c.exp - c.iat > TOOL_RESULT_CONSENT_MAX_TTL_MS) bad("consent binding or window");
  return c;
}
export function parseToolResultRevocation(raw: unknown): ToolResultRevocation {
  return parse(TOOL_RESULT_REVOCATION_SCHEMA, raw, "revocation");
}
export function parseToolResultServingMaterial(raw: unknown): ToolResultServingMaterial {
  const m = parse<ToolResultServingMaterial>(TOOL_RESULT_SERVING_MATERIAL_SCHEMA, raw, "serving material");
  if (!isAccountNkey(m.accountPublicKey) || m.snapshot.watermarkTakenAt < m.snapshot.t0 || m.expiresAt !== Math.floor(m.snapshot.t0 / 1000) + 600) bad("serving material binding or expiry");
  try { fromPublic(m.accountPublicKey); } catch { bad("serving material account key"); }
  return m;
}
export function parseToolResultAnswer(raw: unknown): ToolResultAnswer {
  const a = parse<ToolResultAnswer>(TOOL_RESULT_OUTPUT_SCHEMA, raw, "answer");
  if (a.state === "available" && new TextEncoder().encode(a.content).length !== a.byteCount) bad("answer byte count");
  return a;
}
export function parseToolResultRevocationOutcome(raw: unknown): ToolResultRevocationOutcome {
  return parse(TOOL_RESULT_REVOKE_OUTPUT_SCHEMA, raw, "revocation outcome");
}

/** Resolve only the accepted anchor family/scope. This does not verify a consent signature,
 *  establish human proof or authorize redemption; no signer is exposed. */
export async function resolveToolResultConsentAnchor(resolve: AnchorResolver, keyId: string, at: number): Promise<SignerAnchor> {
  const anchor = await resolveAnchorForUse(resolve, { keyId, role: "consents", at });
  assertAnchorScopeCovers(anchor, "consents", TOOL_RESULTS_ENDPOINT, "private tool-result consent");
  return anchor;
}

import assert from "node:assert/strict";
import { createAccount } from "@nats-io/nkeys";
import {
  ANCHOR_ROLES, EpEnvelopeError, REMOTE_MANAGER_IDENTITY_NAMES, newIdentity,
  parseClusterDocument, compileContractSchema, singleDocumentClosure,
  parseRemoteManagedAgentToolResultServingRequest,
  parseToolResultConsent, parseToolResultRevocation, parseToolResultServingMaterial,
  parseToolResultAnswer, parseToolResultRevocationOutcome, resolveToolResultConsentAnchor,
  TOOL_RESULTS_ENDPOINT, TOOL_RESULTS_CLUSTER, TOOL_RESULTS_COMMANDS,
  TOOL_RESULT_CONSENT_SCHEMA, TOOL_RESULT_REVOCATION_SCHEMA, TOOL_RESULT_SERVING_MATERIAL_SCHEMA,
  TOOL_RESULT_ANSWER_SCHEMAS, TOOL_RESULT_REVOKE_ANSWER_SCHEMAS,
  TOOL_RESULT_MAX_CONTENT_BYTES, TOOL_RESULT_MAX_ENTRIES, TOOL_RESULT_MAX_RETENTION_MS,
  type SignerAnchor,
} from "@cotal-ai/core";

let passed = 0;
function check(name: string, run: () => void): void { run(); passed++; console.log(`✓ ${name}`); }
async function asyncCheck(name: string, run: () => Promise<void>): Promise<void> { await run(); passed++; console.log(`✓ ${name}`); }
function refuses(run: () => unknown): void {
  assert.throws(run, e => e instanceof EpEnvelopeError && e.code === "bad-request");
}
const copy = <T>(value: T): T => structuredClone(value);
const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const uid = "a".repeat(26);
const account = createAccount().getPublicKey();
const badAccount = account.slice(0, -1) + (account.endsWith("A") ? "B" : "A");
const user = newIdentity().id;
const target = { owner, actor: "agent", lifecycleUid: uid };
const consent = { v: 1, kind: "tool-result-consent", id: "consent_1", space: "private_results", target,
  holder: { owner, actor: "web" }, iat: 1_000, exp: 86_401_000, issuer: { keyId: "consent_key" }, sig: "A".repeat(86) };
const revocation = { v: 1, kind: "tool-result-revocation", space: consent.space, consentId: consent.id, target, revokedAt: 2000 };
const material = { v: 1, kind: "tool-result-serving-material", space: consent.space, accountPublicKey: account, target,
  grant: { endpoint: "tool-results", instanceId: uid, epoch: 0, registrationRevision: 1 }, credential: "fixture-not-a-credential",
  snapshot: { t0: 1000, watermark: 0, watermarkTakenAt: 1001, revokedConsentIds: [consent.id] }, expiresAt: 601 };
const request = { v: 1, kind: "manager-managed-agent-tool-result-serving", space: consent.space, actor: "cli", accountPublicKey: account,
  instanceId: uid, managerLifecycleUid: "b".repeat(26), requestId: "r".repeat(22), registrationProof: `sha256:${"a".repeat(64)}`,
  serveEpoch: 0, operation: "issue", target,
  identities: Object.fromEntries(REMOTE_MANAGER_IDENTITY_NAMES.map(name => [name, { id: user }])) };

check("exported consent boundary round-trips and detaches the input", () => {
  const raw = copy(consent);
  const result = parseToolResultConsent(raw);
  assert.deepEqual(result, consent);
  raw.holder.actor = "changed";
  assert.equal(result.holder.actor, "web");
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.holder) && Object.isFrozen(result.issuer));
});
check("exported revocation boundary round-trips a closed marker", () => assert.deepEqual(parseToolResultRevocation(revocation), revocation));
check("exported serving-material boundary conserves account, target and expiry", () => assert.deepEqual(parseToolResultServingMaterial(material), material));
for (const operation of ["issue", "renew"]) check(`shared managed envelope round-trips ${operation}`, () => {
  const r = parseRemoteManagedAgentToolResultServingRequest({ ...request, operation });
  assert.equal(r.operation, operation);
  assert.equal(r.accountPublicKey, account);
  assert.deepEqual(r.target, target);
  assert.deepEqual(r.identities, request.identities);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.target) && Object.isFrozen(r.identities) && Object.values(r.identities).every(Object.isFrozen));
});

for (const [name, raw, parser, paths] of [
  ["consent", consent, parseToolResultConsent, [[], ["target"], ["holder"], ["issuer"]]],
  ["revocation", revocation, parseToolResultRevocation, [[], ["target"]]],
  ["material", material, parseToolResultServingMaterial, [[], ["target"], ["grant"], ["snapshot"]]],
  ["request", request, parseRemoteManagedAgentToolResultServingRequest, [[], ["target"], ["identities"], ...REMOTE_MANAGER_IDENTITY_NAMES.map(n => ["identities", n])]],
] as const) for (const path of paths) check(`${name} refuses unknown fields at ${path.join(".") || "root"}`, () => {
  const rawCopy = copy(raw) as unknown as Record<string, unknown>;
  let node = rawCopy;
  for (const p of path) node = node[p] as Record<string, unknown>;
  node.unexpected = "not-authority";
  refuses(() => parser(rawCopy));
});
for (const field of ["owner", "profile", "mint", "signer", "resume", "permissions"]) check(`serving request refuses caller-selected ${field}`, () => refuses(() => parseRemoteManagedAgentToolResultServingRequest({ ...request, [field]: "extra" })));
for (const operation of ["resume", "prepare", "mint", "", null]) check(`serving operation ${String(operation)} is unsupported`, () => refuses(() => parseRemoteManagedAgentToolResultServingRequest({ ...request, operation })));
for (const [field, value] of [["kind", "manager-service"], ["v", 2], ["serveEpoch", -1], ["serveEpoch", 0.5], ["serveEpoch", Number.MAX_SAFE_INTEGER + 1], ["accountPublicKey", user], ["registrationProof", "wrong"], ["instanceId", "short"], ["managerLifecycleUid", "short"], ["space", "bad.space"]] as const)
  check(`serving envelope rejects malformed ${field}`, () => refuses(() => parseRemoteManagedAgentToolResultServingRequest({ ...request, [field]: value })));
for (const [field, value] of [["owner", "foreign"], ["actor", "bad.actor"], ["lifecycleUid", "short"]] as const)
  check(`serving target rejects malformed ${field}`, () => refuses(() => parseRemoteManagedAgentToolResultServingRequest({ ...request, target: { ...target, [field]: value } })));
for (const change of [{ holder: { owner: "u_bbbbbbbbbbbbbbbbbbbbbbbbbb", actor: "web" } }, { holder: { owner, actor: "agent" } }, { exp: consent.exp + 1 }, { exp: consent.iat }, { iat: -1 }, { exp: 1.5 }, { sig: "not-a-signature" }, { kind: "session" }])
  check("consent rejects a wrong binding, discriminant or window", () => refuses(() => parseToolResultConsent({ ...consent, ...change })));
check("consent parser does not claim current-time or signature verification", () => assert.equal(parseToolResultConsent(consent).iat, 1000));
check("inherited required fields cannot form a serving request", () => refuses(() => parseRemoteManagedAgentToolResultServingRequest(Object.create(request))));
check("account prefix alone does not validate a corrupted checksum", () => refuses(() => parseRemoteManagedAgentToolResultServingRequest({ ...request, accountPublicKey: badAccount })));
for (const field of Object.keys(request)) check(`serving request requires own ${field}`, () => {
  const r = copy(request) as Record<string, unknown>;
  delete r[field];
  refuses(() => parseRemoteManagedAgentToolResultServingRequest(r));
});
for (const change of [{ expiresAt: material.expiresAt + 1 }, { snapshot: { ...material.snapshot, watermarkTakenAt: 999 } }, { snapshot: { ...material.snapshot, revokedConsentIds: [consent.id, consent.id] } }, { accountPublicKey: user }, { accountPublicKey: badAccount }, { grant: { ...material.grant, endpoint: "manager" } }])
  check("serving material rejects torn expiry, snapshot or grant coordinates", () => refuses(() => parseToolResultServingMaterial({ ...material, ...change })));

const available = { state: "available", threadId: "thread", toolCallId: "call", content: "", truncated: false, byteCount: 0, error: false, capturedAt: 1000 };
for (const content of ["", "0", "false", "null"]) check(`falsy content ${JSON.stringify(content)} remains a result`, () => {
  const result = parseToolResultAnswer({ ...available, content, byteCount: new TextEncoder().encode(content).length });
  assert.equal(result.state, "available");
  if (result.state === "available") assert.equal(result.content, content);
});
check("UTF-8 content accepts the 64 KiB boundary", () => assert.equal(parseToolResultAnswer({ ...available, content: "😀".repeat(16384), byteCount: 65536 }).state, "available"));
check("UTF-8 byte overflow refuses despite a smaller character count", () => refuses(() => parseToolResultAnswer({ ...available, content: "😀".repeat(16385), byteCount: 65536 })));
check("incorrect byte count refuses", () => refuses(() => parseToolResultAnswer({ ...available, content: "x" })));
check("pending names only the requested pair", () => assert.deepEqual(parseToolResultAnswer({ state: "pending", threadId: "thread", toolCallId: "call" }), { state: "pending", threadId: "thread", toolCallId: "call" }));
for (const state of ["not-shared", "missing", "expired"]) {
  check(`${state} is a closed status-only result`, () => assert.deepEqual(parseToolResultAnswer({ state }), { state }));
  for (const field of ["content", "threadId", "arguments"]) check(`${state} cannot carry ${field}`, () => refuses(() => parseToolResultAnswer({ state, [field]: "hidden" })));
}
check("available cannot carry tool arguments", () => refuses(() => parseToolResultAnswer({ ...available, arguments: {} })));
for (const state of ["known", "refused", "unknown"]) check(`revocation preserves ${state} without converting it to success`, () => assert.deepEqual(parseToolResultRevocationOutcome({ state, consentId: consent.id }), { state, consentId: consent.id }));
check("unknown revocation cannot carry an automatic retry", () => refuses(() => parseToolResultRevocationOutcome({ state: "unknown", consentId: consent.id, retry: true })));

const schemas = [TOOL_RESULT_CONSENT_SCHEMA, TOOL_RESULT_REVOCATION_SCHEMA, TOOL_RESULT_SERVING_MATERIAL_SCHEMA,
  ...Object.values(TOOL_RESULT_ANSWER_SCHEMAS), ...Object.values(TOOL_RESULT_REVOKE_ANSWER_SCHEMAS),
  ...TOOL_RESULTS_COMMANDS.flatMap(row => [row.input, row.output])];
function frozen(value: unknown): boolean {
  return value === null || typeof value !== "object" || (Object.isFrozen(value) && Object.values(value).every(frozen));
}
for (const [i, schema] of schemas.entries()) check(`declaration ${i} is deeply frozen and compiles through the real profile`, () => {
  assert.ok(frozen(schema));
  assert.equal(typeof compileContractSchema({ root: schema }), "function");
});
for (const [i, row] of TOOL_RESULTS_COMMANDS.entries()) check(`command ${row.name} has valid closed input and output`, () => {
  const inputs = [{ threadId: "thread", toolCallId: "call" }, { consent }, { consentId: consent.id }];
  const outputs = [available, { state: "active", consentId: consent.id }, { state: "known", consentId: consent.id }];
  const input = compileContractSchema({ root: row.input });
  const output = compileContractSchema({ root: row.output });
  assert.ok(input(inputs[i]));
  assert.ok(output(outputs[i]));
  assert.equal(input({ ...inputs[i], unexpected: true }), false);
  assert.equal(output({ ...outputs[i], unexpected: true }), false);
});
check("cluster declares exactly three handle-only ephemeral commands without registration", () => {
  const cluster = parseClusterDocument(TOOL_RESULTS_CLUSTER);
  assert.equal(TOOL_RESULTS_ENDPOINT, "tool-results");
  assert.deepEqual(cluster.commands.map(c => c.name), ["tool-result", "tool-result-consent", "tool-result-revoke"]);
  for (const [i, c] of cluster.commands.entries()) {
    assert.deepEqual(c.modes, ["handle"]);
    assert.equal(c.class, "ephemeral");
    assert.equal(c.targeted, true);
    assert.equal(c.inputDigest, singleDocumentClosure(TOOL_RESULTS_COMMANDS[i].input).closureDigest);
    assert.equal(c.outputDigest, singleDocumentClosure(TOOL_RESULTS_COMMANDS[i].output).closureDigest);
  }
  assert.ok(frozen(TOOL_RESULTS_CLUSTER));
});
check("journal limits remain declarations, not a running capture service", () => {
  assert.equal(TOOL_RESULT_MAX_CONTENT_BYTES, 65536);
  assert.equal(TOOL_RESULT_MAX_ENTRIES, 256);
  assert.equal(TOOL_RESULT_MAX_RETENTION_MS, 3600000);
});

const anchor: SignerAnchor = { keyId: "consent_key", publicKey: user, owner: `${owner}.web`, roles: ["consents"], scope: { consents: ["tool-results"] }, validFrom: 0, validTo: 10000 };
await asyncCheck("consents role resolves only the accepted endpoint scope", async () => {
  assert.ok(ANCHOR_ROLES.includes("consents"));
  assert.equal((await resolveToolResultConsentAnchor(() => anchor, anchor.keyId, 1000)).keyId, anchor.keyId);
});
for (const [name, value] of [["unknown", undefined], ["revoked", { ...anchor, revoked: true }], ["wrong role", { ...anchor, roles: ["sessions"] }], ["no scope", { ...anchor, scope: {} }], ["foreign scope", { ...anchor, scope: { consents: ["manager"] } }], ["closed window", { ...anchor, validTo: 999 }]] as const)
  await asyncCheck(`consent anchor rejects ${name}`, async () => {
    await assert.rejects(resolveToolResultConsentAnchor(() => value as SignerAnchor | undefined, anchor.keyId, 1000), e => e instanceof EpEnvelopeError && e.code === "permission-denied");
  });
console.log(`private-tool-results contract smoke: ${passed} passed, 0 failed; no broker, signing, issuance, registration or serving`);

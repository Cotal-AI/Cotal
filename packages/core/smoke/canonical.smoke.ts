/** RFC 8785 conformance vectors + content-addressing proofs for canonical.ts (SPEC §13.7, D28). */
import { readdirSync, readFileSync } from "node:fs";
import { canonicalJson, contractDigest, isContractDigest, verifyArtifact, verifyRawBytes } from "../src/canonical.js";
import { parseClusterDocument, verifyClusterManifest, verifyClusterRoot } from "../src/endpoint-cluster.js";
import { epfQuarantineSubject, parseDecisionFact, parseEffectFact, parseQuarantineFact } from "../src/endpoint-journal.js";
import { parseReceipt } from "../src/endpoint-receipt.js";
import { parseServiceSpec } from "../src/endpoint-service.js";
import { mintLifecycleUid } from "../src/endpoint-subjects.js";
import { parseRemoteManagerEnvelope } from "../src/remote-manager-authority.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const throws = (name: string, fn: () => unknown, needle: string) => {
  try {
    fn();
  } catch (e) {
    ok(name, String((e as Error).message).includes(needle), (e as Error).message);
    return;
  }
  throw new Error(`FAIL: ${name} — expected a loud throw`);
};

// 1) RFC 8785 ES6 number serialization vectors (the hard part of the RFC).
const numbers = canonicalJson({ n: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001, 0, -0, 10.0, 1e21] });
ok("RFC 8785 number vectors", numbers === '{"n":[333333333.3333333,1e+30,4.5,0.002,1e-27,0,0,10,1e+21]}', numbers);

// 2) Key ordering is by UTF-16 code units, nested objects recurse, whitespace is stripped.
const sorted = canonicalJson({ b: 2, a: { z: 1, "é": 2, A: 3 }, "10": true, "1": false });
ok("UTF-16 code-unit key sort", sorted === '{"1":false,"10":true,"a":{"A":3,"z":1,"é":2},"b":2}', sorted);

// 3) Literals and escapes: control chars escape lowercase-hex, two-char escapes preferred.
const esc = canonicalJson({ s: "\nA\"\\/" , l: [null, true, false] });
ok("escape + literal forms", esc === '{"l":[null,true,false],"s":"\\u000f\\nA\\"\\\\/"}', esc);

// 4) Well-formed surrogate pairs pass through raw; lone surrogates are REJECTED (I-JSON).
ok("surrogate pair passes", canonicalJson({ s: "\u{1D11E}" }) === '{"s":"𝄞"}');
throws("lone surrogate in value rejected", () => canonicalJson({ s: "\uD800" }), "lone surrogate");
throws("lone surrogate in key rejected", () => canonicalJson({ "\uDEAD": 1 }), "lone surrogate");

// 5) Strict mode: undefined never silently becomes null; non-finite numbers refuse.
throws("undefined in array rejected", () => canonicalJson({ a: [1, undefined, 3] }), "undefined");
throws("NaN rejected", () => canonicalJson({ n: Number.NaN }), "non-finite");

// 5b) Strict PLAIN-DATA graph (D28): state invisible to canonicalization refuses instead of
// being silently projected (symbol/non-enumerable/accessor props, class/exotic instances whose
// toJSON rewrites them, subclassed/holey arrays). Only JSON.parse-shaped data canonicalizes.
throws("symbol-keyed own property rejected", () => { const o: Record<string | symbol, unknown> = { a: 1 }; o[Symbol("s")] = 2; return canonicalJson(o); }, "symbol-keyed");
throws("non-enumerable own property rejected", () => { const o = { a: 1 }; Object.defineProperty(o, "hidden", { value: 2, enumerable: false }); return canonicalJson(o); }, "non-enumerable");
throws("accessor property rejected", () => { const o = { a: 1 }; Object.defineProperty(o, "g", { get: () => 2, enumerable: true }); return canonicalJson(o); }, "accessor");
throws("class instance (Date) rejected", () => canonicalJson({ at: new Date(0) }), "non-plain");
throws("exotic container (Map) rejected", () => canonicalJson({ m: new Map([["x", 1]]) }), "non-plain");
throws("own toJSON function rejected (a function is code, not data)", () => canonicalJson({ toJSON: () => ({}) }), "unsupported function");
throws("subclassed array rejected", () => { class A extends Array {} const a = new A(); a.push(1); return canonicalJson({ a }); }, "non-ordinary array");
throws("array hole rejected (would coerce to null)", () => { const a = [1]; a.length = 3; return canonicalJson({ a }); }, "hole");
throws("non-index own property on array rejected", () => { const a = [1] as number[] & { x?: number }; a.x = 2; return canonicalJson({ a }); }, "non-index");
ok("null-prototype plain object canonicalizes", canonicalJson(Object.assign(Object.create(null), { a: 1 })) === '{"a":1}');
ok("JSON.parse-shaped data canonicalizes unchanged", canonicalJson(JSON.parse('{"b":[1,2],"a":"x"}')) === '{"a":"x","b":[1,2]}');
ok("an own __proto__ key canonicalizes as a key", canonicalJson(JSON.parse('{"__proto__":{"a":1}}')) === '{"__proto__":{"a":1}}');

// 5c) One read (#3264): the text and its digest encode the data the check inspected, never a later
// read. Each Proxy reports plain data but answers `get` for one key with something else.
const answering = <T extends object>(target: T, key: string, value: unknown) =>
  new Proxy(target, { get: (t, k, r) => (k === key ? value : Reflect.get(t, k, r)) });
ok("a string read as a lone surrogate is not serialized", canonicalJson(answering({ s: "ok" }, "s", "\uD800")) === '{"s":"ok"}');
ok("a number read as Infinity is not serialized as null", canonicalJson(answering({ n: 1 }, "n", Infinity)) === '{"n":1}');
ok("an array element read as a lone surrogate is not serialized", canonicalJson({ a: answering(["ok"], "0", "\uDC00") }) === '{"a":["ok"]}');
ok("a Proxy answering toJSON serializes its own data", canonicalJson(answering({ a: 1 }, "toJSON", () => ({ b: 1, a: 2 }))) === '{"a":1}');
ok("a digest covers the data the check inspected", contractDigest(answering({ s: "ok" }, "s", "\uD800")) === contractDigest({ s: "ok" }));
// An array's length is read once, from its descriptor. Each Proxy below answers `get("length")`
// differently once the copy has read element 0, or reports a length its target does not have.
const grows = () => {
  let copying = false;
  return new Proxy(["ok", "extra"], {
    ownKeys: () => ["0", "length"],
    getOwnPropertyDescriptor: (t, k) => {
      if (k === "0") copying = true;
      return k === "length" ? { value: 1, writable: true, enumerable: false, configurable: false } : Reflect.getOwnPropertyDescriptor(t, k);
    },
    get: (t, k, r) => (k === "length" ? (copying ? 2 : 1) : Reflect.get(t, k, r)),
  });
};
const shrinks = () => {
  let copying = false;
  return new Proxy(["ok", "kept"], {
    getOwnPropertyDescriptor: (t, k) => {
      if (k === "0") copying = true;
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    get: (t, k, r) => (k === "length" ? (copying ? 1 : 2) : Reflect.get(t, k, r)),
  });
};
const reportsLength = (target: unknown[], value: unknown) =>
  new Proxy(target, {
    getOwnPropertyDescriptor: (t, k) => (k === "length" ? { value, writable: true, enumerable: false, configurable: false } : Reflect.getOwnPropertyDescriptor(t, k)),
  });
ok("an array length read again does not add an element", canonicalJson({ a: grows() }) === '{"a":["ok"]}');
ok("an array length read again does not drop a checked element", canonicalJson({ a: shrinks() }) === '{"a":["ok","kept"]}');
throws("an index past the reported array length is refused", () => canonicalJson({ a: reportsLength(["ok", "kept"], 1) }), 'non-index own property "1"');
throws("a NaN array length is refused", () => canonicalJson({ a: reportsLength(["ok"], Number.NaN) }), "invalid array length");

// 6) Digest identity: shape, stability, and independence from key insertion order.
const d1 = contractDigest({ x: 1, y: [true, "z"] });
const d2 = contractDigest({ y: [true, "z"], x: 1 });
ok("digest has sha256:<hex> form", isContractDigest(d1), d1);
ok("digest independent of key order", d1 === d2);
ok("digest changes with content", contractDigest({ x: 2, y: [true, "z"] }) !== d1);

// 7) verify-on-read: matching bytes parse; tampered bytes and wrong digests refuse loudly.
const artifact = { urn: "ai.cotal.lifecycle", revision: 1 };
const bytes = new TextEncoder().encode(JSON.stringify(artifact));
ok("verifyArtifact accepts true bytes", JSON.stringify(verifyArtifact(bytes, contractDigest(artifact))) === JSON.stringify(artifact));
throws("verifyArtifact rejects tampered bytes", () => verifyArtifact(new TextEncoder().encode('{"urn":"ai.cotal.lifecycle","revision":2}'), contractDigest(artifact)), "digest mismatch");
throws("verifyArtifact rejects malformed digest", () => verifyArtifact(bytes, "sha256:nope"), "malformed digest");
throws("verifyArtifact rejects non-JSON bytes", () => verifyArtifact(new TextEncoder().encode("{"), contractDigest(artifact)), "not valid");

// 8) Digest predicate (#3396): isContractDigest guards typeof === "string" and the cluster,
// service, journal, receipt, and remote-manager-authority readers share that one predicate.
const bareHex = d1.slice(7);
const upperHex = `sha256:${bareHex.toUpperCase()}`;
const arrayDigest: unknown = [d1];
const stringCoercibleDigest: unknown = { toString: () => d1 };
ok("isContractDigest refuses bare hex", !isContractDigest(bareHex));
ok("isContractDigest refuses upper-case hex", !isContractDigest(upperHex));
ok("isContractDigest refuses a one-element array holding a valid digest", !isContractDigest(arrayDigest));
ok("isContractDigest refuses a string-coercible object", !isContractDigest(stringCoercibleDigest));
ok("isContractDigest refuses null and undefined", !isContractDigest(null) && !isContractDigest(undefined));

const validManifest = { v: 1 as const, root: d1, members: [] as string[] };
const validManifestDigest = contractDigest(validManifest);
const validClusterDoc = {
  urn: "ai.cotal.probe",
  revision: 1,
  attributes: [],
  commands: [{ name: "ping", class: "ephemeral", targeted: false, capability: "ping", inputDigest: d1, outputDigest: d1 }],
  events: [],
};
const validClusterRootDigest = contractDigest(validClusterDoc);
const uid = mintLifecycleUid();
const receiptRef = { requestId: "r".repeat(22), sourceSeq: 1, endpoint: "ep", caller: { owner: "o", actor: "a", uid } };
const makeReceipt = (over: Record<string, unknown> = {}) => ({
  v: 1,
  requestId: receiptRef.requestId,
  sourceSeq: 1,
  space: "p3396",
  endpoint: "ep",
  command: "c",
  instance: { id: "i", instanceId: uid, epoch: 0 },
  caller: { id: "o.a", lifecycleUid: uid },
  schemaDigests: { input: d1, output: d1 },
  argsDigest: d1,
  outcome: { ok: true },
  ts: 0,
  signer: { keyId: "k" },
  sig: "s",
  ...over,
});
const decSubject = `cotal.p3396.epf.ep.dec.o.a.${uid}.req-1`;
const effSubject = `cotal.p3396.epf.ep.eff.o.a.${uid}.req-1`;
const quarSubject = epfQuarantineSubject("p3396", "ep", 1);

ok("verifyClusterManifest accepts valid root and closure digests", verifyClusterManifest(validManifestDigest, validManifest).root === d1);
ok("verifyClusterRoot accepts valid root and command digests", verifyClusterRoot(validClusterRootDigest, validClusterDoc).urn === "ai.cotal.probe");
ok("parseServiceSpec accepts valid clusterDigests", parseServiceSpec({ endpoint: "ep", owner: "o", clusterDigests: [d1], protocol: { v: 1 } }, { endpoint: "ep" }).clusterDigests[0] === d1);
ok("parseQuarantineFact accepts valid submissionDigest", parseQuarantineFact({ v: 1, decision: "quarantined", sourceSeq: 1, submissionDigest: d1, error: { code: "internal" }, ts: 0 }, quarSubject).submissionDigest === d1);
ok("parseDecisionFact accepts valid fingerprint", parseDecisionFact({ v: 1, id: "req-1", decision: "rejected", fingerprint: d1, caller: { id: "o.a", lifecycleUid: uid }, sourceSeq: 1, ts: 0, error: { code: "bad-request" } }, decSubject).fingerprint === d1);
ok("parseEffectFact accepts valid fingerprint", parseEffectFact({ v: 1, id: "req-1", outcome: "ran", fingerprint: d1, caller: { id: "o.a", lifecycleUid: uid }, sourceSeq: 1, ts: 0 }, effSubject).fingerprint === d1);
throws("parseRemoteManagerEnvelope accepts valid registrationProof and reaches identities check", () => parseRemoteManagerEnvelope({ v: 1, kind: "probe-kind", space: "p3396", actor: "actor3396", instanceId: uid, managerLifecycleUid: uid, requestId: "a".repeat(30), registrationProof: d1 }, "probe-kind", "probe envelope"), "requires identities");
ok("parseReceipt accepts valid digests", parseReceipt(makeReceipt({ resultDigest: d1 }), receiptRef, "p3396").argsDigest === d1);

for (const [label, bad] of [["bare-hex", bareHex], ["upper-hex", upperHex], ["array-of-digest", arrayDigest]] as const) {
  throws(`verifyArtifact refuses ${label}`, () => verifyArtifact(bytes, bad as string), "malformed digest");
  throws(`verifyRawBytes refuses ${label}`, () => verifyRawBytes(bytes, bad as string), "malformed digest");
  throws(`verifyClusterManifest closure digest refuses ${label}`, () => verifyClusterManifest(bad as string, validManifest), "is not a sha256 closure digest");
  throws(`verifyClusterRoot refuses ${label}`, () => verifyClusterRoot(bad as string, validClusterDoc), "is not a sha256 artifact digest");
  throws(`parseClusterDocument inputDigest refuses ${label}`, () => parseClusterDocument({ ...validClusterDoc, commands: [{ ...validClusterDoc.commands[0], inputDigest: bad }] }), "inputDigest is not a sha256 closure digest");
  throws(`parseClusterDocument outputDigest refuses ${label}`, () => parseClusterDocument({ ...validClusterDoc, commands: [{ ...validClusterDoc.commands[0], outputDigest: bad }] }), "outputDigest is not a sha256 closure digest");
  throws(`parseServiceSpec refuses ${label}`, () => parseServiceSpec({ endpoint: "ep", owner: "o", clusterDigests: [bad], protocol: { v: 1 } }, { endpoint: "ep" }), "clusterDigests must be a non-empty array of sha256 digests");
  throws(`parseQuarantineFact refuses ${label}`, () => parseQuarantineFact({ v: 1, decision: "quarantined", sourceSeq: 1, submissionDigest: bad, error: { code: "internal" }, ts: 0 }, quarSubject), "submissionDigest");
  throws(`parseDecisionFact refuses ${label}`, () => parseDecisionFact({ v: 1, id: "req-1", decision: "rejected", fingerprint: bad, caller: { id: "o.a", lifecycleUid: uid }, sourceSeq: 1, ts: 0, error: { code: "bad-request" } }, decSubject), "fingerprint");
  throws(`parseEffectFact refuses ${label}`, () => parseEffectFact({ v: 1, id: "req-1", outcome: "ran", fingerprint: bad, caller: { id: "o.a", lifecycleUid: uid }, sourceSeq: 1, ts: 0 }, effSubject), "effect.fingerprint");
  throws(`parseRemoteManagerEnvelope refuses ${label}`, () => parseRemoteManagerEnvelope({ v: 1, kind: "probe-kind", space: "p3396", actor: "actor3396", instanceId: uid, managerLifecycleUid: uid, requestId: "a".repeat(30), registrationProof: bad }, "probe-kind", "probe envelope"), "requires a sha256 registrationProof");
  throws(`parseReceipt argsDigest refuses ${label}`, () => parseReceipt(makeReceipt({ argsDigest: bad }), receiptRef, "p3396"), "argsDigest is not a sha256 digest");
  throws(`parseReceipt schemaDigests.input refuses ${label}`, () => parseReceipt(makeReceipt({ schemaDigests: { input: bad, output: d1 } }), receiptRef, "p3396"), "schemaDigests are not sha256 digests");
  throws(`parseReceipt schemaDigests.output refuses ${label}`, () => parseReceipt(makeReceipt({ schemaDigests: { input: d1, output: bad } }), receiptRef, "p3396"), "schemaDigests are not sha256 digests");
  throws(`parseReceipt resultDigest refuses ${label}`, () => parseReceipt(makeReceipt({ resultDigest: bad }), receiptRef, "p3396"), "resultDigest is not a sha256 digest");
}

const srcDir = new URL("../src/", import.meta.url);
const digestGrammarFiles = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .filter((f) => /sha256:\[0-9a-f\]\{64\}/.test(readFileSync(new URL(f, srcDir), "utf8")));
ok("core source declares the sha256:[0-9a-f]{64} grammar only in canonical-json.ts plus the store-ref and schema-pattern sites",
  JSON.stringify(digestGrammarFiles) === JSON.stringify(["canonical-json.ts", "endpoint-invoke.ts", "endpoint-serve.ts", "schema-profile.ts"]),
  digestGrammarFiles);

console.log(`canonical.smoke: ${pass} checks passed`);

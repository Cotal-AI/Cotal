/** RFC 8785 conformance vectors + content-addressing proofs for canonical.ts (SPEC §13.7, D28). */
import { canonicalJson, contractDigest, isContractDigest, verifyArtifact } from "../src/canonical.js";

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

console.log(`canonical.smoke: ${pass} checks passed`);

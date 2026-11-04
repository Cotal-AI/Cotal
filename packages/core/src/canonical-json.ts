/** The node-free half of `canonical.ts`: digest grammar and RFC 8785 canonical JSON. */
import { canonicalizeEx } from "json-canonicalize";

/** Digest identity form used everywhere a contract artifact is referenced: `sha256:<hex>`. */
export const DIGEST_PREFIX = "sha256:" as const;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** True iff `v` is a string holding a well-formed `sha256:<hex>` artifact digest. */
export function isContractDigest(v: unknown): v is string {
  return typeof v === "string" && DIGEST_RE.test(v);
}

/** True iff the string is well-formed UTF-16 (no unpaired surrogate). A lone surrogate has NO
 *  UTF-8 byte encoding — encoders silently substitute U+FFFD, so two distinct malformed strings
 *  can collapse to one byte sequence; anything digest- or wire-bound must refuse them. */
export function isWellFormedUnicode(s: string): boolean {
  return !hasLoneSurrogate(s);
}

/** True iff the string contains an unpaired UTF-16 surrogate (not well-formed / I-JSON
 *  violation). Manual scan: the repo's TS lib target predates `String#isWellFormed`. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++; // well-formed pair; skip the low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // low surrogate with no preceding high half
    }
  }
  return false;
}

/** Walk a JSON value once and return a plain copy of what the walk read, throwing on anything
 *  that cannot canonicalize EXACTLY (D28: verification and digesting must never run over a
 *  normalizing projection):
 *   - strings that are not well-formed UTF-16 (a lone surrogate violates I-JSON; canonicalizing
 *     it would mint a digest for text that cannot interchange), in values AND keys;
 *   - `undefined` anywhere and non-finite numbers (RFC 8785 cannot represent them);
 *   - NON-PLAIN-DATA graphs. `Object.entries` sees only enumerable string-keyed own data props,
 *     and the canonicalizer applies `toJSON`, so a symbol-keyed or non-enumerable own property,
 *     an accessor, or a class/exotic instance (Date → ISO string, Map → `{}`) would be SILENTLY
 *     projected away or rewritten — the exact field-dropping class D28 forbids (an artifact
 *     carrying state its signature never covered must refuse, not launder through the
 *     projection). Objects must be ordinary with a `null`/`Object.prototype` prototype and only
 *     enumerable string-keyed own DATA properties; arrays must be ordinary `Array.prototype`
 *     arrays with no holes and no extra own properties.
 *  The serializer gets the copy, never the input, and each copied value is the one in the
 *  descriptor the check inspected: a Proxy can answer a second read, or `toJSON`, differently,
 *  and the text must encode only data that was checked. */
function interchangeableCopy(v: unknown, path: string): unknown {
  if (v === null) return null;
  switch (typeof v) {
    case "string":
      if (hasLoneSurrogate(v)) throw new Error(`canonicalJson: lone surrogate in string at ${path} (I-JSON violation)`);
      return v;
    case "number":
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${path}`);
      return v;
    case "boolean":
      return v;
    case "undefined":
      throw new Error(`canonicalJson: undefined at ${path} (strict mode never coerces to null)`);
    case "object": {
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype)
          throw new Error(`canonicalJson: non-ordinary array at ${path} (a subclassed/exotic array canonicalizes through projections)`);
        // One read of `length`, from its descriptor, bounds both the index check and the copy. A
        // second read could add an element no index check covered or drop one the check accepted.
        const length: unknown = Object.getOwnPropertyDescriptor(v, "length")?.value;
        if (typeof length !== "number" || !Number.isInteger(length) || length < 0)
          throw new Error(`canonicalJson: invalid array length at ${path} (refusing the projection)`);
        for (const k of Reflect.ownKeys(v)) {
          if (typeof k !== "string")
            throw new Error(`canonicalJson: symbol-keyed own property on array at ${path} (invisible to canonicalization; refusing the projection)`);
          if (k === "length") continue;
          if (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= length)
            throw new Error(`canonicalJson: non-index own property "${k}" on array at ${path} (invisible to canonicalization; refusing the projection)`);
        }
        const copy: unknown[] = [];
        for (let i = 0; i < length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, i);
          if (d === undefined)
            throw new Error(`canonicalJson: hole at ${path}[${i}] (a hole would be coerced to null; refusing the projection)`);
          if (!d.enumerable || d.get !== undefined || d.set !== undefined)
            throw new Error(`canonicalJson: non-enumerable or accessor element at ${path}[${i}] (refusing the projection)`);
          copy.push(interchangeableCopy(d.value, `${path}[${i}]`));
        }
        return copy;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null)
        throw new Error(`canonicalJson: non-plain object at ${path} (a class/exotic instance canonicalizes through projections like toJSON; only plain data objects are interchangeable)`);
      // A null prototype keeps an own `__proto__` key a key instead of a prototype assignment.
      const copy: Record<string, unknown> = Object.create(null);
      for (const k of Reflect.ownKeys(v)) {
        if (typeof k !== "string")
          throw new Error(`canonicalJson: symbol-keyed own property at ${path} (invisible to canonicalization; refusing the projection)`);
        if (hasLoneSurrogate(k)) throw new Error(`canonicalJson: lone surrogate in key at ${path}.${k}`);
        const d = Object.getOwnPropertyDescriptor(v, k)!;
        if (!d.enumerable)
          throw new Error(`canonicalJson: non-enumerable own property "${k}" at ${path} (invisible to canonicalization; refusing the projection)`);
        if (d.get !== undefined || d.set !== undefined)
          throw new Error(`canonicalJson: accessor property "${k}" at ${path} (a getter is code, not data; refusing the projection)`);
        copy[k] = interchangeableCopy(d.value, `${path}.${k}`);
      }
      return copy;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

/** RFC 8785 canonical JSON text of a value (strict: I-JSON enforced, no undefined→null). */
export function canonicalJson(value: unknown): string {
  return canonicalizeEx(interchangeableCopy(value, "$"), { undefinedInArrayToNull: false });
}

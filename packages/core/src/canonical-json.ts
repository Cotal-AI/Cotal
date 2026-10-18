/** The node-free half of `canonical.ts`: digest grammar and RFC 8785 canonical JSON. */
import { canonicalizeEx } from "json-canonicalize";

export const DIGEST_PREFIX = "sha256:" as const;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** True iff `s` is a well-formed `sha256:<hex>` artifact digest. */
export function isContractDigest(s: string): boolean {
  return DIGEST_RE.test(s);
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

/** Walk a JSON value and throw on anything that cannot canonicalize EXACTLY (D28: verification
 *  and digesting must never run over a normalizing projection):
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
 *     arrays with no holes and no extra own properties. */
function assertInterchangeable(v: unknown, path: string): void {
  if (v === null) return;
  switch (typeof v) {
    case "string":
      if (hasLoneSurrogate(v)) throw new Error(`canonicalJson: lone surrogate in string at ${path} (I-JSON violation)`);
      return;
    case "number":
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${path}`);
      return;
    case "boolean":
      return;
    case "undefined":
      throw new Error(`canonicalJson: undefined at ${path} (strict mode never coerces to null)`);
    case "object": {
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype)
          throw new Error(`canonicalJson: non-ordinary array at ${path} (a subclassed/exotic array canonicalizes through projections)`);
        for (const k of Reflect.ownKeys(v)) {
          if (typeof k !== "string")
            throw new Error(`canonicalJson: symbol-keyed own property on array at ${path} (invisible to canonicalization; refusing the projection)`);
          if (k === "length") continue;
          if (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length)
            throw new Error(`canonicalJson: non-index own property "${k}" on array at ${path} (invisible to canonicalization; refusing the projection)`);
        }
        for (let i = 0; i < v.length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, i);
          if (d === undefined)
            throw new Error(`canonicalJson: hole at ${path}[${i}] (a hole would be coerced to null; refusing the projection)`);
          if (!d.enumerable || d.get !== undefined || d.set !== undefined)
            throw new Error(`canonicalJson: non-enumerable or accessor element at ${path}[${i}] (refusing the projection)`);
          assertInterchangeable(v[i], `${path}[${i}]`);
        }
        return;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null)
        throw new Error(`canonicalJson: non-plain object at ${path} (a class/exotic instance canonicalizes through projections like toJSON; only plain data objects are interchangeable)`);
      for (const k of Reflect.ownKeys(v)) {
        if (typeof k !== "string")
          throw new Error(`canonicalJson: symbol-keyed own property at ${path} (invisible to canonicalization; refusing the projection)`);
        if (hasLoneSurrogate(k)) throw new Error(`canonicalJson: lone surrogate in key at ${path}.${k}`);
        const d = Object.getOwnPropertyDescriptor(v, k)!;
        if (!d.enumerable)
          throw new Error(`canonicalJson: non-enumerable own property "${k}" at ${path} (invisible to canonicalization; refusing the projection)`);
        if (d.get !== undefined || d.set !== undefined)
          throw new Error(`canonicalJson: accessor property "${k}" at ${path} (a getter is code, not data; refusing the projection)`);
        assertInterchangeable((v as Record<string, unknown>)[k], `${path}.${k}`);
      }
      return;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

/** RFC 8785 canonical JSON text of a value (strict: I-JSON enforced, no undefined→null). */
export function canonicalJson(value: unknown): string {
  assertInterchangeable(value, "$");
  return canonicalizeEx(value, { undefinedInArrayToNull: false });
}

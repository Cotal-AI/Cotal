/**
 * The `artifact` reference part's contract: the object-store digest boundary, opaque-bytes
 * verify-on-read, and the part guard. Broker-free; part of `smoke:ci`.
 *
 * WHAT THIS SUITE IS FOR, in one line: the object-store digest is not the encoding anybody
 * assumes, and getting it wrong fails on CONTENT rather than on a branch.
 *
 * The store reports `SHA-256=` followed by the base64url alphabet WITH `=` padding — measured on
 * nats-server 2.14.4 / `@nats-io/obj` 3.4.0, where `-` and `_` appear and `+` and `/` never do.
 * That is neither of the two forms `createHash(...).digest()` produces. So the obvious
 * implementation — hash, encode, compare strings — is wrong for roughly three quarters of real
 * digests while passing whatever example its author happened to try. The cells below pin the
 * measurement (1490/2000 and 2000/2000 failures for the two re-encoding strategies) so a future
 * "simplification" back to re-encoding reddens here instead of in production.
 *
 * NOT covered here, deliberately: that a message carrying an `artifact` part survives the Plane-3
 * delivery frame. That predicate is private and only reachable through a real JetStream consumer,
 * so re-implementing it here would be a test of a copy. It is proved end-to-end against the real
 * validator in `smoke:plane3:auth`.
 *
 * Run: pnpm smoke:artifact-contract
 */
import { createHash, randomBytes } from "node:crypto";
import { fromObjectStoreDigest, isArtifactPart, ARTIFACT_PART_KIND } from "../src/artifact.js";
import { rawDigest, verifyRawBytes } from "../src/canonical.js";
import { partsToText } from "../src/parts.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; } else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
const throws = (name: string, fn: () => unknown, needle: string) => {
  try { fn(); check(name, false, "did not throw"); }
  catch (e) { check(name, (e as Error).message.includes(needle), `message was: ${(e as Error).message}`); }
};

/** The store's spelling: base64url alphabet, padding kept. */
const osForm = (bytes: Uint8Array): string =>
  "SHA-256=" + createHash("sha256").update(bytes).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");

// ---- the digest boundary ----------------------------------------------------------------

{
  const bytes = randomBytes(64);
  const hex = createHash("sha256").update(bytes).digest("hex");
  check("converts the store's form to sha256:<hex>", fromObjectStoreDigest(osForm(bytes)) === `sha256:${hex}`);
  check("agrees with rawDigest over the same bytes", fromObjectStoreDigest(osForm(bytes)) === rawDigest(bytes));
}

{
  // THE MEASUREMENT. Re-encoding is the natural implementation and it is wrong; these two counts
  // are why the code decodes. A drift back to re-encoding cannot pass both cells.
  let reB64Fail = 0, reB64UrlFail = 0, decodeOk = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const b = randomBytes(32);
    const stored = osForm(b);
    const h = createHash("sha256").update(b);
    if (stored !== "SHA-256=" + h.copy().digest("base64")) reB64Fail++;
    if (stored !== "SHA-256=" + h.copy().digest("base64url")) reB64UrlFail++;
    if (fromObjectStoreDigest(stored) === `sha256:${h.digest("hex")}`) decodeOk++;
  }
  // BE HONEST ABOUT WHAT THESE TWO CELLS ARE. They measure Node and the store's spelling, not this
  // repo's code: no mutation of `fromObjectStoreDigest` can redden them. They are a recorded
  // measurement kept executable so it cannot rot, and the reason the third cell exists. Only the
  // third one guards the implementation.
  //
  // Not an exact 1490: the `+`/`/` collision rate is random per run. The point is that it is a
  // LARGE fraction, not a rare edge — a re-encoding comparison is broken for most artifacts, not
  // for an exotic few. Empirically ~74%; the bound is deliberately loose and still decisive.
  check("re-encoding to base64 mismatches the stored form for most digests", reB64Fail > N * 0.5, `${reB64Fail}/${N}`);
  check("re-encoding to base64url mismatches EVERY stored digest (padding)", reB64UrlFail === N, `${reB64UrlFail}/${N}`);
  check("decoding to hex is correct for every digest", decodeOk === N, `${decodeOk}/${N}`);
}

{
  const b = randomBytes(32);
  const hex = createHash("sha256").update(b).digest("hex");
  const padded = osForm(b);
  const unpadded = padded.replace(/=+$/, "");
  const standard = "SHA-256=" + createHash("sha256").update(b).digest("base64");
  check("accepts the unpadded spelling", fromObjectStoreDigest(unpadded) === `sha256:${hex}`);
  check("accepts the standard-alphabet spelling (same bytes, not a fallback)", fromObjectStoreDigest(standard) === `sha256:${hex}`);
}

throws("refuses a digest with no SHA-256= prefix", () => fromObjectStoreDigest("MD5=abc"), "prefixed digest");
throws("refuses an empty body", () => fromObjectStoreDigest("SHA-256="), "not 32 bytes");
throws("refuses a short body", () => fromObjectStoreDigest("SHA-256=abc"), "not 32 bytes");
throws("refuses a non-string", () => fromObjectStoreDigest(undefined as unknown as string), "prefixed digest");
// The alphabet check is what makes the 32-byte assertion mean something: Node's base64 decoder
// SKIPS characters it does not recognize, so a body of punctuation decodes to a short buffer and a
// long enough one could decode to a plausible 32 bytes. Validate the shape, then decode.
throws("refuses a body of the right length with an illegal alphabet", () => fromObjectStoreDigest("SHA-256=" + "!".repeat(43) + "="), "not 32 bytes of base64");
throws("refuses a body one character too long", () => fromObjectStoreDigest("SHA-256=" + "A".repeat(44) + "="), "not 32 bytes of base64");

// ---- verify-on-read over opaque bytes ---------------------------------------------------

{
  const bytes = new TextEncoder().encode("héllo wörld ☃");            // multi-byte UTF-8
  check("verifies matching bytes and returns them", verifyRawBytes(bytes, rawDigest(bytes)) === bytes);

  const empty = new Uint8Array(0);
  check("verifies the 0-byte artifact", verifyRawBytes(empty, rawDigest(empty)) === empty);
  check("the 0-byte digest is the SHA-256 of nothing", rawDigest(empty) ===
    `sha256:${createHash("sha256").update(new Uint8Array(0)).digest("hex")}`);

  // A subarray is a VIEW: byteOffset non-zero, backed by a larger buffer. If the digest ran over
  // the backing buffer instead of the view, a chunk carved out of a read buffer would hash to the
  // wrong value — the exact shape a chunked fetch produces.
  const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const view = backing.subarray(2, 5);
  check("a view has a non-zero byteOffset (the precondition this cell tests)", view.byteOffset === 2 && view.length === 3);
  check("digests the VIEW, not its backing buffer", rawDigest(view) === rawDigest(Uint8Array.from([3, 4, 5])));
  check("a view does not digest as its whole buffer", rawDigest(view) !== rawDigest(backing));

  // Truncation is the class digest-verify-on-read exists to catch: a store handing back a short
  // object is otherwise indistinguishable from a small one.
  const full = randomBytes(4096);
  throws("refuses truncated bytes", () => verifyRawBytes(full.subarray(0, 4095), rawDigest(full)), "digest mismatch");
  throws("names the byte count in the mismatch", () => verifyRawBytes(full.subarray(0, 10), rawDigest(full)), "over 10 bytes");
  throws("refuses a malformed digest before hashing", () => verifyRawBytes(full, "sha256:nothex"), "malformed digest");
  throws("refuses a bare hex digest with no prefix", () => verifyRawBytes(full, "a".repeat(64)), "malformed digest");
}

// ---- the part guard ---------------------------------------------------------------------

const good = { kind: ARTIFACT_PART_KIND, name: "r.html", mediaType: "text/html", digest: `sha256:${"a".repeat(64)}`, size: 12 };
check("accepts a well-formed artifact part", isArtifactPart(good));
check("rejects a non-object", !isArtifactPart(null) && !isArtifactPart("artifact"));
check("rejects a different kind", !isArtifactPart({ ...good, kind: "text" }));
check("rejects a malformed digest", !isArtifactPart({ ...good, digest: "sha256:zz" }));
check("rejects an uppercase-hex digest (canonical form is lowercase)", !isArtifactPart({ ...good, digest: `sha256:${"A".repeat(64)}` }));
check("rejects a missing digest", !isArtifactPart({ ...good, digest: undefined }));
check("rejects an empty name", !isArtifactPart({ ...good, name: "" }));
check("rejects an empty mediaType", !isArtifactPart({ ...good, mediaType: "" }));
// "a number" is not a size: each of these is a number and none is a byte count.
check("rejects a negative size", !isArtifactPart({ ...good, size: -1 }));
check("rejects a fractional size", !isArtifactPart({ ...good, size: 1.5 }));
check("rejects NaN as a size", !isArtifactPart({ ...good, size: Number.NaN }));
check("rejects a size past the safe-integer range", !isArtifactPart({ ...good, size: 1e30 }));
check("accepts a 0-byte size", isArtifactPart({ ...good, size: 0 }));

// ---- rendering ---------------------------------------------------------------------------

{
  // Before `partsToText` existed, three surfaces stringified a non-text part's `data` field. An
  // artifact part has none.
  //
  // THE OBVIOUS ASSERTION HERE IS VACUOUS, and a mutation run is what proved it: checking that the
  // output does not contain "undefined" passes even with the artifact arm deleted, because
  // `JSON.stringify(undefined)` returns `undefined` and `Array.prototype.join` renders that as an
  // EMPTY STRING. So the failure mode is not a visible "undefined" — it is the part vanishing
  // without trace, which is worse and which that assertion cannot see. Assert on presence instead.
  const alone = partsToText([good]);
  check("renders an artifact part at all (it does not silently vanish)", alone.length > 0, JSON.stringify(alone));
  const rendered = partsToText([{ kind: "text", text: "see:" }, good]);
  check("the rendering carries the digest (the only actionable handle)", rendered.includes(good.digest), rendered);
  check("the rendering carries the name and size", rendered.includes("r.html") && rendered.includes("12 bytes"), rendered);
}

// ---- NO PART RENDERS AS NOTHING ------------------------------------------------------------
//
// The block above proved the ARTIFACT kind no longer vanishes. It did not prove the general rule,
// and the general rule is the one that will matter for the NEXT kind somebody adds: the else-branch
// produced output for a case it did not handle, so an unknown extension kind rendered as the empty
// string exactly as an artifact once did.
//
// Why this is asserted here rather than left to whoever adds a kind: the previous consolidation was
// produced by a sweep that MATCHED THE EXPRESSION, and it missed two surfaces carrying independent
// copies plus a third that drops non-text parts by FILTERING them, which no grep for
// `JSON.stringify(p.data)` can find. Fixing the shared renderer is the only move that does not
// depend on having found every copy.
{
  const ext = { kind: "some.future-kind", payload: { a: 1 } } as unknown as Parameters<typeof partsToText>[0][number];

  const alone = partsToText([ext]);
  check("an UNKNOWN extension kind does not render as nothing", alone.length > 0, JSON.stringify(alone));
  check("...and the marker NAMES the kind, so a reader knows which renderer is missing",
    alone.includes("some.future-kind"), alone);

  // The mixed case is what made this dangerous rather than merely wrong: the message renders, looks
  // fine, and is missing a part, with only a stray separator to show for it.
  const mixed = partsToText([{ kind: "text", text: "see:" }, ext]);
  check("in a MIXED message the unknown part survives beside the text",
    mixed.includes("see:") && mixed.includes("some.future-kind"), mixed);

  // A `data` part carrying no `data` hits the identical vanishing act, and it is a CORE kind — so
  // it is covered here rather than discovered later as the second instance of a fixed bug.
  const emptyData = partsToText([{ kind: "data", data: undefined }]);
  check("a `data` part with NO data does not render as nothing", emptyData.length > 0, JSON.stringify(emptyData));
  check("...and it is DISTINGUISHABLE from an unrenderable kind",
    emptyData !== alone && !emptyData.includes("no renderer"), emptyData);

  // CONTROLS, and they are the inverse predicate: the kinds this function DOES render must be
  // unchanged. Without them every assertion above is satisfied by a renderer that emits a marker
  // for everything, which would be a worse regression than the one being fixed.
  check("CONTROL: a text part still renders exactly its text",
    partsToText([{ kind: "text", text: "hello" }]) === "hello");
  check("CONTROL: a data part still renders its JSON",
    partsToText([{ kind: "data", data: { x: 1 } }]) === '{"x":1}');
  check("CONTROL: an artifact part still renders its own shape, not the unknown-kind marker",
    partsToText([good]).startsWith("[artifact ") && !partsToText([good]).includes("no renderer"),
    partsToText([good]));
}

console.log(`\nartifact-contract: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

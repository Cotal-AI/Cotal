/**
 * The trusted delivery reason from the reader's headers to a consented recipient's observation,
 * without a broker (no test runner). The broker-backed copies are delivery-recipient.smoke.ts.
 *
 *  1. PRODUCER: the reader's DLV headers are built fresh from its entry's reason: the frame header and
 *     at most one recognized reason, nothing else. An unrecognized entry reason writes no reason.
 *  2. FORGERY: a DM-stream delivery carrying the frame and a `live-mention` reason is `dm`; its
 *     headers are the sender's and are never read.
 *  3. MISSING OR INVALID: a DLV copy without the frame header, with another frame version, with no
 *     reason, with an empty, unknown, differently cased or repeated reason is `unknown`, and an
 *     unrecognized value is reported, bounded.
 *  4. PATHS: a framed DLV copy with `durable-channel` or `live-mention` reports that reason, also
 *     through the producer's own headers.
 *  5. MIXED: a run of deliveries keeps each one's own category; one `live-mention` labels no other.
 *  6. SOURCE IDS: a redelivered copy keeps its `sourceId` and category; distinct sequences differ.
 *
 * Run: pnpm smoke:delivery-reason
 */
import { headers } from "@nats-io/nats-core";
import { PLANE3_FRAME_HEADER, PLANE3_REASON_HEADER, dlvCopyHeaders } from "../src/delivery-reason.js";
import { recipientDeliveryOf, type RecipientDelivery } from "../src/delivery-recipient.js";
import { dlvStream, dmStream } from "../src/subjects.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = "reasons";
const DLV = dlvStream(space), DM = dmStream(space);
const hdrs = (frame: string | undefined, ...reasons: string[]) => {
  const h = headers();
  if (frame !== undefined) h.set(PLANE3_FRAME_HEADER, frame);
  for (const r of reasons) h.append(PLANE3_REASON_HEADER, r);
  return h;
};
let seq = 0;
const deliver = (stream: string, h: ReturnType<typeof headers> | undefined, o: { seq?: number; count?: number } = {}): RecipientDelivery =>
  recipientDeliveryOf(stream, {
    subject: `cotal.${space}.x`, data: new Uint8Array([1]), ...(h ? { headers: h } : {}),
    info: { streamSequence: o.seq ?? ++seq, deliveryCount: o.count ?? 1, timestampNanos: 1_000_000 },
  });

// ---- 1. producer ----
for (const reason of ["durable-channel", "live-mention"] as const) {
  const h = dlvCopyHeaders(reason);
  check(`the reader writes the frame and only "${reason}"`, h.get(PLANE3_FRAME_HEADER) === "1" && h.values(PLANE3_REASON_HEADER).join() === reason && [...h.keys()].length === 2, [...h.keys()]);
}
for (const [what, reason] of [["an unknown", "mention"], ["no", undefined], ["an object", { reason: "live-mention" }]] as const) {
  const h = dlvCopyHeaders(reason);
  check(`${what} entry reason writes the frame and no reason`, h.get(PLANE3_FRAME_HEADER) === "1" && h.values(PLANE3_REASON_HEADER).length === 0 && [...h.keys()].length === 1, [...h.keys()]);
}

// ---- 2. forgery on the unicast plane ----
const forged = deliver(DM, hdrs("1", "live-mention"));
check("a DM delivery with a forged frame and live-mention reason is dm", forged.category === "dm" && forged.unrecognizedReason === undefined, forged);
check("a DM delivery with a forged durable-channel reason is dm", deliver(DM, hdrs("1", "durable-channel")).category === "dm");
check("a delivery on any other stream is unknown whatever its headers", deliver("CHAT_reasons", hdrs("1", "live-mention")).category === "unknown");

// ---- 3. missing or invalid ----
const unknowns: Array<[string, ReturnType<typeof headers> | undefined, string | undefined]> = [
  ["no headers", undefined, undefined],
  ["no frame header", hdrs(undefined, "live-mention"), undefined],
  ["frame version 2", hdrs("2", "live-mention"), undefined],
  ["no reason (an older reader)", hdrs("1"), undefined],
  ["an empty reason", hdrs("1", ""), undefined],
  ["an unknown reason", hdrs("1", "mention"), "mention"],
  ["a differently cased reason", hdrs("1", "LIVE-MENTION"), "LIVE-MENTION"],
  ["two reasons", hdrs("1", "live-mention", "durable-channel"), "live-mention,durable-channel"],
  ["an overlong reason", hdrs("1", "x".repeat(300)), "x".repeat(64)],
];
for (const [what, h, unrecognized] of unknowns) {
  const d = deliver(DLV, h);
  check(`a DLV copy with ${what} is unknown${unrecognized ? ", reported" : ""}`, d.category === "unknown" && d.unrecognizedReason === unrecognized, d);
}

// ---- 4. trusted paths ----
for (const reason of ["durable-channel", "live-mention"] as const) {
  check(`a framed DLV copy with ${reason} is ${reason}`, deliver(DLV, hdrs("1", reason)).category === reason);
  check(`the reader's own ${reason} headers reach the recipient as ${reason}`, deliver(DLV, dlvCopyHeaders(reason)).category === reason);
}

// ---- 5. mixed run ----
const run = [deliver(DLV, hdrs("1", "live-mention")), deliver(DLV, hdrs("1", "durable-channel")), deliver(DLV, hdrs("1")), deliver(DM, hdrs("1", "live-mention")), deliver(DLV, hdrs("1", "mention"))];
const categories = run.map((d) => d.category);
check("a mixed run keeps each delivery's own category", categories.join() === "live-mention,durable-channel,unknown,dm,unknown", categories);
check("one live-mention labels no other delivery", categories.filter((c) => c === "live-mention").length === 1, categories);

// ---- 6. source ids ----
const first = deliver(DLV, hdrs("1", "live-mention"), { seq: 700, count: 1 });
const again = deliver(DLV, hdrs("1", "live-mention"), { seq: 700, count: 3 });
check("a redelivered copy keeps its sourceId and category", first.sourceId === `${DLV}:700` && again.sourceId === first.sourceId && again.category === first.category && again.deliveryCount === 3, { first, again });
check("distinct stream sequences have distinct sourceIds", new Set(run.map((d) => d.sourceId)).size === run.length, run.map((d) => d.sourceId));
check("the observation is frozen", Object.isFrozen(first));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0 || pass !== 26) process.exit(1);

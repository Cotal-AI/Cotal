/**
 * Chunk sizing for the artifact verbs — a COMPUTATION, never a constant.
 *
 * WHY THIS MODULE EXISTS AT ALL. Two earlier attempts at this rule were written as fixed numbers
 * and both were wrong for the same reason: the number was measured correctly and then promoted to a
 * property of the system when it was a property of one sample.
 *
 *   - "128 KiB raw -> a 174,908-byte request" is true for ONE caller shape (a 32-char uploadId, a
 *     10-char `from.id`, an 8-char `from.name`). Request size varies with the caller principal, the
 *     agent name — which is UNBOUNDED — the uploadId, and a `seq` that GROWS DIGITS as a transfer
 *     proceeds. A transfer can pass the check at `seq: 9` and cross the boundary at `seq: 10`.
 *   - `payloadBudget()` reads `max_payload` LIVE. A broker configured to 65,536 yields a 58,982
 *     budget, in which that same 174,908-byte request does not fit at all.
 *
 * So this module is deliberately **envelope-agnostic**: it never knows what a frame looks like. The
 * caller supplies a `frame` function that builds its own ACTUAL serialized bytes for a given raw
 * size, and this measures what that produces. Request and reply are sized SEPARATELY because their
 * envelopes differ, and every call re-derives rather than reusing an earlier answer.
 *
 * That property is also what makes this survive the rail moving. Cotal #350 rules that the `ctl`
 * rails are transitional and the delivery verbs migrate to `ep`, whose envelope adds `v`, `id`,
 * `class`, digests, deadline, structured error and reply attribution. A contract with no envelope
 * constant in it has nothing to invalidate: when the verbs migrate, the FIXTURES change and this
 * logic does not.
 */

/**
 * A frame builder: given a raw payload size in bytes, return the EXACT bytes that would go on the
 * wire for this call, in this direction, right now — including the current `seq`/`offset` at their
 * current digit width.
 *
 * It returns the serialized form rather than an object so there is no room for this module to
 * disagree with the caller's serializer about what a byte is.
 */
export type FrameBuilder = (rawBytes: number) => Uint8Array | string;

/** Raised when the live budget cannot carry even one raw byte plus its envelope. */
export class MinimumChunkError extends Error {
  constructor(
    readonly budget: number,
    readonly minimumFrame: number,
  ) {
    super(
      `the broker's payload budget of ${budget} bytes cannot carry a minimum chunk: one raw byte ` +
        `frames to ${minimumFrame} bytes. Refusing rather than shrinking toward a floor that makes ` +
        `no progress — every call would succeed and the transfer would never complete.`,
    );
    this.name = "MinimumChunkError";
  }
}

/**
 * The largest raw byte count whose frame fits `budget`, for THIS call and THIS direction.
 *
 * POSITIVE PROGRESS IS >= 1 RAW BYTE. That is the thing proven possible — not "a chunk", which can
 * be satisfied by zero and is how a chunker livelocks while every individual reply looks successful.
 * If one raw byte does not fit, this throws {@link MinimumChunkError} rather than returning 0.
 *
 * Callers must invoke this PER CALL, passing a `frame` closed over the current `seq`/`offset`: a
 * plan computed once is a constant wearing a computation's clothes, and digit growth will cross the
 * boundary underneath it.
 */
export function fitChunk(opts: { budget: number; frame: FrameBuilder; maxRaw: number }): number {
  const { budget, frame, maxRaw } = opts;
  // The floor first, and it is checked against ONE raw byte rather than zero. Zero framing inside
  // the budget proves nothing: it is the state in which a chunker loops forever with every reply
  // reporting success.
  const floor = frameBytes(frame, 1);
  if (floor > budget) throw new MinimumChunkError(budget, floor);
  // ZERO IS NOT AN ANSWER THIS FUNCTION MAY GIVE, and returning it here contradicted the paragraph
  // twelve lines above — "POSITIVE PROGRESS IS >= 1 RAW BYTE … this throws rather than returning 0"
  // — which then held only for the budget floor and not for this path.
  //
  // The consequence is in `planTransfer`, its sole caller: `take = Math.min(fit, remaining)` and
  // `remaining -= take`, so a fit of 0 never decrements and the plan loop never terminates. It is a
  // caller declaring a ceiling below one byte, which is a caller bug, and the only two things this
  // function can do about it are refuse loudly or hang the process. A cell REQUIRED the 0 —
  // `C8` — so the livelock was pinned in place by a passing test, which is the third time in this
  // slice a green cell held a defect still.
  //
  // NOT `MinimumChunkError`, though it was the obvious reach. That error means "one raw byte does
  // not fit the BUDGET", which is false here — the budget may be enormous and the caller simply
  // asked for less than a byte. Reusing it would map two unrelated causes onto one name and send an
  // operator to look at the wrong number, which is the same defect this file records `liveLifecycleFor`
  // committing with its bare catch.
  if (maxRaw < 1)
    throw new RangeError(`fitChunk: maxRaw must be at least 1, got ${maxRaw} (a ceiling below one byte cannot make progress)`);
  if (frameBytes(frame, maxRaw) <= budget) return maxRaw;

  // MEASURED, not estimated, and not a formula: each probe serializes the caller's ACTUAL frame and
  // weighs it. Base64 growth is monotonic in the raw size, so a binary search over [1, maxRaw] is
  // exact — it converges on the true boundary rather than approaching it with a safety margin. That
  // matters because a chunker fills the budget deliberately on every call, so a margin is not
  // caution, it is throughput thrown away on every chunk of every transfer.
  let lo = 1, hi = maxRaw;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (frameBytes(frame, mid) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Serialized size of a frame, in bytes.
 *
 * Byte length, never `String.length`: the frame carries base64 (ASCII, so they agree) alongside
 * caller-supplied text like an agent name, which does not.
 */
export function frameBytes(frame: FrameBuilder, rawBytes: number): number {
  const f = frame(rawBytes);
  // BYTE length, never String.length. The base64 payload is ASCII and the two agree there, but the
  // envelope carries caller-supplied text — an agent name is unbounded and may be multi-byte — and
  // that is exactly the field whose variability broke the constant this module replaces.
  return typeof f === "string" ? new TextEncoder().encode(f).length : f.byteLength;
}

/**
 * Assert that an upload frame fits BEFORE it is published.
 *
 * This exists because the daemon cannot refuse what it never receives. Measured against a live
 * nats-server at `max_payload: 100` through the real client: a zero-byte chunk request serializes
 * to 149 bytes and `nc.request` rejects it LOCALLY with `InvalidArgumentError: 'payload' max_payload
 * size exceeded`. The request never reaches the wire, so `ControlReply.error` is not a surface that
 * exists for this failure, and a plan promising a named refusal from the daemon promises something
 * unimplementable. The refusal has to happen here, on the client, before the publish.
 */
export function assertUploadFits(opts: { budget: number; frame: FrameBuilder; rawBytes: number }): void {
  const { budget, frame, rawBytes } = opts;
  const floor = frameBytes(frame, 1);
  // The floor is its own named failure, distinct from "this particular chunk is too big". They are
  // different bugs: one says the transfer can never proceed on this broker, the other says the
  // caller sized this call wrong. Collapsing them would report an unrecoverable condition as a
  // retryable one.
  if (floor > budget) throw new MinimumChunkError(budget, floor);
  const actual = frameBytes(frame, rawBytes);
  if (actual > budget)
    throw new Error(
      `upload chunk of ${rawBytes} raw bytes frames to ${actual} bytes, over the ${budget}-byte budget. ` +
        `Refused before publish: the client rejects an oversize payload locally, so the daemon never ` +
        `receives the call and cannot answer it — there is no reply in which to name this refusal.`,
    );
}

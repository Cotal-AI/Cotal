/**
 * The oversized-frame split and its labelled truncation (plan §5.2).
 *
 * WHY THIS IS A DATA-LOSS SUITE AND NOT A FORMATTING ONE. Everything this plane exists to fix comes
 * back if the split is wrong, and it comes back QUIETLY in every direction: a part sized against the
 * frame instead of the message is REJECTED by the broker, and a rejected truncation is silent loss
 * wearing the costume of a labelled one; a truncation that forgets its label is `tr-`'s 700-character
 * cut with more steps; an event dropped because "no truncation could help" is the exact silent loss
 * the plane was built to make impossible. Each of those looks like working code from the inside.
 *
 * `splitFrames` DOES NOT MEASURE. It is handed `measure`, which in production is
 * `CotalEndpoint.encodedSize` — the surface that builds the envelope and sets the headers. That is
 * what makes this suite possible without a broker, and it is also the property most worth stating:
 * a splitter holding its own copy of the size rule would drift from the publisher, and nothing would
 * fail until a frame near the ceiling met a real broker.
 *
 * WHAT THIS SUITE PROVES AND WHAT IT DOES NOT. It drives `splitFrames` directly with a synthetic
 * `measure`, so it proves the ALGORITHM: conservation, ordering, seq assignment, the truncation
 * label, and the refusals. It does NOT prove that the production `measure` is `encodedSize`, nor
 * that any production caller exists — NOTHING calls `splitFrames` outside this package's smokes,
 * because the emitter that would call it has not been built. `frame-size.smoke.ts` is where
 * `encodedSize` is calibrated against a real broker; the two halves are deliberately separate and
 * neither is evidence for the other.
 *
 * THE CONTROL THAT MATTERS MOST IS `unlucky-neighbour`. An event can fail to fit ALONGSIDE what is
 * already batched and still fit perfectly well ALONE. Truncating it there would cut content that
 * would have crossed the wire intact — data loss caused by the code whose purpose is to bound data
 * loss. A suite that only checked "big input produces truncation" would score that as a pass, which
 * is why the cell asserts the ABSENCE of a label on a split that merely rebalanced.
 *
 * KILL SET, predicted before the run, as NAMES with no counts, and each naming what it must LEAVE
 * GREEN — a mutation that reddens everything proves only that the suite noticed something:
 *   S1  delete the post-flush "does it fit ALONE?" retry, so any event that does not fit with its
 *       batch is truncated — kills `unlucky-neighbour:not-truncated` and nothing else. Every
 *       conservation, ordering and seq cell stays green, because the events all still arrive in
 *       order; they arrive DAMAGED. That is the discrimination: conservation-by-count cannot see it.
 *   S2  `takeCodePoints` slices code UNITS instead of code points — kills
 *       `truncate:no-lone-surrogate` only. The byte-accounting and fit cells stay green, since a
 *       lone surrogate still measures and still fits. It is simply not well-formed UTF-16, which
 *       this branch's own name rule now refuses at the wire.
 *   S3  `originalBytes` measured from the TRUNCATED value instead of the original — kills
 *       `truncate:label-records-original-size` only. Everything about fitting stays green, and the
 *       frame still says `truncated`. The label would just be a lie about how much was lost.
 *   S4  the binary search returns `hi` (the first size that does NOT fit) instead of `lo` — kills
 *       `truncate:result-actually-fits`. This is the plausible off-by-one, not one invented to fit
 *       a passing test, and it is the one that would reach a broker as a rejection.
 *   S5  drop the emptied-value guard, so an impossible envelope is not refused — kills
 *       `refuse:impossible-even-when-emptied`.
 *
 * Run: pnpm smoke:agui-split
 */
import {
  AGUI_EVENT_TYPE,
  AguiBrackets,
  AguiVocabularyError,
  runFinished,
  runStarted,
  splitFrames,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  toolCallStart,
  type AguiEvent,
  type AguiFrame,
} from "../src/agui.js";

let ok = 0,
  fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++;
  else {
    fail++;
    console.log("  x FAIL:", n, extra ?? "");
  }
};

const TS = 1_700_000_000_000;
const ID = { threadId: "t1", runId: "r1", epoch: "e1" };

/**
 * A stand-in for `CotalEndpoint.encodedSize`: the encoded body plus a fixed header block.
 *
 * DELIBERATELY SENSITIVE TO `seq`, because the real one is. `seq` rides inside the JSON body, so a
 * frame at seq 9 and the same frame at seq 10 differ by a byte, and a frame one byte over is
 * refused. Measuring every candidate at the seq it will actually carry is a property of the
 * algorithm, not an implementation detail — `seq:measured-per-candidate` pins it.
 */
const HEADER_BYTES = 60;
const measure = (f: AguiFrame): number => HEADER_BYTES + Buffer.byteLength(JSON.stringify(f), "utf8");

const text = (id: string, delta: string): AguiEvent =>
  textMessageContent({ messageId: id, delta, timestamp: TS });

/** Every event that went in, in order, flattened back out of the frames. */
const flatten = (frames: AguiFrame[]): AguiEvent[] => frames.flatMap((f) => f.events);
const deltasOf = (evs: AguiEvent[]): string[] =>
  evs.map((e) => (e as unknown as Record<string, unknown>).delta as string);

/** The discriminating verdict for a refusal: it must be the vocabulary error AND name the cause. */
const refusalNaming = (fn: () => unknown, needle: string): string => {
  try {
    fn();
    return "NO-THROW";
  } catch (e) {
    if (!(e instanceof AguiVocabularyError)) return `WRONG-TYPE: ${(e as Error).name}`;
    return e.message.includes(needle) ? "OK" : `WRONG-REFUSAL: ${e.message}`;
  }
};

// ── A batch that fits is ONE frame, unchanged ─────────────────────────────────────────────────────
{
  const events = [text("m1", "a"), text("m1", "b"), text("m1", "c")];
  const frames = splitFrames({ ...ID, firstSeq: 7, events, measure, limit: 4096 });
  c("fits:single-frame", frames.length === 1, frames.length);
  c("fits:seq-is-firstSeq", frames[0]?.seq === 7, frames[0]?.seq);
  c("fits:events-unchanged", JSON.stringify(flatten(frames)) === JSON.stringify(events));
}

// ── Too big for one frame: split on event boundaries, seq increments, NOTHING is lost or reordered ─
//    Conservation is asserted on the CONTENT, not the count. A split that dropped one event and
//    duplicated another would keep the count and pass a length check.
{
  const events = Array.from({ length: 40 }, (_, i) => text("m1", `chunk-${i}-${"x".repeat(20)}`));
  const frames = splitFrames({ ...ID, firstSeq: 0, events, measure, limit: 400 });
  c("split:more-than-one-frame", frames.length > 1, frames.length);
  c("split:every-frame-within-limit", frames.every((f) => measure(f) <= 400));
  c("split:every-frame-non-empty", frames.every((f) => f.events.length > 0));
  c(
    "split:seq-is-contiguous-from-firstSeq",
    frames.every((f, i) => f.seq === i),
    frames.map((f) => f.seq),
  );
  c(
    "split:conserves-content-and-order",
    JSON.stringify(deltasOf(flatten(frames))) === JSON.stringify(deltasOf(events)),
  );
  c("split:no-event-truncated", flatten(frames).every((e) => !(e as { cotal?: unknown }).cotal));
}

// ── THE CONTROL THAT MATTERS: an event that does not fit ALONGSIDE its batch, but fits ALONE ───────
//    It must be moved to the next frame INTACT, never truncated. A splitter missing the post-flush
//    retry still conserves order and count — it just silently damages the payload.
//    THE LIMIT IS DERIVED FROM THE INSTRUMENT, NOT GUESSED. A hand-picked constant here is how this
//    cell silently stops testing what it names: pick it slightly too low and the event does not fit
//    alone either, so the splitter truncates it CORRECTLY and the cell fails for a reason that has
//    nothing to do with the retry. The first version of this cell did exactly that. So: measure the
//    frame carrying the big event ALONE and use that as the ceiling — by construction it fits alone
//    and cannot fit beside anything.
{
  const big = "y".repeat(300);
  const events = [text("m1", "small"), text("m1", big)];
  const limit = measure({
    kind: "ag-ui.frame",
    protocol: "ag-ui/0.0.57",
    ...ID,
    seq: 1,
    events: [events[1]!],
  } as AguiFrame);
  const frames = splitFrames({ ...ID, firstSeq: 0, events, measure, limit });
  const last = flatten(frames).at(-1) as unknown as Record<string, unknown>;
  c("unlucky-neighbour:split-into-two", frames.length === 2, frames.length);
  c("unlucky-neighbour:not-truncated", last?.cotal === undefined, last?.cotal);
  c("unlucky-neighbour:delta-is-intact", last?.delta === big);
}

// ── A single event too big for ANY frame is truncated, and the truncation is LABELLED ─────────────
{
  const original = "z".repeat(5000);
  const frames = splitFrames({ ...ID, firstSeq: 3, events: [text("m1", original)], measure, limit: 500 });
  const e = flatten(frames)[0] as unknown as Record<string, unknown>;
  const meta = e?.cotal as { truncated?: { field: string; originalBytes: number } } | undefined;
  c("truncate:one-frame", frames.length === 1, frames.length);
  c("truncate:result-actually-fits", measure(frames[0]!) <= 500, measure(frames[0]!));
  c("truncate:label-present", !!meta?.truncated, meta);
  c(
    "truncate:label-names-the-field-path",
    meta?.truncated?.field === `${AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT}.delta`,
    meta?.truncated?.field,
  );
  c(
    "truncate:label-records-original-size",
    meta?.truncated?.originalBytes === Buffer.byteLength(original, "utf8"),
    meta?.truncated?.originalBytes,
  );
  c("truncate:value-was-actually-cut", (e?.delta as string).length < original.length);
  c(
    "truncate:is-a-prefix-of-the-original",
    original.startsWith(e?.delta as string),
    (e?.delta as string).slice(0, 12),
  );
  // MAXIMAL, not merely fitting: emptying the field would also "fit", and would be a far worse
  // answer. One more code point must push it over.
  const oneMore = {
    ...e,
    delta: original.slice(0, (e?.delta as string).length + 1),
  } as unknown as AguiEvent;
  c(
    "truncate:is-maximal-one-more-would-not-fit",
    measure({ ...frames[0]!, events: [oneMore] }) > 500,
  );
}

// ── Code POINTS, not code units: a lone surrogate is not well-formed UTF-16 ────────────────────────
//    This branch already refuses ill-formed names at the wire; a splitter that manufactured one here
//    would produce a frame the wire layer is obliged to reject.
{
  const original = "😀".repeat(2000); // every character is a surrogate PAIR
  const frames = splitFrames({ ...ID, firstSeq: 0, events: [text("m1", original)], measure, limit: 600 });
  const cut = (flatten(frames)[0] as unknown as Record<string, unknown>).delta as string;
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut);
  c("truncate:no-lone-surrogate", !lone, JSON.stringify(cut.slice(-4)));
  c("truncate:surrogate-result-fits", measure(frames[0]!) <= 600);
}

// ── An oversized event with NO truncatable field is REFUSED, naming why ────────────────────────────
//    TOOL_CALL_START carries no field the plan permits cutting. Cutting `toolCallName` would produce
//    a frame that fits and means something else, so the only honest answer is to fail loudly.
c(
  "refuse:no-truncatable-field",
  refusalNaming(
    () =>
      splitFrames({
        ...ID,
        firstSeq: 0,
        events: [toolCallStart({ toolCallId: "t", toolCallName: "n".repeat(5000), timestamp: TS })],
        measure,
        limit: 500,
      }),
    "carries no truncatable field",
  ) === "OK",
  refusalNaming(() => 0, "x"),
);

// ── A ceiling the envelope alone cannot meet is REFUSED, not looped ────────────────────────────────
c(
  "refuse:impossible-even-when-emptied",
  refusalNaming(
    () => splitFrames({ ...ID, firstSeq: 0, events: [text("m1", "z".repeat(500))], measure, limit: 80 }),
    "even with delta emptied",
  ) === "OK",
);

// ── Argument refusals, asserted as THAT refusal ────────────────────────────────────────────────────
c(
  "refuse:non-positive-limit",
  refusalNaming(
    () => splitFrames({ ...ID, firstSeq: 0, events: [text("m1", "a")], measure, limit: 0 }),
    "split limit must be a positive safe integer",
  ) === "OK",
);
c(
  "refuse:no-events",
  refusalNaming(
    () => splitFrames({ ...ID, firstSeq: 0, events: [], measure, limit: 4096 }),
    "requires at least one event",
  ) === "OK",
);

// ── `seq` is measured per candidate, not sized once at firstSeq ────────────────────────────────────
//    A splitter that measured every candidate at `firstSeq` would produce a part that fits at seq 9
//    and is refused at seq 10. Driven with a measure that charges heavily per seq DIGIT, so a frame
//    packed under the cheap assumption would exceed the ceiling once its real seq is known.
{
  const digitHeavy = (f: AguiFrame): number =>
    HEADER_BYTES + Buffer.byteLength(JSON.stringify(f), "utf8") + String(f.seq).length * 40;
  const events = Array.from({ length: 30 }, (_, i) => text("m1", `d${i}-${"x".repeat(15)}`));
  const frames = splitFrames({ ...ID, firstSeq: 8, events, measure: digitHeavy, limit: 380 });
  c(
    "seq:measured-per-candidate",
    frames.every((f) => digitHeavy(f) <= 380),
    frames.map((f) => `${f.seq}:${digitHeavy(f)}`),
  );
  c("seq:crossed-a-digit-boundary", frames.length > 2 && frames.at(-1)!.seq >= 10, frames.length);
}

// ── A run may OPEN in one frame and CLOSE in another — the split must not break bracketing ─────────
//    This is the property `AguiBrackets` is incremental for. A per-frame balance check would call
//    the split invalid; feeding the frames in order must be accepted.
{
  const events: AguiEvent[] = [
    runStarted({ threadId: ID.threadId, runId: ID.runId, timestamp: TS }),
    // The message must be OPENED before content — the bracket machine refuses content on a message
    // it never saw start, and it was right to refuse the first version of this fixture, which had
    // no START. Left as a comment because "the test was wrong" is the useful half of that story.
    textMessageStart({ messageId: "m1", timestamp: TS }),
    ...Array.from({ length: 20 }, (_, i) => text("m1", `b${i}-${"x".repeat(20)}`)),
    textMessageEnd({ messageId: "m1", timestamp: TS }),
    runFinished({ threadId: ID.threadId, runId: ID.runId, timestamp: TS }),
  ];
  const frames = splitFrames({ ...ID, firstSeq: 0, events, measure, limit: 420 });
  const brackets = new AguiBrackets();
  let bracketErr: string | undefined;
  try {
    for (const f of frames) for (const e of f.events) brackets.accept(e);
  } catch (e) {
    bracketErr = (e as Error).message;
  }
  c("brackets:split-run-is-accepted-across-frames", frames.length > 1 && !bracketErr, bracketErr);
}

console.log(`agui-split smoke: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

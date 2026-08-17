// The bootstrap ordering this surface needs because it taps live BEFORE it reads history.
//
// THE RACE IS THIS PAGE'S, NOT A HYPOTHETICAL. `app.js` opens the SSE feed and only then calls
// `refresh()`, so `onMessage` is already appending live traffic while the backfill fetch is still in
// flight. For ordinary chat that is harmless: entries carry `ts`, the feed is a window, and a
// duplicate is caught by message id. For an event frame it is not harmless, because a frame's
// position in its stream is `seq`, and `seq` is the only thing that can tell a reader that a frame
// is MISSING. Message-id dedupe cannot: two ids are equal or they are not, which says nothing about
// what belongs between them.
//
// SO THE CONSUMER HAS TO IMPOSE ITS OWN PHASE BOUNDARY. The transport arms the watermark, goes live,
// and only then surfaces retained history, so a live frame at `seq` 1003 can legitimately be the
// FIRST frame this page ever sees, ahead of the retained 1000-1002. Two rules follow, and both are
// the opposite of what a first-arrival reading would do:
//
//   · The baseline is the MINIMUM of the settled history batch, not the first frame observed.
//     Baselining on arrival makes the entire backfill look like it ran backwards.
//   · Gap checking is not armed until the boundary passes. Armed earlier, the same backfill reads as
//     a hole between 1003 and 1000.
//
// WHAT A BASELINE ABOVE THE FIRST SEQUENCE MEANS, AND WHAT IT DOES NOT. The chat stream caps per
// subject, so a reader that arrives late finds the earliest retained frame at some `seq` N > 1. That
// is ordinary retention and NOT a fault: the chain is marked prefix-incomplete and applied forward.
// A discontinuity AFTER the baseline is the fault, and the two must never be reported as one thing,
// because the first is what always happens and the second is what must never be ignored.
//
// DETECTION IS NOT RECOVERY, AND A DETECTED GAP STILL DRAWS THE FRAME. A gap note is surfaced and
// the frame is emitted anyway. Holding it back until the missing predecessor turns up would hold it
// forever when the predecessor is genuinely gone, which converts a visible gap into a silent loss:
// the exact trade this lane exists to refuse. `next` also advances past the hole, so one lost frame
// reports once instead of reporting on every frame that follows it.
//
// FIRST SEQUENCE. The emitter publishes its first frame at `seq` 1 (`firstSeq` is the WAL frontier
// plus one, from a zero frontier), while the frame validator admits any non-negative safe integer.
// "Complete from origin" therefore keys on `<= 1` and not on `=== 1`, so a `seq` 0 frame, which is
// structurally valid and which no emitter produces, cannot be reported as an evicted prefix.
//
// NOT ORDERED, DELIBERATELY: anything that is not a frame carrying a usable `seq`. Chat, presence,
// DMs and a malformed frame all pass straight through in arrival order. A machine that held a frame
// it could not sequence would either hold it forever or invent a gap around it, and delaying chat
// behind a frame's backfill would make this file a latency bug for the traffic it does not own.
(() => {
  const KIND = "ag-ui.frame";
  /** The first `seq` any emitter publishes. A baseline at or below this is complete from origin. */
  const FIRST_SEQ = 1;

  const isSeq = (v) => Number.isSafeInteger(v) && v >= 0;

  /** The frame part an entry carries, or `undefined`. A ROUTING question, so it never throws.
   *
   *  Accepts a feed entry (`{mode, channel, msg}`, the all-activity shape) or a bare message (the
   *  selected-channel shape), because both merge sites run this race and a machine that only
   *  understood one of them would leave the other unordered. */
  const frameOf = (entry) => {
    try {
      const msg = entry && typeof entry === "object" ? entry.msg || entry : undefined;
      const parts = msg && msg.parts;
      if (!Array.isArray(parts)) return undefined;
      for (const p of parts)
        if (p && typeof p === "object" && p.kind === KIND && isSeq(p.seq)) return p;
      return undefined;
    } catch {
      return undefined;
    }
  };

  /** The chain a frame belongs to: `(from.id, epoch, threadId)`.
   *
   *  EPOCH IS IN THE KEY BECAUSE `runId` CANNOT DISCRIMINATE. Two writers pick run ids and sequences
   *  independently, so their `(runId, seq)` pairs collide by construction; `epoch` is what makes one
   *  writer's stream its own. A JSON array is the delimiter rather than a joining character, because
   *  a thread id is a producer-supplied string and any separator chosen here could appear inside it,
   *  which would fuse two chains into one and hide a gap in the merge. */
  const chainKey = (entry, frame) => {
    const msg = entry && typeof entry === "object" ? entry.msg || entry : undefined;
    const from = msg && msg.from;
    return JSON.stringify([
      (from && typeof from.id === "string" ? from.id : null),
      typeof frame.epoch === "string" ? frame.epoch : null,
      typeof frame.threadId === "string" ? frame.threadId : null,
    ]);
  };

  /** A two-phase shape-B bootstrap. One instance per bootstrap: a reconnect re-runs both phases. */
  const create = () => {
    /** key -> {baseline, next, prefixIncomplete, faulted, seen:Set<seq>} */
    const chains = new Map();
    /** Live frames arriving before the boundary, in arrival order. */
    const pending = [];
    let settled = false;

    const chainOf = (key) => {
      let c = chains.get(key);
      if (!c) {
        c = { baseline: undefined, next: undefined, prefixIncomplete: false, faulted: false, released: false, seen: new Set() };
        chains.set(key, c);
      }
      return c;
    };

    /** Admit one frame against an armed chain. Returns the notes it produced.
     *
     *  `straddle` marks the ONE frame per chain whose predecessor lies on the other side of the
     *  bootstrap seam, and it changes what a hole MEANS rather than merely how it is worded. See
     *  {@link STRADDLE} below. */
    const admit = (c, key, seq, straddle) => {
      const notes = [];
      if (c.seen.has(seq)) return { emit: false, notes };
      c.seen.add(seq);
      if (seq > c.next) {
        // Both ends are named either way, so a reader sees WHAT is missing rather than only that
        // something is.
        const hole = { key, expected: c.next, got: seq, missing: seq - c.next };
        if (straddle) {
          // STRADDLE: THE ONE HOLE THIS PAGE CANNOT ATTRIBUTE, and calling it a fault was a measured
          // false positive on healthy traffic.
          //
          // The two halves of the bootstrap are two independent reads with no shared cut: a live
          // subscription, and a history request. Nothing makes the point the read was served equal
          // the point the tap began delivering, and on this page the fetch is issued before the tap
          // is even open. So a frame published inside that window is in NEITHER half, and the first
          // buffered frame of a chain can therefore sit above the retained range's top by more than
          // one with nothing lost by the broker at all. Reported as a fault, it latched `faulted`
          // forever on a stream that was fine, and the frame that filled the hole a moment later did
          // not clear it.
          //
          // A fault that fires on healthy traffic is worse than no fault at all, because it teaches
          // the reader to ignore the one signal that matters. So this is reported as its own kind,
          // named as unconfirmed on the surface, and it does NOT set `faulted`. What it is not is
          // silence: the page says it could not establish the join, rather than saying nothing was
          // missing.
          //
          // ONLY THE FIRST RELEASED FRAME OF A CHAIN GETS THIS TREATMENT. Every later buffered frame
          // arrived through the SAME tap as the one before it, and a subscription delivers a subject
          // in order, so a number missing BETWEEN two buffered frames was never delivered while the
          // page was listening. That is a real loss and takes the hard path below, exactly like a
          // post-boundary hole.
          notes.push({ type: "boundary-hole", ...hole });
        } else {
          notes.push({ type: "gap", ...hole });
          c.faulted = true;
        }
      }
      if (seq >= c.next) c.next = seq + 1;
      return { emit: true, notes };
    };

    return {
      /** A live arrival. Before the boundary a frame is HELD; everything else always passes. */
      live(entry) {
        const f = frameOf(entry);
        if (!f) return { emit: [entry], held: false, notes: [] };
        if (!settled) {
          pending.push(entry);
          return { emit: [], held: true, notes: [] };
        }
        const key = chainKey(entry, f);
        const c = chainOf(key);
        if (c.next === undefined) {
          // First frame for a chain that the settled history did not mention: this arrival is the
          // baseline, which is sound now only because the boundary has passed.
          c.baseline = f.seq;
          c.next = f.seq;
          c.prefixIncomplete = f.seq > FIRST_SEQ;
        }
        const r = admit(c, key, f.seq);
        return { emit: r.emit ? [entry] : [], held: false, notes: r.notes };
      },

      /** THE PHASE BOUNDARY: the history batch has settled.
       *
       *  Returns the merged feed to render, oldest-first: the batch in the order the server sorted
       *  it, then every held live frame that the batch did not already carry, released in `seq`
       *  order per chain. The batch is the baseline source, so a live frame that ran ahead of it
       *  lands after its own retained predecessors instead of before them. */
      backfill(batch) {
        const notes = [];
        const rows = Array.isArray(batch) ? batch.slice() : [];

        // Phase one: the batch establishes each chain's baseline. Taken as a MINIMUM over the batch
        // rather than from its first row, because the server sorts the union by `ts` across channels
        // and a frame's `ts` is not its `seq`.
        for (const row of rows) {
          const f = frameOf(row);
          if (!f) continue;
          const c = chainOf(chainKey(row, f));
          if (c.baseline === undefined || f.seq < c.baseline) c.baseline = f.seq;
          c.seen.add(f.seq);
        }
        for (const [key, c] of chains) {
          if (c.baseline === undefined) continue;
          let highest = c.baseline;
          for (const s of c.seen) if (s > highest) highest = s;
          c.next = highest + 1;
          c.prefixIncomplete = c.baseline > FIRST_SEQ;
          if (c.prefixIncomplete) notes.push({ type: "prefix-incomplete", key, baseline: c.baseline });
          // THE RETAINED RANGE IS AUDITED, NOT JUST ITS ENDS. Recording the minimum, the maximum and
          // the set is enough to place the baseline and to dedupe, and it is NOT enough to notice that
          // the middle is missing: a batch of 1, 2, 5 has a baseline of 1 and a frontier of 6, and
          // every later frame follows contiguously, so the chain reads healthy forever while two
          // frames are gone. A discontinuity that exists only inside retained history is still a
          // discontinuity after the baseline, and it is the one kind no live arrival will ever
          // reveal, because nothing after it is out of order.
          //
          // Reported as runs rather than per missing number, so losing a thousand frames is one note
          // naming both ends instead of a thousand notes burying it. The walk stops at `highest`,
          // which is in the set by construction, so a run always terminates on a present frame.
          let run = 0;
          for (let s = c.baseline + 1; s <= highest; s++) {
            if (!c.seen.has(s)) {
              run++;
              continue;
            }
            if (run > 0) {
              notes.push({ type: "gap", key, expected: s - run, got: s, missing: run });
              c.faulted = true;
              run = 0;
            }
          }
        }

        // Phase two: release what the tap delivered while the fetch was in flight. Sorted by `seq`
        // within a chain and stable across chains, so a chain's frames are contiguous with the
        // retained range they follow.
        const heldFrames = pending
          .map((entry, i) => ({ entry, frame: frameOf(entry), i }))
          .filter((h) => h.frame !== undefined);
        heldFrames.sort((a, b) => (a.frame.seq - b.frame.seq) || (a.i - b.i));

        for (const h of heldFrames) {
          const key = chainKey(h.entry, h.frame);
          const c = chainOf(key);
          if (c.next === undefined) {
            // No retained frame for this chain, so the earliest BUFFERED frame is the baseline. This
            // is the empty-history arm, and it is why the buffer is sorted before it is walked.
            c.baseline = h.frame.seq;
            c.next = h.frame.seq;
            c.prefixIncomplete = h.frame.seq > FIRST_SEQ;
            if (c.prefixIncomplete)
              notes.push({ type: "prefix-incomplete", key, baseline: c.baseline });
          }
          // The seam is crossed once per chain: this frame's predecessor is retained history (or
          // nothing), every later one's predecessor came through the same tap it did.
          const straddle = !c.released;
          c.released = true;
          const r = admit(c, key, h.frame.seq, straddle);
          for (const n of r.notes) notes.push(n);
          if (r.emit) rows.push(h.entry);
        }

        pending.length = 0;
        settled = true;
        return { emit: rows, notes };
      },

      /** Whether the boundary has passed. Gap checking is armed only after it has. */
      get settled() {
        return settled;
      },
      /** Held-but-unreleased count. Zero after the boundary, by construction. */
      get pendingCount() {
        return pending.length;
      },
      /** A chain's observed state, for a surface that wants to mark it and for the suite. */
      state(key) {
        const c = chains.get(key);
        return c === undefined
          ? undefined
          : {
              baseline: c.baseline,
              next: c.next,
              prefixIncomplete: c.prefixIncomplete,
              faulted: c.faulted,
            };
      },
      get chainKeys() {
        return [...chains.keys()];
      },
    };
  };

  window.COTAL_EVENT_ORDER = { KIND, FIRST_SEQ, frameOf, chainKey, create };
})();

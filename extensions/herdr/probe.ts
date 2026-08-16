/**
 * Waiting for a spawned process to become VISIBLE to a `ps`-style instrument.
 *
 * WHY THIS EXISTS. The soak's positive control proves the survivor instrument can see a live
 * agent — and it is the reason the eleven leak assertions after it mean anything. If it can pass
 * or fail by timing, then "no agent processes survive" is green with exactly the probability that
 * the instrument happened to look at the right moment.
 *
 * It sampled once, immediately after `runtime.spawn` returned with status `running`. At that
 * moment the pane is running the LAUNCHER, which has not yet spawned the payload, and the nonce
 * appears on the payload's command line only — never on the launcher's, by design (the args and
 * env ride an owner-only script precisely so they stay off every command line).
 *
 * Measured against the real `privateLauncher`, driving its exact argv and sampling at the instant
 * spawn returns: the payload was visible 0 times out of 6, and became visible 70-155ms later,
 * every time. So the control had no correctness margin of its own at all. What kept it green was
 * the latency of `herdr agent start` — the server round trip and pane creation usually take longer
 * than the launcher needs, so the payload is usually already there by the time the cell looks.
 * That margin belongs to an unrelated subsystem, nobody chose it, nothing documents it, and
 * nothing fails when it shrinks. Under load it shrinks, and the cell reddens.
 *
 * That is why the fix is not a longer wait. A longer wait keeps the shape — sample and hope — and
 * merely buys a bigger borrowed margin. The control has to become a statement about whether the
 * instrument CAN see, not about when it happened to look. So: name the event, and wait on it.
 * The event is "the payload becomes visible to the instrument", which is the very property the
 * control asserts, and the deadline is the failure — never a warning, never a quiet pass.
 *
 * This module also owns the nonce the instrument matches on, because the nonce IS the selector:
 * how much of the machine `ourProcs()` can see is decided entirely by what that string is.
 *
 * The probe is injected so this is testable without a race: `probe.smoke.ts` drives it with
 * synthetic probes and a fake clock, so every branch is graded deterministically. A race cannot be
 * killed deterministically through the live path; through an injected probe it can.
 */

/** What the wait concluded. The three cases are deliberately distinct: whoever reads a red at 3am
 *  needs to know whether the instrument looked and saw nothing, or could not look at all. */
export type VisibilityOutcome =
  /** The instrument saw the process. `count` is the sample that decided it. */
  | { kind: "seen"; count: number; tries: number; elapsedMs: number }
  /** The instrument RAN and never saw it inside the deadline. A statement about the world. */
  | { kind: "deadline"; lastCount: number; tries: number; elapsedMs: number }
  /** The instrument never produced a single reading — every attempt threw. A statement about the
   *  INSTRUMENT, and a different repair: `ps` missing, not permitted, or unable to fork. Reporting
   *  this as "saw nothing" would send the reader hunting a process that was never looked for. */
  | { kind: "unavailable"; tries: number; elapsedMs: number; error: string };

export interface WaitOpts {
  /** Hard bound. Reaching it is a FAILURE outcome, never a tolerated pass. */
  deadlineMs: number;
  intervalMs: number;
  /** Injected for deterministic tests; defaults to the real clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll `probe` until it reports at least one match, or the deadline passes.
 *
 * `probe` is expected to THROW when it cannot take a reading at all (an `execFileSync` that fails
 * to run), and to return a count when it can. Those two are not the same event and are not
 * reported as the same outcome.
 *
 * A throwing probe is retried rather than fatal, because a fork failure on a loaded runner is
 * transient and a missing binary is not — retrying costs one deadline in the second case and saves
 * a spurious red in the first. What decides `unavailable` is whether ANY attempt ever produced a
 * reading, not whether the last one did.
 *
 * At least one sample always happens, even at `deadlineMs: 0`, so this can never report on a
 * measurement it did not take.
 */
export async function waitUntilVisible(probe: () => number, opts: WaitOpts): Promise<VisibilityOutcome> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  let tries = 0;
  let sampled = false;
  let lastCount = -1;
  let lastError = "";

  for (;;) {
    tries++;
    try {
      const count = probe();
      sampled = true;
      lastCount = count;
      if (count >= 1) return { kind: "seen", count, tries, elapsedMs: now() - started };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    // Checked AFTER the sample, so the first reading is always taken.
    if (now() - started >= opts.deadlineMs) break;
    await sleep(opts.intervalMs);
  }

  const elapsedMs = now() - started;
  return sampled
    ? { kind: "deadline", lastCount, tries, elapsedMs }
    : { kind: "unavailable", tries, elapsedMs, error: lastError };
}

/** The evidence line for an outcome. Shared with the caller so a red says which of the three
 *  things happened, in the same words the type distinguishes. */
export function visibilityDetail(o: VisibilityOutcome): string {
  switch (o.kind) {
    case "seen":
      return `${o.count} seen after ${o.elapsedMs}ms (${o.tries} ${o.tries === 1 ? "sample" : "samples"})`;
    case "deadline":
      return `the instrument ran ${o.tries} times over ${o.elapsedMs}ms and never saw it (last count ${o.lastCount}) — nothing was there to see, or it never became visible`;
    case "unavailable":
      return `the instrument could not take a single reading in ${o.tries} attempts over ${o.elapsedMs}ms — this says nothing about whether the process exists: ${o.error}`;
  }
}


/**
 * The payload nonce, and the tag the survivor instrument matches.
 *
 * The payload is `sleep <nonce>`, so the nonce has to be a string `sleep` accepts as a duration AND
 * a string no other run can produce. The previous form was `12${process.pid % 1000}`, which fails
 * the second requirement in two ways — and the second is much likelier than the first:
 *
 *   • BIRTHDAY: only 1000 distinct values, so two concurrent soaks on one host can share a nonce.
 *   • PREFIX, and this is the sharp one: the tag is matched with `includes`, and the values are
 *     variable-width. `pid % 1000 === 1` yields the tag `sleep 121`, `pid % 1000 === 10` yields
 *     `sleep 1210` — and "sleep 1210".includes("sleep 121") is TRUE. One soak counts another's
 *     payloads without any value collision at all.
 *
 * Either way the damage is two-directional and lands inside the same run: a neighbour's live
 * payload makes the positive control pass when this run's own instrument might not have worked,
 * and a neighbour's payload still running at the end makes "no agent processes survive" fail when
 * nothing leaked. A green that was bought by another process, and a red that belongs to one.
 *
 * Fixed-width and high-entropy fixes both: 64 bits in a zero-padded fractional part. The width is
 * constant, so no tag can ever be a prefix of another. `sleep` parses the value as a double and
 * ignores precision it cannot represent, but the ARGV string keeps every digit — and argv is what
 * `ps` reports and what the instrument matches, which is the only thing that has to be unique.
 */
export function soakNonce(randomBits: () => bigint): string {
  return `12000.${randomBits().toString().padStart(20, "0")}`;
}

/** What `ourProcs()` greps for. One definition, so the payload and the matcher cannot drift. */
export function agentTag(nonce: string): string {
  return `sleep ${nonce}`;
}

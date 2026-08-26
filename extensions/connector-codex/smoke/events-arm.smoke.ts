/**
 * ARMING IS NOT AUTHORIZATION, for the Codex launch path.
 *
 * A seat publishes its AG-UI event plane only when the launch ARMED it: `opts.events` goes in and
 * `COTAL_EVENTS` comes out. The manager separately mints a publish GRANT on the channel that plane
 * lands on. Those are two different facts, and the dangerous confusion is to treat the second as the
 * first: an agent file or a manifest can hand-write anything into `allowPublish`, so if a grant could
 * arm the emitter, anyone who could write an agent file could turn on a full record of another seat's
 * tool inputs and outputs without touching the launch grammar. The cells drive `buildLaunch` directly
 * and read the environment it renders, so the separation is measured on the artifact.
 *
 * AND THIS IS THE SUITE THAT WOULD CATCH THE WIRING BEING DEAD. The connector can hold a complete,
 * correct mapper and never start it, because the host only builds a holder when `COTAL_EVENTS` is
 * set. A mapping suite passes either way: it drives the mapper directly and never asks whether a
 * real launch reaches it. That is exactly the state every connector shipped in before this campaign.
 *
 * WHAT THIS FILE DOES NOT COVER, stated rather than left to be found. Every cell hand-builds the
 * launch options and calls `buildLaunch`, so it is silent on whether a real `cotal spawn --events`
 * puts `events` and `workspaceRoot` into that bag at all. That is one layer up.
 *
 * The other half is the write-ahead log's home. The log records what has already gone on the wire;
 * a LATER start reads it to learn where to continue. A log written under the launch working
 * directory is invisible to that next start, which then reads an already-published thread as virgin
 * and republishes sequence numbers the stream has already seen. So `COTAL_WORKSPACE_ROOT` rides with
 * the arm and its absence REFUSES the launch. `COTAL_CODEX_HOME` in the same function DOES fall back
 * to the process cwd, and that asymmetry is deliberate: an isolated codex home only ever has to be
 * found by the process that wrote it.
 *
 * Run: pnpm smoke:codex-events-arm
 */
import { eventChannel } from "@cotal-ai/core";
import { codexConnector } from "../src/extension.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  x FAIL: ${name}`, extra ?? "");
  }
};

const WS = "/tmp/cotal-codex-events-arm-workspace";
const env = (extra: Record<string, unknown>): Record<string, string> =>
  codexConnector.buildLaunch({ space: "s", name: "seat", ...extra } as never).env as Record<string, string>;
const refusalFor = (extra: Record<string, unknown>): string | null => {
  try {
    env(extra);
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
};

// ---- the arm ---------------------------------------------------------------------------------
{
  const armed = env({ events: true, workspaceRoot: WS });
  check("--events arms the emitter (COTAL_EVENTS=1)", armed.COTAL_EVENTS === "1", { got: armed.COTAL_EVENTS });
  check("and the log's home rides with it", armed.COTAL_WORKSPACE_ROOT === WS, { got: armed.COTAL_WORKSPACE_ROOT });

  // The negative is the whole point of the pair: a launch that did not ask for events must not get
  // them, and a check that only asserts the positive passes on a connector that arms unconditionally.
  const unarmed = env({ workspaceRoot: WS });
  check("an unarmed launch does NOT set COTAL_EVENTS", unarmed.COTAL_EVENTS === undefined, { got: unarmed.COTAL_EVENTS });
  check("and does not set the log's home either", unarmed.COTAL_WORKSPACE_ROOT === undefined, { got: unarmed.COTAL_WORKSPACE_ROOT });
  check("while the isolated codex home is set either way", typeof unarmed.COTAL_CODEX_HOME === "string" && unarmed.COTAL_CODEX_HOME.length > 0);
}

// ---- the refusal -----------------------------------------------------------------------------
{
  const why = refusalFor({ events: true });
  check("an armed launch with no workspace root refuses", why !== null, { why });
  check("and the refusal says WHY rather than just failing", (why ?? "").includes("workspaceRoot") && (why ?? "").includes("write-ahead log"), { why });

  // The refusal must be specific to the ARM. A launch that never asked for events has no log to
  // place, so the same missing workspaceRoot must NOT refuse it.
  check("an UNARMED launch with no workspace root is fine", refusalFor({}) === null, { why: refusalFor({}) });
}

// ---- the declaration -------------------------------------------------------------------------
{
  // The connector must DECLARE an event plane, or a real armed spawn is refused at the door: the
  // manager mints the publish grant from this declaration, so a connector that arms the emitter
  // without declaring the channel produces a seat that publishes to a subject it has no grant for.
  check("the connector DECLARES an event plane", typeof codexConnector.eventChannel === "function", {
    got: typeof codexConnector.eventChannel,
  });
  // And it is CORE's derivation, not a second copy. Compared by function identity rather than by
  // output: two functions that agree on one sample can disagree on the next, and the property that
  // matters is that there is exactly one place the subject is decided.
  check("and it is core's own derivation, not a re-implementation", codexConnector.eventChannel === eventChannel);
  // Keyed on the PRINCIPAL. A display name is not an identity on this mesh, and a name-keyed channel
  // would fuse two principals' streams onto one subject.
  const sample = codexConnector.eventChannel?.({ owner: "o", actor: "a" } as never);
  check("and the channel it derives is principal-keyed", sample === eventChannel({ owner: "o", actor: "a" } as never), { sample });
}

console.log(`codex-events-arm smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

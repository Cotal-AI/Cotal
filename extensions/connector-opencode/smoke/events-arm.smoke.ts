/**
 * ARMING IS NOT AUTHORIZATION, and this suite keeps the two apart for the OpenCode launch path.
 *
 * A session publishes its AG-UI event plane only when the launch ARMED it: `opts.events` goes in and
 * `COTAL_EVENTS` comes out. The manager separately mints a
 * publish GRANT on the channel that plane lands on. Those are two different facts, and the dangerous
 * confusion is to treat the second as the first: an agent file or a manifest can hand-write anything
 * into `allowPublish`, so if a grant could arm the emitter, anyone who could write an agent file
 * could turn on a full record of another seat's tool inputs and outputs without touching the launch
 * grammar. The cells drive `buildLaunch` directly and read the environment it renders, so the
 * separation is measured on the artifact rather than argued.
 *
 * **AND THIS SUITE IS THE ONE THAT WOULD HAVE CAUGHT THE WIRING BEING DEAD.** The connector can hold
 * a complete, correct emitter and never start it, because the plugin only builds one when
 * `COTAL_EVENTS` is set. A mapping suite passes either way: it drives the mapper directly and never
 * asks whether a real launch reaches it.
 *
 * WHAT THIS FILE DOES NOT COVER, stated rather than left to be found. Every cell here hand-builds the
 * launch options and calls `buildLaunch`, so this suite is silent on whether a real `cotal spawn
 * --events` puts `events` and `workspaceRoot` into that bag at all: if the CLI or the manager stopped
 * passing either one, nothing below would notice. That is one layer up and it is proved by
 * `smoke:spawn-foreground-events`, which drives real argv through `runCli` against a probe connector.
 *
 * The other half is the write-ahead log's home. The log records what has already gone on the wire;
 * a LATER start reads it to learn where to continue. A log written under the launch working
 * directory is invisible to that next start, which then reads an already-published thread as virgin
 * and republishes sequence numbers the stream has seen. So `COTAL_WORKSPACE_ROOT` rides with the arm
 * and its absence REFUSES the launch. Note that `COTAL_OPENCODE_HOME` in the same function DOES fall
 * back to the process cwd: that is safe for a SQLite file and a pidfile, which only ever have to be
 * found by the process that wrote them, and it is not safe for the log, whose whole purpose is to be
 * found by a process that has not started yet.
 *
 * Run: pnpm smoke:opencode-events-arm
 */
import { eventChannel } from "@cotal-ai/core";
import { opencodeConnector } from "../src/extension.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  x FAIL: ${name}`, extra ?? "");
  }
};

const WS = "/tmp/cotal-opencode-events-arm-workspace";
const env = (extra: Record<string, unknown>): Record<string, string> =>
  opencodeConnector.buildLaunch({ space: "s", name: "seat", ...extra } as never).env as Record<string, string>;
const refusalFor = (extra: Record<string, unknown>): string | null => {
  try {
    env(extra);
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
};

// ---- CONTROL: the default is OFF, so every positive cell below is measuring the flag ------------
{
  const e = env({ workspaceRoot: WS });
  check("CONTROL: an ordinary launch carries no COTAL_EVENTS", e.COTAL_EVENTS === undefined, e.COTAL_EVENTS);
  check("CONTROL: an ordinary launch carries no COTAL_WORKSPACE_ROOT either", e.COTAL_WORKSPACE_ROOT === undefined, e.COTAL_WORKSPACE_ROOT);
}

// ---- ARMED: the flag, and only the flag, turns the plane on ------------------------------------
{
  const e = env({ events: true, workspaceRoot: WS });
  check("--events arms the emitter (COTAL_EVENTS=1)", e.COTAL_EVENTS === "1", e.COTAL_EVENTS);
  check("an armed launch carries the workspace root the write-ahead log lives under", e.COTAL_WORKSPACE_ROOT === WS, e.COTAL_WORKSPACE_ROOT);
}
{
  const e = env({ events: false, workspaceRoot: WS });
  check("--no-events leaves the plane off", e.COTAL_EVENTS === undefined, e.COTAL_EVENTS);
}

// ---- THE SEPARATION: a grant cannot arm --------------------------------------------------------
const HANDWRITTEN = eventChannel({ owner: "local", actor: "someone_elses_seat" });
{
  const e = env({ workspaceRoot: WS, allowPublish: ["general", HANDWRITTEN] });
  check("a hand-written event-channel grant does NOT arm the emitter", e.COTAL_EVENTS === undefined,
    { COTAL_EVENTS: e.COTAL_EVENTS, allowPublish: HANDWRITTEN });
  check("and it does not smuggle the workspace root in either", e.COTAL_WORKSPACE_ROOT === undefined, e.COTAL_WORKSPACE_ROOT);
}

// ---- THE WAL HOME: an absent workspace root REFUSES, it does not fall back ---------------------
{
  const msg = refusalFor({ events: true });
  check("an armed launch with no workspace root refuses", msg !== null, msg);
  check("and the refusal NAMES the write-ahead log, so the operator can act on it",
    msg !== null && /write-ahead log/.test(msg), msg);
  check("and it names this connector, so an operator running several knows which one refused",
    msg !== null && /opencode connector/.test(msg), msg);
}
{
  // The neighbouring fallback is deliberate and is asserted here so that a later reader does not
  // "fix" the asymmetry by making one match the other. They serve different consumers.
  const e = env({ events: true, workspaceRoot: WS });
  check("the SQLite/pidfile home still tracks the workspace root when there is one",
    e.COTAL_OPENCODE_HOME === WS, e.COTAL_OPENCODE_HOME);
  const unarmed = env({});
  check("and it still falls back to the launch cwd when events are off, which the log may never do",
    unarmed.COTAL_OPENCODE_HOME === process.cwd() && unarmed.COTAL_WORKSPACE_ROOT === undefined,
    { home: unarmed.COTAL_OPENCODE_HOME, root: unarmed.COTAL_WORKSPACE_ROOT });
}

// ---- Cell count, because a buildLaunch that threw on every input would DELETE cells, not fail them
const EXPECTED = 12;
check(`every cell ran - ${EXPECTED} expected, a conditional cell that vanishes is invisible without this`,
  pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(`opencode-events-arm smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

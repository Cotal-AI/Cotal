/**
 * ARMING IS NOT AUTHORIZATION, AND THIS SUITE IS WHERE THE TWO ARE KEPT APART.
 *
 * A session publishes its AG-UI event plane unless the launch explicitly opts out (`--no-events`,
 * which reaches the connector as `opts.events = false`). The manager separately mints
 * a publish GRANT on the channel that plane lands on. Those are two different facts, and the
 * dangerous confusion is to treat the second as the first: an agent file or manifest can hand-write
 * anything it likes into `allowPublish`, so if a grant could arm the emitter, any author who could
 * write an agent file could turn on a full transcript of another seat's tool inputs and outputs
 * without ever touching the launch grammar. The cells below drive `buildLaunch` directly and read the
 * environment it renders, so the separation is measured on the artifact rather than argued.
 *
 * The other half is the write-ahead log's home. The emitter's log records what it has already put on
 * the wire; a LATER start reads it to learn where to continue. A log written under the launch working
 * directory is invisible to the next start, which then reads an already-published thread as virgin
 * and republishes sequence numbers the stream has seen. So `COTAL_WORKSPACE_ROOT` rides with the arm
 * and its absence REFUSES the launch: there is no default that is merely suboptimal here, only one
 * that corrupts the stream on the second start.
 *
 * Run: pnpm smoke:claude-events-arm
 */
import { eventChannel, readLaunchMaterial, writeLaunchMaterial } from "@cotal-ai/core";
import { configFromEnv } from "@cotal-ai/connector-core";
import { claudeConnector } from "../src/extension.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const WS = "/tmp/cotal-events-arm-workspace";
const env = (extra: Record<string, unknown>): Record<string, string> =>
  claudeConnector.buildLaunch({ space: "s", name: "seat", workspaceRoot: WS, ...extra } as never).env as Record<string, string>;
const refusalFor = (extra: Record<string, unknown>): string | null => {
  try {
    env(extra);
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
};

console.log("claude connector: the event plane is armed by the launch, never by a grant");

// ---- CONTROL: the default is ON -----------------------------------------------------------------
{
  const e = env({});
  check("CONTROL: an ordinary launch carries COTAL_EVENTS", e.COTAL_EVENTS === "1", e.COTAL_EVENTS);
  check("CONTROL: an ordinary launch carries the durable workspace root", e.COTAL_WORKSPACE_ROOT === WS, e.COTAL_WORKSPACE_ROOT);
}

// ---- ARMED: the flag, and only the flag, turns the plane on ------------------------------------
{
  const e = env({ events: true });
  check("--events arms the emitter (COTAL_EVENTS=1)", e.COTAL_EVENTS === "1", e.COTAL_EVENTS);
  check("an armed launch carries the workspace root the write-ahead log lives under", e.COTAL_WORKSPACE_ROOT === WS, e.COTAL_WORKSPACE_ROOT);
}
{
  const e = env({ events: false });
  check("--no-events leaves the plane off", e.COTAL_EVENTS === undefined, e.COTAL_EVENTS);
}

// ---- THE SEPARATION: a grant cannot arm --------------------------------------------------------
// The exact channel the manager would grant, hand-written into the launch the way a manifest or an
// agent file can. Nothing about holding it is a request to publish to it.
const HANDWRITTEN = eventChannel({ owner: "local", actor: "someone_elses_seat" });
{
  const e = env({ events: false, allowPublish: ["general", HANDWRITTEN] });
  check(
    "a hand-written event-channel grant does NOT override an explicit opt-out",
    e.COTAL_EVENTS === undefined,
    { COTAL_EVENTS: e.COTAL_EVENTS, allowPublish: HANDWRITTEN },
  );
  check(
    "and it does not smuggle the workspace root in either",
    e.COTAL_WORKSPACE_ROOT === undefined,
    e.COTAL_WORKSPACE_ROOT,
  );
}

// ---- THE WAL HOME: absent workspace root REFUSES, it does not fall back ------------------------
{
  const msg = refusalFor({ events: true, workspaceRoot: undefined });
  check("an armed launch with no workspace root refuses", msg !== null, msg);
  check(
    "and the refusal NAMES the write-ahead log, so the operator can act on it",
    msg !== null && /write-ahead log/.test(msg),
    msg,
  );
  check(
    "the refusal states it is refusing rather than defaulting to the working directory",
    msg !== null && /Refusing rather than defaulting/.test(msg),
    msg,
  );
}

// ---- REQUIRED POLICY: launch material and env fallback both expose the arm -----------------------
{
  const owner = "u_abcdefghijklmnopqrstuvwxyz";
  const channel = eventChannel({ owner, actor: "seat" });
  const material = writeLaunchMaterial({ servers: "nats://127.0.0.1:4222", eventsRequired: true, userAuth: {
    owner, actor: "seat", sentinelCredsPath: "/dev/null", bearerCmd: ["true"],
  } });
  check("required policy survives launch material", readLaunchMaterial(material).eventsRequired === true);
  const config = configFromEnv({ COTAL_NAME: "seat", COTAL_SPACE: "s", COTAL_LAUNCH_MATERIAL: material,
    COTAL_LIFECYCLE_UID: "abcdefghijklmnopqrstuvwxzy1234", COTAL_ALLOW_PUBLISH: channel });
  check("required launch material reaches connector config", config.eventsRequired === true);
}
{
  const owner = "u_abcdefghijklmnopqrstuvwxyz";
  const channel = eventChannel({ owner, actor: "seat" });
  const config = configFromEnv({
    COTAL_NAME: "seat", COTAL_SPACE: "s", COTAL_OWNER: owner, COTAL_ACTOR: "seat",
    COTAL_SENTINEL_CREDS: "/dev/null", COTAL_BEARER_CMD: '["true"]', COTAL_LIFECYCLE_UID: "abcdefghijklmnopqrstuvwxzy1234",
    COTAL_ALLOW_PUBLISH: channel, COTAL_EVENTS_REQUIRED: "1",
  });
  check("required policy env fallback reaches connector config", config.eventsRequired === true);
  const refused = (() => { try {
    configFromEnv({ COTAL_NAME: "seat", COTAL_SPACE: "s", COTAL_OWNER: owner, COTAL_ACTOR: "seat",
      COTAL_SENTINEL_CREDS: "/dev/null", COTAL_BEARER_CMD: '["true"]', COTAL_LIFECYCLE_UID: "abcdefghijklmnopqrstuvwxzy1234",
      COTAL_ALLOW_PUBLISH: "general", COTAL_EVENTS_REQUIRED: "1" }); return "";
  } catch (error) { return (error as Error).message; } })();
  check("required session refuses when its grant misses the event channel", refused.includes(channel) && refused.includes("actor grant"), refused);
}

// The manager grants what `eventChannel` returns and the session publishes to what it derives from
// its own endpoint. If the connector sanitized, lowercased, or otherwise rebuilt the string here,
// the two would disagree for exactly the principals a display-name sanitizer mangles, and the
// failure would be an auth rejection at publish time, long after the launch looked fine.
{
  check("the connector exposes an event channel at all", typeof claudeConnector.eventChannel === "function");
  const principal = { owner: "local", actor: "UAA7EXAMPLEACTORKEY" };
  check(
    "the connector's channel IS core's derivation, character for character",
    claudeConnector.eventChannel!(principal) === eventChannel(principal),
    { connector: claudeConnector.eventChannel!(principal), core: eventChannel(principal) },
  );
  // A by-value sample cannot see a clone that delegates for that sample and diverges elsewhere.
  // The property that matters, one function deciding the subject, is asserted by identity here as
  // it is on the Codex side.
  check("and it is core's own derivation by identity, not a clone that agrees on one sample", claudeConnector.eventChannel === eventChannel);
  // The whole point of keying on the principal: a display name is not one. Two seats can share a
  // name; they cannot share an allocated actor. If these two ever collapsed to one string the
  // channel would fuse two principals onto one subject.
  check(
    "keying on a display name would name a DIFFERENT channel",
    eventChannel({ owner: "local", actor: "seat" }) !== eventChannel(principal),
  );
}

// ---- Cell count, because six cells above only run when a launch was accepted -------------------
// A regression that makes `buildLaunch` throw on every input does not fail those cells, it deletes
// them, and the run still prints a summary. Change the cases above and change this number
// deliberately.
const EXPECTED = 18;
check(
  `every cell ran - ${EXPECTED} expected, a conditional cell that vanishes is invisible without this`,
  pass + fail === EXPECTED,
  `${pass + fail} cells reported`,
);

console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

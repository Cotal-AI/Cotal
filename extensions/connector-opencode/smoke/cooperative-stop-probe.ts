/**
 * Subprocess probe for the opencode cooperative-stop smoke (cooperative-stop.smoke.ts) — never run
 * standalone. Loads the REAL plugin with a tiny fake OpenCode HTTP server plus the COTAL_* identity +
 * control env the parent set, so the plugin connects its mesh agent and starts its control server. The
 * parent then sends an authenticated {op:"shutdown"} to that endpoint; against this healthy fake the
 * plugin leaves the mesh (its offline presence attempt lands) and exits 0, which the parent asserts.
 * The product's publish is best effort, so what is asserted here is this scenario, not a guarantee. A separate process because the
 * plugin's cooperative shutdown ends in process.exit, which would otherwise tear down the test itself.
 */
import { once } from "node:events";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { bootPlugin } from "./_boot-plugin.js";
import { CotalEndpoint } from "@cotal-ai/core";

// The plugin calls OpenCode's HTTP API at boot to own a session. A shutdown test drives no turn, so
// only POST /session is needed.
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;
// Set by the parent only for the teardown-join scenario; unset, this probe behaves exactly as
// it always did and the original four cells are unaffected.
const marker = process.env.COOP_MARKER?.trim() || undefined;
const trigger = process.env.COOP_TRIGGER?.trim() || undefined;
// Flipped immediately before the un-awaited create, so ONLY the read that the resulting drain
// performs is slowed and marked. Counting reads instead was wrong: the bind does not read, so the
// drain's read was the first one and the marker was never written even with the join in place.
let draining = false;
// True only while the drain's read is outstanding, which is exactly the cutover window. A
// prompt arriving in it means a turn was started against a session whose replacement holder is
// not installed yet, so the probe records the violation where the parent can see it.
let inCutover = false;
const violation = process.env.COOP_VIOLATION?.trim() || undefined;
// EVERY prompt, not only the ones inside a cutover. A turn started during teardown is a
// different fault from one started mid-cutover, and the in-cutover flag cannot see it.
const prompts = process.env.COOP_PROMPTS?.trim() || undefined;
// The SECOND drain, belonging to a swap that was still queued when the stop arrived. It is
// marked separately because it is a different case from the first: the holder join covers work
// already running, and only the chain join covers a swap that has not begun.
const marker2 = process.env.COOP_MARKER_QUEUED?.trim() || undefined;
// Set only for the late-intake scenario: the parent writes `late` once it has SEEN the seat go
// offline, and the probe answers by knocking on every public door. `lateFired` is written after
// those calls return and is the positive control, without which the assertion that nothing changed
// would also pass on a probe that never knocked.
const late = process.env.COOP_LATE?.trim() || undefined;
// THE CROSSING SCENARIO. A caller admitted BEFORE the stop parks inside its presence write and
// resumes after teardown has published departure. The seam holds the first of setStatus's two
// awaits, which is the real gap rather than an invented one: setStatus assigns, awaits setActivity,
// then awaits setStatus, so a teardown starting in that gap publishes departure between them.
//
// ONE DOOR PER PROCESS, which is not tidiness. A hook reaches presence through the plugin's helper
// and a tool reaches the agent directly, so they are two mechanisms; but parking both in one
// teardown makes them mask each other, because waiting on either holds departure until both have
// resumed. Removing the tracking from one path then changes nothing observable and the mutation for
// it survives. Measured, not predicted: that is exactly how C11 and C12 survived. There is one
// teardown per process, so each door needs its own seat.
const cross = process.env.COOP_CROSS?.trim() || undefined; // "hook" | "tool" | "model" | "mirror" | "interior"
const crossArm = process.env.COOP_CROSS_ARM?.trim() || undefined;
const crossParked = process.env.COOP_CROSS_PARKED?.trim() || undefined;
const crossRelease = process.env.COOP_CROSS_RELEASE?.trim() || undefined;
const rejectRelease = process.env.COOP_REJECT_RELEASE?.trim() || undefined;
const rejectParked = process.env.COOP_REJECT_PARKED?.trim() || undefined;
// THE SHAPE ITSELF IS A PRECONDITION, not an assumption. A two-call set cannot tell absorbing every
// element apart from absorbing only the ends, because in a set of two every index IS an end. The
// interior seat admits THREE and puts the failing call in the middle, and this marker is what proves
// the set really had that shape when the stop landed rather than the cell grading two calls it
// believed were three.
const interiorShape = process.env.COOP_INTERIOR_SHAPE?.trim() || undefined;
const noteShape = (): void => {
  if (interiorShape && parked.length === 2 && parkedReject.length === 1)
    writeFileSync(interiorShape, "three calls admitted: two parked with the failing one between them\n");
};
const parked: Array<() => void> = [];
// Released on its own trigger, and BEFORE the parked one, so the failure lands while the teardown is
// still waiting rather than after it has given up.
const parkedReject: Array<() => void> = [];
if (cross) {
  // The model record publishes presence through a different endpoint method than a status write,
  // so the model door needs its own seam rather than a third case on the activity one.
  const originalModel = CotalEndpoint.prototype.setCardModel;
  CotalEndpoint.prototype.setCardModel = async function (model: string, variant?: string): Promise<void> {
    if (cross === "model" && model === "crossing/model") {
      await new Promise<void>((r) => {
        parked.push(r);
        if (crossParked) writeFileSync(crossParked, "the pre-stop model publish is parked\n");
      });
    }
    return originalModel.call(this, model, variant);
  };
  const original = CotalEndpoint.prototype.setActivity;
  CotalEndpoint.prototype.setActivity = async function (activity: string): Promise<void> {
    // A SECOND ADMITTED CALL THAT FAILS, which is a different question from one that is slow. The
    // teardown waits on the set of admitted calls, and if that wait is satisfied by the FIRST thing
    // to happen rather than by all of them, one failure releases departure while another call is
    // still parked. A seat that parks a single caller cannot show that, because a set of one has no
    // difference to show. This is the one that fails, released while the parked one is still held.
    if (activity === "crossing-reject") {
      await new Promise<void>((r) => {
        parkedReject.push(r);
        if (rejectParked) writeFileSync(rejectParked, "the failing call was admitted and is waiting to fail\n");
        noteShape();
      });
      throw new Error("admitted presence write failed");
    }
    if (activity === `crossing-${cross}`) {
      await new Promise<void>((r) => {
        parked.push(r);
        if (crossParked) writeFileSync(crossParked, `the pre-stop ${cross} call is parked inside its presence write\n`);
        noteShape();
      });
    }
    return original.call(this, activity);
  };
}
const lateFired = process.env.COOP_LATE_FIRED?.trim() || undefined;
// Focus turns an @mention into a WAKE rather than an injected batch: the body is acked-and-dropped
// at ingest and stays recallable, so the nudge string handed to drive is the only copy of the wake.
const focus = process.env.COOP_FOCUS?.trim() || undefined;
const focusReady = process.env.COOP_FOCUS_READY?.trim() || undefined;
// THE RESUME SEAT. `drive` reads its phase guards and THEN awaits session creation, so a drive
// admitted while the seat was healthy is parked inside a server round trip when the stop lands.
// Holding POST /session here is what puts it there: the plugin's `ensureSession` awaits the boot
// create, so an inbound DM arriving before this answers admits a drive that cannot proceed. The
// parent releases the hold only AFTER the shutdown, so any prompt this server then sees was
// submitted by a drive that crossed the guard before the stop and resumed after it.
const holdSession = process.env.COOP_HOLD_SESSION?.trim() || undefined;
const holdRelease = process.env.COOP_HOLD_RELEASE?.trim() || undefined;
let drainReads = 0;
const oc = createServer((req, res) => {
  if (req.headers.authorization !== auth) {
    res.writeHead(401).end();
    return;
  }
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
  if (req.method === "POST" && req.url === "/session") {
    const answer = (): void => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "ses_coop" }));
    };
    if (holdSession) {
      writeFileSync(holdSession, "session creation is held; any drive admitted now parks in it\n");
      const poll = (): void => {
        if (holdRelease && existsSync(holdRelease)) answer();
        else setTimeout(poll, 10).unref?.();
      };
      poll();
      return;
    }
    answer();
    return;
  }
  // The AG-UI source reads a session's records from here. The SECOND read is answered SLOWLY and
  // writes a marker just before it answers, which is how the parent sees, from another process,
  // whether a queued drain was still allowed to finish. The first read is fast because it is the
  // fresh adopt at bind time and slowing it would only delay setup.
  if (req.method === "GET" && /^\/session\/[^/]+\/message$/.test(req.url ?? "")) {
    const answer = (): void => {
      if (draining) drainReads += 1;
      if (marker && draining && drainReads === 1) writeFileSync(marker, "the running drain's read completed\n");
      if (marker2 && draining && drainReads === 2) writeFileSync(marker2, "the queued swap's drain ran\n");
      inCutover = false;
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
    };
    if (marker && draining) {
      inCutover = true;
      setTimeout(answer, 2_500);
    } else answer();
    return;
  }
  // A turn being submitted. Nothing may start one while the cutover is open.
  if (req.method === "POST" && /\/prompt_async$/.test(req.url ?? "")) {
    // The BODY as well as the url. A count answers "did a turn start"; only the text answers "which
    // input was carried", and the nudge cell below is about a specific one surviving.
    if (prompts) {
      const body = raw ? (JSON.parse(raw) as { parts?: { text?: string }[] }) : {};
      const said = (body.parts ?? []).map((p) => p.text ?? "").join(" ").replace(/\s+/g, " ").slice(0, 300);
      appendFileSync(prompts, `${req.url} :: ${said}\n`);
    }
    if (violation && inCutover) writeFileSync(violation, `a turn was started mid-cutover: ${req.url}\n`);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const port = (oc.address() as { port: number }).port;
process.env.COTAL_OPENCODE_SERVER_URL = `http://127.0.0.1:${port}`;
process.env.OPENCODE_SERVER_USERNAME = "opencode";
process.env.OPENCODE_SERVER_PASSWORD = "test-secret";

const hooks = await bootPlugin();

if (focus) {
  // Through the seat's own tool, not by reaching into the agent: this is how a real seat enters
  // focus, and the cell is about what the connector does in that mode.
  //
  // RETRIED UNTIL IT REPORTS FOCUS, because `agent.start()` connects in the background and a status
  // write before the link is up does not take. The first version called this once at boot, the call
  // did not stick, and the @mention arrived as an ordinary inbox item instead of a wake: the cell
  // then graded the batch path twice and said nothing about nudges. Failing loudly here is the
  // point, since a seat that is not in focus makes the whole leg vacuous.
  const statusTool = (
    hooks as unknown as { tool: Record<string, { execute: (a: unknown, c?: unknown) => Promise<string> }> }
  ).tool.cotal_status;
  let inFocus = false;
  for (let i = 0; i < 60 && !inFocus; i++) {
    try {
      const said = await statusTool.execute({ attention: "focus" });
      inFocus = /focus/i.test(said);
    } catch {
      /* not connected yet */
    }
    if (!inFocus) await new Promise((r) => setTimeout(r, 100).unref?.());
  }
  if (!inFocus) throw new Error("probe could not enter focus, so the nudge leg would grade nothing");
  if (focusReady) writeFileSync(focusReady, "the seat is in focus\n");
}

// QUEUE REAL EVENT WORK, so the parent's shutdown lands while a drain is in flight. The first
// create binds the holder to this session; the second is NOT awaited, so it leaves a swap on the
// chain whose drain flushes the session being left, and that flush reads through the slow
// endpoint above. Un-awaited on purpose: the bus dispatches events with `void`, so this is how a
// real create arrives, and awaiting it here would drain before the stop and grade nothing.
const fire = (event: unknown): Promise<void> =>
  (hooks as unknown as { event: (a: unknown) => Promise<void> }).event({ event });
const fireTool = (sessionID: string, tool = "late-tool"): Promise<void> =>
  (hooks as unknown as { "tool.execute.before": (i: unknown) => Promise<void> })["tool.execute.before"]({
    sessionID,
    tool,
  });

if (marker) {
  await fire({ type: "session.created", properties: { info: { id: "ses_coop" } } });
  // THE DRAIN MUST STILL BE IN FLIGHT WHEN THE STOP ARRIVES, which is the whole point and was the
  // flaw in the first version of this: fired at boot, the drain finished long before the parent got
  // round to sending the stop, so the marker appeared whether or not the stop waited for anything
  // and the cell passed with the join removed. The parent now says when, and sends the stop while
  // the read it triggers is still outstanding.
  void (async () => {
    while (trigger && !existsSync(trigger)) await new Promise((r) => setTimeout(r, 25).unref?.());
    // ADMITTED HERE rather than at boot, because presence is best effort and silently does nothing
    // while the mesh agent is still connecting: fired at boot this hook returned without ever
    // reaching its presence write, and the cell it feeds passed while grading nothing. The parent
    // writes this trigger only after it has seen the seat online, and the stop is still ahead.
    if (cross === "hook") {
      void fireTool("ses_coop", "crossing-hook");
      void fireTool("ses_coop", "crossing-reject");
    }
    draining = true;
    void fire({ type: "session.created", properties: { info: { id: "ses_next" } } });
    // Queued BEHIND the one above, which is the whole point: when the stop lands, this swap has not
    // started, so only a teardown that joins the CHAIN will let it run. Joining the holder alone
    // covers the drain already in flight and leaves this one abandoned.
    void fire({ type: "session.created", properties: { info: { id: "ses_third" } } });
  })();
}

// KNOCK ON EVERY PUBLIC DOOR AFTER THE SEAT HAS GONE OFFLINE. The parent triggers this only once it
// has observed the offline record, so anything that lands here is unambiguously post-teardown, and
// the joins in the plugin's teardown hold the process open long enough for a publish to be seen.
if (late) {
  void (async () => {
    while (!existsSync(late)) await new Promise((r) => setTimeout(r, 25).unref?.());
    // No sessionID on purpose: that branch publishes "waiting" without an ownership check, so it
    // does not depend on how far the swap chain happened to get before the stop.
    await fire({ type: "permission.asked", properties: { title: "late" } });
    // The tool hook DOES check ownership, and which session is the owned one depends on where the
    // chain stopped, so knock with every id this probe created rather than guessing.
    for (const id of ["ses_coop", "ses_next", "ses_third"]) await fireTool(id);
    // A prompt hook too. It has no presence-visible effect (its publish carries the stored status,
    // which is already offline), so it is knocked but not graded (see the fixture's note).
    await (hooks as unknown as { "chat.message": (i: unknown, o: unknown) => Promise<void> })["chat.message"](
      { sessionID: "ses_coop" },
      { parts: [] },
    );
    // AND THE TOOL MAP, which is intake that never passes through the hook table: OpenCode holds
    // these closures from registration. cotal_status is the one with a presence-visible effect, so
    // it is the one that can be graded rather than merely exercised.
    await (
      hooks as unknown as { tool: Record<string, { execute: (a: unknown, c?: unknown) => Promise<string> }> }
    ).tool.cotal_status.execute({ status: "working" });
    if (lateFired) writeFileSync(lateFired, "every public door was knocked after offline\n");
  })();
}

// ADMITTED BEFORE THE STOP, on purpose: the fence refuses at entry, and this call enters while the
// flag is still clear, so what it grades is the crossing rather than admission. It is not awaited,
// because it is designed to park.
if (cross) {
  void (async () => {
    // ARMED BY THE PARENT, never at boot. Presence is best effort while the mesh agent is still
    // connecting, so a call fired at boot returns without ever reaching its presence write and the
    // cell it feeds passes while grading nothing. Measured: that is how the first version of this
    // scenario went green with its control red.
    while (crossArm && !existsSync(crossArm)) await new Promise((r) => setTimeout(r, 25).unref?.());
    // ONLY THE TOOL DOOR IS FIRED HERE. A tool carries no session, so it can be armed from anywhere;
    // the hook is ownership-checked, and this watcher races the drain watcher, whose swaps change
    // which session is owned. Fired from here it lost that race, the hook was not ours, and it
    // returned without reaching its presence write. So the hook is fired by the drain watcher itself,
    // in front of the swaps, where the session it names is still the owned one.
    if (cross === "tool")
      void (
        hooks as unknown as { tool: Record<string, { execute: (a: unknown, c?: unknown) => Promise<string> }> }
      ).tool.cotal_status.execute({ activity: "crossing-tool" });
    // THE SAME PAIR AS THE HOOK SEAT WITH THE ORDER REVERSED: the call that FAILS is admitted first
    // and the one that parks second. The algorithm is symmetric, since Promise.all short-circuits on
    // the first rejection to occur rather than on a slot, so this is not a second way for the defect
    // to appear. What it pins is that the absorption reaches the head of the set and not only its
    // tail, which the other seat cannot show because there the failing call is never at the front.
    else if (cross === "mirror") {
      void fireTool("ses_coop", "crossing-reject");
      void fireTool("ses_coop", "crossing-mirror");
    }
    // THREE CALLS, THE FAILING ONE IN THE MIDDLE. The head and tail seats above each admit exactly
    // two, and a set of two cannot distinguish absorbing every element from absorbing only the first
    // and the last, because in a set of two every index is already an end. A repair that wraps only
    // the ends passes both of them and still lets an interior rejection settle the wait early. This
    // is the smallest set that has an interior at all.
    else if (cross === "interior") {
      void fireTool("ses_coop", "crossing-interior");
      void fireTool("ses_coop", "crossing-reject");
      void fireTool("ses_coop", "crossing-interior");
    }
    // The session named here is the one the plugin adopted at boot, so the ownership check passes
    // and the hook actually reaches its model publish rather than returning early.
    else if (cross === "model")
      void (
        hooks as unknown as { "chat.message": (i: unknown, o: unknown) => Promise<void> }
      )["chat.message"]({ sessionID: "ses_coop", model: { providerID: "crossing", modelID: "model" } }, { parts: [] });
    while (rejectRelease && !existsSync(rejectRelease)) await new Promise((r) => setTimeout(r, 25).unref?.());
    for (const release of parkedReject) release();
    while (!existsSync(crossRelease)) await new Promise((r) => setTimeout(r, 25).unref?.());
    for (const release of parked) release();
  })();
}

// The plugin's control server keeps the event loop alive; the authenticated shutdown op calls
// process.exit(0). Backstop: never linger on CI if the parent dies before driving shutdown.
setTimeout(() => process.exit(3), 30_000);

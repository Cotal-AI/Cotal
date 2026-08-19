/**
 * Subprocess probe for the opencode cooperative-stop smoke (cooperative-stop.smoke.ts) — never run
 * standalone. Loads the REAL plugin with a tiny fake OpenCode HTTP server plus the COTAL_* identity +
 * control env the parent set, so the plugin connects its mesh agent and starts its control server. The
 * parent then sends an authenticated {op:"shutdown"} to that endpoint; the plugin leaves the mesh
 * (publishes offline presence) and exits 0 — which the parent asserts. A separate process because the
 * plugin's cooperative shutdown ends in process.exit, which would otherwise tear down the test itself.
 */
import { once } from "node:events";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cotal } from "../src/plugin.js";

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
// those calls return and is the positive control — without it the assertion that nothing changed
// would also pass on a probe that never knocked.
const late = process.env.COOP_LATE?.trim() || undefined;
const lateFired = process.env.COOP_LATE_FIRED?.trim() || undefined;
let drainReads = 0;
const oc = createServer((req, res) => {
  if (req.headers.authorization !== auth) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "POST" && req.url === "/session") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "ses_coop" }));
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
    if (prompts) appendFileSync(prompts, `${req.url}\n`);
    if (violation && inCutover) writeFileSync(violation, `a turn was started mid-cutover: ${req.url}\n`);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  res.writeHead(404).end();
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const port = (oc.address() as { port: number }).port;
process.env.COTAL_OPENCODE_SERVER_URL = `http://127.0.0.1:${port}`;
process.env.OPENCODE_SERVER_USERNAME = "opencode";
process.env.OPENCODE_SERVER_PASSWORD = "test-secret";

const hooks = await cotal();

// QUEUE REAL EVENT WORK, so the parent's shutdown lands while a drain is in flight. The first
// create binds the holder to this session; the second is NOT awaited, so it leaves a swap on the
// chain whose drain flushes the session being left, and that flush reads through the slow
// endpoint above. Un-awaited on purpose: the bus dispatches events with `void`, so this is how a
// real create arrives, and awaiting it here would drain before the stop and grade nothing.
const fire = (event: unknown): Promise<void> =>
  (hooks as unknown as { event: (a: unknown) => Promise<void> }).event({ event });
const fireTool = (sessionID: string): Promise<void> =>
  (hooks as unknown as { "tool.execute.before": (i: unknown) => Promise<void> })["tool.execute.before"]({
    sessionID,
    tool: "late-tool",
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
    // which is already offline), so it is knocked but not graded — see the fixture's note.
    await (hooks as unknown as { "chat.message": (i: unknown, o: unknown) => Promise<void> })["chat.message"](
      { sessionID: "ses_coop" },
      { parts: [] },
    );
    if (lateFired) writeFileSync(lateFired, "every public door was knocked after offline\n");
  })();
}

// The plugin's control server keeps the event loop alive; the authenticated shutdown op calls
// process.exit(0). Backstop: never linger on CI if the parent dies before driving shutdown.
setTimeout(() => process.exit(3), 30_000);

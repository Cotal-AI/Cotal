/**
 * Foreground `cotal spawn --events` must mint a credential that can actually publish.
 *
 * **WHY THIS GRADES THE EFFECT AND NOT THE LIST.** The bug this covers did not fail a launch — it
 * SUCCEEDED and produced a mute stream. The child was armed with `COTAL_EVENTS` and published to
 * `events.<name>` on a credential that had never been granted it, so the broker answered every frame
 * with a Permissions Violation nobody saw. A cell asserting that `allowPublish` contains the channel
 * would merely restate the fix, stay green if the mechanism were something else, and stay green if a
 * later change broke the path while leaving the list intact.
 *
 * So this drives the SHIPPED computation — `foregroundAllowPublish`, the same function the command
 * body calls — mints a REAL credential from whatever it returns, connects to a REAL JWT-auth broker,
 * and asks the only question that matters: does the frame land, or is it refused?
 *
 * PUBLISH-PATH ISOLATED on purpose. Binding DM/DLV durables needs `provisionAgentDurables`, and its
 * absence surfaces as "consumer not found" — a CONSUME-side failure that masks the publish outcome,
 * i.e. the one variable under test. An earlier version of this probe reported both arms failing
 * identically for exactly that kind of unrelated reason, which is the false-pair shape: nothing is
 * being varied because nothing under test is being reached.
 *
 * Run: pnpm smoke:foreground-event-grant   (boots its own nats-server)
 */
import { randomUUID } from "node:crypto";
import {
  createSpaceAuth, mintCreds, newIdentity, setupSpaceStreams, mintLifecycleUid,
  CotalEndpoint, type Connector,
} from "@cotal-ai/core";
import { foregroundAllowPublish } from "../src/commands/spawn.js";
import { bootBroker } from "./_boot-broker.js";

let failures = 0;
const check = (label: string, cond: boolean, extra?: unknown): void => {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
};

const space = `fg-events-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers, stop: stopBroker } = await bootBroker(auth);

const NAME = "fg-bot";
// The channel is keyed on the agent's PRINCIPAL, so the test connector takes one — the same shape
// the contract now declares. A name-keyed stub here would type-error, which is the point of moving
// the signature rather than validating a string.
const connector: Pick<Connector, "name" | "eventChannel"> = {
  name: "fg-connector",
  eventChannel: (p: { owner: string; actor: string }) => `events.${p.owner}.${p.actor}`,
};
const AGENT = { owner: "local", actor: "fgbot" };
const OTHER = { owner: "local", actor: "otherbot" };   // a DIFFERENT principal on the same broker

/** Mint a real credential from an ACL, then try to publish to `channel`. */
async function publishes(allowPublish: string[] | undefined, channel = connector.eventChannel!(AGENT)): Promise<"published" | "denied" | string> {
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const creds = await mintCreds(auth, identity, "agent", { allowSubscribe: ["general"], allowPublish, lifecycleUid });
  const ep = new CotalEndpoint({
    space, servers, creds, lifecycleUid,
    card: { name: NAME, kind: "agent", id: identity.id },
    channels: [channel],
    consume: false, registerPresence: false, watchPresence: false,
  });
  const errors: string[] = [];
  ep.on("error", (e: unknown) => errors.push(String((e as Error)?.message ?? e)));
  try {
    await ep.start();
    await ep.multicast("a frame", { channel });
    await new Promise((r) => setTimeout(r, 400));   // let the broker answer before we judge
    await ep.stop();
  } catch (e) {
    errors.push(String((e as Error)?.message ?? e));
    try { await ep.stop(); } catch { /* already down */ }
  }
  if (errors.some((m) => /permission/i.test(m))) return "denied";
  return errors.length ? errors.join(" | ") : "published";
}

try {
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const persona = ["general"];

  // ── the shipped computation, events ON ──
  const withEvents = foregroundAllowPublish(persona, true, connector, AGENT);
  check("the shipped computation adds the connector's OWN event channel",
    (withEvents ?? []).includes(`events.${AGENT.owner}.${AGENT.actor}`), withEvents);
  check("EFFECT: a credential minted from it PUBLISHES to the event channel",
    (await publishes(withEvents)) === "published", withEvents);

  // ── THE ISOLATION PROPERTY, GRADED BY THE BROKER. This is what the re-key is for: the defect was
  //    two distinct principals receiving one grant on one subject, and the only authority that can
  //    settle whether they are actually separated is the one that enforces the grant. A cell
  //    comparing two derived strings would pass for a mapping that produced two channels neither
  //    credential could reach. ──
  check("CROSS-PRINCIPAL EFFECT: this agent's credential is DENIED on another principal's channel",
    (await publishes(withEvents, connector.eventChannel!(OTHER))) === "denied",
    [withEvents, connector.eventChannel!(OTHER)]);

  // ── CONTROL: the pre-fix shape. Without this the cell above would pass for a broker that
  //    accepted everything, which is a different bug wearing the same green. ──
  check("CONTROL: the pre-fix ACL (persona only) is DENIED by the broker",
    (await publishes(persona)) === "denied", persona);

  // ── events OFF and absent must not widen the grant: `--events` is opt-in, and a tri-state
  //    whose ABSENT arm silently granted would be the disclosure direction. ──
  check("events off does not add the channel", (foregroundAllowPublish(persona, false, connector, AGENT) ?? []).join() === persona.join());
  check("events absent does not add the channel", (foregroundAllowPublish(persona, undefined, connector, AGENT) ?? []).join() === persona.join());

  // ── a connector that cannot emit fails loud rather than launching a mute stream ──
  let refused = "";
  try { foregroundAllowPublish(persona, true, { name: "mute-connector" }, AGENT); }
  catch (e) { refused = (e as Error).message; }
  check("events on a connector with no eventChannel is REFUSED, naming the connector",
    /mute-connector/.test(refused) && /event publishing/.test(refused), refused || "did not throw");

  // ── OPEN MODE: no minted identity, so no stable principal to key on. It REFUSES rather than
  //    falling back to the display name — the fallback would reinstate the fused-channel defect on
  //    the one path with no credential to grade it against, which is where it would live forever.
  //    `undefined` is what the command body passes on that branch, so this drives the real arm. ──
  let openRefused = "";
  try { foregroundAllowPublish(persona, true, connector, undefined); }
  catch (e) { openRefused = (e as Error).message; }
  check("open mode (no minted identity) REFUSES --events, naming what is missing",
    /stable identity/.test(openRefused) && /principal/.test(openRefused), openRefused || "did not throw");
  // CONTROL, the inverse of the predicate: the same open-mode call with events OFF is untouched. A
  // refusal that fired on the mode rather than on the request would break every open-mode spawn.
  check("CONTROL: open mode without --events is unaffected",
    (foregroundAllowPublish(persona, undefined, connector, undefined) ?? []).join() === persona.join());
} finally {
  await stopBroker();
}

console.log(failures === 0 ? "\nFOREGROUND EVENT GRANT SMOKE OK" : `\nFOREGROUND EVENT GRANT SMOKE FAILED (${failures})`);
if (failures > 0) process.exit(1);

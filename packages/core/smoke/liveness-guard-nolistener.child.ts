/**
 * The child half of CELL F1 / CELL F2 (#1577): a liveness responder with NO `error` listener
 * attached, taking a probe whose reply target is outside the sender's own subtree.
 *
 * WHY A CHILD PROCESS. The claim is about whether THIS PROCESS SURVIVES, and a claim about process
 * survival cannot be graded inside the process making it: the failing form ends the process, so the
 * assertion after it never runs and the suite reports nothing rather than a red. The parent reads
 * this child's exit status and its printed verdict, which are observable either way.
 *
 * WHY NO LISTENER IS THE WHOLE POINT. `CotalEndpoint extends EventEmitter`, and Node rethrows an
 * `error` event emitted with no listener attached. A cell that attached one would grade the
 * listener. So this file attaches NOTHING on `error` and the parent runs it in both arms:
 *
 *   arm `guard`   — the probe names a reply target outside the sender's subtree, so the responder's
 *                   bound-reply guard rejects it. This is the arm the fix is about.
 *   arm `control` — the SAME file, the same absence of a listener, the same responder, with a
 *                   WELL-FORMED probe. It must survive and answer. Without it, a child that died in
 *                   its broker setup would look identical to a child killed by the guard, and a
 *                   child that printed SURVIVED while binding nothing would look identical to one
 *                   that really took a probe.
 *
 * A `warning` listener IS attached, and deliberately, because it is the positive evidence that the
 * notice was emitted at all rather than the branch being skipped: a guard that silently dropped the
 * frame and emitted nothing would also survive, and would pass a survival-only cell while proving
 * nothing about where the notice went. The parent reads the printed line.
 *
 * Run by `liveness-peer.smoke.ts`; not a suite on its own.
 */
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { CotalEndpoint } from "../src/endpoint.js";
import { livenessSubject, DEV_OWNER } from "../src/subjects.js";

const [servers, space, responderCreds, probeCreds, probeActor, arm] = process.argv.slice(2);
if (!servers || !space || !responderCreds || !probeCreds || !probeActor || !arm)
  throw new Error("usage: <servers> <space> <responderCredsB64> <probeCredsB64> <probeActor> <guard|control>");
if (arm !== "guard" && arm !== "control") throw new Error(`unknown arm ${JSON.stringify(arm)}`);
const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

// The responder, holding the `delivery` credential (the plane whose serve filter that credential
// grants). NOTHING is attached on `error`: that absence is the condition under test.
const ep = new CotalEndpoint({
  space, servers, creds: decode(responderCreds),
  card: { name: "nolistener", kind: "endpoint" },
  consume: false, registerPresence: false, watchPresence: false,
});
// Proof the notice was emitted rather than the branch never being reached. Not an `error` listener:
// `warning` is the channel the guard now reports on, and attaching it cannot make an `error` emit
// survivable, so it does not weaken the arm.
let warnings = 0;
ep.on("warning", (e: Error) => { warnings++; console.log(`WARNING ${e.message}`); });
await ep.start();
ep.serveLiveness("delivery", () => "bound");
await new Promise((r) => setTimeout(r, 300));

// The probe, published by a peer under its OWN request subject (which its grant permits), naming a
// reply target that is NOT under that subject's own `.reply.` subtree in the `guard` arm. The broker
// does not permission-check an embedded reply subject, which is why the responder has to.
const probeSubject = livenessSubject(space, "delivery", DEV_OWNER, probeActor);
const nc = await connect({
  servers,
  authenticator: credsAuthenticator(new TextEncoder().encode(decode(probeCreds))),
  inboxPrefix: `_INBOX_${probeActor}`,
  maxReconnectAttempts: 0,
});
const replyTarget = arm === "guard"
  ? `${probeSubject}.elsewhere.stolen`
  : `${probeSubject}.reply.wellformed`;
console.log(`ARM ${arm} reply=${replyTarget}`);
// A CALLBACK subscription and a counter, NOT an async iterator. In the `guard` arm receiving nothing
// is the CORRECT outcome, so iterating for a frame would wait forever exactly when the guard works,
// and the parent would kill the child at its timeout — a hang that reads as the crash this file
// exists to rule out. Measured here, not anticipated: the first version of this file used
// `for await` and the guard arm was SIGKILLed at 40s with the guard behaving correctly.
let answers = 0;
const heard = nc.subscribe(replyTarget, { callback: (err) => { if (!err) answers++; } });
nc.publish(probeSubject, new Uint8Array(0), { reply: replyTarget });
await nc.flush();

// Wait out the window in which the responder would either answer or die. A fixed wait rather than
// awaiting the reply, for the same reason the counter replaces the iterator.
await new Promise((r) => setTimeout(r, 1_000));

console.log(`ANSWERS ${answers}`);
console.log(`WARNINGS ${warnings}`);
// Reached only by a process that was not ended by the emit. The parent greps for it AND reads the
// exit status, because a process killed after printing would still leave the line behind.
console.log("SURVIVED");
try { heard.unsubscribe(); } catch { /* already done */ }
await nc.drain().catch(() => { /* fine */ });
await ep.stop().catch(() => { /* fine */ });
// Flush before exiting: stdout to a PIPE is asynchronous in Node, so `process.exit` can discard
// lines that were already written, and the parent grades this child by the lines it printed. The
// first version lost its WARNING line this way.
await new Promise<void>((r) => process.stdout.write("", () => r()));
process.exit(0);

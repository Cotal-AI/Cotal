/**
 * Static chat-session pure smoke (no broker, no manager process).
 *
 * SCOPE, stated honestly: this checks the pure rules behind the manager's `chat-session-open` and
 * `chat-session-retire`: the drawn alias shape, how each raw request is read, the open lists under
 * a spawn's rules, the sealed admission payload, the retire ownership guard, the served contract
 * rows and schemas, and the
 * tracker's registration, exact matching and scheduling on a fake clock with a stand-in retire. It
 * does not admit, mint, evict or retire anything. The native open/retire path, the foreign event
 * rule against a drawn actor, the manager's expiry runner and its lifecycle admission, the
 * startup-sweep guard, the stop-time retirement, the leaf's exact grant set and the
 * startAgentActive `chat_` refusal need a live static mesh and are NOT covered here.
 *
 * Run: pnpm smoke:manager-chat-session
 */
import { SealRecipient, isCurvePublicKey, type StaticManagedSlotRow } from "@cotal-ai/core";
import {
  CHAT_ALIAS_PREFIX, CHAT_OPEN_BOUNDS, ChatSessionExpiry, chatOpenLists, chatRetireRefusal, drawChatAlias, isChatAlias, readChatOpenInput, readChatRetireInput,
  sealChatAdmission,
  type ChatExpiryTimers, type ExpiringChatSession,
} from "../src/chat-session.js";
import { MANAGER_CONTRACTS, managerClusterDocument, managerShippedSurface } from "../src/manager-service-contract.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)?.slice(0, 400)); }
}

console.log("1. the manager draws the alias");
{
  const drawn = Array.from({ length: 200 }, () => drawChatAlias());
  check("every drawn alias is chat_ plus 26 base32 characters", drawn.every((a) => /^chat_[a-z2-7]{26}$/.test(a) && isChatAlias(a)), drawn.slice(0, 3));
  check("200 draws are distinct", new Set(drawn).size === drawn.length);
  check("the reserved prefix is chat_", CHAT_ALIAS_PREFIX === "chat_");
  check("an ordinary name, a short chat_ name and an uppercase one are not chat aliases",
    !isChatAlias("reviewer") && !isChatAlias("chat_x") && !isChatAlias(`chat_${"A".repeat(26)}`) && !isChatAlias(`chat_${"a".repeat(27)}`));
}

console.log("2. the open lists follow a spawn's rules");
{
  const sealTo = new SealRecipient().publicKey;
  const lists = (input: { subscribe?: string[]; allowSubscribe?: string[]; allowPublish?: string[]; label?: string; sealTo?: string }) =>
    chatOpenLists({ label: "alice", sealTo, ...input });
  const dmOnly = lists({});
  check("no lists at all is a DM-only session: no initial channels, no read ceiling, no post list",
    !("error" in dmOnly) && dmOnly.subscribe.length === 0 && dmOnly.allowSubscribe.length === 0 && dmOnly.allowPublish.length === 0, dmOnly);
  const fallback = lists({ subscribe: ["general"] });
  check("an empty read ceiling falls back to the initial channels (resolveReadAcl)", !("error" in fallback) && fallback.allowSubscribe.join() === "general", fallback);
  const ceiling = lists({ subscribe: ["general"], allowSubscribe: ["general", "team.>"], allowPublish: ["general"] });
  check("a pattern ceiling is admitted, so the session can join under it", !("error" in ceiling) && ceiling.allowSubscribe.join() === "general,team.>" && ceiling.allowPublish.join() === "general", ceiling);
  check("the post list stays default-deny: a read ceiling grants no post", (() => { const r = lists({ allowSubscribe: ["team.>"] }); return !("error" in r) && r.allowPublish.length === 0; })());
  check("an initial channel outside the ceiling refuses", "error" in lists({ subscribe: ["ops"], allowSubscribe: ["general"] }));
  check("a channel the wire would rewrite refuses in any list",
    "error" in lists({ subscribe: ["foo/bar"] }) && "error" in lists({ allowSubscribe: ["foo/bar"] }) && "error" in lists({ allowPublish: ["foo/bar"] }));
  check("a concrete event channel passes here; the handler applies the foreign event rule against the drawn actor",
    !("error" in lists({ allowSubscribe: ["events.local.UABC"] })));
  check("a blank label refuses", "error" in lists({ label: "   " }));
  check("a sealTo that is not a curve key refuses", "error" in lists({ sealTo: "UABC" }) && "error" in lists({ sealTo: `X${"A".repeat(55)}` }));
}

console.log("2a. each raw request is read field by field before any effect");
{
  const sealTo = new SealRecipient().publicKey;
  const good = { subscribe: ["general"], allowPublish: ["general"], label: "alice", ttl: 900, sealTo };
  const read = readChatOpenInput(good);
  check("a well-formed open is read with every field it carries", !("error" in read) && JSON.stringify(read) === JSON.stringify(good), read);
  check("an open with no lists is read", !("error" in readChatOpenInput({ label: "a", ttl: 1, sealTo })));
  const refusedOpen: [string, unknown][] = [
    ["arguments that are not an object", null], ["a list as the arguments", []],
    ["a missing label", { ttl: 60, sealTo }], ["an empty label", { label: "", ttl: 60, sealTo }], ["a 129-character label", { label: "x".repeat(129), ttl: 60, sealTo }],
    ["a label that is not a string", { label: 5, ttl: 60, sealTo }],
    ["a missing ttl", { label: "a", sealTo }], ["a zero ttl", { label: "a", ttl: 0, sealTo }], ["a 901-second ttl", { label: "a", ttl: 901, sealTo }],
    ["a fractional ttl", { label: "a", ttl: 1.5, sealTo }], ["a ttl given as text", { label: "a", ttl: "60", sealTo }],
    ["a missing sealTo", { label: "a", ttl: 60 }], ["a sealTo that is not a string", { label: "a", ttl: 60, sealTo: 7 }],
    ["a list that is not an array", { subscribe: "general", label: "a", ttl: 60, sealTo }],
    ["a list entry that is not a string", { allowPublish: [1], label: "a", ttl: 60, sealTo }],
    ["an empty list entry", { allowSubscribe: [""], label: "a", ttl: 60, sealTo }],
    ["a repeated list entry", { allowPublish: ["a", "a"], label: "a", ttl: 60, sealTo }],
    ["65 list entries", { allowSubscribe: Array.from({ length: 65 }, (_, i) => `c${i}`), label: "a", ttl: 60, sealTo }],
    ["a caller-supplied actor", { label: "a", ttl: 60, sealTo, actor: "U" }], ["the old channels list", { channels: ["general"], label: "a", ttl: 60, sealTo }],
  ];
  for (const [what, raw] of refusedOpen) {
    const r = readChatOpenInput(raw);
    check(`open refuses ${what}`, "error" in r && r.error.startsWith("chat-session-open: "), r);
  }
  const retire = { alias: drawChatAlias(), actor: "U", lifecycleUid: "a".repeat(26) };
  const readRetire = readChatRetireInput(retire);
  check("a well-formed retire is read", !("error" in readRetire) && JSON.stringify(readRetire) === JSON.stringify(retire), readRetire);
  const refusedRetire: [string, unknown][] = [
    ["arguments that are not an object", "x"], ["a missing actor", { alias: retire.alias, lifecycleUid: retire.lifecycleUid }],
    ["an empty alias", { ...retire, alias: "" }], ["a lifecycleUid that is not a string", { ...retire, lifecycleUid: 1 }], ["an unknown field", { ...retire, ttl: 60 }],
  ];
  for (const [what, raw] of refusedRetire) {
    const r = readChatRetireInput(raw);
    check(`retire refuses ${what}`, "error" in r && r.error.startsWith("chat-session-retire: "), r);
  }
}

console.log("2b. the admission is sealed to sealTo and opens to the closed payload only there");
{
  const recipient = new SealRecipient();
  const admission = {
    space: "s1", managerInstanceId: "i".repeat(26), alias: drawChatAlias(), actor: "UACTOR", lifecycleUid: "a".repeat(26),
    expiresAt: 1_900_000_000_000, sealTo: recipient.publicKey, creds: "-----BEGIN NATS USER JWT-----\nx\n------END NATS USER JWT------",
  };
  const sealed = sealChatAdmission(admission);
  check("the sealer is a one-time curve key and the sealed text carries no credential", isCurvePublicKey(sealed.sealer) && !sealed.sealed.includes("NATS USER JWT"));
  check("another recipient cannot open it", new SealRecipient().openJson(sealed.sealed, sealed.sealer) === undefined);
  const opened = recipient.openJson(sealed.sealed, sealed.sealer) as Record<string, unknown> | undefined;
  check("sealTo opens it to exactly v plus the bound fields and the credential",
    opened !== undefined && Object.keys(opened).sort().join() === "actor,alias,creds,expiresAt,lifecycleUid,managerInstanceId,sealTo,space,v"
    && opened.v === 1 && Object.entries(admission).every(([k, v]) => opened[k] === v), opened);
  check("two seals of one admission use different sender keys", sealChatAdmission(admission).sealer !== sealed.sealer);
}

console.log("3. retire ends only this instance's chat slot at the requested incarnation");
{
  const alias = drawChatAlias();
  const uid = "a".repeat(26);
  const row: StaticManagedSlotRow = {
    owner: "local", alias, actor: "UACTOR", lifecycleUid: uid, managerInstance: "p".repeat(26), ownerInstanceId: "i".repeat(26),
    phase: "active", credentialIds: [],
  };
  const req = { alias, actor: "UACTOR", lifecycleUid: uid };
  check("the owning instance at the same uid and actor may retire", chatRetireRefusal(row, req, "i".repeat(26)) === undefined);
  check("an ordinary alias refuses as permission-denied", chatRetireRefusal(row, { ...req, alias: "reviewer" }, "i".repeat(26))?.code === "permission-denied");
  check("an absent slot refuses as not-found", chatRetireRefusal(undefined, req, "i".repeat(26))?.code === "not-found");
  check("a sibling instance's slot refuses", chatRetireRefusal(row, req, "j".repeat(26))?.code === "failed-precondition");
  const { ownerInstanceId: _legacy, ...legacy } = row;
  check("a legacy row with no recorded owner refuses rather than being adopted", chatRetireRefusal(legacy, req, "i".repeat(26))?.code === "failed-precondition");
  check("another incarnation's uid refuses", chatRetireRefusal(row, { ...req, lifecycleUid: "b".repeat(26) }, "i".repeat(26))?.code === "failed-precondition");
  check("another actor refuses", chatRetireRefusal(row, { ...req, actor: "UOTHER" }, "i".repeat(26))?.code === "failed-precondition");
}

console.log("4. the served contract");
{
  const shipped = managerShippedSurface();
  const doc = managerClusterDocument();
  const rows = doc.commands.filter((c) => c.name.startsWith("chat-session-"));
  check("revision 36 serves chat-session-open and chat-session-retire", shipped.revision === 36 && shipped.names.includes("chat-session-open") && shipped.names.includes("chat-session-retire"));
  check("both rows are untargeted, ephemeral and in the manager.chat class", rows.length === 2 && rows.every((r) => r.targeted === false && r.class === "ephemeral" && r.capability === "manager.chat" && r.modes === undefined), rows);
  const open = MANAGER_CONTRACTS["chat-session-open"];
  const retire = MANAGER_CONTRACTS["chat-session-retire"];
  const sealTo = new SealRecipient().publicKey;
  check("open input admits the three lists, a label, a ttl and sealTo", open.input.validate({ subscribe: ["general"], allowSubscribe: ["team.>"], allowPublish: ["general"], label: "alice", ttl: 900, sealTo }) === true);
  check("open input admits no lists at all", open.input.validate({ label: "alice", ttl: 900, sealTo }) === true);
  check("open input requires sealTo and refuses one that is not a curve key", open.input.validate({ label: "a", ttl: 60 }) === false && open.input.validate({ label: "a", ttl: 60, sealTo: "UABC" }) === false);
  check("open input refuses a caller-supplied alias or actor", open.input.validate({ label: "a", ttl: 60, sealTo, alias: "chat_x" }) === false && open.input.validate({ label: "a", ttl: 60, sealTo, actor: "U" }) === false);
  check("open input refuses the old single channels list", open.input.validate({ channels: ["general"], label: "a", ttl: 60, sealTo }) === false);
  check("open input refuses a ttl beyond the 900-second leaf", open.input.validate({ label: "a", ttl: 901, sealTo }) === false);
  check("open input refuses 65 entries and a duplicate in a list", open.input.validate({ allowSubscribe: Array.from({ length: 65 }, (_, i) => `c${i}`), label: "a", ttl: 60, sealTo }) === false && open.input.validate({ allowPublish: ["a", "a"], label: "a", ttl: 60, sealTo }) === false);
  check("open input refuses a 129-character label", open.input.validate({ label: "x".repeat(129), ttl: 60, sealTo }) === false);
  const { listItems, labelLength, ttlSec } = CHAT_OPEN_BOUNDS;
  const atBounds = { allowSubscribe: Array.from({ length: listItems }, (_, i) => `c${i}`), label: "x".repeat(labelLength), ttl: ttlSec, sealTo };
  check("the request reader's bounds are the served schema's",
    open.input.validate(atBounds) === true && !("error" in readChatOpenInput(atBounds))
    && open.input.validate({ ...atBounds, ttl: ttlSec + 1 }) === false && open.input.validate({ ...atBounds, label: "x".repeat(labelLength + 1) }) === false
    && open.input.validate({ ...atBounds, allowSubscribe: [...atBounds.allowSubscribe, "extra"] }) === false);
  const alias = drawChatAlias();
  const base = { alias, actor: "U", lifecycleUid: "a".repeat(26), expiresAt: 1, sealer: new SealRecipient().publicKey, sealed: "c2VhbGVk" };
  const { sealed: _sealed, ...unsealed } = base;
  check("open output requires the public fields, sealer and sealed, and nothing else",
    open.output.validate(base) === true
    && open.output.validate(unsealed) === false
    && open.output.validate({ ...base, role: "x" }) === false);
  check("open output refuses a credential in the clear", open.output.validate({ ...base, creds: "c" }) === false);
  check("retire input refuses an ordinary alias at the schema", retire.input.validate({ alias: "reviewer", actor: "U", lifecycleUid: "a".repeat(26) }) === false);
  check("retire output admits only the three outcomes", retire.output.validate({ outcome: "retired" }) === true && retire.output.validate({ outcome: "failed", reason: "retirement pending: x" }) === true && retire.output.validate({ outcome: "notStarted" }) === false);
}

console.log("5. the expiry tracker retires what this process admitted, at its expiry, boundedly");
{
  // A fake clock: timers fire only when `advance` passes them, and each firing lets the promise
  // chains it starts settle before the next one.
  let now = 1_000_000;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: ChatExpiryTimers = {
    now: () => now,
    set: (fn, ms) => { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
    clear: (handle) => { pending.delete(handle as number); },
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = until;
    await settle();
  };
  // The stand-in retire records each call and settles only when the check says so.
  const calls: Array<{ uid: string; resolve: () => void; reject: (e: Error) => void }> = [];
  const lines: string[] = [];
  const expiry = new ChatSessionExpiry(
    (session) => new Promise<void>((resolve, reject) => { calls.push({ uid: session.lifecycleUid, resolve, reject }); }),
    { retryDelaysMs: [1_000, 5_000, 30_000], concurrency: 2, log: (line) => lines.push(line), timers },
  );
  const session = (uid: string, inMs: number): ExpiringChatSession =>
    ({ alias: drawChatAlias(), actor: `U${uid}`, lifecycleUid: uid.repeat(26), channels: ["general"], expiresAt: now + inMs });
  const callsFor = (uid: string) => calls.filter((c) => c.uid === uid.repeat(26));
  const admit = (s: ExpiringChatSession): void => { expiry.register(s); expiry.arm(s.lifecycleUid); };

  const opening = session("o", 1_000);
  expiry.register(opening);
  check("a registered opening is held at its exact alias, actor and uid before anything is scheduled",
    expiry.holdsExact(opening) && pending.size === 0);
  check("another alias, actor or uid at that slot is not held",
    !expiry.holdsExact({ ...opening, alias: drawChatAlias() }) && !expiry.holdsExact({ ...opening, actor: "UOTHER" }) && !expiry.holdsExact({ ...opening, lifecycleUid: "z".repeat(26) }));
  let dup = false;
  try { expiry.register(opening); } catch { dup = true; }
  check("registering the same uid twice refuses", dup);
  await advance(5_000);
  check("an opening that was never armed never retires on a timer", callsFor("o").length === 0);
  expiry.forget(opening.lifecycleUid);

  const a = session("a", 10_000);
  admit(a);
  expiry.arm(a.lifecycleUid);
  check("arming twice keeps one timer", pending.size === 1 && expiry.holdsExact(a));
  check("a tracked session exposes its admitted channels", expiry.channels(a.lifecycleUid)?.join() === "general");
  await advance(9_999);
  check("nothing retires before the expiry", calls.length === 0);
  await advance(1);
  check("the expiry starts one retirement", callsFor("a").length === 1);
  callsFor("a")[0]!.resolve();
  await settle();
  check("a confirmed retirement ends the tracking", !expiry.holdsExact(a) && pending.size === 0);

  const b = session("b", 5_000);
  admit(b);
  expiry.forget(b.lifecycleUid);
  await advance(10_000);
  check("a forgotten session is never retired and leaves no timer", callsFor("b").length === 0 && pending.size === 0 && !expiry.holdsExact(b));

  const late = session("c", -60_000);
  admit(late);
  await advance(0);
  check("a session already past its expiry retires at once", callsFor("c").length === 1);
  callsFor("c")[0]!.resolve();
  await settle();

  const burst = ["d", "e", "f", "g", "h"].map((uid) => session(uid, 1_000));
  for (const s of burst) admit(s);
  await advance(1_000);
  const inFlight = () => calls.filter((c) => burst.some((s) => s.lifecycleUid === c.uid)).length;
  check("a burst of expiries runs at most `concurrency` retirements at once", inFlight() === 2, inFlight());
  callsFor("d")[0]!.resolve();
  await settle();
  check("a finished retirement lets the next waiting one start", inFlight() === 3, inFlight());
  for (const uid of ["e", "f"]) callsFor(uid)[0]!.resolve();
  await settle();
  for (const uid of ["g", "h"]) callsFor(uid)[0]!.resolve();
  await settle();
  check("every session of the burst was retired once", burst.every((s) => calls.filter((c) => c.uid === s.lifecycleUid).length === 1 && !expiry.holdsExact(s)));

  const failing = session("i", 1_000);
  admit(failing);
  await advance(1_000);
  callsFor("i")[0]!.reject(new Error("eviction not verified"));
  await settle();
  check("a failed retirement stays tracked and retries after the first delay", expiry.holdsExact(failing) && callsFor("i").length === 1);
  await advance(999);
  check("no retry runs before its delay", callsFor("i").length === 1);
  await advance(1);
  check("the retry runs at its delay", callsFor("i").length === 2);
  callsFor("i")[1]!.reject(new Error("eviction not verified"));
  await settle();
  await advance(5_000);
  callsFor("i")[2]!.reject(new Error("eviction not verified"));
  await settle();
  await advance(30_000);
  callsFor("i")[3]!.reject(new Error("eviction not verified"));
  await settle();
  check("after every delay is spent the session stays held for a retire or the stop, and the log says so",
    callsFor("i").length === 4 && expiry.holdsExact(failing) && pending.size === 0 && expiry.remaining().some((s) => s.lifecycleUid === failing.lifecycleUid)
    && lines.some((l) => l.includes(failing.alias) && l.includes("stays held")), lines);
  expiry.forget(failing.lifecycleUid);

  const forgottenInFlight = session("j", 1_000);
  admit(forgottenInFlight);
  await advance(1_000);
  expiry.forget(forgottenInFlight.lifecycleUid);
  callsFor("j")[0]!.reject(new Error("raced an explicit retire"));
  await settle();
  check("a retirement whose session was forgotten mid-flight is not retried", callsFor("j").length === 1 && pending.size === 0 && !expiry.holdsExact(forgottenInFlight));

  const waiting = session("k", 60_000);
  const running = session("l", 1_000);
  const stillOpening = session("n", 60_000);
  admit(waiting);
  admit(running);
  expiry.register(stillOpening);
  await advance(1_000);
  expiry.stop();
  check("stop clears every timer and keeps every tracked session for the stop to retire",
    pending.size === 0 && [waiting, running, stillOpening].every((s) => expiry.holdsExact(s) && expiry.remaining().some((r) => r.lifecycleUid === s.lifecycleUid)));
  callsFor("l")[0]!.reject(new Error("stopping"));
  await settle();
  await advance(60_000);
  check("after stop nothing retries or fires, and a failed running retirement stays held",
    callsFor("l").length === 1 && callsFor("k").length === 0 && pending.size === 0 && expiry.holdsExact(running));
  let refusedRegister = false;
  try { expiry.register(session("m", 1_000)); } catch { refusedRegister = true; }
  let refusedArm = false;
  try { expiry.arm(stillOpening.lifecycleUid); } catch { refusedArm = true; }
  check("a stopped tracker refuses a new session and refuses to schedule an opening", refusedRegister && refusedArm && expiry.holdsExact(stillOpening));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

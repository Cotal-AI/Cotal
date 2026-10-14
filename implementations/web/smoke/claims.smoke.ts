/** An anycast message carries no claim on the wire, so the dashboard names a claimer only when a later
 *  message's replyTo names the anycast message. It names the claimer by id; the roster gives the name. */
import { strict as assert } from "node:assert";
import type { CotalMessage } from "../client/src/api/types.js";
import { claimedBy } from "../client/src/lib/claims.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

/** A chat message from `fromId` named `fromName`, replying to `replyTo` when that is not undefined (so "" is expressible). */
const msg = (id: string, fromId: string, fromName: string, replyTo?: string): CotalMessage =>
  ({ id, ts: 1, space: "s", from: { id: fromId, name: fromName }, parts: [], kind: "channel", channel: "c", ...(replyTo !== undefined ? { replyTo } : {}) }) as unknown as CotalMessage;

ok("no later messages gives no claim", claimedBy("a1", []) === undefined);
ok("later messages that reply to nothing give no claim", claimedBy("a1", [{ msg: msg("m1", "p1", "ana"), senderId: "p1" }]) === undefined);
ok("a reply to another message is ignored", claimedBy("a1", [{ msg: msg("m1", "p1", "ana", "other"), senderId: "p1" }]) === undefined);
ok("a reply whose replyTo is the id gives its sender", claimedBy("a1", [{ msg: msg("m1", "p1", "ana", "a1"), senderId: "p1" }]) === "p1");
ok("a reply to another message before the reply is skipped", claimedBy("a1", [
  { msg: msg("m1", "p1", "ana", "other"), senderId: "p1" },
  { msg: msg("m2", "p2", "bo", "a1"), senderId: "p2" },
]) === "p2");
ok("the first of two replies wins", claimedBy("a1", [
  { msg: msg("m1", "p1", "ana", "a1"), senderId: "p1" },
  { msg: msg("m2", "p2", "bo", "a1"), senderId: "p2" },
]) === "p1");
ok("the authenticated senderId wins over the payload's from.id", claimedBy("a1", [{ msg: msg("m1", "payload-id", "ana", "a1"), senderId: "real-id" }]) === "real-id");
ok("from.id answers only when senderId is absent", claimedBy("a1", [{ msg: msg("m1", "p1", "ana", "a1") }]) === "p1");
const named = claimedBy("a1", [{ msg: msg("m1", "p1", "ana", "a1"), senderId: "p1" }]);
ok("the answer is the id", named === "p1", named);
ok("the answer is never the display name", named !== "ana", named);
ok("an empty anycast id claims nothing, even for messages with no replyTo", claimedBy("", [{ msg: msg("m1", "p1", "ana"), senderId: "p1" }]) === undefined);
ok("an empty anycast id claims nothing, even for a reply to \"\"", claimedBy("", [{ msg: msg("m1", "p1", "ana", ""), senderId: "p1" }]) === undefined);
ok("an undefined anycast id claims nothing", claimedBy(undefined as unknown as string, [{ msg: msg("m1", "p1", "ana"), senderId: "p1" }]) === undefined);
console.log(`claims: ${n} checks passed`);

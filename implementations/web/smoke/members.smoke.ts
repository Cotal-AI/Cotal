/** Who is in a channel: the broker membership feed when it is authoritative, else the senders of the
 *  channel's posts. Each answer says which one it is, so the pill and the list never disagree. */
import type { CotalMessage, MembershipSnapshot } from "../client/src/api/types.js";
import { channelMembers } from "../client/src/lib/members.js";

let cells = 0, failed = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  cells++;
  if (cond) return console.log(`  ok ${cells} ${name}`);
  failed++;
  console.log(`  x FAIL ${cells} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

const entry = (id: string, live: string[], durable: string[] = []) => ({ id, live, durable, observedAt: 1 });
/** A snapshot with a heartbeat, or with none when `asOf` is null. */
const snap = (members: ReturnType<typeof entry>[], asOf: number | null = 1000): MembershipSnapshot => ({ ...(asOf !== null ? { asOf } : {}), members });
const post = (channel: string, fromId: string, senderId?: string) =>
  ({ ...(senderId !== undefined ? { senderId } : {}), msg: { id: "m", ts: 1, space: "s", from: { id: fromId, name: "x" }, parts: [], channel } as unknown as CotalMessage });
const ids = (r: { id: string }[]) => r.map((m) => m.id).sort();
const KNOWN = ["team.backend", "team.web", "alerts", "ops"];

// 1. an authoritative snapshot
const feed = { snapshot: snap([
  entry("wild", ["team.>"]),
  entry("exact", ["alerts"]),
  entry("dur", [], ["ops"]),
  entry("other", ["ops"]),
]) };
const inBackend = channelMembers("team.backend", feed, KNOWN, []);
ok("a live wildcard that matches the channel is a member", ids(inBackend).includes("wild"), inBackend);
ok("a reader of another channel is not a member", !ids(inBackend).includes("exact") && !ids(inBackend).includes("other"), inBackend);
ok("every member of an authoritative feed has source membership", inBackend.length > 0 && inBackend.every((m) => m.source === "membership"), inBackend);
ok("a concrete live subscription makes a member", ids(channelMembers("alerts", feed, KNOWN, [])).join() === "exact", channelMembers("alerts", feed, KNOWN, []));
ok("a durable member counts", ids(channelMembers("ops", feed, KNOWN, [])).join() === "dur,other", channelMembers("ops", feed, KNOWN, []));
ok("a bounded wildcard does not match the bare prefix", !ids(channelMembers("team", feed, [...KNOWN, "team"], [])).includes("wild"));
ok("a wildcard still matches a channel the known list lacks", ids(channelMembers("team.new", feed, KNOWN, [])).includes("wild"));
ok("an authoritative feed with nobody in the channel gives nobody, whatever was posted",
  channelMembers("quiet", feed, [...KNOWN, "quiet"], [post("quiet", "talker", "talker")]).length === 0);

// 2. a `>` reader is in every channel
const wide = { snapshot: snap([entry("reader", [">"]), entry("star", ["*"])]) };
for (const ch of ["team.backend", "alerts", "ops"]) {
  ok(`a > reader is a member of ${ch}`, ids(channelMembers(ch, wide, KNOWN, [])).includes("reader"), channelMembers(ch, wide, KNOWN, []));
}
ok("a * reader is a member of a channel too", ids(channelMembers("alerts", wide, KNOWN, [])).includes("star"), channelMembers("alerts", wide, KNOWN, []));

// 3. a member appears once
const twice = { snapshot: snap([entry("both", ["alerts", "team.>"], ["alerts", "team.web"]), entry("both", ["alerts"])]) };
ok("a member matched by live and durable appears once", channelMembers("alerts", twice, KNOWN, []).length === 1, channelMembers("alerts", twice, KNOWN, []));
ok("a member matched by two live patterns appears once", channelMembers("team.web", twice, KNOWN, []).length === 1, channelMembers("team.web", twice, KNOWN, []));
ok("a member listed twice in the snapshot appears once", channelMembers("alerts", twice, KNOWN, []).length === 1);

// 4. no authoritative feed: traffic
const posts = [post("alerts", "p1", "p1"), post("ops", "p2", "p2"), post("alerts", "payload-claim", "p3"), post("alerts", "p1", "p1"), post("alerts", "p4")];
for (const [name, m] of [
  ["an absent feed", {}],
  ["an unreadable feed with no snapshot", { unreadable: "read failed" }],
  ["an unreadable feed that still holds the last snapshot", { snapshot: snap([entry("stale", ["alerts"])]), unreadable: "read failed" }],
  ["a snapshot with no heartbeat and no member", { snapshot: snap([], null) }],
] as const) {
  const r = channelMembers("alerts", m, KNOWN, posts);
  ok(`${name} gives the distinct senders of the channel's posts`, ids(r).join() === "p1,p3,p4", r);
  ok(`${name} marks them traffic`, r.length > 0 && r.every((x) => x.source === "traffic"), r);
}
ok("a post names its sender by senderId, not by the payload's from.id", !ids(channelMembers("alerts", {}, KNOWN, posts)).includes("payload-claim"));
ok("from.id answers only when senderId is absent", ids(channelMembers("alerts", {}, KNOWN, posts)).includes("p4"));
ok("posts to other channels name no member", !ids(channelMembers("alerts", {}, KNOWN, posts)).includes("p2"));
ok("no posts and no feed gives nobody", channelMembers("alerts", {}, KNOWN, []).length === 0);
ok("a blank sender id is not a member", channelMembers("alerts", {}, KNOWN, [post("alerts", "")]).length === 0);

console.log(`members: ${cells - failed}/${cells} checks passed`);
if (failed) process.exit(1);

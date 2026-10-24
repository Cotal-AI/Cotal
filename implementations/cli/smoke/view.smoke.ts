/**
 * MeshView smoke test (no NATS, no test runner) — run with: pnpm smoke:view
 *
 * Drives a mock observer endpoint through MeshView and asserts the normalization the surfaces
 * depend on: delivery classification, same-sender/same-text unicast burst coalescing, the
 * status-sorted roster split, and the derived operator signals (counts + DM roll-up).
 */
import { EventEmitter } from "node:events";
import { renderReport } from "@cotal-ai/workspace";
import { MeshView } from "../src/view/mesh-view.js";
import { runLog } from "../src/render.js";
import { feedLine, observedText, watchReport, WATCH_TEXT_LIMIT } from "../src/watch-data.js";
import {
  chatSubject,
  unicastSubject,
  anycastSubject,
  DEV_OWNER,
  type CotalEndpoint,
  type CotalMessage,
  type Presence,
} from "@cotal-ai/core";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

const space = "view-test";
const ids = { alice: "ID_ALICE", bob: "ID_BOB", carol: "ID_CAROL", con: "ID_CON" };

function presence(id: string, name: string, kind: "agent" | "endpoint", status: Presence["status"]): Presence {
  return { card: { id, name, kind, role: name }, status, ts: Date.now() };
}
const roster: Presence[] = [
  presence(ids.alice, "alice", "agent", "working"),
  presence(ids.bob, "bob", "agent", "waiting"),
  presence(ids.carol, "carol", "agent", "idle"),
  presence(ids.con, "console", "endpoint", "idle"),
];

type Routing = { channel: string } | { to: string } | { toService: string };
function msg(from: string, fromName: string, target: Routing, text: string, id: string): CotalMessage {
  return {
    id,
    ts: Date.now(),
    space,
    from: { id: from, name: fromName, role: fromName },
    parts: [{ kind: "text", text }],
    ...target,
  };
}

// ---- a mock observer endpoint: captures the tap, replays roster on demand ----
class MockEndpoint extends EventEmitter {
  readonly space = space;
  tapHandler?: (subject: string, m: CotalMessage | undefined) => void;
  history: CotalMessage[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getRoster(): Presence[] {
    return roster;
  }
  tap(handler: (subject: string, m: CotalMessage | undefined) => void): void {
    this.tapHandler = handler;
  }
  async listChannels(): Promise<{ channel: string; messages: number }[]> {
    return [];
  }
  async channelHistory(): Promise<CotalMessage[]> {
    return [];
  }
  async dmHistory(): Promise<CotalMessage[]> {
    return this.history;
  }
}

const mock = new MockEndpoint();
const view = new MeshView(mock as unknown as CotalEndpoint);
const warnings: string[] = [];
view.on("warning", (e: Error) => warnings.push(e.message));
await view.start();
mock.emit("warning", new Error("creds refresh failed - retrying"));

const tap = mock.tapHandler!;
// multicast + anycast pass through immediately; the unicast burst (same sender+text, 3
// recipients) coalesces into ONE entry over the 400ms window.
tap(chatSubject(space, DEV_OWNER, ids.alice, "general"), msg(ids.alice, "alice", { channel: "general" }, "hello team", "m1"));
tap(anycastSubject(space, "reviewer", DEV_OWNER, ids.alice), msg(ids.alice, "alice", { toService: "reviewer" }, "review pls", "m2"));
tap(unicastSubject(space, DEV_OWNER, ids.bob, DEV_OWNER, ids.alice), msg(ids.alice, "alice", { to: ids.bob }, "ping", "m3"));
tap(unicastSubject(space, DEV_OWNER, ids.carol, DEV_OWNER, ids.alice), msg(ids.alice, "alice", { to: ids.carol }, "ping", "m4"));
tap(unicastSubject(space, DEV_OWNER, ids.bob, DEV_OWNER, ids.alice), msg(ids.alice, "alice", { to: ids.bob }, "ping", "m5"));
// a control frame → deliveryOf null → must NOT enter the feed
tap(`cotal.${space}.ctl.manager.${DEV_OWNER}.${ids.alice}`, msg(ids.alice, "alice", { to: ids.bob }, "ignored", "m6"));

await wait(550); // let the unicast burst flush
const s = view.snapshot();

const chat = s.feed.find((e) => e.id === "m1");
const any = s.feed.find((e) => e.id === "m2");
const uni = s.feed.find((e) => e.delivery === "unicast");

check("feed has exactly 3 entries (control dropped, burst coalesced)", s.feed.length === 3);
check("multicast classified with channel", chat?.delivery === "multicast" && chat?.channel === "general");
check("anycast classified with service", any?.delivery === "anycast" && any?.toService === "reviewer");
check("unicast burst coalesced to one entry, count 3", uni?.count === 3);
check("unicast targets retain authoritative ids", uni?.toIds?.join(",") === [ids.bob, ids.carol, ids.bob].join(","));
check("unicast targets resolved to names", !!uni?.toNames?.includes("bob") && !!uni?.toNames?.includes("carol"));

check("roster split: 3 agents, 1 endpoint", s.agents.length === 3 && s.endpoints.length === 1);
check("agents status-sorted (working first, idle last)", s.agents[0].card.name === "alice" && s.agents[2].card.name === "carol");
check(
  "signals.counts over agents only",
  s.signals.counts.working === 1 && s.signals.counts.waiting === 1 && s.signals.counts.idle === 1 && s.signals.counts.offline === 0,
);
check("signals.waiting surfaces the blocked agent", s.signals.waiting.length === 1 && s.signals.waiting[0].card.name === "bob");
const watchRoster = renderReport(watchReport(s, "roster"), "plain", 200).split("\n");
check("the watch roster names a working agent's progress as unknown", watchRoster.some((line) => /\balice\b.*working - progress unknown/.test(line)) && !watchRoster.some((line) => /\bbob\b.*progress unknown/.test(line)));
{
  // A message past the row bound is cut, and the line says how much it lost and which read shows it whole.
  const long = `${"x".repeat(200_000)}END-MARK`;
  const from = { id: ids.alice, name: "alice" };
  const post = { id: "long", ts: Date.now(), from, delivery: "multicast" as const, channel: "general", text: long };
  const cut = observedText(long);
  const lost = long.length - WATCH_TEXT_LIMIT;
  const marker = (line: string) => line.match(/ \[(\d+) text code units not shown(.*)\]$/);
  const whole = marker(feedLine(post));
  const row = marker(feedLine({ ...post, text: cut.text, omittedCodeUnits: cut.omittedCodeUnits }));
  const dm = marker(feedLine({ ...post, delivery: "unicast", channel: undefined, toIds: [ids.bob], text: cut.text, omittedCodeUnits: cut.omittedCodeUnits }));
  check("a watch line cut at the row bound names the code units not shown and the history read that shows it whole",
    whole?.[1] === String(lost) && whole[2] === "; cotal history general shows it whole" && !feedLine(post).includes("END-MARK"));
  check("a stream row already cut keeps the count it lost", row?.[1] === String(lost) && row[2] === "; cotal history general shows it whole");
  check("a cut direct message points at cotal history --dms", dm?.[1] === String(lost) && dm[2] === "; cotal history --dms shows it whole");
  check("control: a message within the bound has no marker", marker(feedLine({ ...post, text: "short" })) === null);
}

const aliceDm = s.signals.dms.find((p) => p.name === "alice");
check("DM roll-up: alice has 2 conversations (bob, carol)", aliceDm?.conversations.length === 2);
check("DM roll-up: 3 peers total (alice, bob, carol)", s.signals.dms.length === 3);
check("status bar: dmVisible true (open tap)", s.status.dmVisible === true && s.status.space === space);
check(
  "MeshView's own warning listener reaches the model and stream event",
  s.status.warning === "creds refresh failed - retrying" && warnings[0] === "creds refresh failed - retrying",
);

// A DM whose payload forges ANOTHER peer's display name and role (issue #1399): the authenticated
// id is alice's, the payload says name "carol" / role "admin". Identity must follow the id, so
// the name map, the conversation key and the rendered role all come from the roster.
const spoof = msg(ids.alice, "carol", { to: ids.bob }, "forged line", "m7");
tap(unicastSubject(space, DEV_OWNER, ids.bob, DEV_OWNER, ids.alice), spoof);
await wait(50); // recordDm lands on the ingest path, no burst wait needed for the roll-up
const s2 = view.snapshot();
const s2Alice = s2.signals.dms.find((p) => p.name === "alice");
const s2Bob = s2.signals.dms.find((p) => p.name === "bob");
check(
  "tap spoof: nameOf keeps the roster name for the authenticated id",
  s2.nameOf(ids.alice) === "alice",
);
check(
  "tap spoof: the line lands in the alice<->bob thread with roster names",
  s2Alice?.conversations.some((c) => c.with === "bob" && c.messages.some((m) => m.from === "alice" && m.to === "bob" && m.text === "forged line")) === true,
);
check(
  "tap spoof: the forged line never lands in a carol-keyed conversation (payload name cannot re-key a thread)",
  !s2.signals.dms.some((p) => p.conversations.some((c) => c.with === "carol" && c.messages.some((m) => m.text === "forged line"))),
);
check(
  "tap spoof: the peer row keeps the roster role, not the payload 'admin'",
  s2Alice?.role === "alice" && s2Bob?.role === "bob",
);

// Same message through dmHistory (the prefill path): the history row must not poison the map
// either. `presence()` sets role = name, so a roster role of "bob" for bob is the expected truth.
// The history row reuses the LIVE row's ts so the sender+recipient+ts dedup key matches; a
// distinct ts would pass dedup for a reason that has nothing to do with this issue.
const liveForgedTs = s2.signals.dms
  .flatMap((p) => p.conversations)
  .flatMap((c) => c.messages)
  .find((m) => m.text === "forged line")!.ts;
mock.history = [{ ...spoof, ts: liveForgedTs }];
await (view as unknown as { prefillDms(): Promise<void> }).prefillDms();
const s3 = view.snapshot();
const s3Alice = s3.signals.dms.find((p) => p.name === "alice");
check("prefill spoof: nameOf still the roster name after dmHistory", s3.nameOf(ids.alice) === "alice");
check(
  "prefill spoof: still the alice<->bob thread, the history copy dedups, never carol",
  s3Alice?.conversations.some((c) => c.with === "bob" && c.messages.some((m) => m.from === "alice" && m.to === "bob")) === true
    && !s3.signals.dms.some((p) => p.conversations.some((c) => c.with === "carol" && c.messages.some((m) => m.text === "forged line")))
    // both peer rows share one conversation's messages array, so count inside alice's row only
    && s3Alice?.conversations.flatMap((c) => c.messages).filter((m) => m.text === "forged line").length === 1,
);

await view.stop();

// ---- stop after the connection is closed for good ----
{
  // The real endpoint keeps a membership watch's own stop pending until its broker consumer is
  // deleted, which a closed connection cannot do, and settles it from the endpoint's own stop.
  class ClosedForGood extends MockEndpoint {
    private settle?: () => void;
    async readMembership(): Promise<{ asOf: undefined; members: [] }> {
      return { asOf: undefined, members: [] };
    }
    async watchMembership(): Promise<{ stop(): Promise<void> }> {
      return { stop: () => new Promise<void>((resolve) => { this.settle = resolve; }) };
    }
    override async stop(): Promise<void> {
      this.settle?.();
    }
  }
  const closed = new MeshView(new ClosedForGood() as unknown as CotalEndpoint);
  await closed.start();
  await wait(20);
  const stopped = await Promise.race([closed.stop().then(() => true), wait(2_000).then(() => false)]);
  check("stop returns when only the endpoint's stop settles the membership watch (Ctrl-C after the connection is gone)", stopped);
}

// ---- the line stream (console --plain and pipes): ASCII on --plain and under a non-UTF-8 locale ----
/** The lines one runLog prints for a join and two feed entries, under `LC_ALL=locale`. */
async function streamLines(plain: boolean, locale: string): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  const prior = process.env.LC_ALL;
  const ep = new MockEndpoint();
  process.env.LC_ALL = locale;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ").replace(/\x1b\[[0-9;]*m/g, "")); };
  try {
    void runLog(ep as unknown as CotalEndpoint, space, undefined, plain);
    await wait(20);
    ep.emit("presence", { type: "join", presence: roster[0] });
    ep.tapHandler!(chatSubject(space, DEV_OWNER, ids.alice, "general"), msg(ids.alice, "alice", { channel: "general" }, "a → b", "p1"));
    for (const [to, id] of [[ids.bob, "p2"], [ids.carol, "p3"], [ids.bob, "p4"]] as const)
      ep.tapHandler!(unicastSubject(space, DEV_OWNER, to, DEV_OWNER, ids.alice), msg(ids.alice, "alice", { to }, "ping", id));
    await wait(550);
  } finally {
    console.log = log;
    if (prior === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prior;
  }
  return lines;
}
for (const [what, plain, locale] of [["--plain under a UTF-8 locale", true, "C.UTF-8"], ["a pipe under LC_ALL=C", false, "C"]] as const) {
  const text = (await streamLines(plain, locale)).join("\n");
  check(`line stream on ${what} is ASCII: no status marks, -> for the arrow, x for a count`,
    !/[^\x00-\x7F]/.test(text) && /alice\/alice working - progress unknown/.test(text) && /alice\/alice -> #general: a -> b/.test(text) && /\(3x\)/.test(text));
}
{
  const text = (await streamLines(false, "C.UTF-8")).join("\n");
  check("control: a pipe under a UTF-8 locale draws the status mark, the arrow and the count sign",
    /● working · progress unknown/.test(text) && /alice\/alice → #general: a → b/.test(text) && /\(3×\)/.test(text));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

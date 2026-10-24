/**
 * Channel discovery and addressing feedback, driven through the real cotal_* tool specs on real
 * MeshAgents over their OWN nats-server.
 *
 * A live mesh listed 656 channels, 457 of them agents' event channels, in one 52 KB cotal_channels
 * reply with no filter and no way to continue. It described a session's own event channel as one a
 * prior send "may have invented", refused a self-DM as "no peer", refused a human's base name with
 * no pointer to the full name it carries, and stored a role request nobody held with no word on
 * what happens to it.
 *
 * Proves:
 *   - cotal_channels lists the channels the session is on or may join by default, and counts the
 *     event channels and the channels outside its read ACL it leaves out; all: true lists them;
 *   - filter narrows by name, and a list longer than one reply ends with the after value that
 *     continues it, so every channel is reachable once and only once;
 *   - an event channel is described as one, the session's own as its own, and an ordinary
 *     unregistered channel keeps its registry wording;
 *   - a self-DM says it names this session, and nothing is sent;
 *   - a base name lists the present full names that start with it and sends nothing, and only the
 *     full name delivers;
 *   - a request to a role nobody holds says it waits on the queue, and the next holder of that role
 *     receives it.
 *
 * Run: pnpm smoke:discovery-addressing
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventChannel, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "discoverysmoke";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// Every seat reads team and team.>; ops.private is outside that read ACL.
const configFor = (name: string, role?: string): AgentConfig => ({
  space,
  name,
  ...(role ? { role } : {}),
  servers,
  subscribe: ["team"],
  allowSubscribe: ["team", "team.>"],
  allowPublish: [">"],
  kind: "agent",
  tls: false,
  id: `${name.replace(/[^A-Za-z0-9_]/g, "_")}_${randomUUID().slice(0, 8)}`,
  lifecycleUid: mintLifecycleUid(),
});

const agents: MeshAgent[] = [];
const connectSeat = async (name: string, role?: string) => {
  const config = configFor(name, role);
  const agent = new MeshAgent(config);
  agent.on("error", () => {});
  agents.push(agent);
  agent.start();
  for (let i = 0; i < 80 && !agent.connected; i++) await sleep(100);
  if (!agent.connected) throw new Error(`${name} did not connect`);
  return { agent, config };
};
type Seat = Awaited<ReturnType<typeof connectSeat>>;
const run = async (seat: Seat, tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
  const spec = cotalToolSpecs(seat.config, "smoke").find((s) => s.name === tool);
  if (!spec) throw new Error(`no ${tool}`);
  const r = await spec.run(seat.agent, seat.config, args);
  return { text: r.text, isError: r.isError === true };
};
const rowsOf = (text: string) => text.split("\n").filter((l) => /^[●○] #/.test(l)).map((l) => /^[●○] #(\S+)/.exec(l)![1]);
const until = async (cond: () => boolean | Promise<boolean>, ms = 6000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await cond()) return true;
    await sleep(100);
  }
  return false;
};

let failure: unknown;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  const me = await connectSeat("scout", "default");
  const human = await connectSeat("ada-lovelace (web)");
  await until(() => me.agent.roster().some((p) => p.card.name === "ada-lovelace (web)"));

  // ---- traffic: 120 readable channels, 40 event channels, one outside the read ACL ----
  const readable = Array.from({ length: 120 }, (_, i) => `team.lane${String(i).padStart(3, "0")}`);
  const events = Array.from({ length: 40 }, (_, i) => eventChannel({ owner: "u_otherowner", actor: `seat_${i}` }));
  const own = eventChannel(me.agent.ep.principal);
  for (const channel of [...readable, ...events, own, "ops.private"]) {
    const sent = await run(me, "cotal_send", { channel, text: "traffic" });
    if (sent.isError) throw new Error(`send to ${channel}: ${sent.text}`);
  }
  await until(async () => (await me.agent.listChannels()).length >= 120 + 40 + 1 + 1);

  // ---- cotal_channels ----
  const first = await run(me, "cotal_channels");
  const firstRows = rowsOf(first.text);
  check("the default list holds no event channel and nothing outside the read ACL", firstRows.every((c) => c.startsWith("team")), firstRows);
  check("one reply lists at most 100 rows", firstRows.length === 100, firstRows.length);
  check(
    "the default list counts what it leaves out",
    first.text.includes("Not listed: 41 agent event channels (each agent's activity stream, not chat) and 1 channel outside your read ACL. Pass all: true to list them too."),
    first.text.split("\n").slice(-3),
  );
  const cursor = /after: ("[^"]+")/.exec(first.text)?.[1];
  check("a cut list names the after value that continues it", first.text.includes("Listed 100 of 120.") && cursor === JSON.stringify(firstRows[99]), first.text.split("\n").slice(-2));
  const second = await run(me, "cotal_channels", { after: JSON.parse(cursor!) });
  const secondRows = rowsOf(second.text);
  const together = [...firstRows, ...secondRows];
  check(
    "continuing reaches every listed channel once",
    new Set(together).size === together.length && together.length === 120 && readable.every((c) => together.includes(c)),
    { first: firstRows.length, second: secondRows },
  );
  check("the last page offers no further continuation", !second.text.includes("To continue"), second.text.split("\n").slice(-2));

  const all = await run(me, "cotal_channels", { all: true, filter: "events." });
  const allRows = rowsOf(all.text);
  check("all: true lists the event channels", allRows.length === 41 && allRows.includes(own) && events.every((c) => allRows.includes(c)), allRows.length);
  check("the session's own event channel is labelled as its own", all.text.includes(`#${own} — your own event channel (`), all.text);
  check("another agent's event channel is labelled as an agent's", all.text.includes(`#${events[0]} — an agent's event channel (`), all.text);
  const outside = await run(me, "cotal_channels", { all: true, filter: "ops" });
  check("all: true lists a channel outside the read ACL", rowsOf(outside.text).join() === "ops.private", outside.text);
  const filtered = await run(me, "cotal_channels", { filter: "LANE11" });
  check("filter matches part of a name, ignoring case", rowsOf(filtered.text).join() === readable.slice(110, 120).join(), rowsOf(filtered.text));
  const none = await run(me, "cotal_channels", { filter: "seat_" });
  check(
    "a filter that matches only left-out channels says so and how to see them",
    rowsOf(none.text).length === 0 && none.text.includes('No channels in "discoverysmoke" to list matching "seat_".') && none.text.includes("Not listed: 40 agent event channels"),
    none.text,
  );

  // ---- cotal_channel_info ----
  const ownInfo = await run(me, "cotal_channel_info", { channel: own });
  check("own event channel is described as this session's, not as invented", ownInfo.text.includes("your own event channel") && !ownInfo.text.includes("invented"), ownInfo.text);
  const otherInfo = await run(me, "cotal_channel_info", { channel: events[0] });
  check("another agent's event channel is described as one", otherInfo.text.includes("an agent's event channel") && !otherInfo.text.includes("invented"), otherInfo.text);
  const plainInfo = await run(me, "cotal_channel_info", { channel: "ops.private" });
  check("an ordinary unregistered channel keeps its registry wording", plainInfo.text.includes("not in the channel registry") && plainInfo.text.includes("invented"), plainInfo.text);

  // ---- cotal_dm ----
  const self = await run(me, "cotal_dm", { to: "Scout", text: "to myself" });
  check("a self-DM says it names this session", self.isError && self.text.includes('"Scout" is this session') && !self.text.includes("no peer"), self.text);
  const selfId = await run(me, "cotal_dm", { to: me.agent.id, text: "to my id" });
  check("a self-DM by instance id says the same", selfId.isError && selfId.text.includes("is this session"), selfId.text);
  const base = await run(me, "cotal_dm", { to: "ada-lovelace", text: "by base name" });
  check(
    "a base name lists the present full name and sends nothing",
    base.isError && base.text.includes('no peer "ada-lovelace"') && base.text.includes('Present names that start with it: "ada-lovelace (web)".') && base.text.includes("nothing was sent"),
    base.text,
  );
  const unrelated = await run(me, "cotal_dm", { to: "grace", text: "nobody" });
  check("an unrelated name keeps the plain refusal", unrelated.isError && unrelated.text === `Couldn't DM: no peer "grace" in space "${space}"`, unrelated.text);
  const full = await run(me, "cotal_dm", { to: "ada-lovelace (web)", text: "by full name" });
  check("the full name delivers", !full.isError && full.text.includes("for ada-lovelace (web)"), full.text);
  const texts = (seat: Seat) => seat.agent.inboxSnapshot(8).items.map((i) => i.text);
  check("the full-name DM arrived", await until(() => texts(human).includes("by full name")), texts(human));
  await sleep(500);
  check("the refused DMs never reached anyone", texts(human).join() === "by full name" && !texts(me).some((t) => t.startsWith("to my")), { human: texts(human), me: texts(me) });

  // ---- cotal_anycast ----
  const held = await run(me, "cotal_anycast", { role: "default", text: "for a held role" });
  check("a role someone holds gets no waiting note", !held.isError && held.text.includes("(1 holder online at send") && !held.text.includes("waits on its queue"), held.text);
  const waiting = await run(me, "cotal_anycast", { role: "reviewer", text: "queued for a reviewer" });
  check(
    "a role nobody holds says the request waits on its queue",
    !waiting.isError && waiting.text.includes("(0 holders online at send") && waiting.text.includes("No present agent holds @reviewer, so the request waits on its queue until one does."),
    waiting.text,
  );
  const reviewer = await connectSeat("late_reviewer", "reviewer");
  check(
    "the next holder of that role receives the queued request",
    await until(() => reviewer.agent.inboxSnapshot(8).items.some((i) => i.kind === "anycast" && i.text === "queued for a reviewer"), 10000),
    texts(reviewer),
  );

  console.log(`\nDISCOVERY AND ADDRESSING TESTS PASSED ✅  (${pass} checks)`);
} catch (e) {
  failure = e;
} finally {
  for (const agent of agents) await agent.stop().catch(() => {});
  await killAndAwaitExit(srv);
  releaseBroker();
}
if (failure !== undefined) {
  console.error(failure);
  process.exit(1);
}
process.exit(0);

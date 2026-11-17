/**
 * An open chat session's posts and replies on a real broker. Run: pnpm smoke:chat-open:live (needs
 * nats-server on PATH).
 *
 * A session from `openRoutingChatSession`, as `cotal chat` opens one on an open mesh, talks to an
 * agent endpoint on #general. Each check reads what the agent received:
 *   - `send` with `mentions` and `replyTo` reaches the agent with both;
 *   - a reply to the agent's channel message, routed by `replyRecipient` and `publish`, lands on that
 *     channel with the `@names` its text holds and the message's id;
 *   - a reply to the agent's DM goes back as a DM with the DM's id.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, setupSpaceStreams, type CotalMessage } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openRoutingChatSession, publish, replyRecipient, type SessionMessage } from "../src/chat/index.js";

const { check, finish } = createSuite();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | undefined): Promise<T | undefined> {
  for (let i = 0; i < 50; i++) {
    const value = read();
    if (value !== undefined) return value;
    await wait(100);
  }
  return undefined;
}

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const srv: ChildProcess = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
const release = teardownOnSignal(srv, dir);
const stops: (() => Promise<unknown>)[] = [];

try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 200 });
  const space = "chat-open-live";
  await setupSpaceStreams({ servers: server, space });
  const planner = new CotalEndpoint({ space, servers: server, card: { name: "planner", kind: "agent", role: "planner" }, channels: ["general"] });
  planner.on("error", () => {});
  const heard: CotalMessage[] = [];
  planner.on("message", (m: CotalMessage) => heard.push(m));
  stops.push(() => planner.stop());
  await planner.start();

  const session = await openRoutingChatSession(
    { root: dir, server, space, mode: "open", tlsRequired: false, personaRoot: join(dir, "agents"), source: "registry" },
    { label: "me", channels: ["general"], words: { reopen: (channel) => `reopen on #${channel}`, answerOne: "answer one" } },
  );
  stops.unshift(() => session.close());
  const received: SessionMessage[] = [];
  session.subscribe((event) => { if (event.type === "message") received.push(event.message); });
  const self = session.identity().principal;
  const heardText = (text: string) => until(() => heard.find((m) => m.parts[0]?.kind === "text" && m.parts[0].text === text));

  const sent = await session.send("look at this", "general", ["planner"], "m-0");
  const post = await heardText("look at this");
  check("send stores a channel post", sent.outcome === "stored", sent);
  check("send with mentions and replyTo reaches the agent with both",
    post?.channel === "general" && JSON.stringify(post.mentions) === JSON.stringify(["planner"]) && post.replyTo === "m-0", post);

  const question = await planner.multicast("which branch?", { channel: "general" });
  const asked = await until(() => received.find((m) => m.id === question.id));
  const onChannel = asked && replyRecipient(asked, self);
  check("the agent's channel message is answered on its channel", onChannel !== undefined && "kind" in onChannel && onChannel.kind === "channel", onChannel);
  if (onChannel && !("refused" in onChannel)) await publish(session, onChannel, "main, @planner");
  const answer = await heardText("main, @planner");
  check("the reply lands on #general with the @names in its text and the question's id",
    answer?.channel === "general" && JSON.stringify(answer.mentions) === JSON.stringify(["planner"]) && answer.replyTo === question.id, answer);

  const dm = await planner.unicast(self, "are you there?");
  const direct = await until(() => received.find((m) => m.id === dm.id));
  const back = direct && replyRecipient(direct, self);
  if (back && !("refused" in back)) await publish(session, back, "yes");
  const dmAnswer = await heardText("yes");
  check("a reply to the agent's DM goes back as a DM with the DM's id", dmAnswer !== undefined && dmAnswer.channel === undefined && dmAnswer.replyTo === dm.id, dmAnswer);
} finally {
  for (const stop of stops) await stop().catch(() => undefined);
  await killAndAwaitExit(srv, "SIGKILL");
  release();
  rmSync(dir, { recursive: true, force: true });
}

finish();

/**
 * MeshView feed entries keep the wire's reply link, mentions and conversation id. Run:
 * pnpm smoke:view-thread-fields (needs nats-server on PATH).
 *
 * Real traffic on a real broker: an agent publishes through `CotalEndpoint`, and an observer built
 * by `openObserver` (as `cotal watch` builds it) reads it through the history prefill and the live
 * tap. Each field is asserted on the entry the view produced, and a message that carries none of
 * them must produce an entry without them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshView, type FeedEntry } from "../src/view/mesh-view.js";
import { openObserver } from "../src/view/observer.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const srv: ChildProcess = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
const release = teardownOnSignal(srv, dir);
const stops: (() => Promise<unknown>)[] = [];

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  const space = "view-thread-fields";
  await setupSpaceStreams({ servers, space });
  const peer = (name: string, role: string) => {
    const ep = new CotalEndpoint({ space, servers, card: { name, kind: "agent", role }, channels: ["general"] });
    ep.on("error", () => {});
    stops.push(() => ep.stop());
    return ep;
  };
  const alice = peer("alice", "worker");
  const bob = peer("bob", "reviewer");
  await alice.start();
  await bob.start();

  const before = await alice.multicast("from history", { channel: "general", mentions: ["Bob"], replyTo: "m-history", contextId: "ctx-history" });

  const view = new MeshView(openObserver({ space, server: servers, name: "watch" }), {});
  stops.unshift(() => view.stop());
  await view.start();
  await wait(500);

  const channel = await alice.multicast("@bob look", { channel: "general", mentions: ["bob", "carol"], replyTo: "m-1", contextId: "ctx-channel" });
  const bare = await alice.multicast("no thread fields", { channel: "general" });
  const dm = await alice.unicast(bob.card.id, "answer", { replyTo: channel.id, contextId: "ctx-dm" });
  const task = await alice.anycast("reviewer", "please review", { replyTo: "m-task", contextId: "ctx-task" });
  const firstTwin = await alice.unicast(bob.card.id, "same text", { contextId: "ctx-a" });
  const secondTwin = await alice.unicast(bob.card.id, "same text", { contextId: "ctx-b" });
  await wait(1500);

  const feed = view.snapshot().feed;
  const row = (id: string): FeedEntry | undefined => feed.find((e) => e.id === id);

  const history = row(before.id);
  check("a history row carries replyTo", history?.replyTo === "m-history", history);
  check("a history row carries the mentioned names", same(history?.mentions, ["bob"]), history);
  check("a history row carries contextId", history?.contextId === "ctx-history", history);

  const live = row(channel.id);
  check("a live channel row carries replyTo", live?.replyTo === "m-1", live);
  check("a live channel row carries the mentioned names", same(live?.mentions, ["bob", "carol"]), live);
  check("a live channel row carries contextId", live?.contextId === "ctx-channel", live);

  const plain = row(bare.id);
  check("a row whose message carries none of them has none of them",
    plain !== undefined && !("replyTo" in plain) && !("mentions" in plain) && !("contextId" in plain), plain);

  const direct = row(dm.id);
  check("a DM row carries replyTo", direct?.replyTo === channel.id, direct);
  check("a DM row carries contextId", direct?.contextId === "ctx-dm", direct);
  check("a DM row names its recipient", same(direct?.toIds, [bob.card.id]), direct);

  const anycast = row(task.id);
  check("an anycast row carries replyTo", anycast?.replyTo === "m-task", anycast);
  check("an anycast row carries contextId", anycast?.contextId === "ctx-task", anycast);

  const a = row(firstTwin.id), b = row(secondTwin.id);
  check("two DMs that differ only in contextId stay two rows, each with its own",
    a?.contextId === "ctx-a" && b?.contextId === "ctx-b" && a?.count === 1 && b?.count === 1, { a, b });
} finally {
  for (const stop of stops) await stop().catch(() => undefined);
  await killAndAwaitExit(srv, "SIGKILL");
  release();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);

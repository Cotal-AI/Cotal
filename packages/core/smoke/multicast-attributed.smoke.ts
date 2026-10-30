/**
 * multicastAttributed returns the JetStream ack for a channel post: the sequence the broker stored
 * the message at, read back from the stream rather than trusted from the call. `multicast` keeps
 * returning the bare message, a wildcard channel is refused before anything is published, and
 * `unicastAttributed`, which now publishes through the same path, still returns the stored DM
 * sequence.
 *
 * Open mode, its own nats-server on a free port, torn down on exit.
 * Run: pnpm smoke:multicast-attributed
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { CotalEndpoint, isReachable, setupSpaceStreams, chatSubject, chatStream, dmStream, type CotalMessage } from "../src/index.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "mcastattr";
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
let pass = 0;
let failed = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed++;
  console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const srv = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, store);
try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");

  await setupSpaceStreams({ servers: SERVER, space: SPACE });
  const nc = await connect({ servers: SERVER });
  const jsm = await jetstreamManager(nc);
  const stored = async (stream: string, seq: number) => {
    const m = await jsm.streams.getMessage(stream, { seq });
    return { subject: m.subject, id: m.json<CotalMessage>().id };
  };
  const lastSeq = async () => (await jsm.streams.info(chatStream(SPACE))).state.last_seq;

  const mk = (actor: string) => {
    const ep = new CotalEndpoint({
      space: SPACE, servers: SERVER, channels: ["ma.one"], consume: false, registerPresence: false,
      card: { name: actor, kind: "endpoint", owner: "local", actor },
    });
    ep.on("error", () => {});
    return ep;
  };
  const alice = mk("alice");
  const bob = mk("bob");
  await alice.start();
  await bob.start();

  const first = await alice.multicastAttributed("first", { channel: "ma.one" });
  const firstAt = await stored(chatStream(SPACE), first.ack.seq);
  check(
    "multicastAttributed returns the sequence the broker stored the message at",
    first.ack.seq > 0 && firstAt.id === first.msg.id && firstAt.subject === chatSubject(SPACE, "local", "alice", "ma.one"),
    { ack: first.ack, firstAt, id: first.msg.id },
  );
  check("a first publish is not a duplicate", first.ack.duplicate === false, first.ack);
  check("the returned message names the channel it was posted to", first.msg.channel === "ma.one", first.msg.channel);

  const second = await alice.multicastAttributed("second", { channel: "ma.two" });
  const secondAt = await stored(chatStream(SPACE), second.ack.seq);
  check(
    "a later post on another channel gets its own, later sequence",
    second.ack.seq > first.ack.seq && secondAt.id === second.msg.id && secondAt.subject === chatSubject(SPACE, "local", "alice", "ma.two"),
    { first: first.ack.seq, second: second.ack, secondAt },
  );

  const plain = await alice.multicast("plain", { channel: "ma.one" });
  const plainSeq = await lastSeq();
  check(
    "multicast still returns the bare message, stored as the newest entry",
    typeof plain.id === "string" && (await stored(chatStream(SPACE), plainSeq)).id === plain.id,
    { plain: plain.id, plainSeq },
  );

  let refusal = "";
  try {
    await alice.multicastAttributed("wild", { channel: "ma.>" });
  } catch (e) {
    refusal = (e as Error).message;
  }
  check(
    "a wildcard channel is refused before anything is published",
    /cannot publish to wildcard channel "ma\.>"/.test(refusal) && (await lastSeq()) === plainSeq,
    { refusal, last: await lastSeq(), plainSeq },
  );

  const dm = await alice.unicastAttributed(bob.card.id, "direct");
  const dmAt = await stored(dmStream(SPACE), dm.ack.seq);
  check(
    "unicastAttributed still returns the sequence the DM was stored at",
    dm.ack.seq > 0 && dm.ack.duplicate === false && dmAt.id === dm.msg.id,
    { ack: dm.ack, dmAt, id: dm.msg.id },
  );

  await alice.stop();
  await bob.stop();
  await nc.close();
} finally {
  srv.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
    srv.once("exit", () => resolve());
    setTimeout(resolve, 3000);
  });
  rmSync(store, { recursive: true, force: true });
  releaseBroker();
}

console.log(`\nMULTICAST-ATTRIBUTED SMOKE ${failed === 0 ? "PASSED ✅" : "FAILED ✗"}  (${pass} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);

/**
 * `dmHistory` / `channelHistory` / `multiChannelHistory` must reject a SPEC §5 mismatch
 * (drop the row) and derive remaining routing from the forge-locked subject for rows
 * that survive. Payload `from` / `to` are advisory. Live tails, channel backfill, and
 * channel recall already `continue` on mismatch; history must match them, not rewrite.
 *
 * Needs nats-server on PATH. Isolated broker store. No `cotal up` / `cotal down` / `:live`.
 * Run: pnpm smoke:dm-history-subject
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  isReachable,
  setupSpaceStreams,
  unicastSubject,
  chatSubject,
} from "../src/index.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "dmhistsubj";
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
const text = (m: { parts?: { kind: string; text?: string }[] }) =>
  m.parts?.map((p) => (p.kind === "text" ? p.text : "")).join("") ?? "";

const envelope = (over: Record<string, unknown>) => ({
  id: "env-" + Math.random().toString(16).slice(2),
  ts: Date.now(),
  space: SPACE,
  from: { id: "local.alice", name: "alice" },
  to: "local.bob",
  parts: [{ kind: "text", text: "x" }],
  ...over,
});

const srv = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, store);
try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");

  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const alice = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: ["log"], consume: false, registerPresence: false,
    card: { name: "alice", kind: "endpoint", owner: "local", actor: "alice" },
  });
  const bob = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: ["log"], consume: false, registerPresence: false,
    card: { name: "bob", kind: "endpoint", owner: "local", actor: "bob" },
  });
  const viewer = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: ["log"], consume: false, registerPresence: false,
    card: { name: "viewer", kind: "endpoint", owner: "local", actor: "viewer" },
  });
  alice.on("error", () => {});
  bob.on("error", () => {});
  viewer.on("error", () => {});
  await alice.start();
  await bob.start();
  await viewer.start();

  const honest = await alice.unicast(bob.card.id, "honest-line");
  const own = await viewer.unicast(bob.card.id, "viewer-own-line");
  const chatHonest = await alice.multicast("chat-honest", { channel: "log" });
  await wait(200);

  const honestPage = await viewer.dmHistory({ limit: 50 });
  check("honest DM is in history", honestPage.some((m) => m.id === honest.id), honestPage.map((m) => m.id));
  const honestRow = honestPage.find((m) => m.id === honest.id);
  check("honest DM keeps the wire sender", honestRow?.from.id === alice.card.id, honestRow?.from);
  check("honest DM keeps the wire recipient", honestRow?.to === bob.card.id, honestRow?.to);
  check("history still includes the sender's own line (not an echo-drop)", text(honestRow ?? {}) === "honest-line");
  check(
    "history still includes a DM the viewer itself sent",
    honestPage.some((m) => m.id === own.id && text(m) === "viewer-own-line" && m.from.id === viewer.card.id),
    honestPage.filter((m) => m.from?.id === viewer.card.id).map((m) => m.id),
  );

  const raw = await connect({ servers: SERVER });
  const dmSubj = unicastSubject(SPACE, "local", "bob", "local", "alice");
  const chatSubj = chatSubject(SPACE, "local", "alice", "log");

  raw.publish(dmSubj, JSON.stringify(envelope({
    id: "spoof-388",
    from: { id: "local.mallory", name: "Not Alice", role: "admin" },
    to: "local.carol",
    parts: [{ kind: "text", text: "injected-into-carol" }],
  })));
  raw.publish(dmSubj, JSON.stringify(envelope({
    id: "to-spoof-388",
    from: { id: "local.alice", name: "alice" },
    to: "local.carol",
    parts: [{ kind: "text", text: "alice-to-carol-claim" }],
  })));
  raw.publish(dmSubj, "null");
  raw.publish(dmSubj, JSON.stringify(envelope({
    id: "from-string-388",
    from: "truthy-string",
    parts: [{ kind: "text", text: "string-from" }],
  })));
  raw.publish(dmSubj, JSON.stringify(envelope({
    id: "missing-from-388",
    from: undefined,
    parts: [{ kind: "text", text: "no-from" }],
  })));
  raw.publish(dmSubj, JSON.stringify(envelope({
    id: "bad-id-388",
    id: 123,
    parts: [{ kind: "text", text: "numeric-id" }],
  })));
  raw.publish(dmSubj, JSON.stringify((() => {
    const row = envelope({
      id: "no-space-388",
      from: { id: "local.alice", name: "alice" },
      parts: [{ kind: "text", text: "missing-space" }],
    });
    delete row.space;
    return row;
  })()));
  raw.publish(`${dmSubj}.extra`, JSON.stringify(envelope({
    id: "extra-token-388",
    parts: [{ kind: "text", text: "extra-token" }],
  })));
  raw.publish(chatSubj, JSON.stringify({
    id: "chat-spoof-388",
    ts: Date.now(),
    space: SPACE,
    from: { id: "local.mallory", name: "Not Alice" },
    channel: "other",
    parts: [{ kind: "text", text: "chat-injected" }],
  }));
  await raw.flush();
  await raw.close();
  await wait(200);

  let page: Awaited<ReturnType<typeof viewer.dmHistory>> = [];
  let threw: string | undefined;
  try {
    page = await viewer.dmHistory({ limit: 50 });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("JSON null history row does not throw", threw === undefined, threw);
  check("honest DM still present after malformed siblings", page.some((m) => m.id === honest.id), page.map((m) => m.id));
  check("spoofed payload is ABSENT from history (SPEC §5 reject, not rewrite)", !page.some((m) => m.id === "spoof-388"), page.map((m) => m.id));
  check("truthy string from is ABSENT and did not throw", !page.some((m) => m.id === "from-string-388"));
  check("missing from is ABSENT", !page.some((m) => m.id === "missing-from-388"));
  check("non-string id is ABSENT", !page.some((m) => String(m.id) === "123" || (m as { id?: unknown }).id === 123));
  check("extra-token inst subject is ABSENT (parseSubject arity)", !page.some((m) => m.id === "extra-token-388"));
  check(
    "row missing space is ABSENT (isCotalMessage, not the old isRecord triple)",
    !page.some((m) => m.id === "no-space-388"),
    page.map((m) => m.id),
  );

  const toSpoof = page.find((m) => m.id === "to-spoof-388");
  check(
    "matching from.id still rewrites recipient from the subject, not payload to",
    toSpoof?.from.id === alice.card.id && toSpoof?.to === bob.card.id,
    { from: toSpoof?.from, to: toSpoof?.to },
  );
  check(
    "payload to local.carol is NOT what history returns",
    toSpoof?.to !== "local.carol",
    toSpoof?.to,
  );
  check(
    "authenticatedDmMessage strips channel/toService on a surviving DM",
    toSpoof !== undefined && toSpoof.channel === undefined && toSpoof.toService === undefined,
    toSpoof,
  );

  let chatPage: Awaited<ReturnType<typeof viewer.channelHistory>> = [];
  let chatThrew: string | undefined;
  try {
    chatPage = await viewer.channelHistory("log", { limit: 50 });
  } catch (e) {
    chatThrew = e instanceof Error ? e.message : String(e);
  }
  check("channelHistory does not throw on a spoofed sibling", chatThrew === undefined, chatThrew);
  check("channelHistory keeps the honest multicast", chatPage.some((m) => m.id === chatHonest.id), chatPage.map((m) => m.id));
  check("channelHistory drops a from.id mismatch (same drainWindow as dmHistory)", !chatPage.some((m) => m.id === "chat-spoof-388"), chatPage.map((m) => m.id));

  let multi: Awaited<ReturnType<typeof viewer.multiChannelHistory>> = [];
  let multiThrew: string | undefined;
  try {
    multi = await viewer.multiChannelHistory(["log"], { limit: 50 });
  } catch (e) {
    multiThrew = e instanceof Error ? e.message : String(e);
  }
  check("multiChannelHistory does not throw on a spoofed sibling", multiThrew === undefined, multiThrew);
  check("multiChannelHistory keeps the honest multicast", multi.some((r) => r.msg.id === chatHonest.id));
  check("multiChannelHistory drops a from.id mismatch", !multi.some((r) => r.msg.id === "chat-spoof-388"));
  check("multiChannelHistory tags the surviving row from the subject channel", multi.some((r) => r.msg.id === chatHonest.id && r.channel === "log"));

  await alice.stop();
  await bob.stop();
  await viewer.stop();
} finally {
  releaseBroker();
  srv.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}
console.log(failed === 0
  ? `dm-history-subject smoke: ${pass} checks passed`
  : `dm-history-subject smoke: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

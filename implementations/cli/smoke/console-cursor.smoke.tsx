/** Render the shipped console components and drive their real Ink key handlers. */
import assertBase from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import React, { act, StrictMode } from "react";
import { render, Text, useInput } from "ink";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import type { Presence } from "@cotal-ai/core";
import { awaitBrokerReady, countedAssert, emitSentinel, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { useListCursor } from "../dist/console/ui/useListCursor.js";
import { CommandPalette } from "../dist/console/ui/CommandPalette.js";
import { Roster } from "../dist/console/ui/Roster.js";
import { NeedsYou } from "../dist/console/ui/NeedsYou.js";
import { SpacePicker } from "../dist/console/ui/SpacePicker.js";
import { Sequence } from "../dist/console/ui/topo/Sequence.js";
import { foldTopo } from "../dist/console/ui/topo/model.js";
import type { FeedEntry, MeshSnapshot } from "../src/view/mesh-view.js";

const counted = countedAssert(assertBase);
const assert: typeof assertBase = counted.assert as typeof assertBase;
const cells = counted.cells;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await pause();
  assert.ok(check(), label);
}
async function terminal(element: React.ReactElement) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  let frame = "";
  const stdout = new Writable({ write(bytes, _encoding, done) {
    const text = String(bytes).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    if (text.trim()) frame = text;
    done();
  } }) as unknown as NodeJS.WriteStream;
  stdout.columns = 120; stdout.rows = 36; stdout.isTTY = true;
  let app!: ReturnType<typeof render>;
  await act(async () => {
    app = render(<StrictMode>{element}</StrictMode>,
      { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
  });
  return {
    key: async (value: string) => { await act(async () => { stdin.write(value); }); await pause(); },
    screen: (marker: string) => until(() => frame.includes(marker), `Expected ${marker}; saw: ${frame}`),
    rerender: async (next: React.ReactElement) => {
      frame = "";
      await act(async () => { app.rerender(<StrictMode>{next}</StrictMode>); });
    },
    close: async () => {
      await act(async () => { app.unmount(); });
      app.cleanup(); stdin.destroy(); stdout.destroy();
    },
  };
}

let current = -1;
function Cursor({ length, followTail = false }: { length: number; followTail?: boolean }) {
  const cursor = useListCursor(length, { followTail });
  current = cursor.index;
  useInput((input) => {
    if (input === "j") cursor.down();
    if (input === "k") cursor.up();
    if (input === "g") cursor.first();
    if (input === "G") cursor.last();
    if (input === "b") { cursor.down(); cursor.down(); }
  });
  return <Text>{`cursor=${cursor.index}/${length}`}</Text>;
}
for (const followTail of [false, true]) {
  const view = (length: number) => <Cursor length={length} followTail={followTail} />;
  const term = await terminal(view(0));
  try {
    await term.screen("cursor=0/0");
    for (const key of ["j", "j", "k", "G", "g", "b"]) {
      await term.key(key); assert.equal(current, 0, "Empty-list moves remain zero");
    }
    await term.rerender(view(3)); await term.screen(`cursor=${followTail ? 2 : 0}/3`);
    await term.key("g"); await term.key("b");
    assert.equal(current, 2, "Batched moves accumulate rather than reuse a stale selection");
    await term.key("j"); assert.equal(current, 2, "Down at the end stays at the end");
    await term.key("k"); assert.equal(current, 1);
    await term.rerender(view(0)); await term.screen("cursor=0/0");
    await term.rerender(view(4)); await term.screen(`cursor=${followTail ? 3 : 0}/4`);
    await term.key("G");
    await term.rerender(view(2)); await term.screen("cursor=1/2");
    await term.rerender(view(5)); await term.screen(`cursor=${followTail ? 4 : 1}/5`);
    await term.key("g"); await term.key("j");
    await term.rerender(view(6)); await term.screen("cursor=1/6");
    await term.key("k"); await term.key("k"); assert.equal(current, 0, "Up at the start stays zero");
    console.log(`PASS shared cursor empty, shrink, regrow, batching and tail=${followTail}`);
  } finally { await term.close(); }
}

const peers: Presence[] = ["alice", "bob", "carol"].map((name) => ({
  card: { id: `local.${name}`, name, kind: "agent" }, status: "waiting", ts: Date.now(),
}));
for (const lens of ["roster", "needs-you"] as const) {
  let selected: Presence | undefined;
  const open = (peer: Presence) => { selected = peer; };
  const held = { current: { index: 0 } };
  const view = (rows: Presence[]) => lens === "roster"
    ? <Roster view={held} agents={rows} endpoints={[]} query="" boxWidth={100} boxHeight={20} blocked={false}
      onFocus={() => {}} onOpenDetail={open} />
    : <NeedsYou waiting={rows} boxWidth={100} boxHeight={20} blocked={false}
      onFocus={() => {}} onOpenDetail={open} />;
  const term = await terminal(view([]));
  try {
    await term.screen(lens === "roster" ? "roster" : "NEEDS YOU");
    await term.key("\t"); // focus the component's real focusable input surface
    await term.key("j"); await term.key("\x1b[B");
    await term.rerender(view(peers)); await term.screen("alice");
    await term.key("\r"); assert.equal(selected?.card.name, "alice", `${lens}: empty down then refill selects first`);
    await term.key("j"); await term.key("\r"); assert.equal(selected?.card.name, "bob");
    await term.key("j"); await term.key("\r"); assert.equal(selected?.card.name, "carol");
    await term.rerender(view(peers.slice(0, 2))); await term.screen("bob");
    await term.key("k"); await term.key("\r"); assert.equal(selected?.card.name, "alice", `${lens}: up after shrink moves from visible row`);
    await term.rerender(view([])); await term.screen(lens === "roster" ? "nobody present" : "nothing waiting");
    await term.rerender(view(peers)); await term.screen("alice");
    await term.key("\r"); assert.equal(selected?.card.name, "alice", `${lens}: no hidden stale cursor on regrowth`);
    console.log(`PASS ${lens} real focus, keys, refill and shrink`);
  } finally { await term.close(); }
}

let runs: string[] = [];
let changed = "";
const snapshot = (rows: Presence[]) => ({ agents: rows, endpoints: [], channels: [] }) as unknown as MeshSnapshot;
const palette = (rows: Presence[], query = "dm ") => <CommandPalette active query={query}
  snapshot={snapshot(rows)} canWrite canControl width={120} onChange={(query) => { changed = query; }}
  onRun={(line) => runs.push(line)} onCancel={() => {}} onNewAgent={() => {}}
  readManaged={async () => ({ ok: true, rows: [], silent: [], failed: [], answered: [] })} />;
{
  const term = await terminal(palette([]));
  try {
    await term.screen("No agents or endpoints available");
    await term.key("\x1b[B");
    await term.rerender(palette(peers)); await term.screen("▸ @alice");
    await term.key("\t");
    assert.equal(changed, "dm @alice ", "Tab completes the first target after empty-list navigation");
    runs = [];
    await term.rerender(palette(peers, "call ")); await term.screen("@alice");
    await term.key("\x1b[B"); await term.key("\r");
    assert.deepEqual(runs, ["call @bob"], "Palette down uses the first row as its origin after refill");
    await term.rerender(palette(peers.slice(0, 1), "call ")); await term.screen("▸ @alice");
    await term.key("\x1b[B"); await term.key("\r"); assert.equal(runs.at(-1), "call @alice");
    console.log("PASS command palette empty navigation, asynchronous targets and shrink");
  } finally { await term.close(); }
}

const feed: FeedEntry[] = Array.from({ length: 5 }, (_, i) => ({
  id: `message-${i}`, ts: Date.now(), from: { id: "local.alice", name: "alice" },
  delivery: "multicast", channel: "general", text: `message-${i}`,
}));
{
  let opened: FeedEntry | undefined;
  const view = (rows: FeedEntry[]) => <Sequence feed={rows} graph={foldTopo(rows, peers)}
    width={120} height={15} active onOpenMessage={(entry) => { opened = entry; }} />;
  const term = await terminal(view([]));
  const expect = async (id: string) => { await term.key("\r"); assert.equal(opened?.id, id); };
  try {
    await term.screen("no traffic"); await term.key("j");
    await term.rerender(view(feed.slice(0, 3))); await term.screen("message-2"); await expect("message-2");
    await term.key("k"); await expect("message-1");
    await term.rerender(view(feed.slice(0, 4))); await term.screen("message-3"); await expect("message-1");
    await term.rerender(view([])); await term.screen("no traffic");
    await term.key("j");
    await term.rerender(view(feed)); await term.screen("message-4"); await expect("message-4");
    await term.key("g"); await expect("message-0");
    await term.key("G"); await expect("message-4");
    await term.rerender(view(feed.slice(0, 2))); await term.screen("message-1"); await expect("message-1");
    await term.key("\x1b[A"); await expect("message-0");
    console.log("PASS sequence empty navigation, paused tail, empty shrink, refill, g/G and arrows");
  } finally { await term.close(); }
}

// SpacePicker gets its rows through the real listSpaces API, not a replaced module or hook.
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}cursor-`));
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", store], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
let nc: NatsConnection | undefined;
try {
  await awaitBrokerReady(async () => {
    try { const probe = await connect({ servers, reconnect: false }); await probe.close(); return true; }
    catch { return false; }
  }, { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers, reconnect: false });
  const jsm = await jetstreamManager(nc);
  let selected: string | undefined;
  const term = await terminal(<SpacePicker server={servers} onSelect={(space) => { selected = space; }} />);
  try {
    await term.screen("no spaces found"); await term.key("j"); await term.key("\x1b[B");
    for (const space of ["alpha", "beta", "gamma"]) {
      await jsm.streams.add({ name: `CHAT_${space}`, subjects: [`cursor.${space}`] });
    }
    await term.key("r"); await term.screen("▸ alpha");
    await term.key("\r"); assert.equal(selected, "alpha", "Picker refills with its first space selected");
    await term.key("j"); await term.key("\r"); assert.equal(selected, "beta");
    await term.key("\x1b[A"); await term.key("\r"); assert.equal(selected, "alpha");
    console.log("PASS space picker native listSpaces refresh after empty-list navigation");
  } finally { await term.close(); }
} finally {
  await nc?.close();
  await killAndAwaitExit(broker);
  release();
  assert.ok(broker.exitCode !== null || broker.signalCode !== null, "Owned broker has exited");
  console.log(`Retained cursor broker evidence: ${store}`);
}
console.log("CONSOLE CURSOR SMOKE OK");
emitSentinel({ passed: cells(), failed: 0 });

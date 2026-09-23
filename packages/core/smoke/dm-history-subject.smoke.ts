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
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint,
  isReachable,
  setupSpaceStreams,
  unicastSubject,
  chatSubject,
  type Part,
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
  // #1404 fix round: a data part must carry a JSON value at ANY depth. Each refusal is its own
  // cell so a mutation can kill exactly one arm of the structural check. The errors must name the
  // path to the offending value, so a caller learns which member to fix.
  const refuse = async (name: string, data: unknown, wantPath: string) => {
    let msg: string | undefined;
    try {
      await alice.unicast(bob.card.id, "unused-text", { parts: [{ kind: "data", data }] as unknown as Part[] });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check(
      name,
      msg !== undefined && /non-JSON value/.test(msg) && msg.includes(wantPath),
      msg,
    );
  };
  await refuse("publish refuses a data part with top-level undefined (the key stringify drops)", undefined, "data is not a JSON value");
  await refuse("publish refuses undefined inside an array slot (a position stringify rewrites to null)", [1, undefined], "data[1] is not a JSON value");
  await refuse("publish refuses NaN (a non-finite number stringify stores as null)", Number.NaN, "data is not a finite number");
  await refuse("publish refuses a Date (stringify stores it as a string, not a JSON value it was)", new Date(0), "data is not a plain object");
  await refuse("publish refuses a function nested in an object member (stringify drops it)", { at: () => 1 }, "data.at is not a JSON value");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await refuse("publish refuses a cycle (never a stringify TypeError or a stack overflow)", cyclic, "data.self is cyclic");
  // A SHARED subtree is not a cycle: `seen` must hold only the ancestors on the current path, so
  // {a: x, b: x} publishes (stringify carries x twice, faithfully) and the row keeps both members.
  const shared = { n: 1 };
  const dataShared = await alice.unicast(bob.card.id, "unused-text", {
    parts: [{ kind: "data", data: { a: shared, b: shared } }],
  });
  // Accept control: an undefined-valued MEMBER of a plain object publishes — stringify drops just
  // that key (a faithful drop, not a rewrite), and the stored row is {"keep":1} with no drop key.
  // Wrapped like the refusal cells above: a regression must redden THIS cell, not crash the suite
  // before its summary line (a crashed run grades INCONCLUSIVE in the mutation rig, not red).
  let dataUndefMember: Awaited<ReturnType<typeof alice.unicast>> | undefined;
  let undefMemberErr: string | undefined;
  try {
    dataUndefMember = await alice.unicast(bob.card.id, "unused-text", {
      parts: [{ kind: "data", data: { keep: 1, drop: undefined } }],
    });
  } catch (e) {
    undefMemberErr = e instanceof Error ? e.message : String(e);
  }
  // `null` is a JSON value (SPEC §5): a data part carrying it keeps working end to end.
  const dataNull = await alice.unicast(bob.card.id, "unused-text", {
    parts: [{ kind: "data", data: null }],
  });
  // Accept controls: a nested undefined member (stringify drops just that key) and a nested
  // array-of-objects that must round-trip with its data key.
  const dataNested = await alice.unicast(bob.card.id, "unused-text", {
    parts: [{ kind: "data", data: [{ a: 1 }, { b: "two" }] }],
  });
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

  // #1404: the wire never carries a keyless data row — the null part round-trips with its key.
  const jsm = await jetstreamManager(raw);
  const stored = await jsm.streams.getMessage(`DM_${SPACE}`, { last_by_subj: dmSubj });
  check(
    "the stored DM payload keeps the data key (null is a JSON value)",
    stored !== null && JSON.parse(stored.string()).parts.some((p: { kind: string }) => p.kind === "data" && Object.hasOwn(p, "data")),
    stored?.string(),
  );

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
  // #1413 REPRO, raw-row stage: a stored row carrying only id + object from SITS on the same
  // DM subject with a matching sender. Read back through the PUBLIC dmHistory only.
  raw.publish(dmSubj, JSON.stringify({
    id: "partial-1413",
    from: { id: "local.alice" },
  }));
  // Control arms for the new contract: a full row published raw on the same subject, the
  // pre-fix keyless data part, a nameless from, and a non-finite ts.
  raw.publish(dmSubj, JSON.stringify(envelope({ id: "full-1413" })));
  raw.publish(dmSubj, JSON.stringify(envelope({
    id: "pre-fix-keyless-data-1413",
    parts: [{ kind: "data" }],
  })));
  raw.publish(dmSubj, JSON.stringify(envelope({ id: "nameless-from-1413", from: { id: "local.alice" } })));
  raw.publish(dmSubj, JSON.stringify(envelope({ id: "bad-ts-1413", ts: Number.NaN })));
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
    "a data part carrying null (a JSON value) still appears in dmHistory with its data key",
    page.some((m) => m.id === dataNull.id && m.parts.some((p) => p.kind === "data" && "data" in p && p.data === null)),
    page.map((m) => m.id),
  );
  check(
    "a nested array-of-objects data part round-trips with its data key",
    page.some((m) => m.id === dataNested.id && JSON.stringify(m.parts.find((p) => p.kind === "data")?.data) === '[{"a":1},{"b":"two"}]'),
    page.map((m) => m.id),
  );
  check(
    "a shared subtree publishes and round-trips with both members (not a cycle)",
    page.some((m) => m.id === dataShared.id && JSON.stringify(m.parts.find((p) => p.kind === "data")?.data) === '{"a":{"n":1},"b":{"n":1}}'),
    page.map((m) => m.id),
  );
  check(
    "an undefined object member publishes and the stored row drops just that key",
    undefMemberErr === undefined &&
      dataUndefMember !== undefined &&
      page.some((m) => m.id === dataUndefMember.id && JSON.stringify(m.parts.find((p) => p.kind === "data")?.data) === '{"keep":1}'),
    undefMemberErr ?? page.map((m) => m.id),
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

  // ---- #1413: what dmHistory returns for rows lacking what CotalMessage promises ----
  // The CONTRACT cells read the page as its consumers do. `as Record<string, unknown>` is
  // deliberate: the fix under development types this row honestly, so the smoke must observe
  // the shipped fields rather than lean on the type being wrong or right.
  const field = (m: { id?: unknown } | undefined, key: string) =>
    (m as Record<string, unknown> | undefined)?.[key];
  const partial1413 = page.find((m) => m.id === "partial-1413");
  console.log(`  [#1413 repro] partial row via dmHistory: id=${partial1413?.id} ts=${field(partial1413, "ts")} space=${field(partial1413, "space")} parts=${JSON.stringify(field(partial1413, "parts"))} from.name=${JSON.stringify(field(partial1413?.from, "name"))} to=${field(partial1413, "to")}`);
  check(
    "partial row (id + object from only): ts/space/parts/EndpointRef.name are NOT undefined",
    partial1413 !== undefined &&
      field(partial1413, "ts") !== undefined &&
      field(partial1413, "space") !== undefined &&
      field(partial1413, "parts") !== undefined &&
      partial1413.from.name !== undefined,
    partial1413,
  );
  // A full row published raw round-trips: same id, ts preserved exactly, from.name intact,
  // to derived from the subject, and text renders through the shipped partsToText.
  const full1413 = page.find((m) => m.id === "full-1413");
  check(
    "full raw row round-trips unchanged (id, finite ts, EndpointRef.name, subject-derived to, text)",
    full1413 !== undefined && typeof full1413.ts === "number" && Number.isFinite(full1413.ts) &&
      full1413.from.name === "alice" && full1413.to === bob.card.id && text(full1413) === "x",
    full1413,
  );
  // A pre-fix producer's keyless {kind:"data"} row is still SURFACED, not dropped.
  check(
    "pre-fix keyless data part row is still surfaced by dmHistory",
    page.some((m) => m.id === "pre-fix-keyless-data-1413" && m.parts.some((p) => p.kind === "data" && !("data" in p))),
    page.map((m) => m.id),
  );
  // Same rule per field: a nameless from and a non-finite ts.
  const nameless = page.find((m) => m.id === "nameless-from-1413");
  check(
    "row whose from lacks name: name is NOT undefined on the row history returns",
    nameless === undefined || nameless.from.name !== undefined,
    nameless?.from,
  );
  const badTs = page.find((m) => m.id === "bad-ts-1413");
  check(
    "row with non-finite ts: ts on the row history returns is a finite number",
    badTs === undefined || (typeof badTs.ts === "number" && Number.isFinite(badTs.ts)),
    badTs?.ts,
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

/**
 * `dmHistory` must surface identity from the forge-locked DM subject, not the payload.
 *
 * The unicast subject is `inst.<recipOwner>.<recipActor>.<sndOwner>.<sndActor>`. The broker
 * forge-locks those four tokens. Payload `from` / `to` are advisory. Live tails already drop a
 * spoofed `from`. `drainWindow` used to keep `m.json()` and drop `m.subject`, so every history
 * consumer rendered a self-asserted sender and recipient (Cotal #388).
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

const srv = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, store);
try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");

  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const alice = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: [], consume: false, registerPresence: false,
    card: { name: "alice", kind: "endpoint", owner: "local", actor: "alice" },
  });
  const bob = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: [], consume: false, registerPresence: false,
    card: { name: "bob", kind: "endpoint", owner: "local", actor: "bob" },
  });
  const viewer = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: [], consume: false, registerPresence: false,
    card: { name: "viewer", kind: "endpoint", owner: "local", actor: "viewer" },
  });
  alice.on("error", () => {});
  bob.on("error", () => {});
  viewer.on("error", () => {});
  await alice.start();
  await bob.start();
  await viewer.start();

  const honest = await alice.unicast(bob.card.id, "honest-line");
  await wait(200);

  const honestPage = await viewer.dmHistory({ limit: 10 });
  check("honest DM is in history", honestPage.some((m) => m.id === honest.id), honestPage.map((m) => m.id));
  const honestRow = honestPage.find((m) => m.id === honest.id)!;
  check("honest DM keeps the wire sender", honestRow.from.id === alice.card.id, honestRow.from);
  check("honest DM keeps the wire recipient", honestRow.to === bob.card.id, honestRow.to);
  check("history still includes the sender's own line (not an echo-drop)", text(honestRow) === "honest-line");

  const raw = await connect({ servers: SERVER });
  const spoofed = {
    id: "spoof-388",
    ts: Date.now(),
    space: SPACE,
    from: { id: "local.mallory", name: "Not Alice" },
    to: "local.carol",
    parts: [{ kind: "text", text: "injected-into-carol" }],
  };
  raw.publish(
    unicastSubject(SPACE, "local", "bob", "local", "alice"),
    JSON.stringify(spoofed),
  );
  await raw.flush();
  await raw.close();
  await wait(200);

  const page = await viewer.dmHistory({ limit: 20 });
  const row = page.find((m) => m.id === "spoof-388");
  check("spoofed payload is still a history row (rewritten, not silently dropped)", !!row, page.map((m) => m.id));
  check(
    "dmHistory sender is the subject sender, not payload from.id",
    row?.from.id === alice.card.id,
    { from: row?.from, expected: alice.card.id },
  );
  check(
    "dmHistory recipient is the subject recipient, not payload to",
    row?.to === bob.card.id,
    { to: row?.to, expected: bob.card.id },
  );
  check(
    "payload from.id local.mallory is NOT what history returns",
    row?.from.id !== "local.mallory",
    row?.from,
  );
  check(
    "payload to local.carol is NOT what history returns",
    row?.to !== "local.carol",
    row?.to,
  );

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

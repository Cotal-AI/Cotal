/**
 * The run driver's journal grants, against an ENFORCING broker.
 *
 * Every other suite in this lane runs on an open broker, so it proves what the code does and nothing
 * about what a credential permits. That gap shipped a real defect: the replay consumer's grant rows
 * carried `wfj_<runId>_*`, which reads like a pattern and is not one — NATS treats `*` as a wildcard
 * only as a WHOLE dot-delimited token, so those rows were literal strings matching no real API
 * subject. Measured directly: a subscription to `api.WFJ.wfj_r-1_*` received `api.WFJ.wfj_r-1_*` and
 * did NOT receive `api.WFJ.wfj_r-1_ab12cd34`. Under an enforcing broker the driver could not create,
 * bind, ack or delete its own replay consumer — no cross-run escape, but no replay either, which is
 * a run that cannot be resumed at all. A string-comparison test could not see it; only a connection
 * that is actually refused can.
 *
 * So this suite asserts the two directions that matter for authority: the rows a driver is given
 * WORK for its own run, and they do NOTHING for anyone else's.
 *
 * Run: pnpm smoke:run-journal-auth   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams,
  runDriverJournalGrants,
  activateRun,
  replayRunJournal,
  wfjSubject,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const S = "wfjauth";
const RUN_A = "run-a";
const RUN_B = "run-b";
const TID_A = "ta0001";
const TID_B = "tb0001";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-wfjauth-"));

// The driver's rows are EXACTLY what the grant builder returns, plus the two rows any JetStream
// client needs to exist at all: the API's own info endpoint and its inbox. Nothing else — a suite
// that quietly widens the credential to make itself pass is testing a credential nobody will hold.
const driverA = [...runDriverJournalGrants(S, RUN_A, TID_A), "$JS.API.INFO"];
const driverB = [...runDriverJournalGrants(S, RUN_B, TID_B), "$JS.API.INFO"];

writeFileSync(join(sd, "server.conf"), [
  `port: ${PORT}`,
  `jetstream { store_dir: ${JSON.stringify(join(sd, "js"))} }`,
  "authorization {",
  "  users [",
  `    { user: "admin", password: "pw" }`,
  `    { user: "drivera", password: "pw", permissions: { publish = ${JSON.stringify(driverA)}, subscribe = ${JSON.stringify(["_INBOX_da.>"])} } }`,
  `    { user: "driverb", password: "pw", permissions: { publish = ${JSON.stringify(driverB)}, subscribe = ${JSON.stringify(["_INBOX_db.>"])} } }`,
  "  ]",
  "}",
].join("\n"));

const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });
const conns: NatsConnection[] = [];
const done = () => {
  for (const nc of conns) { try { nc.close(); } catch { /* closing */ } }
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);

let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(`nats://admin:pw@127.0.0.1:${PORT}`); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

const open = async (user: string, inbox: string): Promise<NatsConnection> => {
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user, pass: "pw", inboxPrefix: `_INBOX_${inbox}` });
  conns.push(nc);
  return nc;
};

const admin = await open("admin", "adm");
await createEndpointStreams(await jetstreamManager(admin), new Kvm(admin), S);

const ncA = await open("drivera", "da");
const jsA = jetstream(ncA);
const jsmA = await jetstreamManager(ncA);

// ── 1) the rows a driver is GIVEN actually drive its run ──────────────────────────────────────
{
  let started: Awaited<ReturnType<typeof activateRun>> | undefined;
  let err: unknown;
  try {
    started = await activateRun(jsA, jsmA, {
      space: S, runId: RUN_A, holder: "m1", fencingToken: 1, epoch: 1, at: 1,
      expect: "new", takeoverId: TID_A,
    });
  } catch (e) { err = e; }
  c("a driver holding exactly its own journal rows can activate its run", started !== undefined,
    `${(err as Error)?.name}: ${String((err as Error)?.message).slice(0, 90)}`);

  let appended = 0;
  try { appended = await started!.append({ step: "one" }, 1); } catch (e) { err = e; }
  c("and append to it", appended > 0, `${(err as Error)?.name}`);

  let replayed = -1;
  try {
    replayed = (await replayRunJournal(jsA, jsmA, S, RUN_A, TID_A)).records.length;
  } catch (e) { err = e; }
  c("and replay it: the consume rows MATCH the API subjects its own consumer name produces",
    replayed === 2, replayed === -1 ? `${(err as Error)?.name}: ${String((err as Error)?.message).slice(0, 90)}` : replayed);
}

// ── 2) and do nothing at all for another run ─────────────────────────────────────────────────
{
  let crossErr: unknown;
  try {
    await activateRun(jsA, jsmA, {
      space: S, runId: RUN_B, holder: "m1", fencingToken: 1, epoch: 1, at: 1,
      expect: "new", takeoverId: TID_A,
    });
  } catch (e) { crossErr = e; }
  c("run A's driver cannot activate run B", crossErr !== undefined, "it was allowed");

  let pubErr: unknown;
  try {
    await jsA.publish(wfjSubject(S, RUN_B), new TextEncoder().encode("{}"));
  } catch (e) { pubErr = e; }
  c("nor publish to run B's journal subject", pubErr !== undefined, "it was allowed");

  let readErr: unknown;
  try {
    await replayRunJournal(jsA, jsmA, S, RUN_B, TID_A);
  } catch (e) { readErr = e; }
  c("nor read it", readErr !== undefined, "it was allowed");
}

// ── 3) the id is PINNED: a credential names one takeover, not a family of them ────────────────
//
// This is the cell the shipped defect would have failed in the other direction. The rows are
// literal, so a driver that picks a different id than its credential names is refused — which is
// what makes per-takeover uniqueness safe to grant at all.
{
  let wrongId: unknown;
  try {
    await replayRunJournal(jsA, jsmA, S, RUN_A, "some-other-id");
  } catch (e) { wrongId = e; }
  c("a driver cannot use a takeover id its credential was not minted for", wrongId !== undefined,
    "it was allowed");
  // And the shape that shipped: a star inside a name token is not a pattern, so a row built that way
  // grants nothing. Assert the builder no longer produces one rather than trusting it not to.
  c("no grant row carries a partial-token star, which reads like a pattern and is a literal",
    runDriverJournalGrants(S, RUN_A, TID_A).every((r) => !/[A-Za-z0-9_-]\*/.test(r)),
    runDriverJournalGrants(S, RUN_A, TID_A));
}

console.log(`run-journal-auth.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);

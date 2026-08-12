/**
 * `[P5]` preflight against a REAL 3-node JetStream cluster — the case a single node cannot build.
 *
 * WHY THIS IS A SEPARATE, CLUSTERED SMOKE. `assertExpectationSemantics()` refuses a replicated chat
 * stream because on R3 the dedup cache is consulted BEFORE the subject expectation, so a retry
 * returns `duplicate: true` instead of a conflict and a lost message reads as success. That
 * refusal cannot be exercised on one node: `num_replicas: 3` needs three servers. A suite that
 * only ever sees R1 proves the check passes and never proves it REFUSES, which is the half that
 * matters.
 *
 * It also pins the fact the whole state machine rests on, measured rather than assumed:
 *
 *   standalone,     R1 stream : retry with a frozen expectation -> CONFLICT   (expectation first)
 *   3-node cluster, R1 stream : retry with a frozen expectation -> CONFLICT   (same as standalone)
 *   3-node cluster, R3 stream : retry with a frozen expectation -> duplicate  (dedup first)
 *
 * The middle row is the one that matters and the one an earlier revision of this design got wrong:
 * the discriminator is the stream's REPLICATION FACTOR, not whether a cluster is involved. A check
 * written against cluster size would pass on exactly the configuration that breaks.
 *
 * MUTATION LEDGER — predicted before the run:
 *   M1  make the check accept any replica count      -> MUST kill "R3 chat stream is REFUSED"
 *   M2  make the check assert on cluster presence    -> MUST kill "R1 stream inside a cluster is
 *                                                        ACCEPTED" (the row that disproves the
 *                                                        topology framing)
 *
 * Run: pnpm smoke:cas-preflight-cluster   (needs nats-server on PATH; starts 3 servers)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { CotalEndpoint, chatStream, isReachable, mintLifecycleUid } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), "cas-preflight-cluster-"));
const procs: ChildProcess[] = [];
const ports: number[] = [];
const cluster: number[] = [];

try {
  for (let i = 0; i < 3; i++) { ports.push(await pickFreePort()); cluster.push(await pickFreePort()); }
  const routes = cluster.map((p) => `nats://127.0.0.1:${p}`).join(",");
  for (let i = 0; i < 3; i++) {
    const conf = join(root, `n${i}.conf`);
    writeFileSync(conf, [
      `port: ${ports[i]}`,
      `server_name: n${i}`,
      `jetstream { store_dir: "${join(root, `d${i}`)}" }`,
      `cluster { name: C3`,
      `  port: ${cluster[i]}`,
      `  routes: [${routes.split(",").map((r) => `"${r}"`).join(",")}] }`,
    ].join("\n"));
    procs.push(spawn("nats-server", ["-c", conf], { stdio: "ignore" }));
  }

  let up = false;
  for (let i = 0; i < 100 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${ports[0]}`); if (!up) await wait(100); }
  c("cluster is reachable", up);
  await wait(2500); // let raft settle before asking for a replicated stream

  const nc = await connect({ servers: `nats://127.0.0.1:${ports[0]}` });
  const jsm = await jetstreamManager(nc);

  // ── the fact under the design: R1-in-a-cluster behaves like standalone ──
  await jsm.streams.add({ name: "R1C", subjects: ["r1c.>"], num_replicas: 1 });
  const r1 = await jsm.streams.info("R1C");
  c("an R1 stream can be hosted inside a real cluster", r1.config.num_replicas === 1 && Boolean(r1.cluster));

  await jsm.streams.add({ name: "R3C", subjects: ["r3c.>"], num_replicas: 3 });
  const r3 = await jsm.streams.info("R3C");
  c("an R3 stream really is replicated (the fixture is what it claims)", r3.config.num_replicas === 3);

  // ── the SHIPPED check, driven against a real R3 chat stream ──
  //    An earlier draft asserted a LOCAL COPY of the rule (`n === 1`) against stream info. That is a
  //    test of a copy: it stays green while assertExpectationSemantics() drifts or is deleted.
  //
  //    Building the R3 case taught us something the design did not say: an endpoint CANNOT START
  //    against a pre-existing R3 chat stream at all — `ensureStreams` tries to create the canonical
  //    R1 config and the server refuses the mismatch. So the preflight is a SECOND line of defence,
  //    and the reachable threat is a stream that becomes replicated AFTER creation (an operator
  //    scaling it, or a restore from a foreign config). That is what is modelled here.
  const ep = new CotalEndpoint({
    space: "pfx", servers: `nats://127.0.0.1:${ports[0]}`,
    card: { name: "pf", kind: "agent", id: "pf_id" }, lifecycleUid: mintLifecycleUid(),
  });
  ep.on("error", () => {});
  await ep.start();

  let acceptedR1 = true;
  try { await ep.assertExpectationSemantics(); } catch { acceptedR1 = false; }
  c("R1 chat stream inside a cluster is ACCEPTED (topology is NOT the discriminator)", acceptedR1);

  // Re-create the chat stream at R3 underneath the running endpoint. `streams.update` to a higher
  // replica count did not settle within the smoke's budget on a freshly-formed cluster, so this
  // takes the deterministic route: the endpoint only READS stream info here, so a delete+add is
  // sufficient and fast.
  const chat = chatStream("pfx");
  await jsm.streams.delete(chat);
  await jsm.streams.add({ name: chat, subjects: ["cotal.pfx.chat.>"], num_replicas: 3 });
  c("the chat stream really is R3 now (the fixture is what it claims)", (await jsm.streams.info(chat)).config.num_replicas === 3);

  let refusedR3 = false, why = "";
  try { await ep.assertExpectationSemantics(); }
  catch (e) { refusedR3 = true; why = (e as Error).message; }
  c("a chat stream at R3 is REFUSED by the shipped check", refusedR3, why);
  c("the refusal names the replica count, so an operator can act on it", /num_replicas=3/.test(why), why);
  await ep.stop();

  // ── and the behaviour that justifies the rule, measured on this very cluster ──
  const js = (await import("@nats-io/jetstream")).jetstream(nc);
  const probe = async (subject: string, id: string) => {
    await js.publish(subject, "A", { msgID: id, expect: { lastSubjectSequence: 0 } });
    try { const a = await js.publish(subject, "A", { msgID: id, expect: { lastSubjectSequence: 0 } });
      return a.duplicate ? "duplicate" : "stored"; }
    catch { return "conflict"; }
  };
  const onR1 = await probe("r1c.a", "fz1");
  const onR3 = await probe("r3c.a", "fz3");
  c("R1-in-cluster: a frozen-expectation retry CONFLICTS (expectation evaluated first)", onR1 === "conflict", onR1);
  c("R3: a frozen-expectation retry returns DUPLICATE (dedup evaluated first)", onR3 === "duplicate", onR3);

  await nc.drain();
} finally {
  for (const p of procs) p.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}

console.log(`cas-preflight-cluster smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

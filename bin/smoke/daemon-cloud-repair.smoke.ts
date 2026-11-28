/**
 * Cloud asks a computer to repair (#10913 step 3), end to end: the shipped `serveDaemon` polls a
 * loopback account host whose per-computer spaces document carries a `repair` request, and the
 * cells read what the service sends back in its heartbeat.
 *
 * Cells (each asserts counts):
 *  C1  the heartbeat says the service takes repair requests (`capabilities: ["repair-v1"]`);
 *  C2  a `plan` request is answered in a heartbeat within one poll: state planned, a 64-hex digest,
 *      the steps, an ISO completedAt; the service ran 1 plan;
 *  C3  the same revision again runs nothing: after 3 more polls the ack is the same and still 1 plan ran;
 *  C4  an `apply` with a digest from no plan is refused plan-changed with a fresh digest;
 *  C5  an `apply` with the planned digest is applied, with repaired a boolean;
 *  C6  a `reset` request is answered unsupported, and nothing runs;
 *  C7  an `apply` while a local change holds the agent-app gate is answered waiting, then applied
 *      once the gate is free, still one apply for that revision;
 *  C8  after a service restart every heartbeat still carries the latest ack, and the handled
 *      revision does not run again;
 *  C9  no ack string carries a path, the home folder name or the account's subject;
 *  C10 an apply waiting on the gate is withdrawn by a newer plan: the plan is answered and the apply never runs;
 *  C11 once an ack exists, every heartbeat after it carries an ack.
 * Then the repair door alone, with a recording runner:
 *  U1  one plan read answers two accounts' plan requests, and identical applies share one run, each acked;
 *  U2  a run the service started and never finished is answered interrupted with a fresh plan, and 0 applies run;
 *  U3  a plan that moves or starts the service is refused needs-this-computer and 0 applies run; a takeover
 *      consent from Cloud is dropped;
 *  U4  a Windows path, a macOS home path, a command and the person's names in Repair's words never reach the ack;
 *  U5  an ack keeps at most 32 steps and 300 characters a string, and fits its share of the heartbeat.
 *
 * Run: tsx bin/smoke/daemon-cloud-repair.smoke.ts   (Linux and macOS)
 */
import assert from "node:assert/strict";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { lockExclusiveNb } from "@cotal-ai/seat";
import { saveIdpSession } from "@cotal-ai/auth";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPathsFor, ensureStateDir } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";
import { ACK_MAX_BYTES, createCloudRepair, parseRepairRequest, type CloudRepairRunner, type RepairAck } from "../daemon/cloud-repair.js";
import type { RepairPlan, RepairStep } from "../daemon/repair.js";

if (process.platform === "win32") skipSuite("daemon cloud repair: unix socket fixture");
const root = mkdtempSync(join(tmpdir(), "dcr-"));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_") && !["COTAL_TELEMETRY", "COTAL_SKIP_CONNECTOR_SEED"].includes(key)) delete process.env[key];
const home = join(root, "home-person");
mkdirSync(home, { mode: 0o700 });
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.COTAL_HOME = join(root, "cotal");
const machineHome = process.env.COTAL_HOME;
const runtime = join(root, "rt"); mkdirSync(runtime, { mode: 0o700 });
const SUB = "subject-of-person";

type Ack = { revision: number; state: string; completedAt: string; digest?: string; repaired?: unknown; reason?: string; steps?: Record<string, unknown>[] };
const heartbeats: Record<string, unknown>[] = [];
let request: Record<string, unknown> | undefined;
let gets = 0;
const fixture = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  const machine = req.url?.match(/^\/api\/cli\/machines\/([0-9a-f-]+)(\/spaces)?$/);
  if (!machine) { res.writeHead(404); res.end("{}"); return; }
  if (req.method === "PUT") {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      heartbeats.push(JSON.parse(body) as Record<string, unknown>);
      res.end(JSON.stringify({ v: 1, machine: { id: machine[1], lastSeenAt: new Date().toISOString() } }));
    });
    return;
  }
  gets++;
  // The request's revision is part of the ETag, as Cloud does it, so a new request is never a 304.
  const etag = `"r${JSON.stringify(request ?? null).length}-${String(request?.revision ?? 0)}"`;
  if (req.headers["if-none-match"] === etag) { res.writeHead(304); res.end(); return; }
  res.setHeader("etag", etag);
  res.end(JSON.stringify({ v: 1, machineId: machine[1], revision: 1, bindingRevisions: {}, account: { idpUrl, issuer, sub: SUB }, spaces: [], ...(request ? { repair: request } : {}) }));
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const issuer = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const idpUrl = `${issuer}/api/auth`;
saveIdpSession(machineHome, idpUrl, { token: "fixture-session", sub: SUB, expiresAt: Date.now() / 1000 + 3600 });
const paths = daemonPathsFor(machineHome, { XDG_RUNTIME_DIR: runtime });
const log: string[] = [];
const serve = () => serveDaemon({ paths, version: "0.184.9", sessionDir: machineHome, log: line => { log.push(line); } });
let daemon = await serve();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const ack = (beat: Record<string, unknown> | undefined) => beat?.repair as Ack | undefined;
const runs = (kind: string, revision: number) => log.filter(line => line === `cloud repair: ${kind} revision ${revision}`).length;
async function until(test: () => boolean, label: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await sleep(50);
  assert.ok(test(), label);
}
/** The first heartbeat sent after `from` whose ack has this revision and state. */
const ackAfter = (from: number, revision: number, state: string) => heartbeats.slice(from).map(ack).find(item => item?.revision === revision && item.state === state);
const failures: string[] = [];
let passed = 0;
async function cell(name: string, body: () => Promise<void>) {
  try { await body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
try {
  await until(() => heartbeats.length > 0 && gets > 0, "the service registered and polled");
  await cell("C1 the heartbeat says the service takes repair requests", async () => {
    assert.deepEqual(heartbeats.at(-1)!.capabilities, ["repair-v1"]);
  });
  let digest = "";
  await cell("C2 a plan request is answered in a heartbeat within one poll", async () => {
    const from = heartbeats.length;
    request = { revision: 1, request: "plan" };
    await until(() => ackAfter(from, 1, "planned") !== undefined, "a planned ack for revision 1 arrives", 12_000);
    const planned = ackAfter(from, 1, "planned")!;
    assert.match(planned.digest ?? "", /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(planned.steps) && planned.steps.length >= 1 && planned.steps.length <= 32, "the plan's steps, at most 32");
    assert.ok(Number.isFinite(Date.parse(planned.completedAt)) && new Date(planned.completedAt).toISOString() === planned.completedAt, "completedAt is an ISO time");
    assert.equal(runs("plan", 1), 1, "1 plan ran");
    digest = planned.digest!;
  });
  await cell("C3 the same revision again runs nothing", async () => {
    const before = ack(heartbeats.at(-1));
    const polled = gets;
    await until(() => gets >= polled + 3, "3 more polls");
    assert.equal(runs("plan", 1), 1, "still 1 plan ran");
    await until(() => heartbeats.length > 0, "a heartbeat");
    assert.deepEqual(ack(heartbeats.at(-1)), before, "the ack is unchanged");
  });
  await cell("C4 an apply with a digest from no plan is refused plan-changed with a fresh digest", async () => {
    const from = heartbeats.length;
    request = { revision: 2, request: "apply", digest: "0".repeat(64), consent: [] };
    await until(() => ackAfter(from, 2, "refused") !== undefined, "a refused ack for revision 2");
    const refused = ackAfter(from, 2, "refused")!;
    assert.equal(refused.reason, "plan-changed");
    assert.equal(refused.digest, digest, "the fresh plan's digest, so Cloud can apply it");
    assert.equal(runs("apply", 2), 0, "nothing was applied");
  });
  await cell("C5 an apply with the planned digest is applied", async () => {
    const from = heartbeats.length;
    request = { revision: 3, request: "apply", digest, consent: ["remove-old-registration"] };
    await until(() => ackAfter(from, 3, "applied") !== undefined, "an applied ack for revision 3");
    const applied = ackAfter(from, 3, "applied")!;
    assert.equal(typeof applied.repaired, "boolean");
    assert.equal(runs("apply", 3), 1, "1 apply ran");
  });
  await cell("C6 a reset request is answered unsupported and runs nothing", async () => {
    const from = heartbeats.length;
    request = { revision: 4, request: "reset" };
    await until(() => ackAfter(from, 4, "unsupported") !== undefined, "an unsupported ack for revision 4");
    assert.equal(log.filter(line => / revision 4$/.test(line) && !/unsupported/.test(line)).length, 0, "no plan or apply ran for it");
  });
  await cell("C7 an apply while a local change holds the gate waits, then applies once", async () => {
    ensureStateDir(paths);
    const gate = openSync(join(paths.state, "agent-app.lock"), constants.O_RDWR | constants.O_CREAT, 0o600);
    assert.ok(lockExclusiveNb(gate), "the smoke holds the agent-app gate");
    const from = heartbeats.length;
    try {
      request = { revision: 5, request: "apply", digest, consent: [] };
      await until(() => ackAfter(from, 5, "waiting") !== undefined, "a waiting ack for revision 5");
      assert.equal(runs("apply", 5), 0, "nothing ran while the gate was held");
    } finally { closeSync(gate); }
    await until(() => ackAfter(from, 5, "applied") !== undefined, "an applied ack for revision 5 once the gate is free");
    assert.equal(runs("apply", 5), 1, "1 apply ran for revision 5");
  });
  await cell("C8 after a restart every heartbeat carries the latest ack, and it does not run again", async () => {
    const latest = ack(heartbeats.at(-1));
    assert.equal(latest?.revision, 5);
    await daemon.close();
    log.length = 0;
    const from = heartbeats.length;
    daemon = await serve();
    await until(() => heartbeats.length >= from + 1 && gets > 0, "the restarted service sent a heartbeat");
    const after = heartbeats.slice(from);
    assert.ok(after.length >= 1 && after.every(beat => JSON.stringify(ack(beat)) === JSON.stringify(latest)), `${after.length} heartbeat(s) after the restart carry the same ack`);
    const polled = gets;
    await until(() => gets >= polled + 2, "2 more polls");
    assert.equal(runs("apply", 5), 0, "the handled revision did not run again");
  });
  await cell("C9 no ack string carries a path, the home folder name or the account's subject", async () => {
    const text = JSON.stringify(heartbeats.map(ack).filter(Boolean));
    assert.ok(text.length > 2, "there were acks to check");
    for (const secret of [basename(home), SUB, machineHome, root]) assert.ok(!text.includes(secret), `no ack carries ${secret}`);
    for (const item of heartbeats.map(ack).filter(Boolean) as Ack[])
      for (const step of item.steps ?? []) for (const value of Object.values(step)) if (typeof value === "string") {
        assert.ok(value.length <= 300, "at most 300 characters");
        assert.doesNotMatch(value, /[\\/`~]/, "no path or command");
      }
  });
  await cell("C10 an apply waiting on the gate is withdrawn by a newer plan", async () => {
    const gate = openSync(join(paths.state, "agent-app.lock"), constants.O_RDWR | constants.O_CREAT, 0o600);
    assert.ok(lockExclusiveNb(gate), "the smoke holds the agent-app gate");
    const from = heartbeats.length;
    try {
      request = { revision: 6, request: "apply", digest, consent: [] };
      await until(() => ackAfter(from, 6, "waiting") !== undefined, "a waiting ack for revision 6");
      request = { revision: 7, request: "plan" };
      await until(() => ackAfter(from, 7, "planned") !== undefined, "the newer plan is answered while the gate is held");
    } finally { closeSync(gate); }
    const polled = gets;
    await until(() => gets >= polled + 3, "3 more polls with the gate free");
    assert.equal(runs("apply", 6), 0, "the withdrawn apply never ran");
    assert.equal(heartbeats.slice(from).map(ack).filter(item => item?.revision === 6 && item.state !== "waiting").length, 0, "revision 6 was never answered as run");
  });
  await cell("C11 once an ack exists, every heartbeat after it carries one", async () => {
    const first = heartbeats.findIndex(beat => ack(beat) !== undefined);
    assert.ok(first >= 0);
    const after = heartbeats.slice(first);
    assert.equal(after.filter(beat => ack(beat) === undefined).length, 0, `all ${after.length} heartbeats after the first ack carry one`);
  });
} finally {
  await daemon.close();
  fixture.closeAllConnections();
  await new Promise<void>(resolve => fixture.close(() => resolve()));
}

// The repair door alone: a recording runner in place of this computer's Repair.
const step = (name: string, outcome: RepairStep["outcome"], found: string, extra: Partial<RepairStep> = {}): RepairStep => ({ step: name as RepairStep["step"], outcome, found, ...extra });
function door(plan: RepairPlan, busy = false) {
  const calls = { plan: 0, apply: 0 };
  const runner: CloudRepairRunner = {
    plan: async () => { calls.plan++; return plan; },
    apply: async () => { calls.apply++; return { result: { steps: plan.steps.map(item => item.outcome === "fix" ? { ...item, changed: "done" } : item), repaired: true } }; },
    busy: () => busy,
  };
  const repair = createCloudRepair(runner, { spaceId: slug => ({ team: "sp_team" } as Record<string, string>)[slug], secrets: () => ["person-label", "team"], settleMs: 20 });
  const acks: string[] = [];
  repair.onAck(key => acks.push(key));
  const account = (key: string) => { const dir = join(root, "door", key); mkdirSync(dir, { recursive: true, mode: 0o700 }); return { key, dir }; };
  const settle = async (test: () => boolean) => { for (let i = 0; i < 200 && !test(); i++) await sleep(10); };
  return { repair, calls, acks, account, settle };
}
const safePlan: RepairPlan = { digest: "a".repeat(64), steps: [step("service-owner", "ok", "This copy of Cotal runs the background service."), step("spaces", "fix", "1 space has stopped on this computer.", { change: "Start those spaces again.", spaces: ["team"] })] };
await cell("U1 one plan read answers two accounts, and identical applies share one run", async () => {
  const { repair, calls, account, settle } = door(safePlan);
  const one = account("one"), two = account("two");
  repair.offer(one, { revision: 1, request: "plan" }, true);
  repair.offer(two, { revision: 4, request: "plan" }, true);
  await settle(() => repair.ack(one)?.state === "planned" && repair.ack(two)?.state === "planned");
  assert.equal(calls.plan, 1, "1 plan read for 2 requests");
  assert.deepEqual([repair.ack(one)?.revision, repair.ack(two)?.revision], [1, 4], "each account acked at its own revision");
  assert.deepEqual(repair.ack(one)?.steps?.[1]?.spaces, ["sp_team"], "a space is named by its id");
  repair.offer(one, { revision: 2, request: "apply", digest: safePlan.digest, consent: [] }, true);
  repair.offer(two, { revision: 5, request: "apply", digest: safePlan.digest, consent: [] }, true);
  await settle(() => repair.ack(one)?.state === "applied" && repair.ack(two)?.state === "applied");
  assert.equal(calls.apply, 1, "1 apply run for 2 identical requests");
  assert.deepEqual([repair.ack(one)?.revision, repair.ack(two)?.revision], [2, 5]);
  assert.equal(repair.ack(one)?.steps?.[1]?.changed, true, "changed is a boolean flag");
  await repair.close();
});
await cell("U2 a run the service never finished is answered interrupted, and never runs again", async () => {
  const { repair, calls, account, settle } = door(safePlan);
  const one = account("interrupted");
  writeFileSync(join(one.dir, "repair.json"), JSON.stringify({ v: 1, handled: 2, inProgress: 3 }), { mode: 0o600 });
  repair.offer(one, { revision: 3, request: "apply", digest: safePlan.digest, consent: [] }, true);
  await settle(() => repair.ack(one) !== undefined);
  const answered = repair.ack(one)!;
  assert.equal(answered.state, "interrupted");
  assert.equal(answered.revision, 3);
  assert.equal(answered.digest, safePlan.digest, "with a fresh plan to apply");
  repair.offer(one, { revision: 3, request: "apply", digest: safePlan.digest, consent: [] }, true);
  await sleep(100);
  assert.equal(calls.apply, 0, "0 applies ran for the interrupted revision");
  await repair.close();
});
await cell("U3 a plan that changes the service is refused needs-this-computer; a takeover consent is dropped", async () => {
  const takeover: RepairPlan = { digest: "b".repeat(64), steps: [step("service-owner", "fix", "Another copy of the Cotal app runs the background service.", { consent: "takeover", change: "Use this app for the background service." })] };
  const parsed = parseRepairRequest({ revision: 1, request: "apply", digest: takeover.digest, consent: ["takeover", "start-stopped", "remove-old-registration"] });
  assert.deepEqual(parsed && "consent" in parsed ? parsed.consent : undefined, ["remove-old-registration"], "only remove-old-registration survives");
  const { repair, calls, account, settle } = door(takeover);
  const one = account("takeover");
  repair.offer(one, { revision: 1, request: "apply", digest: takeover.digest, consent: ["takeover"] }, true);
  await settle(() => repair.ack(one) !== undefined);
  assert.equal(repair.ack(one)?.state, "refused");
  assert.equal(repair.ack(one)?.reason, "needs-this-computer");
  assert.equal(repair.ack(one)?.steps?.[0]?.outcome, "needs-you", "the step shows it needs the person here");
  assert.equal(repair.ack(one)?.steps?.[0]?.consent, undefined);
  assert.equal(calls.apply, 0, "0 applies ran");
  await repair.close();
});
await cell("U4 paths, commands and names in Repair's words never reach the ack", async () => {
  const leaky: RepairPlan = { digest: "c".repeat(64), steps: [
    step("spaces", "fix", "Start failed at C:\\Users\\alice\\AppData\\Local\\Cotal\\node.exe", { change: "Run `cotal daemon start` again.", spaces: ["team"] }),
    step("agent-apps", "fix", "Missing /Users/alice/Library/Application Support/Cotal", { change: "Find the agent apps for person-label." }),
    step("stale-registration", "fix", "An old registration is left in team.", { space: "team", consent: "remove-old-registration", change: "Remove the old registration." }),
  ] };
  const { repair, account, settle } = door(leaky);
  const one = account("privacy");
  repair.offer(one, { revision: 1, request: "plan" }, true);
  await settle(() => repair.ack(one) !== undefined);
  const text = JSON.stringify(repair.ack(one));
  for (const secret of ["alice", "C:\\", "/Users", "AppData", "cotal daemon", "person-label", "\"team\"", " team."]) assert.ok(!text.includes(secret), `the ack has no ${secret}`);
  assert.equal(repair.ack(one)?.steps?.[2]?.space, "sp_team", "the space is its id");
  assert.equal(repair.ack(one)?.steps?.length, 3, "every step is still there, in fixed words");
  await repair.close();
});
await cell("U5 an ack keeps at most 32 steps and 300 characters a string", async () => {
  const many: RepairPlan = { digest: "d".repeat(64), steps: Array.from({ length: 40 }, (_, i) => step("spaces", "fix", i === 0 ? "x".repeat(400) : `${i} spaces have stopped on this computer.`, { change: "y".repeat(301), spaces: ["team"] })) };
  const { repair, account, settle } = door(many);
  const one = account("bounds");
  repair.offer(one, { revision: 1, request: "plan" }, true);
  await settle(() => repair.ack(one) !== undefined);
  const answered = repair.ack(one) as RepairAck;
  assert.ok((answered.steps?.length ?? 0) <= 32, `${answered.steps?.length} steps`);
  const strings = JSON.stringify(answered).match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  assert.equal(strings.filter(item => item.length - 2 > 300).length, 0, "no string over 300 characters");
  assert.ok(Buffer.byteLength(JSON.stringify(answered)) <= ACK_MAX_BYTES, "within its share of the heartbeat");
  await repair.close();
});
console.log(`${passed} of ${passed + failures.length} cells passed${failures.length ? `; failed: ${failures.join(", ")}` : ""}. Fixture kept at ${root}`);
if (failures.length) process.exit(1);

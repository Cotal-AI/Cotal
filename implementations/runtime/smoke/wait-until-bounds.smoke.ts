/**
 * A `waitUntil` is bounded in how fast and how often it observes, through the `cotal` binary's
 * `run start --local` against a real broker, and on both engines with a small pinned ceiling.
 *
 * Every observation re-persists the step's entry with all observations so far, so a wait that
 * observes without bound grows the run's journal without bound. The cadence has a 1 s floor,
 * refused (L3047) for a literal before anything runs and for a computed cadence at the call, and
 * every look after the first counts toward the run's effect ceiling (L4009), on a fresh run and on a
 * resume alike.
 *
 * Cells:
 *   1. control: a 1 s cadence is accepted and the wait completes on a terminal first look (a local
 *      start runs no timer writer, so a wait that must pause between looks would park here);
 *   2. a literal 1 ms cadence is refused L3047 by `cotal run validate`, and a start of it fails
 *      with nothing journalled;
 *   3. a computed 1 ms cadence is refused L3047 at the call, with nothing journalled for the wait;
 *   4. on the walker, a wait under an effect ceiling of 5 ends L4009 after five looks;
 *   5. on the compiled engine, the same five-look bound, measured through durable appends;
 *   6. a resumed wait whose journal holds four looks, under a ceiling of 5, makes one more look and
 *      ends L4009;
 *   7-29. on both engines: caught deadline, handler fault, refused retry/history/deadline,
 *      cancellation, already-spent effects, effectful and throwing probes, 999/1000ms boundaries,
 *      catchable subsecond resume, caught probe admission refusal inside a reserved look,
 *      and static no-expression template literals.
 *
 * Run: pnpm smoke:runtime-wait-until-bounds   (needs nats-server on PATH and a built `bin/dist`)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity, standaloneConnectOpts,
  openRecordsBucket, readRunRecord,
} from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { Journal, SimHandler, WALKER_LANGUAGE_VERSION, ENGINE_LANGUAGE_VERSION, resolvePins, run, resume, runInWorker, transform, validate, EffectError, EffectRefused, type EffectHandler, type EffectContext, type ObserveRequest, type JournalEntry } from "@cotal-ai/lang";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";

const COTAL = fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url));
const WORKER_ENTRY = new URL(import.meta.resolve("@cotal-ai/lang/engine/worker-entry"));
const home = mkdtempSync(join(tmpdir(), "cotal-wub-home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const SPACE = "wub";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}wub-`));
const auth = await createSpaceAuth(SPACE);
writeFileSync(join(sd, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(sd, "js") }));
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });
teardownOnSignal(broker);
const servers = `nats://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), "cotal-wub-root-"));

const DECLARED = 29;
let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log("  ✓", n); } else { fail++; console.error("  ✗ FAIL:", n, extra ?? ""); } };
process.on("exit", () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  for (const d of [sd, home, root]) rmSync(d, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  up = await isReachable(servers, { creds: await mintCreds(auth, newIdentity(), "probe") }).catch(() => false);
  if (!up) await wait(100);
}
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
await setupSpaceStreams({ servers, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
mkdirSync(join(root, ".cotal"), { recursive: true });
saveSpaceAuth(authDir(root), auth);
recordMesh({ space: SPACE, server: servers, root, mode: "auth", ts: new Date().toISOString() });

const status = async (runId: string) => {
  const creds = await mintCreds(auth, newIdentity(), "run-operator", { runOperator: { endpoint: "manager", runId, takeoverId: "t1" } });
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try { return (await readRunRecord(await openRecordsBucket(nc, SPACE), "manager", runId))?.status?.value; } finally { await nc.drain().catch(() => {}); }
};

interface Started { code: number | null; out: string; runId: string }
const start = (name: string, source: string): Promise<Started> => {
  const file = join(sd, `${name}.cotal.js`);
  writeFileSync(file, source);
  const child = spawn(process.execPath, [COTAL, "run", "start", file, "--local", "--admit-read", "none", "--admit-publish", "none", "--space", SPACE, "--server", servers],
    { cwd: root, env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { out += "\nSMOKE TIMEOUT"; child.kill("SIGKILL"); }, 15_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, out, runId: /starting run (run-[0-9a-f]+)/.exec(out)?.[1] ?? "" });
    });
  });
};
const NEVER = 'terminal: (o) => o === "done"';

// ── 1) control ───────────────────────────────────────────────────────────────────────────────
{
  const r = await start("control", `const v = await waitUntil(() => "done", { name: "w", every: "1s", deadline: "3s", ${NEVER} });\nlog("got", v);\n`);
  const s = await status(r.runId);
  c("a 1s cadence is accepted and a wait terminal on its first look completes", r.code === 0 && s?.state === "completed" && r.out.includes("got done"), { code: r.code, s, out: r.out.slice(-300) });
}

// ── 2) a literal cadence under the floor ─────────────────────────────────────────────────────
{
  const source = `await waitUntil(() => "pending", { name: "w", every: "1ms", deadline: "20s", ${NEVER} });\n`;
  const file = join(sd, "literal-validate.cotal.js");
  writeFileSync(file, source);
  const v = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [COTAL, "run", "validate", file], { cwd: root, env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    child.once("exit", (code) => resolve({ code, out }));
  });
  const r = await start("literal", source);
  const s = await status(r.runId);
  c("a literal 1ms cadence is refused L3047 by validate, and its start fails with nothing journalled",
    v.code !== 0 && v.out.includes("L3047") && r.code !== 0 && s?.state === "failed" && s.journalHigh === 0, { validate: v.out.slice(-300), s });
}

// ── 3) a computed cadence under the floor ────────────────────────────────────────────────────
{
  const r = await start("computed", 'const n = len("x");\nconst cadence = `${n}ms`;\nawait waitUntil(() => "pending", { name: "w", every: cadence, deadline: "20s", ' + NEVER + ' });\n');
  const s = await status(r.runId);
  c("a computed 1ms cadence is refused L3047 at the call, and the run fails without observing",
    r.code !== 0 && s?.state === "failed" && s.failure?.code === "L3047", { code: r.code, s });
}

// ── 4, 5, 6) the effect ceiling ──────────────────────────────────────────────────────────────
// The binary runs at the default ceiling, 10,000 effects, so these pin a small one and drive each
// engine directly, as the host does.
const POLL = `await waitUntil(() => "pending", { name: "w", every: "1s", deadline: "1h", ${NEVER} });`;
const looks = (entries: readonly JournalEntry[]) => entries.filter((e) => e.kind === "waitUntil").reduce((n, e) => Math.max(n, e.observations?.length ?? 0), 0);
{
  const pins = resolvePins({ runId: "w-ceil", effectCeiling: 5 }, 1_770_000_000_000, WALKER_LANGUAGE_VERSION);
  const entries: JournalEntry[] = [];
  const e = await run(POLL, { runId: "w-ceil", handler: new SimHandler({ clock: { start: 1_770_000_000_000 } }), pins, journal: new Journal({ run: "w-ceil", store: { append: async (x) => { entries.push(x); } } }) })
    .then(() => undefined, (x: Error & { code?: string }) => x);
  c("on the walker, a wait under an effect ceiling of 5 ends L4009 after five looks", e?.code === "L4009" && looks(entries) === 5, { code: e?.code, looks: looks(entries) });
}
{
  const pins = resolvePins({ runId: "w-ceil-e", effectCeiling: 5 }, 1_770_000_000_000, ENGINE_LANGUAGE_VERSION);
  const { module } = transform(POLL);
  const entries: JournalEntry[] = [];
  const worker = runInWorker({ source: POLL, module, runId: "w-ceil-e", pins, handler: "bridged" }, {
    entry: WORKER_ENTRY,
    bridge: { handler: new SimHandler({ clock: { start: 1_770_000_000_000 } }), store: { append: async (e) => { entries.push(e); } } },
  });
  const timer = setTimeout(() => worker.cancel("smoke timeout"), 5_000);
  const r = await worker.done.finally(() => clearTimeout(timer));
  const failed = r as { ok: boolean; code?: string; message?: string };
  c("on the compiled engine, a wait under an effect ceiling of 5 ends L4009 after five looks", failed.ok === false && failed.code === "L4009" && looks(entries) === 5, { r, looks: looks(entries) });
}
{
  // A real journal of a wait that has made four looks: a run under the same pins records its entry
  // after every look, and the snapshot holding four observations is the prefix a resume would read.
  const pins = resolvePins({ runId: "w-res", effectCeiling: 5 }, 1_770_000_000_000, WALKER_LANGUAGE_VERSION);
  const recordedRun: JournalEntry[] = [];
  await run(POLL, { runId: "w-res", handler: new SimHandler({ clock: { start: 1_770_000_000_000 } }), pins, journal: new Journal({ run: "w-res", store: { append: async (x) => { recordedRun.push(x); } } }) }).catch(() => undefined);
  const cut = recordedRun.findIndex((e) => e.kind === "waitUntil" && (e.observations?.length ?? 0) === 4);
  const prefix = recordedRun.slice(0, cut + 1);
  const resumed: JournalEntry[] = [...prefix];
  const e = await resume(POLL, new Journal({ run: "w-res", entries: prefix, store: { append: async (x) => { resumed.push(x); } } }), {
    runId: "w-res", handler: new SimHandler({ clock: { start: 1_770_000_000_000 } }), pins,
  }).then(() => undefined, (x: Error & { code?: string }) => x);
  c("a resumed wait whose journal holds four looks, under a ceiling of 5, makes one more look and ends L4009",
    cut >= 0 && looks(prefix) === 4 && e?.code === "L4009" && looks(resumed) === 5, { cut, code: e?.code, looks: looks(resumed) });
}

// The same durable append logs and host seam drive both engines. Every worker has a cancellation
// bound, and every walker execution has a wall bound in addition to its pinned work budgets.
const EPOCH = 1_770_000_000_000;
type Engine = "walker" | "compiled";
const execute = async (engine: Engine, source: string, runId: string, ceiling: number, entries: readonly JournalEntry[] = [], handler: EffectHandler = new SimHandler({ clock: { start: EPOCH } })) => {
  const pins = resolvePins({ runId, effectCeiling: ceiling }, EPOCH, engine === "walker" ? WALKER_LANGUAGE_VERSION : ENGINE_LANGUAGE_VERSION);
  const rows: JournalEntry[] = [...entries];
  const store = { append: async (e: JournalEntry) => { rows.push(e); } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (engine === "compiled") {
      const worker = runInWorker({ source, module: transform(source).module, runId, pins, entries, handler: "bridged" }, { entry: WORKER_ENTRY, bridge: { handler, store } });
      timer = setTimeout(() => worker.cancel("smoke timeout"), 5_000);
      const result = await worker.done;
      return { ok: result.ok, code: result.ok ? undefined : ("code" in result ? result.code : undefined), message: result.ok ? undefined : result.message, rows };
    }
    const journal = new Journal({ run: runId, entries, store });
    const task = entries.length ? resume(source, journal, { runId, handler, pins }) : run(source, { runId, handler, pins, journal });
    await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("smoke timeout")), 5_000); })]);
    return { ok: true, code: undefined, rows };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code, message: String(e), rows };
  } finally { if (timer) clearTimeout(timer); }
};
const settledSleeps = (rows: readonly JournalEntry[]) => new Journal({ run: rows[0]?.run ?? "empty", entries: rows }).entries().filter(e => e.kind === "sleep" && e.status === "ok").length;
const WAIT = `await waitUntil(() => "pending", { name: "w", every: "1s", deadline: "1s", ${NEVER} });`;
const caught = (body: string, code: string) => `try { ${body} } catch (e) { if (e.code !== "${code}") { throw e; } }`;
const SLEEPS = 'await sleep("1s", { name: "a" }); await sleep("1s", { name: "b" });';
for (const engine of ["walker", "compiled"] as const) {
  {
    const source = caught(WAIT, "L4023") + SLEEPS;
    const fresh = await execute(engine, source, `${engine}-deadline`, 3);
    const cut = fresh.rows.findIndex(e => e.kind === "waitUntil" && e.status === "failed");
    const prefix = fresh.rows.slice(0, cut + 1);
    const replayed = await execute(engine, source, `${engine}-deadline`, 3, prefix);
    c(`${engine}: caught deadline records one look and fresh/resumed both complete two sleeps at ceiling3`, cut >= 0 && looks(prefix) === 1 && fresh.ok && replayed.ok && settledSleeps(fresh.rows) === 2 && settledSleeps(replayed.rows) === 2, { fresh: fresh.code, resumed: replayed.code, freshSleeps: settledSleeps(fresh.rows), resumedSleeps: settledSleeps(replayed.rows) });
  }
  {
    class Fault extends SimHandler {
      override async observe(req: ObserveRequest, ctx: EffectContext) {
        if (req.attempt > 0) throw new EffectError("L4002", "probe-host", "handler fault");
        return super.observe(req, ctx);
      }
    }
    const source = caught(POLL, "L4002") + SLEEPS;
    const fresh = await execute(engine, source, `${engine}-fault`, 3, [], new Fault({ clock: { start: EPOCH } }));
    const cut = fresh.rows.findIndex(e => e.kind === "waitUntil" && e.status === "failed");
    const replayed = await execute(engine, source, `${engine}-fault`, 3, fresh.rows.slice(0, cut + 1));
    c(`${engine}: unrecorded handler fault costs nothing on fresh or resume`, cut >= 0 && fresh.ok && replayed.ok && settledSleeps(fresh.rows) === 2, { fresh: fresh.code, resumed: replayed.code });
  }
  {
    class Refuse extends SimHandler {
      override async observe(req: ObserveRequest, ctx: EffectContext) {
        if (req.attempt === 2) throw new EffectRefused("L5016", "temporarily unavailable");
        return super.observe(req, ctx);
      }
    }
    const id = `${engine}-refuse`;
    const first = await execute(engine, POLL, id, 5, [], new Refuse({ clock: { start: EPOCH } }));
    const restarted = await execute(engine, POLL, id, 5, first.rows);
    const folded = new Journal({ run: id, entries: restarted.rows });
    c(`${engine}: refused rebegin preserves two old observations and resumes to exactly five`, !first.ok && first.rows.some(e => e.kind === "waitUntil" && e.status === "refused") && looks(first.rows) === 2 && restarted.code === "L4009" && looks(restarted.rows) === 5 && folded.dispatchedEffects() === 5, { first, resumed: restarted.code, looks: looks(restarted.rows), seed: folded.dispatchedEffects() });
  }
  {
    const source = 'await sleep("1s", { name: "spent-a" }); await sleep("1s", { name: "spent-b" });' + POLL;
    const r = await execute(engine, source, `${engine}-spent`, 5);
    c(`${engine}: two already spent effects leave exactly three recorded looks`, r.code === "L4009" && looks(r.rows) === 3 && settledSleeps(r.rows) === 2, { code: r.code, looks: looks(r.rows) });
  }
  {
    const source = `await waitUntil(async () => { await sleep("1s", { name: "probe" }); return "pending"; }, { name: "w", every: "1s", deadline: "1h", ${NEVER} });`;
    const r = await execute(engine, source, `${engine}-probe`, 5);
    const prefixCut = r.rows.findIndex(e => e.kind === "waitUntil" && e.observations?.length === 1);
    const replayed = await execute(engine, source, `${engine}-probe`, 5, r.rows.slice(0, prefixCut + 1));
    const seed = new Journal({ run: `${engine}-probe`, entries: r.rows }).dispatchedEffects();
    c(`${engine}: probe effects share ceiling with recorded looks on fresh and resume`, r.code === "L4009" && replayed.code === "L4009" && looks(r.rows) === 2 && looks(replayed.rows) === 2 && settledSleeps(r.rows) === 2 && seed === 4, { code: r.code, looks: looks(r.rows), seed });
  }
  {
    // The wait key and first probe sleep spend two effects. The next look reserves the third,
    // so its probe sleep is refused. Catching that L4009 must leave room for the final sleep:
    // only the reservation is refunded, and rejected effect admission must not increment.
    const id = `${engine}-caught-probe-ceiling`;
    const source = caught(`await waitUntil(async () => { await sleep("1s", { name: "probe" }); return "pending"; }, { name: "w", every: "1s", deadline: "1h", ${NEVER} });`, "L4009") + 'await sleep("1s", { name: "after-catch" });';
    const fresh = await execute(engine, source, id, 3);
    // Probe admission faults leave the parent wait pending. Resume the durable first-look
    // prefix to exercise the same reserved-look refusal, not an assumed failed settlement.
    const cut = fresh.rows.findIndex(e => e.kind === "waitUntil" && e.observations?.length === 1);
    const prefix = fresh.rows.slice(0, cut + 1);
    const replayed = await execute(engine, source, id, 3, prefix);
    const seed = new Journal({ run: id, entries: prefix }).dispatchedEffects();
    const finished = (rows: readonly JournalEntry[]) => rows.some(e => e.kind === "sleep" && e.name === "after-catch" && e.status === "ok");
    c(`${engine}: caught probe L4009 inside reserved look leaves one effect on fresh and resume`, cut >= 0 && seed === 2 && looks(prefix) === 1 && fresh.ok && replayed.ok && settledSleeps(fresh.rows) === 2 && settledSleeps(replayed.rows) === 2 && finished(fresh.rows) && finished(replayed.rows), { fresh: fresh.code, resumed: replayed.code, seed, looks: looks(prefix), freshSleeps: settledSleeps(fresh.rows), resumedSleeps: settledSleeps(replayed.rows) });
  }
  {
    const source = `await race({ fast: async () => { await sleep("500ms", { name: "winner" }); return "done"; }, slow: async () => { ${POLL} } }, { name: "r" });` + SLEEPS;
    const fresh = await execute(engine, source, `${engine}-cancelled`, 4);
    const cut = fresh.rows.findIndex(e => e.kind === "race" && e.status === "ok");
    const restarted = await execute(engine, source, `${engine}-cancelled`, 4, fresh.rows.slice(0, cut + 1));
    c(`${engine}: cancelled later cadence records no phantom effect on fresh or resume`, cut >= 0 && fresh.ok && restarted.ok && looks(fresh.rows) === 1 && settledSleeps(fresh.rows) === 3 && settledSleeps(restarted.rows) === 3, { fresh: fresh.code, resumed: restarted.code });
  }
  {
    class Refuse extends SimHandler {
      override async observe(req: ObserveRequest, ctx: EffectContext) {
        if (req.attempt === 2) throw new EffectRefused("L5016", "temporarily unavailable");
        return super.observe(req, ctx);
      }
    }
    const id = `${engine}-refuse-epoch`;
    const source = caught(`await waitUntil(() => "pending", { name: "w", every: "1s", deadline: "3s", ${NEVER} });`, "L4023") + SLEEPS;
    const first = await execute(engine, source, id, 4, [], new Refuse({ clock: { start: EPOCH } }));
    const restarted = await execute(engine, source, id, 4, first.rows, new SimHandler({ clock: { start: EPOCH + 10_000 } }));
    const last = new Journal({ run: id, entries: restarted.rows }).entries().find(e => e.kind === "waitUntil");
    c(`${engine}: refused rebegin preserves absolute deadline and old looks across downtime`, restarted.ok && last?.error?.code === "L4023" && last.startedAt === EPOCH && last.observations?.length === 2 && settledSleeps(restarted.rows) === 2, { code: restarted.code, epoch: last?.startedAt, looks: last?.observations?.length });
  }
  {
    const low = await execute(engine, 'const n = len("x"); const cadence = `${n * 999}ms`; await waitUntil(() => "done", { name: "w", every: cadence, deadline: "2s" });', `${engine}-999`, 3);
    const edge = await execute(engine, 'const n = len("x"); const cadence = `${n * 1000}ms`; await waitUntil(() => "done", { name: "w", every: cadence, deadline: "2s" });', `${engine}-1000`, 3);
    c(`${engine}: computed999ms fails L3047 before observing,1000ms records one terminal look`, low.code === "L3047" && low.rows.length === 0 && edge.ok && looks(edge.rows) === 1, { low, edge });
  }
  {
    // Seed the journal shape an older host could have written with a computed subsecond cadence.
    const source = 'const n = len("x"); const cadence = `${n * 500}ms`; try { await waitUntil(() => "pending", { name: "w", every: cadence, deadline: "1h" }); } catch (e) { if (e.code === "L3047") { await sleep("1s", { name: "caught" }); } else { throw e; } }';
    const seed = await execute(engine, source.replace('`${n * 500}ms`', '`${n * 1000}ms`'), `${engine}-old`, 3);
    const pending = seed.rows.find(e => e.kind === "waitUntil");
    const r = await execute(engine, source, `${engine}-old`, 3, pending ? [pending] : []);
    c(`${engine}: an in-flight computed subsecond cadence takes catch branch on resume`, pending !== undefined && r.ok && r.rows.some(e => e.name === "caught" && e.status === "ok"), { code: r.code });
  }
  {
    const source = caught('await waitUntil(async () => { if (now() > ' + EPOCH + ') { throw "probe fault"; } return "pending"; }, { name: "w", every: "1s", deadline: "1h", ' + NEVER + ' });', "L4002") + SLEEPS;
    // A failed program probe may throw a plain value instead of EffectError; use a catch-all for
    // this cell to verify only its unrecorded observation reservation is refunded.
    const catchAll = source.replace('if (e.code !== "L4002") { throw e; }', 'log("caught probe");');
    const r = await execute(engine, catchAll, `${engine}-probe-fault`, 4);
    c(`${engine}: a probe that throws before observation append refunds its reserved look`, r.ok && looks(r.rows) === 2 && settledSleeps(r.rows) === 2, { code: r.code, looks: looks(r.rows) });
  }
}
{
  const codes = (src: string) => { try { validate(src); return []; } catch (e) { return ((e as { errors?: { code: string }[] }).errors ?? []).map(e => e.code); } };
  const mk = (every: string) => `await waitUntil(() => "done", { name: "w", every: ${every}, deadline: \`2s\` });`;
  c("static no-expression templates obey999/1000ms boundary like string literals", codes(mk('`500ms`')).includes("L3047") && codes(mk('`999ms`')).includes("L3047") && !codes(mk('`1000ms`')).length && codes(mk('"999ms"')).includes("L3047"), { low: codes(mk('`999ms`')), edge: codes(mk('`1000ms`')) });
}

console.log(`wait-until-bounds: ${ok} ok, ${fail} failed`);
emitSentinel({ passed: ok, failed: fail, cells: DECLARED });
if (ok + fail !== DECLARED) {
  console.log(`SUITE INCOMPLETE: ran ${ok + fail} of ${DECLARED} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);

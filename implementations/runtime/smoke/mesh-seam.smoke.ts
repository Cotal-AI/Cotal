/**
 * The Lane-A seam: what a durable run does when it reaches an effect whose substrate has not landed.
 *
 * `turn` and `wait(replied)` CONSUME an agent handle through the turn machinery that has not
 * landed; `spawn`, which produces a handle, `conclave`, which assembles a sub-team of them,
 * `ask`, the schema-checked pause the agent answers, and the liveness pair — `monitor` with
 * `wait(down)` — now perform on the mesh handler, so the seam is the turn-shaped remainder,
 * gated by a single subject rather than by separate absences. One sub-refusal stays on `spawn`
 * itself: a `worktree` binding rides §9 machinery that has not landed, and silently dropping the
 * field would be worse than refusing it.
 *
 * **The claim under test is not "it throws".** It is that a durable run REFUSES, by name, with a
 * reason a reader can act on — and that a MISSING method is not the same thing. A handler that
 * simply lacks the method also fails, as a `TypeError` raised from inside the interpreter about a
 * property of a JavaScript object: red, and an answer to nothing. So the load-bearing cells are the
 * ones that separate those two failures, and the one that proves the simulator still performs the
 * whole group — the seam is only honest if the program can be written and dry-run today.
 *
 * Run: pnpm smoke:runtime-mesh-seam   (no broker: nothing here reaches a plane, which is the point)
 */
import {
  Journal,
  run as runProgram,
  resolvePins,
  SimHandler,
  WALKER_LANGUAGE_VERSION,
  type EffectHandler,
  type RunPins,
} from "@cotal-ai/lang";
import { MeshHandler, NotYetDurable } from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; return; }
  fail++;
  console.log("  ✗ FAIL:", n, extra === undefined ? "" : JSON.stringify(extra));
};

const NOW = 1_770_000_000_000;

/**
 * A mesh handler with no planes behind it.
 *
 * Every refusal below happens BEFORE anything is reached, which is exactly what makes it provable
 * without a broker: a seam that had to open a connection to say "not yet" would not be a seam.
 */
const mesh = new MeshHandler(
  null as never, null as never, null as never, null as never,
  {
    space: "seam", endpoint: "manager", runId: "r-seam",
    caller: { owner: "local", actor: "wf_seam", uid: "a".repeat(26) },
    instanceId: "i".repeat(26), epoch: 1,
    holder: { id: "manager", lifecycleUid: "u_seam" },
    defaultCheckpointTimeout: "1h",
  },
  { awaitSettle: async () => { throw new Error("the seam must refuse before any plane is reached"); } },
  () => NOW,
);

const PROGRAMS: Record<string, string> = {
  spawn: `await spawn("dev", { name: "dev" });`,
  spawnWorktree: `await spawn("dev", { name: "dev", worktree: "wt-a" });`,
  turn: `const d = await spawn("dev", { name: "dev" });\nawait turn(d, { name: "work" });`,
  ask: `const d = await spawn("dev", { name: "dev" });\nawait ask(d, { name: "size", schema: { estimate: "number" } });`,
  monitor: `const d = await spawn("dev", { name: "dev" });\nawait monitor(d, { name: "watch" });`,
  conclave: `await conclave([], async (room) => { return 1; }, { name: "huddle" });`,
};

const SCRIPT = {
  turns: { work: { status: "done", at: NOW } },
  asks: { size: { estimate: 3 } },
};

const drive = async (source: string, handler: EffectHandler, journal?: Journal, pins?: RunPins) =>
  await runProgram(source, {
    runId: "r-seam",
    handler,
    journal: journal ?? new Journal({ run: "r-seam" }),
    ...(pins !== undefined ? { pins } : {}),
  }).then(() => null, (e: unknown) => e as Error);

// ── 1) what a DURABLE PROGRAM can actually reach ───────────────────────────────────────────────
//
// Only the `worktree` sub-refusal is reachable from a broker-less program: `turn` takes a handle
// only `spawn` produces, and `spawn`, `conclave`, `ask` and `monitor` now PERFORM — against no
// planes they die reaching for them (or, for `monitor`, succeed without touching any), so a
// program using the consumers never arrives at the remaining refusal. The worktree guard fires
// before any plane is touched, so it is driven; `turn` is called at the handler, where it can be
// reached at all.
{
  const name = "spawn({worktree})";
  // Pinned up front: a held run has no result to take pins from, and the heal below has to be
  // the SAME run resuming over the refusal.
  const pins = resolvePins({ runId: "r-seam" }, 0, WALKER_LANGUAGE_VERSION);
  const journal = new Journal({ run: "r-seam" });
  const e = await drive(PROGRAMS.spawnWorktree as string, mesh as unknown as EffectHandler, journal, pins);
  // THE RUN IS HELD, NOT FAILED. The interpreter settles the entry `refused` under the code the
  // refusal carried and unwinds with the uncatchable L5025 — so the run boundary, where a driver
  // stands, sees a hold it grades as `released`, and the journal keeps the refusal for a reader.
  c(`${name} holds the run rather than pretending or failing`,
    e?.name === "RunHeld" && (e as { code?: string })?.code === "L5025",
    { name: e?.name, code: (e as { code?: string })?.code });
  c(`${name} names itself in the refusal the hold carries`,
    (e as unknown as { reason?: string })?.reason?.startsWith("spawn({worktree})") === true,
    (e as unknown as { reason?: string })?.reason?.slice(0, 90));
  c(`${name} names its own machinery: the §9 worktree binding`,
    (e as unknown as { reason?: string })?.reason?.includes("worktree binding") === true,
    (e as unknown as { reason?: string })?.reason?.slice(0, 140));
  const entry = journal.entries().find((j) => j.state === "settled");
  c(`${name} carries the code that crosses the run boundary`,
    entry?.status === "refused" && entry?.error?.code === "L5016",
    { status: entry?.status, code: entry?.error?.code });
  // THE HEAL, which is the whole point of `refused` over `failed`: the same journal on a capable
  // host re-performs the refused step live and the run completes.
  const healed = await drive(PROGRAMS.spawnWorktree as string, new SimHandler(SCRIPT as never) as unknown as EffectHandler, journal, pins);
  c(`${name} heals on a capable host: the refused step is performed live and the run completes`,
    healed === null, `${healed?.name}: ${healed?.message?.slice(0, 100)}`);
}

// ── 1b) the consumers, at the handler, where they can be reached ───────────────────────────────
{
  for (const name of ["turn"] as const) {
    const fn = (mesh as unknown as Record<string, unknown>)[name];
    // GUARDED, because a missing method is precisely what this slice replaces: calling `undefined`
    // would kill the process here and the cell would never print, which is red without being an
    // answer. An absent seam is a FAILED CELL that names the method.
    if (typeof fn !== "function") {
      c(`${name} refuses at the handler, as the class itself`, false, "the method is absent");
      c(`${name} carries the code that crosses the run boundary`, false, "the method is absent");
      c(`${name} gives the one shared reason`, false, "the method is absent");
      continue;
    }
    const e = await (fn as (r: unknown, c: unknown) => Promise<unknown>)
      .call(mesh, {}, {} as never).then(() => null, (x: unknown) => x as Error);
    c(`${name} refuses at the handler, as the class itself`, e instanceof NotYetDurable, e?.name);
    c(`${name} carries the code that crosses the run boundary`,
      (e as unknown as { code?: string })?.code === "L5016", (e as unknown as { code?: string })?.code);
    // ALL THREE, not just what a program can reach: refusals with separate reasons would be
    // separate seams wearing one name, and only the shared reason makes it one gate, one subject.
    c(`${name} gives the one shared reason`,
      e?.message.includes("an agent handle rides") === true, e?.message?.slice(0, 140));
  }
}

// ── 1c) the spawn(worktree) sub-refusal at the handler: §9 machinery, refused not dropped ──────
{
  const e = await mesh
    .spawn({ persona: "dev", worktree: "wt-a" }, { signal: { cancelled: false, onCancel() {} }, requestId: "t".repeat(43) } as never)
    .then(() => null, (x: unknown) => x as Error);
  c("spawn with a worktree refuses as the class itself, before any plane is reached",
    e instanceof NotYetDurable, e?.name);
  c("the worktree refusal names its own machinery: the §9 worktree binding",
    e?.message.includes("worktree binding") === true, e?.message?.slice(0, 140));
}

// ── 1d) the wait(replied) gate: the turn-shaped event refuses inside wait ──────────────────────
{
  for (const ev of ["replied"] as const) {
    const e = await mesh
      .wait(
        { event: { event: ev, agent: "dev#u" } } as never,
        { signal: { cancelled: false, onCancel() {} }, requestId: "w".repeat(43) } as never,
      )
      .then(() => null, (x: unknown) => x as Error);
    c(`wait(${ev}) refuses as the class itself, before any plane is reached`,
      e instanceof NotYetDurable, e?.name);
    c(`wait(${ev}) gives the one shared reason`,
      e?.message.includes("an agent handle rides") === true, e?.message?.slice(0, 140));
  }
}

// ── 1e) the liveness pair LEFT the seam: monitor performs, wait(down) reaches for the planes ───
{
  // `monitor` against no planes at all: the registration is the journal entry, so against null
  // planes it still performs — which is the sharpest possible statement that it left the seam.
  const got = await mesh
    .monitor(
      { agent: { agent: `dev#${"u".repeat(26)}`, persona: "dev" } } as never,
      { signal: { cancelled: false, onCancel() {} }, requestId: "m".repeat(43) } as never,
    )
    .then((v) => ({ v }), (x: unknown) => ({ e: x as Error }));
  c("monitor is not refused by the seam: it performs against no planes at all",
    "v" in got && got.v === null,
    "e" in got ? `${got.e?.name}: ${got.e?.message?.slice(0, 90)}` : undefined);
  // `wait(down)` dies REACHING for presence — a different failure than a refusal, which is the
  // same separation block 2 draws for a missing method.
  const e = await mesh
    .wait(
      { event: { event: "down", agent: `dev#${"u".repeat(26)}` } } as never,
      { signal: { cancelled: false, onCancel() {} }, requestId: "n".repeat(43) } as never,
    )
    .then(() => null, (x: unknown) => x as Error);
  c("wait(down) is not refused by the seam: it reaches for the planes and fails there instead",
    e !== null && !(e instanceof NotYetDurable), e?.name);
}

// ── 2) the failure a missing method produces, which is what this slice replaces ─────────────────
{
  // The same handler with `spawn` deleted: the shape this file existed to stop shipping. It
  // fails too — that is the trap. It fails as a fact about JavaScript, at a call site that says
  // nothing about what is missing or when it lands, and NOT as the seam's named hold.
  const crippled = Object.create(Object.getPrototypeOf(mesh) as object) as Record<string, unknown>;
  Object.assign(crippled, mesh);
  crippled.spawn = undefined;
  const e = await drive(PROGRAMS.spawnWorktree as string, crippled as unknown as EffectHandler);
  c("a handler MISSING the method also fails", e !== null, e);
  c("but not as a refusal: it records a generic handler fault, not the seam's hold",
    (e as { code?: string })?.code !== "L5025" && e?.name !== "RunHeld", (e as { code?: string })?.code);
  c("and the two are different failures, which is the whole reason the seam is written down",
    (e as { code?: string })?.code !== (await drive(PROGRAMS.spawnWorktree as string, mesh as unknown as EffectHandler) as { code?: string })?.code,
    { missing: (e as { code?: string })?.code });
}

// ── 3) the simulator still performs the whole group, or the two-exit is one exit ────────────────
{
  for (const [name, source] of Object.entries(PROGRAMS)) {
    const e = await drive(source, new SimHandler(SCRIPT as never) as unknown as EffectHandler);
    c(`${name} still runs in simulation, so the program can be written and dry-run today`,
      e === null, `${e?.name}: ${e?.message?.slice(0, 100)}`);
  }
}

// ── 4) an ungated effect on the same handler is NOT refused ────────────────────────────────────
{
  // Without this the suite would pass against a handler that refused everything, which is a
  // different system: the seam is a statement about a specific effect group, not about the host.
  const e = await drive(`await sleep("1s", { name: "nap" });`, mesh as unknown as EffectHandler);
  // Neither the recorded refusal NOR the hold: a refusal now surfaces as RunHeld (L5025) rather
  // than an L5016 failure, so checking the code alone went blind to a seam that swallowed sleep.
  c("sleep is not refused by the seam: it reaches the plane and fails there instead",
    (e as { code?: string })?.code !== "L5016" && e?.name !== "RunHeld",
    `${e?.name} ${(e as { code?: string })?.code}: ${e?.message?.slice(0, 80)}`);
}

console.log(`mesh-seam.smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

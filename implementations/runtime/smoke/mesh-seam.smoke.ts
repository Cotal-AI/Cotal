/**
 * The Lane-A seam: what a durable run does when it reaches an effect whose substrate has not landed.
 *
 * `spawn`, `turn`, `ask`, `monitor` and `conclave` all address an AGENT HANDLE, and only `spawn`
 * produces one, so the whole group is gated by a single subject rather than by five absences.
 *
 * **The claim under test is not "it throws".** It is that a durable run REFUSES, by name, with a
 * reason a reader can act on — and that a MISSING method is not the same thing. A handler that
 * simply lacks `spawn` also fails, as a `TypeError` raised from inside the interpreter about a
 * property of a JavaScript object: red, and an answer to nothing. So the load-bearing cells are the
 * ones that separate those two failures, and the one that proves the simulator still performs all
 * five — the seam is only honest if the program can be written and dry-run today.
 *
 * Run: pnpm smoke:runtime-mesh-seam   (no broker: nothing here reaches a plane, which is the point)
 */
import {
  Journal,
  run as runProgram,
  SimHandler,
  type EffectHandler,
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
  null as never, null as never, null as never,
  {
    space: "seam", endpoint: "manager", runId: "r-seam",
    instanceId: "i".repeat(26), epoch: 1,
    holder: { id: "manager", lifecycleUid: "u_seam" },
    defaultCheckpointTimeout: "1h",
  },
  { awaitSettle: async () => { throw new Error("the seam must refuse before any plane is reached"); } },
  () => NOW,
);

const PROGRAMS: Record<string, string> = {
  spawn: `await spawn("dev", { name: "dev" });`,
  turn: `const d = await spawn("dev", { name: "dev" });\nawait turn(d, { name: "work" });`,
  ask: `const d = await spawn("dev", { name: "dev" });\nawait ask(d, { name: "size", schema: { estimate: "number" } });`,
  monitor: `const d = await spawn("dev", { name: "dev" });\nawait monitor(d, { name: "watch" });`,
  conclave: `await conclave([], async (room) => { return 1; }, { name: "huddle" });`,
};

const SCRIPT = {
  turns: { work: { status: "done", at: NOW } },
  asks: { size: { estimate: 3 } },
};

const drive = async (source: string, handler: EffectHandler) =>
  await runProgram(source, {
    runId: "r-seam",
    handler,
    journal: new Journal({ run: "r-seam" }),
  }).then(() => null, (e: unknown) => e as Error);

// ── 1) what a DURABLE PROGRAM can actually reach ───────────────────────────────────────────────
//
// Only two of the five are reachable from a program on this host, and the reason is the gap itself:
// `turn`, `ask` and `monitor` take a handle only `spawn` produces, so a program that used them would
// refuse at the SPAWN and never arrive. Running all five as programs would have been three more
// cells about `spawn` wearing other names — so the reachable ones are driven, and the rest are
// called at the handler where they can be reached at all.
{
  for (const name of ["spawn", "conclave"] as const) {
    const e = await drive(PROGRAMS[name] as string, mesh as unknown as EffectHandler);
    // BY CODE, not by class. The interpreter wraps a handler's fault into an `EffectError` before it
    // reaches a caller, so `instanceof NotYetDurable` holds at the handler boundary and not at the
    // run boundary — and the run boundary is where a driver stands. The code is what crosses, which
    // is why the class carries one.
    c(`${name} refuses with L5016 rather than pretending`, (e as { code?: string })?.code === "L5016",
      { name: e?.name, code: (e as { code?: string })?.code });
    c(`${name} names itself in the refusal`, e?.message.startsWith(`${name}(`) === true, e?.message?.slice(0, 90));
    c(`${name} gives ONE reason: the machinery an agent handle comes from`,
      e?.message.includes("an agent handle comes from") === true, e?.message?.slice(0, 140));
  }

  // A program using `turn` refuses at the spawn above it, which is the reach gap stated as a cell
  // rather than left for a reader to infer from three suspiciously similar greens.
  const viaTurn = await drive(PROGRAMS.turn as string, mesh as unknown as EffectHandler);
  c("a program using `turn` never reaches it: the spawn above it refuses first",
    viaTurn?.message.startsWith("spawn(") === true, viaTurn?.message?.slice(0, 60));
}

// ── 1b) the other three, at the handler, where they can be reached ─────────────────────────────
{
  for (const name of ["spawn", "turn", "ask", "monitor", "openConclave", "closeConclave"] as const) {
    const fn = (mesh as unknown as Record<string, (r: unknown, c: unknown) => Promise<unknown>>)[name]!;
    const e = await fn.call(mesh, {}, {} as never).then(() => null, (x: unknown) => x as Error);
    c(`${name} refuses at the handler, as the class itself`, e instanceof NotYetDurable, e?.name);
    c(`${name} carries the code that crosses the run boundary`,
      (e as unknown as { code?: string })?.code === "L5016", (e as unknown as { code?: string })?.code);
  }
}

// ── 2) the failure a missing method produces, which is what this slice replaces ─────────────────
{
  // The same handler with `spawn` deleted: the shape this file existed to stop shipping. It fails
  // too — that is the trap. It fails as a fact about JavaScript, at a call site that says nothing
  // about what is missing or when it lands, and NOT as a NotYetDurable.
  const crippled = Object.create(Object.getPrototypeOf(mesh) as object) as Record<string, unknown>;
  Object.assign(crippled, mesh);
  crippled.spawn = undefined;
  const e = await drive(PROGRAMS.spawn as string, crippled as unknown as EffectHandler);
  c("a handler MISSING the method also fails", e !== null, e);
  c("but not as a refusal: it records a generic handler fault, not L5016",
    (e as { code?: string })?.code !== "L5016", (e as { code?: string })?.code);
  c("and the two are different failures, which is the whole reason the seam is written down",
    (e as { code?: string })?.code !== (await drive(PROGRAMS.spawn as string, mesh as unknown as EffectHandler) as { code?: string })?.code,
    { missing: (e as { code?: string })?.code });
}

// ── 3) the simulator still performs all five, or the two-exit is one exit ───────────────────────
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
  // different system: the seam is a statement about five effects, not about the host.
  const e = await drive(`await sleep("1s", { name: "nap" });`, mesh as unknown as EffectHandler);
  c("sleep is not refused by the seam: it reaches the plane and fails there instead",
    (e as { code?: string })?.code !== "L5016", `${(e as { code?: string })?.code}: ${e?.message?.slice(0, 80)}`);
}

console.log(`mesh-seam.smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

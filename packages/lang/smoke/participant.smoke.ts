import { dryRun } from "../src/dryrun.js";
import type { AgentHandleValue, EffectContext, ParticipantRequest } from "../src/effects.js";
import { run } from "../src/interpret.js";
import { Journal } from "../src/journal.js";
import { KeyScope } from "../src/keys.js";
import { SimHandler } from "../src/sim.js";

let pass = 0;
const ok = (name: string, condition: boolean, extra?: unknown): void => {
  if (!condition) throw new Error(`FAIL: ${name}${extra === undefined ? "" : ` - ${JSON.stringify(extra)}`}`);
  pass += 1;
  console.log(`  ok ${name}`);
};

{
  const requests: ParticipantRequest[] = [];
  const sim = new SimHandler({ turns: { native: { status: "done" } } });
  const handler = {
    now: () => sim.now(),
    participant: async (req: ParticipantRequest, ctx: EffectContext): Promise<AgentHandleValue> => {
      requests.push(req);
      await ctx.bind({ lifecycle: "native-1" });
      return { agent: "native#native-1", persona: "native-session" };
    },
    spawn: (req: Parameters<SimHandler["spawn"]>[0], ctx: EffectContext) => sim.spawn(req, ctx),
    turn: (req: Parameters<SimHandler["turn"]>[0], ctx: EffectContext) => sim.turn(req, ctx),
    ask: (req: Parameters<SimHandler["ask"]>[0], ctx: EffectContext) => sim.ask(req, ctx),
    checkpoint: (req: Parameters<SimHandler["checkpoint"]>[0], ctx: EffectContext) => sim.checkpoint(req, ctx),
    sleep: (req: Parameters<SimHandler["sleep"]>[0], ctx: EffectContext) => sim.sleep(req, ctx),
    wait: (req: Parameters<SimHandler["wait"]>[0], ctx: EffectContext) => sim.wait(req, ctx),
    observe: (req: Parameters<SimHandler["observe"]>[0], ctx: EffectContext) => sim.observe(req, ctx),
    notify: (req: Parameters<SimHandler["notify"]>[0], ctx: EffectContext) => sim.notify(req, ctx),
    monitor: (req: Parameters<SimHandler["monitor"]>[0], ctx: EffectContext) => sim.monitor(req, ctx),
    openConclave: (req: Parameters<SimHandler["openConclave"]>[0], ctx: EffectContext) => sim.openConclave(req, ctx),
    closeConclave: (req: Parameters<SimHandler["closeConclave"]>[0], ctx: EffectContext) => sim.closeConclave(req, ctx),
  };
  const source = 'const native = await participant({ name: "self" });\nlog(native.kind, native.agent);\nawait turn(native, { name: "native" });';
  const first = await run(source, { runId: "participant-live", handler });
  ok("participant forwards only its optional name", JSON.stringify(requests) === '[{"name":"self"}]', requests);
  ok("the host-supplied participant handle reaches the program", first.value === undefined);
  const entry = first.journal.entries().find((candidate) => candidate.kind === "participant");
  ok("participant is journalled with its own durable effect kind", entry?.status === "ok", entry);

  const refusing = new SimHandler({ turns: { native: { status: "done" } } });
  refusing.participant = async () => { throw new Error("replay called participant"); };
  const replay = await run(source, {
    runId: "participant-live",
    handler: refusing,
    pins: first.pins,
    journal: new Journal({ run: "participant-live", entries: first.journal.entries() }),
  });
  ok("a settled participant handle replays without calling the host", replay.journal.entries().length === first.journal.entries().length);
}

{
  const source = 'const a = await participant({ name: "self" });\nconst b = await participant({ name: "self" });\nlog(a.kind, a.agent, b.agent);';
  const logs: unknown[][] = [];
  await run(source, { runId: "participant-sim", handler: new SimHandler({}), onLog: (line) => logs.push([...line.values]) });
  ok("simulation produces deterministic participant handles", JSON.stringify(logs) === '[["participant","sim.participant.self","sim.participant.self-2"]]', logs);

  const report = await dryRun('await participant({ name: "self" });');
  ok("dry run records the participant effect", report.effects[0]?.kind === "participant", report.effects);
  ok("dry run does not report a participant as a spawned agent", report.agents.length === 0, report.agents);
}

{
  const sim = new SimHandler({});
  const key = new KeyScope().nextEffect("spawn", "worker");
  const spawned = await sim.spawn({ persona: "worker" }, {
    key,
    signal: { cancelled: false, onCancel: () => {} },
    requestId: "legacy-check",
    attempt: 0,
    bind: async () => {},
  });
  ok("new spawned handles carry the spawned discriminator", spawned.kind === "spawned", spawned);
  const legacy: AgentHandleValue = { agent: "old.worker", persona: "worker" };
  ok("legacy spawned handle replay remains type-compatible without a discriminator", legacy.kind === undefined, legacy);
}

console.log(`participant: ${pass} checks passed`);

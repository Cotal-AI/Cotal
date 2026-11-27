/**
 * The first command a launch hands its agent (SPEC 13.22), with no broker. The launch file is read
 * once and removed. The command lane queues the command before any other under the id its spawn
 * named, holds it while the harness runs no commands yet, and ends it refused with the harness's
 * cause when the harness cannot run it.
 *
 * Run: pnpm smoke:first-command
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { mock } from "node:test";
import { discardLaunchArtifacts, firstCommandId, type CommandState, type FirstCommand } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { CommandRefused, FIRST_COMMAND_READY_MS, createCommandLane, type AgentCommand, type CommandDispatcher, type CommandLane } from "../src/agent-commands.js";
import { firstCommandEnv, takeFirstCommand } from "../src/first-command.js";

const { check, finish } = createSuite();
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const FIRST: FirstCommand = { id: firstCommandId("spawn-goal-1"), target: "skill", name: "review", args: "the diff" };
const ctx = (args: Record<string, unknown>) =>
  ({ request: { args }, principal: { owner: "u_a", actor: "agent" }, caller: { owner: "u_a", actor: "web", uid: "u1" } }) as never;
const call = async (lane: CommandLane, command: string, args: Record<string, unknown>): Promise<unknown> =>
  lane.handlers.find((h) => h.command === command)!.handler(ctx(args));
const stateOf = async (lane: CommandLane, id = FIRST.id): Promise<CommandState> => ((await call(lane, "command-state", { id })) as { state: CommandState }).state;

function harness(o: { targets?: ("command" | "skill")[]; unsupported?: () => string | undefined; refuse?: CommandRefused } = {}) {
  const ran: AgentCommand[] = [];
  const dispatcher: CommandDispatcher = {
    targets: new Set(o.targets ?? ["command", "skill"]),
    ...(o.unsupported ? { unsupported: o.unsupported } : {}),
    async list() { return []; },
    async dispatch(c) {
      if (o.refuse) throw o.refuse;
      ran.push(c);
    },
  };
  return { dispatcher, ran };
}

// ---- the launch file ----------------------------------------------------------------------------
{
  const artifacts: string[] = [];
  const env = firstCommandEnv(FIRST, artifacts);
  const path = env.COTAL_FIRST_COMMAND_FILE!;
  check("the launch names a private file inside a launch artifact", artifacts.length === 1 && path.startsWith(artifacts[0]!) && (statSync(path).mode & 0o077) === 0, { artifacts, path });
  const procEnv: NodeJS.ProcessEnv = { ...env };
  const taken = takeFirstCommand(procEnv);
  check("the seat takes the command the launch wrote", same(taken, FIRST), taken);
  check("taking it removes the file and drops the variable", !existsSync(path) && procEnv.COTAL_FIRST_COMMAND_FILE === undefined);
  check("a restarted process with the same launch env finds nothing to run again", takeFirstCommand({ ...env }) === undefined);
  check("a launch with no first command writes nothing", same(firstCommandEnv(undefined, artifacts), {}) && artifacts.length === 1);
  writeFileSync(path, JSON.stringify({ ...FIRST, id: "not-an-id" }));
  let thrown: unknown;
  try { takeFirstCommand({ ...env }); } catch (e) { thrown = e; }
  check("a file that is not a first command refuses the seat rather than running something else", thrown instanceof Error && /id/.test(thrown.message), String(thrown));
  check("the launch's id is 26 base32 characters and the same for a retried spawn", /^[a-z2-7]{26}$/.test(FIRST.id) && firstCommandId("spawn-goal-1") === FIRST.id && firstCommandId("spawn-goal-2") !== FIRST.id);
  discardLaunchArtifacts(artifacts);
}

// ---- a harness that runs commands ---------------------------------------------------------------
{
  const h = harness();
  let told = 0;
  const lane = createCommandLane(h.dispatcher, () => { told++; }, FIRST);
  check("the first command waits for the connector at once, under the spawn's id", lane.queued === 1 && same(await stateOf(lane), { kind: "queued" }));
  const later = (await call(lane, "command", { target: "command", name: "later" })) as { id: string };
  check("a command queued after it is announced to the connector", told === 1, told);
  await lane.dispatchNext();
  check("the connector takes the first command before any other, with its args", same(h.ran, [{ target: "skill", name: "review", args: "the diff" }]), h.ran);
  check("its state reads started", same(await stateOf(lane), { kind: "started" }));
  await lane.dispatchNext();
  check("the later command runs next", h.ran[1]?.name === "later" && same(await stateOf(lane, later.id), { kind: "started" }), h.ran);
}

// ---- what a harness cannot run --------------------------------------------------------------------
{
  const none = createCommandLane(undefined, () => {}, FIRST);
  const s = await stateOf(none);
  check("with no dispatcher it ends refused, failed-precondition, and nothing waits", none.queued === 0 && s.kind === "refused" && s.code === "failed-precondition" && /runs no commands or skills/.test(s.message), s);

  const commandsOnly = createCommandLane(harness({ targets: ["command"] }).dispatcher, () => {}, FIRST);
  const t = await stateOf(commandsOnly);
  check("a target the harness does not run ends refused, naming it", commandsOnly.queued === 0 && t.kind === "refused" && t.code === "failed-precondition" && /runs no skills/.test(t.message), t);

  const refusing = harness({ refuse: new CommandRefused("not-found", 'Codex has no enabled skill named "review"') });
  const lane = createCommandLane(refusing.dispatcher, () => {}, FIRST);
  await lane.dispatchNext();
  const r = await stateOf(lane);
  check("a name the harness does not have ends refused not-found with the harness's reason", same(r, { kind: "refused", code: "not-found", message: 'Codex has no enabled skill named "review"' }), r);
}

// ---- a harness that does not run commands yet -------------------------------------------------------
mock.timers.enable({ apis: ["setInterval", "Date"] });
{
  let cause: string | undefined = "the command mod is not running in this Claude Code session";
  const h = harness({ unsupported: () => cause });
  let told = 0;
  const lane = createCommandLane(h.dispatcher, () => { told++; }, FIRST);
  check("while the harness runs no commands, the first command reads queued and the connector is not shown it", lane.queued === 0 && same(await stateOf(lane), { kind: "queued" }) && told === 0);
  mock.timers.tick(1_000);
  check("it stays held while the cause stands", lane.queued === 0 && told === 0);
  cause = undefined;
  mock.timers.tick(250);
  check("once the harness runs commands the connector is told, and it waits for a turn", told === 1 && lane.queued === 1, { told, queued: lane.queued });
  await lane.dispatchNext();
  check("it then runs", h.ran.length === 1 && same(await stateOf(lane), { kind: "started" }));
}
{
  const h = harness({ unsupported: () => "the command mod is not running in this Claude Code session" });
  const lane = createCommandLane(h.dispatcher, () => {}, FIRST);
  mock.timers.tick(FIRST_COMMAND_READY_MS - 250);
  check("it is held up to the bound", same(await stateOf(lane), { kind: "queued" }));
  mock.timers.tick(500);
  const s = await stateOf(lane);
  check("past the bound it ends refused, failed-precondition, with the harness's cause", s.kind === "refused" && s.code === "failed-precondition" && /within 60 s: the command mod is not running/.test(s.message) && lane.queued === 0 && h.ran.length === 0, s);
}
{
  let cause: string | undefined = "not yet";
  const h = harness({ unsupported: () => cause });
  let told = 0;
  const lane = createCommandLane(h.dispatcher, () => { told++; }, FIRST);
  const cancelled = (await call(lane, "command-cancel", { id: FIRST.id })) as { state: CommandState };
  cause = undefined;
  mock.timers.tick(500);
  check("a held first command can be cancelled, and the harness is never shown it", same(cancelled.state, { kind: "cancelled" }) && told === 0 && lane.queued === 0 && h.ran.length === 0, { cancelled, told });
}
{
  const lane = createCommandLane(harness({ unsupported: () => "not yet" }).dispatcher, () => {}, FIRST);
  lane.close();
  const s = await stateOf(lane);
  check("closing the lane refuses a held first command as unavailable", s.kind === "refused" && s.code === "unavailable", s);
}
mock.timers.reset();

finish();

/**
 * A pi seat lists and runs pi's own commands, prompt templates and skills for its `agent` endpoint,
 * and stops pi's turn on `interrupt`.
 *
 * The shipped dispatcher and PiDriver run over a fake pi host that behaves as pi 1.5.2 was measured
 * to: `sendUserMessage` with `expandPromptTemplates` runs an extension command's handler before it
 * returns, and starts a turn for a template or a skill. The fake mesh hands queued commands to the
 * dispatcher as the shared command lane does. No broker is started.
 *
 * Run: pnpm smoke:pi-commands
 */
import type { CommandDispatch, MeshAgent } from "@cotal-ai/connector-core";
import { CommandRefused, type AgentCommand } from "@cotal-ai/connector-core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { piCommandDispatcher, piRunsCommands, type PiCommandHost, type PiCommandInfo } from "../src/commands.js";
import { PiDriver, type CotalBatchDetails, type PiContextLike, type PiHost } from "../src/driver.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2_000): Promise<boolean> => {
  for (let waited = 0; !cond() && waited < ms; waited += 10) await sleep(10);
  return cond();
};

const PI_COMMANDS: PiCommandInfo[] = [
  { name: "spike-cmd", source: "extension", description: "an extension command" },
  { name: "review", source: "extension", description: "the extension command named review" },
  { name: "greet", source: "prompt", description: "Greet someone by name" },
  { name: "review", source: "prompt", description: "a template pi never runs, shadowed by the extension command" },
  { name: "skill:demo", source: "skill", description: "A demo skill" },
];

/** One seat: the shipped driver and dispatcher, a fake pi session and a fake mesh queue. */
function seat(commands: PiCommandInfo[] = PI_COMMANDS) {
  const s = {
    turnOpen: false,
    startsTurns: true,
    abortEnds: true,
    confirmBatches: true,
    sent: [] as string[],
    handlers: [] as string[],
    batches: [] as string[],
    aborts: 0,
    queue: [] as AgentCommand[],
    states: [] as string[],
    pendingTurn: undefined as { goalIds: string[]; text: string } | undefined,
    signal: new AbortController(),
  };
  const ctx: PiContextLike = {
    get signal() { return s.signal.signal; },
    isIdle: () => !s.turnOpen,
    hasUI: false,
    ui: { notify: () => {} },
    shutdown: () => {},
    abort: () => {
      s.aborts++;
      s.signal.abort();
      if (s.abortEnds) queueMicrotask(() => endTurn("aborted"));
    },
  };
  const startTurn = (): void => { s.turnOpen = true; driver.onAgentStart(ctx); };
  const endTurn = (stopReason = "stop"): void => {
    s.turnOpen = false;
    driver.onAgentEnd([{ role: "assistant", stopReason }], ctx);
    s.signal = new AbortController();
  };
  const pi: PiCommandHost = {
    getCommands: () => commands,
    sendUserMessage(text, options) {
      if (options.expandPromptTemplates !== true) throw new Error("sent without expandPromptTemplates");
      s.sent.push(text);
      const name = text.slice(1).split(" ")[0];
      if (commands.some((c) => c.source === "extension" && c.name === name)) return void s.handlers.push(text);
      if (s.startsTurns) queueMicrotask(startTurn);
    },
  };
  const host: PiHost = {
    sendMessage(message) {
      s.batches.push(message.content);
      const custom = { role: "custom", customType: message.customType, details: message.details satisfies CotalBatchDetails };
      queueMicrotask(() => {
        startTurn();
        driver.onMessageStart(custom);
        if (!s.confirmBatches) return;
        driver.onContext([custom]);
        driver.onProviderResponse(200);
      });
    },
  };
  const dispatcher = piCommandDispatcher(() => pi, (): PiDriver => driver);
  const mesh = {
    id: "me",
    attention: "open",
    get queuedCommands() { return s.queue.length; },
    async dispatchNextCommand(): Promise<CommandDispatch> {
      const command = s.queue.shift();
      if (!command) return "empty";
      try {
        await dispatcher.dispatch(command);
        s.states.push(`${command.name}:started`);
        return "dispatched";
      } catch (e) {
        s.states.push(`${command.name}:${e instanceof CommandRefused ? `refused/${e.code}` : `unknown/${(e as Error).message}`}`);
        return "failed";
      }
    },
    peekInbox: () => [],
    inboxPreview: () => [],
    drainInboxDeliveries: () => ({ drained: [], missing: [] }),
    peekPendingTurns: () => s.pendingTurn,
    claimTurns: () => true,
    commitSurfacedTurns: () => { s.pendingTurn = undefined; },
    releaseTurns: () => {},
    noteTurnsDispatched: () => {},
    holdInFlight: () => true,
    releaseInFlight: () => {},
    setStatus: async () => {},
    setCondition: async () => {},
  } as unknown as MeshAgent;
  const driver = new PiDriver(mesh);
  driver.bind(host);
  driver.onSessionStart(ctx);
  const queue = (target: AgentCommand["target"], name: string, args = ""): void => {
    s.queue.push({ target, name, args });
    driver.onCommand();
  };
  return { s, ctx, dispatcher, driver, queue, startTurn, endTurn };
}

console.log("1. only a pi that runs commands an extension sends gets a dispatcher");
check("pi 0.79.10 runs none", !piRunsCommands("0.79.10"));
check("pi 0.84.1 runs none", !piRunsCommands("0.84.1"));
check("pi 0.84.2 runs them", piRunsCommands("0.84.2"));
check("pi 1.5.2 runs them", piRunsCommands("1.5.2"));
check("pi 0.100.0 runs them", piRunsCommands("0.100.0"));
{
  let threw = false;
  try { piRunsCommands("nightly"); } catch { threw = true; }
  check("a version that is not major.minor.patch is refused", threw);
}

console.log("\n2. the list names each command as `command` names it");
{
  const { dispatcher } = seat();
  const list = await dispatcher.list();
  check("extension commands and templates are commands, skills are skills without pi's prefix", JSON.stringify(list) === JSON.stringify([
    { name: "spike-cmd", target: "command", description: "an extension command" },
    { name: "review", target: "command", description: "the extension command named review" },
    { name: "greet", target: "command", description: "Greet someone by name" },
    { name: "demo", target: "skill", description: "A demo skill" },
  ]), list);
  let message = "";
  try { await seat([{ name: "demo", source: "skill" }]).dispatcher.list(); } catch (e) { message = (e as Error).message; }
  check("a skill pi lists without its prefix is refused", message.includes('without its "skill:" prefix'), message);
}

console.log("\n3. each command runs through pi's command path");
{
  const { s, queue } = seat();
  queue("command", "spike-cmd", "hello there");
  await until(() => s.states.length === 1);
  check("an extension command runs its handler with its args", JSON.stringify(s.handlers) === JSON.stringify(["/spike-cmd hello there"]), s.handlers);
  check("it is started without a turn", s.states[0] === "spike-cmd:started" && !s.turnOpen, s.states);
  queue("command", "greet", "world");
  await until(() => s.states.length === 2);
  check("a template is sent as pi's own /greet and is started once its turn starts", s.sent.at(-1) === "/greet world" && s.states[1] === "greet:started" && s.turnOpen, { sent: s.sent, states: s.states });
}
{
  const { s, queue } = seat();
  queue("skill", "demo", "extra args");
  await until(() => s.states.length === 1);
  check("a skill is sent as pi's /skill:demo", s.sent[0] === "/skill:demo extra args" && s.states[0] === "demo:started", { sent: s.sent, states: s.states });
  s.turnOpen = false;
}
{
  const { s, queue } = seat();
  queue("command", "greet");
  await until(() => s.states.length === 1);
  check("a command with no args is sent bare", s.sent[0] === "/greet", s.sent);
}

console.log("\n4. a name pi does not list never reaches pi");
{
  const { s, queue } = seat();
  queue("command", "nosuch", "x");
  queue("command", "demo");
  queue("skill", "greet");
  await until(() => s.states.length === 3);
  check("an unknown command, a skill named as a command and a template named as a skill are refused not-found",
    JSON.stringify(s.states) === JSON.stringify(["nosuch:refused/not-found", "demo:refused/not-found", "greet:refused/not-found"]), s.states);
  check("pi was sent nothing", s.sent.length === 0, s.sent);
}

console.log("\n5. a command waits for the running turn, and messages go first after a command");
{
  const { s, queue, startTurn, endTurn } = seat();
  startTurn();
  queue("command", "greet", "later");
  await sleep(50);
  check("nothing is sent while a turn runs", s.sent.length === 0 && s.states.length === 0, s.sent);
  endTurn();
  await until(() => s.states.length === 1);
  check("the command starts once the turn ended and pi is idle", s.sent[0] === "/greet later" && s.states[0] === "greet:started", s.states);
}
{
  const { s, queue, endTurn } = seat();
  // Waiting before anything pumps, so the commands and the message compete for one idle pi.
  s.pendingTurn = { goalIds: ["g1"], text: "RUN_TURN_WAITING" };
  s.queue.push({ target: "command", name: "spike-cmd", args: "first" });
  queue("command", "spike-cmd", "second");
  await until(() => s.batches.length === 1);
  check("after a command the waiting message goes before the next command",
    JSON.stringify(s.handlers) === JSON.stringify(["/spike-cmd first"]) && s.batches[0]?.includes("RUN_TURN_WAITING"), { batches: s.batches, handlers: s.handlers });
  endTurn();
  await until(() => s.handlers.length === 2);
  check("the next command runs after the message's turn", s.handlers[1] === "/spike-cmd second", s.handlers);
}

console.log("\n6. a template whose turn never starts is unknown, and the queue moves on");
{
  const { s, queue } = seat();
  s.startsTurns = false;
  queue("command", "greet", "nobody");
  queue("command", "spike-cmd", "after");
  await until(() => s.states.length === 2, 8_000);
  check("the template is unknown after the start bound", s.states[0]?.startsWith("greet:unknown/pi started no turn within 5 s"), s.states);
  check("the next command still runs", s.states[1] === "spike-cmd:started", s.states);
}

console.log("\n7. interrupt aborts pi's turn");
{
  const { s, dispatcher, startTurn } = seat();
  check("with no turn running it answers idle and aborts nothing", (await dispatcher.interrupt!()) === "idle" && s.aborts === 0, s.aborts);
  startTurn();
  const state = await dispatcher.interrupt!();
  check("a running turn is aborted and answered once it ended", state === "interrupted" && s.aborts === 1 && !s.turnOpen, { state, aborts: s.aborts });
}

console.log("\n8. a held delivery lets a command start the next turn");
{
  const { s, driver, dispatcher, queue } = seat();
  s.confirmBatches = false;
  s.pendingTurn = { goalIds: ["g2"], text: "RUN_TURN_HELD" };
  driver.onIncoming();
  await until(() => s.turnOpen);
  queue("command", "greet", "resume");
  await sleep(50);
  check("a command queued during the turn waits", s.sent.length === 0, s.sent);
  await dispatcher.interrupt!();
  check("the interrupted turn's unconfirmed batch holds the delivery", driver.state === "held", driver.state);
  await until(() => s.states.length === 1);
  check("the queued command then starts", s.sent[0] === "/greet resume" && s.states[0] === "greet:started", { sent: s.sent, states: s.states });
}
{
  const { s, driver, dispatcher, queue } = seat();
  s.confirmBatches = false;
  s.pendingTurn = { goalIds: ["g3"], text: "RUN_TURN_HELD" };
  driver.onIncoming();
  await until(() => s.turnOpen);
  await dispatcher.interrupt!();
  check("with nothing queued the delivery stays held", driver.state === "held" && s.sent.length === 0, driver.state);
  queue("command", "spike-cmd", "while-held");
  await until(() => s.handlers.length === 1);
  check("a command queued while held starts", s.handlers[0] === "/spike-cmd while-held", s.handlers);
}
{
  const { s, driver, queue, startTurn, endTurn } = seat();
  s.confirmBatches = false;
  s.pendingTurn = { goalIds: ["g4"], text: "RUN_TURN_UNCONFIRMED" };
  driver.onIncoming();
  await until(() => s.turnOpen);
  endTurn();
  check("a turn that ends without confirming its batch holds the delivery", driver.state === "held", driver.state);
  startTurn();
  queue("command", "greet", "not-yet");
  await sleep(50);
  check("a turn its user starts while held still keeps a command waiting", driver.state === "held" && s.sent.length === 0, { state: driver.state, sent: s.sent });
  endTurn();
  await until(() => s.states.length === 1);
  check("the command starts once that turn ended", s.sent[0] === "/greet not-yet" && s.states[0] === "greet:started", { sent: s.sent, states: s.states });
}

console.log(`\n${failed === 0 ? "PI-COMMANDS SMOKE OK" : "PI-COMMANDS SMOKE FAILED"}  (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);

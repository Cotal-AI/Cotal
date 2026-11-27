/**
 * A pi seat lists and runs pi's own commands, prompt templates and skills for its `agent` endpoint,
 * takes its owner's turns, reports its usage, stops pi's turn on `interrupt`, and switches pi's model
 * and thinking level on `set-model` from pi 0.84.3, with the next turn running on the switch.
 *
 * The shipped dispatcher and PiDriver run over a fake pi host that behaves as pi 1.5.2 was measured
 * to: `sendUserMessage` with `expandPromptTemplates` runs an extension command's handler before it
 * returns, and starts a turn for a template or a skill. Without the option it starts a turn on the
 * message as given. Its `setModel` answers false and changes nothing for a model it holds no
 * credentials for, and its `setThinkingLevel` clamps a level the model does not take, as pi's do.
 * Each turn it starts records the model and level it runs on. The fake mesh hands queued commands and
 * turns to the dispatcher as the shared command lane does. No broker is started.
 *
 * Run: pnpm smoke:pi-commands
 */
import type { CommandDispatch, MeshAgent } from "@cotal-ai/connector-core";
import { CommandRefused, type AgentCommand, type AgentTurn } from "@cotal-ai/connector-core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { servedCommands } from "../../connector-core/dist/agent-commands.js";
import { piCommandDispatcher, piRunsCommands, piSwitchesModels, type PiCommandHost, type PiCommandInfo, type PiSessionView } from "../src/commands.js";
import { PiDriver, type CotalBatchDetails, type PiContextLike, type PiHost } from "../src/driver.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
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

/** The fake pi's models: whether it holds credentials for each, and the thinking levels each takes. */
const MODELS = [
  { provider: "prov", id: "vision", input: ["text", "image"], credentials: true, levels: ["off", "low", "medium", "high"] },
  { provider: "prov", id: "text-only", input: ["text"], credentials: true, levels: ["off"] },
  { provider: "prov", id: "deep", input: ["text"], credentials: true, levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { provider: "openrouter", id: "acme/coder-1", input: ["text"], credentials: true, levels: ["off", "low", "high"] },
  { provider: "locked", id: "pro", input: ["text"], credentials: false, levels: ["off", "high"] },
];
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const registered = (provider: string, id: string) => MODELS.find((m) => m.provider === provider && m.id === id);
/** The level the fake runs on `model` for `level`: the highest the model takes at or below it. */
function clamp(model: { provider: string; id: string } | undefined, level: string): string {
  const takes = (model && registered(model.provider, model.id)?.levels) ?? LEVELS;
  for (let i = LEVELS.indexOf(level); i >= 0; i--) if (takes.includes(LEVELS[i]!)) return LEVELS[i]!;
  return "off";
}

type Queued = AgentCommand | { turn: AgentTurn };
const label = (job: Queued): string => ("turn" in job ? "turn" : job.name);

/** One seat: the shipped driver and dispatcher, a fake pi session and a fake mesh queue. */
function seat(commands: PiCommandInfo[] = PI_COMMANDS, runsCommands = true, switchesModels = true) {
  const s = {
    turnOpen: false,
    startsTurns: true,
    abortEnds: true,
    confirmBatches: true,
    sent: [] as string[],
    handlers: [] as string[],
    batches: [] as string[],
    userMessages: [] as unknown[],
    aborts: 0,
    queue: [] as Queued[],
    sessionOpen: true,
    model: { provider: "prov", id: "vision", input: ["text", "image"] } as PiSessionView["model"],
    thinking: "medium",
    /** Each model pi's setModel was asked for, as `provider/id`. */
    modelSwitches: [] as string[],
    /** The model id and level each turn started on. */
    turnsRun: [] as string[],
    contextUsage: { tokens: 51_200, contextWindow: 200_000 } as { tokens: number | null; contextWindow: number } | undefined,
    entries: [] as unknown[],
    oauth: false,
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
  const startTurn = (): void => {
    s.turnOpen = true;
    s.turnsRun.push(`${s.model?.id}:${s.thinking}`);
    driver.onAgentStart(ctx);
  };
  const endTurn = (stopReason = "stop"): void => {
    s.turnOpen = false;
    driver.onAgentEnd([{ role: "assistant", stopReason }], ctx);
    s.signal = new AbortController();
  };
  const pi: PiCommandHost = {
    getCommands: () => commands,
    sendUserMessage(text, options) {
      if (options?.expandPromptTemplates !== true) {
        s.userMessages.push(text);
        if (s.startsTurns) queueMicrotask(startTurn);
        return;
      }
      if (typeof text !== "string") throw new Error("a command was sent as parts");
      s.sent.push(text);
      const name = text.slice(1).split(" ")[0];
      if (commands.some((c) => c.source === "extension" && c.name === name)) return void s.handlers.push(text);
      if (s.startsTurns) queueMicrotask(startTurn);
    },
    async setModel(model) {
      s.modelSwitches.push(`${model.provider}/${model.id}`);
      const known = registered(model.provider, model.id);
      if (!known?.credentials) return false;
      s.model = known;
      s.thinking = clamp(known, s.thinking);
      return true;
    },
    getThinkingLevel: () => s.thinking,
    setThinkingLevel(level) { s.thinking = clamp(s.model, level); },
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
  const session: PiSessionView = {
    get model() { return s.model; },
    modelRegistry: { isUsingOAuth: () => s.oauth, find: registered },
    sessionManager: { getEntries: () => s.entries },
    getContextUsage: () => s.contextUsage,
  };
  const dispatcher = piCommandDispatcher({ host: () => pi, turns: (): PiDriver => driver, session: () => (s.sessionOpen ? session : undefined), commands: runsCommands, models: switchesModels });
  const mesh = {
    id: "me",
    attention: "open",
    get queuedCommands() { return s.queue.length; },
    async dispatchNextCommand(): Promise<CommandDispatch> {
      const job = s.queue.shift();
      if (!job) return "empty";
      try {
        if ("turn" in job) await dispatcher.turn!(job.turn);
        else await dispatcher.dispatch(job);
        s.states.push(`${label(job)}:started`);
        return "dispatched";
      } catch (e) {
        s.states.push(`${label(job)}:${e instanceof CommandRefused ? `refused/${e.code}` : `unknown/${(e as Error).message}`}`);
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
  const queueTurn = (text: string, images: AgentTurn["images"] = []): void => {
    s.queue.push({ turn: { text, images } });
    driver.onCommand();
  };
  return { s, ctx, dispatcher, driver, queue, queueTurn, startTurn, endTurn };
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

const PNG = { mimeType: "image/png" as const, data: "iVBORw0KGgo=" };
const JPEG = { mimeType: "image/jpeg" as const, data: "/9j/4AAQ" };

console.log("\n9. an owner's turn reaches pi as the user's own message");
{
  const { s, dispatcher, queueTurn } = seat();
  check("the dispatcher takes turns with images", typeof dispatcher.turn === "function" && dispatcher.images === true);
  queueTurn("/greet is plain text here");
  await until(() => s.states.length === 1);
  check("the text is sent as typed, without pi's command path, and is started once its turn starts",
    JSON.stringify(s.userMessages) === JSON.stringify(["/greet is plain text here"]) && s.sent.length === 0 && s.states[0] === "turn:started" && s.turnOpen,
    { userMessages: s.userMessages, sent: s.sent, states: s.states });
}
{
  const { s, queueTurn } = seat();
  queueTurn("what is in these?", [PNG, JPEG]);
  await until(() => s.states.length === 1);
  check("text and images go as one message: the text, then each image", JSON.stringify(s.userMessages[0]) === JSON.stringify([
    { type: "text", text: "what is in these?" },
    { type: "image", data: PNG.data, mimeType: "image/png" },
    { type: "image", data: JPEG.data, mimeType: "image/jpeg" },
  ]), s.userMessages);
}
{
  const { s, queueTurn } = seat();
  queueTurn("", [PNG]);
  await until(() => s.states.length === 1);
  check("an image with no text carries no empty text part", JSON.stringify(s.userMessages[0]) === JSON.stringify([{ type: "image", data: PNG.data, mimeType: "image/png" }]), s.userMessages);
}
{
  const { s, queueTurn } = seat();
  s.model = { provider: "prov", id: "text-only", input: ["text"] };
  queueTurn("look", [PNG]);
  queueTurn("no image this time");
  await until(() => s.states.length === 2);
  check("images for a model that takes none are refused before pi sees them, and the queue moves on",
    s.states[0] === "turn:refused/failed-precondition" && s.states[1] === "turn:started" && JSON.stringify(s.userMessages) === JSON.stringify(["no image this time"]),
    { states: s.states, userMessages: s.userMessages });
}
{
  const { s, queueTurn } = seat();
  s.model = undefined;
  queueTurn("hello");
  await until(() => s.states.length === 1);
  check("with no model selected the turn is refused and pi is sent nothing", s.states[0] === "turn:refused/failed-precondition" && s.userMessages.length === 0, s.states);
}
{
  const { s, queueTurn, startTurn, endTurn } = seat();
  startTurn();
  queueTurn("after your turn");
  await sleep(50);
  check("a turn waits while pi runs one", s.userMessages.length === 0 && s.states.length === 0, s.userMessages);
  endTurn();
  await until(() => s.states.length === 1);
  check("it starts once pi is idle", s.states[0] === "turn:started" && s.userMessages[0] === "after your turn", s.states);
}
{
  const { s, queueTurn } = seat();
  s.startsTurns = false;
  queueTurn("into the void");
  await until(() => s.states.length === 1, 8_000);
  check("a turn pi never starts is unknown after the start bound", s.states[0]?.startsWith("turn:unknown/pi started no turn within 5 s"), s.states);
}
{
  const { s, dispatcher, queueTurn } = seat(PI_COMMANDS, false);
  check("a pi that runs no commands lists no command kinds", dispatcher.targets.size === 0);
  queueTurn("older pi");
  await until(() => s.states.length === 1);
  check("and still takes the owner's turn", s.states[0] === "turn:started" && s.userMessages[0] === "older pi", s.states);
}

console.log("\n10. usage reports pi's context window and the session's cost");
{
  const { s, dispatcher } = seat();
  s.entries = [
    { type: "session" },
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "message", message: { role: "assistant", usage: { cost: { total: 0.0125 } } } },
    { type: "message", message: { role: "toolResult", usage: { cost: { total: 0.0005 } } } },
    { type: "compaction", usage: { cost: { total: 0.002 } } },
    { type: "usage", usage: { cost: { total: 0.001 } } },
    { type: "custom", usage: { cost: { total: 9 } } },
  ];
  const got = await dispatcher.usage!();
  check("context is pi's tokens and window, cost the sum of pi's recorded usage in USD",
    got.context?.used === 51_200 && got.context.size === 200_000 && got.cost?.currency === "USD" && Math.abs(got.cost.amount - 0.016) < 1e-9, got);
  s.contextUsage = { tokens: null, contextWindow: 200_000 };
  s.entries = [];
  check("unknown tokens and a zero cost are left out", JSON.stringify(await dispatcher.usage!()) === "{}");
  s.entries = [{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } }];
  s.oauth = true;
  check("a subscription sign-in reports no cost", (await dispatcher.usage!()).cost === undefined);
  s.sessionOpen = false;
  let message = "";
  try { await dispatcher.usage!(); } catch (e) { message = (e as Error).message; }
  check("with no session open it fails", message === "pi has no session open", message);
}

/** How a switch ended: `resolved`, or the refusal's code, or `unknown/<message>` for any other throw. */
const outcome = async (work: Promise<unknown>): Promise<string> => {
  try { await work; return "resolved"; } catch (e) { return e instanceof CommandRefused ? `refused/${e.code}` : `unknown/${(e as Error).message}`; }
};

console.log("\n11. set-model switches pi's model and thinking level, and the next turn runs on them");
check("pi 0.84.2 saves a switch as the operator's own defaults, so it gets none", !piSwitchesModels("0.84.2"));
check("pi 0.84.3 switches the session alone", piSwitchesModels("0.84.3"));
check("pi 1.6.1 switches the session alone", piSwitchesModels("1.6.1"));
{
  const { dispatcher } = seat(PI_COMMANDS, true, false);
  check("below 0.84.3 the dispatcher has no switch, and presence says set-model is not served",
    dispatcher.setModel === undefined && servedCommands(dispatcher).setModel === false, servedCommands(dispatcher));
  check("from 0.84.3 presence says set-model is served", servedCommands(seat().dispatcher).setModel === true);
}
{
  const { s, dispatcher, queueTurn } = seat();
  const got = await dispatcher.setModel!("prov/deep", "high");
  check("an idle switch calls pi's setModel and setThinkingLevel, and answers what pi runs",
    same(got, { model: "prov/deep", variant: "high" }) && same(s.modelSwitches, ["prov/deep"]) && s.thinking === "high", { got, switches: s.modelSwitches, thinking: s.thinking });
  queueTurn("on the new model");
  await until(() => s.states.length === 1);
  check("the next queued turn runs on the new model and level", s.states[0] === "turn:started" && same(s.turnsRun, ["deep:high"]), { states: s.states, turns: s.turnsRun });
}
{
  const { s, dispatcher } = seat();
  const got = await outcome(dispatcher.setModel!("prov/nosuch", "high"));
  check("an unknown model is refused not-found, and pi's setModel is never called",
    got === "refused/not-found" && s.modelSwitches.length === 0 && s.model?.id === "vision" && s.thinking === "medium", { got, switches: s.modelSwitches });
  const bare = await outcome(dispatcher.setModel!("vision", undefined));
  check("a model named without its provider is refused not-found", bare === "refused/not-found" && s.modelSwitches.length === 0, bare);
}
{
  const { s, dispatcher } = seat();
  const got = await outcome(dispatcher.setModel!("locked/pro", "high"));
  check("a model pi holds no credentials for is refused failed-precondition, with the model and level unchanged",
    got === "refused/failed-precondition" && same(s.modelSwitches, ["locked/pro"]) && s.model?.id === "vision" && s.thinking === "medium",
    { got, switches: s.modelSwitches, model: s.model?.id, thinking: s.thinking });
}
{
  const { s, dispatcher, queueTurn } = seat();
  const got = await outcome(dispatcher.setModel!("prov/text-only", "high"));
  check("a level the new model does not take is refused failed-precondition, with the model and level pi ran put back",
    got === "refused/failed-precondition" && same(s.modelSwitches, ["prov/text-only", "prov/vision"]) && s.model?.id === "vision" && s.thinking === "medium",
    { got, switches: s.modelSwitches, model: s.model?.id, thinking: s.thinking });
  const alone = await outcome(dispatcher.setModel!(undefined, "max"));
  check("a level alone that pi clamps is refused, with the level put back and no model switch",
    alone === "refused/failed-precondition" && s.thinking === "medium" && s.modelSwitches.length === 2, { alone, thinking: s.thinking });
  queueTurn("still as before");
  await until(() => s.states.length === 1);
  check("the next turn runs on the model and level from before", same(s.turnsRun, ["vision:medium"]), s.turnsRun);
}
{
  const { s, dispatcher, queueTurn } = seat();
  const got = await dispatcher.setModel!(undefined, "low");
  check("a variant alone changes only pi's thinking level",
    same(got, { model: "prov/vision", variant: "low" }) && s.modelSwitches.length === 0 && s.thinking === "low", { got, switches: s.modelSwitches });
  const neither = await dispatcher.setModel!(undefined, undefined);
  check("with neither, nothing changes and the answer is what pi runs", same(neither, { model: "prov/vision", variant: "low" }) && s.modelSwitches.length === 0, neither);
  queueTurn("thinking less");
  await until(() => s.states.length === 1);
  check("the next turn runs at the new level", same(s.turnsRun, ["vision:low"]), s.turnsRun);
}
{
  const { s, dispatcher, queueTurn } = seat();
  const got = await dispatcher.setModel!("openrouter/acme/coder-1", undefined);
  check("a model id holding a / is found by the provider before the first /, and without a variant the answer is the level pi carried over and clamped",
    same(got, { model: "openrouter/acme/coder-1", variant: "low" }) && same(s.modelSwitches, ["openrouter/acme/coder-1"]), { got, switches: s.modelSwitches });
  queueTurn("on openrouter");
  await until(() => s.states.length === 1);
  check("the next turn runs on that model at that level", same(s.turnsRun, ["acme/coder-1:low"]), s.turnsRun);
}
{
  const { s, dispatcher } = seat();
  const got = await outcome(dispatcher.setModel!("prov/deep", "turbo"));
  check("a variant that is not a pi thinking level is refused failed-precondition before pi is asked anything",
    got === "refused/failed-precondition" && s.modelSwitches.length === 0 && s.model?.id === "vision" && s.thinking === "medium", { got, switches: s.modelSwitches });
}
{
  const { s, dispatcher } = seat();
  s.model = undefined;
  const noModel = await outcome(dispatcher.setModel!(undefined, "low"));
  check("a variant alone while pi has no model selected is refused failed-precondition", noModel === "refused/failed-precondition" && s.thinking === "medium", noModel);
  s.sessionOpen = false;
  const got = await outcome(dispatcher.setModel!("prov/deep", "high"));
  check("with no session open the switch is refused failed-precondition", got === "refused/failed-precondition" && s.modelSwitches.length === 0, got);
}

console.log(`\n${failed === 0 ? "PI-COMMANDS SMOKE OK" : "PI-COMMANDS SMOKE FAILED"}  (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);

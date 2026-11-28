// Serves the agent endpoint's command requests for this session (SPEC 13.22). A mod cannot open a
// socket or write to a running child's stdin, so a reader relays the seat server's requests on its
// stdout and a one-shot helper carries each answer back.

import { streamTo } from './stream.js';

const ALLOW = 'allow';
const PANEL = 'refuse-panel';
const SETTINGS = 'refuse-writes-settings';

// A command the person, a plugin or an MCP server added runs as if typed at the seat.
const OPEN_SOURCES = new Set(['user', 'plugin', 'mcp']);

// Claude Code's own commands as of 2.1.330. A built-in without a row does not run remotely.
const BUILTINS = new Map(Object.entries({
  // Prints text or runs a prompt turn, with no panel and no settings write.
  context: ALLOW,
  compact: ALLOW,
  init: ALLOW,
  'security-review': ALLOW,
  'code-review': ALLOW,
  simplify: ALLOW,
  verify: ALLOW,
  // Opens a panel, and the run does not end until someone at the seat closes it.
  usage: PANEL,
  status: PANEL,
  help: PANEL,
  'release-notes': PANEL,
  diff: PANEL,
  resume: PANEL,
  rewind: PANEL,
  hooks: PANEL,
  tasks: PANEL,
  mcp: PANEL,
  plugin: PANEL,
  // Changes the settings of the person at the seat.
  model: SETTINGS,
  config: SETTINGS,
  effort: SETTINGS,
  theme: SETTINGS,
  fast: SETTINGS,
  autocompact: SETTINGS,
  'output-style': SETTINGS,
  tui: SETTINGS,
  statusline: SETTINGS,
  permissions: SETTINGS,
  'update-config': SETTINGS,
  'fewer-permission-prompts': SETTINGS,
}));

const REFUSALS = {
  [PANEL]: (name) => `/${name} opens a panel that only someone at the seat can close`,
  [SETTINGS]: (name) => `/${name} changes Claude Code settings at the seat`,
};

// Claude's refusal texts and what each means for the request, given Claude's text from the match
// on. Any other refusal leaves the outcome unknown, so it answers as an error.
const REJECTIONS = [
  ['run', 'no command named', (claude) => ({ outcome: 'not-found', reason: claude })],
  ['run', 'the session was stopped and nobody has sent input since', () => ({ outcome: 'refused', reason: 'waiting for local input' })],
  ['run', 'was removed from the queue before it ran', () => ({ outcome: 'refused', reason: 'dropped by a local Stop' })],
  ['interrupt', 'no turn is running', () => ({ outcome: 'idle' })],
];

// The answer frame's limits, in code points, as the seat server's parser counts them.
const NAME = /^\S{1,128}$/u;
const MAX_COMMANDS = 2048;
const MAX_TEXT = 4096;
const MAX_REASON = 2000;

// How long an interrupt waits for the aborted turn to complete.
const COMPLETE_MS = 2000;

const described = new Map();
let turnId;
// Message count where the uninterrupted main-turn chain began, so a later prompt in the chain
// does not move the slice past tools an abort already moved to the background.
let since;
// The owner's model switch (SPEC 13.22): `{ model, effort? }`, which every step of each main turn
// that starts after it goes out on. It lives in this session alone, because Claude Code's own
// /model and /effort save the person's settings.
let wanted;
// The switch the running main turn started under: a turn already running keeps its model.
let running;
// Resolvers for interrupts waiting on a main turn's completion, by turn id.
const completions = new Map();

const clip = (text, max) => [...text].slice(0, max).join('');
const messageOf = (error) => String(error?.message ?? error) || 'unknown error';

// A refusing row comes first: Claude ships some of its own commands, such as /diff, as plugins.
function verdict({ name, source }) {
  const row = BUILTINS.get(name);
  if (row && row !== ALLOW) return REFUSALS[row](name);
  if (row === ALLOW || OPEN_SOURCES.has(source)) return undefined;
  return `/${name} is a Claude Code command that does not run remotely`;
}

// Why a remote request may not run `name`, or undefined when it may. Claude picks the entry a name
// runs, so a name is refused when any entry listed under it is. The connector applies it to the list
// a launcher reads before launch, so that list offers only what the seat will run.
export const refusal = (commands, name) => commands.filter((entry) => entry.name === name).map(verdict).find(Boolean);

// Exported for the cells: Claude's test kit cannot make `$.command.run` reject.
export function rejected(op, message) {
  for (const [rowOp, text, outcome] of REJECTIONS) {
    if (rowOp === op && message.includes(text)) return { op, ...outcome(message.slice(message.indexOf(text))) };
  }
  return { op: 'error', reason: message };
}

async function list($) {
  const commands = await $.command.list();
  const shown = commands.filter(({ name }) => NAME.test(name) && !described.get(name)?.isHidden && !refusal(commands, name));
  return {
    op: 'list',
    commands: shown.slice(0, MAX_COMMANDS).map(({ name, description }) => {
      const argumentHint = described.get(name)?.argumentHint;
      return {
        name,
        ...(description ? { description: clip(description, MAX_TEXT) } : {}),
        ...(argumentHint ? { argumentHint: clip(argumentHint, MAX_TEXT) } : {}),
      };
    }),
  };
}

// Only a name Claude lists runs. Claude itself also resolves aliases and plugin suffixes, and either
// could reach a refused built-in under another name.
async function run($, { command: name, args }) {
  const commands = await $.command.list();
  if (!commands.some((entry) => entry.name === name)) return { op: 'run', outcome: 'not-found', reason: `no command named /${name} in this session` };
  const reason = refusal(commands, name);
  if (reason) return { op: 'run', outcome: 'refused', reason };
  try {
    await $.command.run({ command: name, args });
  } catch (error) {
    return rejected('run', messageOf(error));
  }
  return { op: 'run', outcome: 'started' };
}

const isPrompt = (message) => message.role === 'user' && message.text && !message.toolResults?.length;

// Stops each tool an abort moved to the background from `from` onwards, or since the last prompt
// when no mark is held. Says why when a stop was refused.
async function stopBackgrounded($, from) {
  const messages = await $.session.messages();
  const start = from ?? messages.findLastIndex(isPrompt) + 1;
  const tasks = new Set();
  for (const message of messages.slice(start)) {
    for (const { result } of message.toolResults ?? []) {
      if (result?.backgroundedByTurnAbort === true && typeof result.backgroundTaskId === 'string') tasks.add(result.backgroundTaskId);
    }
  }
  let refused = false;
  for (const task_id of tasks) {
    const stopped = await $.tool.call({ tool: 'TaskStop', task_id }).catch((error) => ({ deny: messageOf(error) }));
    if (stopped.deny !== undefined) refused = true;
  }
  return refused ? 'a tool is still running' : undefined;
}

// Resolves true once the main turn `id` completed, or false after COMPLETE_MS.
function completion($, id) {
  return new Promise((resolve) => {
    const timer = $.clock.after(COMPLETE_MS, () => {
      completions.delete(id);
      resolve(false);
    });
    completions.set(id, () => {
      timer.cancel();
      completions.delete(id);
      resolve(true);
    });
  });
}

async function interrupt($) {
  if (turnId === undefined) return { op: 'interrupt', outcome: 'idle' };
  const stopping = turnId;
  const from = since;
  // Claude records the tool results an abort moved to the background after the abort resolves, so
  // they are read once the aborted turn completed.
  const completed = completion($, stopping);
  try {
    await $.turn.abort({ turnId: stopping });
  } catch (error) {
    completions.get(stopping)?.();
    return rejected('interrupt', messageOf(error));
  }
  if (!(await completed)) {
    since = undefined;
    const reason = `the aborted turn did not complete within ${COMPLETE_MS / 1000} s, so tools it moved to the background may still run`;
    return { op: 'interrupt', outcome: 'interrupted', reason };
  }
  const reason = await stopBackgrounded($, from).catch((error) => `could not stop the tools the interrupt left running: ${messageOf(error)}`);
  return { op: 'interrupt', outcome: 'interrupted', ...(reason ? { reason } : {}) };
}

// The owner's words as the person's own, a turn of its own once the session is idle.
async function prompt($, { text }) {
  const submitted = await $.prompt.submit({ text, asUser: true });
  if (submitted.drop !== undefined) return { op: 'prompt', outcome: 'refused', reason: submitted.drop || 'Claude Code dropped the prompt' };
  return { op: 'prompt', outcome: 'submitted' };
}

// The status line's figures: no breakdown, so the call sends no request.
async function usage($) {
  const { context, cost } = await $.session.usage();
  return {
    op: 'usage',
    window: context.window,
    ...(context.tokens !== undefined ? { tokens: context.tokens } : {}),
    ...(cost ? { usd: cost.usd } : {}),
  };
}

// The model the session runs from its next main turn: the one named, else the one in force.
async function switchModel($, { model, effort }) {
  const name = model ?? wanted?.model ?? (await $.session.model());
  wanted = { model: name, ...(effort !== undefined ? { effort } : {}) };
  return { op: 'model', ...wanted };
}

async function answerFor($, request) {
  try {
    if (request.op === 'list') return await list($);
    if (request.op === 'run') return await run($, request);
    if (request.op === 'interrupt') return await interrupt($);
    if (request.op === 'prompt') return await prompt($, request);
    if (request.op === 'usage') return await usage($);
    if (request.op === 'model') return await switchModel($, request);
    return { op: 'error', reason: `unknown request op ${JSON.stringify(request.op)}` };
  } catch (error) {
    return { op: 'error', reason: messageOf(error) };
  }
}

async function serve($, line) {
  const request = JSON.parse(line);
  if (request.op === 'stream') return streamTo(request);
  const answer = await answerFor($, request);
  if (answer.reason !== undefined) answer.reason = clip(answer.reason, MAX_REASON);
  await $.process.run(['node', $.plugin.root + '/dist/command-reader.cjs', 'answer', request.route], {
    stdin: JSON.stringify({ id: request.id, ...answer }),
  });
}

// Runs outside every hook: `$.command.run` rejects inside a hook the turn or the session's start
// waits on. Each request is served on its own, so an interrupt is not held behind a queued run.
async function listen($) {
  const { version } = await $.session.version();
  const reader = $.process.spawn({ argv: ['node', $.plugin.root + '/dist/command-reader.cjs', 'read', '--claude', version] });
  let buffer = '';
  for await (const piece of reader) {
    if (piece.stream !== 'stdout') continue;
    buffer += piece.text;
    // An answer that cannot be sent has no way back; the server's caller times the request out.
    for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) serve($, buffer.slice(0, end)).catch(() => {});
  }
}

// native-wake.js holds this plugin's unmatched hook on each event it shares with this file, and a
// plugin may hook an event once per matcher. Commands serve interactive sessions, which every seat
// is; `turnId: /./` matches every turn.
export function register(on) {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e);
    // A reader that cannot start or stops leaves no reader, which the seat server reports as the cause.
    listen($).catch(() => {});
    return started;
  });
  on('command.describe', async ($, e, next) => {
    const shown = await next(e);
    described.set(e.command, shown);
    return shown;
  });
  on('turn.start', { turnId: /./ }, async ($, e, next) => {
    if (e.agentId === undefined) {
      turnId = e.turnId;
      running = wanted;
      since ??= await $.session.messages().then((m) => m.length, () => undefined);
    }
    return next(e);
  });
  // A rewrite lasts one step, so each of the main turn's steps carries the switch. A subagent's
  // steps keep the model Claude Code picks for them.
  on('turn.step', { turnId: /./ }, async function* ($, e, next) {
    if (e.agentId !== undefined || running === undefined || e.turnId !== turnId) return yield* next(e);
    return yield* next({ ...e, ...running });
  });
  // A /model or /effort run at the seat wins from the next turn: Claude Code shows the person its own
  // setting, which a switch leaves unchanged. This mod never runs either.
  on('command.run', { command: /^(model|effort)$/ }, async ($, e, next) => {
    const ran = await next(e);
    if (e.command === 'model') wanted = undefined;
    else if (wanted) wanted = { model: wanted.model };
    return ran;
  });
  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    const completed = await next(e);
    if (e.agentId === undefined) {
      if (e.turnId === turnId) turnId = undefined;
      if (!e.isAborted || completions.has(e.turnId)) since = undefined;
      completions.get(e.turnId)?.();
    }
    return completed;
  });
}

// Cells for hooks/commands.js, run by `claude plugin test` with no session and no sign-in.
// `pnpm smoke:claude-command-mod` runs them and checks the count.
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'
import { rejected } from '../hooks/commands.js'

type Source = 'builtin' | 'user' | 'plugin' | 'mcp'
type Entry = { name: string; description: string; source: Source }
type Frame = Record<string, unknown>
type Stub = { deny: string } | undefined

const ROUTE = '/tmp/cotal-claude-cmd-1000/4242-4343.sock'

// The rows the policy must hold. Each is its own cell, so removing a row reddens exactly one.
const ALLOWED = ['context', 'compact', 'init', 'security-review', 'code-review', 'simplify', 'verify']
const PANELS = ['usage', 'status', 'help', 'release-notes', 'diff', 'resume', 'rewind', 'hooks', 'tasks', 'mcp', 'plugin']
const SETTINGS = ['model', 'config', 'effort', 'theme', 'fast', 'autocompact', 'output-style', 'tui', 'statusline', 'permissions', 'update-config', 'fewer-permission-prompts']

const builtin = (name: string): Entry => ({ name, description: `the built-in /${name}`, source: 'builtin' })
const USER: Entry = { name: 'x', description: 'Project command x', source: 'user' }
const PLUGIN: Entry = { name: 'probecmds:plugcmd', description: 'Plugin command', source: 'plugin' }
const MCP: Entry = { name: 'mcp__srv__prompt', description: 'An MCP prompt', source: 'mcp' }
const OPEN = [USER, PLUGIN, MCP]
// Claude's list puts the person's own commands first, then built-ins and plugins, hidden ones included.
const LIST: Entry[] = [
  USER,
  { name: 'secret', description: 'A hidden project command', source: 'user' },
  ...[...ALLOWED, ...PANELS, ...SETTINGS, 'exit', 'heapdump'].map(builtin),
  PLUGIN,
  MCP,
]

interface Options {
  env?: Record<string, string>
  list?: Entry[]
  abort?: (turnId: string) => Stub
  messages?: SessionMessage[] | (() => SessionMessage[])
  stop?: (taskId: string) => Stub
  readerFails?: boolean
  drop?: string
  usage?: { context: { tokens?: number; window: number }; cost?: { usd: number } }
  model?: string
}

// Stands in for Claude Code under the mod and for the seat server beyond its reader and helper.
function seat(on: On, options: Options = {}) {
  const record = { reader: [] as string[][], helper: [] as string[][], runs: [] as string[][], aborts: [] as string[], stops: [] as string[], prompts: [] as unknown[], steps: [] as unknown[][] }
  const lines: string[] = []
  const answers = new Map<string, (frame: Frame) => void>()
  let wake = () => {}
  mock.env(on, options.env ?? { COTAL_NAME: 'seat-a' })
  on('fs.read', () => ({ deny: 'this test has no CLI record' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.version', () => ({ value: { version: '2.1.330' } }))
  on('process.spawn', async function* ($, e) {
    record.reader.push([...e.argv])
    if (options.readerFails) throw new Error('node is not on PATH')
    for (;;) {
      while (lines.length) yield { stream: 'stdout' as const, text: lines.shift()! }
      await new Promise<void>((resolve) => { wake = resolve })
    }
  })
  on('process.run', ($, e) => {
    record.helper.push([...e.argv])
    const frame = JSON.parse(e.init?.stdin ?? '{}') as Frame
    answers.get(String(frame.id))?.(frame)
    return { value: { exitCode: 0, stdout: 'ok\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.list', () => ({ value: options.list ?? LIST }))
  on('command.describe', ($, e) => ({ description: e.description, argumentHint: e.argumentHint, isHidden: e.isHidden }))
  on('command.run', ($, e) => {
    record.runs.push([e.command, e.args])
    return { text: '' }
  })
  on('prompt.submit', ($, e) => {
    record.prompts.push({ text: e.text, origin: e.origin })
    return options.drop !== undefined ? { drop: options.drop } : { text: e.text }
  })
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], ...(options.usage ?? { context: { window: 200000 } }) } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.model', () => ({ value: options.model ?? 'claude-opus-5-5' }))
  // The engine's request: what each step goes out on.
  on('turn.step', async function* ($, e) {
    record.steps.push([e.turnId, e.agentId ?? 'main', e.model, e.effort ?? 'none'])
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  // Static fixtures list the session after the abort: messages through the last prompt were already
  // there when the turn started, and the aborted turn's tool results appear once it completes.
  const isPrompt = (m: SessionMessage) => m.role === 'user' && Boolean(m.text) && !m.toolResults?.length
  let settled = false
  on('turn.complete', () => {
    settled = true
    return { text: '' }
  })
  on('turn.abort', ($, e) => {
    record.aborts.push(e.turnId)
    return options.abort?.(e.turnId) ?? { value: undefined }
  })
  on('session.messages', () => {
    if (typeof options.messages === 'function') return { value: [...options.messages()] }
    const list = options.messages ?? []
    return { value: settled ? list : list.slice(0, list.findLastIndex(isPrompt) + 1) }
  })
  on('tool.call', ($, e) => {
    if (e.tool !== 'TaskStop') return { deny: `this test runs no ${e.tool}` }
    const task = String((e as { task_id?: unknown }).task_id)
    record.stops.push(task)
    return options.stop?.(task) ?? { result: { message: `stopped ${task}` } }
  })
  let sent = 0
  const ask = (request: Frame) => new Promise<Frame>((resolve) => {
    const id = `r${++sent}`
    answers.set(id, resolve)
    lines.push(`${JSON.stringify({ ...request, id, route: ROUTE })}\n`)
    wake()
  })
  return { ask, record }
}

const start = ($: Engine) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
// One model request of turn `turnId` at the launch model and effort, read to its end.
async function step($: Engine, turnId: string, agentId?: string) {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const chunk of stream) void chunk
  return stream.result
}
const PRESENTATION = { isFullscreen: false, columns: 80 }
// An abort Claude accepts: the aborted turn completes a moment later.
const completes = ($: Engine) => (turnId: string): Stub => {
  setTimeout(() => void $.turn.complete({ turnId, answer: '', durationMs: 5, isAborted: true, reason: 'aborted' }), 1)
  return undefined
}

describe('policy', () => {
  for (const name of ALLOWED) {
    test(`allow row: /${name} runs`, async ($, on) => {
      const { ask, record } = seat(on)
      await start($)
      expect(await ask({ op: 'run', command: name, args: 'a b' })).toEqual({ id: 'r1', op: 'run', outcome: 'started' })
      expect(record.runs).toEqual([[name, 'a b']])
    })
  }
  for (const name of PANELS) {
    test(`refuse-panel row: /${name} is refused unrun`, async ($, on) => {
      const { ask, record } = seat(on)
      await start($)
      expect(await ask({ op: 'run', command: name, args: '' })).toEqual({
        id: 'r1', op: 'run', outcome: 'refused', reason: `/${name} opens a panel that only someone at the seat can close`,
      })
      expect(record.runs).toHaveLength(0)
    })
  }
  for (const name of SETTINGS) {
    test(`refuse-writes-settings row: /${name} is refused unrun`, async ($, on) => {
      const { ask, record } = seat(on)
      await start($)
      expect(await ask({ op: 'run', command: name, args: '' })).toEqual({
        id: 'r1', op: 'run', outcome: 'refused', reason: `/${name} changes Claude Code settings at the seat`,
      })
      expect(record.runs).toHaveLength(0)
    })
  }
  test('a built-in with no row is refused unrun', async ($, on) => {
    const { ask, record } = seat(on)
    await start($)
    expect(await ask({ op: 'run', command: 'exit', args: '' })).toEqual({
      id: 'r1', op: 'run', outcome: 'refused', reason: '/exit is a Claude Code command that does not run remotely',
    })
    expect(record.runs).toHaveLength(0)
  })
  test('user, plugin and mcp commands run', async ($, on) => {
    const { ask, record } = seat(on)
    await start($)
    for (const { name } of OPEN) expect((await ask({ op: 'run', command: name, args: 'go' })).outcome).toBe('started')
    expect(record.runs).toEqual(OPEN.map(({ name }) => [name, 'go']))
  })
  test('a refusing row applies whatever source Claude gives the command', async ($, on) => {
    const { ask, record } = seat(on, { list: [{ name: 'diff', description: 'Toggle the diff panel', source: 'plugin' }] })
    await start($)
    expect(await ask({ op: 'list' })).toEqual({ id: 'r1', op: 'list', commands: [] })
    expect((await ask({ op: 'run', command: 'diff', args: '' })).outcome).toBe('refused')
    expect(record.runs).toHaveLength(0)
  })
})

describe('exact names', () => {
  test('an alias, a suffix or another case of a listed name is not found and not run', async ($, on) => {
    const { ask, record } = seat(on)
    await start($)
    for (const name of ['cost', 'plugcmd', 'Context']) {
      const answer = await ask({ op: 'run', command: name, args: '' })
      expect(answer).toEqual({ id: answer.id, op: 'run', outcome: 'not-found', reason: `no command named /${name} in this session` })
    }
    expect(record.runs).toHaveLength(0)
  })
  test('a name listed twice runs only when every entry allows it', async ($, on) => {
    // /exit has no row, so the person's own /exit alone would run.
    const { ask, record } = seat(on, { list: [{ name: 'exit', description: 'mine', source: 'user' }, builtin('exit')] })
    await start($)
    expect(await ask({ op: 'run', command: 'exit', args: '' })).toEqual({
      id: 'r1', op: 'run', outcome: 'refused', reason: '/exit is a Claude Code command that does not run remotely',
    })
    expect(record.runs).toHaveLength(0)
  })
})

// Claude rejects `$.command.run` itself, and the test kit cannot make it, so the run rows are
// checked on the mapping the mod applies to the rejection's message.
describe('rejections', () => {
  test('no command named: not-found with Claude\'s text', () => {
    expect(rejected('run', 'cotal: $.command.run: no command named /gone in this session')).toEqual({
      op: 'run', outcome: 'not-found', reason: 'no command named /gone in this session',
    })
  })
  test('the session was stopped: refused, waiting for local input', () => {
    expect(rejected('run', 'cotal: $.command.run: the session was stopped and nobody has sent input since')).toEqual({
      op: 'run', outcome: 'refused', reason: 'waiting for local input',
    })
  })
  test('removed from the queue: refused, dropped by a local Stop', () => {
    expect(rejected('run', 'cotal: $.command.run: the command was removed from the queue before it ran')).toEqual({
      op: 'run', outcome: 'refused', reason: 'dropped by a local Stop',
    })
  })
  test('any other rejection: error with Claude\'s text', () => {
    expect(rejected('run', 'cotal: $.command.run: the disk is on fire')).toEqual({ op: 'error', reason: 'cotal: $.command.run: the disk is on fire' })
    expect(rejected('interrupt', 'cotal: $.command.run: no command named /x in this session')).toEqual({
      op: 'error', reason: 'cotal: $.command.run: no command named /x in this session',
    })
  })
  test('no turn is running: idle', async ($, on) => {
    mock.clock(on)
    const { ask, record } = seat(on, { abort: (turnId) => ({ deny: `no turn is running (asked for ${turnId})` }) })
    await start($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'idle' })
    expect(record.aborts).toEqual(['t1'])
  })
})

describe('list', () => {
  test('lists what a remote request may run, without hidden entries, with hints', async ($, on) => {
    const { ask } = seat(on)
    await start($)
    const describe = (name: string, isHidden: boolean, argumentHint?: string) => $.command.describe({
      command: name, description: 'described', isHidden, immediate: false,
      ...(argumentHint ? { argumentHint } : {}),
      provider: { plugin: 'engine', tier: 'core' },
    })
    await describe('x', false, 'word')
    await describe('secret', true)
    await describe('heapdump', true)
    await describe('context', false, '[all]')
    const answer = await ask({ op: 'list' })
    const expected = [
      { name: 'x', description: 'Project command x', argumentHint: 'word' },
      ...ALLOWED.map((name) => ({ name, description: `the built-in /${name}`, ...(name === 'context' ? { argumentHint: '[all]' } : {}) })),
      { name: 'probecmds:plugcmd', description: 'Plugin command' },
      { name: 'mcp__srv__prompt', description: 'An MCP prompt' },
    ]
    expect(answer.commands).toHaveLength(ALLOWED.length + 3)
    expect(answer).toEqual({ id: 'r1', op: 'list', commands: expected })
  })
})

describe('interrupt', () => {
  const ABORTED: SessionMessage[] = [
    { role: 'user', text: 'earlier prompt', toolUses: [] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u0', text: '', isError: false, result: { backgroundTaskId: 'old', backgroundedByTurnAbort: true } }] },
    { role: 'user', text: 'run the two scripts', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: {} }, { tool_use_id: 'u2', tool: 'Bash', input: {} }, { tool_use_id: 'u3', tool: 'Read', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [
      { tool_use_id: 'u1', text: '', isError: false, result: { backgroundTaskId: 'b1', backgroundedByTurnAbort: true } },
      { tool_use_id: 'u2', text: '', isError: false, result: { backgroundTaskId: 'b2', backgroundedByTurnAbort: true } },
      { tool_use_id: 'u3', text: '', isError: false, result: { backgroundTaskId: 'b3' } },
    ] },
  ]
  test('idle when no turn started', async ($, on) => {
    const { ask, record } = seat(on)
    await start($)
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'idle' })
    expect(record.aborts).toHaveLength(0)
  })
  test('idle once the main turn completed', async ($, on) => {
    const { ask, record } = seat(on)
    await start($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'idle' })
    expect(record.aborts).toHaveLength(0)
  })
  test('aborts the main-loop turn, not a subagent turn', async ($, on) => {
    mock.clock(on)
    const { ask, record } = seat(on, { abort: completes($) })
    await start($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.start({ text: 'sub', turnId: 't2', agentId: 'a1' })
    await $.turn.complete({ turnId: 't2', agentId: 'a1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted' })
    expect(record.aborts).toEqual(['t1'])
    expect(record.stops).toHaveLength(0)
  })
  test('stops each tool the abort moved to the background', async ($, on) => {
    mock.clock(on)
    const { ask, record } = seat(on, { messages: ABORTED, abort: completes($) })
    await start($)
    await $.turn.start({ text: 'run the two scripts', turnId: 't1' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted' })
    expect(record.stops).toEqual(['b1', 'b2'])
  })
  test('a refused TaskStop: interrupted, a tool is still running', async ($, on) => {
    mock.clock(on)
    const { ask, record } = seat(on, { messages: ABORTED, abort: completes($), stop: (task) => (task === 'b1' ? { deny: 'not now' } : undefined) })
    await start($)
    await $.turn.start({ text: 'run the two scripts', turnId: 't1' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted', reason: 'a tool is still running' })
    expect(record.stops).toEqual(['b1', 'b2'])
  })
  test('an aborted turn that does not complete: interrupted, its tools may still run', async ($, on) => {
    const clock = mock.clock(on)
    const { ask, record } = seat(on, { messages: ABORTED, abort: () => void clock.advance(2000) })
    await start($)
    await $.turn.start({ text: 'run the two scripts', turnId: 't1' })
    expect(await ask({ op: 'interrupt' })).toEqual({
      id: 'r1', op: 'interrupt', outcome: 'interrupted',
      reason: 'the aborted turn did not complete within 2 s, so tools it moved to the background may still run',
    })
    expect(record.stops).toHaveLength(0)
  })
  const userPrompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
  const bashUse = (id: string): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: {} }] })
  const bashAborted = (id: string, task: string): SessionMessage => ({
    role: 'user', text: '', toolUses: [],
    toolResults: [{ tool_use_id: id, text: '', isError: false, result: { backgroundTaskId: task, backgroundedByTurnAbort: true } }],
  })
  test('stops a tool whose abort result precedes a preempting prompt', async ($, on) => {
    mock.clock(on)
    const history: SessionMessage[] = [userPrompt('earlier'), bashAborted('u0', 'old')]
    const { ask, record } = seat(on, { messages: () => history, abort: completes($) })
    await start($)
    history.push(userPrompt('run loop'))
    await $.turn.start({ text: 'run loop', turnId: 't1' })
    history.push(bashUse('u1'), bashAborted('u1', 'b1'), userPrompt('preempting message'))
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: true, reason: 'aborted' })
    await $.turn.start({ text: 'preempting message', turnId: 't2' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted' })
    expect(record.aborts).toEqual(['t2'])
    expect(record.stops).toEqual(['b1'])
  })
  test('plain interrupt stops its task once and a later interrupt does not stop it again', async ($, on) => {
    mock.clock(on)
    const history: SessionMessage[] = []
    const { ask, record } = seat(on, {
      messages: () => history,
      abort: (turnId) => {
        if (turnId === 't1') history.push(bashUse('u1'), bashAborted('u1', 'b1'))
        if (turnId === 't2') history.push(bashUse('u2'), bashAborted('u2', 'b2'))
        return completes($)(turnId)
      },
    })
    await start($)
    history.push(userPrompt('first'))
    await $.turn.start({ text: 'first', turnId: 't1' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted' })
    expect(record.stops).toEqual(['b1'])
    history.push(userPrompt('second'))
    await $.turn.start({ text: 'second', turnId: 't2' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r2', op: 'interrupt', outcome: 'interrupted' })
    expect(record.stops).toEqual(['b1', 'b2'])
  })
  test('a turn that ends normally clears the mark before a later interrupt', async ($, on) => {
    mock.clock(on)
    const history: SessionMessage[] = []
    const { ask, record } = seat(on, { messages: () => history, abort: completes($) })
    await start($)
    history.push(userPrompt('first'))
    await $.turn.start({ text: 'first', turnId: 't1' })
    history.push(bashUse('u1'), bashAborted('u1', 'b1'), userPrompt('second'))
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: true, reason: 'aborted' })
    await $.turn.start({ text: 'second', turnId: 't2' })
    await $.turn.complete({ turnId: 't2', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
    history.push(userPrompt('third'))
    await $.turn.start({ text: 'third', turnId: 't3' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted' })
    expect(record.aborts).toEqual(['t3'])
    expect(record.stops).toEqual([])
  })
  test('two aborted turns in a row before an interrupt stop both tasks', async ($, on) => {
    mock.clock(on)
    const history: SessionMessage[] = [userPrompt('earlier'), bashAborted('u0', 'old')]
    const { ask, record } = seat(on, { messages: () => history, abort: completes($) })
    await start($)
    history.push(userPrompt('first'))
    await $.turn.start({ text: 'first', turnId: 't1' })
    history.push(bashUse('u1'), bashAborted('u1', 'b1'), userPrompt('second'))
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: true, reason: 'aborted' })
    await $.turn.start({ text: 'second', turnId: 't2' })
    history.push(bashUse('u2'), bashAborted('u2', 'b2'), userPrompt('third'))
    await $.turn.complete({ turnId: 't2', answer: '', durationMs: 5, isAborted: true, reason: 'aborted' })
    await $.turn.start({ text: 'third', turnId: 't3' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted' })
    expect(record.aborts).toEqual(['t3'])
    expect(record.stops).toEqual(['b1', 'b2'])
  })
  test('a timed-out interrupt clears the mark before a later interrupt', async ($, on) => {
    const clock = mock.clock(on)
    const history: SessionMessage[] = []
    const { ask, record } = seat(on, {
      messages: () => history,
      abort: (turnId) => {
        if (turnId === 't1') return void clock.advance(2000)
        return completes($)(turnId)
      },
    })
    await start($)
    history.push(userPrompt('first'))
    await $.turn.start({ text: 'first', turnId: 't1' })
    expect(await ask({ op: 'interrupt' })).toEqual({
      id: 'r1', op: 'interrupt', outcome: 'interrupted',
      reason: 'the aborted turn did not complete within 2 s, so tools it moved to the background may still run',
    })
    history.push(bashUse('u1'), bashAborted('u1', 'b1'))
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 2500, isAborted: true, reason: 'aborted' })
    history.push(userPrompt('second'))
    await $.turn.start({ text: 'second', turnId: 't2' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r2', op: 'interrupt', outcome: 'interrupted' })
    expect(record.aborts).toEqual(['t1', 't2'])
    expect(record.stops).toEqual([])
  })
  test('stops a tool when the abort appends its result and a queued prompt lands after it', async ($, on) => {
    mock.clock(on)
    const history: SessionMessage[] = [userPrompt('earlier'), bashAborted('u0', 'old')]
    const { ask, record } = seat(on, {
      messages: () => history,
      abort: (turnId) => {
        history.push(bashUse('u1'), bashAborted('u1', 'b1'), userPrompt('queued mid-turn input'))
        return completes($)(turnId)
      },
    })
    await start($)
    history.push(userPrompt('run loop'))
    await $.turn.start({ text: 'run loop', turnId: 't1' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted' })
    expect(record.aborts).toEqual(['t1'])
    expect(record.stops).toEqual(['b1'])
  })
  test('a rejected session.messages at turn.start falls back to the last prompt on interrupt', async ($, on) => {
    mock.clock(on)
    let reads = 0
    const { ask, record } = seat(on, {
      messages: () => {
        if (++reads === 1) throw new Error('session messages unavailable')
        return ABORTED
      },
      abort: completes($),
    })
    await start($)
    await $.turn.start({ text: 'run the two scripts', turnId: 't1' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted' })
    expect(record.aborts).toEqual(['t1'])
    expect(record.stops).toEqual(['b1', 'b2'])
  })
})

describe('prompt', () => {
  test('submits the owner\'s words as the person\'s own', async ($, on) => {
    const { ask, record } = seat(on)
    await start($)
    expect(await ask({ op: 'prompt', text: 'hello there' })).toEqual({ id: 'r1', op: 'prompt', outcome: 'submitted' })
    expect(record.prompts).toEqual([{ text: 'hello there', origin: { kind: 'plugin', name: 'cotal', asUser: true } }])
  })
  test('a prompt Claude drops: refused, with Claude\'s reason', async ($, on) => {
    const { ask } = seat(on, { drop: 'a Stop stands' })
    await start($)
    expect(await ask({ op: 'prompt', text: 'hello' })).toEqual({ id: 'r1', op: 'prompt', outcome: 'refused', reason: 'a Stop stands' })
  })
})

describe('usage', () => {
  test('reports the window, the tokens over it and the cost', async ($, on) => {
    const { ask } = seat(on, { usage: { context: { tokens: 1234, window: 200000 }, cost: { usd: 0.5 } } })
    await start($)
    expect(await ask({ op: 'usage' })).toEqual({ id: 'r1', op: 'usage', window: 200000, tokens: 1234, usd: 0.5 })
  })
  test('leaves out what Claude has not reported', async ($, on) => {
    const { ask } = seat(on, { usage: { context: { window: 200000 } } })
    await start($)
    expect(await ask({ op: 'usage' })).toEqual({ id: 'r1', op: 'usage', window: 200000 })
  })
})

describe('model', () => {
  test('a switch applies from the next main turn, at every step, and the running turn keeps its model', async ($, on) => {
    const { ask, record } = seat(on)
    await start($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(await ask({ op: 'model', model: 'haiku', effort: 'low' })).toEqual({ id: 'r1', op: 'model', model: 'haiku', effort: 'low' })
    await step($, 't1')
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
    await $.turn.start({ text: 'again', turnId: 't2' })
    await step($, 't2')
    await step($, 't2')
    expect(record.steps).toEqual([['t1', 'main', 'claude-opus-5-5', 'high'], ['t2', 'main', 'haiku', 'low'], ['t2', 'main', 'haiku', 'low']])
  })
  test('a subagent\'s steps keep the model Claude picks', async ($, on) => {
    const { ask, record } = seat(on)
    await start($)
    await ask({ op: 'model', model: 'haiku' })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.start({ text: 'sub', turnId: 't2', agentId: 'a1' })
    await step($, 't2', 'a1')
    await step($, 't1')
    expect(record.steps).toEqual([['t2', 'a1', 'claude-opus-5-5', 'high'], ['t1', 'main', 'haiku', 'high']])
  })
  test('an effort alone keeps the model in force, and a model alone drops a switched effort', async ($, on) => {
    const { ask } = seat(on, { model: 'sonnet' })
    await start($)
    expect(await ask({ op: 'model', effort: 'low' })).toEqual({ id: 'r1', op: 'model', model: 'sonnet', effort: 'low' })
    expect(await ask({ op: 'model', model: 'haiku', effort: 'max' })).toEqual({ id: 'r2', op: 'model', model: 'haiku', effort: 'max' })
    expect(await ask({ op: 'model', effort: 'medium' })).toEqual({ id: 'r3', op: 'model', model: 'haiku', effort: 'medium' })
    expect(await ask({ op: 'model', model: 'opus' })).toEqual({ id: 'r4', op: 'model', model: 'opus' })
  })
  test('a /model run at the seat ends the switch from the next turn', async ($, on) => {
    const { ask, record } = seat(on)
    await start($)
    await ask({ op: 'model', model: 'haiku', effort: 'low' })
    await $.command.run({ command: 'model', args: 'sonnet', origin: { kind: 'composer' }, presentation: PRESENTATION })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await step($, 't1')
    expect(record.steps).toEqual([['t1', 'main', 'claude-opus-5-5', 'high']])
  })
  test('an /effort run at the seat ends the switched effort and keeps the switched model', async ($, on) => {
    const { ask, record } = seat(on)
    await start($)
    await ask({ op: 'model', model: 'haiku', effort: 'low' })
    await $.command.run({ command: 'effort', args: 'max', origin: { kind: 'composer' }, presentation: PRESENTATION })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await step($, 't1')
    expect(record.steps).toEqual([['t1', 'main', 'haiku', 'high']])
  })
})

describe('reader and helper', () => {
  test('an interactive session starts its reader before any request', async ($, on) => {
    const clock = mock.clock(on)
    const { record } = seat(on)
    await start($)
    await clock.settle()
    expect(record.reader).toHaveLength(1)
  })
  test('a -p run starts no reader', async ($, on) => {
    const clock = mock.clock(on)
    const { record } = seat(on)
    await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
    await clock.settle()
    expect(record.reader).toHaveLength(0)
  })
  test('a reader that fails leaves nothing unhandled', async ($, on) => {
    const clock = mock.clock(on)
    const { record } = seat(on, { readerFails: true })
    await start($)
    await clock.settle()
    expect(record.reader).toHaveLength(1)
  })
  for (const [kind, env] of [['a managed seat', { COTAL_NAME: 'seat-a' }], ['a personal session', {}]] as const) {
    test(`serves ${kind}`, async ($, on) => {
      const { ask, record } = seat(on, { env })
      await start($)
      await ask({ op: 'list' })
      const script = record.reader[0]?.[1] ?? ''
      expect(script.endsWith('/dist/command-reader.cjs')).toBe(true)
      expect(record.reader).toEqual([['node', script, 'read', '--claude', '2.1.330']])
      expect(record.helper).toEqual([['node', script, 'answer', ROUTE]])
    })
  }
})

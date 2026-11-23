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
  messages?: SessionMessage[]
  stop?: (taskId: string) => Stub
  readerFails?: boolean
}

// Stands in for Claude Code under the mod and for the seat server beyond its reader and helper.
function seat(on: On, options: Options = {}) {
  const record = { reader: [] as string[][], helper: [] as string[][], runs: [] as string[][], aborts: [] as string[], stops: [] as string[] }
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
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.abort', ($, e) => {
    record.aborts.push(e.turnId)
    return options.abort?.(e.turnId) ?? { value: undefined }
  })
  on('session.messages', () => ({ value: options.messages ?? [] }))
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
    const { ask, record } = seat(on, { list: [{ name: 'model', description: 'mine', source: 'user' }, builtin('model')] })
    await start($)
    expect(await ask({ op: 'run', command: 'model', args: 'haiku' })).toEqual({
      id: 'r1', op: 'run', outcome: 'refused', reason: '/model changes Claude Code settings at the seat',
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
    const { ask, record } = seat(on)
    await start($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.start({ text: 'sub', turnId: 't2', agentId: 'a1' })
    await $.turn.complete({ turnId: 't2', agentId: 'a1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted' })
    expect(record.aborts).toEqual(['t1'])
    expect(record.stops).toHaveLength(0)
  })
  test('stops each tool the abort moved to the background', async ($, on) => {
    const { ask, record } = seat(on, { messages: ABORTED })
    await start($)
    await $.turn.start({ text: 'run the two scripts', turnId: 't1' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted' })
    expect(record.stops).toEqual(['b1', 'b2'])
  })
  test('a refused TaskStop: interrupted, a tool is still running', async ($, on) => {
    const { ask, record } = seat(on, { messages: ABORTED, stop: (task) => (task === 'b1' ? { deny: 'not now' } : undefined) })
    await start($)
    await $.turn.start({ text: 'run the two scripts', turnId: 't1' })
    expect(await ask({ op: 'interrupt' })).toEqual({ id: 'r1', op: 'interrupt', outcome: 'interrupted', reason: 'a tool is still running' })
    expect(record.stops).toEqual(['b1', 'b2'])
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

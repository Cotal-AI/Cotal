const WAKE = /^Cotal: a new message for connection_id ([A-Za-z0-9_-]{1,128})\. Read it with cotal_inbox\.$/;
const pending = new Set();
const expanded = new Set();
const wakeRows = new Set();
let submitting = false;
let paused = false;
let active = false;
let reader;

async function submit($, inTurn = false) {
  if (submitting || paused || active !== inTurn) return;
  submitting = true;
  try {
    for (const text of pending) {
      if (paused || active !== inTurn) break;
      pending.delete(text);
      try {
        // Appending at a main-loop boundary keeps the wake in this turn. Submitting a prompt
        // instead would queue a second turn, after all the work we need the message to reach.
        const result = inTurn
          ? await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
          : await $.prompt.submit({ text });
        if (result?.drop || (inTurn && !result?.uuid)) {
          paused = true;
          pending.add(text);
          break;
        }
      } catch {
        paused = true;
        pending.add(text);
        $.ui.log('Cotal incoming delivery is paused. Your next message can resume it.');
        break;
      }
    }
  } finally {
    submitting = false;
  }
}

async function listen($) {
  try {
    // Managed sessions already own a native channel and do not carry this CLI record.
    if (await $.env.get('COTAL_NAME') || await $.env.get('COTAL_LINK') || await $.env.get('COTAL_AGENT_FILE')) return;
    const root = $.plugin.root;
    const record = JSON.parse(await $.fs.read(root + '/dist/cli.json'));
    if (!Array.isArray(record.argv) || typeof record.argv[0] !== 'string') {
      throw new Error('missing Cotal CLI record');
    }
    reader = $.process.spawn({ argv: [record.argv[0], root + '/dist/monitor.cjs', '--native'] });
    let buffer = '';
    for await (const piece of reader) {
      if (piece.stream !== 'stdout') continue;
      buffer += piece.text;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (WAKE.test(line)) {
          pending.add(line);
          void submit($);
        }
      }
      if (buffer.length > 256) throw new Error('invalid Cotal wake feed');
    }
  } catch {
    await reader?.return();
    $.ui.log('Cotal incoming auto-wake is unavailable. Run cotal setup, then reopen Claude.');
  }
}

export function register(on) {
  on('session.append', async ($, e, next) => {
    const own = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name && !e.origin.asUser;
    const text = e.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const result = await next(e);
    if (own && text.split(/\r?\n/).some(line => WAKE.test(line))) {
      wakeRows.add(e.uuid);
      $.ui.invalidate('ui.render');
    }
    return result;
  });
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const origin = e.props.origin;
    const own = origin?.kind === 'plugin' && origin.name === $.plugin.name && !origin.asUser;
    // Desktop renders plugin submissions as SDK rows. Trust the recorded event id, never a
    // text-only match that could hide something the person or another plugin wrote.
    if (!own && !wakeRows.has(e.requestId)) return next(e);
    // Some app versions include their attribution wrapper in the rendered text. Match only our
    // fixed wake line, and keep the full original available through the disclosure below.
    if (!e.props.text.split(/\r?\n/).some(line => WAKE.test(line))) return next(e);
    const { Box, Button } = $.ui.resolve(e);
    const open = expanded.has(e.requestId);
    return Box({
      flexDirection: 'column',
      children: [
        Button({
          key: 'cotal-wake-details',
          label: open ? 'Cotal · new message  ▾' : 'Cotal · new message  ›',
          plain: true,
          onPress: () => {
            if (open) expanded.delete(e.requestId);
            else expanded.add(e.requestId);
            $.ui.invalidate('ui.render');
          },
        }),
        ...(open ? [await next(e)] : []),
      ],
    });
  });
  on('session.start', async ($, e, next) => {
    const started = await next(e);
    void listen($);
    return started;
  });
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e);
    // The engine stamps the person's input. Peer deliveries, timers and another plugin's prompt
    // must not restart work after Stop. Desktop and SDK hosts submit their own input as sdk.
    if (!result?.drop && ['composer', 'bridge', 'sdk'].includes(e.origin?.kind)) paused = false;
    return result;
  });
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) active = true;
    return next(e);
  });
  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined && !next.signal.aborted) await submit($, true);
    return result;
  });
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      active = true;
      if (!next.signal.aborted) await submit($, true);
    }
    return yield* next(e);
  });
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e);
    if (e.agentId !== undefined) return completed;
    active = false;
    // Stop pauses both wake paths; only the host's next person-origin prompt resumes them.
    if (e.isAborted) paused = true;
    if (!paused && pending.size > 0) void submit($);
    return completed;
  });
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') await reader?.return();
    return next(e);
  });
}

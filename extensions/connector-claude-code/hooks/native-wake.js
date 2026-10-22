const WAKE = /^Cotal: a new message for connection_id ([A-Za-z0-9_-]{1,128})\. Read it with cotal_inbox\.$/;
const PREVIEW = /^Cotal preview for connection_id ([A-Za-z0-9_-]{1,128}): (\{.*\})$/;
const PERSONA = /^Cotal persona "[A-Za-z0-9_-]{1,64}" for connection_id ([A-Za-z0-9_-]{1,128})\n/;
const COTAL_TOOL = /^mcp__(cotal|plugin_cotal_cotal)__(cotal_connect|cotal_disconnect)$/;
const pending = new Set();
const expanded = new Set();
const wakeRows = new Set();
const previews = new Map();
let submitting = false;
let paused = false;
let active = false;
let reader;
let readerSession;
let nativeBinding;
// The adopted persona's instructions by connection_id, repeated in this conversation's context.
const personas = new Map();

async function relayNative($, event) {
  if (await $.env.get('COTAL_NAME') || await $.env.get('COTAL_LINK') || await $.env.get('COTAL_AGENT_FILE')) return;
  const root = $.plugin.root;
  const record = JSON.parse(await $.fs.read(root + '/dist/cli.json'));
  const fields = ['hook_event_name', 'session_id', 'transcript_path', 'cwd', 'source', 'notification_type', 'error', 'agent_id'];
  const frame = {};
  for (const key of fields) if (typeof event[key] === 'string') frame[key] = event[key];
  const result = await $.process.run([record.argv[0], root + '/dist/monitor.cjs', '--native', '--native-event', JSON.stringify(frame)]);
  if (result.exitCode !== 0) throw new Error('Cotal native lifecycle binding was not confirmed');
}

// Move the connect reply's persona item into this plugin's own context, now as the call's context
// and on later turns as a prompt block, so the persona reads as plugin context, not tool output.
function adoptPersona($, result) {
  if (!Array.isArray(result?.result)) return result;
  const item = result.result.find(part => part?.type === 'text' && PERSONA.test(part.text));
  if (!item) return result;
  const kept = result.result.filter(part => part !== item);
  personas.clear();
  personas.set(PERSONA.exec(item.text)[1], item.text);
  $.ui.invalidate('prompt.context');
  return { ...result, result: kept, text: kept.map(part => part.text ?? '').join('\n'), context: [item.text] };
}

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
        if (inTurn) {
          wakeRows.add(result.uuid);
          $.ui.invalidate('ui.render');
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
    const session = await $.session.id();
    if (reader && readerSession === session) return;
    await reader?.return();
    readerSession = session;
    reader = $.process.spawn({ argv: [record.argv[0], root + '/dist/monitor.cjs', '--native', '--session', session] });
    let buffer = '';
    for await (const piece of reader) {
      if (piece.stream !== 'stdout') continue;
      buffer += piece.text;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const preview = PREVIEW.exec(line);
        if (preview) {
          try {
            const value = JSON.parse(preview[2]);
            if (Number.isInteger(value.unread) && value.unread >= 0 && Array.isArray(value.rows) &&
                value.rows.length <= 8 && value.rows.every(row => typeof row === 'string' && Array.from(row).length <= 240)) {
              previews.set(preview[1], value);
            }
          } catch {}
        } else if (WAKE.test(line)) {
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
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
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
    const id = e.props.text.split(/\r?\n/).map(line => WAKE.exec(line)?.[1]).find(Boolean);
    const preview = id ? previews.get(id) : undefined;
    const { Box, Button } = $.ui.resolve(e);
    const open = expanded.has(e.requestId);
    return Box({
      flexDirection: 'column',
      children: [
        Button({
          key: 'cotal-wake-details',
          label: preview
            ? `Cotal · ${preview.unread} unread  ${open ? '▾' : '›'}`
            : open ? 'Cotal · new message  ▾' : 'Cotal · new message  ›',
          plain: true,
          onPress: () => {
            if (open) expanded.delete(e.requestId);
            else expanded.add(e.requestId);
            $.ui.invalidate('ui.render');
          },
        }),
        ...(open ? preview?.rows?.length
          ? preview.rows.map((row, index) => Box({ key: `cotal-preview-${index}`, children: [row] }))
          : [await next(e)] : []),
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
  on('prompt.context', async ($, e, next) => {
    const context = await next(e);
    if (e.agentId !== undefined || !personas.size) return context;
    return { ...context, blocks: [...context.blocks, ...[...personas.values()].map(text => ({ name: 'cotal-persona', text }))] };
  });
  on('tool.call', async ($, e, next) => {
    let input = e;
    const tool = e.agentId === undefined ? COTAL_TOOL.exec(e.tool)?.[2] : undefined;
    if (tool === 'cotal_connect') {
      const session = await $.session.id();
      try {
        const root = $.plugin.root;
        const record = JSON.parse(await $.fs.read(root + '/dist/cli.json'));
        const binding = await $.process.run([record.argv[0], root + '/dist/monitor.cjs', '--native', '--native-binding', session]);
        if (binding.exitCode !== 0) return { deny: 'Cotal cannot read this conversation’s native command hooks. Check whether your organization permits the Cotal command hooks.' };
        nativeBinding = JSON.parse(binding.stdout);
        if (nativeBinding.session_id !== session) throw new Error('native session mismatch');
        await relayNative($, nativeBinding);
        void listen($);
      } catch { return { deny: 'Cotal could not bind this native conversation to its local server. No identity was requested.' }; }
      let model;
      try { model = await $.session.model(); } catch {}
      // Only the host reports its model: a value the model wrote into the call is dropped.
      const { host_model: _written, ...call } = e;
      input = { ...call, context: session, ...(typeof model === 'string' && model ? { host_model: model } : {}) };
    }
    let result = await next(input);
    if (tool === 'cotal_connect') result = adoptPersona($, result);
    if (tool === 'cotal_disconnect' && result?.text === `Disconnected ${e.connection_id}.` && personas.delete(e.connection_id))
      $.ui.invalidate('prompt.context');
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
    await reader?.return();
    reader = undefined;
    readerSession = undefined;
    nativeBinding = undefined;
    personas.clear();
    pending.clear();
    previews.clear();
    return next(e);
  });
}

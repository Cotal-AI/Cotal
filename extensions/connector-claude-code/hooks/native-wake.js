const WAKE = /^Cotal: a new message for connection_id ([A-Za-z0-9_-]{1,128})\. Read it with cotal_inbox\.$/;
const PREVIEW = /^Cotal preview for connection_id ([A-Za-z0-9_-]{1,128}): (\{.*\})$/;
const INLINE = /^Cotal: inline messages for connection_id ([A-Za-z0-9_-]{1,128})\.$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const offers = new Map();
const retries = new Map();
const admissions = new Map();
const inlineRows = new Map();
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

function inlineFrame(frame, session) {
  const item = frame?.inline;
  return frame && typeof frame.id === 'string' && ID.test(frame.id) && typeof frame.route === 'string' &&
    item?.v === 1 && item.session === session && typeof item.receipt === 'string' && ID.test(item.receipt) &&
    typeof item.text === 'string' && item.text.startsWith(`Cotal: inline messages for connection_id ${frame.id}.\n`) &&
    Number.isInteger(item.count) && item.count > 0 && item.count <= 8 &&
    Number.isInteger(item.remaining) && item.remaining >= 0 && JSON.stringify(frame).length <= 4096;
}

async function receipt($, frame, action, uuid) {
  const root = $.plugin.root;
  const record = JSON.parse(await $.fs.read(root + '/dist/cli.json'));
  const session = await $.session.id();
  if (frame.inline.session !== session) throw new Error('Cotal native session changed');
  const result = await $.process.run(
    [record.argv[0], root + '/dist/monitor.cjs', '--native', '--session', session, '--native-delivery'],
    { stdin: JSON.stringify({ route: frame.route, session, id: frame.id, receipt: frame.inline.receipt, action, ...(uuid ? { uuid } : {}) }), timeoutMs: 3000 },
  );
  if (result.exitCode !== 0) throw new Error('Cotal native receipt was not confirmed');
  return JSON.parse(result.stdout);
}

async function deferInline($, frame) {
  retries.set(frame.id, frame);
  try { await receipt($, frame, 'reject'); } catch {}
}

async function resumeInline($) {
  let reopen = false;
  for (const [key, frame] of retries) {
    try { if (!(await receipt($, frame, 'retry')).ok) reopen = true; }
    catch { reopen = true; }
    retries.delete(key);
  }
  if (reopen) {
    await reader?.return();
    reader = undefined;
    readerSession = undefined;
    void listen($);
  }
}

async function submitInline($, frame, inTurn) {
  const claim = await receipt($, frame, 'claim');
  if (!claim.ok) {
    await receipt($, frame, 'retry');
    return;
  }
  if (!inlineFrame(claim.frame, await $.session.id()) || JSON.stringify(claim.frame) !== JSON.stringify(frame))
    throw new Error('Cotal inline offer changed');
  const text = claim.frame.inline.text;
  const admission = { frame: claim.frame, uuid: undefined, resolve: undefined, observed: undefined };
  admission.observed = new Promise(resolve => { admission.resolve = resolve; });
  admissions.set(text, admission);
  try {
    if (paused) { await deferInline($, frame); return; }
    if (active !== inTurn) {
      await receipt($, frame, 'defer');
      offers.set(frame.inline.receipt, frame);
      return;
    }
    let result;
    try {
      result = inTurn
        ? await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        : await $.prompt.submit({ text });
    } catch (error) { paused = true; throw error; }
    if (result?.drop || result?.deny) {
      paused = true;
      throw new Error('Cotal native admission was refused');
    }
    const uuid = inTurn ? result?.uuid : admission.uuid || await Promise.race([
      admission.observed, $.clock.sleep(2000).then(() => undefined),
    ]);
    const stored = result?.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (!uuid || inTurn && stored !== text) {
      paused = true;
      throw new Error('Cotal native admission was not confirmed');
    }
    wakeRows.add(uuid);
    inlineRows.set(uuid, claim.frame.inline);
    $.ui.invalidate('ui.render');
    const committed = await receipt($, claim.frame, 'commit', uuid);
    if (!committed.ok) await receipt($, claim.frame, 'retry');
  } finally {
    admissions.delete(text);
  }
}

async function submit($, inTurn = false) {
  if (submitting || paused || active !== inTurn) return;
  submitting = true;
  try {
    for (const [key, frame] of [...offers]) {
      if (paused || active !== inTurn) break;
      offers.delete(key);
      try { await submitInline($, frame, inTurn); }
      catch {
        await deferInline($, frame);
        $.ui.log(paused
          ? 'Cotal incoming delivery is paused. Your next message can resume it.'
          : 'Cotal could not confirm incoming delivery. The message remains in the inbox.');
        break;
      }
    }
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
    if (!paused && !active && offers.size) void submit($);
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
        } else if (line.startsWith('Cotal inline delivery: ')) {
          try {
            if (line.length > 4120) continue;
            const frame = JSON.parse(line.slice('Cotal inline delivery: '.length));
            if (!inlineFrame(frame, session)) continue;
            if (paused) await deferInline($, frame);
            else {
              offers.set(frame.inline.receipt, frame);
              void submit($);
            }
          } catch {}
        } else if (WAKE.test(line)) {
          pending.add(line);
          void submit($);
        }
      }
      if (buffer.length > 4120) throw new Error('invalid Cotal wake feed');
    }
  } catch {
    await reader?.return();
    $.ui.log('Cotal incoming auto-wake is unavailable. Run cotal setup, then reopen Claude.');
  }
}

export function register(on) {
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const own = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name && !e.origin.asUser;
    const result = await next(e);
    const text = result?.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '';
    if (own && !result?.deny && result?.uuid && text.split(/\r?\n/).some(line => WAKE.test(line) || INLINE.test(line))) {
      // Claude may wrap a plugin prompt in its own attribution text before storing it. Require
      // our complete offered bytes on whole lines and our plugin origin, never a marker alone.
      const matches = [...admissions].filter(([body]) => text === body || text.includes(`\n${body}\n`));
      if (matches.length === 1) {
        const admission = matches[0][1];
        admission.uuid = result.uuid;
        admission.resolve(result.uuid);
        inlineRows.set(result.uuid, admission.frame.inline);
      }
      wakeRows.add(result.uuid);
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
    if (!e.props.text.split(/\r?\n/).some(line => WAKE.test(line) || INLINE.test(line))) return next(e);
    const id = e.props.text.split(/\r?\n/).map(line => (WAKE.exec(line) || INLINE.exec(line))?.[1]).find(Boolean);
    const delivered = inlineRows.get(e.requestId);
    const preview = delivered ? undefined : id ? previews.get(id) : undefined;
    const { Box, Button } = $.ui.resolve(e);
    const open = expanded.has(e.requestId);
    return Box({
      flexDirection: 'column',
      children: [
        Button({
          key: 'cotal-wake-details',
          label: delivered
            ? `Cotal · ${delivered.count} message${delivered.count === 1 ? '' : 's'}${delivered.remaining ? ` · ${delivered.remaining} pending` : ''}  ${open ? '▾' : '›'}`
            : preview
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
    if (!result?.drop && ['composer', 'bridge', 'sdk'].includes(e.origin?.kind)) {
      paused = false;
      await resumeInline($);
    }
    return result;
  });
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) active = true;
    return next(e);
  });
  on('tool.call', async ($, e, next) => {
    let input = e;
    if (e.agentId === undefined && /^mcp__(cotal|plugin_cotal_cotal)__cotal_connect$/.test(e.tool)) {
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
      input = { ...e, context: session };
    }
    const result = await next(input);
    if (e.agentId === undefined && !next.signal.aborted) await submit($, true);
    return result;
  });
  on('turn.step', async function* ($, e, next) {
    // This request already owns its message snapshot. Appending here stores a row without
    // putting it in that request, and a final response would leave no next request to read it.
    // Keep late arrivals queued for a tool boundary or an attributed prompt after this turn.
    if (e.agentId === undefined) active = true;
    return yield* next(e);
  });
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e);
    if (e.agentId !== undefined) return completed;
    active = false;
    // Stop pauses both wake paths; only the host's next person-origin prompt resumes them.
    if (e.isAborted) {
      paused = true;
      for (const frame of offers.values()) await deferInline($, frame);
      offers.clear();
    }
    if (!paused && (pending.size > 0 || offers.size > 0)) void submit($);
    return completed;
  });
  on('session.end', async ($, e, next) => {
    await reader?.return();
    reader = undefined;
    readerSession = undefined;
    nativeBinding = undefined;
    pending.clear();
    offers.clear();
    retries.clear();
    admissions.clear();
    inlineRows.clear();
    wakeRows.clear();
    expanded.clear();
    previews.clear();
    return next(e);
  });
}

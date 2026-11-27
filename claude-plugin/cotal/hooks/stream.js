// Relays the reply text Claude Code shows while a reply streams to the seat, which journals it for
// the event plane (src/claude-stream.ts). A flush names its prompt and a display id the transcript
// never records, so each prompt's main-thread messages are numbered in the order they stream, as the
// seat numbers that prompt's saved text blocks.

// The least time between two relays: each one is a helper process.
const INTERVAL_MS = 250;
// A relay over the seat's line limit would be refused; the saved text carries what it held.
const MAX_RELAY_BYTES = 512 * 1024;

let target;
let prompt;
let count = 0;
const keys = new Map();
let pending = [];
let sending = false;
let timer;
let last = -Infinity;

// The seat asks once per reader it accepts; its latest ask names where the text goes.
export function streamTo(request) {
  target = { route: request.route, id: request.id };
}

export function keyOf(e) {
  if (e.prompt_id !== prompt) {
    prompt = e.prompt_id;
    count = 0;
    keys.clear();
  }
  let key = keys.get(e.message_id);
  if (key === undefined) {
    key = `stream:${prompt}:${++count}`;
    keys.set(e.message_id, key);
  }
  return key;
}

function collect($, e) {
  // A subagent's reply is not in the main transcript, and a flush before the first prompt names none.
  if (target === undefined || e.agent_id !== undefined || typeof e.prompt_id !== 'string' || typeof e.message_id !== 'string') return;
  const key = keyOf(e);
  if (typeof e.delta !== 'string' || e.delta === '') return;
  const tail = pending.at(-1);
  if (tail?.key === key) tail.text += e.delta;
  else pending.push({ key, text: e.delta });
  schedule($);
}

function schedule($) {
  if (sending || timer !== undefined || pending.length === 0) return;
  const wait = last + INTERVAL_MS - Date.now();
  if (wait > 0) {
    timer = $.clock.after(wait, () => {
      timer = undefined;
      void send($);
    });
    return;
  }
  void send($);
}

async function send($) {
  const deltas = pending;
  pending = [];
  if (target === undefined || deltas.length === 0) return;
  const stdin = JSON.stringify({ id: target.id, op: 'deltas', deltas });
  if (stdin.length > MAX_RELAY_BYTES) return;
  sending = true;
  last = Date.now();
  try {
    await $.process.run(['node', $.plugin.root + '/dist/command-reader.cjs', 'answer', target.route], { stdin });
  } catch {
    // The seat journals nothing of this relay, and the saved message still carries its text.
  } finally {
    sending = false;
    schedule($);
  }
}

export function register(on) {
  on('classic.MessageDisplay', async ($, e, next) => {
    const shown = await next(e);
    collect($, e);
    return shown;
  });
}

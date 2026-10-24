// Deliberate fault injection at a live KV iterator boundary. The real CLI, broker, credentials,
// snapshot handling and presenceView/getRoster stay in use; no presence state is fabricated.
import { writeFileSync } from 'node:fs';
import { CotalEndpoint } from '@cotal-ai/core';

const fault = process.env.SMOKE_WHO_WATCH_FAULT;
if (!['unpopulated', 'stale', 'error'].includes(fault)) throw new Error('unknown who watch fault');
const states = new WeakMap();
const proto = CotalEndpoint.prototype;
const start = proto.start;
const stop = proto.stop;
const bind = proto.startPresenceWatch;
const waitSnapshot = proto.waitForPresenceSnapshot;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

proto.start = function (...args) {
  if (this.card.name === 'who') {
    let release, errorSeen;
    const state = { fault, watches: 0, events: [], gate: new Promise(resolve => { release = resolve; }),
      error: new Promise(resolve => { errorSeen = resolve; }), release };
    this.once('error', errorSeen);
    states.set(this, state);
  }
  return start.apply(this, args);
};
proto.startPresenceWatch = async function (...args) {
  const state = states.get(this);
  if (!state) return bind.apply(this, args);
  const watch = this.kv.watch.bind(this.kv);
  const first = state.watches++ === 0;
  this.kv.watch = async (...watchArgs) => {
    const iter = await watch(...watchArgs);
    const iterate = iter[Symbol.asyncIterator].bind(iter);
    iter[Symbol.asyncIterator] = async function* () {
      if (fault === 'unpopulated' || !first) {
        state.events.push('held before snapshot');
        await state.gate;
      }
      for await (const entry of { [Symbol.asyncIterator]: iterate }) {
        yield entry;
        if (entry.isUpdate) {
          state.events.push('live snapshot delivered');
          if (fault === 'error') throw new Error('fixture: live presence iterator failed');
          if (fault === 'stale') await state.gate;
        }
      }
    };
    return iter;
  };
  try { return await bind.apply(this, args); }
  finally { this.kv.watch = watch; }
};
proto.waitForPresenceSnapshot = async function (...args) {
  const result = await waitSnapshot.apply(this, args);
  const state = states.get(this);
  if (!state) return result;
  if (fault === 'error') await state.error;
  if (fault === 'stale') {
    const deadline = Date.now() + 12_000;
    while (this.presenceView().state !== 'stale' && Date.now() < deadline) await wait(25);
    if (this.presenceView().state !== 'stale') throw new Error('fixture: live watch did not become stale');
  }
  state.events.push(`observed ${this.presenceView().state}`);
  writeFileSync(process.env.SMOKE_WHO_WATCH_TRACE, JSON.stringify({ fault, events: state.events }));
  return result;
};
proto.stop = function (...args) {
  states.get(this)?.release();
  return stop.apply(this, args);
};

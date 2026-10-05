// The four booth demos. Each is `async (stage, run, ctx)`: it builds its panels on `stage`,
// paces itself with `run.sleep` / `run.press` (both reject when the run is cancelled), and
// returns when its story is told. Nothing here talks to a real mesh; it is a scripted picture.
'use strict';
(() => {
  const swallow = (p) => p.catch(() => {});

  // Wait for a toolbar choice. In auto mode pick `autoId` after `autoAfter` ms unless a visitor takes over.
  function choice(S, run, state, autoId, autoAfter) {
    const ext = run.external();
    state.resolve = ext.resolve;
    let t = null;
    const hook = () => { clearTimeout(t); S.toolbarClearAutofill(); };
    if (run.auto) {
      S.toolbarAutofill(autoId, autoAfter);
      t = setTimeout(() => { if (!run.cancelled && run.auto && state.resolve) { const r = state.resolve; state.resolve = null; r(autoId); } }, autoAfter);
      run.manualHooks.add(hook);
    }
    return ext.promise.finally(() => { clearTimeout(t); run.manualHooks.delete(hook); S.toolbarClearAutofill(); });
  }
  const chooser = (state) => (id) => { if (state.resolve) { const r = state.resolve; state.resolve = null; r(id); } };

  // ------------------------------------------------------------------ 1. a team ships a feature
  async function team(S, run) {
    const M = S.mesh;
    const agents = [
      { id: 'sven', role: 'planner', vendor: 'claude', persona: 'sven', x: 0.2, y: 0.3 },
      { id: 'david', role: 'builder', vendor: 'opencode', persona: 'david', x: 0.2, y: 0.76 },
      { id: 'ray', role: 'reviewer', vendor: 'codex', persona: 'ray', x: 0.8, y: 0.3 },
      { id: 'mira', role: 'reviewer', vendor: 'hermes', persona: 'mira', x: 0.8, y: 0.76 },
    ];
    const garry = { id: 'garry', role: 'security', vendor: 'pi', persona: 'garry', x: 0.5, y: 0.14 };
    M.add({ id: '#general', kind: 'channel', label: '#general', x: 0.5, y: 0.4 });
    M.add({ id: '#review', kind: 'channel', label: '#review', x: 0.5, y: 0.74 });
    for (const a of agents) { M.add({ id: a.id, label: a.id, vendor: a.vendor, x: a.x, y: a.y }); M.link(a.id, '#general'); M.link(a.id, '#review'); }
    S.roster(agents);
    S.feed({ sys: 'space <b>demo</b> · 4 agents online · 2 channels' });

    const members = (ch) => M.edges.filter((e) => e.b === ch).map((e) => e.a);
    const mcast = async (from, ch, text) => {
      S.feed({ from, to: ch, kind: 'chat', text });
      await M.pulse(from, ch, 'chat');
      await Promise.all(members(ch).filter((m) => m !== from).map((m) => M.pulse(ch, m, 'chat', { dur: 520 })));
    };
    const dm = async (from, to, text) => { S.feed({ from, to, kind: 'dm', text }); M.dashed(from, to, 'dm', 1400); await M.pulse(from, to, 'dm'); };

    S.caption('Five agents. Four vendors. One shared space.', 'They see each other and talk directly. No orchestrator in the middle.');
    await run.press(S, [{ id: 'go', label: 'Ship a feature', key: 'Space', primary: true }], { autoAfter: 2600 });

    // 1. multicast
    S.status('sven', 'working'); S.think('sven', 'planning');
    await run.sleep(1100);
    const plan = 'Plan: david builds the API, reviewers stand by.';
    swallow(S.say('sven', plan));
    await run.sleep(500);
    S.caption('One post to #general. Every subscriber receives it.', 'Multicast is how a group stays in sync.', { cls: 'chat', text: 'multicast' });
    await mcast('sven', '#general', plan);
    await run.sleep(1400);

    // 2. unicast
    S.caption('A direct message to david. Delivered durably.', 'Unicast: if he is mid-turn it waits in his inbox. Nothing is lost.', { cls: 'dm', text: 'unicast' });
    await dm('sven', 'david', 'Spec is in wt-1. Ship it as PR #42.');
    S.status('sven', 'idle'); S.status('david', 'working'); S.think('david', 'building POST /users');
    await run.sleep(2200);

    // 3. the PR, then anycast to the reviewer role
    swallow(S.say('david', 'PR #42 is up: POST /users.'));
    await mcast('david', '#review', 'PR #42 is up: POST /users');
    S.status('david', 'waiting');
    await run.sleep(400);
    S.caption('"Any reviewer: grade PR #42." One free reviewer claims it.', 'Anycast addresses a role, not a name. Delegation without a scheduler.', { cls: 'anycast', text: 'anycast' });
    S.status('sven', 'working');
    S.feed({ from: 'sven', to: '@reviewer', kind: 'anycast', text: 'grade PR #42' });
    M.dashed('sven', 'ray', 'anycast', 1200); M.dashed('sven', 'mira', 'anycast', 1200);
    await run.sleep(550);
    await M.pulse('sven', 'ray', 'anycast');
    S.status('ray', 'working'); S.think('ray', 'reading the diff');
    S.feed({ sys: '<b>ray</b> claimed it · mira stays free' });
    S.status('sven', 'idle');
    await run.sleep(1800);

    // 4. late joiner
    S.caption('garry joins late and replays the history first.', 'Durable streams: a late joiner catches up, then goes live.', { cls: 'gold', text: 'late join' });
    M.add({ id: 'garry', label: 'garry', vendor: 'pi', x: garry.x, y: garry.y, from: { x: 0.5, y: -0.15 } });
    M.link('garry', '#general'); M.link('garry', '#review');
    S.rosterAdd(garry);
    S.feed({ sys: '<b>garry</b> (security) joined · replaying 4 messages' });
    await run.sleep(600);
    for (let i = 0; i < 4; i++) { swallow(M.pulse(i % 2 ? '#review' : '#general', 'garry', 'chat', { dur: 320 })); await run.sleep(170); }
    S.status('garry', 'working'); S.think('garry', 'auditing PR #42');
    await run.sleep(1400);

    // 5. peers talk to each other
    S.caption('They talk to each other, not through a controller.', 'Finding, fix, approval: peer to peer, across vendors.');
    swallow(S.say('ray', 'Missing input validation on /users.'));
    await dm('ray', 'david', 'Missing input validation on /users.');
    S.status('david', 'working'); S.think('david', 'fixing');
    await run.sleep(1500);
    swallow(S.say('david', 'Fixed and pushed.'));
    await dm('david', 'ray', 'Fixed and pushed.');
    await run.sleep(600);
    S.status('ray', 'idle'); S.mood('ray', 'happy'); swallow(S.say('ray', 'Approved.'));
    await mcast('ray', '#review', 'PR #42 approved ✓');
    S.status('garry', 'idle'); S.mood('garry', 'happy'); swallow(S.say('garry', 'Security: clean.'));
    await mcast('garry', '#review', 'security: clean ✓');
    S.status('david', 'idle');
    await run.sleep(700);

    // 6. done
    S.status('sven', 'working'); swallow(S.say('sven', 'Merged PR #42.'));
    await mcast('sven', '#general', 'Merged PR #42 ✓');
    S.status('sven', 'idle');
    for (const a of ['sven', 'david', 'ray', 'mira', 'garry']) S.mood(a, 'happy');
    S.caption('Shipped. Every message rode one durable, replayable log.', 'Three delivery modes, live presence, late join: one open standard on NATS.');
    S.stats([{ n: '5', label: 'agents' }, { n: '4', label: 'vendors' }, { n: '3', label: 'delivery modes' }, { n: '0', label: 'orchestrators' }]);
  }

  // ------------------------------------------------------------------ 2. three ways to send
  async function modes(S, run, { pick, next }) {
    const M = S.mesh;
    M.add({ id: 'alice', label: 'alice', vendor: 'claude', x: 0.13, y: 0.5 });
    M.add({ id: '#general', kind: 'channel', label: '#general', x: 0.5, y: 0.3 });
    for (const [id, v, x, y] of [['bob', 'opencode', 0.74, 0.12], ['carol', 'codex', 0.88, 0.32], ['dan', 'hermes', 0.74, 0.5]]) { M.add({ id, label: id, vendor: v, x, y }); M.link(id, '#general'); }
    M.link('alice', '#general');
    M.add({ id: 'role', kind: 'label', label: 'role: reviewer (3 holders)', color: 'anycast', x: 0.76, y: 0.63 });
    for (const [id, v, x, y] of [['rev-1', 'codex', 0.6, 0.84], ['rev-2', 'pi', 0.76, 0.92], ['rev-3', 'hermes', 0.92, 0.8]]) M.add({ id, label: id, vendor: v, x, y });
    M.status('bob', 'working'); M.status('rev-2', 'working');
    S.feed({ sys: 'space <b>demo</b> · 7 agents online · <b>bob</b> and <b>rev-2</b> are mid-turn' });

    const CHAT = ['Standup: API freeze at 16:00.', 'Heads up: main is green again.', 'Design review moved to #general.'];
    const DM = ['bob, can you take the migration?', 'bob: the fixture is in wt-2.', 'bob, PR #51 needs your eyes.'];
    const ANY = ['grade PR #42', 'review the auth change', 'second opinion on #51'];
    let inbox = 0, bobBusy = true, draining = false, rr = 0;
    const tried = new Set(); const state = { resolve: null };

    const drain = async () => {
      if (draining) return; draining = true;
      try {
        await run.sleep(2800);
        M.status('bob', 'idle'); S.feed({ sys: '<b>bob</b> finished his turn · reading inbox' });
        await run.sleep(300);
        while (inbox > 0) { inbox--; M.badge('bob', inbox ? 'inbox ' + inbox : null); M.ring('bob', '#d29922'); S.feed({ sys: 'delivered to <b>bob</b> · acknowledged' }); await run.sleep(480); }
        S.caption('Delivered when he freed up. In order. Nothing lost.', 'That is what agents need: they spend most of their time mid-turn.', { cls: 'dm', text: 'unicast' });
        bobBusy = false;
        await run.sleep(5000);
        M.status('bob', 'working'); bobBusy = true;
      } catch { /* cancelled */ }
      draining = false;
    };

    const actions = {
      chat: async () => {
        S.toolbarMark('chat');
        S.caption('One post. Every subscriber gets it.', '#general has three members: one stream, one bookmark per reader.', { cls: 'chat', text: 'multicast' });
        S.feed({ from: 'alice', to: '#general', kind: 'chat', text: pick(CHAT) });
        await M.pulse('alice', '#general', 'chat');
        await Promise.all(['bob', 'carol', 'dan'].map((m) => M.pulse('#general', m, 'chat', { dur: 520 })));
        S.feed({ sys: 'delivered to <b>bob</b>, <b>carol</b>, <b>dan</b>' });
      },
      dm: async () => {
        S.toolbarMark('dm');
        const text = pick(DM); S.feed({ from: 'alice', to: 'bob', kind: 'dm', text });
        M.dashed('alice', 'bob', 'dm', 1200); await M.pulse('alice', 'bob', 'dm');
        if (bobBusy) {
          inbox++; M.badge('bob', 'inbox ' + inbox);
          S.caption('bob is mid-turn. The message waits in his inbox.', 'Durable, per-reader delivery. Press again: it queues behind, in order.', { cls: 'dm', text: 'unicast' });
          S.feed({ sys: '<b>bob</b> is working · queued (' + inbox + ')' });
          drain();
        } else {
          S.caption('bob is free. Delivered now, acknowledged on read.', 'Same message, same inbox. Only the timing differs.', { cls: 'dm', text: 'unicast' });
          S.feed({ sys: 'delivered to <b>bob</b> · acknowledged' });
        }
      },
      anycast: async () => {
        S.toolbarMark('anycast');
        const holders = ['rev-1', 'rev-2', 'rev-3'];
        S.feed({ from: 'alice', to: '@reviewer', kind: 'anycast', text: pick(ANY) });
        for (const h of holders) M.dashed('alice', h, 'anycast', 1100);
        await run.sleep(450);
        const free = holders.filter((h) => M.get(h).status !== 'working');
        if (!free.length) {
          M.badge('role', 'queued 1');
          S.caption('All three reviewers are busy. The work waits on the role.', 'A shared work queue: the first one to free up takes it.', { cls: 'anycast', text: 'anycast' });
          await run.sleep(1800);
          M.status('rev-1', 'idle'); M.badge('role', null);
          free.push('rev-1');
        }
        const winner = free[rr++ % free.length];
        await M.pulse('alice', winner, 'anycast'); M.status(winner, 'working');
        const busy = holders.filter((h) => h !== winner && M.get(h).status === 'working');
        S.feed({ sys: '<b>' + winner + '</b> claimed it' + (busy.length ? ' · ' + busy.join(', ') + ' skipped (busy)' : '') });
        S.caption('Addressed to a role. One free holder claims it.', (busy.length ? busy.join(' and ') + ' busy, so skipped. ' : '') + 'Press again: the next free one takes it.', { cls: 'anycast', text: 'anycast' });
        (async () => { try { await run.sleep(3200); M.status(winner, 'idle'); } catch { /* cancelled */ } })();
      },
    };

    S.toolbar([
      { id: 'chat', label: 'Multicast', key: '1', cls: 'chat' },
      { id: 'dm', label: 'Unicast', key: '2', cls: 'dm' },
      { id: 'anycast', label: 'Anycast', key: '3', cls: 'any' },
    ].map((it) => ({ ...it, onPress: chooser(state) })), 'press one, in any order');
    S.caption('Three ways to send. One model.', 'To a channel, to one peer, or to a role. Press one.');

    const autoSeq = ['chat', 'dm', 'dm', 'anycast', 'anycast'];
    for (let i = 0; ; i++) {
      const id = await choice(S, run, state, autoSeq[Math.min(i, autoSeq.length - 1)], i === 0 ? 2400 : 3400);
      await actions[id]();
      tried.add(id);
      if (run.auto && i >= autoSeq.length - 1) { await run.sleep(3600); break; }
      if (!run.auto && tried.size === 3) {
        S.stats([{ n: '3', label: 'modes' }, { n: '1', label: 'addressing scheme' }, { n: '0', label: 'lost messages' }]);
        S.actions([{ id: 'next', label: 'Next demo', key: '→', primary: true, onPress: next }]);
      }
    }
    S.caption('One addressing scheme. Three ways to reach it.', 'A channel, a peer, or a role: all durable, all on one stream.');
    S.stats([{ n: '3', label: 'modes' }, { n: '1', label: 'addressing scheme' }, { n: '0', label: 'lost messages' }]);
  }

  // ------------------------------------------------------------------ 3. any topology
  async function topo(S, run, { pick, next }) {
    const M = S.mesh;
    const vendors = ['claude', 'opencode', 'codex', 'hermes', 'pi'];
    const names = ['lead', 'ana', 'ben', 'cleo', 'dev', 'eli', 'fay', 'gus', 'hana'];
    const workers = names.slice(1);
    names.forEach((n, i) => M.add({ id: n, label: n, vendor: vendors[i % 5], x: 0.5, y: 0.5 }));
    M.add({ id: '#team', kind: 'channel', label: '#team', x: 0.5, y: 0.5 });
    let mode = null, swarm = [], stop = false;
    const state = { resolve: null };
    const count = () => S.counter('<b>' + (names.length + swarm.length) + '</b> agents online · ' + (mode === 'hybrid' ? 3 : 1) + ' channel' + (mode === 'hybrid' ? 's' : ''));
    const ensure = (id, label, x, y) => { if (!M.has(id) || M.get(id).dying) { M.add({ id, kind: 'channel', label, x, y, from: { x: 0.5, y: 0.5 } }); } else M.move(id, x, y); };
    const drop = (id) => { if (M.has(id)) M.remove(id); };
    const relinkSwarm = () => { for (const s of swarm) M.link(s, mode === 'hybrid' ? (Math.random() < 0.5 ? '#a' : '#b') : '#team'); };
    const ring = (ids, cx, cy, rx, ry, off = -1.5708) => ids.forEach((n, i) => M.move(n, cx + Math.cos(off + (i / ids.length) * 6.283) * rx, cy + Math.sin(off + (i / ids.length) * 6.283) * ry));
    const layouts = {
      peers() { M.clearEdges(); drop('#a'); drop('#b'); M.move('#team', 0.5, 0.5); ring(names, 0.5, 0.5, 0.3, 0.36); for (const n of names) M.link(n, '#team'); },
      supervisor() { M.clearEdges(); drop('#a'); drop('#b'); M.move('lead', 0.5, 0.14); M.move('#team', 0.5, 0.46); workers.forEach((n, i) => M.move(n, 0.12 + i * (0.76 / 7), 0.8 + (i % 2) * 0.09)); for (const n of names) M.link(n, '#team'); },
      chain() { M.clearEdges(); drop('#a'); drop('#b'); M.move('#team', 0.5, 0.12); names.forEach((n, i) => { M.move(n, 0.07 + i * (0.86 / 8), 0.58 + (i % 2 ? 0.14 : -0.14)); M.link(n, '#team'); }); },
      hybrid() {
        M.clearEdges(); ensure('#a', '#alpha', 0.27, 0.58); ensure('#b', '#beta', 0.73, 0.58); M.move('#team', 0.5, 0.14);
        M.move('lead', 0.27, 0.2); M.move('eli', 0.73, 0.2); M.link('lead', '#team'); M.link('eli', '#team'); M.link('lead', '#a'); M.link('eli', '#b');
        ring(['ana', 'ben', 'cleo', 'dev'], 0.27, 0.6, 0.17, 0.3, 0.3); ring(['fay', 'gus', 'hana'], 0.73, 0.6, 0.17, 0.3, 0.3);
        for (const n of ['ana', 'ben', 'cleo', 'dev']) M.link(n, '#a'); for (const n of ['fay', 'gus', 'hana']) M.link(n, '#b');
      },
    };
    const CAP = {
      peers: ['A flat team of peers.', 'Everyone in #team, anyone can message anyone. No one is in charge.'],
      supervisor: ['A manager with workers.', 'The lead hands out work by anycast; workers report back by direct message. Same agents, same wire.'],
      chain: ['A pipeline.', 'Each stage hands off to the next with a direct message. Still the same wire.'],
      hybrid: ['Two teams with leads, and the leads are peers.', 'Any shape you can draw. It is configuration, not a framework.'],
      scale: ['Forty more agents just joined.', 'Local-first with no rewrite to scale: the same subjects and streams run from a laptop to a cluster.'],
    };
    const setMode = (m) => { mode = m; layouts[m](); relinkSwarm(); S.toolbarMark(m); S.caption(CAP[m][0], CAP[m][1]); count(); };
    const addSwarm = () => {
      const n0 = swarm.length;
      for (let i = 0; i < 40; i++) {
        const id = 'w' + (n0 + i); const a = Math.random() * 6.283, rr = 0.36 + Math.random() * 0.12;
        M.add({ id, vendor: pick(vendors), x: 0.5 + Math.cos(a) * rr * 1.15, y: 0.5 + Math.sin(a) * rr * 1.1, from: { x: 0.5 + Math.cos(a) * 0.9, y: 0.5 + Math.sin(a) * 0.9 }, size: 0.5, status: pick(['idle', 'idle', 'working']) });
        swarm.push(id);
      }
      relinkSwarm(); S.toolbarMark('scale'); S.caption(CAP.scale[0], CAP.scale[1]); count();
    };
    const busyFor = (id, ms) => { M.status(id, 'working'); (async () => { try { await run.sleep(ms); M.status(id, 'idle'); } catch { /* cancelled */ } })(); };
    const traffic = async () => {
      if (!mode) return;
      const r = Math.random();
      if (swarm.length && r < 0.45) { const a = pick(swarm); const e = M.edges.find((e) => e.a === a); if (e) { await M.pulse(a, e.b, 'chat', { dur: 500 }); swallow(M.pulse(e.b, pick(swarm), 'chat', { dur: 450 })); } return; }
      if (mode === 'peers') {
        const a = pick(names), b = pick(names.filter((n) => n !== a));
        if (r < 0.75) { M.dashed(a, b, 'dm', 900); busyFor(b, 1500); await M.pulse(a, b, 'dm'); }
        else { await M.pulse(a, '#team', 'chat'); await Promise.all(names.filter((n) => n !== a).slice(0, 5).map((n) => M.pulse('#team', n, 'chat', { dur: 450 }))); }
      } else if (mode === 'supervisor') {
        const w = pick(workers.filter((n) => M.get(n).status !== 'working')) || pick(workers);
        for (const x of workers) M.dashed('lead', x, 'anycast', 500);
        await M.pulse('lead', w, 'anycast'); busyFor(w, 1800);
        (async () => { try { await run.sleep(1600); await M.pulse(w, 'lead', 'dm'); } catch { /* cancelled */ } })();
      } else if (mode === 'chain') {
        for (let i = 0; i < names.length - 1 && mode === 'chain'; i++) { busyFor(names[i], 500); M.dashed(names[i], names[i + 1], 'dm', 700); await M.pulse(names[i], names[i + 1], 'dm', { dur: 380 }); }
        if (mode === 'chain') { busyFor('hana', 600); await M.pulse('hana', '#team', 'chat'); }
      } else if (mode === 'hybrid') {
        const left = ['lead', 'ana', 'ben', 'cleo', 'dev'], right = ['eli', 'fay', 'gus', 'hana'];
        if (r < 0.35) { const a = pick(left); await M.pulse(a, '#a', 'chat'); await Promise.all(left.filter((n) => n !== a).map((n) => M.pulse('#a', n, 'chat', { dur: 420 }))); }
        else if (r < 0.7) { const a = pick(right); await M.pulse(a, '#b', 'chat'); await Promise.all(right.filter((n) => n !== a).map((n) => M.pulse('#b', n, 'chat', { dur: 420 }))); }
        else if (r < 0.85) { M.dashed('lead', 'eli', 'dm', 900); await M.pulse(Math.random() < 0.5 ? 'lead' : 'eli', Math.random() < 0.5 ? 'eli' : 'lead', 'dm'); }
        else { const a = pick(['lead', 'eli']); await M.pulse(a, '#team', 'chat'); await M.pulse('#team', a === 'lead' ? 'eli' : 'lead', 'chat', { dur: 450 }); }
      }
    };
    (async () => { while (!stop) { try { await traffic(); await run.sleep(mode === 'chain' ? 500 : 260 + Math.random() * 300); } catch { return; } } })();

    S.toolbar([
      { id: 'peers', label: 'Peers', key: '1' }, { id: 'supervisor', label: 'Supervisor', key: '2' }, { id: 'chain', label: 'Pipeline', key: '3' }, { id: 'hybrid', label: 'Hybrid', key: '4' }, { id: 'scale', label: '+40 agents', key: '5', cls: 'any' },
    ].map((it) => ({ ...it, onPress: chooser(state) })), 'same nine agents, re-wired');
    setMode('peers'); S.caption('Nine agents, one space. The shape is yours.', 'Press a topology: the same agents re-wire live.');

    const autoSeq = [['supervisor', 5200], ['chain', 5600], ['hybrid', 6200], ['scale', 5600], ['peers', 7000]];
    let scaledAt = 0;
    for (let i = 0; ; i++) {
      const [autoId, after] = autoSeq[Math.min(i, autoSeq.length - 1)];
      const id = await choice(S, run, state, autoId, after);
      if (id === 'scale') { addSwarm(); scaledAt = scaledAt || Date.now(); }
      else setMode(id);
      if (run.auto && i >= autoSeq.length - 1) { await run.sleep(5000); break; }
      if (!run.auto && scaledAt) {
        S.stats([{ n: String(names.length + swarm.length), label: 'agents' }, { n: '4', label: 'topologies' }, { n: '1', label: 'standard' }, { n: '0', label: 'rewrites' }]);
        S.actions([{ id: 'next', label: 'Next demo', key: '→', primary: true, onPress: next }]);
      }
    }
    stop = true;
    S.caption('Any shape you can draw, on one standard.', 'Peers, supervisor, pipeline, hybrid: the topology is yours to define.');
    S.stats([{ n: String(names.length + swarm.length), label: 'agents' }, { n: '4', label: 'topologies' }, { n: '1', label: 'standard' }, { n: '0', label: 'rewrites' }]);
  }

  // ------------------------------------------------------------------ 4. a workflow that survives
  const PROGRAM = [
    'const planner = await spawn("planner")',
    'const builder = await spawn("builder", { worktree: "wt-1" })',
    '',
    'const plan = await ask(planner, { name: "plan", schema: { steps: "array" } })',
    'const ok = await checkpoint("approve-plan", "Approve plan?", { timeout: "4h" })',
    '',
    'const r = await turn(builder, { name: "build", deadline: "30m" })',
    '',
    'const verdicts = await fanOut(["security", "critic"], async (role) => {',
    '  const reviewer = await spawn("reviewer", { role })',
    '  return ask(reviewer, { name: "verdict", schema: { ok: "boolean" } })',
    '}, { name: "review", key: (role) => role })',
    '',
    'log("merged", verdicts.every((v) => v.ok))',
  ];
  async function lang(S, run, { sfx }) {
    const M = S.mesh; const RUN = { x: 0.5, y: 0.8 };
    S.code(PROGRAM);
    M.add({ id: 'run', kind: 'channel', color: 'gold', label: 'run 7f3a', x: RUN.x, y: RUN.y, size: 1.1 });
    const SEC = '/fanOut:review#0/b:security/', CRI = '/fanOut:review#0/b:critic/';
    const step = async (line, key, scope, ms, note) => { S.hl(line); S.journal({ key, scope, status: 'pending' }); await run.sleep(ms); return () => { S.journalSet(scope + key, 'ok', note); S.codeDone(line); }; };
    const spawnAt = (id, vendor, x, y) => { M.add({ id, label: id, vendor, x, y, from: RUN }); M.link(id, 'run'); };

    S.caption('A workflow is a program. Every effect is journalled.', 'Run it. You will be the human in the loop.');
    await run.press(S, [{ id: 'go', label: 'Run the workflow', key: 'Space', primary: true }], { autoAfter: 2600 });

    let done = await step(0, 'spawn:planner#0', '/', 650); spawnAt('planner', 'claude', 0.18, 0.3); done('ok · seat planner#1');
    await run.sleep(450);
    done = await step(1, 'spawn:builder#0', '/', 650); spawnAt('builder', 'opencode', 0.42, 0.2); done('ok · wt-1');
    S.caption('spawn brings real agents into the run.', 'Each one is a seat on the mesh, with a worktree of its own.');
    await run.sleep(500);

    S.hl(3); S.journal({ key: 'ask:plan#0', scope: '/', status: 'pending' }); M.status('planner', 'working');
    await M.pulse('run', 'planner', 'gold'); await run.sleep(1300); await M.pulse('planner', 'run', 'gold');
    M.status('planner', 'idle'); S.journalSet('/ask:plan#0', 'ok', 'ok · { steps: 3 }'); S.codeDone(3);
    await run.sleep(300);

    S.hl(4); S.journal({ key: 'checkpoint:approve-plan#0', scope: '/', status: 'pending', note: 'waiting for a human' });
    M.add({ id: 'you', label: 'you', x: 0.82, y: 0.86, status: 'waiting', from: { x: 1.1, y: 1 } }); M.link('you', 'run');
    S.caption('Approve the plan?', 'A checkpoint is a durable pause a human resolves from anywhere. It waits 4 hours if it must. You are the human.', { cls: 'gold', text: 'checkpoint' });
    await run.press(S, [{ id: 'ok', label: 'Approve', key: 'Space', primary: true }], { autoAfter: 3000 });
    await M.pulse('you', 'run', 'gold'); M.status('you', 'idle'); sfx.ok();
    S.journalSet('/checkpoint:approve-plan#0', 'ok', 'resolved by you'); S.codeDone(4);
    await run.sleep(300);

    S.hl(6); S.journal({ key: 'turn:build#0', scope: '/', status: 'pending' }); M.status('builder', 'working');
    S.caption('The builder takes a turn in its own worktree.', 'turn wakes an agent; it reads its channels and speaks for itself.');
    await M.pulse('run', 'builder', 'gold'); await run.sleep(2000); await M.pulse('builder', 'run', 'gold');
    M.status('builder', 'idle'); S.journalSet('/turn:build#0', 'ok', 'done · 2.0s'); S.codeDone(6);
    await run.sleep(300);

    S.hl(8); S.journal({ key: 'fanOut:review#0', scope: '/', status: 'pending', note: '2 branches' });
    S.caption('Two reviewers in parallel, each in its own journal branch.', 'Concurrency you can read back afterwards.');
    await run.sleep(600);
    S.hl(9); S.journal({ key: 'spawn:reviewer#0', scope: SEC, status: 'pending' }); S.journal({ key: 'spawn:reviewer#0', scope: CRI, status: 'pending' });
    await run.sleep(650);
    spawnAt('security', 'codex', 0.7, 0.2); spawnAt('critic', 'hermes', 0.9, 0.46);
    S.journalSet(SEC + 'spawn:reviewer#0', 'ok', 'ok'); S.journalSet(CRI + 'spawn:reviewer#0', 'ok', 'ok'); S.codeDone(9);
    await run.sleep(350);
    S.hl(10); S.journal({ key: 'ask:verdict#0', scope: SEC, status: 'pending' }); S.journal({ key: 'ask:verdict#0', scope: CRI, status: 'pending' });
    M.status('security', 'working'); M.status('critic', 'working');
    swallow(M.pulse('run', 'security', 'gold')); swallow(M.pulse('run', 'critic', 'gold', { delay: 120 }));
    await run.sleep(900);

    S.caption('Now kill the process that is driving this run.', 'The agents are real seats on the mesh. The run is a program plus its journal, nothing else.', { cls: 'red', text: 'crash test' });
    const killed = run.press(S, [{ id: 'kill', label: 'Kill the host', key: 'Space', cls: 'danger' }], { autoAfter: 2800 });
    (async () => { try { await run.sleep(1500); await M.pulse('security', 'run', 'gold'); M.status('security', 'idle'); S.journalSet(SEC + 'ask:verdict#0', 'ok', 'ok · { ok: true }'); } catch { /* cancelled */ } })();
    await killed;

    S.host(false); S.journalFreeze(true); sfx.bad(); S.hl(-1);
    S.caption('The host is dead. Nothing was serialized.', 'The journal and the program are the whole state. Resume on any machine.', { cls: 'red', text: 'host died' });
    await run.sleep(500);
    await run.press(S, [{ id: 'resume', label: 'Resume on another host', key: 'Space', primary: true }], { autoAfter: 3000 });

    S.host(true); S.journalFreeze(false); S.codeReset();
    S.caption('Resume re-runs the program from the top.', 'Recorded steps return their recorded results instantly. No agent is asked twice.', { cls: 'chat', text: 'replay' });
    const recorded = [[0, '/spawn:planner#0'], [1, '/spawn:builder#0'], [3, '/ask:plan#0'], [4, '/checkpoint:approve-plan#0'], [6, '/turn:build#0'], [9, SEC + 'spawn:reviewer#0'], [9, CRI + 'spawn:reviewer#0'], [10, SEC + 'ask:verdict#0']];
    for (const [line, key] of recorded) { S.hl(line, 'replay'); S.journalSet(key, 'replayed', 'replayed'); sfx.kind('chat'); await run.sleep(260); S.codeDone(line); }
    S.hl(10); S.journalSet(CRI + 'ask:verdict#0', 'pending', 'live · recovered');
    S.caption('It reaches the one unfinished step and continues live.', 'The critic never noticed. Its verdict lands in the same journal.');
    await run.sleep(1700);
    await M.pulse('critic', 'run', 'gold'); M.status('critic', 'idle');
    S.journalSet(CRI + 'ask:verdict#0', 'ok', 'ok · { ok: true }'); S.journalSet('/fanOut:review#0', 'ok', 'ok · 2 branches'); S.codeDone(8); S.codeDone(10); S.codeDone(11);
    await run.sleep(400);
    S.hl(13); S.journal({ key: 'log', scope: '/', status: 'ok', note: 'merged true' }); sfx.ok(); M.ring('run', '#e9c46a'); M.status('you', 'idle');
    await run.sleep(400); S.codeDone(13);
    S.caption('Merged. One dead host, zero lost work.', 'Cotal Lang: a small JavaScript subset where every effect is durable and every run is replayable.');
    S.stats([{ n: '11', label: 'steps' }, { n: '1', label: 'dead host' }, { n: '0', label: 'lost work' }, { n: '0', label: 'agents re-asked' }]);
  }

  window.DEMOS = [
    { id: 'team', layout: 'team', secs: 30, title: 'A team ships a feature', hook: 'Five agents from four vendors coordinate as peers in one shared space. No orchestrator.', tags: [{ text: 'presence' }, { text: 'multicast', cls: 'chat' }, { text: 'unicast', cls: 'dm' }, { text: 'anycast', cls: 'any' }, { text: 'late join', cls: 'gold' }], run: team },
    { id: 'modes', layout: 'modes', secs: 30, title: 'Three ways to send', hook: 'To a channel, to one peer, or to a role. One addressing scheme, durable by default.', tags: [{ text: 'multicast', cls: 'chat' }, { text: 'unicast', cls: 'dm' }, { text: 'anycast', cls: 'any' }, { text: 'durable inbox' }], run: modes },
    { id: 'topo', layout: 'topo', secs: 35, title: 'Any topology', hook: 'Peers, supervisor, pipeline, hybrid: the same agents re-wired live. Then forty more join.', tags: [{ text: 'topology' }, { text: 'scale', cls: 'any' }, { text: 'local-first' }], run: topo },
    { id: 'lang', layout: 'lang', secs: 40, title: 'A workflow that survives', hook: 'Cotal Lang: a program spawns agents, pauses for your approval, and survives its host being killed.', tags: [{ text: 'cotal lang', cls: 'gold' }, { text: 'checkpoint', cls: 'gold' }, { text: 'journal' }, { text: 'resume' }], run: lang },
  ];
})();

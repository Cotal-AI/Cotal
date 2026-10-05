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
    S.feed({ sys: '4 agents online' });

    const members = (ch) => M.edges.filter((e) => e.b === ch).map((e) => e.a);
    const mcast = async (from, ch, text) => {
      S.feed({ from, to: ch, kind: 'chat', text });
      await M.pulse(from, ch, 'chat');
      await Promise.all(members(ch).filter((m) => m !== from).map((m) => M.pulse(ch, m, 'chat', { dur: 520 })));
    };
    const dm = async (from, to, text) => { S.feed({ from, to, kind: 'dm', text }); M.dashed(from, to, 'dm', 1400); await M.pulse(from, to, 'dm'); };

    S.caption('Five agents, four vendors, one space.', 'No orchestrator in the middle.');
    await run.press(S, [{ id: 'go', label: 'Ship a feature', key: 'Space', primary: true }], { autoAfter: 2600 });

    // 1. multicast
    S.status('sven', 'working'); S.think('sven', 'planning');
    await run.sleep(1100);
    const plan = 'Plan: david builds the API, reviewers stand by.';
    swallow(S.say('sven', plan));
    await run.sleep(500);
    S.caption('One post. Every member gets it.', '', { cls: 'chat', text: 'multicast' });
    await mcast('sven', '#general', plan);
    await run.sleep(1400);

    // 2. unicast
    S.caption('A direct message to david.', 'If he is busy it waits in his inbox.', { cls: 'dm', text: 'unicast' });
    await dm('sven', 'david', 'Spec is in wt-1. Ship it as PR #42.');
    S.status('sven', 'idle'); S.status('david', 'working'); S.think('david', 'building POST /users');
    await run.sleep(2200);

    // 3. the PR, then anycast to the reviewer role
    swallow(S.say('david', 'PR #42 is up: POST /users.'));
    await mcast('david', '#review', 'PR #42 is up: POST /users');
    S.status('david', 'waiting');
    await run.sleep(400);
    S.caption('Sent to a role. One free reviewer claims it.', '', { cls: 'anycast', text: 'anycast' });
    S.status('sven', 'working');
    S.feed({ from: 'sven', to: '@reviewer', kind: 'anycast', text: 'grade PR #42' });
    M.dashed('sven', 'ray', 'anycast', 1200); M.dashed('sven', 'mira', 'anycast', 1200);
    await run.sleep(550);
    await M.pulse('sven', 'ray', 'anycast');
    S.status('ray', 'working'); S.think('ray', 'reading the diff');
    S.feed({ sys: 'ray claimed it' });
    S.status('sven', 'idle');
    await run.sleep(1800);

    // 4. late joiner
    S.caption('garry joins late and replays the history.', '', { cls: 'gold', text: 'late join' });
    M.add({ id: 'garry', label: 'garry', vendor: 'pi', x: garry.x, y: garry.y, from: { x: 0.5, y: -0.15 } });
    M.link('garry', '#general'); M.link('garry', '#review');
    S.rosterAdd(garry);
    S.feed({ sys: 'garry joined · replaying 4 messages' });
    await run.sleep(600);
    for (let i = 0; i < 4; i++) { swallow(M.pulse(i % 2 ? '#review' : '#general', 'garry', 'chat', { dur: 320 })); await run.sleep(170); }
    S.status('garry', 'working'); S.think('garry', 'auditing PR #42');
    await run.sleep(1400);

    // 5. peers talk to each other
    S.caption('Peers talk to peers.', 'Finding, fix, approval: across vendors.');
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
    S.caption('Shipped.', 'One durable log. One open standard.');
    S.stats([{ n: '5', label: 'agents' }, { n: '4', label: 'vendors' }, { n: '0', label: 'orchestrators' }]);
  }

  // ------------------------------------------------------------------ 2. three ways to send
  async function modes(S, run, { pick, next }) {
    const M = S.mesh;
    M.add({ id: 'alice', label: 'alice', vendor: 'claude', x: 0.13, y: 0.5 });
    M.add({ id: '#general', kind: 'channel', label: '#general', x: 0.5, y: 0.3 });
    for (const [id, v, x, y] of [['bob', 'opencode', 0.74, 0.12], ['carol', 'codex', 0.88, 0.32], ['dan', 'hermes', 0.74, 0.5]]) { M.add({ id, label: id, vendor: v, x, y }); M.link(id, '#general'); }
    M.link('alice', '#general');
    M.add({ id: 'role', kind: 'label', label: 'reviewers', color: 'anycast', x: 0.76, y: 0.64 });
    for (const [id, v, x, y] of [['rev-1', 'codex', 0.6, 0.84], ['rev-2', 'pi', 0.76, 0.92], ['rev-3', 'hermes', 0.92, 0.8]]) M.add({ id, label: id, vendor: v, x, y });
    M.status('bob', 'working'); M.status('rev-2', 'working');
    S.feed({ sys: '7 agents online · bob and rev-2 are busy' });

    const CHAT = ['Standup: API freeze at 16:00.', 'Heads up: main is green again.', 'Design review moved to #general.'];
    const DM = ['bob, can you take the migration?', 'bob: the fixture is in wt-2.', 'bob, PR #51 needs your eyes.'];
    const ANY = ['grade PR #42', 'review the auth change', 'second opinion on #51'];
    let inbox = 0, bobBusy = true, draining = false, rr = 0;
    const tried = new Set(); const state = { resolve: null };

    const drain = async () => {
      if (draining) return; draining = true;
      try {
        await run.sleep(2800);
        M.status('bob', 'idle'); S.feed({ sys: 'bob is free · reading inbox' });
        await run.sleep(300);
        while (inbox > 0) { inbox--; M.badge('bob', inbox ? 'inbox ' + inbox : null); M.ring('bob', '#d29922'); S.feed({ sys: 'delivered to bob' }); await run.sleep(480); }
        S.caption('Delivered when he freed up. Nothing lost.', '', { cls: 'dm', text: 'unicast' });
        bobBusy = false;
        await run.sleep(5000);
        M.status('bob', 'working'); bobBusy = true;
      } catch { /* cancelled */ }
      draining = false;
    };

    const actions = {
      chat: async () => {
        S.toolbarMark('chat');
        S.caption('One post. Everyone in #general gets it.', '', { cls: 'chat', text: 'multicast' });
        S.feed({ from: 'alice', to: '#general', kind: 'chat', text: pick(CHAT) });
        await M.pulse('alice', '#general', 'chat');
        await Promise.all(['bob', 'carol', 'dan'].map((m) => M.pulse('#general', m, 'chat', { dur: 520 })));
        S.feed({ sys: 'delivered to bob, carol, dan' });
      },
      dm: async () => {
        S.toolbarMark('dm');
        const text = pick(DM); S.feed({ from: 'alice', to: 'bob', kind: 'dm', text });
        M.dashed('alice', 'bob', 'dm', 1200); await M.pulse('alice', 'bob', 'dm');
        if (bobBusy) {
          inbox++; M.badge('bob', 'inbox ' + inbox);
          S.caption('bob is busy. It waits in his inbox.', 'Press again: it queues in order.', { cls: 'dm', text: 'unicast' });
          S.feed({ sys: 'bob is busy · queued (' + inbox + ')' });
          drain();
        } else {
          S.caption('bob is free. Delivered now.', '', { cls: 'dm', text: 'unicast' });
          S.feed({ sys: 'delivered to bob' });
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
          S.caption('All reviewers busy. The work waits on the role.', '', { cls: 'anycast', text: 'anycast' });
          await run.sleep(1800);
          M.status('rev-1', 'idle'); M.badge('role', null);
          free.push('rev-1');
        }
        const winner = free[rr++ % free.length];
        await M.pulse('alice', winner, 'anycast'); M.status(winner, 'working');
        const busy = holders.filter((h) => h !== winner && M.get(h).status === 'working');
        S.feed({ sys: winner + ' claimed it' + (busy.length ? ' · ' + busy.join(', ') + ' busy' : '') });
        S.caption('Sent to a role. One free reviewer claims it.', busy.length ? busy.join(' and ') + ' busy, so skipped.' : '', { cls: 'anycast', text: 'anycast' });
        (async () => { try { await run.sleep(3200); M.status(winner, 'idle'); } catch { /* cancelled */ } })();
      },
    };

    S.toolbar([
      { id: 'chat', label: 'Multicast', key: '1', cls: 'chat' },
      { id: 'dm', label: 'Unicast', key: '2', cls: 'dm' },
      { id: 'anycast', label: 'Anycast', key: '3', cls: 'any' },
    ].map((it) => ({ ...it, onPress: chooser(state) })));
    S.caption('Three ways to send.', 'Press one.');

    const autoSeq = ['chat', 'dm', 'dm', 'anycast', 'anycast'];
    for (let i = 0; ; i++) {
      const id = await choice(S, run, state, autoSeq[Math.min(i, autoSeq.length - 1)], i === 0 ? 2400 : 3400);
      await actions[id]();
      tried.add(id);
      if (run.auto && i >= autoSeq.length - 1) { await run.sleep(3600); break; }
      if (!run.auto && tried.size === 3) {
        S.stats([{ n: '3', label: 'modes' }, { n: '0', label: 'lost messages' }]);
        S.actions([{ id: 'next', label: 'Next demo', key: '→', primary: true, onPress: next }]);
      }
    }
    S.caption('One addressing scheme.', 'A channel, a peer, or a role.');
    S.stats([{ n: '3', label: 'modes' }, { n: '0', label: 'lost messages' }]);
  }

  // ------------------------------------------------------------------ 3. any topology
  async function topo(S, run, { pick, next }) {
    const M = S.mesh;
    const vendors = ['claude', 'opencode', 'codex', 'hermes', 'pi'];
    const names = ['lead', 'ana', 'ben', 'cleo', 'dev', 'eli', 'fay', 'gus', 'hana'];
    const workers = names.slice(1);
    const TREE = { ben: ['ana', 'cleo', 'dev'], gus: ['eli', 'fay', 'hana'] };
    names.forEach((n, i) => M.add({ id: n, label: n, vendor: vendors[i % 5], x: 0.5, y: 0.5 }));
    M.add({ id: '#team', kind: 'channel', label: '#team', x: 0.5, y: 0.5 });
    let mode = null, swarm = [], gen = 0, stop = false, tasks = 6;
    const state = { resolve: null };
    const live = (g) => !stop && g === gen;
    const count = () => S.counter('<b>' + (names.length + swarm.length) + '</b> agents');
    const ensure = (id, label, x, y) => { if (!M.has(id) || M.get(id).dying) { M.add({ id, kind: 'channel', label, x, y, from: { x: 0.5, y: 0.5 } }); } else M.move(id, x, y); };
    const drop = (id) => { if (M.has(id)) M.remove(id); };
    const busyFor = (id, ms) => { M.status(id, 'working'); (async () => { try { await run.sleep(ms); M.status(id, 'idle'); } catch { /* cancelled */ } })(); };
    const later = (ms, fn) => { (async () => { try { await run.sleep(ms); await fn(); } catch { /* cancelled */ } })(); };
    const ring = (ids, cx, cy, rx, ry, off = -1.5708) => ids.forEach((n, i) => M.move(n, cx + Math.cos(off + (i / ids.length) * 6.283) * rx, cy + Math.sin(off + (i / ids.length) * 6.283) * ry));
    const layouts = {
      peers() { drop('#a'); drop('#b'); ensure('#team', '#team', 0.5, 0.5); ring(names, 0.5, 0.5, 0.3, 0.36); for (const n of names) M.link(n, '#team'); },
      supervisor() { drop('#a'); drop('#b'); drop('#team'); M.move('lead', 0.5, 0.2); workers.forEach((n, i) => { M.move(n, 0.1 + i * (0.8 / 7), 0.74); M.link(n, 'lead'); }); },
      tree() {
        drop('#a'); drop('#b'); drop('#team'); M.move('lead', 0.5, 0.14);
        Object.entries(TREE).forEach(([sub, kids], j) => {
          const cx = j ? 0.73 : 0.27; M.move(sub, cx, 0.45); M.link(sub, 'lead');
          kids.forEach((k, i) => { M.move(k, cx + (i - 1) * 0.15, 0.78); M.link(k, sub); });
        });
      },
      chain() { drop('#a'); drop('#b'); ensure('#team', '#team', 0.5, 0.12); names.forEach((n, i) => { M.move(n, 0.07 + i * (0.86 / 8), 0.58 + (i % 2 ? 0.14 : -0.14)); M.link(n, '#team'); }); },
      hybrid() {
        ensure('#a', '#alpha', 0.27, 0.58); ensure('#b', '#beta', 0.73, 0.58); ensure('#team', '#team', 0.5, 0.14);
        M.move('lead', 0.27, 0.2); M.move('eli', 0.73, 0.2); M.link('lead', '#team'); M.link('eli', '#team'); M.link('lead', '#a'); M.link('eli', '#b');
        ring(['ana', 'ben', 'cleo', 'dev'], 0.27, 0.6, 0.17, 0.3, 0.3); ring(['fay', 'gus', 'hana'], 0.73, 0.6, 0.17, 0.3, 0.3);
        for (const n of ['ana', 'ben', 'cleo', 'dev']) M.link(n, '#a'); for (const n of ['fay', 'gus', 'hana']) M.link(n, '#b');
      },
    };
    const CAP = {
      peers: ['A flat team of peers.', 'No one is in charge.'],
      supervisor: ['A manager with workers.', 'The lead hands each task to a free worker, who reports back.'],
      tree: ['A tree of teams.', 'The lead delegates to sub-leads. Each one splits the work.'],
      chain: ['A pipeline.', 'Each stage hands off to the next.'],
      hybrid: ['Two teams, and the leads are peers.', ''],
      scale: ['Forty more just joined.', 'Same wire, from a laptop to a cluster.'],
    };

    // The forty: placed and wired to fit whatever shape is on screen.
    const dropSwarm = () => { gen++; for (const s of swarm) M.remove(s); swarm = []; M.zoomTo(1); };
    const swarmSpot = (i) => {
      if (mode === 'supervisor' || mode === 'tree') {
        const row = i % 2, col = Math.floor(i / 2);
        return { x: -0.04 + col * (1.08 / 19) + (row ? 0.028 : 0), y: 0.97 + row * 0.1, hub: mode === 'supervisor' ? 'lead' : col < 10 ? 'ben' : 'gus' };
      }
      const a = ((i + 0.5) / 40) * 6.283 + (Math.random() - 0.5) * 0.08, ring = i % 3;
      const x = 0.5 + Math.cos(a) * (0.42 + ring * 0.065), y = 0.5 + Math.sin(a) * (0.45 + ring * 0.035);
      return { x, y, hub: mode === 'hybrid' ? (x < 0.5 ? '#a' : '#b') : '#team' };
    };
    const addSwarm = () => {
      if (swarm.length) return;
      const g = ++gen;
      for (let i = 0; i < 40; i++) {
        const id = 'w' + g + '_' + i, p = swarmSpot(i);
        M.add({ id, vendor: pick(vendors), x: p.x, y: p.y, from: { x: 0.5 + (p.x - 0.5) * 2.2, y: 0.5 + (p.y - 0.5) * 2.2 }, size: 0.6, status: pick(['idle', 'idle', 'idle', 'working', 'waiting']) });
        M.link(id, p.hub); swarm.push(id);
      }
      M.zoomTo(mode === 'supervisor' || mode === 'tree' ? 0.72 : 0.8);
      S.toolbarMark('scale'); S.caption(CAP.scale[0], CAP.scale[1]); count();
      swarmChurn(g); swarmTraffic(g);
    };
    // The outer agents change state on their own: a burst of work, a wait for input, back to idle.
    const swarmChurn = async (g) => {
      try {
        while (live(g)) {
          await run.sleep(160 + Math.random() * 220);
          if (!live(g)) return;
          const a = pick(swarm), n = M.get(a); if (!n) continue;
          if (n.status === 'idle') { if (Math.random() < 0.6) busyFor(a, 1200 + Math.random() * 2400); }
          else if (n.status === 'working' && Math.random() < 0.3) { M.status(a, 'waiting'); later(1200 + Math.random() * 2000, () => M.status(a, 'idle')); }
          else if (n.status === 'waiting' && Math.random() < 0.5) M.status(a, 'idle');
        }
      } catch { /* cancelled */ }
    };
    // Dense, mixed traffic: channel fan-outs, peer DMs, and tasks claimed and reported back.
    const swarmTraffic = async (g) => {
      const hubOf = (a) => { const e = M.edges.find((e) => e.a === a); return e ? e.b : null; };
      const members = (hub) => M.edges.filter((e) => e.b === hub).map((e) => e.a);
      try {
        while (live(g)) {
          await run.sleep(70 + Math.random() * 140);
          if (!live(g)) return;
          const r = Math.random(), a = pick(swarm), hub = hubOf(a);
          if (!hub || !M.get(hub)) continue;
          if (M.get(hub).kind !== 'channel') {
            // a task from the hub to a free member, and its report back a little later
            if (r < 0.4) {
              const free = members(hub).filter((m) => swarm.includes(m) && M.get(m).status === 'idle'); const w = pick(free); if (!w) continue;
              swallow(M.pulse(hub, w, 'anycast', { dur: 520 })); busyFor(w, 1100 + Math.random() * 1300);
              later(1700 + Math.random() * 2000, () => live(g) && M.pulse(w, hub, 'dm', { dur: 520 }));
            } else { const b = pick(swarm); if (b !== a) { M.dashed(a, b, 'dm', 600); swallow(M.pulse(a, b, 'dm', { dur: 480 })); } }
          } else if (r < 0.55) {
            M.pulse(a, hub, 'chat', { dur: 420 }).then(() => {
              const ms = members(hub).filter((m) => m !== a);
              for (let i = 0; i < 2 + Math.floor(Math.random() * 4); i++) swallow(M.pulse(hub, pick(ms), 'chat', { dur: 380 + Math.random() * 200 }));
            }, () => {});
          } else if (r < 0.85) {
            const b = pick(swarm); if (b !== a) { M.dashed(a, b, 'dm', 600); swallow(M.pulse(a, b, 'dm', { dur: 480 })); }
          } else {
            const b = pick(swarm.filter((n) => M.get(n).status === 'idle')); if (b && b !== a) { swallow(M.pulse(a, b, 'anycast', { dur: 500 })); busyFor(b, 1500 + Math.random() * 2500); }
          }
        }
      } catch { /* cancelled */ }
    };

    const setMode = (m) => {
      dropSwarm(); mode = m; M.clearEdges(); layouts[m]();
      for (const n of names) M.badge(n, null);
      if (m === 'supervisor') M.badge('lead', tasks + ' tasks');
      S.toolbarMark(m); S.caption(CAP[m][0], CAP[m][1]); count();
    };
    let treeBusy = false;
    const treeRound = async () => {
      // lead → a free sub-lead → its three workers → reports climb back up
      const sub = pick(Object.keys(TREE).filter((s) => M.get(s).status !== 'working')); if (!sub || treeBusy) return;
      treeBusy = true; const kids = TREE[sub];
      M.status('lead', 'working'); M.dashed('lead', sub, 'dm', 600);
      await M.pulse('lead', sub, 'dm'); M.status('lead', 'idle');
      M.status(sub, 'working'); M.badge(sub, '3 tasks'); treeBusy = false;
      await run.sleep(300);
      await Promise.all(kids.map((k, i) => M.pulse(sub, k, 'anycast', { dur: 500, delay: i * 120 }).then(() => busyFor(k, 1400 + Math.random() * 1400))));
      let left = 3;
      later(0, () => Promise.all(kids.map(async (k) => {
        await run.sleep(1600 + Math.random() * 1500); if (mode !== 'tree') return;
        await M.pulse(k, sub, 'dm', { dur: 480 }); left--; M.badge(sub, left ? left + ' tasks' : null);
      })).then(async () => { if (mode !== 'tree') return; M.status(sub, 'idle'); await M.pulse(sub, 'lead', 'dm'); }));
    };
    const traffic = async () => {
      if (!mode) return;
      const r = Math.random();
      if (mode === 'peers') {
        const a = pick(names), b = pick(names.filter((n) => n !== a));
        if (r < 0.75) { M.dashed(a, b, 'dm', 900); busyFor(b, 1500); await M.pulse(a, b, 'dm'); }
        else { await M.pulse(a, '#team', 'chat'); await Promise.all(names.filter((n) => n !== a).slice(0, 5).map((n) => M.pulse('#team', n, 'chat', { dur: 450 }))); }
      } else if (mode === 'supervisor') {
        const free = workers.filter((n) => M.get(n).status !== 'working');
        if (!free.length) { await run.sleep(400); return; }
        const w = pick(free);
        tasks = tasks > 1 ? tasks - 1 : 6; M.badge('lead', tasks + ' tasks');
        M.status('lead', 'working');
        for (const x of free) M.dashed('lead', x, 'anycast', 450);
        await M.pulse('lead', w, 'anycast'); busyFor(w, 2200 + Math.random() * 1200);
        later(700, async () => { M.status('lead', 'idle'); await run.sleep(1300 + Math.random() * 900); if (mode === 'supervisor') await M.pulse(w, 'lead', 'dm'); });
      } else if (mode === 'tree') {
        await treeRound(); await run.sleep(600);
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
    (async () => { while (!stop) { try { await traffic(); await run.sleep(mode === 'chain' ? 500 : mode === 'supervisor' ? 650 + Math.random() * 400 : 260 + Math.random() * 300); } catch { return; } } })();

    S.toolbar([
      { id: 'peers', label: 'Peers', key: '1' }, { id: 'supervisor', label: 'Supervisor', key: '2' }, { id: 'tree', label: 'Tree', key: '3' },
      { id: 'chain', label: 'Pipeline', key: '4' }, { id: 'hybrid', label: 'Hybrid', key: '5' }, { id: 'scale', label: '+40 agents', key: '6', cls: 'any' },
    ].map((it) => ({ ...it, onPress: chooser(state) })));
    setMode('peers'); S.caption('Nine agents. Pick a shape.', '');

    const autoSeq = [['supervisor', 4600], ['tree', 6400], ['chain', 5400], ['hybrid', 4800], ['scale', 5000]];
    let scaledAt = 0;
    for (let i = 0; ; i++) {
      const [autoId, after] = autoSeq[Math.min(i, autoSeq.length - 1)];
      const id = await choice(S, run, state, autoId, after);
      if (id === 'scale') { addSwarm(); scaledAt = scaledAt || Date.now(); }
      else setMode(id);
      if (run.auto && i >= autoSeq.length - 1) { await run.sleep(6500); break; }
      if (!run.auto && scaledAt) {
        S.stats([{ n: String(names.length + swarm.length), label: 'agents' }, { n: '5', label: 'topologies' }, { n: '0', label: 'rewrites' }]);
        S.actions([{ id: 'next', label: 'Next demo', key: '→', primary: true, onPress: next }]);
      }
    }
    stop = true;
    S.caption('Any shape you can draw.', 'Topology is configuration.');
    S.stats([{ n: String(names.length + swarm.length), label: 'agents' }, { n: '5', label: 'topologies' }, { n: '0', label: 'rewrites' }]);
  }

  // ------------------------------------------------------------------ 4. a pipeline across machines
  const PROGRAM = [
    'const issues = [{ id: "#318" }, { id: "#322" }, { id: "#327" }]',
    '',
    'async function review(model) {',
    '  const r = await spawn(model)',
    '  return await ask(r, { name: "verdict",',
    '    schema: { ok: "boolean" } })',
    '}',
    '',
    'async function lane(issue) {',
    '  const t = await spawn("triager")',
    '  const tri = await ask(t, { name: "triage",',
    '    schema: { label: "string" } })',
    '  if (tri.label !== "confirmed") return tri',
    '',
    '  const fixer = await spawn("fixer", { worktree: issue.id })',
    '  await ask(fixer, { name: "fix", schema: { pr: "string" } })',
    '  for (let round = 0; round < 3; round++) {',
    '    const v = await parallel({',
    '      gpt: () => review("reviewer-gpt"),',
    '      gemini: () => review("reviewer-gemini"),',
    '    })',
    '    if (v.gpt.ok && v.gemini.ok)',
    '      return await turn(fixer, { name: "merge" })',
    '    await ask(fixer, { name: "fix", schema: { pr: "string" } })',
    '  }',
    '}',
    '',
    'await fanOut(issues, lane, { name: "lanes" })',
  ];
  const L = { fan: 27, rSpawn: 3, rAsk: 4, tSpawn: 9, tAsk: 10, tRet: 12, fSpawn: 14, fAsk: 15, par: 17, ok: 21, merge: 22, refix: 23 };
  async function lang(S, run, { sfx }) {
    const M = S.mesh;
    const MACH = { laptop: 0.17, server: 0.5, cloud: 0.83 }, ROW = 0.47, BASE = 0.84;
    const slots = { laptop: [null, null, null], server: [null, null, null], cloud: [null, null, null] }, hostOf = {};
    let home = 'laptop';
    S.code(PROGRAM);
    for (const [m, x] of Object.entries(MACH)) M.add({ id: m, kind: 'channel', color: 'sys', label: m, x, y: BASE, size: 0.9 });
    M.add({ id: 'run', kind: 'channel', color: 'gold', label: 'run', x: 0.5, y: 0.13, size: 1 }); M.link('run', home);
    S.host(true, 'run on laptop');
    const seat = (id, label, vendor, host) => {
      const k = slots[host].indexOf(null); slots[host][k] = id; hostOf[id] = host;
      M.add({ id, label, vendor, x: MACH[host] + (k - 1) * 0.1, y: ROW, from: { x: MACH[host], y: BASE } }); M.link(id, host);
    };
    const unseat = (id) => { const s = slots[hostOf[id]]; s[s.indexOf(id)] = null; M.remove(id); };
    const lane = (id) => '/fanOut:lanes#0/b:' + id + '/';
    const J = (scope, key, note) => S.journal({ key, scope, status: 'pending', note });
    const ok = (scope, key, note) => S.journalSet(scope + key, 'ok', note);
    const work = async (id, ms) => { M.status(id, 'working'); await M.pulse('run', id, 'gold', { dur: 520 }); await run.sleep(ms); await M.pulse(id, 'run', 'gold', { dur: 520 }); M.status(id, 'idle'); };

    S.caption('Your issue backlog, as a program.', 'Three machines share one mesh.');
    await run.press(S, [{ id: 'go', label: 'Run on the backlog', key: 'Space', primary: true }], { autoAfter: 2600 });

    // phase 1 · triage
    S.hl(L.fan); J('/', 'fanOut:lanes#0', '3 issues');
    S.caption('Phase 1 · triage', 'One agent per issue. It labels the issue on GitHub.', { cls: 'gold', text: 'fanOut' });
    await run.sleep(400);
    S.hl(L.tSpawn);
    const TRI = [['tA', '#318', 'laptop', 'confirmed', 'green'], ['tB', '#322', 'server', 'confirmed', 'green'], ['tC', '#327', 'cloud', 'duplicate', 'sys']];
    TRI.forEach(([id, iss, host], i) => { seat(id, 'triage', 'opencode', host); J(lane(iss), 'ask:triage#0'); });
    await run.sleep(450); S.hl(L.tAsk);
    await Promise.all(TRI.map(async ([id, iss, , label, col], i) => { await run.sleep(i * 260); await work(id, 1100 + i * 250); M.badge(id, label, col); ok(lane(iss), 'ask:triage#0', label); }));
    S.codeDone(L.tSpawn); S.codeDone(L.tAsk); S.hl(L.tRet);
    S.caption('#327 is a duplicate.', 'Its lane ends there. The other two go on.');
    await run.sleep(1100);
    for (const [id] of TRI) unseat(id);

    // phase 2 · fix
    S.hl(L.fSpawn); S.codeDone(L.tRet);
    S.caption('Phase 2 · fix', 'A fixer per confirmed issue reproduces it and opens a PR.');
    seat('fA', 'fixer', 'claude', 'cloud'); seat('fB', 'fixer', 'claude', 'server');
    J(lane('#318'), 'ask:fix#0'); J(lane('#322'), 'ask:fix#0');
    await run.sleep(400); S.hl(L.fAsk); S.codeDone(L.fSpawn);
    await Promise.all([work('fA', 1700).then(() => { M.badge('fA', 'PR #412'); ok(lane('#318'), 'ask:fix#0', 'PR #412'); }),
      run.sleep(300).then(() => work('fB', 1600)).then(() => { M.badge('fB', 'PR #413'); ok(lane('#322'), 'ask:fix#0', 'PR #413'); })]);
    S.codeDone(L.fAsk);

    // phase 3 · review, two model families per PR
    S.hl(L.par);
    S.caption('Phase 3 · review', 'Two reviewers per PR, from two model families.', { cls: 'chat', text: 'parallel' });
    const REV = [['gA', 'gpt', 'codex', 'server', '#318', 'gpt'], ['mA', 'gemini', null, 'laptop', '#318', 'gemini'], ['gB', 'gpt', 'codex', 'cloud', '#322', 'gpt'], ['mB', 'gemini', null, 'laptop', '#322', 'gemini']];
    for (const [id, label, vendor, host, iss, b] of REV) { seat(id, label, vendor, host); J(lane(iss) + 'b:' + b + '/', 'ask:verdict#0'); }
    await run.sleep(400); S.hl(L.rAsk);
    const verdict = (id, iss, b, pass, ms) => work(id, ms).then(() => { M.badge(id, pass ? 'APPROVE' : 'BLOCK', pass ? 'green' : 'red'); S.journalSet(lane(iss) + 'b:' + b + '/ask:verdict#0', pass ? 'ok' : 'dead', pass ? 'approve' : 'block'); });
    await Promise.all([verdict('gA', '#318', 'gpt', false, 1500), verdict('mA', '#318', 'gemini', true, 1200), verdict('gB', '#322', 'gpt', true, 1300), verdict('mB', '#322', 'gemini', true, 1700)]);
    S.codeDone(L.rSpawn); S.codeDone(L.rAsk);

    // #322 merges; #318 goes back to its fixer
    S.hl(L.merge); J(lane('#322'), 'turn:merge#0');
    S.caption('One PR is blocked.', 'The findings go back to the fixer for another round.', { cls: 'red', text: 'block' });
    swallow(work('fB', 700).then(() => { M.badge('fB', 'merged', 'green'); ok(lane('#322'), 'turn:merge#0', 'PR #413 merged'); }));
    await run.sleep(500); for (const id of ['gB', 'mB', 'mA']) unseat(id);
    S.hl(L.refix); J(lane('#318'), 'ask:fix#1');
    await M.pulse('gA', 'fA', 'dm'); unseat('gA');
    await work('fA', 1200); M.badge('fA', 'PR #412 · v2'); ok(lane('#318'), 'ask:fix#1', 'PR #412 v2'); S.codeDone(L.refix);

    // round 2, then pull the plug on the laptop mid-review
    S.hl(L.par);
    seat('gA2', 'gpt', 'codex', 'server'); seat('mA2', 'gemini', null, 'laptop');
    const S318 = lane('#318') + 'parallel#1/';
    J(S318 + 'b:gpt/', 'ask:verdict#1'); J(S318 + 'b:gemini/', 'ask:verdict#1');
    M.status('gA2', 'working'); M.status('mA2', 'working');
    swallow(M.pulse('run', 'gA2', 'gold')); swallow(M.pulse('run', 'mA2', 'gold', { delay: 150 }));
    S.caption('Now unplug the laptop.', 'It runs the workflow and one of the reviewers.', { cls: 'red', text: 'crash test' });
    const killed = run.press(S, [{ id: 'kill', label: 'Unplug the laptop', key: 'Space', cls: 'danger' }], { autoAfter: 2600 });
    (async () => { try { await run.sleep(1300); await M.pulse('gA2', 'run', 'gold'); M.status('gA2', 'idle'); M.badge('gA2', 'APPROVE', 'green'); S.journalSet(S318 + 'b:gpt/ask:verdict#1', 'ok', 'approve'); } catch { /* cancelled */ } })();
    await killed;

    sfx.bad(); M.recolor('laptop', 'red'); M.recolor('run', 'sys'); M.status('mA2', 'offline'); M.badge('mA2', null);
    S.host(false, 'laptop down'); S.journalFreeze(true); S.hl(-1);
    S.journalSet(S318 + 'b:gemini/ask:verdict#1', 'dead', 'seat lost');
    S.caption('The laptop is gone, and the run with it.', 'Any other machine can pick it up.', { cls: 'red', text: 'machine down' });
    await run.sleep(600);
    await run.press(S, [{ id: 'resume', label: 'Resume on the server', key: 'Space', primary: true }], { autoAfter: 2600 });

    // resume: the journal replays, only the lost step runs again
    unseat('mA2'); M.unlink('run', 'laptop'); M.link('run', 'server'); M.recolor('run', 'gold'); home = 'server';
    S.host(true, 'run on server'); S.journalFreeze(false); S.codeReset();
    S.caption('Resume replays the journal.', 'Finished steps return instantly. No agent is asked twice.', { cls: 'chat', text: 'replay' });
    for (const line of [L.fan, L.tSpawn, L.tAsk, L.fSpawn, L.fAsk, L.rSpawn, L.rAsk, L.refix]) { S.hl(line, 'replay'); sfx.kind('chat'); await run.sleep(230); S.codeDone(line); }
    for (const r of S.root.querySelectorAll('.jr.ok')) r.classList.replace('ok', 'replayed');
    S.hl(L.rSpawn); seat('mA3', 'gemini', null, 'cloud'); J(S318 + 'b:gemini/', 'spawn:reviewer-gemini#2', 'on cloud');
    S.caption('The lost reviewer comes back on another machine.', '');
    await run.sleep(500); ok(S318 + 'b:gemini/', 'spawn:reviewer-gemini#2', 'on cloud'); S.hl(L.rAsk);
    await work('mA3', 1300); M.badge('mA3', 'APPROVE', 'green'); S.journalSet(S318 + 'b:gemini/ask:verdict#1', 'ok', 'approve');

    // merge
    S.hl(L.merge); J(lane('#318'), 'turn:merge#0');
    await run.sleep(300); unseat('mA3'); unseat('gA2');
    await work('fA', 800); M.badge('fA', 'merged', 'green'); ok(lane('#318'), 'turn:merge#0', 'PR #412 merged');
    S.codeDone(L.par); S.codeDone(L.merge); S.codeDone(L.fan); S.hl(-1);
    S.journal({ key: 'fanOut:lanes', scope: '/', status: 'ok', note: '2 merged · 1 duplicate' }); sfx.ok(); M.ring('run', '#e9c46a');
    S.caption('Two PRs merged. One duplicate closed.', 'One machine lost, no work lost.');
    S.stats([{ n: '3', label: 'machines' }, { n: '2', label: 'PRs merged' }, { n: '0', label: 'lost work' }]);
  }

  window.DEMOS = [
    { id: 'team', layout: 'team', secs: 30, title: 'A team ships a feature', hook: 'Five agents from four vendors coordinate as peers. No orchestrator.', tags: [{ text: 'presence' }, { text: 'multicast', cls: 'chat' }, { text: 'unicast', cls: 'dm' }, { text: 'anycast', cls: 'any' }, { text: 'late join', cls: 'gold' }], run: team },
    { id: 'modes', layout: 'modes', secs: 30, title: 'Three ways to send', hook: 'To a channel, to one peer, or to a role.', tags: [{ text: 'multicast', cls: 'chat' }, { text: 'unicast', cls: 'dm' }, { text: 'anycast', cls: 'any' }, { text: 'durable inbox' }], run: modes },
    { id: 'topo', layout: 'topo', secs: 35, title: 'Any topology', hook: 'The same agents re-wired live into any shape, nested trees included.', tags: [{ text: 'topology' }, { text: 'scale', cls: 'any' }, { text: 'local-first' }], run: topo },
    { id: 'lang', layout: 'lang', secs: 40, title: 'A pipeline across machines', hook: 'Triage, fix and review a GitHub backlog. Then unplug a machine.', tags: [{ text: 'cotal lang', cls: 'gold' }, { text: 'fanOut', cls: 'gold' }, { text: 'journal' }, { text: 'resume' }], run: lang },
  ];
})();

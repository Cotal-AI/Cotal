// Pass checks for the tool-text rehearsal, one per scenario in scenarios.json (#5625).
//
// Each check reads one run's record, which rehearse.mjs builds from what the mesh and the seats
// kept: alice's tool calls from her own transcript, the posts and DMs from `cotal history`, the
// seats alice started and the roster at the end. A check names what it saw, so a reader can tell a
// pass from a lucky one.

const isPattern = (c) => typeof c === "string" && /[*>]/.test(c);
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const okCalls = (r, tool) => r.calls.filter((c) => c.tool === tool && c.ok);
const allCalls = (r, tool) => r.calls.filter((c) => c.tool === tool);
const alicePosts = (r) => r.posts.filter((p) => p.from === r.alice);
const aliceDms = (r) => r.dms.filter((d) => d.from === r.alice);
const check = (name, ok, detail) => ({ check: name, ok: Boolean(ok), detail });

/** The channels a seat alice started was put on: the join she passed, plus what its persona lists. */
function helperChannels(r, spawn) {
  const persona = r.personas.find((p) => p.name === spawn.args?.name);
  return new Set([...list(spawn.args?.join), ...list(persona?.subscribe)]);
}

const checks = {
  "get-help"(r) {
    const reviewPosts = alicePosts(r).filter((p) => p.channel.startsWith("review."));
    const channels = new Set(reviewPosts.map((p) => p.channel));
    const spawns = okCalls(r, "cotal_spawn");
    const joined = spawns.filter((s) => [...helperChannels(r, s)].some((c) => channels.has(c)));
    const helperIds = new Set(r.spawned.map((s) => s.id));
    const briefDms = aliceDms(r).filter((d) => helperIds.has(d.to));
    const left = r.spawned.filter((s) => !r.presentAtEnd.includes(s.name));
    return [
      check("a review channel carries alice's post", channels.size > 0, [...channels]),
      check("a helper is spawned onto that channel", joined.length > 0, spawns.map((s) => ({ name: s.args?.name, join: s.args?.join }))),
      check("the brief is not DMed to the helper", briefDms.length === 0, briefDms.map((d) => d.text.slice(0, 120))),
      check("every helper is gone at the end", r.spawned.length > 0 && left.length === r.spawned.length, { spawned: r.spawned.map((s) => s.name), presentAtEnd: r.presentAtEnd }),
    ];
  },
  share(r) {
    return [
      check("alice posts on a channel", alicePosts(r).length > 0, alicePosts(r).map((p) => `#${p.channel}`)),
      check("alice sends no DM", aliceDms(r).length === 0, aliceDms(r).map((d) => d.text.slice(0, 120))),
    ];
  },
  private(r) {
    return [
      check("alice DMs bob", aliceDms(r).some((d) => d.to === r.ids.bob), aliceDms(r).map((d) => d.toName ?? d.to)),
      check("alice posts on no channel", alicePosts(r).length === 0, alicePosts(r).map((p) => `#${p.channel}`)),
    ];
  },
  "role-pool"(r) {
    const asks = okCalls(r, "cotal_anycast").filter((c) => c.args?.role === "review-frontend");
    return [
      check("alice anycasts to review-frontend", asks.length > 0, allCalls(r, "cotal_anycast").map((c) => c.args?.role)),
      check("the request names #review.checkout", asks.some((c) => String(c.args?.text ?? "").includes("review.checkout")), asks.map((c) => String(c.args?.text ?? "").slice(0, 160))),
      check("alice spawns no one", okCalls(r, "cotal_spawn").length === 0, okCalls(r, "cotal_spawn").map((c) => c.args?.name)),
    ];
  },
  "no-pool"(r) {
    const mentioned = alicePosts(r).some((p) => p.mentions.length > 0);
    const reached = mentioned || aliceDms(r).length > 0 || okCalls(r, "cotal_spawn").length > 0;
    return [
      check("alice sends no anycast", allCalls(r, "cotal_anycast").length === 0, allCalls(r, "cotal_anycast").map((c) => c.args?.role)),
      check("alice reaches someone by mention, DM or spawn", reached, { mentioned, dms: aliceDms(r).length, spawns: okCalls(r, "cotal_spawn").map((c) => c.args?.name) }),
    ];
  },
  family(r) {
    const tried = allCalls(r, "cotal_send").filter((c) => isPattern(c.args?.channel));
    const on = new Set(alicePosts(r).map((p) => p.channel));
    const reached = on.has("review.announce") || (on.has("review.a") && on.has("review.b"));
    return [
      check("no pattern send went out", okCalls(r, "cotal_send").every((c) => !isPattern(c.args?.channel)), tried.map((c) => ({ channel: c.args?.channel, ok: c.ok }))),
      check("the notice reaches review.announce or every review channel", reached, [...on]),
    ];
  },
  "one-job"(r) {
    const spawns = okCalls(r, "cotal_spawn");
    const told = spawns.filter((s) => s.args?.once === true || /despawn|cotal_despawn/i.test(String(s.args?.prompt ?? "")));
    const left = r.spawned.filter((s) => !r.presentAtEnd.includes(s.name));
    return [
      check("the helper is told to stop (once, or despawn itself)", told.length > 0, spawns.map((s) => ({ name: s.args?.name, once: s.args?.once, prompt: String(s.args?.prompt ?? "").slice(0, 200) }))),
      check("the helper leaves the roster", r.spawned.length > 0 && left.length === r.spawned.length, { spawned: r.spawned.map((s) => s.name), presentAtEnd: r.presentAtEnd }),
    ];
  },
  scope(r) {
    const allowed = (c) => c === "bugs.checkout";
    const saved = okCalls(r, "cotal_persona").filter((c) => {
      const fields = ["subscribe", "allowSubscribe", "allowPublish"].map((k) => c.args?.[k]).filter((v) => v !== undefined);
      return fields.length > 0 && fields.every((v) => list(v).every(allowed)) && fields.some((v) => list(v).length > 0);
    });
    const savedNames = new Set(saved.map((c) => c.args?.name));
    const spawns = okCalls(r, "cotal_spawn");
    return [
      check("a persona limited to bugs.checkout is saved", saved.length > 0, allCalls(r, "cotal_persona").map((c) => ({ name: c.args?.name, subscribe: c.args?.subscribe, allowSubscribe: c.args?.allowSubscribe, allowPublish: c.args?.allowPublish, ok: c.ok }))),
      check("that persona is spawned by name", spawns.some((s) => savedNames.has(s.args?.name)), spawns.map((s) => s.args?.name)),
      check("nothing is spawned on alice's own permissions", spawns.every((s) => savedNames.has(s.args?.name)), spawns.map((s) => s.args?.name)),
    ];
  },
};

/** Grade one run. `record` is the normalized record rehearse.mjs writes as record.json. */
export function grade(scenario, record) {
  const run = checks[scenario];
  if (!run) throw new Error(`grade: no pass check for scenario "${scenario}"`);
  const results = run(record);
  return { scenario, pass: results.every((c) => c.ok), checks: results };
}

/** Counts per run, as #5625 asks the report to give them. */
export function counts(record) {
  const by = (xs, key) => xs.reduce((m, x) => ({ ...m, [x[key]]: (m[x[key]] ?? 0) + 1 }), {});
  return {
    alicePosts: by(alicePosts(record), "channel"),
    aliceDms: aliceDms(record).length,
    anycasts: allCalls(record, "cotal_anycast").length,
    spawns: okCalls(record, "cotal_spawn").length,
    despawns: okCalls(record, "cotal_despawn").length,
    personasSaved: okCalls(record, "cotal_persona").length,
    refusedCalls: record.calls.filter((c) => !c.ok).map((c) => c.tool),
  };
}

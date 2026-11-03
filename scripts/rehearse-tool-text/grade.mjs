// Pass checks for the tool-text rehearsal, one per scenario in scenarios.json (#5625).
//
// Each check reads one run's record: alice's tool calls in the order she made them, from her own
// transcript; the posts and DMs from `cotal history`; the seats alice started; the roster at the end;
// the personas on disk; and how the manager says each seat ended. loadRecord() builds the record from
// the files a run leaves, so a run can be graded again later from what it kept. A check names what
// it saw, so a reader can tell a pass from a lucky one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const isPattern = (c) => typeof c === "string" && /[*>]/.test(c);
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);
const okCalls = (r, tool) => r.calls.filter((c) => c.tool === tool && c.ok);
const allCalls = (r, tool) => r.calls.filter((c) => c.tool === tool);
const alicePosts = (r) => r.posts.filter((p) => p.from === r.alice);
const aliceDms = (r) => r.dms.filter((d) => d.from === r.alice);
const check = (name, ok, detail) => ({ check: name, ok: Boolean(ok), detail });
const time = (t) => (typeof t === "number" ? t : Date.parse(t));
const launchFailed = (r, seat) => r.reaps.some((x) => x.id === seat.id && /launch-failed/.test(x.reason));

/** A seat counts as stopped only when the manager says it stopped itself, ended its once task, or
 *  was stopped at alice's request. A crash or a failed launch is not a stop. */
function stopped(r, seat) {
  return r.reaps.some((x) => x.id === seat.id && (
    /it stopped itself/.test(x.reason) ||
    (/its once task ended/.test(x.reason) && !/launch-failed/.test(x.reason)) ||
    (r.alice && x.reason.includes(`stopped it at local.${r.alice}`))
  ));
}

/** Every helper alice started is gone from a roster that was read, and the manager says it
 *  stopped. A seat the manager stopped because its launch failed was never a working helper. */
function helpersStopped(r) {
  const helpers = r.spawned.filter((s) => !launchFailed(r, s));
  return helpers.length > 0 && r.finalPsOk && helpers.every((s) => !r.presentAtEnd.includes(s.name) && stopped(r, s));
}

/** The channels a seat alice started was put on: the join she passed, plus what its persona lists. */
function helperChannels(r, spawn) {
  const persona = r.personas.find((p) => p.name === spawn.args?.name);
  return new Set([...list(spawn.args?.join), ...list(persona?.subscribe)]);
}

/** A prompt that tells the helper to stop itself: it asks for a despawn or a self-stop with no
 *  negation before it in the same clause. A negation reaches across commas, so "do not despawn
 *  yourself, or call cotal_despawn" does not count. A clause ends at a semicolon, at "then" or "but",
 *  and at the comma closing a leading condition, so "if you are not needed, despawn yourself" does. */
const NEGATION = /\b(?:not|don't|never|no need to|avoid)\b/i;
const CONDITION = /^\s*(?:if|when|whenever|once|after|before|as soon as|while|until)\b/i;
const clauses = (sentence) => sentence.split(/;|\b(?:then|but)\b/i).flatMap((c) => {
  const comma = c.indexOf(",");
  return CONDITION.test(c) && comma >= 0 ? [c.slice(0, comma), c.slice(comma + 1)] : [c];
});
const toldToStop = (prompt) =>
  prompt.split(/(?<=[.!?])\s+/).flatMap(clauses)
    .some((clause) => [...clause.matchAll(/\b(?:cotal_despawn|despawn|stop yourself)\b/gi)].some((m) => !NEGATION.test(clause.slice(0, m.index))));

const checks = {
  "get-help"(r) {
    const spawns = okCalls(r, "cotal_spawn");
    const helperIds = new Set(r.spawned.map((s) => s.id));
    // The brief: alice's post naming the PR, on a channel a helper was put on, after which, and only
    // after which, a helper started on PR 812. Its start is its first tool call outside Cotal that names
    // 812, such as reading PR-812.md, or a post or DM of its own that names 812; a run with no such
    // start has no brief. The post must also come before the helper said anything at all or stopped.
    const said = (id) => [...r.posts, ...r.dms].filter((m) => m.from === id).map((m) => time(m.ts));
    const stoppedAt = (id) => r.reaps.filter((x) => x.id === id).map((x) => (x.at === undefined ? -Infinity : time(x.at)));
    const started = Math.min(
      ...(r.toolUses ?? []).filter((u) => !u.cotal && /\b812\b/.test(u.input)).map((u) => time(u.at)),
      ...[...r.posts, ...r.dms].filter((m) => helperIds.has(m.from) && /\b812\b/.test(m.text)).map((m) => time(m.ts)),
    );
    const reached = (p, spawn) => Number.isFinite(started) && time(p.ts) < started && r.spawned.filter((h) => h.name === spawn.args?.name && !launchFailed(r, h))
      .some((h) => [...said(h.id), ...stoppedAt(h.id)].every((t) => time(p.ts) < t));
    const briefs = alicePosts(r).filter((p) => p.channel.startsWith("review.") && /\b812\b/.test(p.text) &&
      spawns.some((s) => helperChannels(r, s).has(p.channel) && reached(p, s)));
    const briefDms = aliceDms(r).filter((d) => helperIds.has(d.to));
    return [
      check("alice posts the brief on a review channel a helper is put on, before the helper starts on the PR", briefs.length > 0, { briefs: briefs.map((p) => ({ ts: p.ts, channel: p.channel, text: p.text.slice(0, 80) })), helperStarted: Number.isFinite(started) ? new Date(started).toISOString() : "never", posts: alicePosts(r).map((p) => ({ ts: p.ts, channel: p.channel, text: p.text.slice(0, 80) })), spawns: spawns.map((s) => ({ name: s.args?.name, join: s.args?.join })) }),
      check("the brief is not DMed to the helper", briefDms.length === 0, briefDms.map((d) => d.text.slice(0, 120))),
      check("every helper stops by the end", helpersStopped(r), { spawned: r.spawned.map((s) => s.name), presentAtEnd: r.presentAtEnd, finalPsOk: r.finalPsOk, reaps: r.reaps }),
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
    const told = spawns.filter((s) => s.args?.once === true || toldToStop(String(s.args?.prompt ?? "")));
    return [
      check("the helper is told to stop (once, or despawn itself)", told.length > 0, spawns.map((s) => ({ name: s.args?.name, once: s.args?.once, prompt: String(s.args?.prompt ?? "").slice(0, 200) }))),
      check("the helper stops and leaves the roster", helpersStopped(r), { spawned: r.spawned.map((s) => s.name), presentAtEnd: r.presentAtEnd, finalPsOk: r.finalPsOk, reaps: r.reaps }),
    ];
  },
  scope(r) {
    const only = (v) => list(v).every((c) => c === "bugs.checkout");
    // The persona as the manager saved it, not as the call spelled it: a prompt's own frontmatter
    // can add grants the call's arguments leave out. An empty allowSubscribe reads as subscribe.
    const limited = (name) => {
      const p = r.personas.find((x) => x.written && x.name === name);
      if (!p) return false;
      const read = list(p.allowSubscribe).length ? p.allowSubscribe : p.subscribe;
      return list(read).length > 0 && only(read) && only(p.subscribe) && only(p.allowPublish);
    };
    // The persona a helper launched with is the file as it stands only when no save of that name came
    // after the spawn, and, where the run recorded file times, the file was last written before the seat
    // started.
    const saves = (name) => r.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.tool === "cotal_persona" && c.ok && c.args?.name === name).map(({ i }) => i);
    const unchangedSince = (name) => {
      const file = r.personas.find((x) => x.written && x.name === name);
      if (file?.mtimeMs === undefined) return true;
      const seats = r.spawned.filter((s) => s.name === name && !launchFailed(r, s));
      return seats.length > 0 && seats.every((s) => s.startedAt !== undefined && file.mtimeMs <= s.startedAt);
    };
    const spawns = r.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.tool === "cotal_spawn" && c.ok);
    const scoped = ({ c, i }) => {
      const at = saves(c.args?.name);
      return at.some((j) => j < i) && !at.some((j) => j > i) && limited(c.args?.name) && unchangedSince(c.args?.name);
    };
    const savedNames = [...new Set(r.calls.filter((c) => c.tool === "cotal_persona" && c.ok).map((c) => c.args?.name))];
    return [
      check("a persona limited to bugs.checkout is saved", savedNames.some(limited), r.personas.filter((p) => p.written).map((p) => ({ name: p.name, subscribe: p.subscribe, allowSubscribe: p.allowSubscribe, allowPublish: p.allowPublish }))),
      check("that persona is spawned by name after it is saved, and not redefined after", spawns.some(scoped), spawns.map(({ c, i }) => ({ name: c.args?.name, at: i, savedAt: saves(c.args?.name) }))),
      check("nothing is spawned on alice's own permissions", spawns.every(scoped), spawns.map(({ c }) => c.args?.name)),
    ];
  },
};

/** The YAML frontmatter fields a persona check reads: scalars, flow lists and block lists. */
export function frontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---/.exec(src);
  const out = {};
  let key;
  for (const line of (m?.[1] ?? "").split("\n")) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && key) { out[key] = [...list(out[key]), item[1].trim().replace(/^["']|["']$/g, "")]; continue; }
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    out[key] = v.startsWith("[") ? v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
      : v === "" ? [] : v.replace(/^["']|["']$/g, "");
  }
  return out;
}

/** How the manager says each seat ended, from its `seat reaped:` log lines. */
export function reapsFrom(log) {
  return log.split("\n").map((l) => /^(\S+) seat reaped: (\S+) \((\w+), [^)]*\) - (.*)$/.exec(l)).filter(Boolean)
    .map(([, at, name, id, reason]) => ({ at, name, id, reason }));
}

/** The record a check reads, built from a run directory rehearse.mjs wrote. A run recorded before
 *  `finalPsOk` existed takes it from the status of its last `cotal ps`. */
export function loadRecord(dir) {
  const r = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
  const log = existsSync(join(dir, "manager.log")) ? readFileSync(join(dir, "manager.log"), "utf8") : "";
  const pdir = join(dir, "personas");
  const written = new Set(r.personasWritten ?? (r.personas ?? []).filter((p) => p.written).map((p) => p.file));
  const personas = existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith(".md"))
    .map((f) => ({ file: f, written: written.has(f), mtimeMs: r.personaTimes?.[f], ...frontmatter(readFileSync(join(pdir, f), "utf8")) })) : [];
  let finalPsOk = r.finalPsOk;
  if (finalPsOk === undefined && existsSync(join(dir, "cli.json"))) {
    const ps = JSON.parse(readFileSync(join(dir, "cli.json"), "utf8")).filter((x) => x.argv[0] === "ps");
    finalPsOk = ps.length > 0 && ps.at(-1).status === 0;
  }
  return { ...r, personas, reaps: reapsFrom(log), finalPsOk: Boolean(finalPsOk) };
}

/** Grade one run's record. */
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

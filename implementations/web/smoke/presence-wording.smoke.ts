/** Browser presence wording must agree with core's public helpers, including unchecked stamps. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatAge, presenceAges, presenceText, type Presence } from "@cotal-ai/core";

type Wording = {status:string; activity:string; activityAge:string; heartbeat:string};
interface BrowserPresence {
  formatAge: typeof formatAge;
  presenceAges: typeof presenceAges;
  heartbeatAge(ts: number, now: number): string | undefined;
  describe(peer: Partial<Presence>, now: number): Wording;
}
const win: {COTAL_PRESENCE?:BrowserPresence} = {};
new Function("window", readFileSync(new URL("../src/web/presence.js", import.meta.url), "utf8"))(win);
assert.ok(win.COTAL_PRESENCE);
const helper = win.COTAL_PRESENCE;
const now = 2_000_000_000;
for (const ms of [0, 999, 1000, 44_999, 45_000, 59_999, 60_000, 89_999, 90_000, 3_599_999, 3_600_000, 86_399_999, 86_400_000, 172_800_000]) {
  assert.equal(helper.formatAge(ms), formatAge(ms), `browser age agrees with core at ${ms}ms`);
}
for (const stamp of [undefined, null, "1000", NaN, Infinity, -Infinity, now + 1000, now - 90_000, 0]) {
  const peer = {status:"waiting",activity:"Review pending",statusSince:stamp,activitySince:stamp,activeAt:stamp,condition:{code:"rate_limit",since:stamp}} as unknown as Presence;
  assert.deepEqual(helper.presenceAges(peer, now), presenceAges(peer, now), `browser presence ages agree with core for ${String(stamp)}`);
}
const peer: Partial<Presence> = {status:"waiting", activity:"Approve the migration", condition:{code:"rate_limit",since:now - 2_400_000}, statusSince:now - 120_000, activitySince:now - 3_600_000, activeAt:now - 90_000, ts:now - 5000};
assert.deepEqual(helper.describe(peer, now), {
  status:"waiting (rate_limit for 40m) · unchanged for 2m · active 1m ago",
  activity:"Approve the migration (set 1h ago)", activityAge:"set 1h ago", heartbeat:"heartbeat 5s ago",
}, "presence wording dates condition, status, activity, progress and heartbeat separately");
assert.equal(helper.describe({...peer, activity:""}, now).activityAge, "", "a cleared activity has no activity age");
assert.equal(helper.describe({status:"idle"}, now).status, "idle", "missing timestamps do not invent durations");
assert.equal(helper.describe({status:"waiting",condition:{code:"auth"}},now).status, "waiting (auth)", "a condition without its timestamp has no invented duration");
assert.equal(helper.describe({...peer,condition:undefined},now).status.includes("rate_limit"), false, "cleared conditions disappear");
assert.equal(helper.heartbeatAge(now + 1000,now), "0s", "clock skew does not create negative heartbeat ages");
assert.equal(helper.heartbeatAge(NaN,now), undefined, "invalid heartbeat does not create a fabricated age");
for (const text of ["line\nnext\u202e", "🙂".repeat(201), "x".repeat(198)+"\n"+"tail", "<img src=x onerror=alert(1)>"]) {
  const untrusted = {status:"waiting",activity:text,condition:{code:text}} as unknown as Presence;
  const wording = helper.describe(untrusted,now);
  assert.equal(wording.status, `waiting (${presenceText(text)})`, "condition text follows core's bounded single-line wording");
  assert.equal(wording.activity, presenceText(text), "activity text follows core's bounded single-line wording");
}
assert.match(helper.describe({status:"working",progress:{kind:"unknown"}} as unknown as Presence,now).status, /working · progress unknown/, "working presence wording names unknown progress");
for (const [page, consumer] of [["../ui/pages/index.astro","app.js"],["../src/web/graph.html","graph.js"]]) {
  const html = readFileSync(new URL(page!,import.meta.url),"utf8");
  assert.ok(html.indexOf('src="/presence.js"') >= 0 && html.indexOf('src="/presence.js"') < html.indexOf(`src="/${consumer}"`), "both pages load presence wording before their consumer");
}
console.log("Browser presence wording smoke passed: core parity, independent ages, missing/invalid stamps, clock skew and bounded text.");

/**
 * EVERY ROUTE THE DASHBOARD CALLS GOES THROUGH THE HTTP STATUS GATE.
 *
 * The server answers a failed route with a 500 whose body is `{"error": "..."}`, which is valid
 * JSON, and `fetch()` does not reject on a 500. So a route that reads its body without consulting
 * the status stores the refusal as data. `readJson` (lib/snapshot.ts) is the gate, and
 * `client/src/api/http.ts` is the one place the client makes a request, so this suite drives
 * `httpApi(fakeFetch)` for every one of its nine reads and writes: meta, roster, channels, activity,
 * dms, history, membership, deleteChannel and agentEvents. The two agent watches answer 204 with no
 * body, so section 6 holds them to that: a 204 is success and anything else throws.
 *
 * WHAT A CELL PROVES. The fake answers `{ ok: false, status: 500, json: { error: "boom" } }`. A
 * method that went through the gate rejects, and its message names the read and the server's own
 * error text. A method that read the body directly RESOLVES with `{ error: "boom" }`, which is the
 * wipe this guards. The positive cells run the same methods against a 200 and require the body
 * back, so a gate that refuses everything cannot pass the negative ones.
 *
 * Run: pnpm smoke:web-http-api
 */
import { httpApi } from "../client/src/api/http.js";

let cells = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

interface Call { url: string; init?: RequestInit }

/** A fetch that records each request and answers every one with `answer`. */
const fake = (answer: { ok: boolean; status: number; body?: unknown }) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: answer.ok,
      status: answer.status,
      json: async () => {
        if (answer.body === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return answer.body;
      },
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
};

const CHANNEL = "team.back end#1";
/** One entry per method: what it is called with, and the name its refusal carries. */
const METHODS: { id: string; what: string; run: (api: ReturnType<typeof httpApi>) => Promise<unknown> }[] = [
  { id: "meta", what: "space", run: (a) => a.meta() },
  { id: "roster", what: "peers", run: (a) => a.roster() },
  { id: "channels", what: "channels", run: (a) => a.channels() },
  { id: "activity", what: "activity", run: (a) => a.activity(200) },
  { id: "dms", what: "direct messages", run: (a) => a.dms(500) },
  { id: "history", what: `#${CHANNEL} history`, run: (a) => a.history(CHANNEL, 200) },
  { id: "membership", what: "membership", run: (a) => a.membership() },
  { id: "deleteChannel", what: `delete #${CHANNEL}`, run: (a) => a.deleteChannel(CHANNEL) },
  { id: "agentEvents", what: "local.abc events", run: (a) => a.agentEvents("local.abc", 200) },
];

/** What one call did: it rejected with `error`, or it resolved with `value`. Kept apart on purpose,
 *  because a refusal handed back as data is a RESOLVED call and must never read as a rejection. */
type Outcome = { rejected: true; error: Error } | { rejected: false; value: unknown };
const settle = async (run: () => Promise<unknown>): Promise<Outcome> => {
  try { return { rejected: false, value: await run() }; } catch (e) { return { rejected: true, error: e as Error }; }
};
const messageOf = (o: Outcome): string => (o.rejected ? o.error.message : `RESOLVED with ${JSON.stringify(o.value)}`);

// ── 1. A REFUSAL IS NOT DATA, on every route ────────────────────────────────────────────────────
{
  let n = 0;
  for (const m of METHODS) {
    n++;
    const { fetchImpl } = fake({ ok: false, status: 500, body: { error: "boom" } });
    const outcome = await settle(() => m.run(httpApi(fetchImpl)));
    const message = messageOf(outcome);
    ok(`1.${n}a ${m.id} REJECTS a 500 rather than resolving with its body as data`, outcome.rejected, message);
    ok(`1.${n}b ${m.id} names the read it refused`, outcome.rejected && message.includes(m.what), message);
    ok(`1.${n}c ${m.id} carries the server's own error text and the status`,
      outcome.rejected && message.includes("boom") && message.includes("500"), message);
  }
}

// A refusal that is not JSON still refuses: the status is the fact that matters.
{
  let n = 0;
  for (const m of METHODS) {
    n++;
    const { fetchImpl } = fake({ ok: false, status: 503 });
    const outcome = await settle(() => m.run(httpApi(fetchImpl)));
    ok(`2.${n} ${m.id} REJECTS a 503 whose body is not JSON`, outcome.rejected && outcome.error.message.includes("503"), messageOf(outcome));
  }
}

// ── 3. CONTROL: a 200 is parsed and returned, so section 1 is not a gate that refuses everything ─
{
  let n = 0;
  for (const m of METHODS) {
    n++;
    const body = { marker: m.id };
    const { fetchImpl } = fake({ ok: true, status: 200, body });
    const got = await m.run(httpApi(fetchImpl));
    ok(`3.${n} CONTROL: ${m.id} returns the body of a 200`, JSON.stringify(got) === JSON.stringify(body), got);
  }
}

// ── 4. THE REQUESTS ─────────────────────────────────────────────────────────────────────────────
{
  const { calls, fetchImpl } = fake({ ok: true, status: 200, body: [] });
  const api = httpApi(fetchImpl);
  await api.meta();
  await api.roster();
  await api.channels();
  await api.activity(123);
  await api.dms(456);
  await api.membership();
  const urls = calls.map((c) => c.url);
  ok("4.1 the reads hit their own routes, with the limits the controller asked for",
    JSON.stringify(urls) === JSON.stringify([
      "/api/meta", "/api/roster", "/api/channels", "/api/activity?limit=123", "/api/dms?limit=456", "/api/membership",
    ]), urls);
  ok("4.2 and none of them is a write", calls.every((c) => c.init === undefined || c.init.method === undefined || c.init.method === "GET"), calls);
}
{
  const { calls, fetchImpl } = fake({ ok: true, status: 200, body: [] });
  await httpApi(fetchImpl).history(CHANNEL, 200);
  ok("4.3 history ENCODES the channel with encodeURIComponent, so a name with a slash, a space or a hash cannot change the route",
    calls[0]?.url === `/api/channels/${encodeURIComponent(CHANNEL)}/history?limit=200`, calls[0]?.url);
  ok("4.4 CONTROL: the encoding is not a no-op for this name, so 4.3 can tell it from none", encodeURIComponent(CHANNEL) !== CHANNEL);
}
{
  const { calls, fetchImpl } = fake({ ok: true, status: 200, body: { ok: true, channel: "x", purged: 3 } });
  await httpApi(fetchImpl).deleteChannel("x");
  const c = calls[0];
  const headers = new Headers(c?.init?.headers);
  ok("4.5 deleteChannel is a POST to /api/channel/delete", c?.url === "/api/channel/delete" && c?.init?.method === "POST", c);
  ok("4.6 it declares a JSON body", headers.get("content-type") === "application/json", [...headers]);
  ok("4.7 and the body is exactly {\"channel\":...}", c?.init?.body === JSON.stringify({ channel: "x" }), c?.init?.body);
}

// ── 5. THE DEFAULT FETCH is the page's own, looked up when a request is made ────────────────────
{
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return { ok: true, status: 200, json: async () => ({ space: "s", pid: 1 }) } as unknown as Response;
  }) as typeof fetch;
  try {
    const api = httpApi();
    globalThis.fetch = (async (url: string) => {
      seen.push(`late:${String(url)}`);
      return { ok: true, status: 200, json: async () => ({ space: "s", pid: 1 }) } as unknown as Response;
    }) as typeof fetch;
    await api.meta();
  } finally {
    globalThis.fetch = real;
  }
  ok("5.1 with no fetch passed, a request goes through the global fetch as it is when the request is made",
    seen.length === 1 && seen[0] === "late:/api/meta", seen);
}

// ── 6. ONE AGENT'S EVENT PLANE: the read and the two watches ────────────────────────────────────
/** An id that is not URL-safe, so a cell can tell an encoded path from a raw one. Real ids are
 *  `<owner>.<actor>`; the server refuses this one, which does not matter to the client's request. */
const AGENT = "own er/x.y#1";
const FEED = "f/1 2";
{
  const { calls, fetchImpl } = fake({ ok: true, status: 200, body: { frames: [], more: false } });
  await httpApi(fetchImpl).agentEvents(AGENT, 400);
  ok("6.1 agentEvents GETs /api/agents/<id>/events with the limit the controller asked for",
    calls[0]?.url === `/api/agents/${encodeURIComponent(AGENT)}/events?limit=400` && (calls[0]?.init === undefined || calls[0]?.init.method === undefined), calls[0]);
  ok("6.2 CONTROL: the encoding is not a no-op for this id, so 6.1 can tell it from none", encodeURIComponent(AGENT) !== AGENT);
}
{
  const refused = { refused: "Permissions Violation for Subscription to \"cotal.main.chat.local.abc.events.local.abc\"", grant: "cotal mint watcher --profile agent --allow-subscribe 'events.local.abc' --provision" };
  const { fetchImpl } = fake({ ok: true, status: 200, body: refused });
  const got = await settle(() => httpApi(fetchImpl).agentEvents("local.abc", 200));
  ok("6.3 a { refused } answer is passed through as data, with its grant", !got.rejected && JSON.stringify(got.value) === JSON.stringify(refused), messageOf(got));
}
for (const [n, route] of [[4, "watch"], [5, "unwatch"]] as const) {
  const { calls, fetchImpl } = fake({ ok: true, status: 204 });
  const got = await settle(() => httpApi(fetchImpl)[route](AGENT, FEED));
  const c = calls[0];
  ok(`6.${n}a ${route} is a POST to /api/agents/<id>/${route}?feed=<feed>, both encoded`,
    c?.url === `/api/agents/${encodeURIComponent(AGENT)}/${route}?feed=${encodeURIComponent(FEED)}` && c?.init?.method === "POST", c);
  ok(`6.${n}b ${route} sends no body`, c?.init?.body === undefined, c?.init);
  ok(`6.${n}c ${route} takes a 204 with no body as success`, !got.rejected && got.value === undefined, messageOf(got));
}
for (const route of ["watch", "unwatch"] as const) {
  const { fetchImpl } = fake({ ok: false, status: 400, body: { error: "unknown feed f-9" } });
  const got = await settle(() => httpApi(fetchImpl)[route]("local.abc", "f-9"));
  ok(`6.6 ${route}: a 400 throws naming the request and the server's text`,
    got.rejected && got.error.message.includes(`${route} local.abc`) && got.error.message.includes("unknown feed f-9") && got.error.message.includes("400"), messageOf(got));
}
for (const route of ["watch", "unwatch"] as const) {
  const { fetchImpl } = fake({ ok: true, status: 200, body: {} });
  const got = await settle(() => httpApi(fetchImpl)[route]("local.abc", "f-1"));
  ok(`6.7 ${route}: any answer but a 204 throws, a 200 included`, got.rejected && got.error.message.includes("200"), messageOf(got));
}

console.log(failed === 0 ? `web http api: ${cells} cells OK` : `web http api: ${failed}/${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);

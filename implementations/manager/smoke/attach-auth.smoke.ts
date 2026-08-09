/**
 * Console-endpoint reachability + credential smoke (no NATS, no test runner) — pnpm smoke:attach-auth
 *
 * The manager's HTTP face used to bind and advertise a hardcoded `127.0.0.1`. The bind address is
 * now an operator choice, which means the face can leave the box, which means everything on it that
 * describes the mesh — or MINTS a credential — must be credentialed.
 *
 * P2 item 6 removed the `ws://.../attach/` terminal transport from this face: the terminal rides a
 * mesh §13.6 session, so `cotal attach` reaches a manager on another machine through the BROKER and
 * there is no per-agent attach ticket left to bind. What remains here, and what this guards:
 *   - `attachHost` derives a bind/advertise address from a broker URL (and stays loopback when there
 *     is no mesh address to follow);
 *   - `/agents`, `/feed` and `POST /session/<name>` refuse an unauthenticated caller, accept the
 *     token by query/bearer (never a cookie), and reject a wrong-length AND a same-length-but-wrong
 *     token; the static shell stays open so the page can load and then present the credential;
 *   - `consoleUrl()` advertises the bound host, keeps the token in the fragment, and a wildcard bind
 *     advertises loopback;
 *   - an upgrade to this HTTP-only face is refused, never left hanging.
 */
import WebSocket from "ws";
import { AttachEndpoint, attachHost } from "../src/attach-endpoint.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond || extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

// --- attachHost: an address derived from the mesh ---------------------------------------------
check("attachHost: derives the broker's host", attachHost("nats://100.98.80.110:4222") === "100.98.80.110");
check("attachHost: loopback mesh stays loopback", attachHost("nats://127.0.0.1:4222") === "127.0.0.1");
check("attachHost: no mesh address → loopback", attachHost(undefined) === "127.0.0.1");
check("attachHost: takes the first of a server list", attachHost("nats://10.0.0.9:4222,nats://10.0.0.8:4222") === "10.0.0.9");
let threw = false;
try { attachHost("not-a-url"); } catch { threw = true; }
check("attachHost: an unparseable URL throws, never a silent bind", threw);
// URL.hostname hands back an IPv6 literal BRACKETED; listen() would treat that as a DNS name and
// fail ENOTFOUND, killing a manager whose broker URL is IPv6.
check("attachHost: strips IPv6 brackets for the bind address", attachHost("nats://[::1]:4222") === "::1");
check("attachHost: strips brackets for a full IPv6 literal", attachHost("nats://[2001:db8::1]:4222") === "2001:db8::1");
{
  const v6 = new AttachEndpoint(() => [], () => [], 0, undefined, attachHost("nats://[::1]:4222"), "d".repeat(64));
  let ok = false, why = "", advertised = "";
  try { await v6.start(); ok = true; advertised = v6.consoleUrl(); await v6.stop(); } catch (e) { why = (e as Error).message; }
  check("an IPv6 broker URL yields a bindable console host", ok, why);
  check("...and advertises it re-bracketed", ok && advertised.startsWith("http://[::1]:"), ok ? advertised : why);
}

// --- the live endpoint ------------------------------------------------------------------------
const TOKEN = "a".repeat(64);
const minted: string[] = [];
const ep = new AttachEndpoint(
  () => [{ name: "x" }],
  () => [],
  0,
  async (name) => { minted.push(name); return { grant: { sessionId: `sess-${name}` }, wsUrl: "ws://127.0.0.1:14999", creds: "CREDS" }; },
  "127.0.0.1",
  TOKEN,
);
await ep.start();
const base = new URL(ep.consoleUrl()).origin;

const get = async (path: string, init?: RequestInit): Promise<Response> => fetch(`${base}${path}`, init);

try {
  // Data routes are credentialed; the static console shell is not (it describes no agent).
  for (const p of ["/agents", "/feed"])
    check(`unauthenticated GET ${p} → 401`, (await get(p)).status === 401);
  for (const p of ["/", "/app.js"])
    check(`static shell GET ${p} is served without a credential`, (await get(p)).status === 200);

  // The mint route is the most sensitive thing on this face: it hands the browser a real §13.6
  // grant plus a per-session caller credential. It must never answer an uncredentialed caller, and
  // the refusal must land BEFORE the establisher runs (no offer burned, no credential minted).
  check("unauthenticated POST /session/<name> → 401", (await get("/session/x", { method: "POST" })).status === 401);
  check("...and the session establisher was never reached", minted.length === 0, minted);

  // Wrong tokens are refused, including one of the right length (so the check is not length-only).
  check("wrong-length token → 401", (await get("/agents?t=nope")).status === 401);
  check("same-length wrong token → 401", (await get(`/agents?t=${"b".repeat(64)}`)).status === 401);
  check("same-length wrong token on the mint route → 401", (await get(`/session/x?t=${"b".repeat(64)}`, { method: "POST" })).status === 401);
  check("...still no establisher call", minted.length === 0, minted);

  // Each accepted credential channel.
  check("token by query → 200", (await get(`/agents?t=${TOKEN}`)).status === 200);
  check("a cookie is NOT accepted as a credential", (await get("/agents", { headers: { cookie: `cotal_attach=${TOKEN}` } })).status === 401);
  check("token by bearer → 200", (await get("/agents", { headers: { authorization: `Bearer ${TOKEN}` } })).status === 200);
  check("the credentialed mint route reaches the establisher", (await get(`/session/x?t=${TOKEN}`, { method: "POST" })).status === 200);
  check("...exactly once, for the named agent", minted.length === 1 && minted[0] === "x", minted);

  // NO cookie: cookies are host-scoped, not port-scoped, so one set here would be sent to every
  // other HTTP service on this host and would collide between two managers on one box.
  const page = await get(`/?t=${TOKEN}`);
  check("console page is served", page.status === 200);
  check("console URL puts the token in the FRAGMENT, never the query", ep.consoleUrl().includes(`#t=${TOKEN}`) && !ep.consoleUrl().includes("?t="), ep.consoleUrl());
  check("console page is no-store + no-referrer", (page.headers.get("cache-control") ?? "").includes("no-store") && (page.headers.get("referrer-policy") ?? "").includes("no-referrer"));
  check("console page sets NO cookie", (page.headers.get("set-cookie") ?? "") === "", page.headers.get("set-cookie"));

  // HTTP-only face: item 6 deleted the ws terminal transport, so an upgrade gets a clean refusal
  // rather than a hung or reset socket — credential or not, since there is nothing to authorize.
  const upgradeTo = (pathAndQuery: string): Promise<string> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}${pathAndQuery}`);
      const done = (v: string) => { try { ws.close(); } catch { /* already closing */ } resolve(v); };
      ws.on("unexpected-response", (_req, res) => done(`http-${res.statusCode}`));
      ws.on("open", () => done("upgraded"));
      ws.on("error", (e) => done(`error:${(e as Error).message}`));
      setTimeout(() => done("timeout"), 4000);
    });
  check("a ws upgrade to the deleted attach transport is refused", (await upgradeTo("/attach/nobody")) === "http-400");
  check("...and holding the console token does not resurrect it", (await upgradeTo(`/attach/nobody?t=${TOKEN}`)) === "http-400");

  // Where it advertises itself.
  const remote = new AttachEndpoint(() => [], () => [], 0, undefined, "100.98.80.110", TOKEN);
  check("consoleUrl() advertises the bound host, not loopback", remote.consoleUrl().startsWith("http://100.98.80.110:"), remote.consoleUrl());
  const wild = new AttachEndpoint(() => [], () => [], 0, undefined, "0.0.0.0", TOKEN);
  check("a wildcard bind advertises loopback (not a dialable name)", wild.consoleUrl().startsWith("http://127.0.0.1:"), wild.consoleUrl());
  // An address this machine does not own. It must say which address and why, not surface a bare
  // errno from deep inside startup.
  const orphan = new AttachEndpoint(() => [], () => [], 0, undefined, "203.0.113.7", TOKEN);
  let bindErr = "";
  try { await orphan.start(); await orphan.stop(); } catch (e) { bindErr = (e as Error).message; }
  check(
    "binding an address this host lacks fails with operator-legible guidance",
    bindErr.includes("203.0.113.7") && bindErr.includes("console host it owns"),
    bindErr,
  );
} finally {
  await ep.stop();
}

console.log(failures === 0 ? "\n✓ attach-auth smoke passed" : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

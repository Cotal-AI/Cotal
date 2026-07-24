/**
 * Attach-endpoint reachability + credential smoke (no NATS, no test runner) — pnpm smoke:attach-auth
 *
 * The manager's attach face used to bind and advertise a hardcoded `127.0.0.1`, so a remote
 * `cotal attach` dialed its OWN loopback and got ECONNREFUSED. It now follows the mesh broker's
 * host — which means it can leave the box, which means the whole surface must be credentialed:
 * it carries terminal read+write for every managed agent, plus the roster and the live feed.
 *
 * Guards both halves:
 *   - `attachHost` derives the bind/advertise address from the broker URL (and stays loopback
 *     when there is no mesh address to follow);
 *   - every route AND the WS upgrade refuse an unauthenticated caller, accept the token by
 *     query/cookie/bearer, and reject a wrong-length and a same-length-but-wrong token;
 *   - the console page hands the browser the credential as a same-origin HttpOnly cookie;
 *   - `url()` / `consoleUrl()` advertise the bound host, and a wildcard bind advertises loopback.
 */
import WebSocket from "ws";
import { AttachEndpoint, attachHost } from "../src/attach-endpoint.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond || extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

// --- attachHost: the bind address follows the mesh -------------------------------------------
check("attachHost: derives the broker's host", attachHost("nats://100.98.80.110:4222") === "100.98.80.110");
check("attachHost: loopback mesh stays loopback", attachHost("nats://127.0.0.1:4222") === "127.0.0.1");
check("attachHost: no mesh address → loopback", attachHost(undefined) === "127.0.0.1");
check("attachHost: takes the first of a server list", attachHost("nats://10.0.0.9:4222,nats://10.0.0.8:4222") === "10.0.0.9");
let threw = false;
try { attachHost("not-a-url"); } catch { threw = true; }
check("attachHost: an unparseable URL throws, never a silent bind", threw);

// --- the live endpoint ------------------------------------------------------------------------
const TOKEN = "a".repeat(64);
const ep = new AttachEndpoint(() => undefined, () => [{ name: "x" }], () => [], 0, "127.0.0.1", TOKEN);
await ep.start();
const base = ep.consoleUrl().replace(/\/\?t=.*$/, "");

const get = async (path: string, init?: RequestInit): Promise<Response> => fetch(`${base}${path}`, init);

try {
  // Unauthenticated: nothing is readable, including the roster and the feed.
  for (const p of ["/", "/agents", "/feed", "/app.js"])
    check(`unauthenticated GET ${p} → 401`, (await get(p)).status === 401);

  // Wrong tokens are refused, including one of the right length (so the check is not length-only).
  check("wrong-length token → 401", (await get("/agents?t=nope")).status === 401);
  check("same-length wrong token → 401", (await get(`/agents?t=${"b".repeat(64)}`)).status === 401);

  // Each accepted credential channel.
  check("token by query → 200", (await get(`/agents?t=${TOKEN}`)).status === 200);
  check("token by cookie → 200", (await get("/agents", { headers: { cookie: `cotal_attach=${TOKEN}` } })).status === 200);
  check("token by bearer → 200", (await get("/agents", { headers: { authorization: `Bearer ${TOKEN}` } })).status === 200);

  // The console page is where a browser picks the credential up for every later request.
  const page = await get(`/?t=${TOKEN}`);
  const cookie = page.headers.get("set-cookie") ?? "";
  check("console page sets the credential cookie", page.status === 200 && cookie.includes(`cotal_attach=${TOKEN}`), cookie);
  check("cookie is HttpOnly + SameSite=Strict", /HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie), cookie);

  // The WS upgrade — the one that carries terminal write access.
  const upgrade = (qs: string): Promise<string> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/attach/nobody${qs}`);
      const done = (v: string) => { try { ws.close(); } catch { /* already closing */ } resolve(v); };
      ws.on("unexpected-response", (_req, res) => done(`http-${res.statusCode}`));
      ws.on("open", () => done("upgraded"));
      ws.on("error", (e) => done(`error:${(e as Error).message}`));
      setTimeout(() => done("timeout"), 4000);
    });

  const anon = await upgrade("");
  check("unauthenticated WS upgrade refused with 401", anon === "http-401", anon);
  const authed = await upgrade(`?t=${TOKEN}`);
  check("token-bearing WS upgrade is accepted", authed === "upgraded", authed);

  // What the manager hands back over the control plane.
  const url = ep.url("agent one");
  check("url() carries the token", url.includes(`t=${TOKEN}`), url);
  check("url() percent-encodes the agent name", url.includes("/attach/agent%20one"), url);

  const remote = new AttachEndpoint(() => undefined, () => [], () => [], 0, "100.98.80.110", TOKEN);
  check("url() advertises the bound host, not loopback", remote.url("a").startsWith("ws://100.98.80.110:"), remote.url("a"));
  const wild = new AttachEndpoint(() => undefined, () => [], () => [], 0, "0.0.0.0", TOKEN);
  check("a wildcard bind advertises loopback (not a dialable name)", wild.url("a").startsWith("ws://127.0.0.1:"), wild.url("a"));
} finally {
  await ep.stop();
}

console.log(failures === 0 ? "\n✓ attach-auth smoke passed" : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

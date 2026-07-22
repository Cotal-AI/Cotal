/**
 * P2 item 6 — the console's `POST /session/<name>` face route. Run: pnpm smoke:console-session-route.
 *
 * The manager's LOOPBACK HTTP face (same-host operator) is the browser's establishment door: POST
 * mints a mesh §13.6 session (offer + per-session caller credential) via the INJECTED establisher and
 * returns {grant, wsUrl, creds} — the browser then opens the caller rail over the broker's ws
 * listener. The face NEVER constructs a plane; the establisher is injected (the manager wires the ONE
 * plane + the session-caller mint at 6b-2). This smoke drives the route with a STUB establisher.
 *
 * Proven: POST returns 200 + {grant, wsUrl, creds} from the establisher (called with the name); GET
 * is 405 (POST-only — it has side effects: a one-use offer + a credential mint); with no establisher
 * wired the route 503s (open mesh / pre-6b-2), never a silent or wrong response.
 */
import { AttachEndpoint } from "../src/attach-endpoint.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };

// --- A. with an injected establisher ---
const called: string[] = [];
const ep = new AttachEndpoint(
  () => [],
  () => [],
  0,
  async (name) => { called.push(name); return { grant: { sessionId: `sess-${name}` }, wsUrl: "ws://127.0.0.1:14999", creds: `CREDS-FOR-${name}` }; },
);
await ep.start();
const base = ep.consoleUrl().replace(/\/$/, "");

console.log("A. POST /session/<name> establishes a mesh session via the injected establisher");
const r = await fetch(`${base}/session/worker-1`, { method: "POST" });
const body = (await r.json()) as { grant?: { sessionId?: string }; wsUrl?: string; creds?: string };
c("POST returns 200", r.status === 200, r.status);
c("body is {grant, wsUrl, creds} from the establisher", body.grant?.sessionId === "sess-worker-1" && body.wsUrl === "ws://127.0.0.1:14999" && body.creds === "CREDS-FOR-worker-1", body);
c("the establisher was called with the agent name", called.includes("worker-1"));
c("NO ws:// terminal-attach URL leaked (the wsUrl is the BROKER's mesh ws, not a manager attach face)", !body.wsUrl?.includes("/attach/"));

console.log("B. GET /session is 405 (POST-only: it has side effects)");
const g = await fetch(`${base}/session/worker-1`, { method: "GET" });
c("GET /session/<name> → 405 method not allowed", g.status === 405, g.status);

await ep.stop();

// --- C. without an establisher (open mesh / pre-6b-2) ---
console.log("C. no injected establisher → 503, never a wrong/silent response");
const ep2 = new AttachEndpoint(() => [], () => []);
await ep2.start();
const base2 = ep2.consoleUrl().replace(/\/$/, "");
const r2 = await fetch(`${base2}/session/worker-1`, { method: "POST" });
c("POST /session → 503 when no establisher is wired", r2.status === 503, r2.status);
await ep2.stop();

console.log(`\nconsole-session-route: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

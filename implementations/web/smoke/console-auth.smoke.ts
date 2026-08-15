/**
 * THE CONSOLE'S HTTP SURFACE AUTHENTICATES A CALLER, AND EACH REFUSAL SAYS WHICH CONDITION FAILED.
 *
 * Measured before this change, on the shipped file: `req.headers` was read **0 times** (control:
 * `req.url`, 3 times). Not weak authentication — none. The surface binds loopback, and loopback
 * defends against other HOSTS; it does not defend against another PROCESS on this machine, and it
 * does not defend against a page in the operator's own browser issuing requests to
 * `http://127.0.0.1:7799`. What that reached was the whole mesh read path plus a channel-delete POST.
 *
 * This is slice 1 of the send work and deliberately contains NO send route. It is worth landing on
 * its own: the hole it closes exists today, and every later slice depends on the caller being known.
 *
 * WHAT IS DRIVEN, IN TWO LAYERS, BECAUSE ONE IS NOT ENOUGH:
 *   1. The exported `makeAuthGate` — what the gate decides.
 *   2. The gate block LIFTED OUT of the shipped `handleRequest` and executed — what the handler DOES
 *      with each verdict, over a recording `ServerResponse`.
 * Layer 2 exists because a suite on this surface has already been caught asserting what a function
 * was CALLED WITH rather than what it DID (PR #450, mutation 8). A correct gate wired to a handler
 * that ignores its verdict is an unauthenticated surface with a passing test.
 *
 * NOT DRIVEN, and no cell implies it: a real browser's cookie jar, and a real cross-site request. The
 * `SameSite=Strict` attribute is asserted as EMITTED, not as ENFORCED — enforcement is the browser's
 * and needs a browser. That boundary is stated rather than left for a reader to assume.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { CROSS_ORIGIN, LAUNCH_TOKEN_ALREADY_USED, UNAUTHENTICATED, makeAuthGate } from "../src/web.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const PORT = 7799;
const q = (s = "") => new URLSearchParams(s);
type Req = { headers: Record<string, string | undefined> };
const req = (headers: Record<string, string | undefined> = {}): Req => ({ headers });

// ── 1. WHAT THE GATE DECIDES ────────────────────────────────────────────────────────────────────
{
  const gate = makeAuthGate(PORT);
  check("NON-VACUITY: the gate minted a launch token to test with",
    typeof gate.launchToken === "string" && gate.launchToken.length >= 32, { len: gate.launchToken.length });

  const bare = gate.check(req() as never, q());
  check("a request with no cookie and no token is refused as `unauthenticated`",
    bare !== undefined && "refuse" in bare && bare.refuse === UNAUTHENTICATED, bare);

  const exchanged = gate.check(req() as never, q(`k=${gate.launchToken}`));
  check("the launch token is exchanged for a session",
    exchanged !== undefined && "exchange" in exchanged && typeof exchanged.exchange === "string", exchanged);
  const session = (exchanged as { exchange: string }).exchange;

  check("that session is then accepted",
    gate.check(req({ cookie: `cotal_web_session=${session}` }) as never, q()) === undefined);

  // THE SINGLE-USE PROPERTY, which is the whole reason a launch URL may be printed and pasted.
  const replay = gate.check(req() as never, q(`k=${gate.launchToken}`));
  check("replaying the SAME launch token is refused as `launch-token-already-used`, not accepted",
    replay !== undefined && "refuse" in replay && replay.refuse === LAUNCH_TOKEN_ALREADY_USED, replay);
  check("…and that condition is DISTINCT from `unauthenticated` (a replayed link is a different fact)",
    LAUNCH_TOKEN_ALREADY_USED !== UNAUTHENTICATED);

  const forged = gate.check(req({ cookie: "cotal_web_session=not-a-real-session" }) as never, q());
  check("an unknown session cookie is refused, not trusted for looking like one",
    forged !== undefined && "refuse" in forged && forged.refuse === UNAUTHENTICATED, forged);
}

// ── 2. ORIGIN ───────────────────────────────────────────────────────────────────────────────────
{
  const gate = makeAuthGate(PORT);
  const evil = gate.check(req({ origin: "https://evil.example" }) as never, q(`k=${gate.launchToken}`));
  check("a cross-origin request is refused as `cross-origin` — even carrying a VALID launch token",
    evil !== undefined && "refuse" in evil && evil.refuse === CROSS_ORIGIN, evil);
  check("…and the token it presented was NOT consumed (a refused request must not spend the secret)",
    (() => {
      const after = gate.check(req() as never, q(`k=${gate.launchToken}`));
      return after !== undefined && "exchange" in after;
    })());

  for (const host of [`cotal.localhost:${PORT}`, `127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
    const g2 = makeAuthGate(PORT);
    const ok = g2.check(req({ origin: `http://${host}` }) as never, q(`k=${g2.launchToken}`));
    check(`our own origin http://${host} is not treated as cross-origin`,
      ok !== undefined && "exchange" in ok, { host, ok });
  }

  // ORDERING, and it is load-bearing: a cross-site request arrives WITHOUT the cookie (SameSite),
  // so a gate testing the session first would report every one of them as `unauthenticated` and the
  // operator would never learn that another site was talking to their console.
  const g3 = makeAuthGate(PORT);
  const both = g3.check(req({ origin: "https://evil.example" }) as never, q());
  check("with BOTH failures present, the more specific condition wins (`cross-origin`, not `unauthenticated`)",
    both !== undefined && "refuse" in both && both.refuse === CROSS_ORIGIN, both);
}

// ── 3. THE READINESS NONCE ──────────────────────────────────────────────────────────────────────
// `--detach`'s parent polls /api/meta to learn the child is up and is OURS. It gets its own
// credential rather than an exempt route: an exempt route is unauthenticated for everyone, forever,
// and the next person to add a field to it will not know that.
{
  const gate = makeAuthGate(PORT);
  check("the readiness nonce is accepted",
    gate.check(req({ "x-cotal-readiness": gate.readinessNonce }) as never, q()) === undefined);
  check("a WRONG readiness nonce is refused (the check is a comparison, not a presence test)",
    (() => {
      const r = gate.check(req({ "x-cotal-readiness": "wrong" }) as never, q());
      return r !== undefined && "refuse" in r && r.refuse === UNAUTHENTICATED;
    })());
  check("the readiness nonce does NOT consume the launch token (the parent polls; the browser still needs it)",
    (() => {
      gate.check(req({ "x-cotal-readiness": gate.readinessNonce }) as never, q());
      const after = gate.check(req() as never, q(`k=${gate.launchToken}`));
      return after !== undefined && "exchange" in after;
    })());
  check("the two secrets are different values (one leaking must not be the other)",
    gate.launchToken !== gate.readinessNonce);
}

// ── 4. WHAT THE SHIPPED HANDLER DOES WITH EACH VERDICT ──────────────────────────────────────────
// Lifted out of `web.ts` and executed. A correct gate wired to a handler that ignores it is an
// unauthenticated surface with a passing test — that exact shape survived a green suite on this
// surface once already.
const webTs = read("../src/web.ts");
const gateBlock = (() => {
  const start = webTs.indexOf("    const verdict = gate.check(req, query);");
  if (start === -1) return null;
  const end = webTs.indexOf("\n\n", start);
  return end === -1 ? null : webTs.slice(start, end);
})();
check("the gate block was lifted out of handleRequest", Boolean(gateBlock), { len: gateBlock?.length });
check("CONTROL: a block that is not in the file lifts nothing",
  webTs.indexOf("    const verdict = gate.checkNothing(") === -1);

type Recorded = { status: number; headers: Record<string, string>; body: string };
const runGateBlock = (verdict: unknown, path = "/api/roster"): Recorded => {
  const rec: Recorded = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => { rec.status = status; rec.headers = headers; },
    end: (body?: string) => { rec.body = body ?? ""; },
  };
  const source = ts.transpileModule(
    `globalThis.__run = () => { ${gateBlock} };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const ctx: Record<string, unknown> = {
    gate: { check: () => verdict },
    req: {}, query: q(), path, res,
    CROSS_ORIGIN, SESSION_COOKIE: "cotal_web_session",
    globalThis: undefined, console,
  };
  ctx.globalThis = ctx;
  runInContext(source, createContext(ctx), { filename: "web.ts (gate block)" });
  (ctx.__run as () => void)();
  return rec;
};

const un = runGateBlock({ refuse: UNAUTHENTICATED });
check("an `unauthenticated` verdict becomes a 401", un.status === 401, un.status);
check("…whose BODY names the condition (a caller reading only the body still learns which failed)",
  JSON.parse(un.body).error === UNAUTHENTICATED, un.body);
check("…and is not an empty 200 (the defect this lane exists to remove)", un.status !== 200 && un.body !== "");

const xo = runGateBlock({ refuse: CROSS_ORIGIN });
check("a `cross-origin` verdict becomes a 403, not the same status as unauthenticated",
  xo.status === 403 && xo.status !== un.status, { xo: xo.status, un: un.status });
check("…and names its own condition", JSON.parse(xo.body).error === CROSS_ORIGIN, xo.body);

const ex = runGateBlock({ exchange: "SESSIONVALUE" }, "/graph");
check("an exchange verdict sets the session cookie", (ex.headers["set-cookie"] ?? "").includes("SESSIONVALUE"), ex.headers);
check("…HttpOnly, so page script cannot read it", (ex.headers["set-cookie"] ?? "").includes("HttpOnly"));
check("…SameSite=Strict, so a cross-site request never carries it (EMITTED here; enforced by the browser)",
  (ex.headers["set-cookie"] ?? "").includes("SameSite=Strict"));
check("…and redirects to the same path WITHOUT the token, so the spent secret leaves the address bar",
  ex.status === 302 && ex.headers.location === "/graph", { status: ex.status, location: ex.headers.location });

const allowed = runGateBlock(undefined);
check("an allowed request writes NOTHING and falls through to the routes",
  allowed.status === 0 && allowed.body === "", allowed);

// ── 5. THE GATE RUNS BEFORE EVERY ROUTE ─────────────────────────────────────────────────────────
// Positional, over the shipped source: the first route must come AFTER the gate. A gate placed below
// a route leaves that route unauthenticated, and nothing in its own behaviour would say so.
const gateAt = webTs.indexOf("const verdict = gate.check(req, query);");
const firstRoute = webTs.indexOf('if (path === "/feed")');
check("NON-VACUITY: both positions were found", gateAt !== -1 && firstRoute !== -1, { gateAt, firstRoute });
check("the gate runs BEFORE the first route (a route above the gate would be unauthenticated)",
  gateAt < firstRoute, { gateAt, firstRoute });

console.log(`\nCONSOLE AUTH SMOKE OK ✅  (${pass} passed, 0 failed)`);

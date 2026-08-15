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

    // THE SCHEME IS PART OF THE ORIGIN. Comparing only the host accepted `https://<same host>`,
    // which is a different origin to every browser. Testing the allowed hosts only under the
    // allowed scheme is what let that through: every negative differed in HOST, so nothing ever
    // varied the SCHEME.
    const g2s = makeAuthGate(PORT);
    const wrongScheme = g2s.check(req({ origin: `https://${host}` }) as never, q(`k=${g2s.launchToken}`));
    check(`…but https://${host} is a DIFFERENT origin and is refused as \`cross-origin\``,
      wrongScheme !== undefined && "refuse" in wrongScheme && wrongScheme.refuse === CROSS_ORIGIN, { host, wrongScheme });
  }

  // ORDERING, and it is load-bearing: a cross-site request arrives WITHOUT the cookie (SameSite),
  // so a gate testing the session first would report every one of them as `unauthenticated` and the
  // operator would never learn that another site was talking to their console.
  const g3 = makeAuthGate(PORT);
  const both = g3.check(req({ origin: "https://evil.example" }) as never, q());
  check("with BOTH failures present, the more specific condition wins (`cross-origin`, not `unauthenticated`)",
    both !== undefined && "refuse" in both && both.refuse === CROSS_ORIGIN, both);

  // THE CASE THAT MATTERS MOST, and the suite did not have it until a mutation went looking. Moving
  // the origin check below the session check leaves every cell above green — because all of them
  // describe a request with NO session. The dangerous request is the opposite: the operator's own
  // browser HAS a session, and another site's page is trying to ride it. `SameSite=Strict` should
  // stop the cookie ever being sent, but that is the browser's promise, not ours, and this is the
  // check that holds if the promise is not kept.
  const g4 = makeAuthGate(PORT);
  const authed = g4.check(req() as never, q(`k=${g4.launchToken}`)) as { exchange: string };
  const ridden = g4.check(
    req({ origin: "https://evil.example", cookie: `cotal_web_session=${authed.exchange}` }) as never, q());
  check("a cross-origin request carrying a VALID session is still refused (the CSRF case, not the login case)",
    ridden !== undefined && "refuse" in ridden && ridden.refuse === CROSS_ORIGIN, ridden);
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
  // SAME-LENGTH negatives. Every wrong secret in this suite was the string `wrong`, which differs in
  // LENGTH — so `secretEquals` reduced to a length comparison authenticated everything and all 32
  // cells stayed green. A comparison is only shown to compare CONTENT by a negative that matches in
  // length and differs in one byte.
  const nonceOneOff = `${gate.readinessNonce.slice(0, -1)}${gate.readinessNonce.slice(-1) === "A" ? "B" : "A"}`;
  check("NON-VACUITY: the one-character-changed nonce is the same LENGTH and a different VALUE",
    nonceOneOff.length === gate.readinessNonce.length && nonceOneOff !== gate.readinessNonce,
    { len: nonceOneOff.length });
  check("a same-length readiness nonce differing in ONE character is refused (content, not length)",
    (() => {
      const r = gate.check(req({ "x-cotal-readiness": nonceOneOff }) as never, q());
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

  // The launch token had NO wrong-value negative at all: the only failing token case was a REPLAY,
  // which never reaches the comparison because the token is already undefined by then.
  {
    const g5 = makeAuthGate(PORT);
    const tokenOneOff = `${g5.launchToken.slice(0, -1)}${g5.launchToken.slice(-1) === "A" ? "B" : "A"}`;
    check("NON-VACUITY: the one-character-changed launch token is the same LENGTH and a different VALUE",
      tokenOneOff.length === g5.launchToken.length && tokenOneOff !== g5.launchToken, { len: tokenOneOff.length });
    const wrong = g5.check(req() as never, q(`k=${tokenOneOff}`));
    check("a same-length WRONG launch token is refused as `unauthenticated`, not exchanged",
      wrong !== undefined && "refuse" in wrong && wrong.refuse === UNAUTHENTICATED, wrong);
    check("…and a wrong token does NOT burn the real one (a failed guess must not cost the operator their link)",
      (() => {
        const after = g5.check(req() as never, q(`k=${g5.launchToken}`));
        return after !== undefined && "exchange" in after;
      })());
  }

  // ORDERING SIBLING of the CSRF case: the readiness check sits ABOVE the session check, so it must
  // sit below the origin check too. Moving it above the origin check left every cell green, because
  // every cross-origin case carried launch/session credentials and none carried the readiness nonce.
  {
    const g6 = makeAuthGate(PORT);
    const evilReady = g6.check(
      req({ origin: "https://evil.example", "x-cotal-readiness": g6.readinessNonce }) as never, q());
    check("a cross-origin request carrying a VALID readiness nonce is still refused as `cross-origin`",
      evilReady !== undefined && "refuse" in evilReady && evilReady.refuse === CROSS_ORIGIN, evilReady);
  }
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

type Recorded = { status: number; headers: Record<string, string>; body: string; routeReached: boolean };
const runGateBlock = (verdict: unknown, path = "/api/roster"): Recorded => {
  const rec: Recorded = { status: 0, headers: {}, body: "", routeReached: false };
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => { rec.status = status; rec.headers = headers; },
    end: (body?: string) => { rec.body = body ?? ""; },
  };
  // A ROUTE SENTINEL after the lifted block. Without it this harness can only see what was WRITTEN,
  // never whether execution STOPPED — and a refusal that writes a 401 and then falls through into
  // the routes writes exactly the same bytes as one that returns. Measured: dropping the refusal
  // branch's `return` left all 32 cells green while an unauthenticated POST still reached the
  // channel-delete. The fixture must reach as far as the sentence describing it, and the sentence
  // here is "the request is refused", not "a 401 was written".
  const source = ts.transpileModule(
    `globalThis.__run = () => { ${gateBlock}\n__routeReached(); };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const ctx: Record<string, unknown> = {
    gate: { check: () => verdict },
    req: {}, query: q(), path, res,
    CROSS_ORIGIN, SESSION_COOKIE: "cotal_web_session",
    __routeReached: () => { rec.routeReached = true; },
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
check("…and EXECUTION STOPS: the routes below the gate are never reached (a 401 that then serves the route is not a refusal)",
  un.routeReached === false, un);

const xo = runGateBlock({ refuse: CROSS_ORIGIN });
check("a `cross-origin` verdict becomes a 403, not the same status as unauthenticated",
  xo.status === 403 && xo.status !== un.status, { xo: xo.status, un: un.status });
check("…and names its own condition", JSON.parse(xo.body).error === CROSS_ORIGIN, xo.body);
check("…and EXECUTION STOPS for it too", xo.routeReached === false, xo);

// THE THIRD REFUSAL, driven through the HANDLER and not only through the gate. Measured: the two
// layers were joined by an assumption — the gate produced this condition and the handler was only
// ever handed the other two, so special-casing it out of the handler's refusal predicate left every
// cell green while a replayed launch link fell through to a route.
const rp = runGateBlock({ refuse: LAUNCH_TOKEN_ALREADY_USED });
check("a `launch-token-already-used` verdict becomes a 401 at the HANDLER, not only at the gate",
  rp.status === 401, rp.status);
check("…names its own condition in the body", JSON.parse(rp.body).error === LAUNCH_TOKEN_ALREADY_USED, rp.body);
check("…and EXECUTION STOPS for the replayed link as well", rp.routeReached === false, rp);

const ex = runGateBlock({ exchange: "SESSIONVALUE" }, "/graph");
// ATTRIBUTE BOUNDARIES, not substrings. `.includes("HttpOnly")` is satisfied by an attribute merely
// CONTAINING the word — `NotHttpOnly` passes it and the browser enforces nothing. Parse the header
// the way a browser does: split on `;`, trim, compare whole attributes.
const cookieAttrs = (ex.headers["set-cookie"] ?? "").split(";").map((s) => s.trim());
check("an exchange verdict sets the session cookie under the EXACT name, carrying the session value",
  cookieAttrs[0] === "cotal_web_session=SESSIONVALUE", cookieAttrs);
check("…Path=/, as a whole attribute", cookieAttrs.includes("Path=/"), cookieAttrs);
check("…HttpOnly as a WHOLE attribute, so page script cannot read it (`NotHttpOnly` must not satisfy this)",
  cookieAttrs.includes("HttpOnly"), cookieAttrs);
check("…SameSite=Strict as a WHOLE attribute (EMITTED here; enforced by the browser)",
  cookieAttrs.includes("SameSite=Strict"), cookieAttrs);
check("…and redirects to the same path WITHOUT the token, so the spent secret leaves the address bar",
  ex.status === 302 && ex.headers.location === "/graph", { status: ex.status, location: ex.headers.location });
check("…and EXECUTION STOPS after the redirect (the exchange answers; it does not also serve the route)",
  ex.routeReached === false, ex);

const allowed = runGateBlock(undefined);
check("an allowed request writes NOTHING and falls through to the routes",
  allowed.status === 0 && allowed.body === "", allowed);
check("POSITIVE CONTROL for the sentinel: an ALLOWED request DOES reach the routes, so the three non-reaches above are real",
  allowed.routeReached === true, allowed);

// ── 5. THE GATE RUNS BEFORE EVERY ROUTE ─────────────────────────────────────────────────────────
// Positional, over the shipped source: the first route must come AFTER the gate. A gate placed below
// a route leaves that route unauthenticated, and nothing in its own behaviour would say so.
// Against EVERY route dispatch, not one named route. Measured: keying this on `/feed` alone let
// `/api/meta` be moved above the gate with all 32 cells still green — the cell's SENTENCE said "the
// first route" and its ASSERTION said "/feed", and the next route added above the gate inherits no
// protection and nothing says so.
const gateAt = webTs.indexOf("const verdict = gate.check(req, query);");
const routeAts = [
  ...webTs.matchAll(/if \(path === "/g),
  ...webTs.matchAll(/if \(path\.startsWith\("/g),
].map((m) => m.index as number);
// `.every()` over an empty set passes while proving nothing, so the count is asserted FIRST and the
// cell below is only meaningful because of it.
check("NON-VACUITY: the gate position and MORE THAN ONE route dispatch were located in the shipped source",
  gateAt !== -1 && routeAts.length > 1, { gateAt, routes: routeAts.length });
check("the gate runs BEFORE EVERY route dispatch (any route above it would be permanently unauthenticated)",
  routeAts.every((at) => gateAt < at), { gateAt, earliestRoute: Math.min(...routeAts), routes: routeAts.length });

console.log(`\nCONSOLE AUTH SMOKE OK ✅  (${pass} passed, 0 failed)`);

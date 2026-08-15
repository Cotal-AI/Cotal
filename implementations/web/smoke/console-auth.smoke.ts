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
import { closeSync, fchmodSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // …and a SAME-LENGTH forgery, derived from the real session. The literal above is SHORTER than a
  // minted session, so `sessions.has(session)` could be replaced by a length check and survive:
  // measured, that mutant went 68/68 green while authenticating any cookie of the right size.
  const sessIdx = [...session].map((_, i) => i);
  check("NON-VACUITY: the session sweep covers EVERY index of a real minted session",
    sessIdx.length === session.length && sessIdx.length > 3, { n: sessIdx.length });
  const sessSurvivors = sessIdx.filter((i) => {
    const near = `${session.slice(0, i)}${session[i] === "A" ? "B" : "A"}${session.slice(i + 1)}`;
    const r = gate.check(req({ cookie: `cotal_web_session=${near}` }) as never, q());
    return !(r !== undefined && "refuse" in r && r.refuse === UNAUTHENTICATED);
  });
  check("a same-length session cookie differing at ANY SINGLE index is refused (membership, not shape, not length)",
    sessSurvivors.length === 0, { acceptedAtPositions: sessSurvivors });
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

  // DEFAULT-PORT SERIALIZATION. `new URL("http://localhost:80").origin` is `http://localhost` — the
  // WHATWG serializer drops the default port — so an allow-list built by string concatenation stored
  // `http://localhost:80` and could never match a real browser's Origin header. On `--port 80` the
  // console refused its own page. Both sides must be normalized the same way.
  {
    const g80 = makeAuthGate(80);
    const ok80 = g80.check(req({ origin: "http://localhost" }) as never, q(`k=${g80.launchToken}`));
    check("on --port 80 the console accepts its OWN origin, which a browser sends without the default port",
      ok80 !== undefined && "exchange" in ok80, ok80);
    const evil80 = makeAuthGate(80).check(req({ origin: "http://evil.example" }) as never, q());
    check("…and still refuses another origin on port 80 (the normalization did not widen the set)",
      evil80 !== undefined && "refuse" in evil80 && evil80.refuse === CROSS_ORIGIN, evil80);
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
  // EVERY POSITION, not just the last. A negative that only ever changes the FINAL character leaves
  // `length + final byte` equality passing: measured, that mutant survived 68/68 while accepting any
  // secret sharing one byte. One-off negatives must sweep first, middle and last.
  const flip = (s: string, i: number) => `${s.slice(0, i)}${s[i] === "A" ? "B" : "A"}${s.slice(i + 1)}`;
  const positions = (s: string) => [...s].map((_, i) => i);
  // EVERY index, not a sample of three. A comparator checking length plus three fixed positions
  // rejects a 0/middle/last negative and accepts everything else — sampling positions is the same
  // mistake as sampling routes, one type down.
  const nonceIdx = positions(gate.readinessNonce);
  check("NON-VACUITY: the nonce sweep covers EVERY index, not a sample",
    nonceIdx.length === gate.readinessNonce.length && nonceIdx.length > 3, { n: nonceIdx.length });
  const nonceSurvivors = nonceIdx.filter((i) => {
    const r = gate.check(req({ "x-cotal-readiness": flip(gate.readinessNonce, i) }) as never, q());
    return !(r !== undefined && "refuse" in r && r.refuse === UNAUTHENTICATED);
  });
  check("a same-length readiness nonce differing at ANY SINGLE index is refused (content, not length, not some bytes)",
    nonceSurvivors.length === 0, { acceptedAtPositions: nonceSurvivors });
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
    const tokenIdx = positions(g5.launchToken);
    check("NON-VACUITY: the launch-token sweep covers EVERY index, not a sample",
      tokenIdx.length === g5.launchToken.length && tokenIdx.length > 3, { n: tokenIdx.length });
    const tokenSurvivors = tokenIdx.filter((i) => {
      const r = g5.check(req() as never, q(`k=${flip(g5.launchToken, i)}`));
      return !(r !== undefined && "refuse" in r && r.refuse === UNAUTHENTICATED);
    });
    check("a same-length WRONG launch token differing at ANY SINGLE index is refused as `unauthenticated`",
      tokenSurvivors.length === 0, { acceptedAtPositions: tokenSurvivors });
    const wrong = g5.check(req() as never, q(`k=${flip(g5.launchToken, 0)}`));
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

// ── 4. THE SHIPPED HANDLER: ITS STRUCTURE FIRST, THEN ITS BEHAVIOUR ─────────────────────────────
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

// THE SHIPPED HANDLER, PARSED. Derived here because the cells below need it before section 5 reads
// it structurally. Every string-slice version of these checks was eventually beaten by a shape it
// did not model — the property is about statements, so it is asserted over statements.
const handlerBody = (() => {
  const sf = ts.createSourceFile("web.ts", webTs, ts.ScriptTarget.ES2022, true);
  let found: ts.Block | undefined;
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "handleRequest"
      && n.initializer && ts.isArrowFunction(n.initializer) && ts.isBlock(n.initializer.body)
    ) found = n.initializer.body;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
})();
const stmts = handlerBody?.statements ?? ts.factory.createNodeArray<ts.Statement>([]);
// A `const <name> = …` statement whose declared name matches, or undefined for anything else. Any
// other statement kind in one of these slots fails the cell by returning undefined.
const declName = (s: ts.Statement | undefined): string | undefined =>
  s !== undefined && ts.isVariableStatement(s) && s.declarationList.declarations.length === 1
    && ts.isIdentifier(s.declarationList.declarations[0].name)
    ? s.declarationList.declarations[0].name.text
    : undefined;
const ifCond = (s: ts.Statement | undefined): string | undefined =>
  s !== undefined && ts.isIfStatement(s) ? s.expression.getText() : undefined;
const gateInit = stmts[2] !== undefined && ts.isVariableStatement(stmts[2])
  ? stmts[2].declarationList.declarations[0]?.initializer?.getText() ?? ""
  : "";

// ── 4a. THE GATE RUNS BEFORE EVERY ROUTE (structural, over the parsed handler) ──────────────────
// Asserted BEFORE the behavioural cells below, because they consume the parsed statements: with
// these cells running later, a route inserted into the refusal slot tripped the extraction guard
// first and the suite reported "the refusal condition was extracted" — true, and useless. The cell
// that NAMES the defect has to be the cell that fires.
// Positional, over the shipped source: the first route must come AFTER the gate. A gate placed below
// a route leaves that route unauthenticated, and nothing in its own behaviour would say so.
// STRUCTURAL, not an enumeration of route syntax. Two earlier versions of this cell were beaten by
// the same move: the first compared the gate against ONE named route (`/feed`), and the second
// against every `if (path === "` / `if (path.startsWith("` dispatch — which silently omitted the
// SHIPPED STATIC DISPATCH (`PAGE[path]` then `if (file)`), so moving that block above the gate left
// `/`, `/graph` and every asset unauthenticated with all 68 cells green.
//
// A list of route shapes can always omit one, and the omission is invisible. So this asserts the
// property directly instead: between the handler's opening brace and the gate there is NOTHING but
// the path and query parses — no statement of any syntax, present or future.
//
// OVER THE AST, not over lines. The line-based version of this cell counted trimmed source lines, so
// a route dispatch appended to the END of the query line — after its semicolon, same line — left
// `firstStatements` at exactly two entries starting `const path` / `const query`. Measured: 110/110
// green while an unauthenticated `GET /api/meta` answered `200 {}` and `gate.check` was never called
// at all. Line position is not statement position, and only one of them is the property.
const gateAt = webTs.indexOf("const verdict = gate.check(req, query);");
const handlerAt = webTs.indexOf("const handleRequest = async (req: IncomingMessage, res: ServerResponse)");
check("NON-VACUITY: the handler's start and the gate were both located in the shipped source",
  gateAt !== -1 && handlerAt !== -1 && handlerAt < gateAt, { handlerAt, gateAt });
check("NON-VACUITY: the shipped handleRequest was found IN THE AST and has a statement body",
  handlerBody !== undefined && handlerBody.statements.length > 3, { statements: handlerBody?.statements.length });
check("the handler's first THREE STATEMENTS are the path parse, the query parse, and the gate call — nothing else precedes the gate",
  declName(stmts[0]) === "path" && declName(stmts[1]) === "query"
    && declName(stmts[2]) === "verdict" && gateInit.includes("gate.check(req, query)"),
  { first: [declName(stmts[0]), declName(stmts[1]), declName(stmts[2])], gateInit });
check("…and statements 4 and 5 are the REFUSAL and EXCHANGE handlers, so no route can sit between the gate and its refusal",
  (ifCond(stmts[3]) ?? "").includes('"refuse" in verdict')
    && (ifCond(stmts[4]) ?? "").includes('"exchange" in verdict'),
  { third: ifCond(stmts[3]), fourth: ifCond(stmts[4]) });

// THE NAME OF A STATEMENT IS NOT ITS CONTENT. Pinning statements 0-2 by their DECLARED NAMES left
// their initializers unconstrained, and an initializer is code: a comma expression inside the still
// named `path` declaration that writes the gate's own readiness nonce into `req.headers` self-
// authorizes the request BEFORE the gate reads it. Measured against a REAL gate from makeAuthGate —
// a bare unauthenticated request went from `401` to reaching the route, with all 114 cells green.
// The prefix ahead of the gate is security-critical, so it is pinned by EXACT TEXT: it may parse the
// request and do nothing else, and any edit to it — including an innocent one — must be deliberate.
const initText = (s: ts.Statement | undefined): string =>
  s !== undefined && ts.isVariableStatement(s)
    ? s.declarationList.declarations[0]?.initializer?.getText() ?? "" : "";
check("…and the path parse is EXACTLY a parse — its initializer reads the URL and does nothing else",
  initText(stmts[0]) === `(req.url ?? "/").split("?")[0]`, { init: initText(stmts[0]) });
check("…and the query parse likewise, so no side effect can run before the gate is consulted",
  initText(stmts[1]) === `new URLSearchParams((req.url ?? "").split("?")[1] ?? "")`, { init: initText(stmts[1]) });

// EQUALITY, NOT AN ENUMERATION OF FORBIDDEN SPELLINGS. The refusal condition used to be checked by
// banning the substrings `path`, `req.`, `method` and `query` from it — and a list of spellings can
// always be evaded by one more spelling. Measured: conjoining the refusal with
// `req["headers"]?.["x-skip-auth"] === undefined` dodges every banned substring (bracket notation
// contains no `req.`), stays green at 114/114, and gives any request carrying that header a free
// pass while the gate's refusal is computed and discarded. The property is not "avoids these four
// words", it is "depends on the verdict and NOTHING else", so it is asserted as equality.
check("the refusal condition is EXACTLY verdict-only — not merely free of a list of forbidden spellings",
  ifCond(stmts[3]) === `verdict !== undefined && "refuse" in verdict`, { cond: ifCond(stmts[3]) });
check("…and so is the exchange condition",
  ifCond(stmts[4]) === `verdict !== undefined && "exchange" in verdict`, { cond: ifCond(stmts[4]) });

// ── 4b. WHAT THE SHIPPED HANDLER DOES WITH EACH VERDICT (behavioural) ───────────────────────────
type Recorded = { status: number; headers: Record<string, string>; body: string; routeReached: boolean };
// The METHOD is a fixture dimension too, and it was the next one held constant: `req` was `{}`, so
// `req.method` was `undefined` in every cell. Gating the refusal predicate on `req.method !== "POST"`
// therefore left all 84 cells green while the real channel-delete POST — the one destructive route on
// this surface — skipped the refusal entirely. Same shape as the path survivor, one dimension over.
const runGateBlock = (verdict: unknown, path = "/api/roster", method = "GET"): Recorded => {
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
    req: { method }, query: q(), path, res,
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

// THE EXCHANGE BRANCH IS A DIMENSION TOO. The refusal branch is asserted verdict-only above, but the
// exchange branch legitimately reads `path` (it redirects to it), so it cannot be asserted the same
// way — it has to be SWEPT. The single fixture used `/graph`; conjoining the exchange with
// `path === "/graph"` therefore stayed green while the ACTUAL printed launch URL is `/`, which would
// have burned the token, served the page, and never set a session cookie. The one path that matters
// most was the one path not driven.
for (const exPath of ["/", "/graph", "/app.js"]) {
  const e = runGateBlock({ exchange: "SESSIONVALUE" }, exPath);
  check(`an exchange on ${exPath} sets the cookie and redirects THERE (the printed launch URL is "/")`,
    e.status === 302 && (e.headers["set-cookie"] ?? "").includes("SESSIONVALUE") && e.headers.location === exPath,
    { exPath, e });
}

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

// PATH INDEPENDENCE, and the gap it closes was found by mutating rather than by reading. Every
// refusal fixture above uses runGateBlock's DEFAULT path, so the suite varied the VERDICT and held
// the PATH constant — while the code can branch on either. Conjoining the handler's refusal
// predicate with `path === "/api/roster"` therefore refused exactly the cases the suite drove and
// let `/feed`, the static assets and the channel-delete POST fall straight through, surviving 49/49.
// A gate is worthless if it is a gate for one path.
const ROUTE_PATHS = ["/", "/feed", "/app.js", "/api/meta", "/api/roster", "/api/channel/delete"];
check("NON-VACUITY: the refusal sweep covers several paths INCLUDING the destructive one",
  ROUTE_PATHS.length > 1 && ROUTE_PATHS.includes("/api/channel/delete"), ROUTE_PATHS);
// STRUCTURAL INDEPENDENCE, because a sweep is a SAMPLE and a sample can always be evaded — the path
// list omits `/api/dms`, `/api/activity`, the history route, and a predicate conjoined with
// `path !== "/api/dms"` refuses all six sampled paths while letting DMs through. Sampling cannot fix
// that; the property can. The refusal branch must depend on the VERDICT ALONE.
// FROM THE AST, not from a string slice. The slice took `indexOf("if (")` to `indexOf(") {")` over
// the lifted block; inserting a `switch (path) {` above the refusal put a `) {` BEFORE the first
// `if (`, so the slice inverted and extracted the empty string. The suite went red — but on this
// non-vacuity cell, which says only "extraction failed" and names nothing about the bypass. A guard
// that fails safe is not the same as a cell that detects. The condition now comes from the parsed
// refusal statement, which cannot invert.
const refusalCond = ifCond(stmts[3]) ?? "";
check("NON-VACUITY: the refusal condition was extracted and mentions the verdict",
  refusalCond.includes("verdict"), { refusalCond });
for (const forbidden of ["path", "req.", "method", "query"]) {
  check(`the refusal branch does NOT depend on \`${forbidden}\` — it refuses on the verdict alone, for every route and method`,
    !refusalCond.includes(forbidden), { refusalCond, forbidden });
}

const ROUTE_METHODS = ["GET", "POST"];
check("NON-VACUITY: the sweep varies the METHOD as well as the path",
  ROUTE_METHODS.length > 1 && ROUTE_METHODS.includes("POST"), ROUTE_METHODS);
for (const refusal of [UNAUTHENTICATED, CROSS_ORIGIN, LAUNCH_TOKEN_ALREADY_USED]) {
  for (const routePath of ROUTE_PATHS) {
    for (const method of ROUTE_METHODS) {
      const r = runGateBlock({ refuse: refusal }, routePath, method);
      check(`\`${refusal}\` refuses ${method} ${routePath} AND never reaches the route (a gate for one path or one method is not a gate)`,
        r.status !== 0 && r.body !== "" && r.routeReached === false, { routePath, method, r });
    }
  }
}
// Named separately from the sweep because it is THE destructive request on this surface, and a
// reader looking for "is the channel-delete gated?" should find a cell that says so.
const del = runGateBlock({ refuse: UNAUTHENTICATED }, "/api/channel/delete", "POST");
check("the channel-delete POST — the one destructive route here — is refused and never reached",
  del.status === 401 && del.routeReached === false, del);

const allowed = runGateBlock(undefined);
check("an allowed request writes NOTHING and falls through to the routes",
  allowed.status === 0 && allowed.body === "", allowed);
check("POSITIVE CONTROL for the sentinel: an ALLOWED request DOES reach the routes, so the three non-reaches above are real",
  allowed.routeReached === true, allowed);


// ── 4b2. THE GATE THE HANDLER ACTUALLY CLOSES OVER (INTERIM GUARD) ──────────────────────────────
// A hole this suite CANNOT close from here, stated rather than papered over. Everything above builds
// its own gate; the shipped handler closes over the one created inside `web()`. Overwriting that one
// — `const gate = makeAuthGate(port); gate.check = () => undefined;` — opens the entire surface and
// leaves every cell green, because no cell here ever touches web()'s closure. Measured on a real
// gate: `check` goes from `{refuse:"unauthenticated"}` to `undefined`, i.e. allow-everything.
//
// The durable fix is an integration cell against the REAL server, which needs a running mesh and is
// NOT done here. This is an INTERIM structural guard: it pins the gate's creation and its ADJACENCY
// to the handler, so a statement inserted between them is caught.
//
// ITS BOUNDARY IS MEASURED, not estimated: the SAME overwrite moved BELOW the handler, just above
// `createServer`, leaves the adjacency intact and SURVIVES 128/128. So this guard catches insertion
// between the gate and the handler and nothing else. Anyone reading it should know that, which is
// why the survivor is written down here instead of being left for the next reviewer to rediscover.
{
  const decl = "  const gate = makeAuthGate(port);\n\n  const handleRequest = async (req: IncomingMessage, res: ServerResponse)";
  check("INTERIM: the handler's gate is created by makeAuthGate and NOTHING sits between that and the handler",
    webTs.includes(decl), { found: webTs.includes(decl) });
  check("CONTROL: the adjacency pin is not vacuous — a creation line that is not in the file is not found",
    !webTs.includes("  const gate = makeAuthGateNothing(port);"));
}

// ── 4c. THE TWO LAYERS, CAUSALLY JOINED ─────────────────────────────────────────────────────────
// Until now the gate was driven with real inputs and the handler was driven with HAND-BUILT
// verdicts, so the suite could hand the handler a `{refuse: …}` the gate itself could never mint,
// and a divergence between them was invisible. This drives a REAL `makeAuthGate` through the REAL
// lifted prefix — the same statements the browser reaches — so a verdict is produced by the gate and
// consumed by the handler in one causal chain, with no fixture in the middle.
{
  const handlerPrefix = webTs.slice(webTs.indexOf("\n", handlerAt) + 1, webTs.indexOf("\n\n", gateAt));
  check("NON-VACUITY: the handler prefix through the exchange branch was lifted",
    handlerPrefix.includes("gate.check(req, query)") && handlerPrefix.includes('"exchange" in verdict'),
    { len: handlerPrefix.length });
  const source = ts.transpileModule(`globalThis.__run = () => { ${handlerPrefix}\n__routeReached(); };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const drive = (gate: unknown, url: string, headers: Record<string, string> = {}) => {
    const rec = { status: 0, headers: {} as Record<string, string>, body: "", routeReached: false };
    const ctx: Record<string, unknown> = {
      req: { url, method: "GET", headers }, gate, URLSearchParams,
      res: {
        writeHead: (s: number, h: Record<string, string>) => { rec.status = s; rec.headers = h ?? {}; },
        end: (b?: string) => { rec.body = b ?? ""; },
      },
      CROSS_ORIGIN, SESSION_COOKIE: "cotal_web_session", READINESS_HEADER: "x-cotal-readiness",
      __routeReached: () => { rec.routeReached = true; }, globalThis: undefined, console, JSON,
    };
    ctx.globalThis = ctx;
    runInContext(source, createContext(ctx), { filename: "web.ts (handler prefix)" });
    (ctx.__run as () => void)();
    return rec;
  };
  const real = makeAuthGate(7799);
  const bare = drive(real, "/api/roster");
  check("REAL GATE → REAL HANDLER: a bare request is refused 401 and never reaches a route",
    bare.status === 401 && JSON.parse(bare.body).error === UNAUTHENTICATED && bare.routeReached === false, bare);
  const ex = drive(real, `/?k=${real.launchToken}`);
  check("REAL GATE → REAL HANDLER: the REAL launch token is exchanged for a cookie and redirected to `/`",
    ex.status === 302 && ex.headers.location === "/"
      && (ex.headers["set-cookie"] ?? "").startsWith("cotal_web_session="), ex);
  const session = (ex.headers["set-cookie"] ?? "").split(";")[0].split("=")[1];
  const replay = drive(real, `/?k=${real.launchToken}`);
  check("REAL GATE → REAL HANDLER: replaying the REAL spent token is refused as `launch-token-already-used`",
    replay.status === 401 && JSON.parse(replay.body).error === LAUNCH_TOKEN_ALREADY_USED, replay);
  const withNonce = drive(real, "/api/meta", { "x-cotal-readiness": real.readinessNonce });
  check("REAL GATE → REAL HANDLER: the REAL readiness nonce is accepted and reaches the route",
    withNonce.status === 0 && withNonce.routeReached === true, withNonce);
  check("NON-VACUITY: the session the REAL exchange minted is a non-empty secret",
    typeof session === "string" && session.length > 20, { len: session?.length });
  const foreign = drive(real, "/api/roster", { origin: "https://evil.example" });
  check("REAL GATE → REAL HANDLER: a cross-origin request is refused 403 by the condition the GATE chose",
    foreign.status === 403 && JSON.parse(foreign.body).error === CROSS_ORIGIN, foreign);
}

// ── 5. CONSTANT-TIME COMPARISON ─────────────────────────────────────────────────────────────────
// TIMING SAFETY IS NOT OBSERVABLE FROM OUTPUTS, so it cannot be tested functionally. Replacing the
// comparison with plain `===` produces an identical boolean for every vector in this file — measured,
// 103 cells stayed green while the constant-time property was gone. **A functional suite cannot see
// this class of regression at all**; the only honest cell is a structural one over the shipped helper.
const secretEqualsSrc = webTs.slice(
  webTs.indexOf("function secretEquals("),
  webTs.indexOf("/** Parse one cookie"),
);
check("NON-VACUITY: the shipped secretEquals body was located", secretEqualsSrc.includes("function secretEquals("),
  { len: secretEqualsSrc.length });
// PRESENCE ANYWHERE IS NOT THE PROPERTY. Asserting that the file CONTAINS `timingSafeEqual(ab, bb)`
// was satisfied by an UNREACHABLE call: `if (ab.length < 0) return timingSafeEqual(ab, bb); return
// ab.equals(bb);` keeps every text pin green at 114/114 and typechecks, while `Buffer.equals` is a
// memcmp that exits at the first differing byte. Measured on the lifted helper, 200k calls/batch,
// medians of 9 batches: a secret differing at index 0 vs index 42 cost 809ns/879ns with the shipped
// code (ratio 1.09) and 572ns/720ns with `equals` (ratio 1.26) — a byte-position oracle.
// So the cell asserts the DATAFLOW: the function's own final return returns that call.
const secretEqualsFn = (() => {
  const sf = ts.createSourceFile("web.ts", webTs, ts.ScriptTarget.ES2022, true);
  let found: ts.FunctionDeclaration | undefined;
  ts.forEachChild(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "secretEquals") found = n;
  });
  return found;
})();
const fnStmts = secretEqualsFn?.body?.statements ?? ts.factory.createNodeArray<ts.Statement>([]);
const lastStmt = fnStmts[fnStmts.length - 1];
check("NON-VACUITY: the shipped secretEquals was found IN THE AST with a body",
  secretEqualsFn !== undefined && fnStmts.length > 0, { statements: fnStmts.length });
check("secretEquals RETURNS the timing-safe comparison — its own final return, not a call parked somewhere unreachable",
  lastStmt !== undefined && ts.isReturnStatement(lastStmt)
    && lastStmt.expression?.getText() === "timingSafeEqual(ab, bb)",
  { last: lastStmt?.getText() });
check("…and does not short-circuit to a plain string comparison",
  !/return\s+a\s*===\s*b/.test(secretEqualsSrc), { secretEqualsSrc });
// THE LENGTH-MISMATCH BRANCH IS A SEPARATE PROPERTY, and pinning the equal-length compare did not
// cover it: deleting the dummy `timingSafeEqual(ab, ab)` left 112/112 green. Unlike the `===` case
// above, this one IS measurable — lifting the shipped helper and timing 200k calls per batch,
// medians of 9 batches, a length mismatch went from 1034ns (dummy present, 1.05x the same-length
// cost) to 572ns (dummy deleted, 1.69x cheaper). That is the secret's LENGTH leaking through timing.
// It is pinned structurally rather than with a timing cell because a timing cell on a loaded CI
// runner is flaky, and a flaky cell is worse than an honest structural one.
check("…and the LENGTH-MISMATCH branch still does the work before failing, so a wrong length costs the same as a wrong value",
  secretEqualsSrc.includes("timingSafeEqual(ab, ab)"), { secretEqualsSrc });

// ── 6. THE SESSION FILE'S MODE, DRIVEN AGAINST A REAL FILE ──────────────────────────────────────
// This file holds the launch URL and the readiness nonce, so its mode is a credential boundary. No
// cell reached it at all: deleting the descriptor chmod, or writing 0644, went 68/68 green. And the
// bug it guards is specifically the STALE file — `mode:` on writeFileSync applies at CREATION only,
// so the interesting case is a pre-existing permissive file, not a fresh one.
{
  const writeBlock = webTs.slice(
    webTs.indexOf('    const sfd = openSync(sessionPath, "w", 0o600);'),
    webTs.indexOf("    process.once(\"exit\", () => rmSync(sessionPath, { force: true }));"),
  );
  check("the session-file write block was lifted out of the shipped source", writeBlock.includes("openSync("),
    { len: writeBlock.length });
  check("CONTROL: a block that is not in the file lifts nothing",
    webTs.indexOf('    const sfd = openSyncNothing(') === -1);

  const dir = mkdtempSync(join(tmpdir(), "cotal-web-session-"));
  const sessionPath = join(dir, "web.session");
  // PRE-CREATE IT PERMISSIVE. This is the whole point: a fresh file would pass even with the chmod
  // deleted, so a cell that only ever writes a new file proves nothing about the defect.
  // fchmod ON THE DESCRIPTOR, because `mode:` at creation is masked by the process umask — under
  // `umask 077` the "permissive" fixture was created 0600 and the non-vacuity cell below failed
  // before any shipped code ran. A suite whose result depends on the operator's umask is not a
  // suite; the fixture has to set the mode it claims to set.
  {
    const pfd = openSync(sessionPath, "w");
    try { fchmodSync(pfd, 0o644); writeFileSync(pfd, "stale"); } finally { closeSync(pfd); }
  }
  check("NON-VACUITY: the stale file really is permissive before the shipped block runs",
    (statSync(sessionPath).mode & 0o777) === 0o644, (statSync(sessionPath).mode & 0o777).toString(8));

  const source = ts.transpileModule(`globalThis.__write = () => { ${writeBlock} };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  // THE MODE AT THE INSTANT OF THE WRITE, not afterwards. Swapping the chmod and the write leaves the
  // final mode 0600 and the final content correct — so a cell that inspects the file afterwards
  // passes while the secret was written into a WORLD-READABLE file and narrowed a moment later. A
  // credential exposed for an instant is exposed. This wrapper records the descriptor's mode at the
  // moment the bytes go in.
  let modeAtWrite: number | undefined;
  const recordingWrite = (fd: number, data: string) => {
    modeAtWrite = fstatSync(fd as number).mode & 0o777;
    return writeFileSync(fd, data);
  };
  const ctx: Record<string, unknown> = {
    openSync, fchmodSync, writeFileSync: recordingWrite, closeSync, JSON,
    sessionPath, launchUrl: "http://127.0.0.1:7799/?k=x", gate: { readinessNonce: "n" },
    globalThis: undefined, console,
  };
  ctx.globalThis = ctx;
  runInContext(source, createContext(ctx), { filename: "web.ts (session write)" });
  (ctx.__write as () => void)();

  check("the secret is written into an ALREADY-0600 descriptor — narrowed BEFORE the bytes, not after",
    modeAtWrite === 0o600, { modeAtWrite: modeAtWrite?.toString(8) });
  check("the shipped write NARROWS a stale permissive session file to 0600 (mode is enforced on every write, not only at creation)",
    (statSync(sessionPath).mode & 0o777) === 0o600, (statSync(sessionPath).mode & 0o777).toString(8));
  // BOTH FIELDS. The file is a two-field credential and only one of them was asserted: dropping
  // `readiness` from the written JSON left the mode cells and the launch-URL cell green at 110/110,
  // while the parent's reader derived `undefined` — measured — so `--detach` would send no readiness
  // header, poll a surface that correctly refuses it, and time out. Parse once, assert both.
  const written = JSON.parse(readFileSync(sessionPath, "utf8")) as Record<string, unknown>;
  check("…and the file still holds the launch URL it was asked to write",
    written.launchUrl === "http://127.0.0.1:7799/?k=x", written);
  check("…AND the readiness nonce, the second credential `--detach` polls with (without it the parent sends no header and never sees ready)",
    written.readiness === "n", written);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nCONSOLE AUTH SMOKE OK ✅  (${pass} passed, 0 failed)`);

/** Real HTTP proof reads: one advertised 429 retry shares the original timeout and cancellation.
 * No exchange or manager mutation is represented by this fixture. */
import { createServer, type ServerResponse } from "node:http";
import { createSuite } from "@cotal-ai/smoke-kit";
import { fetchIdpJwt, IdpLoginCancelled, IdpRateLimitedError, IdpSessionRejectedError, IdpUnreachableError } from "@cotal-ai/auth";

const { check, finish } = createSuite();
const priorTimeout = process.env.COTAL_IDP_TIMEOUT_MS;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: "fixture", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.fixture`;
const send = (res: ServerResponse, status: number, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(status === 200 ? { token: jwt } : { error: "test-local refusal" }));
};
async function fixture(run: (url: string, times: number[]) => Promise<void>, response: (res: ServerResponse, count: number) => void, timeout = 5000) {
  process.env.COTAL_IDP_TIMEOUT_MS = String(timeout);
  const times: number[] = [];
  const server = createServer((_req, res) => { times.push(Date.now()); response(res, times.length); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test IdP did not bind");
  try { await run(`http://127.0.0.1:${address.port}/api/auth`, times); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
async function failure(work: Promise<unknown>): Promise<unknown> {
  try { await work; return undefined; } catch (e) { return e; }
}
try {
  for (const [label, headers, minimum] of [
    ["standard seconds", { "retry-after": "1" }, 1000],
    ["native seconds", { "x-retry-after": "1" }, 1000],
    ["later of both", { "retry-after": "1", "x-retry-after": "2" }, 2000],
    ["valid native despite malformed standard", { "retry-after": "bad", "x-retry-after": "1" }, 1000],
    ["zero is bounded", { "x-retry-after": "0" }, 1000],
  ] as const) {
    await fixture(async (url, times) => {
      check(`${label}: the proof succeeds`, await fetchIdpJwt(url, label) === jwt);
      check(`${label}: exactly one retry`, times.length === 2, times.length);
      check(`${label}: no early retry`, times[1]! - times[0]! >= minimum - 40, times);
      check(`${label}: the successful proof is held`, await fetchIdpJwt(url, label) === jwt && times.length === 2);
    }, (res, count) => send(res, count === 1 ? 429 : 200, count === 1 ? headers : {}));
  }
  let advertised = 0;
  await fixture(async (url, times) => {
    check("HTTP date succeeds", await fetchIdpJwt(url, "date") === jwt);
    check("HTTP date waits until the advertised instant", times.length === 2 && times[1]! >= advertised - 40, times);
  }, (res, count) => {
    advertised ||= Math.ceil((Date.now() + 1500) / 1000) * 1000;
    send(res, count === 1 ? 429 : 200, count === 1 ? { "retry-after": new Date(advertised).toUTCString() } : {});
  });
  for (const [label, headers, seconds] of [
    ["missing hint", {}, undefined],
    ["malformed hints", { "retry-after": "bad", "x-retry-after": "soon" }, undefined],
    ["negative native hint", { "x-retry-after": "-1" }, undefined],
    ["nonfinite native hint", { "x-retry-after": "9".repeat(400) }, undefined],
    ["outside budget", { "x-retry-after": "30" }, 30],
    ["standard outside budget", { "retry-after": "30" }, 30],
    ["later terminal hint", { "retry-after": "40", "x-retry-after": "30" }, 40],
    ["valid terminal native", { "retry-after": "bad", "x-retry-after": "30" }, 30],
  ] as const) {
    await fixture(async (url, times) => {
      const error = await failure(fetchIdpJwt(url, label));
      check(`${label}: keeps the HTTP refusal`, error instanceof Error && error.message.includes("HTTP 429"), String(error));
      check(`${label}: public typed status`, error instanceof IdpRateLimitedError && error.status === 429, error);
      check(`${label}: provider delay only`, error instanceof IdpRateLimitedError && error.retryAfterSeconds === seconds, error);
      check(`${label}: no speculative retry`, times.length === 1, times.length);
    }, (res) => send(res, 429, headers), 1200);
  }
  for (const [label, headers] of [
    ["zero terminal hint", { "retry-after": "0" }],
    ["past terminal date", { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }],
  ] as const) {
    await fixture(async (url, times) => {
      const error = await failure(fetchIdpJwt(url, label));
      check(`${label}: no invented retry floor`, error instanceof IdpRateLimitedError && error.status === 429 && error.retryAfterSeconds === 0, error);
      check(`${label}: wait does not fit`, times.length === 1, times.length);
    }, (res) => send(res, 429, headers), 500);
  }
  let terminalDate = 0;
  await fixture(async (url, times) => {
    const before = Date.now();
    const error = await failure(fetchIdpJwt(url, "terminal date"));
    const after = Date.now();
    check("terminal date: typed status", error instanceof IdpRateLimitedError && error.status === 429, error);
    check("terminal date: minimum remaining seconds", error instanceof IdpRateLimitedError && typeof error.retryAfterSeconds === "number" && error.retryAfterSeconds >= (terminalDate - after) / 1000 && error.retryAfterSeconds <= (terminalDate - before) / 1000, error);
    check("terminal date: no over-budget retry", times.length === 1, times.length);
  }, (res) => {
    terminalDate = Math.ceil((Date.now() + 30_000) / 1000) * 1000;
    send(res, 429, { "retry-after": new Date(terminalDate).toUTCString(), "x-retry-after": "2" });
  }, 1200);
  for (const status of [401, 403, 503]) {
    await fixture(async (url, times) => {
      const error = await failure(fetchIdpJwt(url, String(status)));
      check(`${status}: remains a refusal`, error instanceof Error);
      check(`${status}: not a rate limit`, !(error instanceof IdpRateLimitedError));
      if (status === 401) check("401: session rejection stays typed", error instanceof IdpSessionRejectedError);
      check(`${status}: never retried`, times.length === 1, times.length);
    }, (res) => send(res, status, { "retry-after": "1" }));
  }
  await fixture(async (url, times) => {
    const error = await failure(fetchIdpJwt(url, "repeated"));
    check("repeated 429 remains a refusal", error instanceof Error && error.message.includes("HTTP 429"));
    check("repeated 429 uses final response timing", error instanceof IdpRateLimitedError && error.status === 429 && error.retryAfterSeconds === 30, error);
    check("repeated 429 stops after two requests", times.length === 2, times.length);
    check("a failed proof is not held", await fetchIdpJwt(url, "repeated") === jwt && times.length === 3);
  }, (res, count) => send(res, count <= 2 ? 429 : 200, { "x-retry-after": count === 1 ? "1" : "30" }));
  await fixture(async (url, times) => {
    const errors = await Promise.all(Array.from({ length: 8 }, () => failure(fetchIdpJwt(url, "shared refusal"))));
    check("concurrent refusal: same typed failure", errors[0] instanceof IdpRateLimitedError && errors.every((error) => error === errors[0]), errors);
    check("concurrent refusal: no invented hint on final response", errors[0] instanceof IdpRateLimitedError && errors[0].retryAfterSeconds === undefined, errors[0]);
    check("concurrent refusal: one shared retry", times.length === 2, times.length);
    check("concurrent refusal: failure is not cached", await fetchIdpJwt(url, "shared refusal") === jwt && times.length === 3);
  }, (res, count) => send(res, count <= 2 ? 429 : 200, count === 1 ? { "x-retry-after": "1" } : {}));
  await fixture(async (url, times) => {
    const controller = new AbortController();
    const pending = failure(fetchIdpJwt(url, "cancel", controller.signal));
    await pause(120); controller.abort();
    check("cancel during advertised wait stays caller cancellation", await pending instanceof IdpLoginCancelled);
    await pause(1050);
    check("cancelled wait never retries later", times.length === 1, times.length);
  }, (res) => send(res, 429, { "x-retry-after": "1" }));
  for (const body of [false, true]) {
    await fixture(async (url, times) => {
      const start = Date.now();
      const error = await failure(fetchIdpJwt(url, body ? "body" : "headers"));
      const elapsed = Date.now() - start;
      check(`${body ? "body" : "headers"}: retry shares one timeout`, elapsed >= 1200 && elapsed < 2500, elapsed);
      check(`${body ? "body" : "headers"}: timeout is not caller cancellation`, error instanceof IdpUnreachableError && !(error instanceof IdpLoginCancelled), String(error));
      check(`${body ? "body" : "headers"}: exactly two requests`, times.length === 2, times.length);
    }, (res, count) => {
      if (count === 1) send(res, 429, { "x-retry-after": "1" });
      else if (body) { res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); }
    }, 1400);
  }
  await fixture(async (url, times) => {
    const values = await Promise.all(Array.from({ length: 8 }, () => fetchIdpJwt(url, "shared")));
    check("concurrent uncancelled callers share the retry", values.every((value) => value === jwt) && times.length === 2, times.length);
  }, (res, count) => send(res, count === 1 ? 429 : 200, { "x-retry-after": "1" }));
} catch (e) {
  check("HTTP proof fixture completes", false, String(e));
} finally {
  if (priorTimeout === undefined) delete process.env.COTAL_IDP_TIMEOUT_MS;
  else process.env.COTAL_IDP_TIMEOUT_MS = priorTimeout;
}
finish();

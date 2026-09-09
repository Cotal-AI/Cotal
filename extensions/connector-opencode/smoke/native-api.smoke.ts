import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { OpenCodeNativeApi, OpenCodeNativeApiError } from "../src/native-api.js";

const nativeSession = {
  id: "ses_fixture123", projectID: "project-fixture", directory: "/fixture/project",
  version: "1.18.15", time: { created: 123, updated: 456 },
};
const requests: { method: string; path: string; authorization?: string }[] = [];
let answer: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end("{}");
const server = createServer((req, res) => {
  requests.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization });
  res.setHeader("content-type", "application/json");
  answer(req, res);
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const endpoint = `http://127.0.0.1:${address.port}`;
const api = new OpenCodeNativeApi({ endpoint, password: "fixture-password" });
const rejects = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof OpenCodeNativeApiError);
  assert.equal(error.code, code);
  return true;
};

try {
  await test("client construction is side-effect-free and rejects unsafe locators", () => {
    const before = requests.length;
    for (const url of ["file:///fixture", "http://user:password@127.0.0.1", "http://192.0.2.1", `${endpoint}?token=x`, `${endpoint}/nested/`, `${endpoint}#fragment`]) {
      assert.throws(() => new OpenCodeNativeApi({ endpoint: url }), rejects("invalid-config"));
    }
    assert.throws(() => new OpenCodeNativeApi({ endpoint, username: "owner" }), rejects("invalid-config"));
    assert.throws(() => new OpenCodeNativeApi({ endpoint, timeoutMs: 0 }), rejects("invalid-config"));
    assert.throws(() => new OpenCodeNativeApi({ endpoint, maxResponseBytes: Infinity }), rejects("invalid-config"));
    assert.equal(requests.length, before);
  });
  await test("health, session list, exact readback and status reach the HTTP server", async () => {
    answer = (req, res) => {
      const value = req.url === "/global/health" ? { healthy: true, version: "1.18.15" }
        : req.url === "/session" ? [nativeSession]
        : req.url === "/session/status" ? { ses_fixture123: { type: "busy" } }
        : nativeSession;
      res.end(JSON.stringify(value));
    };
    assert.deepEqual(await api.health(), { version: "1.18.15" });
    const list = await api.sessions();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], { id: "ses_fixture123", projectID: "project-fixture", directory: "/fixture/project", createdAt: 123, updatedAt: 456 });
    assert.deepEqual(await api.session("ses_fixture123"), list[0]);
    assert.equal((await api.statuses()).ses_fixture123.type, "busy");
    assert.equal(requests.at(-1)?.authorization, `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`);
    assert.ok(requests.every(request => request.method === "GET"));
  });
  await test("an invalid session selector refuses before HTTP", async () => {
    const before = requests.length;
    await assert.rejects(api.session("../global/dispose"), rejects("invalid-session"));
    assert.equal(requests.length, before);
  });
  await test("readback cannot silently select another session", async () => {
    answer = (_req, res) => res.end(JSON.stringify({ ...nativeSession, id: "ses_other" }));
    await assert.rejects(api.session("ses_fixture123"), rejects("invalid-response"));
  });
  await test("missing identity fields and duplicate IDs are invalid native responses", async () => {
    answer = (_req, res) => res.end(JSON.stringify({ ...nativeSession, time: {} }));
    await assert.rejects(api.session("ses_fixture123"), rejects("invalid-response"));
    answer = (_req, res) => res.end(JSON.stringify([nativeSession, nativeSession]));
    await assert.rejects(api.sessions(), rejects("invalid-response"));
    answer = (_req, res) => res.end(JSON.stringify({ ses_fixture123: { type: "not-a-status" } }));
    await assert.rejects(api.statuses(), rejects("invalid-response"));
  });
  await test("auth failures, missing sessions and server errors stay distinct and scrubbed", async () => {
    for (const [status, code] of [[401, "unauthorized"], [403, "unauthorized"], [404, "not-found"], [500, "http-error"]] as const) {
      answer = (_req, res) => { res.statusCode = status; res.end("sensitive-native-error-detail"); };
      await assert.rejects(api.session("ses_fixture123"), (error: unknown) => {
        assert.ok(error instanceof OpenCodeNativeApiError);
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        assert.ok(!error.message.includes("sensitive-native-error-detail"));
        assert.ok(!error.message.includes("fixture-password"));
        return true;
      });
    }
  });
  await test("redirects never forward native credentials", async () => {
    answer = (_req, res) => { res.statusCode = 302; res.setHeader("location", `${endpoint}/credential-capture`); res.end(); };
    const before = requests.length;
    await assert.rejects(api.health(), rejects("transport"));
    assert.equal(requests.length, before + 1);
    assert.ok(requests.every(request => request.path !== "/credential-capture"));
  });
  await test("malformed JSON and UTF-8 are rejected", async () => {
    answer = (_req, res) => res.end("{");
    await assert.rejects(api.health(), rejects("invalid-response"));
    answer = (_req, res) => res.end(Buffer.from([0xff]));
    await assert.rejects(api.health(), rejects("invalid-response"));
  });
  await test("response limits count bytes and do not truncate into success", async () => {
    answer = (_req, res) => res.end(JSON.stringify({ healthy: true, version: "x".repeat(1000) }));
    const bounded = new OpenCodeNativeApi({ endpoint, maxResponseBytes: 64 });
    await assert.rejects(bounded.health(), rejects("response-too-large"));
  });
  await test("the deadline covers a stalled response body", async () => {
    answer = (_req, res) => { res.writeHead(200); res.write("{"); };
    const bounded = new OpenCodeNativeApi({ endpoint, timeoutMs: 75 });
    await assert.rejects(bounded.health(), rejects("timeout"));
  });
  await test("caller cancellation is distinguishable from timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(api.health(controller.signal), rejects("cancelled"));
  });
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

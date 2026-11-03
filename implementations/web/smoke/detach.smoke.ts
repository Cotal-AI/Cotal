import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEB_READINESS_HEADER } from "@cotal-ai/workspace";
import { appendedLogTail, detachedArgs, terminateDetachedWeb, waitForDetachedWeb } from "../src/web.js";

const root = mkdtempSync(join(tmpdir(), "cotal-web-detach-"));
const pidPath = join(root, "web.pid");
const sessionPath = join(root, "web.session");
const readyPath = join(root, "child.ready");

/** A deliberately SIGTERM-resistant, detached, unref'd fixture child. It still ignores SIGTERM
 *  (that resistance is what this suite tests), but it takes a deadline in milliseconds from its
 *  own first argument and exits on its own once that deadline passes, so a copy that is never
 *  collected by the suite's `finally` reaps itself instead of surviving forever. */
const FIXTURE_DEADLINE_MS = 60_000;
function spawnFixture(readyMarkerPath: string, deadlineMs: number) {
  const child = spawn(process.execPath, [
    "-e",
    `const fs=require("node:fs"); process.on("SIGTERM",()=>{}); fs.writeFileSync(${JSON.stringify(readyMarkerPath)}, "ready"); const deadlineMs=Number(process.argv[1]); setTimeout(()=>process.exit(0), deadlineMs);`,
    String(deadlineMs),
  ], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

const child = spawnFixture(readyPath, FIXTURE_DEADLINE_MS);

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  assert.deepEqual(
    detachedArgs(["--detach", "--space=old", "--server=old:1", "--host", "192.0.2.10", "--port", "8123", "--no-open"], "new", "nats://new:2"),
    ["--host", "192.0.2.10", "--port", "8123", "--space", "new", "--server", "nats://new:2", "--no-open"],
    "equals-form targets are replaced without consuming the following flag",
  );
  assert.deepEqual(
    detachedArgs(["--space", "old", "--server", "old:1", "--detach"], "new", "nats://new:2"),
    ["--space", "new", "--server", "nats://new:2", "--no-open"],
    "split-form targets are replaced and child-only flags are normalized",
  );

  const missing = spawn(join(root, "missing-cotal-binary"), [], { stdio: "ignore" });
  await assert.rejects(
    waitForDetachedWeb(missing, { pidPath, sessionPath, url: "http://127.0.0.1:1/", space: "fixture", timeoutMs: 100 }),
    /failed to start:.*(?:ENOENT|no such file)/i,
    "no-PID spawn failures retain the operating-system cause",
  );

  const logPath = join(root, "web.log");
  const old = "old-attempt\n";
  writeFileSync(logPath, old + "x".repeat(6000), { mode: 0o600 });
  const tail = appendedLogTail(logPath, Buffer.byteLength(old));
  assert.ok(Buffer.byteLength(tail) <= 4096, "attempt diagnostics are capped at 4096 bytes");
  assert.equal(tail.includes("old-attempt"), false, "attempt diagnostics exclude historical bytes");
  // POSIX-only: Windows' fs does not honor mode bits (the file reads back 0o666), so 0o600 privacy is
  // a POSIX concept there — Windows scopes access via ACLs instead. Assert it only where it applies.
  if (process.platform !== "win32") assert.equal(statSync(logPath).mode & 0o777, 0o600, "fixture log is private");

  assert.ok(child.pid, "fixture child has a pid");
  for (let i = 0; i < 100 && !existsSync(readyPath); i++) await sleep(10);
  assert.ok(existsSync(readyPath), "SIGTERM-resistant fixture child became ready");
  writeFileSync(pidPath, String(child.pid));

  const selfReapReadyPath = join(root, "self-reap.ready");
  const selfReapChild = spawnFixture(selfReapReadyPath, 500);
  assert.ok(selfReapChild.pid, "self-reap fixture child has a pid");
  let selfReaped = false;
  for (let i = 0; i < 300 && !selfReaped; i++) {
    await sleep(10);
    selfReaped = !alive(selfReapChild.pid!);
  }
  assert.ok(selfReaped, "a leaked fixture child with a short deadline reaps itself, with no signal sent to it");

  await assert.rejects(
    waitForDetachedWeb(child, {
      pidPath,
      sessionPath,
      url: "http://127.0.0.1:1/",
      space: "fixture",
      timeoutMs: 100,
    }),
    /did not become HTTP-ready within 100ms \(pid \d+\); last probe http:\/\/127\.0\.0\.1:1\/api\/meta: .+/,
  );
  // A pidfile that exists and cannot be read is not "not claimed yet". A directory at the name is
  // EISDIR for every user, where mode 000 is not, and the wait names it instead of probing until
  // the window ends.
  rmSync(pidPath, { force: true });
  mkdirSync(pidPath);
  const unreadableStarted = Date.now();
  await assert.rejects(
    waitForDetachedWeb(child, {
      pidPath,
      sessionPath,
      url: "http://127.0.0.1:1/",
      space: "fixture",
      timeoutMs: 1500,
    }),
    new RegExp(`cannot read ${pidPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: EISDIR`),
    "an unreadable pidfile is named instead of waiting out the readiness window",
  );
  assert.ok(Date.now() - unreadableStarted < 1000, "an unreadable pidfile does not wait out the readiness window");
  rmSync(pidPath, { recursive: true, force: true });
  writeFileSync(pidPath, String(child.pid));
  // A different process on the bound port answers 200 with a huge space and pid whose JSON escaping
  // turns each character into six bytes: the last-probe text still stays within its 300-byte cap.
  const squatter = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ space: "\u0001".repeat(200_000), pid: "\u0001".repeat(200_000) }));
  });
  await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  try {
    const port = (squatter.address() as { port: number }).port;
    let message = "";
    await waitForDetachedWeb(child, {
      pidPath,
      sessionPath,
      url: `http://127.0.0.1:${port}/`,
      space: "fixture",
      timeoutMs: 600,
    }).catch((e: unknown) => { message = e instanceof Error ? e.message : String(e); });
    assert.match(message, /did not become HTTP-ready within 600ms \(pid \d+\); last probe http:\/\/127\.0\.0\.1:\d+\/api\/meta: answered space "(?:\\u0001){40}\.\.\."/);
    const lastProbe = message.slice(message.indexOf("; last probe ") + "; last probe ".length);
    assert.ok(Buffer.byteLength(lastProbe) <= 300, `last-probe text stays within its 300-byte cap (got ${Buffer.byteLength(lastProbe)} bytes)`);
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }

  // #3678: the probe does not follow a redirect. Whatever owns the port answers `/api/meta` with a
  // redirect to a path or origin it controls, where it answers with this dashboard's space and pid.
  // That is not ready, and the readiness nonce reaches no path but `/api/meta`. The same server
  // answering `/api/meta` itself is ready, so the refusal comes from the redirect, not the fixture.
  const nonce = "fixture-readiness-nonce";
  const nonceAt: string[] = [];
  let stealRequests = 0;
  const answerMeta = (res: ServerResponse) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ space: "fixture", pid: child.pid }));
  };
  const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as { port: number }).port };
  };
  const other = await listen((req, res) => {
    if (req.headers[WEB_READINESS_HEADER] === nonce) nonceAt.push(`other:${req.url}`);
    if (req.url === "/steal") { stealRequests++; return answerMeta(res); }
    res.writeHead(404).end();
  });
  let answer: { code: number; location: string } | "meta" = "meta";
  const bound = await listen((req, res) => {
    if (req.headers[WEB_READINESS_HEADER] === nonce) nonceAt.push(req.url ?? "");
    if (req.url === "/steal") { stealRequests++; return answerMeta(res); }
    if (req.url !== "/api/meta") return res.writeHead(404).end();
    if (answer === "meta") return answerMeta(res);
    res.writeHead(answer.code, { location: answer.location }).end();
  });
  writeFileSync(sessionPath, JSON.stringify({ launchUrl: `http://127.0.0.1:${bound.port}/`, readiness: nonce, host: "127.0.0.1", port: bound.port }));
  try {
    const redirects = [
      ...[301, 302, 307, 308].map((code) => ({ code, location: "/steal" })),
      { code: 302, location: `http://127.0.0.1:${other.port}/steal` },
    ];
    for (const redirect of redirects) {
      answer = redirect;
      nonceAt.length = 0;
      stealRequests = 0;
      await assert.rejects(
        waitForDetachedWeb(child, { pidPath, sessionPath, url: `http://127.0.0.1:${bound.port}/`, space: "fixture", timeoutMs: 600 }),
        new RegExp(`did not become HTTP-ready within 600ms \\(pid \\d+\\); last probe http://127\\.0\\.0\\.1:${bound.port}/api/meta: HTTP ${redirect.code}$`),
        `a ${redirect.code} to ${redirect.location} is not ready`,
      );
      assert.ok(nonceAt.length > 0, `the probe presented the nonce on /api/meta (${redirect.code} to ${redirect.location})`);
      assert.deepEqual([...new Set(nonceAt)], ["/api/meta"], `the nonce reaches only /api/meta (${redirect.code} to ${redirect.location})`);
      assert.equal(stealRequests, 0, `the redirect target is never requested (${redirect.code} to ${redirect.location})`);
    }
    answer = "meta";
    nonceAt.length = 0;
    const session = await waitForDetachedWeb(child, { pidPath, sessionPath, url: `http://127.0.0.1:${bound.port}/`, space: "fixture", timeoutMs: 2000 });
    assert.equal(session.readiness, nonce, "the same server answering /api/meta itself is ready");
    assert.deepEqual([...new Set(nonceAt)], ["/api/meta"], "the ready probe presented the nonce on /api/meta only");
    console.log(`web detach smoke: ${redirects.length} redirects refused, nonce kept on /api/meta, direct answer ready`);
  } finally {
    await new Promise<void>((resolve) => bound.server.close(() => resolve()));
    await new Promise<void>((resolve) => other.server.close(() => resolve()));
  }

  await terminateDetachedWeb(child, pidPath);
  assert.equal(alive(child.pid!), false, "timeout cleanup escalates and confirms child death");
  assert.equal(existsSync(pidPath), false, "timeout cleanup removes the exact child-owned pidfile");

  writeFileSync(pidPath, "999999");
  await terminateDetachedWeb(child, pidPath);
  assert.equal(readFileSync(pidPath, "utf8"), "999999", "cleanup preserves a replacement pidfile owner");

  console.log("web detach smoke: timeout teardown and pid ownership passed");
} finally {
  if (child.pid && alive(child.pid)) {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
  }
  rmSync(root, { recursive: true, force: true });
}

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, awaitBrokerReady, brokerHeap, emitSentinel, recordSmokeSandbox } from "../src/index.js";

let checks = 0;
const check = (name: string, run: () => void): void => {
  assert.doesNotThrow(run, name);
  checks++;
  console.log(`  ✓ ${name}`);
};

const base = mkdtempSync(join(tmpdir(), "cotal-smoke-kit-package-"));
try {
  const root = join(base, "root");
  const cotalHome = join(base, "home");
  const xdgConfigHome = join(base, "config");
  const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome });
  const env = { COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdgConfigHome };
  check("recorded sandbox permits its own down command", () => assertSmokeSandboxDown(anchor, ["down"], { cwd: root, env }));
  assert.throws(() => assertSmokeSandboxDown(undefined, ["down"], { cwd: root, env }), /missing anchor/);
  checks++;
  console.log("  ✓ missing sandbox anchor is refused");
  check("non-destructive commands do not require the down guard", () => assertSmokeSandboxDown(anchor, ["status"], { cwd: root, env }));
} finally {
  rmSync(base, { recursive: true, force: true });
}

{
  let calls = 0;
  await awaitBrokerReady(async () => (++calls === 3), { servers: "nats://127.0.0.1:1", attempts: 5, delayMs: 1 });
  assert.equal(calls, 3);
  checks++;
  console.log("  ✓ awaitBrokerReady resolves once the probe answers true (after two delays)");
}

await (async () => {
  await assert.rejects(
    () => awaitBrokerReady(async () => false, { servers: "nats://127.0.0.1:2", attempts: 4, delayMs: 1 }),
    /nats:\/\/127\.0\.0\.1:2.*4 attempts.*no broker output collected/s,
  );
  checks++;
  console.log("  ✓ awaitBrokerReady throws on exhaustion naming the server and attempt count");
})();

await (async () => {
  await assert.rejects(
    () => awaitBrokerReady(async () => false, { servers: "nats://127.0.0.1:3", attempts: 2, delayMs: 1, output: () => "boot failed: address in use" }),
    /boot failed: address in use/,
  );
  checks++;
  console.log("  ✓ awaitBrokerReady's exhaustion message carries the collected broker output");
})();

await (async () => {
  await assert.rejects(
    () => awaitBrokerReady(async () => false, { servers: "nats://127.0.0.1:4", attempts: 2, delayMs: 1, output: () => "" }),
    /no broker output collected/,
  );
  checks++;
  console.log("  ✓ awaitBrokerReady names \"no broker output collected\" when output() is empty");
})();

{
  const prefix = "github.com/nats-io/nats-server/v2/server.";
  const record = (pc: string, caller: string) =>
    `1: 1048576 [1: 1048576] @ 0x${pc}\n` +
    `# 0x${pc} ${prefix}(*Server).createInternalClient+0x1 file.go:1\n` +
    `# 0xff ${prefix}${caller}+0x1 file.go:2\n`;
  const heap = "heap profile: 3: 3145728 [3: 3145728] @ heap/1048576\n" +
    record("aa", "(*client).init") + record("bb", "(*stream).init") + record("cc", "(*stream).init") +
    "\n# HeapAlloc = 3145728\n# HeapInuse = 4194304\n# Stack = 1048576\n# Sys = 8388608\n";
  const goroutines = `2 @ 0xaa\n# 0xaa ${prefix}(*client).readLoop+0x1 file.go:1\n`;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/debug/pprof/heap?gc=1&debug=1") res.end(heap);
    else if (req.url === "/debug/pprof/goroutine?debug=1") res.end(goroutines);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const profile = await brokerHeap(`http://127.0.0.1:${address.port}`);
    check("brokerHeap reads two heap profiles and one goroutine profile", () => assert.deepEqual(requests, [
      "/debug/pprof/heap?gc=1&debug=1", "/debug/pprof/heap?gc=1&debug=1", "/debug/pprof/goroutine?debug=1",
    ]));
    check("one function in two stack categories produces two site rows", () => assert.equal(profile.sites.length, 2));
    check("the connection site carries only its category's byte share", () => assert.equal(profile.sites.find((s) => s.part === "connections")?.mb, 1));
    check("repeated stream stacks aggregate in their own site row", () => assert.equal(profile.sites.find((s) => s.part === "streams")?.mb, 2));
    check("category totals retain the original allocation split", () => assert.deepEqual(profile.heapByPart, {
      consumers: 0, streams: 2, connections: 1, accounts: 0, other: 0,
    }));
    check("site rows still sum to the measured live heap", () => assert.equal(profile.sites.reduce((n, s) => n + s.mb, 0), profile.heapAllocMb));
    check("top sites rank site/category pairs by bytes", () => assert.deepEqual(profile.topSites, [
      { site: "server.(*Server).createInternalClient", part: "streams", mb: 2 },
      { site: "server.(*Server).createInternalClient", part: "connections", mb: 1 },
    ]));
    check("no site row exceeds the category it names", () => assert.ok(profile.sites.every((s) => s.mb <= profile.heapByPart[s.part])));
    check("goroutine attribution is unchanged", () => {
      assert.equal(profile.goroutines, 2);
      assert.equal(profile.goroutinesByPart.connections, 2);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

console.log(`SMOKE-KIT PACKAGE TESTS: ${checks} tests executed`);
emitSentinel({ passed: checks, failed: 0 });

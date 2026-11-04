import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, awaitBrokerReady, brokerHeap, emitSentinel, highwayHash64, recordSmokeSandbox, withDeadline } from "../src/index.js";

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
  // minio/highwayhash v1.0.4's 64-bit vectors: key 00..1f, input 00..n-1. These lengths reach every
  // remainder path: none, under 4, under 16, from 16, and whole 32-byte packets.
  const key = Uint8Array.from({ length: 32 }, (_, i) => i);
  for (const [length, want] of [
    [0, "536ec222de567a90"], [1, "78ddcdc7aa43ab7e"], [3, "803d468aabef6b5c"], [4, "da7e009368a405f2"],
    [7, "8294f53817ae024d"], [15, "3bf349a4863f7940"], [16, "32b87ef98934abcf"], [17, "e2c0c5c8d267fe19"],
    [31, "685a03cf7c00c79f"], [32, "fc80d5ecd964c9a0"], [33, "fc8131a03cf7902c"], [47, "081e916bc0ba2613"],
    [63, "a03921bfe9eb8eab"], [64, "ffa6d24c5d2c5475"],
  ] as const) assert.equal(Buffer.from(highwayHash64(key, Uint8Array.from({ length }, (_, i) => i))).toString("hex"), want, `HighwayHash-64 of ${length} bytes`);
  checks++;
  console.log("  ✓ highwayHash64 matches minio's HighwayHash-64 vectors, the checksum backdateMessages writes");
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

{
  const messages: string[] = [];
  const log = console.log;
  const equal = (actual: unknown, expected: unknown, name: string): void => {
    assert.equal(actual, expected, name);
    checks++;
  };
  console.log = (...parts: unknown[]) => { messages.push(parts.join(" ")); };
  try {
    const value = { arrived: true };
    equal(await withDeadline(Promise.resolve(value), 1_000, "the value"), value, "fulfilled object identity is preserved");
    for (const value of [false, 0, null, undefined])
      equal(await withDeadline(Promise.resolve(value), 1_000, "the falsy value"), value, "falsy fulfillment is preserved");
    equal(messages.length, 0, "undefined fulfillment does not log a timeout");
    equal(await withDeadline(Promise.resolve().then(() => true), 1_000, "the void drain"), true, "a fulfilled void drain has a completion marker");
    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => { resolvePending = resolve; });
    equal(await withDeadline(pending.then(() => true), 1, "the pending drain"), undefined, "a pending drain misses its deadline");
    equal(messages.length, 1, "a timeout logs once");
    equal(messages[0], "  ! the pending drain did not end within 1ms", "the diagnostic identifies the timed-out wait");
    resolvePending();
    await pending;
    equal(messages.length, 1, "late fulfillment creates no second diagnostic");
    const error = new Error("deadline rejection control");
    await assert.rejects(withDeadline(Promise.reject(error), 1_000, "the rejected wait"), (got: unknown) => got === error);
    checks++;
    equal(messages.length, 1, "rejection is not reported as a timeout");
    let rejectLate!: (error: Error) => void;
    const late = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
    equal(await withDeadline(late, 1, "the late rejection"), undefined, "the deadline can win before rejection");
    rejectLate(error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    equal(messages.length, 2, "late rejection is handled without another timeout diagnostic");
  } finally {
    console.log = log;
  }
  console.log("  ✓ deadline values, completion markers, diagnostics and rejections");

  // A retained 60-second timer would keep either child alive past the process deadline.
  const helper = new URL("../src/deadline.ts", import.meta.url).href;
  for (const promise of ["Promise.resolve('done')", "Promise.reject(new Error('expected'))"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { withDeadline } from ${JSON.stringify(helper)}; await withDeadline(${promise}, 60_000, 'timer cleanup').catch(() => undefined); process.stdout.write('finished');`,
    ], { encoding: "utf8", timeout: 10_000 });
    check(`deadline timer is cleared after ${promise.startsWith("Promise.resolve") ? "fulfillment" : "rejection"}`, () => {
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, "finished");
    });
  }
}

console.log(`SMOKE-KIT PACKAGE TESTS: ${checks} tests executed`);
emitSentinel({ passed: checks, failed: 0 });

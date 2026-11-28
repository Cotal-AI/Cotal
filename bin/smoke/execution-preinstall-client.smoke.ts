import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveDaemon } from "../daemon/server.js";
import { processBirth, holdLifetime } from "../daemon/lifetime.js";
import { observeUpdateDaemon, sameUpdateDaemon, assertUpdateDaemon } from "../daemon/update-lifetime.js";
import { PREINSTALL_TIMEOUT_MS, targetExecutionPreinstall } from "../daemon/execution-preinstall-client.js";

const root = mkdtempSync(join(tmpdir(), "execution-receipt-"));
try {
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", cotalPreinstall: { v: 1, entry: "./dist/check.js" } }));
  const installed = join(root, "installed.js");
  const check = join(root, "dist/check.js");
  const prefix = "const r=JSON.parse(process.argv[2]);const receipt={v:1,nonce:r.nonce,installedEntry:r.installedEntry,hostedSpaces:[],occupied:0,admission:{disposition:'restart-empty',occupied:0,hostedSpaces:[]}};";
  const receipt = "console.log('COTAL_PREINSTALL_RESULT '+JSON.stringify(receipt));";
  for (const [label, code, expected] of [
    ["accepted", `${prefix}${receipt}`, undefined],
    ["missing", "console.log('no receipt');", /no unique result/],
    ["duplicate", `${prefix}${receipt}${receipt}`, /no unique result/],
    ["wrong nonce", `${prefix}receipt.nonce='unbound';${receipt}`, /invalid evidence/],
    ["wrong entry", `${prefix}receipt.installedEntry='/other/install';${receipt}`, /invalid evidence/],
    ["negative seats", `${prefix}receipt.occupied=-1;${receipt}`, /invalid evidence/],
    ["malformed", "console.log('COTAL_PREINSTALL_RESULT {');", /JSON|Unexpected/],
    ["refused", "process.stderr.write('target policy refuses');process.exitCode=7;", /target policy refuses/],
    ["oversized", "process.stdout.write('x'.repeat(1024*1024+1));", /exceeded its limit/],
  ] as const) {
    writeFileSync(check, code);
    const run = () => targetExecutionPreinstall(root, installed, [process.execPath, installed, "daemon", "serve"], {});
    if (expected) await assert.rejects(run, expected, label);
    else assert.equal((await run()).occupied, 0);
  }
  writeFileSync(check, `${prefix}receipt.admission={disposition:'deferred',occupied:null,hostedSpaces:[],reason:'Manager state is unknown; restart deferred'};${receipt}`);
  const unknown = await targetExecutionPreinstall(root, installed, [process.execPath, installed, "daemon", "serve"], {});
  assert.equal(unknown.admission.occupied, null, "unknown occupancy remains null in the admission");
  assert.equal(unknown.occupied, 0, "the count released updaters validate stays an integer");
  for (const code of [
    "receipt.occupied=null;receipt.admission={disposition:'deferred',occupied:null,hostedSpaces:[],reason:'unknown'}",
    "receipt.admission={disposition:'restart-empty',occupied:null,hostedSpaces:[]}",
    "receipt.admission={disposition:'deferred',occupied:0,hostedSpaces:[],reason:''}",
    "receipt.occupied=1;receipt.admission={disposition:'consent-stop',occupied:1,hostedSpaces:[],inventory:[]}",
  ]) {
    writeFileSync(check, `${prefix}${code};${receipt}`);
    await assert.rejects(() => targetExecutionPreinstall(root, installed, [process.execPath, installed, "daemon", "serve"], {}), /invalid evidence/);
  }
  if (process.argv.includes("--deadline")) {
    writeFileSync(check, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
    const started = Date.now();
    await assert.rejects(() => targetExecutionPreinstall(root, installed, [process.execPath, installed, "daemon", "serve"], {}), /timed out/);
    assert.ok(Date.now() - started >= PREINSTALL_TIMEOUT_MS && Date.now() - started < PREINSTALL_TIMEOUT_MS + 10_000, "production timeout and forced child close remain bounded");
    console.log("execution preinstall timeout: real TERM-resistant child closed under the production deadline");
  }
  const dir = join(root, "r"), state = join(root, "s");
  for (const path of [dir, state]) mkdirSync(path, { mode: 0o700 });
  const paths = { dir, state, socket: join(dir, "d.sock"), lock: join(state, "daemon.lock") };
  assert.equal(await observeUpdateDaemon(paths), undefined);
  if (process.platform === "linux") {
    let connections = 0;
    const foreign = createServer(socket => { connections++; socket.destroy(); });
    await new Promise<void>((resolve, reject) => foreign.once("error", reject).listen(paths.socket, resolve));
    try {
      chmodSync(paths.socket, 0o600);
      assert.equal(await observeUpdateDaemon(paths), undefined, "a shared listener does not belong to a home with no lifetime lock");
    } finally { await new Promise<void>(resolve => foreign.close(() => resolve())); }
    assert.equal(connections, 0, "the unrelated listener was not contacted");
  }
  const daemon = await serveDaemon({ paths, version: "0.0.0-lifetime", sessionDir: state, stopAllowed: async () => false });
  try {
    const answered = daemon.counters.statusAnswered;
    const identity = await observeUpdateDaemon(paths);
    assert.deepEqual(identity, { pid: process.pid, start: processBirth(process.pid) });
    assert.equal(daemon.counters.statusAnswered, answered, "identity observation sends no status or Manager request");
    assertUpdateDaemon(identity, paths);
    assert.throws(() => assertUpdateDaemon({ ...identity!, start: "changed" }, paths), /lifetime changed/);
    assert.equal(sameUpdateDaemon(identity, undefined), false);
    assert.equal(sameUpdateDaemon(undefined, identity), false);
  } finally { await daemon.close(); }
  assert.equal(await observeUpdateDaemon(paths), undefined);
  writeFileSync(paths.lock, "malformed", { mode: 0o600 });
  await assert.rejects(observeUpdateDaemon(paths), /identity is unreadable/);
  writeFileSync(paths.lock, "", { mode: 0o600 });
  const held = holdLifetime(paths.lock);
  try { await assert.rejects(observeUpdateDaemon(paths), /held/); }
  finally { held.release(); }
  console.log("execution preinstall transport: child evidence and native identity without Manager policy passed");
} finally { rmSync(root, { recursive: true, force: true }); }

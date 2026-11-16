import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetExecutionPreinstall } from "../daemon/execution-preinstall-client.js";

const root = mkdtempSync(join(tmpdir(), "execution-receipt-"));
try {
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", cotalPreinstall: { v: 1, entry: "./dist/check.js" } }));
  const installed = join(root, "installed.js");
  const check = join(root, "dist/check.js");
  const prefix = "const r=JSON.parse(process.argv[2]);if(r.admission!==1)throw Error('new reader omitted admission request');const receipt={v:1,nonce:r.nonce,installedEntry:r.installedEntry,admission:{disposition:'restart-empty',occupied:0,hostedSpaces:[]}};";
  const receipt = "console.log('COTAL_PREINSTALL_RESULT '+JSON.stringify(receipt));";
  for (const [label, code, expected] of [
    ["accepted", `${prefix}${receipt}`, undefined],
    ["missing", "console.log('no receipt');", /no unique result/],
    ["duplicate", `${prefix}${receipt}${receipt}`, /no unique result/],
    ["wrong nonce", `${prefix}receipt.nonce='unbound';${receipt}`, /invalid evidence/],
    ["wrong entry", `${prefix}receipt.installedEntry='/other/install';${receipt}`, /invalid evidence/],
    ["negative seats", `${prefix}receipt.admission.occupied=-1;${receipt}`, /invalid evidence/],
    ["malformed", "console.log('COTAL_PREINSTALL_RESULT {');", /JSON|Unexpected/],
    ["refused", "process.stderr.write('target policy refuses');process.exitCode=7;", /target policy refuses/],
    ["oversized", "process.stdout.write('x'.repeat(1024*1024+1));", /exceeded its limit/],
  ] as const) {
    writeFileSync(check, code);
    const run = () => targetExecutionPreinstall(root, installed, [process.execPath, installed, "daemon", "serve"], {});
    if (expected) await assert.rejects(run, expected, label);
    else assert.equal((await run()).admission.occupied, 0);
  }
  writeFileSync(check, `${prefix}receipt.hostedSpaces=['legacy-space'];receipt.admission={disposition:'deferred',occupied:null,hostedSpaces:[],reason:'Manager state is unknown; restart deferred'};${receipt}`);
  const deferred = await targetExecutionPreinstall(root, installed, [process.execPath, installed, "daemon", "serve"], {});
  assert.equal(deferred.admission.occupied, null, "new admission retains unknown occupancy independently");
  assert.deepEqual(deferred.admission.hostedSpaces, []);
  for (const code of [
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
    assert.ok(Date.now() - started >= 120_000 && Date.now() - started < 130_000, "production timeout and forced child close remain bounded");
    console.log("execution preinstall timeout: real TERM-resistant child closed under the production deadline");
  }
  console.log("execution preinstall transport: nine real child receipt/output/refusal cases passed");
} finally { rmSync(root, { recursive: true, force: true }); }

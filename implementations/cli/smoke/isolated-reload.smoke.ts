/** Real isolated maintenance broker reloads, with signal/log delivery delayed at the executable boundary. */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { emitSentinel, skipSuite, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { connectIsolatedBroker, startIsolatedBroker, type IsolatedBroker } from "../src/lib/isolated-broker.js";
import { resolveNatsServer } from "../src/lib/nats-bin.js";

if (process.platform === "win32") skipSuite("requires POSIX signal forwarding");

const real = (await resolveNatsServer()).path;
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}reload-`)));
const bin = join(scratch, "bin");
const control = join(scratch, "control.json");
mkdirSync(bin);
// The production watchdog owns this shim, which owns and reaps the real broker. A signal to the
// suite kills its coordinator; the watchdog then stops the shim and its child. No replacement NATS
// implementation or production test switch is involved.
writeFileSync(join(bin, "nats-server"), `#!${process.execPath}
const {spawn,spawnSync}=require('node:child_process');const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--version')){const r=spawnSync(${JSON.stringify(real)},args,{stdio:'inherit'});process.exit(r.status??1)}
const child=spawn(${JSON.stringify(real)},args,{stdio:['ignore','ignore','pipe']});
let split=false;
child.stderr.on('data',chunk=>{
  const text=chunk.toString();const at=text.indexOf('Reloaded server configuration');
  if(split&&at>=0){const cut=at+'Reloaded server config'.length;process.stderr.write(text.slice(0,cut));setTimeout(()=>process.stderr.write(text.slice(cut)),150);split=false}
  else process.stderr.write(chunk);
});
process.on('SIGHUP',()=>{
  const mode=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
  if(mode.action==='silent')return;
  if(mode.action==='exit'){child.kill('SIGTERM');return}
  if(mode.action==='reject')fs.writeFileSync(args[args.indexOf('-c')+1],'{ invalid configuration');
  split=mode.split??false;
  setTimeout(()=>child.kill('SIGHUP'),mode.delay??0);
});
process.on('SIGTERM',()=>child.kill('SIGTERM'));
process.on('SIGINT',()=>child.kill('SIGINT'));
child.on('exit',code=>process.exit(code??1));
`);
chmodSync(join(bin, "nats-server"), 0o755);
const originalPath = process.env.PATH;
process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
let passed = 0, failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}`, detail ?? ""); }
}
const scope = { profile: "infrastructure" as const, streams: ["RELOAD"] };
function mode(value: { action?: string; delay?: number; split?: boolean }): void {
  writeFileSync(control, JSON.stringify(value));
}
async function run(name: string, lifetime: number, body: (broker: IsolatedBroker) => Promise<void>): Promise<void> {
  const root = join(scratch, name); mkdirSync(root);
  mode({});
  const broker = await startIsolatedBroker({
    root, storeDir: join(root, "store"), space: "reload", mode: "open", label: "backup",
    deadline: new Date(Date.now() + lifetime), initialScope: scope,
  });
  try { await body(broker); } finally { await broker.stop(); }
}
async function failure(broker: IsolatedBroker): Promise<string> {
  try { await broker.addLogin(scope); return ""; }
  catch (error) { return (error as Error).message; }
}
try {
  await run("success", 10_000, async (broker) => {
    const immediate = await broker.addLogin(scope);
    const first = await connectIsolatedBroker(broker, immediate); await first.close();
    check("an immediate reload installs a usable maintenance login", true);
    mode({ delay: 500, split: true });
    let delayed;
    let error = "";
    try { delayed = await broker.addLogin(scope); } catch (cause) { error = (cause as Error).message; }
    check("a delayed reload with a split acknowledgement installs the next login", delayed !== undefined, error);
    if (delayed) {
      const current = await connectIsolatedBroker(broker, delayed); await current.close();
      let retired = false;
      try { const old = await connectIsolatedBroker(broker, immediate); await old.close(); } catch { retired = true; }
      check("the delayed reload retires the preceding maintenance principal", retired);
    }
  });
  await run("rejection", 10_000, async (broker) => {
    mode({ action: "reject", delay: 300 });
    const started = Date.now(), error = await failure(broker);
    check("a rejected reload reports the real broker rejection promptly", /broker rejected its maintenance-login reload/.test(error) && Date.now() - started < 3_000, error);
  });
  await run("exit", 10_000, async (broker) => {
    mode({ action: "exit" });
    const started = Date.now(), error = await failure(broker);
    check("broker exit refuses the reload promptly", /broker.*(exited|not running)/.test(error) && Date.now() - started < 3_000, error);
  });
  await run("deadline", 1_500, async (broker) => {
    // An old acknowledgement left unread before this call must not authorize the new config.
    const log = broker.runFiles.find((file) => file.path.endsWith(".log"))!;
    appendFileSync(log.path, "[INF] Reloaded server configuration\n");
    mode({ action: "silent" });
    const started = Date.now(), error = await failure(broker), elapsed = Date.now() - started;
    check("an old acknowledgement cannot authorize a reload with no response", /did not confirm its maintenance-login reload/.test(error), error);
    check("an unacknowledged reload waits until the operation deadline", /did not confirm its maintenance-login reload/.test(error) && elapsed >= 500 && elapsed < 3_000, { error, elapsed });
  });
  await run("bound", 30_000, async (broker) => {
    mode({ action: "silent" });
    const started = Date.now(), error = await failure(broker), elapsed = Date.now() - started;
    check("an unacknowledged reload has its own bound before a distant operation deadline", /did not confirm its maintenance-login reload/.test(error) && elapsed >= 10_000 && elapsed < 22_000, { error, elapsed });
  });
  console.log(`ISOLATED RELOAD SMOKE: ${passed} passed, ${failed} failed`);
  emitSentinel({ passed, failed });
  process.exitCode = failed ? 1 : 0;
} finally {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  rmSync(scratch, { recursive: true, force: true });
}

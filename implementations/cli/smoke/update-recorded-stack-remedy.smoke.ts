import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert;
const root = mkdtempSync(join(tmpdir(), "stack-remedy-"));
const project = join(root, "project with spaces"), home = join(root, "home"), fixture = join(root, "fixture");
for (const path of [project, join(project, ".cotal"), home, fixture, join(root, "config"), join(root, "cotal"), join(root, "tmp"), join(root, "rt")]) mkdirSync(path, { recursive: true, mode: 0o700 });
const repo = join(import.meta.dirname, "../../..");
const packed = process.env.COTAL_REMEDY_TEST_ENTRY;
const entry = packed ?? join(repo, "bin/cotal.ts");
const env = { ...process.env, HOME: home, COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "rt"), TMPDIR: join(root, "tmp"), COTAL_NO_UPDATE_CHECK: "1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
let latest = "99.0.0";
const server = createServer(async (request, response) => {
  if (decodeURIComponent(request.url ?? "") === "/cotal-ai") response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest }, versions: { [latest]: { name: "cotal-ai", version: latest } } }));
  else if (packed) {
    try {
      const upstream = await fetch(`https://registry.npmjs.org${request.url}`, { headers: { accept: request.headers.accept ?? "application/json" } });
      response.writeHead(upstream.status); response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) { response.writeHead(502).end(String(error)); }
  } else response.writeHead(404).end("metadata only");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no private registry port");
const registry = `http://127.0.0.1:${address.port}`;
const core = packed ? pathToFileURL(join(dirname(packed), "../node_modules/@cotal-ai/core/dist/index.js")).href : pathToFileURL(join(repo, "packages/core/dist/index.js")).href;
const seat = join(fixture, "seat.mjs");
writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "cotal-stack-remedy-fixture", version: "0.0.1", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
writeFileSync(seat, `import{CotalEndpoint}from${JSON.stringify(core)};const e=process.env;const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,card:{id:e.COTAL_ID,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});await ep.start();setInterval(()=>{},1000);for(const s of['SIGINT','SIGTERM'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));`);
writeFileSync(join(fixture, "index.js"), `import{registry}from${JSON.stringify(core)};registry.register({kind:'connector',name:'stack-remedy-seat',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[${JSON.stringify(seat)}],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_ID:String(o.id),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
let started = false;
async function cli(args: string[], updating = false): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [...(packed ? [] : ["--import", import.meta.resolve("tsx")]), entry, ...args], { cwd: project, env: { ...env, ...(updating ? { npm_config_registry: registry } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", bytes => output += bytes); child.stderr.on("data", bytes => output += bytes);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, output };
}
async function ok(args: string[]): Promise<string> { const r = await cli(args); assert.equal(r.code, 0, r.output); return r.output; }
const journal = join(project, ".cotal/stack-controller.json");
function digest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function records(): Record<string, string> {
  const result: Record<string, string> = { [journal]: digest(journal) };
  const walk = (path: string) => { for (const e of readdirSync(path, { withFileTypes: true })) { const p = join(path, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && e.name.endsWith(".json")) result[p] = digest(p); } };
  walk(join(env.COTAL_HOME, "services"));
  return result;
}
async function report(proven: boolean, seats: number): Promise<string> {
  const before = records();
  const r = await cli(["update", "--self", "--stop-agents"], true);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, new RegExp(`: ${seats} seats`));
  assert.deepEqual(records(), before, "the report changes no stack journal or service record");
  if (proven) {
    assert.match(r.output, /Recorded stack root:/);
    assert.match(r.output, /listed seats end and are not restarted/);
    assert.match(r.output, /Nothing was stopped by this command/);
    assert.match(r.output, /cotal down --yes --with-agents --space remedy-proof/);
    assert.match(r.output, /cotal update --self/);
    assert.match(r.output, /cotal up --detach --space remedy-proof --server .* --runtime pty --max-sessions 7/);
    assert.doesNotMatch(r.output, /Cannot determine this Manager's original hosting command/);
  } else {
    assert.match(r.output, /Cannot determine this Manager's original hosting command/);
    assert.doesNotMatch(r.output, /Recorded stack root:/);
  }
  return r.output;
}
try {
  await ok(["ext", "add", fixture]);
  await ok(["setup", "--destination", "local", "--harness", "stack-remedy-seat", "--project", project, "--space", "remedy-proof", "--no-input", "--configure-only"]);
  started = true;
  await ok(["up", "--detach", "--space", "remedy-proof", "--open", "--max-sessions", "7"]);
  await report(true, 0);
  await ok(["spawn", "--agent", "stack-remedy-seat", "--name", "remedy-worker", "--detach", "--no-events", "--space", "remedy-proof"]);
  const printed = await report(true, 1);
  const original = readFileSync(journal);
  for (const field of ["home", "host"] as const) {
    const wrong = JSON.parse(original.toString());
    wrong.recovery[field] = field === "home" ? join(root, "another-home") : "0".repeat(64);
    writeFileSync(journal, JSON.stringify(wrong));
    try { await report(false, 1); } finally { writeFileSync(journal, original); }
  }
  const held = `${journal}.test-held`;
  renameSync(journal, held);
  try {
    const r = await cli(["update", "--self", "--stop-agents"], true);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /Cannot determine this Manager's original hosting command/);
    assert.doesNotMatch(r.output, /Recorded stack root:/);
  } finally { renameSync(held, journal); }
  const moved = JSON.parse(original.toString()); moved.root = join(root, "another-root");
  writeFileSync(journal, JSON.stringify(moved));
  try { await report(false, 1); } finally { writeFileSync(journal, original); }
  const parsed = JSON.parse(original.toString());
  const manager = parsed.members.find((m: { role: string }) => m.role === "manager");
  const instanceDir = join(env.COTAL_HOME, "services", Buffer.from("remedy-proof").toString("hex"), "instances");
  const instancePath = join(instanceDir, `${Buffer.from(manager.instanceId).toString("hex")}.json`);
  const bytes = readFileSync(instancePath), mismatch = JSON.parse(bytes.toString());
  mismatch.value.adapterReadiness.native.instanceId = "wrong-manager-instance";
  writeFileSync(instancePath, JSON.stringify(mismatch));
  try { await report(false, 1); } finally { writeFileSync(instancePath, bytes); }
  const after = await ok(["ps", "--space", "remedy-proof", "--json"]);
  assert.match(after, /remedy-worker/, "all remedy reads leave the real seat running");
  if (packed) {
    const commands = printed.split("\n").filter(line => line.startsWith("    cd ")).map(line => line.trim());
    assert.equal(commands.length, 3);
    const version = await ok(["version", "--json"]);
    latest = JSON.parse(version).result.version;
    const commandEnv = { ...env, npm_config_registry: registry, PATH: `${join(dirname(packed), "../../../../bin")}:${process.env.PATH ?? ""}` };
    for (const command of commands) {
      const child = spawn("bash", ["-c", command], { cwd: project, env: commandEnv, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", bytes => output += bytes); child.stderr.on("data", bytes => output += bytes);
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 0, output);
    }
    const final = JSON.parse(await ok(["ps", "--space", "remedy-proof", "--json"]));
    assert.equal(final.result.items.length, 0, "the exact printed sequence restarts no seats");
    assert.match(await ok(["status", "--space", "remedy-proof"]), /Manager:.*answering/);
    const manifest = JSON.parse(readFileSync(join(env.XDG_CONFIG_HOME, "cotal/extensions/extensions.json"), "utf8"));
    assert.ok(manifest.extensions.filter((entry: { pkg: string }) => entry.pkg.startsWith("@cotal-ai/")).every((entry: { version: string }) => entry.version === latest));
    const finalJournal = JSON.parse(readFileSync(journal, "utf8"));
    assert.notDeepEqual(finalJournal.members.find((row: { role: string }) => row.role === "manager").process, manager.process);
  }
} finally {
  if (started) await ok(["down", "--yes", "--with-agents", "--space", "remedy-proof"]);
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (existsSync(journal)) assert.equal(JSON.parse(readFileSync(journal, "utf8")).operation.phase, "completed");
  rmSync(root, { recursive: true, force: true });
}
emitSentinel({ passed: counted.cells(), failed: 0 });

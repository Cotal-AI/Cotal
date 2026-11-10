/** Ordinary CLI managers must reject changed first-party generations, including cached providers. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { assertSmokeSandboxDown, createSuite, freePort, killAndAwaitExit, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const suite = createSuite();
const repo = resolve(import.meta.dirname, "../../..");
const cli = join(repo, "bin/dist/cotal.js");
const version = (JSON.parse(readFileSync(join(repo, "implementations/manager/package.json"), "utf8")) as { version: string }).version;
const core = pathToFileURL(join(repo, "packages/core/dist/index.js")).href;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
interface Envelope {
  result?: { readiness?: string; managers?: { instanceId: string; state: string }[]; instances?: { instanceId: string; definition: string; observedProcess: string }[] } | null;
}

for (const surface of ["up", "manager-start"] as const) {
  const sandbox = mkdtempSync(join(tmpdir(), `connector-generation-${surface}-`));
  const root = join(sandbox, "project"), home = join(sandbox, "home"), xdg = join(sandbox, "config"), reports = join(sandbox, "reports");
  for (const dir of [root, home, xdg, reports]) mkdirSync(dir, { mode: 0o700 });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH", "FORCE_COLOR"].includes(key)));
  const env = { ...inherited, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, XDG_STATE_HOME: join(sandbox, "state"), XDG_CACHE_HOME: join(sandbox, "cache"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
  const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
  const space = `gen-${randomUUID().slice(0, 8)}`;
  let sequence = 0;
  const run = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 90_000 };
    assertSmokeSandboxDown(anchor, args, options);
    const child = spawnSync(process.execPath, [cli, ...args], options);
    let doc: Envelope = {};
    try { doc = JSON.parse(child.stdout) as Envelope; } catch { /* asserted by each caller */ }
    const result = { code: child.status, output: child.stdout + child.stderr, doc };
    writeFileSync(join(sandbox, `${String(sequence++).padStart(3, "0")}.json`), JSON.stringify(result, null, 2));
    return result;
  };
  const prefix = join(xdg, "cotal/extensions");
  const entries: { pkg: string; version: string; spec: string; source?: string; provides: { kind: string; name: string }[]; commands: never[]; connectors: { name: string; requires: string[]; eventPlane: boolean }[] }[] = [];
  // These are local fixture packages, not claimed to be released connector artifacts.
  const install = (pkg: string, name: string, generation: string, seeded: boolean) => {
    const dir = join(prefix, "node_modules", pkg);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version: generation, type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": ">=0.1.0" } }));
    writeFileSync(join(dir, "seat.mjs"), `import {CotalEndpoint} from ${JSON.stringify(core)};import {readFileSync,writeFileSync} from 'node:fs';
const o=JSON.parse(process.env.GENERATION_OPTIONS);const meta=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));
const ep=new CotalEndpoint({space:o.space,servers:o.servers,creds:o.creds?readFileSync(o.creds,'utf8'):undefined,lifecycleUid:o.lifecycleUid,acceptedToken:o.acceptedToken,channels:[],consume:false,card:{id:o.id,name:o.name,kind:'agent'}});ep.on('error',()=>{});await ep.start();writeFileSync(process.env.GENERATION_REPORT,JSON.stringify({version:meta.version,name:o.name}));process.on('SIGTERM',()=>{void ep.close().finally(()=>process.exit(0))});`);
    writeFileSync(join(dir, "index.js"), `import {registry} from ${JSON.stringify(core)};registry.register({kind:'connector',name:${JSON.stringify(name)},requires:['node'],buildLaunch:o=>({command:process.execPath,args:[${JSON.stringify(join(dir, "seat.mjs"))}],env:{PATH:process.env.PATH,HOME:process.env.HOME,GENERATION_OPTIONS:JSON.stringify({space:o.space,servers:o.servers,creds:o.creds,id:o.id,name:o.name,lifecycleUid:o.lifecycleUid,acceptedToken:o.acceptedToken}),GENERATION_REPORT:${JSON.stringify(reports)}+'/'+o.name+'.json'}})});`);
    const entry = { pkg, version: generation, spec: `${pkg}@${generation}`, ...(seeded ? { source: "seeded" } : {}), provides: [{ kind: "connector", name }], commands: [] as never[], connectors: [{ name, requires: ["node"], eventPlane: false }] };
    const at = entries.findIndex((value) => value.pkg === pkg);
    if (at < 0) entries.push(entry); else entries[at] = entry;
    writeFileSync(join(prefix, "extensions.json"), JSON.stringify({ extensions: entries }));
  };
  install("@cotal-ai/connector-claude-code", "generation-warm", version, true);
  install("generation-third-party", "generation-third-party", "1.0.0", false);
  let manager: ChildProcess | undefined;
  let instance: string | undefined;
  const seats: string[] = [];
  let attempted = false;
  const launch = (harness: string, name: string) => {
    if (!instance) throw new Error("fixture has no observed manager instance");
    const result = run("spawn", "--space", space, "--on", instance, "--harness", harness, "--name", name, "--no-events", "--detach", "--json");
    if (result.code === 0) seats.push(name);
    return result;
  };
  try {
    const prepared = run("space", "create", space, "--root", root, "--json");
    if (prepared.code !== 0) throw new Error(`owned preparation failed: ${prepared.output}`);
    attempted = true;
    const up = run("up", "--server", `nats://127.0.0.1:${await freePort()}`, ...(surface === "manager-start" ? ["--no-manager"] : []), "--detach", "--json");
    if (up.code !== 0) throw new Error(`owned startup failed: ${up.output}`);
    if (surface === "manager-start") {
      const fd = openSync(join(sandbox, "manager.log"), "a");
      try { manager = spawn(process.execPath, [cli, "manager", "start", "--foreground", "--space", space], { cwd: root, env, stdio: ["ignore", fd, fd] }); }
      finally { closeSync(fd); }
    }
    for (let i = 0; i < 60; i++) {
      const census = run("ps", "--space", space, "--json");
      const rows = census.doc.result?.managers?.filter((row) => row.state === "answered") ?? [];
      if (census.code === 0 && rows.length === 1) { instance = rows[0]!.instanceId; break; }
      if (manager && manager.exitCode !== null) break;
      await sleep(250);
    }
    if (!instance) throw new Error("ordinary manager did not answer its native census");
    const warm = launch("generation-warm", "generation_warm");
    suite.check(`${surface}: matching first-party connector joins`, warm.code === 0 && warm.doc.result?.readiness === "joined", warm);
    if (warm.code !== 0) throw new Error("matching connector control failed before generation comparison");
    install("@cotal-ai/connector-claude-code", "generation-warm", "9.9.9", true);
    install("@cotal-ai/connector-codex", "generation-cold", "9.9.9", true);
    for (const [harness, name, pkg] of [["generation-cold", "generation_cold", "@cotal-ai/connector-codex"], ["generation-warm", "generation_cached", "@cotal-ai/connector-claude-code"]]) {
      const result = launch(harness!, name!);
      suite.check(`${surface}: ${harness} refuses the changed generation with restart guidance`, result.code === 2 && result.doc.result === null && result.output.includes(pkg!) && result.output.includes("9.9.9") && result.output.includes(version) && /restart/.test(result.output), result);
      if (result.code === 0) {
        const loaded = JSON.parse(readFileSync(join(reports, `${name}.json`), "utf8")) as { version: string };
        console.log(`Observed mismatched fixture seat generation: ${loaded.version}`);
      }
    }
    const thirdParty = launch("generation-third-party", "generation_third_party");
    suite.check(`${surface}: unrelated third-party version still joins`, thirdParty.code === 0 && thirdParty.doc.result?.readiness === "joined", thirdParty);
    const same = run("ps", "--space", space, "--json");
    suite.check(`${surface}: the same manager remains answering`, same.code === 0 && same.doc.result?.managers?.some((row) => row.instanceId === instance && row.state === "answered") === true, same);
  } finally {
    for (const name of seats) {
      const stopped = run("stop", name, "--space", space, "--on", instance!, "--json");
      suite.check(`${surface}: owned seat ${name} stops`, stopped.code === 0, stopped);
    }
    if (manager) {
      const inventory = run("service", "--space", space, "--json");
      const owned = inventory.doc.result?.instances?.find((row) => row.definition === "manager");
      if (owned) {
        const stopped = run("service", "stop", "manager", "--instance", owned.instanceId, "--space", space, "--yes", "--json");
        suite.check(`${surface}: owned manager service stops through its native control`, stopped.code === 0, stopped);
      }
      await killAndAwaitExit(manager, "SIGTERM");
    }
    if (attempted) {
      const down = run("down", "--yes", "--json");
      const inventory = run("service", "--space", space, "--json");
      const rows = inventory.doc.result?.instances;
      suite.check(`${surface}: owned stack members are gone`, down.code === 0 && inventory.code === 0 && Boolean(rows?.length) && rows!.every((row) => row.observedProcess === "gone" || row.observedProcess === "previous-boot"), down);
    }
    console.log(`Retained generation fixture: ${sandbox}`);
  }
}
suite.finish();
process.exit(process.exitCode ?? 0);

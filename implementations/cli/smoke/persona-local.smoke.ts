/** Native offline persona acceptance. Every mutation uses the built public CLI and real editors. */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireLock } from "@cotal-ai/core";
import { recordMesh, recordPreparedSpace, setCurrent, loadMeshes, clearCurrent } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sandbox = mkdtempSync(join(tmpdir(), "cotal-persona-smoke-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.toUpperCase().startsWith("COTAL_"))) as Record<string, string>;
for (const [key, part] of Object.entries({ HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "runtime", TMPDIR: "tmp", TMP: "tmp", TEMP: "tmp", COTAL_HOME: "cotal" })) {
  mkdirSync(join(sandbox, part), { recursive: true, mode: 0o700 }); env[key] = join(sandbox, part);
}
for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith("COTAL_")) delete process.env[key];
Object.assign(process.env, env);
delete env.EDITOR; delete env.VISUAL;
const project = join(sandbox, "project"), other = join(sandbox, "other");
for (const path of [project, other]) mkdirSync(join(path, ".cotal", "agents"), { recursive: true, mode: 0o700 });
const catalog = join(project, ".cotal", "agents");
const file = join(catalog, "complete.md");
const original = `---\n# exact comment survives\nname: complete\nrole: tester\nkind: agent\ndescription: Full definition\ntags: [native, offline]\nsubscribe: [team.a]\nallowSubscribe: [team.>]\nallowPublish: []\nquiet: [team.a]\nmuted: [team.b]\nmodel: fixture/model\nvariant: high\nagent: claude\nlaunchOptions:\n  custom: true\ncapabilities: [spawn, run]\nowner: fixture_owner\ntheme: paper\n---\nPrivate authored body.\n`;
const { check, finish } = createSuite();
const bin = join(root, "bin/dist/cotal.js");
const run = (args: string[], extra: Record<string, string> = {}, cwd = other) => spawnSync(process.execPath, [bin, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
const call = (args: string[], extra: Record<string, string> = {}) => run(["persona", ...args, "--space", "prepared"], extra);
const json = (args: string[]) => { const result = call([...args, "--json"]); return { result, doc: JSON.parse(result.stdout) as any }; };
const quote = (value: string) => process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
const editor = (name: string, code: string) => {
  const path = join(sandbox, `${name}.mjs`); writeFileSync(path, code, { mode: 0o600 });
  return { EDITOR: `${quote(process.execPath)} ${quote(path)}`, VISUAL: `${quote(process.execPath)} ${quote(path)}` };
};
const pause = (ms: number) => new Promise(ok => setTimeout(ok, ms));
const until = async (condition: () => boolean) => { const end = Date.now() + 15_000; while (!condition() && Date.now() < end) await pause(20); return condition(); };
const active = new Set<Promise<unknown>>();
let childSequence = 0;
const launch = (args: string[], extra: Record<string, string>, nodeArgs: string[] = []) => {
  const child = spawn(process.execPath, [...nodeArgs, bin, "persona", ...args, "--space", "prepared"], { cwd: other, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  const evidence = join(sandbox, `native-child-${++childSequence}`);
  let stdout = "", stderr = "", ended = false, spawnError: string | undefined;
  child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
  child.once("error", error => { spawnError = error.message; });
  const snapshot = () => ({ pid: child.pid, status: child.exitCode, signal: child.signalCode, stdout, stderr, spawnError, evidence });
  const done = new Promise<ReturnType<typeof snapshot>>(ok => child.once("close", (status, signal) => {
    ended = true;
    const result = { ...snapshot(), status, signal };
    writeFileSync(`${evidence}.stdout`, stdout, { mode: 0o600 });
    writeFileSync(`${evidence}.stderr`, stderr, { mode: 0o600 });
    writeFileSync(`${evidence}.json`, `${JSON.stringify({ ...result, args, nodeArgs }, null, 2)}\n`, { mode: 0o600 });
    ok(result);
  }));
  active.add(done); void done.finally(() => active.delete(done));
  return { done, ended: () => ended, snapshot };
};
const controls = createServer(socket => { connections++; socket.destroy(); });
let connections = 0;
const releases: string[] = [];
try {
  await new Promise<void>(ok => controls.listen(0, "127.0.0.1", ok));
  const port = (controls.address() as { port: number }).port;
  if (port === 4222) throw new Error("forbidden broker port");
  recordPreparedSpace({ space: "prepared", root: project, ts: new Date().toISOString() });
  recordMesh({ space: "recorded", root: other, mode: "open", server: `nats://127.0.0.1:${port}`, origin: "manual", ts: new Date().toISOString() });
  setCurrent("prepared");
  const missingCatalogRoot = join(sandbox, "missing-catalog"); mkdirSync(missingCatalogRoot);
  recordPreparedSpace({ space: "missing-catalog", root: missingCatalogRoot, ts: new Date().toISOString() });
  const absentCatalog = run(["persona", "--space", "missing-catalog", "--json"]);
  check("missing catalog directory is a complete empty inventory", absentCatalog.status === 0 && JSON.parse(absentCatalog.stdout).result.items.length === 0);
  const input = join(sandbox, "input.md"); writeFileSync(input, original);
  const empty = json([]);
  check("prepared catalog is an offline complete empty read", empty.result.status === 0 && empty.doc.result?.items?.length === 0 && empty.doc.target?.root === project);
  check("prepared catalog does not fabricate a registration", !loadMeshes().some(item => item.space === "prepared"));
  if (!process.argv.includes("--prepared-only")) {
  const created = json(["create", "complete", "--file", input]);
  check("native full-field create stores exact input bytes privately", created.result.status === 0 && readFileSync(file, "utf8") === original && (process.platform === "win32" || (lstatSync(file).mode & 0o777) === 0o600), created.result.stderr);
  const detail = json(["show", "complete"]);
  check("native show preserves every AgentDef field and exact source", detail.result.status === 0 && detail.doc.result.source === original && detail.doc.result.definition.owner === "fixture_owner" && detail.doc.result.definition.launchOptions.custom === true && detail.doc.result.definition.meta.theme === "paper" && detail.doc.result.definition.muted[0] === "team.b" && detail.doc.result.definition.capabilities.length === 2);
  check("list never echoes private persona bodies or launch options", !json([]).result.stdout.includes("Private authored body.") && !json([]).result.stdout.includes("custom"));
  for (const mode of [[], ["--plain"], ["--json"]]) {
    const listed = call(mode); const shown = call(["show", "complete", ...mode]);
    check(`native list and show support ${mode[0] ?? "human"}`, listed.status === 0 && shown.status === 0 && listed.stdout.includes("complete") && shown.stdout.includes("Private authored body."));
  }
  const selected = run(["p", "--json"]);
  check("selected prepared root wins over another cwd", selected.status === 0 && JSON.parse(selected.stdout).target.root === project);
  const second = run(["persona", "--space", "recorded", "--json"]);
  check("two roots have distinct offline catalogs", second.status === 0 && JSON.parse(second.stdout).result.items.length === 0);
  setCurrent("recorded");
  const selectedRecorded = run(["persona", "--json"]);
  check("selected recorded root stays offline", selectedRecorded.status === 0 && JSON.parse(selectedRecorded.stdout).target.root === other);
  setCurrent("gone");
  const staleSelection = run(["persona", "--json"]);
  check("stale selection refuses instead of reading cwd", staleSelection.status === 2);
  setCurrent("prepared");
  const completion = run(["__complete", "persona", "--space", "prepared", "show", ""]);
  check("native completion resolves the offline prepared catalog", completion.status === 0 && completion.stdout.includes("complete"));
  clearCurrent();
  recordMesh({ space: "second-recorded", root: project, mode: "open", server: `nats://127.0.0.1:${port}`, origin: "manual", ts: new Date().toISOString() });
  const ambiguous = run(["persona", "--json"], {}, env.HOME);
  check("ambiguous offline target refuses without choosing a catalog", ambiguous.status === 2);
  recordPreparedSpace({ space: "stale-root", root: join(sandbox, "absent-root"), ts: new Date().toISOString() });
  const staleRoot = run(["persona", "create", "wrong", "--prompt", "body", "--subscribe", "", "--space", "stale-root", "--json"]);
  check("stale catalog root refuses without recreating it", staleRoot.status === 2 && !existsSync(join(sandbox, "absent-root")));
  setCurrent("prepared");
  const legacy = run(["personas", "show", "complete", "--space", "prepared"]);
  check("legacy parser still reads the same prepared catalog", legacy.status === 0 && legacy.stdout.includes("Private authored body."));
  for (const args of [["--space", "missing"], ["--space", "prepared", "--server", `nats://127.0.0.1:${port}`]]) {
    const result = run(["persona", "create", "wrong", "--prompt", "body", "--subscribe", "", ...args, "--json"]);
    check(`unavailable target refuses without cwd write ${args[1]}`, result.status === 2 && !existsSync(join(other, ".cotal/agents/wrong.md")));
  }
  const overwritten = call(["create", "complete", "--prompt", "replacement", "--subscribe", "", "--json"]);
  check("create refuses to overwrite an existing definition", overwritten.status === 2 && readFileSync(file, "utf8") === original);
  writeFileSync(input, "---\nname: [secret-fixture-value\n---\nprivate\n");
  const bad = call(["create", "broken", "--file", input, "--json"]);
  check("malformed file input refuses without leaking parser source", bad.status === 1 && !existsSync(join(catalog, "broken.md")) && !`${bad.stdout}${bad.stderr}`.includes("secret-fixture-value"));
  writeFileSync(input, original);
  check("conflicting create sources refuse", call(["create", "new", "--file", input, "--prompt", "body"]).status === 1);
  check("file name mismatch refuses", call(["create", "different", "--file", input]).status === 1);
  const remote = call(["create", "remote", "--prompt", "body", "--subscribe", "", "--on", "manager", "--json"]);
  check("remote on refuses before a local write", remote.status === 2 && !existsSync(join(catalog, "remote.md")));
  const marker = join(sandbox, "editor-marker");
  const markerEditor = editor("marker", `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'launched');`);
  const noInput = call(["edit", "complete", "--no-input"], markerEditor);
  check("no-input edit refuses before editor launch", noInput.status === 1 && !existsSync(marker));
  const jsonEdit = call(["edit", "complete", "--json"], markerEditor);
  check("JSON edit refuses before editor launch", jsonEdit.status === 1 && !existsSync(marker));
  const valid = editor("valid", `import {readFileSync,writeFileSync,statSync} from 'node:fs';const p=process.argv[2];if(p===${JSON.stringify(file)})process.exit(88);writeFileSync(p,readFileSync(p,'utf8').replace('Private authored body.','Valid changed body.'));`);
  check("native valid editor promotes exact full-field bytes", call(["edit", "complete"], valid).status === 0 && readFileSync(file, "utf8") === original.replace("Private authored body.", "Valid changed body."));
  writeFileSync(file, original);
  const invalid = editor("invalid", `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'---\\nname: [\\n---\\ninvalid\\n');`);
  const invalidRun = call(["edit", "complete"], invalid);
  check("invalid native editor preserves original bytes", invalidRun.status === 1 && readFileSync(file, "utf8") === original);
  writeFileSync(file, original);
  const failed = editor("nonzero", `import {readFileSync,writeFileSync} from 'node:fs';const p=process.argv[2];writeFileSync(p,readFileSync(p,'utf8').replace('Private authored body.','Uncommitted body.'));process.exitCode=9;`);
  const failedRun = call(["edit", "complete"], failed);
  check("nonzero native editor preserves original bytes", failedRun.status === 5 && readFileSync(file, "utf8") === original);
  writeFileSync(file, original);
  const held = async (label: string) => {
    const ready = join(sandbox, `${label}-ready`), release = join(sandbox, `${label}-release`); releases.push(release);
    const command = editor(label, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';const p=process.argv[2],src=readFileSync(p,'utf8');writeFileSync(${JSON.stringify(ready)},'ready');const end=Date.now()+20000;while(!existsSync(${JSON.stringify(release)})){if(Date.now()>end)process.exit(99);await new Promise(ok=>setTimeout(ok,20));}writeFileSync(p,src.replace('Private authored body.','Held update.'));`);
    const child = launch(["edit", "complete"], command);
    if (!await until(() => existsSync(ready))) throw new Error("native editor did not reach gate");
    return { ...child, release: () => writeFileSync(release, "release") };
  };
  const first = await held("concurrent");
  const winner = call(["edit", "complete"], valid);
  check("second real editor commits while first editor stays gated", winner.status === 0 && !first.ended());
  first.release(); const conflict = await first.done;
  check("two native editors refuse lost overwrite", conflict.status === 2 && /changed|conflict/i.test(conflict.stderr) && readFileSync(file, "utf8").includes("Valid changed body."));
  writeFileSync(file, original);
  const removing = await held("remove-race");
  const removed = json(["remove", "complete", "--yes"]); removing.release(); const stale = await removing.done;
  check("held editor cannot resurrect a removed definition", removed.result.status === 0 && stale.status === 2 && !existsSync(file));
  writeFileSync(file, original);
  const legacyHeld = await held("legacy-race");
  const legacyWrite = run(["personas", "new", "complete", "--prompt", "Legacy winner.", "--subscribe", "", "--force", "--space", "prepared"]);
  legacyHeld.release(); const legacyConflict = await legacyHeld.done;
  check("legacy and canonical writes share conflict fencing", legacyWrite.status === 0 && legacyConflict.status === 2 && readFileSync(file, "utf8").includes("Legacy winner."));
  writeFileSync(file, original);
  // Hold the same public machine-local lock in a genuine other process (this suite), then release.
  const lockPath = join(catalog, ".complete.md.lock");
  const lock = acquireLock(lockPath);
  const attempted = join(sandbox, "lock-attempted");
  const preload = join(sandbox, "lock-observer.mjs");
  // Observe the actual native lock claim. No CLI result or file operation is mocked.
  writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const link=fs.linkSync;fs.linkSync=function(from,to){if(to===${JSON.stringify(lockPath)})fs.writeFileSync(${JSON.stringify(attempted)},'attempted');return link.call(this,from,to);};syncBuiltinESMExports();`);
  const waiting = launch(["remove", "complete", "--yes"], {}, ["--import", pathToFileURL(preload).href]);
  try {
    await until(() => existsSync(attempted) || waiting.ended());
    const observed = { ...waiting.snapshot(), attempted: existsSync(attempted), ended: waiting.ended(), fileExists: existsSync(file) };
    writeFileSync(join(sandbox, "lock-before-release.json"), `${JSON.stringify(observed, null, 2)}\n`, { mode: 0o600 });
    check("native commit waits for the shared per-persona lock", observed.attempted && !observed.ended && observed.fileExists, observed);
  } finally { lock.release(); }
  const lockResult = await waiting.done;
  check("native commit finishes after the shared lock is released", lockResult.status === 0 && !existsSync(file), { ...lockResult, fileExists: existsSync(file) });
  writeFileSync(file, original);
  const noConfirm = json(["remove", "complete"]);
  check("remove requires scoped confirmation before deletion", noConfirm.result.status === 1 && existsSync(file));
  const aliasRemove = run(["p", "rm", "complete", "--yes", "--space", "prepared", "--json"]);
  check("scoped rm removes only the named persona", aliasRemove.status === 0 && !existsSync(file) && existsSync(join(other, ".cotal/agents")));
  const body = json(["create", "body", "--prompt", "Only a body.", "--subscribe", ""]);
  check("native body creation uses the shared serializer", body.result.status === 0 && readFileSync(join(catalog, "body.md"), "utf8").includes("subscribe: []"));
  writeFileSync(join(catalog, "malformed.md"), "invalid");
  const partial = json([]);
  check("malformed catalog is named partial rather than complete empty", partial.result.status === 4 && partial.doc.completeness === "partial" && partial.doc.warnings.some((warning: any) => warning.target.name === "malformed"));
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    chmodSync(catalog, 0);
    try { check("unreadable catalog refuses rather than showing empty", json([]).result.status === 2); }
    finally { chmodSync(catalog, 0o700); }
    const bodyFile = join(catalog, "body.md"); chmodSync(bodyFile, 0);
    try { check("unreadable source is not absent", json(["show", "body"]).result.status === 2); }
    finally { chmodSync(bodyFile, 0o600); }
  }
  for (const args of [["persona", "--help"], ["p", "--help"], ["persona", "unknown"], ["persona", "--unknown"]]) {
    const result = run(args); check(`local parse/help ${args.join(" ")}`, result.status === (args.includes("--help") ? 0 : 1));
  }
  check("local persona commands never connect to a broker", connections === 0);
  check("local persona commands never seed connectors", !existsSync(join(env.COTAL_HOME!, "extensions")));
  check("all private editor drafts were cleaned", readdirSync(env.TMPDIR!).every(name => !name.startsWith("cotal-persona-")));
  }
} finally {
  for (const release of releases) if (!existsSync(release)) writeFileSync(release, "release");
  await Promise.all(active);
  await new Promise<void>(ok => controls.close(() => ok()));
}
finish();

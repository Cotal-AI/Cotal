import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { win32ProcessBinding } from "@cotal-ai/workspace";
import { cleanupExecutionStore, type ConnectorSetCleanup } from "../execution-store.js";

if (process.platform === "win32") {
  const scratch = mkdtempSync(join(tmpdir(), "connector-cleanup-native-"));
  const installed = join(scratch, "prefix", "lib", "node_modules", "cotal-ai");
  const suppliedRoot = join(scratch, "sets"), outside = join(scratch, "outside");
  for (const path of [installed, suppliedRoot, outside]) mkdirSync(path, { recursive: true });
  // The data producer hands an existing protected directory to the strict collector canonically.
  const root = realpathSync.native(suppliedRoot);
  writeFileSync(join(outside, "sentinel"), "keep");
  const sid = win32ProcessBinding().userSid(), account = `cotalgc${process.pid}`;
  const warnings: string[] = [];
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const ps = (script: string) => {
    const result = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop';${script}`, "utf16le").toString("base64")], { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")), encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const own = (path: string) => { const result = spawnSync("icacls.exe", [path, "/setowner", `*${sid}`, "/T", "/Q"], { encoding: "utf8", timeout: 30000, windowsHide: true }); assert.equal(result.status, 0, result.stdout + result.stderr); };
  const create = (version: string) => { mkdirSync(join(root, version, "nested"), { recursive: true }); writeFileSync(join(root, version, "nested", ".hidden"), version); own(join(root, version)); };
  const spec: ConnectorSetCleanup = { root, installRoot: installed, current: "0.4.0", previous: "0.3.0", holders: [{ version: "0.2.0", state: "live" }, { version: "0.1.0", state: "unknown" }] };
  const clean = (value = spec) => cleanupExecutionStore(installed, line => warnings.push(line), value);
  let created = false;
  try {
    own(scratch);
    for (const version of ["0.0.1", "0.1.0", "0.2.0", "0.3.0", "0.4.0"]) create(version);
    cleanupExecutionStore(installed, line => warnings.push(line));
    assert(existsSync(join(root, "0.0.1")), "absent spec never collects sets");
    clean();
    assert.deepEqual(readdirSync(root).sort(), ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]);
    assert.equal(warnings.length, 0, warnings.join("\n"));
    create("0.0.2"); clean({ ...spec, holders: [{ state: "unknown" }] });
    assert(existsSync(join(root, "0.0.2")), "unversioned unknown retains all");
    clean(); assert(!existsSync(join(root, "0.0.2")));
    const foreignSid = ps(`$p=ConvertTo-SecureString ([Guid]::NewGuid().ToString()+'aA!9') -AsPlainText -Force;$u=New-LocalUser -Name ${literal(account)} -Password $p -AccountNeverExpires;$u.SID.Value`); created = true;
    create("0.0.3");
    const foreignFile = join(root, "0.0.3", "nested", ".hidden");
    ps(`$a=Get-Acl -LiteralPath ${literal(foreignFile)};$a.SetOwner([Security.Principal.SecurityIdentifier]::new(${literal(foreignSid)}));Set-Acl -LiteralPath ${literal(foreignFile)} -AclObject $a`);
    const foreignBefore = warnings.length; clean();
    assert(existsSync(foreignFile)); assert.equal(warnings.length, foreignBefore + 1);
    assert(warnings.at(-1)!.includes(join(root, "0.0.3")) && warnings.at(-1)!.includes(foreignSid) && warnings.at(-1)!.includes("cotal ext seed --repair"));
    own(join(root, "0.0.3")); clean(); assert(!existsSync(join(root, "0.0.3")));
    create("0.0.4"); const junction = join(root, "0.0.4", "nested", "junction");
    ps(`New-Item -ItemType Junction -Path ${literal(junction)} -Target ${literal(outside)}|Out-Null`);
    const junctionBefore = warnings.length; clean();
    assert(existsSync(junction)); assert.equal(warnings.length, junctionBefore + 1); assert.match(warnings.at(-1)!, /reparse points 1/);
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
    rmSync(junction); clean(); assert(!existsSync(join(root, "0.0.4")));
    create("0.0.5");
    const workspace = new URL("../../packages/workspace/dist/index.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `const{claimGlobalNpmUpdateLock}=await import(${JSON.stringify(workspace)});const release=claimGlobalNpmUpdateLock(${JSON.stringify(dirname(installed))});process.stdout.write('held\\n');process.stdin.resume();process.stdin.on('end',()=>{release();process.exit(0)});`], { stdio: ["pipe", "pipe", "inherit"] });
    try { await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("lock child readiness timed out")), 15000); child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("exit", code => { clearTimeout(timer); reject(new Error(`lock child exited before readiness: ${code}`)); }); child.stdout.once("data", () => { clearTimeout(timer); resolve(); }); }); clean(); assert(existsSync(join(root, "0.0.5")), "competing updater retains obsolete set"); }
    finally { const ended = new Promise<void>(resolve => { if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("close", () => resolve()); }); child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await ended; clearTimeout(timer); }
    clean(); assert(!existsSync(join(root, "0.0.5")));
    create("0.0.6"); const denied = join(root, "0.0.6"), deniedFile = join(denied, "nested", ".hidden");
    const deny = spawnSync("icacls.exe", [deniedFile, "/deny", `*${sid}:(D)`, "/Q"], { encoding: "utf8", timeout: 30000, windowsHide: true }); assert.equal(deny.status, 0, deny.stdout + deny.stderr);
    const deniedParent = dirname(deniedFile);
    const denyParent = spawnSync("icacls.exe", [deniedParent, "/deny", `*${sid}:(DC)`, "/Q"], { encoding: "utf8", timeout: 30000, windowsHide: true }); assert.equal(denyParent.status, 0, denyParent.stdout + denyParent.stderr);
    const deniedBefore = warnings.length;
    try { clean(); assert(existsSync(denied), "actual delete denial keeps generation directory"); assert.equal(warnings.length, deniedBefore + 1); assert(warnings.at(-1)!.includes(denied)); }
    finally { for (const path of [deniedFile, deniedParent]) { const reset = spawnSync("icacls.exe", [path, "/remove:d", `*${sid}`, "/Q"], { encoding: "utf8", timeout: 30000, windowsHide: true }); assert.equal(reset.status, 0, reset.stdout + reset.stderr); } }
    clean(); assert(!existsSync(denied));
    const installedRootRetentions: { owner: string; warning: string | null }[] = [];
    create("0.0.7");
    for (const owner of [foreignSid, "S-1-5-32-544", "S-1-5-18"]) {
      const changed = spawnSync("icacls.exe", [installed, "/setowner", `*${owner}`, "/Q"], { encoding: "utf8", timeout: 30000, windowsHide: true });
      assert.equal(changed.status, 0, changed.stdout + changed.stderr);
      const warningCount: number = warnings.length;
      try {
        clean();
        assert(existsSync(join(root, "0.0.7")), "foreign installed root cannot collect sets");
        if (owner === foreignSid) assert.equal(warnings.length, warningCount);
        else assert(warnings.length === warningCount + 1 && warnings.at(-1)!.includes(installed) && warnings.at(-1)!.includes(owner) && warnings.at(-1)!.includes("cotal ext seed --repair"));
        installedRootRetentions.push({ owner, warning: warnings.length === warningCount ? null : warnings.at(-1)! });
      } finally { own(installed); }
    }
    clean(); assert(!existsSync(join(root, "0.0.7")));
    const result = { platform: process.platform, arch: process.arch, suppliedRoot, canonicalRoot: root, nativeSid: sid, foreignSid, retained: readdirSync(root).sort(), warnings, installedRootRetentions, accountRemoved: false, passed: true };
    ps(`Remove-LocalUser -Name ${literal(account)}`); created = false; result.accountRemoved = true;
    const output = process.env.COTAL_OWNER_PROBE_OUTPUT;
    if (output) { mkdirSync(output, { recursive: true }); writeFileSync(join(output, "collector-result.json"), JSON.stringify(result, null, 2)); }
    console.log(JSON.stringify(result));
  } finally { if (created) ps(`Remove-LocalUser -Name ${literal(account)}`); rmSync(scratch, { recursive: true, force: true }); }
}

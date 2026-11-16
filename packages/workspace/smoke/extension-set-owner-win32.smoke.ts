import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsSetOwnedByCurrentUser, windowsSetTreeOwnership } from "../src/extension-set-win32.js";
import { win32ProcessBinding } from "../src/win32-process.js";

if (process.platform !== "win32") throw new Error("Windows connector-set owner measurement requires Windows");
if (process.argv[2] === "--denied-child") {
  const path = process.argv[3]!;
  assert.throws(() => win32ProcessBinding().directoryOwnerSid(path), /Windows error 5/);
  assert.throws(() => windowsSetOwnedByCurrentUser(path), /Windows error 5/);
  console.log("native and composed owner readers refuse actual READ_CONTROL denial");
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), "connector-owner-"));
const own = join(root, "own set ü"), foreign = join(root, "foreign set"), junction = join(root, "junction");
mkdirSync(own); mkdirSync(foreign);
const account = `ct${randomBytes(8).toString("hex")}`;
const sid = win32ProcessBinding().userSid();
const output = process.env.COTAL_OWNER_PROBE_OUTPUT;
if (!output) throw new Error("measurement output directory required");
mkdirSync(output, { recursive: true });
const runSetup = (label: string, file: string, args: string[]) => {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  const startedAt = new Date().toISOString(), started = performance.now();
  const result = spawnSync(file, args, { env: environment, encoding: "utf8", timeout: 30000, windowsHide: true });
  // Arguments can contain the new account's random password, so never record them.
  appendFileSync(join(output, "setup-calls.jsonl"), JSON.stringify({ label, file, startedAt, elapsedMs: Math.round(performance.now() - started), boundMs: 30000, status: result.status, signal: result.signal, error: result.error ? { name: result.error.name, message: result.error.message, code: (result.error as NodeJS.ErrnoException).code } : null, stdout: result.stdout, stderr: result.stderr }) + "\n");
  assert.equal(result.status, 0, `${label}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
};
const ps = (label: string, script: string) => runSetup(label, join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop';Import-Module Microsoft.PowerShell.Security;${script}`, "utf16le").toString("base64")]);
const net = (label: string, args: string[]) => runSetup(label, join(process.env.SystemRoot ?? "C:\\Windows", "System32", "net.exe"), args);
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
let created = false;
try {
  ps("set-own-root-owner", `$a=Get-Acl -LiteralPath ${literal(own)};$a.SetOwner([Security.Principal.SecurityIdentifier]::new(${literal(sid)}));Set-Acl -LiteralPath ${literal(own)} -AclObject $a`);
  // Mark attempted creation before the call, so a timed-out add still gets an owned-name delete attempt.
  created = true;
  net("create-foreign-account", ["user", account, `${randomBytes(5).toString("hex")}aA!9`, "/add", "/expires:never", "/active:no"]);
  const foreignSid = ps("lookup-foreign-account-sid", `[Security.Principal.NTAccount]::new($env:COMPUTERNAME,${literal(account)}).Translate([Security.Principal.SecurityIdentifier]).Value`);
  assert.match(foreignSid, /^S-1-[0-9-]+$/);
  ps("set-foreign-owner-and-junction", `$a=Get-Acl -LiteralPath ${literal(foreign)};$a.SetOwner([Security.Principal.SecurityIdentifier]::new(${literal(foreignSid)}));Set-Acl -LiteralPath ${literal(foreign)} -AclObject $a;New-Item -ItemType Junction -Path ${literal(junction)} -Target ${literal(own)}|Out-Null`);
  const ownResult = windowsSetOwnedByCurrentUser(own);
  const foreignResult = windowsSetOwnedByCurrentUser(foreign);
  assert.equal(win32ProcessBinding().directoryOwnerSid(own), sid);
  assert.equal(win32ProcessBinding().directoryOwnerSid(foreign), foreignSid);
  assert.throws(() => win32ProcessBinding().directoryOwnerSid(junction), /real directory|reparse/);
  const missing = join(root, "missing");
  assert.throws(() => win32ProcessBinding().directoryOwnerSid(missing), /Windows error [23]\)/);
  assert.throws(() => windowsSetOwnedByCurrentUser(missing), /ENOENT/);
  const file = join(root, "ordinary file ü.txt");
  writeFileSync(file, "not a connector directory");
  assert.throws(() => win32ProcessBinding().directoryOwnerSid(file), /real directory/);
  assert.throws(() => windowsSetOwnedByCurrentUser(file), /real directory/);
  assert.throws(() => win32ProcessBinding().directoryOwnerSid(`${own}\0other`), /NUL/);
  let reparseError = "";
  try { windowsSetOwnedByCurrentUser(junction); } catch (error) { reparseError = String(error); }
  assert.equal(ownResult, true);
  assert.equal(foreignResult, false);
  assert.match(reparseError, /real directory|reparse/);
  const privilegedOwners: { sid: string; path: string; error: string }[] = [];
  for (const [name, owner] of [["administrators", "S-1-5-32-544"], ["system", "S-1-5-18"]] as const) {
    const path = join(root, name);
    mkdirSync(path);
    const change = spawnSync("icacls.exe", [path, "/setowner", `*${owner}`, "/Q"], { encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(change.status, 0, change.stdout + change.stderr);
    assert.equal(win32ProcessBinding().directoryOwnerSid(path), owner);
    let error = "";
    try { windowsSetOwnedByCurrentUser(path); } catch (cause) { error = String(cause); }
    if (owner === sid) assert.equal(windowsSetOwnedByCurrentUser(path), true, "current token equality precedes privileged SID refusal");
    else assert(error.includes(path) && error.includes(owner) && error.includes("cotal ext seed --repair"), error);
    privilegedOwners.push({ sid: owner, path, error });
  }
  const denied = join(root, "denied owner read");
  mkdirSync(denied);
  const deniedResult = ps("prove-read-control-denial", `$p=${literal(denied)};$original=Get-Acl -LiteralPath $p;$acl=Get-Acl -LiteralPath $p;$acl.SetOwner([Security.Principal.SecurityIdentifier]::new(${literal(foreignSid)}));$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new(${literal(sid)}),[Security.AccessControl.FileSystemRights]::ReadPermissions,[Security.AccessControl.AccessControlType]::Deny));try{Set-Acl -LiteralPath $p -AclObject $acl;& ${literal(process.execPath)} --import tsx ${literal(fileURLToPath(import.meta.url))} --denied-child $p;if($LASTEXITCODE -ne 0){throw 'denied owner reader child failed'}}finally{Set-Acl -LiteralPath $p -AclObject $original}`);
  assert.match(deniedResult, /refuse actual READ_CONTROL denial/);
  const ownTree = join(root, "own tree ü"), foreignFileTree = join(root, "foreign file tree"), junctionTree = join(root, "junction tree");
  for (const tree of [ownTree, foreignFileTree, junctionTree]) {
    mkdirSync(join(tree, "nested"), { recursive: true });
    writeFileSync(join(tree, "nested", ".hidden.txt"), "ordinary file included in owner census");
    const change = spawnSync("icacls.exe", [tree, "/setowner", `*${sid}`, "/T", "/Q"], { encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(change.status, 0, change.stdout + change.stderr);
  }
  const foreignFile = join(foreignFileTree, "nested", ".hidden.txt");
  const foreignChange = spawnSync("icacls.exe", [foreignFile, "/setowner", `*${foreignSid}`, "/Q"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(foreignChange.status, 0, foreignChange.stdout + foreignChange.stderr);
  ps("create-tree-junction", `New-Item -ItemType Junction -Path ${literal(join(junctionTree, "internal junction"))} -Target ${literal(foreign)}|Out-Null`);
  const treeOwnership = { own: windowsSetTreeOwnership(ownTree), foreignFile: windowsSetTreeOwnership(foreignFileTree), junction: windowsSetTreeOwnership(junctionTree) };
  assert.deepEqual(treeOwnership.own, { owners: [sid], reparsePoints: 0, owned: true });
  assert.deepEqual([...treeOwnership.foreignFile.owners].sort(), [sid, foreignSid].sort());
  assert.equal(treeOwnership.foreignFile.reparsePoints, 0);
  assert.equal(treeOwnership.foreignFile.owned, false);
  assert.deepEqual(treeOwnership.junction, { owners: [sid], reparsePoints: 1, owned: false });
  const result = { platform: process.platform, arch: process.arch, nativeSid: sid, foreignSid, ownResult, foreignResult, reparseError, privilegedOwners, deniedResult, missingRefused: true, fileRefused: true, nulRefused: true, treeOwnership, accountRemoved: false };
  net("remove-foreign-account", ["user", account, "/delete"]); created = false;
  result.accountRemoved = true;
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (created) net("finally-remove-foreign-account", ["user", account, "/delete"]);
}

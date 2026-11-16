import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsSetOwnedByCurrentUser, windowsSetTreeOwnership } from "../src/extension-set-win32.js";
import { win32ProcessBinding } from "../src/win32-process.js";

if (process.platform !== "win32") throw new Error("Windows connector-set owner measurement requires Windows");
const root = mkdtempSync(join(tmpdir(), "connector-owner-"));
const own = join(root, "own set ü"), foreign = join(root, "foreign set"), junction = join(root, "junction");
mkdirSync(own); mkdirSync(foreign);
const account = `cotal${process.pid}`;
const sid = win32ProcessBinding().userSid();
const ps = (script: string) => {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  const result = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop';Import-Module Microsoft.PowerShell.Security;${script}`, "utf16le").toString("base64")], { env: environment, encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
let created = false;
try {
  ps(`$a=Get-Acl -LiteralPath ${literal(own)};$a.SetOwner([Security.Principal.SecurityIdentifier]::new(${literal(sid)}));Set-Acl -LiteralPath ${literal(own)} -AclObject $a`);
  const foreignSid = ps(`$p=ConvertTo-SecureString ([Guid]::NewGuid().ToString()+'aA!9') -AsPlainText -Force;$u=New-LocalUser -Name ${literal(account)} -Password $p -AccountNeverExpires;$u.SID.Value`);
  created = true;
  ps(`$a=Get-Acl -LiteralPath ${literal(foreign)};$a.SetOwner([Security.Principal.SecurityIdentifier]::new(${literal(foreignSid)}));Set-Acl -LiteralPath ${literal(foreign)} -AclObject $a;New-Item -ItemType Junction -Path ${literal(junction)} -Target ${literal(own)}|Out-Null`);
  const ownResult = windowsSetOwnedByCurrentUser(own);
  const foreignResult = windowsSetOwnedByCurrentUser(foreign);
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
    let error = "";
    try { windowsSetOwnedByCurrentUser(path); } catch (cause) { error = String(cause); }
    assert(error.includes(path) && error.includes(owner) && error.includes("cotal ext seed --repair"), error);
    privilegedOwners.push({ sid: owner, path, error });
  }
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
  ps(`New-Item -ItemType Junction -Path ${literal(join(junctionTree, "internal junction"))} -Target ${literal(foreign)}|Out-Null`);
  const treeOwnership = { own: windowsSetTreeOwnership(ownTree), foreignFile: windowsSetTreeOwnership(foreignFileTree), junction: windowsSetTreeOwnership(junctionTree) };
  assert.deepEqual(treeOwnership.own, { owners: [sid], reparsePoints: 0, owned: true });
  assert.deepEqual([...treeOwnership.foreignFile.owners].sort(), [sid, foreignSid].sort());
  assert.equal(treeOwnership.foreignFile.reparsePoints, 0);
  assert.equal(treeOwnership.foreignFile.owned, false);
  assert.deepEqual(treeOwnership.junction, { owners: [sid], reparsePoints: 1, owned: false });
  const result = { platform: process.platform, nativeSid: sid, foreignSid, ownResult, foreignResult, reparseError, privilegedOwners, treeOwnership, accountRemoved: false };
  ps(`Remove-LocalUser -Name ${literal(account)}`); created = false;
  result.accountRemoved = true;
  const output = process.env.COTAL_OWNER_PROBE_OUTPUT;
  if (!output) throw new Error("measurement output directory required");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (created) ps(`Remove-LocalUser -Name ${literal(account)}`);
}

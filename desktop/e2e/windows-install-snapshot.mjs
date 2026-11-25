import { open, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { win32, dirname, join, resolve } from "node:path";

const LIMIT = 64 * 1024;
const TASK = /^cotal-daemon-(?:[a-f0-9]{16}-)?S-1-\d+(?:-\d+)+$/;
const sensitive = /token|secret|password|credential|authorization|bearer|cookie|environment|^env$|link|url|uri|auth/i;
function text(value) {
  return String(value).slice(0, 4096)
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/)[^\s<>"']+/gi, "[redacted-link]")
    .replace(/\b(?:Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)/gi, "[redacted]")
    .replace(/\b(?:token|secret|password|credential|authorization|api[_-]?key)\s*[:= ]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
function clean(value, depth = 0, budget = { remaining: 2000 }) {
  if (--budget.remaining < 0 || depth > 10) return "[bounded]";
  if (typeof value === "string") return text(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 64).map(v => clean(v, depth + 1, budget));
  if (value && typeof value === "object") {
    const result = Object.create(null);
    for (const key of Object.keys(value).slice(0, 128)) {
      if (!sensitive.test(key) || key === "accountMode") result[text(key)] = clean(value[key], depth + 1, budget);
    }
    return result;
  }
  return null;
}
async function boundedFile(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > LIMIT) throw new Error("bounded");
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMIT) throw new Error("bounded");
    const buffer = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIMIT) throw new Error("bounded");
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
const fields = ["Command", "Arguments", "WorkingDirectory", "UserId", "LogonType", "RunLevel", "MultipleInstancesPolicy", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries", "ExecutionTimeLimit", "Priority"];
function definition(raw) {
  const result = {};
  for (const field of fields) {
    if (typeof raw?.[field] === "string" || typeof raw?.[field] === "number") result[field] = clean(raw[field]);
  }
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => ["string", "boolean", "number"].includes(typeof value?.[key])).map(key => [key, clean(value[key])]));
  if (Array.isArray(raw?.triggers)) result.triggers = raw.triggers.slice(0, 16).map(value => pick(value, ["type", "enabled", "userId", "interval"]));
  if (raw?.settings) result.settings = pick(raw.settings, ["restartInterval", "restartCount"]);
  // Keep only the known Node + native CLI launch grammar. Unknown command lines are opaque.
  const command = raw?.Command;
  if (typeof command !== "string" || !win32.isAbsolute(command) || !/\\(?:node|cotal-desktop)\.exe$/i.test(command) || /[%\r\n]|:\/\//.test(command)) result.Command = "[redacted-command]";
  const args = raw?.Arguments;
  const parts = typeof args === "string" ? args.match(/"[^"\r\n]*"|[^\s"]+/g) : null;
  if (!parts || parts.join(" ") !== args || parts.length < 3 || !/^(?:"[A-Za-z]:\\[^"%]*\\daemon-native\.js"|[A-Za-z]:\\[^\s"%]*\\daemon-native\.js)$/.test(parts[0]) || parts[1] !== "daemon" || parts[2] !== "serve" || parts.slice(3).some(p => !/^(?:--daemon-home|--service|--owned-service|--json|"[A-Za-z]:\\[^"%]*"|[A-Za-z]:\\[^\s"%]*)$/.test(p)) || sensitive.test(args) || /:\/\//.test(args)) result.Arguments = "[redacted-arguments]";
  if (typeof command === "string" && /\\cotal-desktop\.exe$/i.test(command) && typeof args === "string" && /^--daemon(?: --daemon-home (?:"[A-Za-z]:\\[^"%\r\n]*"|[A-Za-z]:\\[^\s"%]*))?$/.test(args) && !sensitive.test(args) && !/:\/\//.test(args)) result.Arguments = text(args);
  return result;
}
function fileDefinition(bytes) {
  const xml = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
  const raw = {};
  for (const field of fields) {
    const match = new RegExp(`<${field}>([^<]*)</${field}>`).exec(xml);
    if (match) raw[field] = match[1].replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  }
  return definition(raw);
}
// Exact root task lookup only. No process, pipe, lock, environment or task enumeration.
const SCRIPT = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
try {
 $s=New-Object -ComObject 'Schedule.Service'; $s.Connect()
 try { $t=$s.GetFolder('\\').GetTask($env:COTAL_INSTALL_SNAPSHOT_TASK) }
 catch { if ($_.Exception.HResult -eq -2147024894) { '{"observation":"absent"}'; exit 0 }; throw }
 $xml=[string]$t.Xml
 if ([System.Text.Encoding]::UTF8.GetByteCount($xml) -gt 65536) { throw 'bounded' }
 $doc=[System.Xml.XmlDocument]::new(); $doc.XmlResolver=$null; $doc.LoadXml($xml)
 $d=@{}
 foreach ($name in @('Command','Arguments','WorkingDirectory','UserId','LogonType','RunLevel','MultipleInstancesPolicy','DisallowStartIfOnBatteries','StopIfGoingOnBatteries','ExecutionTimeLimit','Priority')) {
  $n=$doc.SelectSingleNode("//*[local-name()='$name']"); if ($n) { $d[$name]=$n.InnerText }
 }
 $d.triggers=@($doc.SelectNodes("//*[local-name()='Triggers']/*") | ForEach-Object { @{ type=$_.LocalName; enabled=[string]$_.Enabled; userId=[string]$_.UserId; interval=[string]$_.Repetition.Interval } })
 $d.settings=@{ restartInterval=[string]$doc.Task.Settings.RestartOnFailure.Interval; restartCount=[string]$doc.Task.Settings.RestartOnFailure.Count }
 $principal=$t.Definition.Principal
 $sid=[string]$principal.UserId
 if ($sid -notmatch '^S-1-') { $sid=([System.Security.Principal.NTAccount]::new($sid)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
 ConvertTo-Json -Depth 8 -Compress -InputObject @{ observation='present'; state=[int]$t.State; enabled=[bool]$t.Enabled; instances=[int]$t.GetInstances(0).Count; actions=[int]$t.Definition.Actions.Count; userId=$sid; logonType=[int]$principal.LogonType; runLevel=[int]$principal.RunLevel; definition=$d }
} catch { '{"observation":"unknown","code":"NATIVE_QUERY_FAILED","message":"Exact task observation failed"}' }
`;
function nativeQuery(unit, { signal }) {
  if (process.platform !== "win32" || !process.env.SystemRoot) return Promise.resolve({ observation: "unknown" });
  return new Promise(resolve => {
    execFile(win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")], { signal, timeout: 5000, maxBuffer: LIMIT, windowsHide: true, encoding: "utf8", env: { ...process.env, COTAL_INSTALL_SNAPSHOT_TASK: unit } }, (error, stdout) => {
      if (error) return resolve({ observation: "unknown" });
      try { resolve(JSON.parse(stdout)); } catch { resolve({ observation: "unknown" }); }
    });
  });
}
/** Append passive diagnostics. Failures are observations, never product decisions. */
export async function captureWindowsInstallSnapshot({ stage, receipt, output, status, refusal, validation, taskQuery = nativeQuery }) {
  const paths = process.platform === "win32" ? win32 : { dirname, join, resolve };
  const sourcePath = paths.join(paths.dirname(receipt), "service-task.xml");
  if ([receipt, sourcePath].some(path => paths.resolve(path).toLowerCase() === paths.resolve(output).toLowerCase())) return { diagnostic: "OUTPUT_CONFLICT", output: "unknown" };
  const snapshot = { stage: text(stage), at: new Date().toISOString(), receipt: { observation: "unknown" }, task: { observation: "not-queried" } };
  try {
    snapshot.status = clean(status);
    if (validation !== undefined) snapshot.validation = clean(validation);
    if (refusal) snapshot.refusal = { message: text(refusal.message ?? ""), next: text(refusal.next ?? "") };
    let record;
    try {
      await lstat(receipt);
      snapshot.receipt.exists = true;
      record = JSON.parse((await boundedFile(receipt)).toString("utf8"));
      snapshot.receipt = { observation: "present", exists: true };
      for (const key of ["v", "mechanism", "unit", "unitPath", "unitSha256", "installedAt", "daemonHome"]) {
        if (["string", "number"].includes(typeof record[key])) snapshot.receipt[key] = clean(record[key]);
      }
    } catch (error) {
      snapshot.receipt = error.code === "ENOENT" ? { observation: "absent", exists: false } : { observation: "unknown", ...(snapshot.receipt.exists ? { exists: true } : {}), code: "RECEIPT_UNREADABLE" };
    }
    if (record?.mechanism === "scheduled-task" && typeof record.unit === "string" && TASK.test(record.unit)) {
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ observation: "unknown" }); }, 5000); });
        const raw = await Promise.race([Promise.resolve().then(() => taskQuery(record.unit, { signal: controller.signal })), timeout]);
        snapshot.task = { observation: ["present", "absent"].includes(raw?.observation) ? raw.observation : "unknown" };
        if (snapshot.task.observation === "unknown") Object.assign(snapshot.task, { code: "NATIVE_QUERY_UNKNOWN", message: "Exact task observation unavailable" });
        if (snapshot.task.observation === "present") {
          if (Number.isInteger(raw.state) && raw.state >= 0 && raw.state <= 4) snapshot.task.state = raw.state;
          if (typeof raw.enabled === "boolean") snapshot.task.enabled = raw.enabled;
          for (const key of ["instances", "actions", "logonType", "runLevel"]) if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) snapshot.task[key] = raw[key];
          if (typeof raw.userId === "string" && /^S-1-\d+(?:-\d+)+$/.test(raw.userId)) snapshot.task.userId = raw.userId;
          snapshot.task.definition = definition(raw.definition);
        }
      } catch { snapshot.task = { observation: "unknown", code: "NATIVE_QUERY_FAILED", message: "Exact task observation failed" }; }
      finally { clearTimeout(timer); }
      if (record.unitPath === sourcePath) {
        try {
          const bytes = await boundedFile(record.unitPath);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          snapshot.source = { observation: "present", sha256, matchesReceipt: sha256 === record.unitSha256, definition: fileDefinition(bytes) };
        } catch (error) { snapshot.source = { observation: error.code === "ENOENT" ? "absent" : "unknown" }; }
      }
    }
  } catch { snapshot.diagnostic = "SNAPSHOT_UNKNOWN"; }
  try {
    let line = JSON.stringify(snapshot) + "\n";
    if (Buffer.byteLength(line) > 256 * 1024) line = JSON.stringify({ stage: text(stage), diagnostic: "SNAPSHOT_LIMIT", receipt: snapshot.receipt.observation, task: snapshot.task.observation }) + "\n";
    const handle = await open(output, "a", 0o600);
    try { await handle.writeFile(line); } finally { await handle.close(); }
  } catch { return { ...snapshot, output: "unknown" }; }
  return snapshot;
}

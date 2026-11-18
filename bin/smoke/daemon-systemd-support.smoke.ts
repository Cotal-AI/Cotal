/** Linux service prerequisites and recovery guidance through the built CLI, with no host service calls. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkSecretDir } from "@cotal-ai/core";
import { createSuite, killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("daemon systemd prerequisites: Linux only");
const suite = createSuite();
const root = mkdtempSync(join(tmpdir(), "dss-"));
const cli = resolve(import.meta.dirname, "../dist/cotal.js");
const home = join(root, "h"), config = join(root, "c"), runtime = join(root, "r");
const native = join(root, "native"), absent = join(root, "absent"), blocked = join(root, "blocked");
for (const dir of [home, config, runtime, native, absent, blocked]) mkSecretDir(dir);
const log = join(root, "native.log");
const env: NodeJS.ProcessEnv = {
  HOME: home, USER: "smoke", LOGNAME: "smoke", XDG_CONFIG_HOME: config,
  XDG_RUNTIME_DIR: runtime, COTAL_HOME: join(home, ".cotal"), TMPDIR: root,
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_ALLOW_CHECKOUT_SEED: "1",
  DO_NOT_TRACK: "1", NO_COLOR: "1", PATH: native,
};
writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, args + '\\n');
if (args !== '--user show-environment') process.exit(99);
console.log(${JSON.stringify(`HOME=${home}\nXDG_CONFIG_HOME=${config}`)});
`, { mode: 0o700 });
writeFileSync(join(native, "loginctl"), `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, args + '\\n');
if (args !== 'show-user smoke --property=Linger --no-ask-password --no-pager') process.exit(99);
console.log('Linger=yes');
`, { mode: 0o700 });
writeFileSync(join(blocked, "systemctl"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
function run(args: string[], path = native, overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, PATH: path, ...overrides }, encoding: "utf8", timeout: 15_000 });
  if (result.error) throw result.error;
  const text = `${result.stdout}${result.stderr}`;
  console.log(`${args.join(" ")}: exit ${result.status}\n${text}`);
  return { code: result.status, text, stdout: result.stdout };
}

// A responding user manager remains supported, and a broken bus must keep its own diagnosis.
if (existsSync("/run/systemd/system")) {
  const control = run(["daemon", "install", "--dry-run"]);
  suite.check("responding systemd user manager plans without writes", control.code === 0 && control.text.includes("Would install") && !existsSync(join(config, "systemd")));
  const calls = readFileSync(log, "utf8");
  suite.check("preview only queried environment and linger", calls === "--user show-environment\nshow-user smoke --property=Linger --no-ask-password --no-pager\n");
  const bus = run(["daemon", "install", "--dry-run"], blocked);
  suite.check("unavailable user bus still names the logged-in session", bus.code === 2 && bus.text.includes("DEPENDENCY_UNAVAILABLE") && bus.text.includes("logged-in session"));
}
const callsBefore = existsSync(log) ? readFileSync(log, "utf8") : "";
// Also run under a private mount namespace without /run/systemd/system to cover a
// machine that has systemctl installed but was not booted with systemd.
const unsupportedPaths = existsSync("/run/systemd/system") ? [absent] : [absent, native];
for (const path of unsupportedPaths) {
  for (const args of [["install", "--dry-run"], ["install"], ["setup"]]) {
    for (const format of ["--plain", "--json"]) {
      const result = run(["daemon", ...args, format], path);
      const document = format === "--json" ? JSON.parse(result.stdout) : undefined;
      suite.check(`${args.join(" ")} ${format}: unsupported service names working alternatives`, result.code === 2 && result.text.includes("UNSUPPORTED") && result.text.includes("systemd") && result.text.includes("cotal daemon serve") && result.text.includes("cotal update --self") && !result.text.includes("logged-in session") && (!document || document.error.code === "UNSUPPORTED"));
    }
  }
  const auto = run(["update", "--auto", "on"], path);
  suite.check("automatic update guidance never suggests unsupported installation", auto.code === 0 && auto.text.includes("systemd") && auto.text.includes("cotal daemon serve") && auto.text.includes("cotal update --self") && !auto.text.includes("cotal daemon install"));
  suite.check("automatic update guidance is complete prose", /\. The Linux background service requires systemd\b/.test(auto.text) && /\. Run `cotal daemon serve`/.test(auto.text) && auto.text.trimEnd().endsWith("."));
}
suite.check("unsupported commands never queried a native supervisor", (existsSync(log) ? readFileSync(log, "utf8") : "") === callsBefore);
suite.check("unsupported commands never published a unit", !existsSync(join(config, "systemd")));
if (!existsSync("/run/systemd/system")) {
  // The desktop reads the account's application PATH. Keep that shell and every
  // native tool inside this fixture, including when it appends Node's directory.
  writeFileSync(join(blocked, "systemctl"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, 'unexpected desktop systemctl\\n'); process.exit(99);\n`, { mode: 0o700 });
  for (const profile of [".bash_profile", ".bashrc", ".zprofile", ".zshrc", ".profile"]) writeFileSync(join(home, profile), `export PATH=${JSON.stringify(blocked)}\n`, { mode: 0o600 });
  const beforeDesktop = existsSync(log) ? readFileSync(log, "utf8") : "";
  for (const request of [{ op: "install" }, { op: "setup", space: "probe", idp: "http://127.0.0.1:1/auth" }]) {
    for (const rt of [runtime, undefined]) {
      const desktop = spawnSync(process.execPath, [cli, "daemon", "desktop"], { cwd: root, env: { ...env, PATH: blocked, XDG_RUNTIME_DIR: rt }, input: `${JSON.stringify(request)}\n`, encoding: "utf8", timeout: 15_000 });
      if (desktop.error) throw desktop.error;
      console.log(`desktop ${request.op}, runtime=${rt !== undefined}: exit ${desktop.status}\n${desktop.stdout}${desktop.stderr}`);
      const frame = JSON.parse(desktop.stdout.trim().split("\n").at(-1)!);
      suite.check(`desktop ${request.op} runtime=${rt !== undefined}: unsupported before recovery or runtime checks`, desktop.status === 0 && frame.ok === false && frame.error.code === "UNSUPPORTED" && frame.error.remedy.includes("cotal daemon serve") && frame.error.remedy.includes("cotal update --self") && !desktop.stdout.includes("logged-in session"));
    }
  }
  suite.check("unsupported desktop requests never queried a native supervisor", (existsSync(log) ? readFileSync(log, "utf8") : "") === beforeDesktop);
  suite.check("unsupported desktop requests never published a unit or receipt", !existsSync(join(config, "systemd")) && !existsSync(join(home, ".cotal", "daemon", "service-unit.json")));
  if (!existsSync(`/run/user/${process.geteuid!()}`)) {
    const missing = run(["daemon", "status", "--json"], native, { XDG_RUNTIME_DIR: undefined });
    const error = JSON.parse(missing.stdout).error;
    suite.check("missing runtime names private directory provisioning", missing.code === 2 && error.cause.code === "NO_RUNTIME_DIR" && error.remedy.includes("pam_rundir") && error.remedy.includes("0700") && error.remedy.includes("XDG_RUNTIME_DIR"));
  }
  const child = spawn(process.execPath, [cli, "daemon", "serve"], { cwd: root, env: { ...env, PATH: absent }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; });
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  try {
    for (let i = 0; i < 100 && !output.includes("daemon ready at") && child.exitCode === null && !spawnError; i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (spawnError) throw spawnError;
    suite.check("foreground daemon starts without systemd", output.includes("daemon ready at"), output);
    const status = run(["daemon", "status", "--json"], absent);
    const result = JSON.parse(status.stdout).result;
    suite.check("foreground status identifies the owned daemon", status.code === 0 && result.state === "ready" && result.pid === child.pid);
    const advice = run(["update", "--auto"], absent);
    suite.check("foreground update advice avoids unsupported installation", advice.code === 0 && advice.text.includes("cotal update --self") && !advice.text.includes("cotal daemon install"));
    suite.check("foreground update guidance is complete prose", /\. The Linux background service requires systemd\b/.test(advice.text) && /\. Run `cotal daemon serve`/.test(advice.text) && advice.text.trimEnd().endsWith("."));
  } finally {
    if (child.pid) await killAndAwaitExit(child, "SIGTERM");
    suite.check("foreground child is stopped", !child.pid || child.exitCode !== null || child.signalCode !== null);
  }
}
console.log(`Retained daemon systemd support fixture: ${root}`);
suite.finish();
